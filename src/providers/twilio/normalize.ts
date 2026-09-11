/**
 * Twilio payloads to `PluginInboundEvent`.
 *
 * The one job here is to turn untrusted delivery params into the shape the
 * gateway's admission pipeline consumes, dropping anything that must not
 * become a turn. Every drop is silent and returns `undefined`: a delivery
 * receipt is not an error.
 *
 * Nothing in this module decides whether a message is *allowed*. Trust
 * classification and the admission floor live in the gateway and stay there;
 * this module's contribution to that decision is getting `actorExternalId`
 * right and stamping the chat type as `sms` — always, because an SMS sender
 * id is spoofable in a way an iMessage identity is not, and the gateway
 * classifies on that distinction.
 */

import type { TwilioWebhookParams } from "./schemas.ts";
import {
  nonMessageLabel,
  TwilioWebhookParamsSchema,
  webhookIsMessage,
} from "./schemas.ts";
import { CHANNEL_ID } from "../../plugin-paths.ts";
import type { PluginInboundEvent } from "../../channel/contract.ts";
import { resolveIdentity } from "../../channel/identity.ts";
import type { WebhookDelivery } from "../types.ts";

/** The chat type every Twilio event carries. See the module note. */
export function chatTypeForMessage(): "sms" {
  return "sms";
}

/** Normalize one inbound Twilio webhook message. */
function normalizeFields(input: {
  sid: string;
  from: string | undefined;
  body: string | undefined;
  receivedAt: string;
  raw: Record<string, unknown>;
}): PluginInboundEvent | undefined {
  const identity = resolveIdentity({ from: input.from });
  if (!identity) return undefined;

  const content = input.body?.trim();
  if (!content) return undefined;

  return {
    version: "v1",
    sourceChannel: CHANNEL_ID,
    receivedAt: input.receivedAt,
    message: {
      content,
      // Twilio has no conversation ids: a 1:1 SMS thread is a pair of
      // numbers, so the sender's normalized number is the conversation
      // address. The two ids stay semantically distinct even when they hold
      // the same string — see `identity.ts` for why that matters.
      conversationExternalId: identity.conversationExternalId,
      externalMessageId: input.sid,
    },
    actor: {
      actorExternalId: identity.actorExternalId,
    },
    source: {
      updateId: input.sid,
      messageId: input.sid,
      chatType: chatTypeForMessage(),
    },
    // Verbatim, per the gateway's ingress rule: only the parsed working copy
    // is schema-shaped.
    raw: input.raw,
  };
}

/** Normalize a parsed messaging-webhook delivery. */
export function normalizeWebhookParams(
  params: TwilioWebhookParams,
  receivedAt: string,
): PluginInboundEvent | undefined {
  // The schema refined on `MessageSid`, but the record's index signature
  // still says `string | undefined` to the compiler, and a re-check here is
  // cheaper than a cast.
  const sid = params.MessageSid;
  if (!sid) return undefined;

  return normalizeFields({
    sid,
    from: params.From,
    body: params.Body,
    receivedAt,
    raw: params as Record<string, unknown>,
  });
}

/**
 * Read a Twilio delivery and say what it is.
 *
 * A messaging webhook carries `Body` and is a turn candidate. A status
 * callback carries `MessageStatus` and no `Body`, and is routine: Twilio
 * posts delivery state to the same URL unless the number's status callback
 * is pointed elsewhere, and neither delivery is an error.
 */
export function classifyTwilioWebhook(
  raw: unknown,
  receivedAt: string,
): WebhookDelivery {
  const parsed = TwilioWebhookParamsSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "ignored", reason: "unrecognized webhook params" };
  }

  if (!webhookIsMessage(parsed.data)) {
    return { kind: "ignored", reason: nonMessageLabel(parsed.data) };
  }

  const event = normalizeWebhookParams(parsed.data, receivedAt);
  return event
    ? { kind: "message", event }
    : { kind: "ignored", reason: "inbound message carried no usable turn" };
}
