import { afterEach, describe, expect, it } from "vitest";

import { resolveAutoDevRuntimeConfig } from "../src/orchestrator/autodev-runtime-config";

const ENV_KEYS = [
  "AUTODEV_LOOP_MAX_RUNS",
  "AUTODEV_LOOP_MAX_MINUTES",
  "AUTODEV_AUTO_COMMIT",
  "AUTODEV_AUTO_RELEASE_ENABLED",
  "AUTODEV_AUTO_RELEASE_PUSH",
  "AUTODEV_RUN_ARCHIVE_ENABLED",
  "AUTODEV_RUN_ARCHIVE_DIR",
  "AUTODEV_VALIDATION_STRICT",
  "AUTODEV_SECONDARY_REVIEW_ENABLED",
  "AUTODEV_SECONDARY_REVIEW_TARGET",
  "AUTODEV_SECONDARY_REVIEW_REQUIRE_GATE_PASSED",
  "AUTODEV_STAGE_OUTPUT_ECHO_ENABLED",
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
  it("accepts zero loop limits as unlimited", () => {
    process.env.AUTODEV_LOOP_MAX_RUNS = "0";
    process.env.AUTODEV_LOOP_MAX_MINUTES = "0";

    const config = resolveAutoDevRuntimeConfig();
    expect(config.autoDevLoopMaxRuns).toBe(0);
    expect(config.autoDevLoopMaxMinutes).toBe(0);
  });

  it("falls back to defaults for invalid negative loop limits", () => {
    process.env.AUTODEV_LOOP_MAX_RUNS = "-1";
    process.env.AUTODEV_LOOP_MAX_MINUTES = "-10";

    const config = resolveAutoDevRuntimeConfig();
    expect(config.autoDevLoopMaxRuns).toBe(20);
    expect(config.autoDevLoopMaxMinutes).toBe(120);
  });

  it("reads init enhancement budget from env", () => {
    process.env.AUTODEV_INIT_ENHANCEMENT_ENABLED = "false";
    process.env.AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS = "180000";
    process.env.AUTODEV_INIT_ENHANCEMENT_MAX_CHARS = "1200";

    const config = resolveAutoDevRuntimeConfig();
    expect(config.autoDevInitEnhancementEnabled).toBe(false);
    expect(config.autoDevInitEnhancementTimeoutMs).toBe(180000);
    expect(config.autoDevInitEnhancementMaxChars).toBe(1200);
  });

  it("enables run archive by default with default archive dir", () => {
    delete process.env.AUTODEV_RUN_ARCHIVE_ENABLED;
    delete process.env.AUTODEV_RUN_ARCHIVE_DIR;
    delete process.env.AUTODEV_STAGE_OUTPUT_ECHO_ENABLED;

    const config = resolveAutoDevRuntimeConfig();
    expect(config.autoDevRunArchiveEnabled).toBe(true);
    expect(config.autoDevRunArchiveDir).toBe(".codeharbor/autodev-runs");
    expect(config.autoDevStageOutputEchoDefaultEnabled).toBe(true);
  });

  it("reads run archive settings from env", () => {
    process.env.AUTODEV_RUN_ARCHIVE_ENABLED = "false";
    process.env.AUTODEV_RUN_ARCHIVE_DIR = "logs/autodev-archive";
    process.env.AUTODEV_STAGE_OUTPUT_ECHO_ENABLED = "false";

    const config = resolveAutoDevRuntimeConfig();
    expect(config.autoDevRunArchiveEnabled).toBe(false);
    expect(config.autoDevRunArchiveDir).toBe("logs/autodev-archive");
    expect(config.autoDevStageOutputEchoDefaultEnabled).toBe(false);
  });

  it("reads validation strict mode from env", () => {
    process.env.AUTODEV_VALIDATION_STRICT = "true";
    const config = resolveAutoDevRuntimeConfig();
    expect(config.autoDevValidationStrict).toBe(true);
  });

  it("uses secondary review defaults", () => {
    delete process.env.AUTODEV_SECONDARY_REVIEW_ENABLED;
    delete process.env.AUTODEV_SECONDARY_REVIEW_TARGET;
    delete process.env.AUTODEV_SECONDARY_REVIEW_REQUIRE_GATE_PASSED;

    const config = resolveAutoDevRuntimeConfig();
    expect(config.autoDevSecondaryReviewEnabled).toBe(false);
    expect(config.autoDevSecondaryReviewTarget).toBe("@review-guard");
    expect(config.autoDevSecondaryReviewRequireGatePassed).toBe(true);
  });

  it("reads secondary review settings from env", () => {
    process.env.AUTODEV_SECONDARY_REVIEW_ENABLED = "true";
    process.env.AUTODEV_SECONDARY_REVIEW_TARGET = "@qa-guard";
    process.env.AUTODEV_SECONDARY_REVIEW_REQUIRE_GATE_PASSED = "false";

    const config = resolveAutoDevRuntimeConfig();
    expect(config.autoDevSecondaryReviewEnabled).toBe(true);
    expect(config.autoDevSecondaryReviewTarget).toBe("@qa-guard");
    expect(config.autoDevSecondaryReviewRequireGatePassed).toBe(false);
  });

  it("lets orchestrator options override env for init enhancement budget", () => {
    process.env.AUTODEV_INIT_ENHANCEMENT_ENABLED = "true";
    process.env.AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS = "480000";
    process.env.AUTODEV_INIT_ENHANCEMENT_MAX_CHARS = "4000";
    process.env.AUTODEV_SECONDARY_REVIEW_ENABLED = "false";
    process.env.AUTODEV_SECONDARY_REVIEW_TARGET = "@review-guard";
    process.env.AUTODEV_SECONDARY_REVIEW_REQUIRE_GATE_PASSED = "true";

    const config = resolveAutoDevRuntimeConfig({
      autoDevInitEnhancementEnabled: false,
      autoDevInitEnhancementTimeoutMs: 60000,
      autoDevInitEnhancementMaxChars: 900,
      autoDevSecondaryReviewEnabled: true,
      autoDevSecondaryReviewTarget: "@review-bot",
      autoDevSecondaryReviewRequireGatePassed: false,
    });
    expect(config.autoDevInitEnhancementEnabled).toBe(false);
    expect(config.autoDevInitEnhancementTimeoutMs).toBe(60000);
    expect(config.autoDevInitEnhancementMaxChars).toBe(900);
    expect(config.autoDevSecondaryReviewEnabled).toBe(true);
    expect(config.autoDevSecondaryReviewTarget).toBe("@review-bot");
    expect(config.autoDevSecondaryReviewRequireGatePassed).toBe(false);
  });
});
