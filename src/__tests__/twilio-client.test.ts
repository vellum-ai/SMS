/**
 * The Twilio REST client against a stubbed fetch.
 *
 * Account credentials stay in the credential store. The assistant phone number
 * is an explicit non-secret argument to sends, so account inventory can be
 * inspected and a line can be purchased before setup chooses one.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { pluginApiMock } from "./helpers/plugin-api-mock.ts";

mock.module("@vellumai/plugin-api", pluginApiMock);

const { TwilioClient, resolveTwilioCredentials } = await import(
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
  test("resolves Twilio account credentials from the credential store", async () => {
    expect(await resolveTwilioCredentials()).toEqual({
      accountSid: "AC0123456789",
      authToken: "tok-1",
    });
  });

  test("sends form-encoded with basic auth and an explicit configured From", async () => {
    responder = () =>
      new Response(JSON.stringify({ sid: "SM1", status: "queued" }), {
        status: 201,
      });
    const client = new TwilioClient();
    const sid = await client.sendMessage(
      "+15551234567",
      "hello",
      "+15559998888",
    );

    expect(sid).toBe("SM1");
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

  test("searches every Twilio-supported inventory type with SMS-only filters", async () => {
    responder = (url) => {
      if (url.endsWith("/AvailablePhoneNumbers/US.json")) {
        return new Response(
          JSON.stringify({
            subresource_uris: {
              local: "/2010-04-01/Accounts/AC.../AvailablePhoneNumbers/US/Local.json",
              toll_free: "/2010-04-01/Accounts/AC.../AvailablePhoneNumbers/US/TollFree.json",
              mobile: "/2010-04-01/Accounts/AC.../AvailablePhoneNumbers/US/Mobile.json",
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/TollFree.json")) {
        return new Response(
          JSON.stringify({
            available_phone_numbers: [
              {
                phone_number: "+18005550123",
                capabilities: { SMS: true },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/Mobile.json")) {
        return new Response(
          JSON.stringify({ available_phone_numbers: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          available_phone_numbers: [
            {
              phone_number: "+12125550123",
              friendly_name: "(212) 555-0123",
              capabilities: { sms: true },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const numbers = await new TwilioClient().searchAvailablePhoneNumbers({
      country: "us",
      areaCode: "212",
    });

    expect(numbers.map((number) => number.phone_number).sort()).toEqual([
      "+12125550123",
      "+18005550123",
    ]);
    expect(calls[0]?.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC0123456789/AvailablePhoneNumbers/US.json",
    );
    expect(calls.map((call) => call.url)).toContain(
      "https://api.twilio.com/2010-04-01/Accounts/AC0123456789/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&PageSize=10&AreaCode=212",
    );
    expect(calls.map((call) => call.url)).toContain(
      "https://api.twilio.com/2010-04-01/Accounts/AC0123456789/AvailablePhoneNumbers/US/Mobile.json?SmsEnabled=true&PageSize=10&AreaCode=212",
    );
    expect(calls.map((call) => call.url)).toContain(
      "https://api.twilio.com/2010-04-01/Accounts/AC0123456789/AvailablePhoneNumbers/US/TollFree.json?SmsEnabled=true&PageSize=10",
    );
  });

  test("purchases the selected number through IncomingPhoneNumbers", async () => {
    responder = () =>
      new Response(
        JSON.stringify({
          sid: "PN1",
          phone_number: "+12125550123",
          capabilities: { sms: true },
        }),
        { status: 201 },
      );

    const number = await new TwilioClient().purchasePhoneNumber("+12125550123");

    expect(number.sid).toBe("PN1");
    expect(calls[0]?.url).toContain("/IncomingPhoneNumbers.json");
    expect(calls[0]?.init.method).toBe("POST");
    expect(String(calls[0]?.init.body)).toBe(
      `PhoneNumber=${encodeURIComponent("+12125550123")}`,
    );
  });

  test("sets the number's SMS webhook form-encoded", async () => {
    responder = () => new Response("{}", { status: 200 });
    const client = new TwilioClient();
    await client.setSmsWebhook("PN1", "https://example.test/hook");

    expect(calls[0]?.url).toContain("/IncomingPhoneNumbers/PN1.json");
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
    await expect(
      new TwilioClient().sendMessage("+15551234567", "x", "+15559998888"),
    ).rejects.toThrow(/not a valid SMS-capable/);
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

    const sid = await new TwilioClient().sendMessage(
      "+15551234567",
      "x",
      "+15559998888",
    );
    expect(sid).toBe("SM3");
    expect(attempt).toBe(2);
  });

  test("does not retry a 400", async () => {
    let attempt = 0;
    responder = () => {
      attempt++;
      return new Response(JSON.stringify({ message: "bad" }), { status: 400 });
    };
    await expect(
      new TwilioClient().sendMessage("+15551234567", "x", "+15559998888"),
    ).rejects.toThrow();
    expect(attempt).toBe(1);
  });

  test("names the request when fetch itself fails", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      new TwilioClient().sendMessage("+15551234567", "x", "+15559998888"),
    ).rejects.toThrow(/Twilio API POST \/Messages.json could not be reached/);
  });
});
