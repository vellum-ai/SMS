/**
 * Twilio REST API client.
 *
 * Thin wrapper over `https://api.twilio.com/2010-04-01/Accounts/{AccountSid}`
 * with HTTP Basic auth, retry behavior for 429s and 5xx responses, and
 * tolerant response parsing through `schemas.ts`.
 *
 * The Account SID and Auth Token are credentials. The selected assistant SMS
 * line is a non-secret config value, read only when sending a message. That
 * separation lets setup inspect and purchase account numbers before a line has
 * been selected.
 */

import {
  resolveAccountSid,
  resolveAuthToken,
} from "../../config.ts";
import { describeApiFailure, describeError } from "../error-detail.ts";
import type {
  TwilioAvailablePhoneNumber,
  TwilioIncomingPhoneNumber,
  TwilioMessage,
} from "./schemas.ts";
import {
  TwilioAvailablePhoneNumberCountrySchema,
  TwilioAvailablePhoneNumberListSchema,
  TwilioIncomingPhoneNumberListSchema,
  TwilioIncomingPhoneNumberResponseSchema,
  TwilioMessageListSchema,
  TwilioSendResponseSchema,
} from "./schemas.ts";

/** Twilio API base. The account sid is appended per request. */
export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

/** Retries for a 429 or a 5xx. Beyond this the caller sees the failure. */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

/** Page size for account listings and available-number suggestions. */
const LIST_PAGE_SIZE = 100;
const AVAILABLE_NUMBER_PAGE_SIZE = 10;

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

/** The credentials required to talk to the user's Twilio account. */
export async function resolveTwilioCredentials(): Promise<{
  accountSid: string;
  authToken: string;
}> {
  const [accountSid, authToken] = await Promise.all([
    resolveAccountSid(),
    resolveAuthToken(),
  ]);
  return { accountSid, authToken };
}

export type AvailablePhoneNumberType = "local" | "toll_free" | "mobile";

export interface SearchAvailablePhoneNumbersOptions {
  /** ISO 3166-1 alpha-2 country code accepted by Twilio, for example US. */
  country: string;
  /** Area code when the provider supports it for the selected inventory type. */
  areaCode?: string;
}

export class TwilioClient {
  /**
   * `POST /Messages.json`.
   *
   * Twilio has no idempotency key on send. The idempotency key the transport
   * passes is intentionally not forwarded because Twilio does not accept it.
   */
  async sendMessage(
    to: string,
    body: string,
    fromNumber: string,
  ): Promise<string | undefined> {
    const form = new URLSearchParams({ To: to, Body: body, From: fromNumber });
    const raw = await this.request("/Messages.json", {
      method: "POST",
      form,
    });
    return TwilioSendResponseSchema.safeParse(raw).data?.sid;
  }

  /** `GET /Messages.json`, newest first. */
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
   * Search every number type Twilio exposes for this account and country.
   *
   * Twilio's country resource tells us whether Local, TollFree, and Mobile
   * inventory is supported before we request it. Each query carries the
   * documented `SmsEnabled=true` filter, then the caller still checks the
   * returned capability flag before presenting a purchasable choice.
   */
  async searchAvailablePhoneNumbers(
    options: SearchAvailablePhoneNumbersOptions,
  ): Promise<TwilioAvailablePhoneNumber[]> {
    const country = options.country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new Error("Twilio number search needs a two-letter country code, for example US.");
    }

    const countryResource = await this.request(
      `/AvailablePhoneNumbers/${encodeURIComponent(country)}.json`,
      { method: "GET", form: new URLSearchParams() },
    );
    const parsedCountry = TwilioAvailablePhoneNumberCountrySchema.safeParse(
      countryResource,
    );
    const subresources = parsedCountry.success
      ? parsedCountry.data.subresource_uris
      : {};
    const types = (Object.keys(subresources) as AvailablePhoneNumberType[])
      .filter((type): type is AvailablePhoneNumberType =>
        type === "local" || type === "toll_free" || type === "mobile",
      );

    const results = await Promise.all(
      types.map(async (type) => {
        const form = new URLSearchParams({
          SmsEnabled: "true",
          PageSize: String(AVAILABLE_NUMBER_PAGE_SIZE),
        });
        if (options.areaCode?.trim() && type !== "toll_free") {
          form.set("AreaCode", options.areaCode.trim());
        }

        const resource =
          type === "local"
            ? "Local"
            : type === "toll_free"
              ? "TollFree"
              : "Mobile";
        const raw = await this.request(
          `/AvailablePhoneNumbers/${encodeURIComponent(country)}/${resource}.json`,
          { method: "GET", form },
        );
        const parsed = TwilioAvailablePhoneNumberListSchema.safeParse(raw);
        return parsed.success ? parsed.data.available_phone_numbers : [];
      }),
    );

    return results.flat();
  }

  /**
   * `POST /IncomingPhoneNumbers.json` purchases a number in this Twilio
   * account. Caller confirmation belongs above this client because this is a
   * billable external action.
   */
  async purchasePhoneNumber(phoneNumber: string): Promise<TwilioIncomingPhoneNumber> {
    const form = new URLSearchParams({ PhoneNumber: phoneNumber });
    const raw = await this.request("/IncomingPhoneNumbers.json", {
      method: "POST",
      form,
    });
    const parsed = TwilioIncomingPhoneNumberResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Twilio purchased a number but returned an unreadable response.");
    }
    return parsed.data;
  }

  /** `POST /IncomingPhoneNumbers/{Sid}.json` sets the number's SMS webhook. */
  async setSmsWebhook(
    sid: string,
    url: string,
    method: "POST" = "POST",
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

  /** One authenticated request, retrying 429s and 5xx with exponential backoff. */
  private async request(
    path: string,
    init: { method: string; form: URLSearchParams },
  ): Promise<unknown> {
    const { accountSid, authToken } = await resolveTwilioCredentials();
    let lastError: TwilioApiError | undefined;

    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    let url = `${this.baseUrl}/${encodeURIComponent(accountSid)}${path}`;
    if (init.method === "GET" && init.form.size > 0) {
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

  private readonly baseUrl = TWILIO_API_BASE;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
