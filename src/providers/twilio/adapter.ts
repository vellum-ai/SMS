/**
 * BYOK provider — the user's own Twilio account and number.
 *
 * Everything Twilio-specific lives behind this adapter: the REST client, the
 * tolerant schemas, and the normalizer. Nothing above the provider seam
 * imports from this directory.
 */

import { TwilioClient } from "./client.ts";
import { classifyTwilioWebhook, normalizeListedMessage } from "./normalize.ts";
import {
  sameWebhookUrl,
  type TwilioIncomingPhoneNumber,
} from "./schemas.ts";
import type {
  EnsureWebhookOptions,
  FetchInboundOptions,
  InboundRecord,
  MessagingProvider,
  SendResult,
  SendTarget,
  WebhookDelivery,
  WebhookRegistration,
} from "../types.ts";
import {
  resolveAccountSid,
  resolveAuthToken,
  resolveFromNumber,
} from "../../config.ts";

/**
 * The number on the account this plugin programs and sends from.
 *
 * Matches on the normalized spelling of the stored `from_number` credential,
 * because Twilio reports `phone_number` in E.164 and a user pastes whatever
 * their console shows — punctuation included.
 */
function numberMatches(
  number: TwilioIncomingPhoneNumber,
  fromNumber: string,
): boolean {
  if (!number.phone_number) return false;
  return normalizeDigits(number.phone_number) === normalizeDigits(fromNumber);
}

function normalizeDigits(value: string): string {
  return `+${value.replace(/\D/g, "")}`;
}

export function createTwilioProvider(): MessagingProvider {
  const client = new TwilioClient();

  return {
    id: "twilio",
    label: "Twilio (your own account)",
    supportsPolling: true,
    supportsLive: false,

    async checkReadiness() {
      try {
        await resolveAccountSid();
        await resolveAuthToken();
        await resolveFromNumber();
        return { ready: true as const };
      } catch (err) {
        return {
          ready: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    /**
     * Lists recent messages and keeps the inbound ones past the cursor.
     *
     * Filtering happens here rather than in the poller so the poller stays
     * provider-agnostic: it never sees a Twilio-shaped payload. The cursor
     * bound is a client-side comparison for the same reason the client's
     * listing is — Twilio's date filters are day-granular, not timestamp.
     */
    async fetchInbound(
      fetchOpts: FetchInboundOptions,
    ): Promise<InboundRecord[]> {
      const { fromNumber } = await resolveLineForFetch();
      const messages = await client.listMessages(fetchOpts.limit);

      return messages
        .filter(
          (message) =>
            message.direction === "inbound" &&
            // The listing covers every number on the account; only the line
            // this plugin owns is this channel's business.
            message.to !== undefined &&
            normalizeDigits(message.to) === normalizeDigits(fromNumber),
        )
        .filter(
          (message) =>
            !fetchOpts.since ||
            !message.date_created ||
            message.date_created >= fetchOpts.since,
        )
        .map((message) => ({
          id: message.sid,
          createdAt: message.date_created,
          // Normalizing here, inside the adapter, is what keeps the poller
          // provider-agnostic.
          event: normalizeListedMessage(message, new Date().toISOString()),
        }));
    },

    /**
     * Programs the configured number's SMS webhook.
     *
     * Twilio has no webhook registry — the delivery URL is a field on the
     * number — so this lists the account's numbers, finds the configured one,
     * and only writes when the URL differs. The comparison ignores a trailing
     * slash: the gateway serves both spellings of a declared route, and a
     * strict `===` would rewrite a working registration over a cosmetic
     * difference.
     *
     * A number that does not exist on the account fails rather than silently
     * registering nothing: "webhook registered" must mean Twilio will deliver.
     */
    async ensureWebhook(
      opts: EnsureWebhookOptions,
    ): Promise<WebhookRegistration> {
      const { fromNumber } = await resolveLineForFetch();
      const numbers = await client.listIncomingPhoneNumbers();
      const line = numbers.find((number) => numberMatches(number, fromNumber));

      if (!line) {
        throw new Error(
          `the configured from number (${fromNumber}) was not found on this Twilio account — check the number in the SMS settings app`,
        );
      }

      if (line.sms_url && sameWebhookUrl(line.sms_url, opts.url)) {
        return { created: false, id: line.sid };
      }

      await client.setSmsWebhook(line.sid, opts.url, "POST");
      return { created: true, id: line.sid };
    },

    async send(
      target: SendTarget,
      body: string,
      _sendOpts: { idempotencyKey: string },
    ): Promise<SendResult> {
      if (!("to" in target)) {
        // Twilio has no conversation ids, so nothing should ever produce one.
        // Failing loudly beats sending to an address Twilio cannot parse.
        throw new Error(
          "Twilio sends are addressed by phone number; a conversation id cannot be delivered",
        );
      }
      const sid = await client.sendMessage(target.to, body);
      return { id: sid };
    },

    classifyWebhook(raw: unknown, receivedAt: string): WebhookDelivery {
      return classifyTwilioWebhook(raw, receivedAt);
    },
  };
}

/**
 * The line's from number, resolved once per fetch.
 *
 * A thin local wrapper rather than calling the client's `resolveLine` from
 * the adapter, so the adapter's credential reads stay visible at its own
 * seam and a test stubs one function, not the client.
 */
async function resolveLineForFetch(): Promise<{ fromNumber: string }> {
  return { fromNumber: await resolveFromNumber() };
}
