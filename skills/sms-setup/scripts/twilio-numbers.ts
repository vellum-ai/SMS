#!/usr/bin/env bun
/**
 * Inspect, select, and purchase the assistant's Twilio SMS line.
 *
 * This script never accepts or prints Twilio credentials. The Account SID and
 * Auth Token are resolved from the SMS credential store by TwilioClient. The
 * selected phone number is written to the plugin's non-secret config.json.
 *
 * Commands:
 *   bun skills/sms-setup/scripts/twilio-numbers.ts list
 *   bun skills/sms-setup/scripts/twilio-numbers.ts search --country US [--area-code 212]
 *   bun skills/sms-setup/scripts/twilio-numbers.ts use --phone-number +15551234567
 *   bun skills/sms-setup/scripts/twilio-numbers.ts purchase --phone-number +15551234567
 */

import { saveFromNumber } from "../../../src/app-settings.ts";
import { normalizeHandle } from "../../../src/channel/identity.ts";
import { pluginConfigPath } from "../../../src/plugin-paths.ts";
import { TwilioClient } from "../../../src/providers/twilio/client.ts";
import type {
  TwilioAvailablePhoneNumber,
  TwilioIncomingPhoneNumber,
} from "../../../src/providers/twilio/schemas.ts";
import { resolveWebhookEndpoint } from "../../../src/webhook-endpoint.ts";

interface OwnedNumber {
  phoneNumber: string;
  friendlyName?: string;
}

interface AvailableNumber extends OwnedNumber {
  locality?: string;
  region?: string;
  country?: string;
  addressRequirements?: string;
}

interface WebhookResult {
  outcome: "registered" | "skipped" | "failed";
  url?: string;
  reason?: string;
}

interface ConfiguredNumber {
  fromNumber: string;
  webhook: WebhookResult;
}

function phoneNumberOf(value: { phone_number?: string }): string | undefined {
  return normalizeHandle(value.phone_number);
}

function isSmsCapable(value: {
  capabilities?: { sms?: boolean };
}): boolean {
  return value.capabilities?.sms === true;
}

function ownedNumbers(values: TwilioIncomingPhoneNumber[]): OwnedNumber[] {
  return values.flatMap((value) => {
    const phoneNumber = phoneNumberOf(value);
    return phoneNumber && isSmsCapable(value)
      ? [{ phoneNumber, friendlyName: value.friendly_name }]
      : [];
  });
}

function availableNumbers(
  values: TwilioAvailablePhoneNumber[],
): AvailableNumber[] {
  return values.flatMap((value) => {
    const phoneNumber = phoneNumberOf(value);
    return phoneNumber && isSmsCapable(value)
      ? [
          {
            phoneNumber,
            friendlyName: value.friendly_name,
            locality: value.locality,
            region: value.region,
            country: value.iso_country,
            addressRequirements: value.address_requirements,
          },
        ]
      : [];
  });
}

async function registerWebhook(
  client: TwilioClient,
  line: TwilioIncomingPhoneNumber,
): Promise<WebhookResult> {
  const endpoint = await resolveWebhookEndpoint();
  if (!endpoint.ok) {
    return { outcome: "skipped", reason: endpoint.reason };
  }

  try {
    await client.setSmsWebhook(line.sid, endpoint.url);
    return { outcome: "registered", url: endpoint.url };
  } catch (err) {
    return {
      outcome: "failed",
      url: endpoint.url,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function saveKnownNumber(
  client: TwilioClient,
  line: TwilioIncomingPhoneNumber,
  requireSmsCapability = true,
): Promise<ConfiguredNumber> {
  const phoneNumber = phoneNumberOf(line);
  if (!phoneNumber || (requireSmsCapability && !isSmsCapable(line))) {
    throw new Error("Twilio did not return an SMS-capable phone number.");
  }

  saveFromNumber(pluginConfigPath(), phoneNumber);
  return { fromNumber: phoneNumber, webhook: await registerWebhook(client, line) };
}

async function saveOwnedNumber(
  client: TwilioClient,
  rawNumber: string,
): Promise<ConfiguredNumber> {
  const phoneNumber = normalizeHandle(rawNumber);
  if (!phoneNumber) {
    throw new Error("Use an E.164 phone number, for example +15551234567.");
  }

  const line = (await client.listIncomingPhoneNumbers()).find(
    (candidate) =>
      phoneNumberOf(candidate) === phoneNumber && isSmsCapable(candidate),
  );
  if (!line) {
    throw new Error(
      `${phoneNumber} is not an SMS-capable number on this Twilio account.`,
    );
  }

  return saveKnownNumber(client, line);
}

/** List existing SMS-capable numbers that can be selected for the assistant. */
export async function listNumbers(): Promise<{ numbers: OwnedNumber[] }> {
  const client = new TwilioClient();
  return { numbers: ownedNumbers(await client.listIncomingPhoneNumbers()) };
}

/** Search all SMS-capable inventory Twilio supports in one country. */
export async function searchNumbers(options: {
  country: string;
  areaCode?: string;
}): Promise<{ numbers: AvailableNumber[] }> {
  const client = new TwilioClient();
  return {
    numbers: availableNumbers(await client.searchAvailablePhoneNumbers(options)),
  };
}

/** Save an existing SMS-capable account number as the assistant's line. */
export async function useNumber(rawNumber: string): Promise<ConfiguredNumber> {
  return saveOwnedNumber(new TwilioClient(), rawNumber);
}

/** Purchase a selected SMS-capable candidate, then save it as the assistant's line. */
export async function purchaseNumber(
  rawNumber: string,
): Promise<ConfiguredNumber> {
  const phoneNumber = normalizeHandle(rawNumber);
  if (!phoneNumber) {
    throw new Error("Use an E.164 phone number, for example +15551234567.");
  }

  const client = new TwilioClient();
  const purchased = await client.purchasePhoneNumber(phoneNumber);
  // The number was selected from Twilio's SMS-filtered search response. Some
  // provision responses omit capabilities, so do not strand a completed
  // purchase solely because that redundant field is absent here.
  return saveKnownNumber(client, purchased, false);
}

function flags(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must be supplied as --name value pairs.");
    }
    values.set(flag.slice(2), value);
  }
  return values;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const args = flags(rest);
  let result: unknown;

  switch (command) {
    case "list":
      result = await listNumbers();
      break;
    case "search":
      result = await searchNumbers({
        country: required(args, "country"),
        areaCode: args.get("area-code"),
      });
      break;
    case "use":
      result = await useNumber(required(args, "phone-number"));
      break;
    case "purchase":
      result = await purchaseNumber(required(args, "phone-number"));
      break;
    default:
      throw new Error(
        "Usage: twilio-numbers.ts list | search --country US [--area-code 212] | use --phone-number +15551234567 | purchase --phone-number +15551234567",
      );
  }

  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
