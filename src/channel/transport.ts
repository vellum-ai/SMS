/**
 * Outbound half of the channel.
 *
 * The assistant renders a reply and the host routes it here. Provider-agnostic:
 * the actual send goes through whichever `MessagingProvider` is configured, and
 * the rendering rules live in `render.ts` so the `sms` skill's send script
 * applies exactly the same ones from its own process.
 *
 * A long reply becomes several messages rather than one truncated one. There
 * is no idempotency key on a Twilio send (the adapter notes why), so chunk
 * identity lives in the reply-key the turn layer derives, which bounds a
 * double-send to a retried turn rather than a re-chunked reply.
 */

import type {
  PluginChannelTransport,
  PluginDeliveryResult,
  PluginReplyPayload,
} from "./contract.ts";
import { chunkForDelivery, idempotencyKey } from "./render.ts";
import { CHANNEL_ID } from "../plugin-paths.ts";
import type { MessagingProvider, SendTarget } from "../providers/types.ts";

export function createTransport(
  provider: MessagingProvider,
): PluginChannelTransport {
  return {
    channel: CHANNEL_ID,

    async deliver(
      conversationExternalId: string,
      payload: PluginReplyPayload,
    ): Promise<PluginDeliveryResult> {
      // SMS has no typing indicator, so a chatAction payload is accepted and
      // answered as delivered: refusing it would surface as a delivery error
      // on every host that renders one.
      const chunks = chunkForDelivery(payload.text ?? "");
      if (chunks.length === 0) {
        // Nothing to say is a success, not a failure: an empty render should
        // not surface as a delivery error.
        return { ok: true };
      }

      const target = targetFor(conversationExternalId);
      let lastId: string | undefined;

      for (const [index, chunk] of chunks.entries()) {
        try {
          const result = await provider.send(target, chunk, {
            idempotencyKey: idempotencyKey(
              conversationExternalId,
              chunk,
              index,
            ),
          });
          lastId = result.id;
        } catch (err) {
          // Report the failure rather than continuing: the recipient has
          // already received the earlier chunks, and pushing more after a
          // failure would deliver the reply out of order.
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      return { ok: true, externalMessageId: lastId };
    },
  };
}

/**
 * Route by the shape of the conversation id.
 *
 * The normalizer uses the normalized sender number as the conversation
 * address, and Twilio has no chat ids of its own, so every address here is a
 * recipient (`to`). The conversation arm stays for the seam's shape.
 */
export function targetFor(conversationExternalId: string): SendTarget {
  if (
    /^\+\d{7,15}$/.test(conversationExternalId) ||
    conversationExternalId.includes("@")
  ) {
    return { to: conversationExternalId };
  }
  return { conversationId: conversationExternalId };
}

export { chunkForDelivery, flattenForPlainText, idempotencyKey } from "./render.ts";
