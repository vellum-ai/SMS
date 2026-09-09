/**
 * The ingress manifest, checked against what the gateway will actually parse.
 *
 * A manifest that fails the gateway's schema fails closed — the route is not
 * served — so the shape here is not cosmetic. These tests pin the declaration
 * the gateway-side `twilio` verification kind and inbound reading expect.
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
    verification?: {
      kind: string;
      secret: { field: string };
    };
    inbound?: {
      identity: string;
      fields: Record<string, unknown>;
    };
  }[];
};

describe("channels/ingress.json", () => {
  test("declares exactly one http route", () => {
    expect(manifest.routes.length).toBe(1);
    const route = manifest.routes[0]!;
    expect(route.path).toBe("events-twilio");
    expect(route.kind).toBe("http");
  });

  test("declares the twilio verification kind over the auth token", () => {
    const route = manifest.routes[0]!;
    expect(route.verification).toEqual({
      kind: "twilio",
      secret: { field: "auth_token" },
    });
  });

  test("declares inbound fields over the vendor's form params", () => {
    // The gateway reads these off the delivery's own body — Twilio's flat
    // form params — before it forwards anything, so the paths must be the
    // vendor's parameter names, not the plugin's event shape.
    const fields = manifest.routes[0]!.inbound!.fields as Record<
      string,
      string | { from: string; default?: string }
    >;
    expect(fields.content).toBe("Body");
    expect(fields.actorExternalId).toBe("From");
    expect(fields.conversationExternalId).toBe("From");
    expect(fields.externalMessageId).toBe("MessageSid");
    // Every SMS event reads as sms: the sender id is spoofable and the
    // gateway classifies on that.
    expect(fields.chatType).toEqual({ from: "From", default: "sms" });
  });

  test("declares phone identity so +1 (202) 555-0142 and +12025550142 match", () => {
    expect(manifest.routes[0]!.inbound!.identity).toBe("phone");
  });
});
