/**
 * Plugin configuration and credential resolution.
 *
 * The Twilio Account SID and Auth Token are vault credentials. The assistant's
 * SMS line is a non-secret, user-owned setting in this plugin's config.json.
 * Keeping the line in config lets setup select it from the authenticated
 * Twilio account without treating a public phone number as a secret.
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

/** What the provider needs stored before it can make authenticated API calls. */
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
  ],
};

/**
 * Twilio signs deliveries with the account auth token the user already holds.
 * The gateway reads this same field when it verifies inbound deliveries.
 */
export const WEBHOOK_SECRET_FIELDS: Record<ProviderId, string> = {
  twilio: "auth_token",
};

const E164_NUMBER = /^\+[1-9]\d{6,14}$/;

export const SMSConfigSchema = z.object({
  provider: z
    .enum(PROVIDER_IDS)
    .default("twilio")
    .describe("Which provider backs the line. Twilio is the only implementation."),
  fromNumber: z
    .string()
    .regex(E164_NUMBER, "must be an E.164 phone number, for example +15551234567")
    .optional()
    .describe("The Twilio SMS line the assistant sends and receives on."),
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
