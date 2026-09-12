/**
 * Reading and writing the plugin's non-secret configuration.
 *
 * Values live in the host-owned plugin config.json, the same file the init
 * hook receives through InitContext.config. Account credentials never pass
 * through this module.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { normalizeHandle } from "./channel/identity.ts";
import type { SMSConfig } from "./config.ts";
import { SMSConfigSchema } from "./config.ts";

export type ConfigView = SMSConfig;

function readConfigObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A fresh or partially written host config reads as defaults.
  }
  return {};
}

/** Resolve config.json through the schema so defaults are filled in. */
export function readConfigView(configPath: string): ConfigView {
  const parsed = SMSConfigSchema.safeParse(readConfigObject(configPath));
  return parsed.success ? parsed.data : SMSConfigSchema.parse({});
}

/**
 * Persist the assistant's Twilio number without touching the credential vault.
 *
 * The canonical E.164 spelling is required because this number is used both as
 * Twilio's outbound From value and to match an IncomingPhoneNumbers record.
 */
export function saveFromNumber(configPath: string, rawNumber: string): ConfigView {
  const fromNumber = normalizeHandle(rawNumber);
  if (!fromNumber) {
    throw new Error("The assistant SMS number must be a valid E.164 phone number.");
  }

  const next = { ...readConfigObject(configPath), fromNumber };
  const parsed = SMSConfigSchema.safeParse(next);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    );
  }

  writeConfigObject(configPath, next);
  return parsed.data;
}

function writeConfigObject(configPath: string, value: Record<string, unknown>): void {
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, configPath);
}
