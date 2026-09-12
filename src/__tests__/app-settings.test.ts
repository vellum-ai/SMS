import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { readConfigView, saveFromNumber } from "../app-settings.ts";

let directory: string | undefined;

function configPath(): string {
  directory = mkdtempSync(join(tmpdir(), "sms-config-"));
  return join(directory, "config.json");
}

afterEach(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("saveFromNumber", () => {
  test("normalizes and atomically stores the assistant line in plugin config", () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ provider: "twilio", custom: "kept" }));

    const config = saveFromNumber(path, "(555) 999-8888");

    expect(config).toEqual({ provider: "twilio", fromNumber: "+15559998888" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      provider: "twilio",
      custom: "kept",
      fromNumber: "+15559998888",
    });
    expect(readConfigView(path)).toEqual({
      provider: "twilio",
      fromNumber: "+15559998888",
    });
  });

  test("rejects an invalid number without changing config", () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ provider: "twilio", custom: "kept" }));

    expect(() => saveFromNumber(path, "not a number")).toThrow(/E\.164/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      provider: "twilio",
      custom: "kept",
    });
  });
});
