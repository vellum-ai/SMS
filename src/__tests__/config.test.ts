import { describe, expect, test } from "bun:test";

import {
  PROVIDER_CREDENTIALS,
  resolveConfig,
  SMSConfigSchema,
} from "../config.ts";

describe("SMSConfigSchema", () => {
  test("defaults to Twilio", () => {
    expect(SMSConfigSchema.parse({})).toEqual({ provider: "twilio" });
  });

  test("strips retired polling configuration", () => {
    expect(
      SMSConfigSchema.parse({ ingressMode: "poll", pollIntervalMs: 30_000 }),
    ).toEqual({ provider: "twilio" });
  });

  test("rejects an unknown provider", () => {
    expect(() => SMSConfigSchema.parse({ provider: "photon" })).toThrow();
  });
});

describe("resolveConfig", () => {
  test("passes a valid config through without warnings", () => {
    const { config, warnings } = resolveConfig({ provider: "twilio" });
    expect(config).toEqual({ provider: "twilio" });
    expect(warnings).toEqual([]);
  });

  test("falls back to defaults with a warning on garbage", () => {
    const { config, warnings } = resolveConfig({ provider: 4 });
    expect(config).toEqual({ provider: "twilio" });
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("treats absent config as defaults", () => {
    expect(resolveConfig(undefined).config).toEqual({ provider: "twilio" });
  });
});

describe("credential fields", () => {
  test("Twilio's fields cover the three console values", () => {
    expect(PROVIDER_CREDENTIALS.twilio.map((field) => field.field)).toEqual([
      "account_sid",
      "auth_token",
      "from_number",
    ]);
  });

  test("only the auth token is masked", () => {
    const secret = PROVIDER_CREDENTIALS.twilio.filter((field) => field.secret);
    expect(secret.map((field) => field.field)).toEqual(["auth_token"]);
  });
});
