/**
 * The provider seam.
 *
 * Everything above this interface — the poller, the transport, the webhook
 * route — is provider-agnostic and must stay that way. Only the adapter under
 * `src/providers/twilio/` knows what Twilio's payloads look like.
 *
 * One provider, deliberately. Twilio is the only one implemented and the only
 * one offered; the seam survives anyway because it is what keeps the rest of
 * the plugin honest about where vendor knowledge ends, and a second provider
 * (Telnyx, MessageBird) would be a directory and a registry entry rather than
 * a rewrite.
 *
 * Bring-your-own, same as the iMessage plugin: the user holds the Twilio
 * account and the billing.
 */

import type { PluginInboundEvent } from "../channel/contract.ts";

export const PROVIDER_IDS = ["twilio"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Providers that are implemented but not offered for selection yet.
 *
 * The settings panel still lists them, disabled, with `reason` as the hover
 * tooltip. The provider route refuses a switch onto one. An install that
 * already names one keeps running.
 */
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

/**
 * Where an outbound message is addressed.
 *
 * Twilio has no conversation ids — a 1:1 SMS thread is just a pair of
 * numbers — so `to` is the only arm a Twilio delivery ever produces. The
 * `conversationId` arm stays because the seam is provider-agnostic and a
 * future provider with server-side threads would need it.
 */
export type SendTarget = { to: string } | { conversationId: string };

/**
 * One message the poller paged over.
 *
 * `event` is absent when the record is not a turn — an outbound echo, a
 * delivery receipt, an unattributable message. The poller still advances its
 * cursor past those, so normalization has to happen inside the adapter rather
 * than after the poller hands the record back.
 */
export interface InboundRecord {
  id: string;
  /** Provider-side creation time, used only to advance the poll cursor. */
  createdAt?: string;
  event?: PluginInboundEvent;
}

/**
 * What a webhook delivery turned out to be.
 *
 * A verdict rather than an optional event, because "not a turn" is more than
 * one unrelated thing and the caller has to tell them apart. A status
 * callback is routine and ignored; an unparsable body is a bug in one of us.
 * Collapsing both into `undefined` makes a routine receipt read exactly like
 * a delivery that went nowhere.
 */
export type WebhookDelivery =
  | { kind: "message"; event: PluginInboundEvent }
  | { kind: "ignored"; reason: string };

export interface FetchInboundOptions {
  /** ISO-8601 lower bound. */
  since?: string;
  limit: number;
}

export interface SendResult {
  /** Provider id of the delivered message, when the send returned one. */
  id?: string;
}

/**
 * What a provider must implement to back this channel.
 *
 * Deliberately small. Twilio supports polling (the Messages list API), so
 * `fetchInbound` is required in practice; `supportsPolling` still lets the
 * runtime pick the ingress mode rather than find out at runtime. There is no
 * long-lived stream to subscribe to, so live ingress does not exist here.
 */
export interface MessagingProvider {
  readonly id: ProviderId;
  /** Human-readable name for logs and user-facing errors. */
  readonly label: string;
  /** Whether `fetchInbound` is usable on this provider. */
  readonly supportsPolling: boolean;
  /**
   * Whether `subscribeInbound` is usable on this provider.
   *
   * Always false: Twilio has no long-lived inbound connection. The field
   * stays so the runtime can ask rather than know.
   */
  readonly supportsLive: boolean;

  /**
   * Confirm the provider is configured and reachable.
   *
   * Returning a reason rather than throwing keeps "not set up yet" — the normal
   * state right after install — distinct from a genuine failure.
   */
  checkReadiness(): Promise<{ ready: true } | { ready: false; reason: string }>;

  fetchInbound(opts: FetchInboundOptions): Promise<InboundRecord[]>;

  /**
   * Point the provider's webhook at `opts.url`, if it is not already.
   *
   * Twilio has no webhook registry: the delivery URL is a field on the phone
   * number itself (`SmsUrl` / `SmsMethod`), so "registering" means updating
   * the configured number. Implementations compare first and write only when
   * the value differs, so the every-start call costs one read rather than a
   * write.
   */
  ensureWebhook(opts: EnsureWebhookOptions): Promise<WebhookRegistration>;

  send(
    target: SendTarget,
    body: string,
    opts: { idempotencyKey: string },
  ): Promise<SendResult>;

  /**
   * Read one webhook delivery and say what it is.
   *
   * Only the adapter knows its vendor's event vocabulary, so only it can
   * decide what a given delivery means.
   */
  classifyWebhook(raw: unknown, receivedAt: string): WebhookDelivery;

  /**
   * Release whatever the provider is holding open.
   *
   * Optional because a `fetch`-based client has no connection of its own to
   * give back. Twilio holds nothing, so the adapter omits it.
   */
  close?(): Promise<void>;
}

/**
 * Options for {@link MessagingProvider.ensureWebhook}.
 *
 * `hasSecret` is part of the seam but unused by Twilio: the signing key is
 * the account auth token the user already holds, so there is no issued
 * secret to lose and nothing to replace on registration.
 */
export interface EnsureWebhookOptions {
  /** Absolute URL the provider should deliver to. */
  url: string;
  /**
   * Whether the plugin already holds this provider's signing secret.
   */
  hasSecret: boolean;
}

/** What `ensureWebhook` found or did. */
export interface WebhookRegistration {
  /** False when a usable registration for that URL was already there. */
  created: boolean;
  /** Provider-side id, when the provider returned one. */
  id?: string;
  /**
   * Signing secret the provider issued, for the caller to store.
   *
   * Twilio never issues one — every delivery is signed with the account auth
   * token — so this is always absent here. The field stays because the seam
   * is provider-agnostic and the runtime stores it when a provider hands one
   * over.
   */
  secret?: string;
}
