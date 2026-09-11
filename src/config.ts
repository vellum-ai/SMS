/**
 * Plugin configuration and credential resolution.
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

/** Fixed credential service the provider reads its secrets from. */
export const CREDENTIAL_SERVICE = "sms";

/** One credential a provider needs, as the settings app renders it. */
export interface CredentialField {
  field: string;
  label: string;
  placeholder: string;
  secret: boolean;
}

/** What the provider needs stored before it can do anything. */
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
 * Twilio signs deliveries with the account auth token the user already holds.
 * The gateway reads this same field when it verifies inbound deliveries.
 */
export const WEBHOOK_SECRET_FIELDS: Record<ProviderId, string> = {
  twilio: "auth_token",
};

export const SMSConfigSchema = z.object({
  provider: z
    .enum(PROVIDER_IDS)
    .default("twilio")
    .describe("Which provider backs the line. Twilio is the only implementation."),
});

export type SMSConfig = z.infer<typeof SMSConfigSchema>;

export interface ResolvedConfig {
  config: SMSConfig;
  warnings: string[];
}

/** Validate the host-supplied configuration. */
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

/** Read one stored credential field. */
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

  if (value) return value;

  throw new Error(`${label} is not set. Add it in the SMS settings app.`);
}

export async function resolveAccountSid(): Promise<string> {
  return resolveCredentialField("account_sid", "The Twilio account SID");
}

export async function resolveAuthToken(): Promise<string> {
  return resolveCredentialField("auth_token", "The Twilio auth token");
}

export async function resolveFromNumber(): Promise<string> {
  return resolveCredentialField("from_number", "The from number");
}
