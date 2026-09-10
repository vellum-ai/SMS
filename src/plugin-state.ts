/**
 * In-process handles the hooks, routes, and runtime share.
 *
 * The webhook route reads the durable config file because the host may load it
 * as a different module instance from the one initialized by the hook.
 */

import type { PluginChannelProvider } from "./channel/contract.ts";
import type { SMSConfig } from "./config.ts";
import type { MessagingProvider } from "./providers/types.ts";

export interface RuntimeLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface RuntimeContext {
  logger: RuntimeLogger;
  pluginStorageDir: string;
  pluginName: string;
}

export type WebhookRegistrationStep = "resolve-url" | "call-provider";

export interface WebhookRegistrationReport {
  provider: string;
  outcome: "registered" | "already-registered" | "skipped" | "failed";
  url?: string;
  step?: WebhookRegistrationStep;
  reason?: string;
  at: string;
}

interface PluginState {
  initContext?: RuntimeContext;
  config?: SMSConfig;
  provider?: MessagingProvider;
  channel?: PluginChannelProvider;
  webhookReport?: WebhookRegistrationReport;
}

const state: PluginState = {};

export function setInitContext(context: RuntimeContext): void {
  state.initContext = context;
}

export function getInitContext(): RuntimeContext | undefined {
  return state.initContext;
}

export function setConfig(config: SMSConfig): void {
  state.config = config;
}

export function getConfig(): SMSConfig | undefined {
  return state.config;
}

export function setProvider(provider: MessagingProvider | undefined): void {
  state.provider = provider;
}

export function getProvider(): MessagingProvider | undefined {
  return state.provider;
}

export function setChannel(channel: PluginChannelProvider | undefined): void {
  state.channel = channel;
}

export function getChannel(): PluginChannelProvider | undefined {
  return state.channel;
}

export function setWebhookReport(report: WebhookRegistrationReport): void {
  state.webhookReport = report;
}

export function getWebhookReport(): WebhookRegistrationReport | undefined {
  return state.webhookReport;
}

export function resetPluginState(): void {
  state.initContext = undefined;
  state.config = undefined;
  state.provider = undefined;
  state.channel = undefined;
  state.webhookReport = undefined;
}
