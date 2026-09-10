/**
 * Reading the plugin configuration for the settings app and webhook route.
 *
 * Values live in the host-owned plugin `config.json`, the same file the init
 * hook receives through `InitContext.config`. The schema fills defaults and
 * strips retired configuration keys, including the former polling options.
 */

import { existsSync, readFileSync } from "node:fs";

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

/** Resolve `config.json` through the schema so defaults are filled in. */
export function readConfigView(configPath: string): ConfigView {
  const parsed = SMSConfigSchema.safeParse(readConfigObject(configPath));
  return parsed.success ? parsed.data : SMSConfigSchema.parse({});
}
