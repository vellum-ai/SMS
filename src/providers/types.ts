/**
 * The provider seam.
 *
 * Everything above this interface, including the transport and webhook route,
 * is provider-agnostic. Only the adapter under `src/providers/twilio/` knows
 * what a Twilio payload looks like.
 */

import type { PluginInboundEvent } from "../channel/contract.ts";

export const PROVIDER_IDS = ["twilio"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const UNAVAILABLE_PROVIDERS: Partial<Record<ProviderId, string>> = {};

export function unavailableProviderReason(id: string): string | undefined {
  return UNAVAILABLE_PROVIDERS[id as ProviderId];
}

export function unavailableProviderList(): { id: string; reason: string }[] {
  return Object.entries(UNAVAILABLE_PROVIDERS).map(([id, reason]) => ({
    id,
    reason,
  }));
}

/** Where an outbound message is addressed. */
export type SendTarget = { to: string } | { conversationId: string };

/** What a webhook delivery turned out to be. */
export type WebhookDelivery =
  | { kind: "message"; event: PluginInboundEvent }
  | { kind: "ignored"; reason: string };

export interface SendResult {
  id?: string;
}

/** What a provider must implement to back this webhook-only channel. */
export interface MessagingProvider {
  readonly id: ProviderId;
  readonly label: string;

  checkReadiness(): Promise<{ ready: true } | { ready: false; reason: string }>;
  ensureWebhook(opts: EnsureWebhookOptions): Promise<WebhookRegistration>;
  send(
    target: SendTarget,
    body: string,
    opts: { idempotencyKey: string },
  ): Promise<SendResult>;
  classifyWebhook(raw: unknown, receivedAt: string): WebhookDelivery;
  close?(): Promise<void>;
}

export interface EnsureWebhookOptions {
  url: string;
  hasSecret: boolean;
}

export interface WebhookRegistration {
  created: boolean;
  id?: string;
  secret?: string;
}
