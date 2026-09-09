/**
 * Phone numbers the assistant already knows, and the guardian's SMS identity.
 *
 * The setup skill uses this to prefill and to check verification: inbound from
 * a number that is not a verified identity on the guardian is classified
 * unknown and denied under the default plugin floor, so the guardian's own
 * number is the first thing worth having attested.
 *
 * Parsing the contacts list here, rather than asking the setup skill to
 * re-derive it, keeps the skill script and any future surface on the same set.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { normalizeHandle } from "./identity.ts";

const execFileAsync = promisify(execFile);

/** Channel types whose address is a phone number. */
const PHONE_CHANNEL_TYPES = new Set(["phone", "imessage", "sms", "whatsapp"]);

/** Contacts-page / prompt type for this plugin's discovered channel. */
const SMS_CHANNEL_TYPE = "sms";

/** Inbound trust stores the same handle as `sms:+E.164` on type `plugin`. */
const SMS_INBOUND_PREFIX = "sms:";

/** Channel statuses that mean "do not message this person". */
const SKIP_STATUSES = new Set(["blocked", "revoked"]);

/** How long to wait for `assistant contacts list` before giving up. */
const LIST_CONTACTS_TIMEOUT_MS = 10_000;

/** A guardian SMS handle already on the contact graph. */
export interface GuardianSmsIdentity {
  address: string;
  verified: boolean;
}

/**
 * E.164 numbers on a contacts-list payload.
 *
 * Accepts both shapes the host actually emits: the HTTP/OpenAPI form
 * (`type` + `address`) and the CLI form the contacts skill documents
 * (`channel` + `externalUserId`). A blocked or revoked channel is skipped.
 */
export function phoneNumbersFromContacts(payload: unknown): string[] {
  const contacts = contactsOf(payload);
  const phones = new Set<string>();

  for (const contact of contacts) {
    if (!contact || typeof contact !== "object") continue;
    const channels = (contact as { channels?: unknown }).channels;
    if (!Array.isArray(channels)) continue;

    for (const channel of channels) {
      const phone = phoneFromChannel(channel);
      if (phone) phones.add(phone);
    }
  }

  return [...phones];
}

/** `assistant contacts list --json`, parsed. */
export async function listContactsJson(
  extraArgs: readonly string[] = [],
): Promise<unknown> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "assistant",
      ["contacts", "list", "--json", "--limit", "100", ...extraArgs],
      { timeout: LIST_CONTACTS_TIMEOUT_MS, encoding: "utf8" },
    );
    stdout = result.stdout;
  } catch (err) {
    const detail =
      err instanceof Error
        ? (err as { stderr?: string }).stderr?.trim() || err.message
        : String(err);
    throw new Error(
      `assistant contacts list failed: ${detail.slice(0, 300)}`,
    );
  }

  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("assistant contacts list returned a body that is not JSON");
  }
}

/** Guardian contacts only. The setup skill uses this before prompting. */
export async function listGuardianContactsJson(): Promise<unknown> {
  return listContactsJson(["--role", "guardian"]);
}

/**
 * The first usable phone number on the guardian contact, if any.
 *
 * `listJson` is the test seam. Production reads
 * `assistant contacts list --role guardian --json`.
 */
export async function loadGuardianPhoneNumber(
  listJson: () => Promise<unknown> = listGuardianContactsJson,
): Promise<string | undefined> {
  return phoneNumbersFromContacts(await listJson())[0];
}

/**
 * The guardian's SMS identity, if one is already stored.
 *
 * Looks at type `sms` and at the inbound `(plugin, sms:…)` row. A Phone
 * Calling number does not count: inbound trust is a different (type, address)
 * key, so a verified phone is still unknown on this channel.
 *
 * `listJson` is the test seam. Production reads
 * `assistant contacts list --role guardian --json`.
 */
export async function loadGuardianSmsIdentity(
  listJson: () => Promise<unknown> = listGuardianContactsJson,
): Promise<GuardianSmsIdentity | undefined> {
  return smsIdentityFromContacts(await listJson());
}

/**
 * First SMS identity on a contacts-list payload.
 *
 * Prefers a verified row when both an unverified discovered channel and a
 * verified inbound row exist. Same HTTP and CLI channel shapes as
 * {@link phoneNumbersFromContacts}.
 */
export function smsIdentityFromContacts(
  payload: unknown,
): GuardianSmsIdentity | undefined {
  const contacts = contactsOf(payload);
  let fallback: GuardianSmsIdentity | undefined;

  for (const contact of contacts) {
    if (!contact || typeof contact !== "object") {
      continue;
    }
    const channels = (contact as { channels?: unknown }).channels;
    if (!Array.isArray(channels)) {
      continue;
    }

    for (const channel of channels) {
      const identity = smsIdentityFromChannel(channel);
      if (!identity) {
        continue;
      }
      if (identity.verified) {
        return identity;
      }
      if (!fallback) {
        fallback = identity;
      }
    }
  }

  return fallback;
}

function contactsOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const contacts = (payload as { contacts?: unknown }).contacts;
  return Array.isArray(contacts) ? contacts : [];
}

function smsIdentityFromChannel(
  channel: unknown,
): GuardianSmsIdentity | undefined {
  if (!channel || typeof channel !== "object") {
    return undefined;
  }
  const row = channel as {
    status?: unknown;
    policy?: unknown;
    type?: unknown;
    channel?: unknown;
    address?: unknown;
    externalUserId?: unknown;
    externalChatId?: unknown;
  };

  const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
  if (SKIP_STATUSES.has(status)) {
    return undefined;
  }
  if (typeof row.policy === "string" && row.policy.toLowerCase() === "deny") {
    return undefined;
  }

  const kind =
    typeof row.type === "string"
      ? row.type.toLowerCase()
      : typeof row.channel === "string"
        ? row.channel.toLowerCase()
        : "";
  const isDiscovered = kind === SMS_CHANNEL_TYPE;
  const isInbound = kind === "plugin";
  if (!isDiscovered && !isInbound) {
    return undefined;
  }

  const candidates = [row.address, row.externalUserId, row.externalChatId];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") {
      continue;
    }
    const handle = handleFromSmsAddress(candidate, isInbound);
    if (!handle) {
      continue;
    }
    return { address: handle, verified: channelLooksVerified(status) };
  }
  return undefined;
}

function handleFromSmsAddress(
  raw: string,
  requirePrefix: boolean,
): string | undefined {
  const trimmed = raw.trim();
  const prefixed = trimmed.toLowerCase().startsWith(SMS_INBOUND_PREFIX);
  if (requirePrefix && !prefixed) {
    return undefined;
  }
  const unscoped = prefixed
    ? trimmed.slice(SMS_INBOUND_PREFIX.length)
    : trimmed;
  return normalizeHandle(unscoped);
}

function channelLooksVerified(status: string): boolean {
  return status === "verified" || status === "active";
}

function phoneFromChannel(channel: unknown): string | undefined {
  if (!channel || typeof channel !== "object") return undefined;
  const row = channel as {
    status?: unknown;
    policy?: unknown;
    type?: unknown;
    channel?: unknown;
    address?: unknown;
    externalUserId?: unknown;
    externalChatId?: unknown;
  };

  const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
  if (SKIP_STATUSES.has(status)) return undefined;
  if (typeof row.policy === "string" && row.policy.toLowerCase() === "deny") {
    return undefined;
  }

  const kind =
    typeof row.type === "string"
      ? row.type
      : typeof row.channel === "string"
        ? row.channel
        : "";
  if (kind && !PHONE_CHANNEL_TYPES.has(kind.toLowerCase())) return undefined;

  const candidates = [row.address, row.externalUserId, row.externalChatId];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const phone = normalizeHandle(candidate);
    if (phone) return phone;
  }
  return undefined;
}
