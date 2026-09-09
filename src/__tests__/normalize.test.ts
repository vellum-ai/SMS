import { describe, expect, test } from "bun:test";

import {
  chatTypeForMessage,
  classifyTwilioWebhook,
  normalizeWebhookParams,
} from "../providers/twilio/normalize.ts";
import { normalizeListedMessage } from "../providers/twilio/normalize.ts";

const RECEIVED_AT = "2026-09-09T10:00:00.000Z";

function messageDelivery(overrides: Record<string, string> = {}) {
  return {
    MessageSid: "SM01",
    AccountSid: "AC01",
    From: "+15551234567",
    To: "+15559998888",
    Body: "hello there",
    NumMedia: "0",
    ...overrides,
  };
}

function statusCallback(overrides: Record<string, string> = {}) {
  return {
    MessageSid: "SM02",
    AccountSid: "AC01",
    From: "+15551234567",
    To: "+15559998888",
    MessageStatus: "delivered",
    ...overrides,
  };
}

describe("normalizeWebhookParams", () => {
  test("maps a messaging delivery onto the event shape", () => {
    const event = normalizeWebhookParams(messageDelivery(), RECEIVED_AT);
    expect(event).toBeDefined();
    expect(event?.sourceChannel).toBe("sms");
    expect(event?.message.content).toBe("hello there");
    expect(event?.message.externalMessageId).toBe("SM01");
    expect(event?.actor.actorExternalId).toBe("+15551234567");
    expect(event?.message.conversationExternalId).toBe("+15551234567");
  });

  test("uses the caller's clock, never the provider timestamp", () => {
    const event = normalizeWebhookParams(
      messageDelivery(),
      RECEIVED_AT,
    );
    expect(event?.receivedAt).toBe(RECEIVED_AT);
  });

  test("preserves the original params verbatim", () => {
    const raw = messageDelivery({ SomeFutureField: "x" });
    const event = normalizeWebhookParams(raw, RECEIVED_AT);
    expect(event?.raw).toEqual(raw);
  });

  test("stamps the chat type as sms, always", () => {
    // SMS sender ids are spoofable; the gateway classifies on this, so a
    // missing signal must never buy a stronger identity.
    const event = normalizeWebhookParams(messageDelivery(), RECEIVED_AT);
    expect(chatTypeForMessage()).toBe("sms");
    expect(event?.source.chatType).toBe("sms");
  });

  test("drops a message with no attributable sender", () => {
    expect(
      normalizeWebhookParams(messageDelivery({ From: "" }), RECEIVED_AT),
    ).toBeUndefined();
  });

  test("drops a message with no body", () => {
    expect(
      normalizeWebhookParams(messageDelivery({ Body: "" }), RECEIVED_AT),
    ).toBeUndefined();
  });

  test("normalizes a non-E.164 sender", () => {
    const event = normalizeWebhookParams(
      messageDelivery({ From: "(555) 123-4567" }),
      RECEIVED_AT,
    );
    expect(event?.actor.actorExternalId).toBe("+15551234567");
  });
});

describe("normalizeListedMessage", () => {
  test("maps a listed inbound message onto the event shape", () => {
    const event = normalizeListedMessage(
      {
        sid: "SM03",
        direction: "inbound",
        from: "+15551234567",
        body: "via poll",
        date_created: "2026-09-09T09:59:00.000Z",
      },
      RECEIVED_AT,
    );
    expect(event?.message.content).toBe("via poll");
    expect(event?.message.externalMessageId).toBe("SM03");
  });

  test("drops an outbound echo", () => {
    // The listing covers both directions; the poller must never see our own
    // replies come back as turns. Direction filtering happens in the adapter,
    // but a record that slips through with no sender still fails closed here.
    const event = normalizeListedMessage(
      { sid: "SM04", direction: "outbound-api", body: "our reply" },
      RECEIVED_AT,
    );
    expect(event).toBeUndefined();
  });
});

describe("classifyTwilioWebhook", () => {
  test("classifies a messaging delivery as a message", () => {
    const delivery = classifyTwilioWebhook(messageDelivery(), RECEIVED_AT);
    expect(delivery.kind).toBe("message");
  });

  test("classifies a status callback as ignored, naming the status", () => {
    const delivery = classifyTwilioWebhook(statusCallback(), RECEIVED_AT);
    expect(delivery).toEqual({
      kind: "ignored",
      reason: "status callback (delivered)",
    });
  });

  test("classifies a bodyless delivery without a status as ignored", () => {
    const delivery = classifyTwilioWebhook(
      { MessageSid: "SM05" },
      RECEIVED_AT,
    );
    expect(delivery).toEqual({
      kind: "ignored",
      reason: "delivery without a body",
    });
  });

  test("classifies params with no MessageSid as unrecognized", () => {
    const delivery = classifyTwilioWebhook({ From: "+15551234567" }, RECEIVED_AT);
    expect(delivery).toEqual({
      kind: "ignored",
      reason: "unrecognized webhook params",
    });
  });
});
