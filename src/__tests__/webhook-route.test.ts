/**
 * The Twilio webhook handler.
 *
 * The gateway has already verified the signature and gated the sender by the
 * time any of this runs, so nothing here checks either. What is left is the
 * form-encoded parsing, the not-a-turn answers, and the turn-running reply.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  pluginApiMock,
  resetSharedState,
  setTurnResult,
  turns,
} from "./helpers/plugin-api-mock.ts";

mock.module("@vellumai/plugin-api", pluginApiMock);

const { handleTwilioWebhook, resolveWebhookConfig } = await import(
  "../webhook-route.ts"
);

function postForm(params: Record<string, string>): Request {
  const body = new URLSearchParams(params).toString();
  return new Request("http://localhost/webhooks/plugins/sms/events-twilio", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body,
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** The Twilio message-send response, for a stubbed fetch. */
const sendOk = () =>
  new Response(JSON.stringify({ sid: "SM99", status: "queued" }), {
    status: 201,
  });

let durable: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  durable = join(mkdtempSync(join(tmpdir(), "sms-webhook-")), "config.json");
  writeFileSync(durable, JSON.stringify({}));
  resetSharedState();
  globalThis.fetch = (async () => sendOk()) as unknown as typeof fetch;
});

afterEach(() => {
  rmSync(join(durable, ".."), { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

describe("handleTwilioWebhook", () => {
  test("answers 200-ignore on a status callback without running a turn", async () => {
    const response = await handleTwilioWebhook(
      postForm({
        MessageSid: "SM02",
        From: "+15551234567",
        MessageStatus: "delivered",
      }),
      durable,
    );
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      ok: true,
      ignored: "status callback (delivered)",
    });
    expect(turns).toEqual([]);
  });

  test("answers 200-ignore on a garbage body rather than erroring", async () => {
    // URLSearchParams is tolerant, so arbitrary bytes parse into keys with no
    // MessageSid — which lands in the classifier's unrecognized bucket, not
    // the unparsable one. Either way the answer to the vendor is 200-ignore:
    // the delivery was authentic and retrying it will not change the body.
    const request = new Request(
      "http://localhost/webhooks/plugins/sms/events-twilio",
      { method: "POST", body: "\x00\x01 not form data" },
    );
    const response = await handleTwilioWebhook(request, durable);
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).ignored).toBe(
      "unrecognized webhook params",
    );
  });

  test("runs a turn on a message delivery and answers with the outcome", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return sendOk();
    }) as unknown as typeof fetch;

    const response = await handleTwilioWebhook(
      postForm({ MessageSid: "SM01", From: "+15551234567", Body: "hello" }),
      durable,
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body.ok).toBe(true);
    expect(body.conversationId).toBe("conv-1");
    expect(body.replied).toBe(true);

    // The turn is bound the way the gateway addresses the chat: channel
    // "plugin", this plugin's name in the id prefixes.
    expect(turns.length).toBe(1);
    const channel = (turns[0] as { channel: Record<string, string> }).channel;
    expect(channel.sourceChannel).toBe("plugin");
    expect(channel.externalChatId).toBe("sms:+15551234567");
    expect(channel.externalUserId).toBe("sms:+15551234567");

    // And the answer went back out over the same line.
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toContain("/Messages.json");
    expect(String(calls[0]?.init.body)).toContain(
      `To=${encodeURIComponent("+15551234567")}`,
    );
    expect(String(calls[0]?.init.body)).toContain("Body=hi+back");
  });

  test("503s when the send fails, so the gateway releases its dedup claim", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const response = await handleTwilioWebhook(
      postForm({ MessageSid: "SM01", From: "+15551234567", Body: "hello" }),
      durable,
    );
    expect(response.status).toBe(503);
    expect((await bodyOf(response)).error).toBe("could not run the turn");
  });
});

describe("resolveWebhookConfig", () => {
  test("reads config.json when this module instance never saw init", () => {
    const config = resolveWebhookConfig(durable);
    expect(config).toEqual({ provider: "twilio" });
  });
});
