/**
 * The Twilio adapter's webhook programming.
 *
 * "Registering" for Twilio means writing `SmsUrl` on the configured number.
 * What matters is the compare-before-write: a start that finds the URL
 * already correct must not write, and a number missing from the account must
 * fail loudly rather than report a registration nothing will deliver to.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { pluginApiMock } from "./helpers/plugin-api-mock.ts";

mock.module("@vellumai/plugin-api", pluginApiMock);

const { createTwilioProvider } = await import("../providers/twilio/adapter.ts");

const calls: { url: string; init: RequestInit }[] = [];
let numbersPayload: unknown = {
  incoming_phone_numbers: [
    {
      sid: "PN1",
      phone_number: "+1 555 999 8888",
      sms_url: "https://old.example.test/hook",
      sms_method: "POST",
    },
  ],
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const path = String(url);
    if (path.includes("/IncomingPhoneNumbers/PN1.json") && init.method === "POST") {
      return new Response("{}", { status: 200 });
    }
    if (path.includes("/IncomingPhoneNumbers")) {
      return new Response(JSON.stringify(numbersPayload), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function postsToNumber(): number {
  return calls.filter(
    (call) =>
      call.url.includes("/IncomingPhoneNumbers/PN1.json") &&
      call.init.method === "POST",
  ).length;
}

describe("ensureWebhook", () => {
  test("programs the number when the URL differs", async () => {
    const provider = createTwilioProvider();
    const result = await provider.ensureWebhook({
      url: "https://assistant.example.test/webhooks/plugins/sms/events-twilio/",
      hasSecret: true,
    });

    expect(result.created).toBe(true);
    expect(result.id).toBe("PN1");
    expect(postsToNumber()).toBe(1);
    expect(String(calls.at(-1)?.init.body)).toContain(
      "SmsUrl=https%3A%2F%2Fassistant.example.test",
    );
  });

  test("matches the number regardless of punctuation", async () => {
    // The stored credential and Twilio's listing spell the same number
    // differently; matching is on digits.
    numbersPayload = {
      incoming_phone_numbers: [
        { sid: "PN2", phone_number: "+15550000000", sms_url: "" },
        { sid: "PN1", phone_number: "+15559998888", sms_url: "" },
      ],
    };
    const provider = createTwilioProvider();
    const result = await provider.ensureWebhook({
      url: "https://assistant.example.test/hook/",
      hasSecret: true,
    });
    expect(result.id).toBe("PN1");
  });

  test("does not write when the URL already matches, slash-insensitively", async () => {
    numbersPayload = {
      incoming_phone_numbers: [
        {
          sid: "PN1",
          phone_number: "+15559998888",
          // The trailing slash differs from what we ask for; the gateway
          // serves both spellings, so this is the same address.
          sms_url: "https://assistant.example.test/hook",
          sms_method: "POST",
        },
      ],
    };
    const provider = createTwilioProvider();
    const result = await provider.ensureWebhook({
      url: "https://assistant.example.test/hook/",
      hasSecret: true,
    });

    expect(result.created).toBe(false);
    expect(postsToNumber()).toBe(0);
  });

  test("fails loudly when the configured number is not on the account", async () => {
    numbersPayload = { incoming_phone_numbers: [] };
    const provider = createTwilioProvider();
    await expect(
      provider.ensureWebhook({
        url: "https://assistant.example.test/hook/",
        hasSecret: true,
      }),
    ).rejects.toThrow(/was not found on this Twilio account/);
  });
});

describe("send", () => {
  test("refuses a conversation-id target rather than guessing", async () => {
    const provider = createTwilioProvider();
    await expect(
      provider.send({ conversationId: "CH123" }, "hi", {
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/addressed by phone number/);
  });
});
