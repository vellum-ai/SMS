/**
 * Twilio REST API client.
 *
 * Thin wrapper over `https://api.twilio.com/2010-04-01/Accounts/{AccountSid}`
 * with HTTP Basic auth (AccountSid:AuthToken), the retry behavior Twilio's
 * own SDKs use for 429s, and tolerant response parsing through `schemas.ts`.
 *
 * Everything is form-encoded rather than JSON: Twilio's API accepts JSON on
 * some endpoints, but the forms are the documented, universally accepted
 * spelling, and the messaging webhook is form-encoded on the wire either way.
 *
 * Credentials are resolved per request rather than cached, so a rotated token
 * takes effect without a restart.
 */

import {
  resolveAccountSid,
  resolveAuthToken,
  resolveFromNumber,
} from "../../config.ts";
import { describeApiFailure, describeError } from "../error-detail.ts";
import type { TwilioIncomingPhoneNumber, TwilioMessage } from "./schemas.ts";
import {
  TwilioIncomingPhoneNumberListSchema,
  TwilioMessageListSchema,
  TwilioSendResponseSchema,
} from "./schemas.ts";

/** Twilio API base. The account sid is appended per request. */
export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

/** Retries for a 429 or a 5xx. Beyond this the caller sees the failure. */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

/** Page size for listings. Generous; listings are cheap and rate-limited lightly. */
const LIST_PAGE_SIZE = 100;

export class TwilioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "TwilioApiError";
  }

  /** Whether a retry could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** The line this plugin sends from, and whose webhook it programs. */
export async function resolveLine(): Promise<{
  accountSid: string;
  authToken: string;
  fromNumber: string;
}> {
  const [accountSid, authToken, fromNumber] = await Promise.all([
    resolveAccountSid(),
    resolveAuthToken(),
    resolveFromNumber(),
  ]);
  return { accountSid, authToken, fromNumber };
}

export class TwilioClient {
  /**
   * The API base and the credential sources are fixed, not injected. There is
   * one Twilio deployment and one credential set this client can use, so
   * passing either in would only create a way for a caller to be wrong. Tests
   * exercise the client by stubbing `fetch` and the credential module.
   */
  private readonly baseUrl = TWILIO_API_BASE;
  private readonly getLine = resolveLine;

  /**
   * `POST /Messages.json`.
   *
   * Twilio has no idempotency key on send. The `idempotencyKey` the seam
   * passes is accepted and deliberately unused: honoring it would require
   * client-side state that a restart loses, and pretending otherwise is worse
   * than the honest gap. The transport layer already keys reply chunks off
   * the message being answered, which bounds the double-send window to a
   * retried turn.
   */
  async sendMessage(to: string, body: string): Promise<string | undefined> {
    const form = new URLSearchParams({ To: to, Body: body });
    // From is resolved inside `request` (the line's from number) and added
    // there, so every send carries the same line without each caller knowing it.
    const raw = await this.request("/Messages.json", {
      method: "POST",
      form,
    });
    return TwilioSendResponseSchema.safeParse(raw).data?.sid;
  }

  /**
   * `GET /Messages.json`, newest first, filtered client-side.
   *
   * Twilio's documented filters (`To`, `From`, `DateCreated>`) are date-granular
   * at best, so the cursor bound is applied by the caller over the returned
   * page rather than trusted to the API. `limit` caps how far back the page
   * reaches.
   */
  async listMessages(limit: number): Promise<TwilioMessage[]> {
    const form = new URLSearchParams({ PageSize: String(limit) });
    const raw = await this.request("/Messages.json", { method: "GET", form });
    const parsed = TwilioMessageListSchema.safeParse(raw);
    return parsed.success ? parsed.data.messages : [];
  }

  /** `GET /IncomingPhoneNumbers.json`. */
  async listIncomingPhoneNumbers(): Promise<TwilioIncomingPhoneNumber[]> {
    const form = new URLSearchParams({ PageSize: String(LIST_PAGE_SIZE) });
    const raw = await this.request("/IncomingPhoneNumbers.json", {
      method: "GET",
      form,
    });
    const parsed = TwilioIncomingPhoneNumberListSchema.safeParse(raw);
    return parsed.success ? parsed.data.incoming_phone_numbers : [];
  }

  /**
   * `POST /IncomingPhoneNumbers/{Sid}.json` — set the number's SMS webhook.
   *
   * The only write this plugin performs on the account besides sending. It
   * runs on every webhook-mode start, so it is only called after a comparison
   * (see the adapter) — a blind write would churn Twilio's audit log and
   * briefly drop any webhook another process had just programmed.
   */
  async setSmsWebhook(
    sid: string,
    url: string,
    method: "POST",
  ): Promise<void> {
    const form = new URLSearchParams({
      SmsUrl: url,
      SmsMethod: method,
    });
    await this.request(`/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, {
      method: "POST",
      form,
    });
  }

  /**
   * One authenticated request, retrying 429s and 5xx with exponential backoff.
   *
   * `fetch` rejects rather than resolving for a transport failure — connection
   * refused, DNS, TLS — and the reason is on `.cause`, not in the message. Left
   * unwrapped it escapes as a bare `TypeError: fetch failed` with no mention
   * of which request it was, which is how a provider being unreachable comes
   * to look like a plugin bug.
   */
  private async request(
    path: string,
    init: { method: string; form: URLSearchParams },
  ): Promise<unknown> {
    const { accountSid, authToken, fromNumber } = await this.getLine();
    let lastError: TwilioApiError | undefined;

    // The send needs the line; the listings do not. Adding it everywhere is
    // harmless (Twilio ignores unknown form keys on GET) and keeps one path.
    if (!init.form.has("From") && init.method === "POST" && path === "/Messages.json") {
      init.form.set("From", fromNumber);
    }

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    let url = `${this.baseUrl}/${encodeURIComponent(accountSid)}${path}`;
    if (init.method === "GET") {
      url = `${url}?${init.form.toString()}`;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: init.method,
          headers: {
            Authorization: `Basic ${auth}`,
            ...(init.method === "POST"
              ? {
                  "Content-Type":
                    "application/x-www-form-urlencoded; charset=utf-8",
                }
              : {}),
          },
          ...(init.method === "POST"
            ? { body: init.form.toString() }
            : {}),
        });
      } catch (err) {
        throw new TwilioApiError(
          `Twilio API ${init.method} ${path} could not be reached: ${describeError(err)}`,
          0,
        );
      }

      if (response.ok) {
        return await response.json().catch(() => ({}));
      }

      const body = await response.text().catch(() => undefined);
      lastError = new TwilioApiError(
        describeApiFailure(
          `Twilio API ${init.method} ${path}`,
          response.status,
          body,
        ),
        response.status,
        body,
      );

      if (!lastError.retryable) throw lastError;
    }

    throw lastError ?? new TwilioApiError("Twilio API request failed", 0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
