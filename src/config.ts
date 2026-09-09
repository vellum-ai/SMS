/**
 * Plugin configuration — schema, defaults, and credential resolution.
 *
 * The host hands the plugin its parsed config as `InitContext.config` (an
 * `unknown`). This module owns the single Zod schema that validates it.
 *
 * No secret is a config field, and no credential name is configurable: the
 * provider resolves from the fixed set of fields declared in
 * `PROVIDER_CREDENTIALS`, so secrets live in the credential store rather than
 * as plaintext in `config.json`.
 */

import { resolveCredential } from "@vellumai/plugin-api";
import { z } from "zod";

import { describeError } from "./providers/error-detail.ts";
import type { ProviderId } from "./providers/types.ts";
import { PROVIDER_IDS } from "./providers/types.ts";

/**
 * Fixed credential service the provider reads its secrets from.
 *
 * `resolveCredential` takes a `"service/field"` ref; the colon form
 * (`sms:auth_token`) is the human-facing name used by the `assistant
 * credentials` CLI and in error messages. Keep the two spellings straight —
 * passing the colon form to `resolveCredential` does not resolve.
 */
export const CREDENTIAL_SERVICE = "sms";

/**
 * One credential a provider needs, as the settings app renders it.
 *
 * Field identity only — what it is called and how to draw its input. The
 * prose around it (what the provider is, where to get a key) is display copy
 * and lives in the app's provider catalog, mirroring how the assistant's own
 * provider forms split the two.
 *
 * `secret: false` is not decoration. The account sid and the from number are
 * identifiers that appear in Twilio's own dashboard URLs, and masking them
 * means a user cannot check the value they just pasted against the one on
 * screen. Masking exists for the value that would compromise the account
 * (the auth token), not for every field next to it.
 */
export interface CredentialField {
  /** Field name within the `sms` credential service. */
  field: string;
  label: string;
  /** Shown in the empty input. Replaced by a masked hint once a value exists. */
  placeholder: string;
  secret: boolean;
}

/**
 * What the provider needs stored before it can do anything.
 *
 * The settings app reads this to render its fields, and `checkReadiness` on
 * the adapter resolves exactly these. One list, so the provider cannot ask
 * for a credential the app never offers to collect.
 */
export const PROVIDER_CREDENTIALS: Record<
  ProviderId,
  readonly CredentialField[]
> = {
  twilio: [
    {
      field: "account_sid",
      label: "Account SID",
      placeholder: "Enter your Twilio account SID (AC...)",
      secret: false,
    },
    {
      field: "auth_token",
      label: "Auth Token",
      placeholder: "Enter your Twilio auth token",
      secret: true,
    },
    {
      field: "from_number",
      label: "From Number",
      placeholder: "Enter the number to send from, e.g. +15551234567",
      secret: false,
    },
  ],
};

/**
 * Where the inbound-webhook signing credential is stored.
 *
 * Twilio never issues a webhook secret: every delivery is signed with the
 * account auth token the user already holds. So this is the same field as
 * `PROVIDER_CREDENTIALS` rather than a plugin-issued one, and the settings
 * app collects it as part of the ordinary credential form.
 *
 * The gateway reads the same credential when it verifies a delivery — the
 * route's `verification.secret.field` in `channels/ingress.json` names
 * exactly this. Renaming it here without renaming it there silently stops
 * every delivery from verifying.
 */
export const WEBHOOK_SECRET_FIELDS: Record<ProviderId, string> = {
  twilio: "auth_token",
};

/**
 * How inbound messages reach the plugin.
 *
 * `webhook` is the default: Twilio POSTs each inbound message to the number's
 * configured URL, and the gateway verifies the `X-Twilio-Signature` before
 * the plugin route ever runs.
 *
 * `poll` exists for deployments whose gateway is not reachable from the
 * internet. It reads the account's Messages list on an interval. Poll mode
 * cannot start turns (see `channel-runtime.ts` for the gap), so webhook mode
 * is the only mode that receives.
 */
export const INGRESS_MODES = ["webhook", "poll"] as const;
export type IngressMode = (typeof INGRESS_MODES)[number];

/** Bounds on the poll interval. Twilio rate-limits with 429. */
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 300_000;

export const SMSConfigSchema = z
  .object({
    provider: z
      .enum(PROVIDER_IDS)
      .default("twilio")
      .describe(
        "Which provider backs the line. Twilio is the only implementation.",
      ),
    ingressMode: z
      .enum(INGRESS_MODES)
      .default("webhook")
      .describe(
        "How inbound messages arrive: 'webhook' (Twilio POSTs to this plugin's ingress route, the default) or 'poll' for deployments with no public ingress.",
      ),
    pollIntervalMs: z
      .number()
      .int()
      .min(MIN_POLL_INTERVAL_MS)
      .max(MAX_POLL_INTERVAL_MS)
      .default(5_000)
      .describe("Delay between polls, in milliseconds. Only used in poll mode."),
  });

export type SMSConfig = z.infer<typeof SMSConfigSchema>;

export interface ResolvedConfig {
  config: SMSConfig;
  warnings: string[];
}

/**
 * Validate the host-supplied config.
 *
 * Invalid values fall back to defaults with a warning rather than throwing: a
 * bad interval should not stop the channel from loading.
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const warnings: string[] = [];
  const parsed = SMSConfigSchema.safeParse(raw ?? {});

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      warnings.push(`${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    warnings.push("falling back to default configuration");
    return { config: SMSConfigSchema.parse({}), warnings };
  }

  return { config: parsed.data, warnings };
}

/**
 * Read one stored credential field.
 *
 * Resolved at call time rather than at load, so a rotated token takes effect
 * without a daemon restart and an unconfigured line fails only when it is
 * actually used.
 *
 * `resolveCredential` throws when the reference does not resolve. That error
 * covers a missing value, an unreachable store, and a scoping refusal with
 * one type, so this message does not guess which it was. The store's own
 * words lead, because a guessed "not set" is the diagnosis that sends someone
 * to re-enter a key that is already there. An empty value is the one case
 * this path can name as unset.
 */
export async function resolveCredentialField(
  field: string,
  label: string,
): Promise<string> {
  let value: string | undefined;
  try {
    value = await resolveCredential(`${CREDENTIAL_SERVICE}/${field}`);
  } catch (err) {
    throw new Error(`${label} could not be read: ${describeError(err)}`, {
      cause: err,
    });
  }

  if (value) {
    return value;
  }

  throw new Error(`${label} is not set. Add it in the SMS settings app.`);
}

/** Read the Twilio account sid. */
export async function resolveAccountSid(): Promise<string> {
  return resolveCredentialField("account_sid", "The Twilio account SID");
}

/** Read the Twilio auth token. */
export async function resolveAuthToken(): Promise<string> {
  return resolveCredentialField("auth_token", "The Twilio auth token");
}

/** Read the number this plugin sends from. */
export async function resolveFromNumber(): Promise<string> {
  return resolveCredentialField("from_number", "The from number");
}
