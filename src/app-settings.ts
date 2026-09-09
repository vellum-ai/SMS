/**
 * The plugin config as the configuration app sees it.
 *
 * The app shows the resolved config and lets a few fields be edited. Values
 * live in the host-owned plugin `config.json` — the same file the `init` hook
 * reads via `InitContext.config` — and an edit merges into that file so
 * unrelated fields are preserved.
 *
 * `provider` is deliberately not part of the settings PATCH, and there is no
 * provider-switch route: Twilio is the only implementation, so there is
 * nothing to switch to. The field stays in the config shape so the seam does
 * not have to lose it, and a second provider will bring its own route back
 * with it.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { z } from "zod";

import type { SMSConfig } from "./config.ts";
import { INGRESS_MODES, SMSConfigSchema } from "./config.ts";

/** The resolved config the app displays. No secrets live in it. */
export type ConfigView = SMSConfig;

/**
 * Partial update accepted by the settings PATCH route.
 *
 * `.strict()` so an unknown or non-editable key is a 400 rather than a silent
 * no-op — a user who edits `provider` here should be told it is not
 * switchable, not left wondering why nothing changed.
 */
export const ConfigUpdateSchema = z
  .object({
    ingressMode: z.enum(INGRESS_MODES).optional(),
    pollIntervalMs: z.number().int().optional(),
  })
  .strict();

export type ConfigUpdate = z.infer<typeof ConfigUpdateSchema>;

/**
 * Parse `config.json` into a plain object.
 *
 * Returns `{}` when the file is missing or unparsable, so a fresh install
 * reads as all-defaults and a write starts from an empty object rather than
 * crashing.
 */
function readConfigObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to empty.
  }
  return {};
}

/** Resolve `config.json` through the schema so defaults are filled in. */
export function readConfigView(configPath: string): ConfigView {
  const parsed = SMSConfigSchema.safeParse(readConfigObject(configPath));
  return parsed.success ? parsed.data : SMSConfigSchema.parse({});
}

/**
 * Validate a partial update against the current file without writing it.
 *
 * A settings save starts the channel on this view first, and only writes if
 * that start succeeds. Parsing here is what rejects an out-of-range interval
 * before ingress is torn down.
 */
export function mergeConfigUpdate(
  configPath: string,
  update: ConfigUpdate,
): ConfigView {
  const merged = { ...readConfigObject(configPath), ...update };
  const parsed = SMSConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigValidationError(
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    );
  }
  return parsed.data;
}

/**
 * Merge a partial update into `config.json` and persist it.
 *
 * Merging rather than replacing keeps fields the app does not surface. The
 * write is atomic (temp file plus rename) so a crash mid-write cannot leave a
 * truncated config that reads back as all-defaults.
 *
 * Throws when the merged result fails validation, so an out-of-range interval
 * is rejected before it is written rather than silently reset on next boot.
 */
export function applyConfigUpdate(
  configPath: string,
  update: ConfigUpdate,
): ConfigView {
  const view = mergeConfigUpdate(configPath, update);
  writeConfigObject(configPath, { ...readConfigObject(configPath), ...update });
  return view;
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function writeConfigObject(
  configPath: string,
  value: Record<string, unknown>,
): void {
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, configPath);
}
