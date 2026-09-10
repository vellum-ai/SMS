/**
 * BYOK provider for the user's Twilio account and number.
 *
 * Everything Twilio-specific lives behind this adapter. Nothing above the
 * provider seam imports from this directory.
 */

import { resolveAccountSid, resolveAuthToken, resolveFromNumber } from "../../config.ts";
import type {
  EnsureWebhookOptions,
  MessagingProvider,
  SendResult,
  SendTarget,
  WebhookDelivery,
  WebhookRegistration,
} from "../types.ts";
import { TwilioClient } from "./client.ts";
import { classifyTwilioWebhook } from "./normalize.ts";
import { sameWebhookUrl, type TwilioIncomingPhoneNumber } from "./schemas.ts";

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

    async ensureWebhook(
      opts: EnsureWebhookOptions,
    ): Promise<WebhookRegistration> {
      const fromNumber = await resolveFromNumber();
      const numbers = await client.listIncomingPhoneNumbers();
      const line = numbers.find((number) => numberMatches(number, fromNumber));

      if (!line) {
        throw new Error(
          `the configured from number (${fromNumber}) was not found on this Twilio account; check the number in the SMS settings app`,
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
