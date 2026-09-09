/**
 * The Twilio REST client against a stubbed fetch.
 *
 * Auth shape, form encoding, From injection, retry behavior, and the error
 * body landing in the message — the classes of failure the adapter and the
 * surfaces above it report on.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { pluginApiMock } from "./helpers/plugin-api-mock.ts";

mock.module("@vellumai/plugin-api", pluginApiMock);

const { TwilioClient, resolveLine } = await import(
  "../providers/twilio/client.ts"
);

const calls: { url: string; init: RequestInit }[] = [];
let responder: (url: string) => Response = () =>
  new Response("{}", { status: 200 });

const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder(String(url));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function authHeader(init: RequestInit): string {
  return String((init.headers as Record<string, string>).Authorization);
}

describe("TwilioClient", () => {
  test("resolves the line from the credential store", async () => {
    const line = await resolveLine();
    expect(line).toEqual({
      accountSid: "AC0123456789",
      authToken: "tok-1",
      fromNumber: "+15559998888",
    });
  });

  test("sends form-encoded with basic auth and the line's From", async () => {
    responder = () =>
      new Response(JSON.stringify({ sid: "SM1", status: "queued" }), {
        status: 201,
      });
    const client = new TwilioClient();
    const sid = await client.sendMessage("+15551234567", "hello");

    expect(sid).toBe("SM1");
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC0123456789/Messages.json",
    );
    expect(call.init.method).toBe("POST");
    expect(authHeader(call.init)).toBe(
      `Basic ${Buffer.from("AC0123456789:tok-1").toString("base64")}`,
    );
    expect(String(call.init.body)).toBe(
      `To=${encodeURIComponent("+15551234567")}&Body=hello&From=${encodeURIComponent("+15559998888")}`,
    );
  });

  test("lists messages with the page size as a query param", async () => {
    responder = () =>
      new Response(JSON.stringify({ messages: [{ sid: "SM2" }] }), {
        status: 200,
      });
    const client = new TwilioClient();
    const messages = await client.listMessages(50);

    expect(messages.map((m) => m.sid)).toEqual(["SM2"]);
    expect(calls[0]?.url).toContain("PageSize=50");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("sets the number's SMS webhook form-encoded", async () => {
    responder = () => new Response("{}", { status: 200 });
    const client = new TwilioClient();
    await client.setSmsWebhook("PN1", "https://example.test/hook", "POST");

    expect(calls[0]?.url).toContain(
      "/IncomingPhoneNumbers/PN1.json",
    );
    expect(String(calls[0]?.init.body)).toBe(
      `SmsUrl=${encodeURIComponent("https://example.test/hook")}&SmsMethod=POST`,
    );
  });

  test("carries the provider's error body in the thrown message", async () => {
    responder = () =>
      new Response(
        JSON.stringify({
          code: 21606,
          message: "The 'From' number is not a valid SMS-capable number",
        }),
        { status: 400 },
      );
    const client = new TwilioClient();
    await expect(client.sendMessage("+15551234567", "x")).rejects.toThrow(
      /not a valid SMS-capable/,
    );
  });

  test("retries a 429 and succeeds on the second attempt", async () => {
    let attempt = 0;
    responder = () => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify({ message: "too many" }), {
          status: 429,
        });
      }
      return new Response(JSON.stringify({ sid: "SM3" }), { status: 201 });
    };
    const client = new TwilioClient();
    const sid = await client.sendMessage("+15551234567", "x");
    expect(sid).toBe("SM3");
    expect(attempt).toBe(2);
  });

  test("does not retry a 400", async () => {
    let attempt = 0;
    responder = () => {
      attempt++;
      return new Response(JSON.stringify({ message: "bad" }), { status: 400 });
    };
    const client = new TwilioClient();
    await expect(client.sendMessage("+15551234567", "x")).rejects.toThrow();
    expect(attempt).toBe(1);
  });

  test("names the request when fetch itself fails", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new TwilioClient();
    await expect(client.sendMessage("+15551234567", "x")).rejects.toThrow(
      /Twilio API POST \/Messages.json could not be reached/,
    );
  });
});
