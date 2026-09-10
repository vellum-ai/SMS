/**
 * The ingress manifest, checked against what the gateway parses.
 *
 * A manifest that fails the gateway schema fails closed, so this declaration is
 * a security boundary rather than cosmetic metadata.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "../../channels/ingress.json"), "utf8"),
) as {
  routes: {
    path: string;
    kind: string;
    verification?: unknown;
    inbound?: {
      identity: string;
      fields: Record<string, unknown>;
    };
  }[];
};

describe("channels/ingress.json", () => {
  test("declares exactly one http route", () => {
    expect(manifest.routes).toHaveLength(1);
    expect(manifest.routes[0]?.path).toBe("events-twilio");
    expect(manifest.routes[0]?.kind).toBe("http");
  });

  test("declares Twilio signing with generic HMAC payload parts", () => {
    expect(manifest.routes[0]?.verification).toEqual({
      kind: "hmac",
      algorithm: "sha1",
      secret: { field: "auth_token" },
      signature: {
        header: "X-Twilio-Signature",
        encoding: "base64",
      },
      payload: ["request-url", "form-params"],
    });
  });

  test("declares inbound fields over the vendor's form params", () => {
    const fields = manifest.routes[0]!.inbound!.fields as Record<
      string,
      string | { from: string; default?: string }
    >;
    expect(fields.content).toBe("Body");
    expect(fields.actorExternalId).toBe("From");
    expect(fields.conversationExternalId).toBe("From");
    expect(fields.externalMessageId).toBe("MessageSid");
    expect(fields.chatType).toEqual({ from: "From", default: "sms" });
  });

  test("declares phone identity so formatted and E.164 values match", () => {
    expect(manifest.routes[0]!.inbound!.identity).toBe("phone");
  });
});
