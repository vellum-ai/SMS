/**
 * `POST /webhooks/plugins/sms/events-twilio` — deliveries from the configured
 * Twilio number.
 *
 * Twilio signs with `X-Twilio-Signature`, an HMAC-SHA1 over the request URL
 * and the sorted form params, keyed by the account auth token — a scheme the
 * `channels/ingress.json` manifest describes to the gateway as a `twilio`
 * route. The handler never sees an unverified delivery.
 */

import { handleTwilioWebhook } from "../src/webhook-route.ts";

export async function POST(request: Request): Promise<Response> {
  return handleTwilioWebhook(request);
}
