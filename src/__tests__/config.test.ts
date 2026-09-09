import { describe, expect, test } from "bun:test";

import {
  INGRESS_MODES,
  PROVIDER_CREDENTIALS,
  resolveConfig,
  SMSConfigSchema,
} from "../config.ts";

describe("SMSConfigSchema", () => {
  test("defaults to twilio over webhook", () => {
    const config = SMSConfigSchema.parse({});
    expect(config.provider).toBe("twilio");
    expect(config.ingressMode).toBe("webhook");
    expect(config.pollIntervalMs).toBe(5_000);
  });

  test("accepts poll mode with a bounded interval", () => {
    const config = SMSConfigSchema.parse({
      ingressMode: "poll",
      pollIntervalMs: 30_000,
    });
    expect(config.ingressMode).toBe("poll");
    expect(config.pollIntervalMs).toBe(30_000);
  });

  test("rejects an interval below the floor", () => {
    expect(() =>
      SMSConfigSchema.parse({ ingressMode: "poll", pollIntervalMs: 500 }),
    ).toThrow();
  });

  test("rejects an unknown ingress mode", () => {
    expect(() => SMSConfigSchema.parse({ ingressMode: "live" })).toThrow();
  });

  test("rejects an unknown provider", () => {
    expect(() => SMSConfigSchema.parse({ provider: "photon" })).toThrow();
  });
});

describe("resolveConfig", () => {
  test("passes a valid config through without warnings", () => {
    const { config, warnings } = resolveConfig({
      ingressMode: "poll",
      pollIntervalMs: 10_000,
    });
    expect(config.ingressMode).toBe("poll");
    expect(warnings).toEqual([]);
  });

  test("falls back to defaults with a warning on garbage", () => {
    const { config, warnings } = resolveConfig({ ingressMode: 4 });
    expect(config.provider).toBe("twilio");
    expect(config.ingressMode).toBe("webhook");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("treats absent config as defaults", () => {
    const { config } = resolveConfig(undefined);
    expect(config.ingressMode).toBe("webhook");
  });
});

describe("credential fields", () => {
  test("twilio's fields cover the three console values", () => {
    expect(PROVIDER_CREDENTIALS.twilio.map((f) => f.field)).toEqual([
      "account_sid",
      "auth_token",
      "from_number",
    ]);
  });

  test("only the auth token is masked", () => {
    const secret = PROVIDER_CREDENTIALS.twilio.filter((f) => f.secret);
    expect(secret.map((f) => f.field)).toEqual(["auth_token"]);
  });

  test("the offered ingress modes have no live entry", () => {
    expect(INGRESS_MODES).toEqual(["webhook", "poll"]);
  });
});
