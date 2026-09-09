/**
 * Tolerant schemas for Twilio payloads.
 *
 * Two wire shapes live here:
 *
 * - **Webhook deliveries** — `application/x-www-form-urlencoded`, parsed by
 *   the route into a flat `Record<string, string>` before it reaches the
 *   adapter. The messaging webhook carries the message itself (`Body`,
 *   `From`, `MessageSid`); the status callback carries only delivery state
 *   (`MessageStatus`, no `Body`).
 * - **API responses** — JSON from `api.twilio.com`, whose error envelope is
 *   `{"code": 21xxx, "message": "..."}` with a status in the 400s.
 *
 * Everything is optional beyond what a turn needs, because a field Twilio
 * adds must degrade, not throw.
 */

import { z } from "zod";

/**
 * A parsed messaging webhook.
 *
 * A status callback parses as this too — `MessageStatus` present, `Body`
 * absent — and the classifier tells them apart, which is why nothing here
 * marks a field required that the other delivery shape does not carry.
 */
export const TwilioWebhookParamsSchema = z
  .record(z.string(), z.string())
  .refine(
    (params) => typeof params.MessageSid === "string" && params.MessageSid.length > 0,
    { message: "no MessageSid" },
  );

export type TwilioWebhookParams = z.infer<typeof TwilioWebhookParamsSchema>;

/** Whether a delivery is a message rather than a status callback. */
export function webhookIsMessage(params: TwilioWebhookParams): boolean {
  return typeof params.Body === "string" && params.Body.length > 0;
}

/** A short label naming what a non-message delivery was, for the log. */
export function nonMessageLabel(params: TwilioWebhookParams): string {
  if (params.MessageStatus) return `status callback (${params.MessageStatus})`;
  return "delivery without a body";
}

/** One message from `GET /Messages.json`. */
export const TwilioMessageSchema = z.object({
  sid: z.string(),
  direction: z.enum(["inbound", "outbound-api", "outbound-call", "outbound-reply"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  body: z.string().optional(),
  date_created: z.string().optional(),
});

export type TwilioMessage = z.infer<typeof TwilioMessageSchema>;

/** The listing envelope. `messages` is absent rather than empty on some errors. */
export const TwilioMessageListSchema = z.object({
  messages: z.array(TwilioMessageSchema).default([]),
});

/** One entry from `GET /IncomingPhoneNumbers.json`. */
export const TwilioIncomingPhoneNumberSchema = z.object({
  sid: z.string(),
  phone_number: z.string().optional(),
  sms_url: z.string().optional(),
  sms_method: z.string().optional(),
  capabilities: z
    .object({ sms: z.boolean().optional() })
    .passthrough()
    .optional(),
});

export type TwilioIncomingPhoneNumber = z.infer<
  typeof TwilioIncomingPhoneNumberSchema
>;

export const TwilioIncomingPhoneNumberListSchema = z.object({
  incoming_phone_numbers: z
    .array(TwilioIncomingPhoneNumberSchema)
    .default([]),
});

/** The send response: a message resource, of which only the sid matters. */
export const TwilioSendResponseSchema = z.object({
  sid: z.string().optional(),
});

/**
 * Compare two webhook URLs for "same delivery target".
 *
 * Trailing-slash-insensitive, mirroring the iMessage plugin's rule: the
 * gateway serves both spellings of a declared route, so a number pointed at
 * either delivers to the same place, and a `===` comparison would rewrite a
 * working registration as a side effect of a cosmetic difference.
 */
export function sameWebhookUrl(a: string, b: string): boolean {
  const strip = (url: string) => url.trim().replace(/\/+(?=[?#]|$)/, "");
  return strip(a) === strip(b);
}
