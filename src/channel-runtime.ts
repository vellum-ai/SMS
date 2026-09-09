/**
 * Channel runtime — building the provider and running the ingress for it.
 *
 * Shared by `init` and by the settings route, so a settings save runs exactly
 * the same code path as a fresh boot. That is the whole reason this is not
 * inlined into the hook: a save that only half-matched boot would drift, and
 * the drift would show as "it works after a restart".
 *
 * Every entry point is safe to call repeatedly: `start` tears down whatever is
 * running first.
 */

import { describeError } from "./providers/error-detail.ts";
import { buildChannelProvider } from "./channel/provider.ts";
import type { SMSConfig } from "./config.ts";
import type { RuntimeContext } from "./plugin-state.ts";
import {
  getInitContext,
  getProvider,
  getSupervisor,
  getWebhookReport,
  setChannel,
  setConfig,
  setWebhookReport,
  setProvider,
  setSupervisor,
  type WebhookRegistrationStep,
} from "./plugin-state.ts";
import { pluginDataDir, pluginName } from "./plugin-paths.ts";
import { resolveProvider } from "./providers/index.ts";
import type { MessagingProvider } from "./providers/types.ts";
import { PollWorkerSupervisor } from "./worker/supervisor.ts";
import { resolveWebhookEndpoint } from "./webhook-endpoint.ts";
import { describeWebhookFailure } from "./webhook-report.ts";

/**
 * What happened to the channel.
 *
 * - `running` — ingress is up on the configured provider.
 * - `idle` — the provider was built here and could not come up; `idleReason`
 *   says why, and it is something the user can act on.
 *
 * There is deliberately no third state for "this caller has no runtime". A
 * save arriving before `init` used to report one, which said the write applied
 * on the next reload — true, and mostly read as an alarm about a channel
 * nobody had broken. `derivedContext` removes the condition instead.
 */
export type ChannelStatus = "running" | "idle";

export interface StartRuntimeResult {
  status: ChannelStatus;
  /** Why the channel is idle. Only set when `status` is `idle`. */
  idleReason?: string;
}

export interface StartRuntimeOptions {
  /**
   * Wait for webhook registration before returning.
   *
   * Boot leaves this off: registration is a network round trip, and plugin
   * load should not block on it. A settings save turns it on so a credential
   * that cannot resolve fails the save instead of writing the new provider
   * and reporting success while inbound is dead.
   */
  waitForSetup?: boolean;
}

/**
 * Point the configured number's webhook at this plugin's ingress route.
 *
 * Runs on every webhook-mode start, which is what makes a credential saved in
 * the settings app enough to finish setup: the restart that follows the save
 * is what programs the number. The adapter compares before it writes, so
 * repeating it costs one listing rather than a churned registration.
 *
 * Never throws. An unprogrammed number is a channel that hears nothing, not a
 * channel that failed to load, and taking the daemon's boot down over a
 * provider's 500 would be the worse trade.
 *
 * Every exit records which step it got to. Two things happen here — resolving
 * the public URL, asking Twilio — and they fail for entirely different
 * reasons. A report that says only "failed" leaves a reader unable to tell an
 * assistant with no public ingress from a Twilio that refused the write.
 *
 * There is no secret-storage step, unlike the iMessage plugin: Twilio signs
 * every delivery with the account auth token the user already holds, so there
 * is nothing issued to store. The step ids stay aligned with the report shape
 * so a shared reader does not need per-plugin branches.
 */
async function registerWebhook(
  provider: MessagingProvider,
  logger: RuntimeContext["logger"],
): Promise<void> {
  const at = new Date().toISOString();
  let step: WebhookRegistrationStep = "resolve-url";

  /** Record and log one failure, naming the step it happened at. */
  const fail = (err: unknown, message: string): void => {
    const reason = describeError(err);
    setWebhookReport({ provider: provider.id, outcome: "failed", step, reason, at });
    logger.warn(
      // `reason` alongside `err`: the host's logger may or may not expand an
      // Error, and a warning that renders as `{}` is how this becomes
      // undiagnosable in the first place.
      { err, reason, step, provider: provider.id },
      `sms: ${message} — the channel is running but will not hear anything`,
    );
  };

  try {
    const endpoint = await resolveWebhookEndpoint();
    if (!endpoint.ok) {
      setWebhookReport({
        provider: provider.id,
        outcome: "skipped",
        step,
        reason: endpoint.reason,
        at,
      });
      logger.warn(
        { provider: provider.id, step, reason: endpoint.reason },
        "sms: no webhook could be registered — inbound will not arrive until the assistant has a public URL or ingressMode is 'poll'",
      );
      return;
    }

    step = "call-provider";
    const result = await provider.ensureWebhook({
      url: endpoint.url,
      hasSecret: true,
    });

    setWebhookReport({
      provider: provider.id,
      outcome: result.created ? "registered" : "already-registered",
      url: endpoint.url,
      at,
    });
    logger.info(
      { provider: provider.id, created: result.created, url: endpoint.url },
      result.created
        ? "sms: programmed the number's SMS webhook"
        : "sms: the number's SMS webhook already points here",
    );
  } catch (err) {
    // Everything is inside the boundary: this runs un-awaited, so anything
    // escaping is an unhandled rejection rather than a channel that reports
    // what went wrong.
    fail(err, "could not program the inbound webhook");
  }
}

/**
 * Stop whatever ingress is running. Leaves the resolved provider in place so
 * outbound delivery still works while inbound is down.
 */
export async function stopIngress(): Promise<void> {
  getSupervisor()?.stop();
  setSupervisor(undefined);
}

/**
 * Drop the current provider, giving back anything it holds open.
 *
 * Un-awaited on purpose: this runs on the synchronous path that a settings
 * save and a fresh boot share, and neither should wait on a socket closing.
 */
export function releaseProvider(): void {
  const previous = getProvider();
  setProvider(undefined);
  void previous?.close?.().catch(() => {});
}

/**
 * A runtime context for a caller the `init` hook has not reached.
 *
 * `init` stashes the host's context, and until now anything running before it
 * — a settings save arriving on a route while the hook has not run, or been
 * torn down and not yet re-run — had nothing to build a channel with and
 * reported `not-loaded`: the config write landed, the channel did not, and the
 * app said so with a line about reloading that mostly read as an alarm.
 *
 * Nothing in that context actually had to come from the host. The plugin's own
 * paths module resolves both fields from this file's location, and for an
 * external plugin the storage directory it derives is the same `<plugin>/data`
 * the host passes in — so a channel built on this one is the same channel,
 * writing the same poll cursor.
 *
 * The logger falls back to the console rather than to no-ops. Discarding it
 * was a mistake worth naming: webhook registration reports what it did through
 * this logger and nothing else, so a channel started without a host context
 * would fail to register and say nothing anywhere.
 */
function derivedContext(): RuntimeContext {
  const write =
    (level: "debug" | "info" | "warn" | "error") =>
    (obj: object, msg: string) => {
      console[level === "debug" ? "log" : level](msg, obj);
    };
  return {
    logger: {
      debug: write("debug"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
    },
    pluginStorageDir: pluginDataDir(),
    pluginName: pluginName(),
  };
}

/**
 * Build the provider for `config` and start its ingress.
 *
 * Never throws: a provider that cannot be built, or an ingress mode the
 * provider does not support, leaves the channel idle with a reason. Plugin
 * load and a settings edit both need to survive a bad configuration.
 */
export async function startChannelRuntime(
  config: SMSConfig,
  options: StartRuntimeOptions = {},
): Promise<StartRuntimeResult> {
  const ctx = getInitContext() ?? derivedContext();

  await stopIngress();
  setConfig(config);

  // Clear the previous provider before attempting to build the new one. If the
  // build fails we must not leave the old provider active: outbound would keep
  // going out over a provider the config no longer names, while the settings
  // app reports the new one. Idle is the honest state.
  releaseProvider();
  setChannel(undefined);

  let provider;
  try {
    provider = resolveProvider({ config });
  } catch (err) {
    const idleReason = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(
      { err, provider: config.provider },
      "sms: could not build the configured provider — the channel is idle",
    );
    return { status: "idle", idleReason };
  }

  setProvider(provider);
  setChannel(buildChannelProvider(provider));

  if (config.ingressMode === "webhook") {
    ctx.logger.info(
      { provider: provider.id },
      `sms: webhook ingress — inbound arrives at /webhooks/plugins/${ctx.pluginName}/events-twilio`,
    );
    if (options.waitForSetup) {
      await registerWebhook(provider, ctx.logger);
      const report = getWebhookReport();
      if (report?.outcome === "failed") {
        return {
          status: "idle",
          idleReason: describeWebhookFailure(report),
        };
      }
    } else {
      // Boot does not wait: registration is a network round trip, and plugin
      // load should not block on it. A failure leaves the channel running.
      // Outbound still works, and inbound was not going to arrive either way.
      void registerWebhook(provider, ctx.logger);
    }
    return { status: "running" };
  }

  if (!provider.supportsPolling) {
    const idleReason = `provider ${provider.id} is webhook-only but ingressMode is 'poll'`;
    ctx.logger.warn({ provider: provider.id }, `sms: ${idleReason}`);
    return { status: "idle", idleReason };
  }

  const supervisor = new PollWorkerSupervisor({
    bootstrap: {
      storageDir: ctx.pluginStorageDir,
      intervalMs: config.pollIntervalMs,
      provider: config.provider,
    },
    logger: ctx.logger,
    sink: (event) => {
      // Still nowhere to hand this. Webhook mode reaches the host's inbound
      // pipeline by *replying* to a delivery the gateway gated and forwarded —
      // see `webhook-route.ts` — and a polled message is not a reply to
      // anything, so it has no such opening. Posting it straight into a
      // conversation would skip the kill switch, trust classification, and the
      // admission floor, which is exactly the gap this channel must not open,
      // so it is logged and dropped until the host offers a way in that is not
      // a webhook reply. Deployments that need inbound run `ingressMode:
      // "webhook"`.
      ctx.logger.info(
        {
          actorExternalId: event.actor.actorExternalId,
          conversationExternalId: event.message.conversationExternalId,
          externalMessageId: event.message.externalMessageId,
          chatType: event.source.chatType,
        },
        "sms: normalized inbound message (poll mode cannot start turns)",
      );
    },
  });

  supervisor.start();
  setSupervisor(supervisor);

  ctx.logger.info(
    { provider: provider.id, intervalMs: config.pollIntervalMs },
    "sms: poll worker started",
  );
  return { status: "running" };
}
