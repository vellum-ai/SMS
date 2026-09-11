/**
 * Channel runtime for the webhook-only SMS provider.
 *
 * Shared by `init` and the credential route so a settings save follows the
 * same setup path as a fresh boot.
 */

import { buildChannelProvider } from "./channel/provider.ts";
import type { SMSConfig } from "./config.ts";
import { describeError } from "./providers/error-detail.ts";
import { resolveProvider } from "./providers/index.ts";
import type { MessagingProvider } from "./providers/types.ts";
import {
  getInitContext,
  getProvider,
  getWebhookReport,
  setChannel,
  setConfig,
  setProvider,
  setWebhookReport,
  type RuntimeContext,
  type WebhookRegistrationStep,
} from "./plugin-state.ts";
import { pluginName } from "./plugin-paths.ts";
import { resolveWebhookEndpoint } from "./webhook-endpoint.ts";
import { describeWebhookFailure } from "./webhook-report.ts";

export type ChannelStatus = "running" | "idle";

export interface StartRuntimeResult {
  status: ChannelStatus;
  idleReason?: string;
}

export interface StartRuntimeOptions {
  /** Wait for webhook registration before returning. */
  waitForSetup?: boolean;
}

/** Point the configured number's webhook at this plugin's ingress route. */
async function registerWebhook(
  provider: MessagingProvider,
  logger: RuntimeContext["logger"],
): Promise<void> {
  const at = new Date().toISOString();
  let step: WebhookRegistrationStep = "resolve-url";

  const fail = (err: unknown, message: string): void => {
    const reason = describeError(err);
    setWebhookReport({ provider: provider.id, outcome: "failed", step, reason, at });
    logger.warn(
      { err, reason, step, provider: provider.id },
      `sms: ${message}; the channel is running but will not receive inbound messages`,
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
        "sms: no webhook could be registered; inbound will not arrive until the assistant has a public URL",
      );
      return;
    }

    step = "call-provider";
    const result = await provider.ensureWebhook({ url: endpoint.url, hasSecret: true });
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
    fail(err, "could not program the inbound webhook");
  }
}

/** Drop the current provider, giving back anything it holds open. */
export function releaseProvider(): void {
  const previous = getProvider();
  setProvider(undefined);
  void previous?.close?.().catch(() => {});
}

/** A runtime context for a caller the init hook has not reached. */
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
    pluginStorageDir: "",
    pluginName: pluginName(),
  };
}

/** Build the provider and register its webhook ingress. */
export async function startChannelRuntime(
  config: SMSConfig,
  options: StartRuntimeOptions = {},
): Promise<StartRuntimeResult> {
  const ctx = getInitContext() ?? derivedContext();
  setConfig(config);

  releaseProvider();
  setChannel(undefined);

  let provider: MessagingProvider;
  try {
    provider = resolveProvider({ config });
  } catch (err) {
    const idleReason = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(
      { err, provider: config.provider },
      "sms: could not build the configured provider; the channel is idle",
    );
    return { status: "idle", idleReason };
  }

  setProvider(provider);
  setChannel(buildChannelProvider(provider));
  ctx.logger.info(
    { provider: provider.id },
    `sms: webhook ingress at /webhooks/plugins/${ctx.pluginName}/events-twilio`,
  );

  if (options.waitForSetup) {
    await registerWebhook(provider, ctx.logger);
    const report = getWebhookReport();
    if (report?.outcome === "failed") {
      return { status: "idle", idleReason: describeWebhookFailure(report) };
    }
  } else {
    void registerWebhook(provider, ctx.logger);
  }

  return { status: "running" };
}
