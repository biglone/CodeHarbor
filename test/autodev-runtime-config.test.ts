import { afterEach, describe, expect, it } from "vitest";

import { resolveAutoDevRuntimeConfig } from "../src/orchestrator/autodev-runtime-config";

const ENV_KEYS = [
  "AUTODEV_LOOP_MAX_RUNS",
  "AUTODEV_LOOP_MAX_MINUTES",
  "AUTODEV_AUTO_COMMIT",
  "AUTODEV_AUTO_RELEASE_ENABLED",
  "AUTODEV_AUTO_RELEASE_PUSH",
  "AUTODEV_MAX_CONSECUTIVE_FAILURES",
  "AUTODEV_INIT_ENHANCEMENT_ENABLED",
  "AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS",
  "AUTODEV_INIT_ENHANCEMENT_MAX_CHARS",
] as const;

const originalEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) {
  originalEnv.set(key, process.env[key]);
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("resolveAutoDevRuntimeConfig", () => {
  it("reads init enhancement budget from env", () => {
    process.env.AUTODEV_INIT_ENHANCEMENT_ENABLED = "false";
    process.env.AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS = "180000";
    process.env.AUTODEV_INIT_ENHANCEMENT_MAX_CHARS = "1200";

    const config = resolveAutoDevRuntimeConfig();
    expect(config.autoDevInitEnhancementEnabled).toBe(false);
    expect(config.autoDevInitEnhancementTimeoutMs).toBe(180000);
    expect(config.autoDevInitEnhancementMaxChars).toBe(1200);
  });

  it("lets orchestrator options override env for init enhancement budget", () => {
    process.env.AUTODEV_INIT_ENHANCEMENT_ENABLED = "true";
    process.env.AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS = "480000";
    process.env.AUTODEV_INIT_ENHANCEMENT_MAX_CHARS = "4000";

    const config = resolveAutoDevRuntimeConfig({
      autoDevInitEnhancementEnabled: false,
      autoDevInitEnhancementTimeoutMs: 60000,
      autoDevInitEnhancementMaxChars: 900,
    });
    expect(config.autoDevInitEnhancementEnabled).toBe(false);
    expect(config.autoDevInitEnhancementTimeoutMs).toBe(60000);
    expect(config.autoDevInitEnhancementMaxChars).toBe(900);
  });
});
