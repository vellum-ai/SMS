import { describe, expect, test } from "bun:test";

import { normalizeHandle, resolveIdentity } from "../channel/identity.ts";

describe("normalizeHandle", () => {
  test.each([
    ["+15551234567", "+15551234567"],
    ["5551234567", "+15551234567"],
    ["1 555 123 4567", "+15551234567"],
    ["(555) 123-4567", "+15551234567"],
    ["011442012345678", "+442012345678"],
    ["00442012345678", "+442012345678"],
  ])("normalizes %s to %s", (raw, expected) => {
    expect(normalizeHandle(raw)).toBe(expected);
  });

  test.each([
    ["too short"],
    ["12345"],
    // A 10-digit national number outside the default country cannot be
    // guessed, so it is rejected rather than assumed US.
    ["+4412345678901234567890"],
    [""],
    [undefined],
    ["not a number"],
  ])("rejects %s", (raw) => {
    expect(normalizeHandle(raw)).toBeUndefined();
  });

  test("rejects short codes, which are not people", () => {
    expect(normalizeHandle("40404")).toBeUndefined();
  });

  test("rejects email handles: this channel is phones only", () => {
    expect(normalizeHandle("someone@example.com")).toBeUndefined();
  });
});

describe("resolveIdentity", () => {
  test("uses the sender number for both ids, semantically distinct", () => {
    const identity = resolveIdentity({ from: "+15551234567" });
    expect(identity).toEqual({
      actorExternalId: "+15551234567",
      conversationExternalId: "+15551234567",
    });
  });

  test("normalizes the sender before using it as an identity", () => {
    const identity = resolveIdentity({ from: "(555) 123-4567" });
    expect(identity?.actorExternalId).toBe("+15551234567");
  });

  test("drops a message with no attributable sender", () => {
    expect(resolveIdentity({ from: undefined })).toBeUndefined();
    expect(resolveIdentity({ from: "not a number" })).toBeUndefined();
  });
});
