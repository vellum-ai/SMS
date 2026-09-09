/**
 * The handler behind `routes/events-twilio.ts`.
 *
 * The gateway authenticates and gates the delivery before this handler runs:
 * the `X-Twilio-Signature` check, body-size limits, rate limiting, and the
 * admission pipeline are all its job, and re-implementing them here would mean
 * two schemes to keep in sync and one to get subtly wrong.
 *
 * By the time a delivery reaches this handler, the gateway has already read
 * the sender and the chat out of the delivery's own form params (via the
 * `inbound` declaration in `channels/ingress.json`), run the kill switch, the
 * trust verdict and the intercepts, and compared the sender against the
 * admission floor. A delivery that arrives here is one the assistant is
 * allowed to answer, and answering it is this plugin's job.
 *
 * Twilio posts `application/x-www-form-urlencoded`, unlike every provider the
 * iMessage plugin carries, so the body is parsed as form params here rather
 * than as JSON.
 */

import { readConfigView } from "./app-settings.ts";
import type { SMSConfig } from "./config.ts";
import { pluginConfigPath } from "./plugin-paths.ts";
import { getConfig } from "./plugin-state.ts";
import { resolveProvider } from "./providers/index.ts";
import { describeError } from "./providers/error-detail.ts";
import { runTurnForDelivery } from "./run-turn.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Config this delivery is judged against.
 *
 * `init` writes the resolved config into in-memory plugin state, but the host
 * loads this route with a cache-busting query string (`file.ts?t=mtime`). That
 * is a different module instance, so `getConfig()` is empty here even when the
 * plugin is up. `config.json` is the same file either instance would have
 * written. Read it when this instance never saw `init`.
 *
 * `durablePath` is for tests. Production always uses the plugin's own file.
 */
export function resolveWebhookConfig(
  durablePath: string = pluginConfigPath(),
): SMSConfig {
  return getConfig() ?? readConfigView(durablePath);
}

/**
 * Parse a delivery body into form params.
 *
 * Returns `undefined` on anything unparsable. The caller answers 200 rather
 * than 400: the delivery was authentic (the gateway verified the signature
 * over exactly these bytes) and retrying it will not make the body parse.
 */
async function parseFormParams(request: Request): Promise<
  Record<string, string> | undefined
> {
  try {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const record: Record<string, string> = {};
    for (const [key, value] of params) {
      record[key] = value;
    }
    return record;
  } catch {
    return undefined;
  }
}

export async function handleTwilioWebhook(
  request: Request,
  durablePath?: string,
): Promise<Response> {
  const config = resolveWebhookConfig(durablePath);
  if (config.ingressMode !== "webhook") {
    // An approved-but-unused declaration should not be a live surface.
    return json(404, { error: "webhook ingress is not enabled" });
  }

  const params = await parseFormParams(request);
  if (!params) {
    return json(200, { ok: true, ignored: "unparsable body" });
  }

  // Built for this route rather than read from plugin state. The mode check
  // above guarantees a webhook-mode config, and building from scratch keeps
  // the handler correct on its own terms rather than by coincidence.
  const provider = resolveProvider({ config });

  const delivery = provider.classifyWebhook(params, new Date().toISOString());

  if (delivery.kind === "ignored") {
    // Status callbacks, delivery receipts, events this provider does not
    // model. The reason names the event rather than the category, so a vendor
    // that starts sending something new is visible rather than silently
    // dropped.
    return json(200, { ok: true, ignored: delivery.reason });
  }

  // Everything that could refuse this message already has. The gateway read
  // the sender and the chat out of the vendor's own delivery — the flat form
  // params, via the declaration in `channels/ingress.json` — ran the kill
  // switch, the trust verdict and the intercepts, and compared the sender
  // against the admission floor, all before forwarding. A delivery that
  // arrives here is one the assistant is allowed to answer, and answering it
  // is this plugin's job: nothing on the assistant side speaks Twilio.
  try {
    const outcome = await runTurnForDelivery({
      event: delivery.event,
      provider,
    });
    return json(200, { ok: true, ...outcome });
  } catch (err) {
    // 503 rather than 200, so Twilio sends it again. The gateway releases its
    // dedup claim on this status, so the retry arrives as a fresh delivery
    // rather than one answered as a duplicate.
    return json(503, {
      error: "could not run the turn",
      detail: describeError(err),
    });
  }
}
