import { describe, expect, it } from "vitest";

import {
  evaluateUpgradePostCheck,
  parseInstalledVersionFromSelfUpdateOutput,
} from "../src/orchestrator/upgrade-utils";

describe("upgrade utils", () => {
  it("parses installed version from legacy self-update output", () => {
    const output = [
      "[self-update] Installing codeharbor@latest...",
      "[self-update] Installed version: 0.1.53",
    ].join("\n");

    expect(parseInstalledVersionFromSelfUpdateOutput(output)).toBe("0.1.53");
  });

  it("parses installed version from structured self-update summary output", () => {
    const output = [
      "[self-update] 结果摘要",
      "- status: success",
      "- target: latest",
      "- installedVersion: 0.1.53",
      "- restart: 已跳过（--skip-restart）",
    ].join("\n");

    expect(parseInstalledVersionFromSelfUpdateOutput(output)).toBe("0.1.53");
  });

  it("keeps post-check successful when probe fails but self-update output has installed version", () => {
    const result = evaluateUpgradePostCheck({
      targetVersion: "0.1.53",
      selfUpdateVersion: "0.1.53",
      versionProbe: {
        version: null,
        source: "unavailable",
        error: "probe timeout",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.installedVersion).toBe("0.1.53");
    expect(result.checkDetail).toContain("source=self-update output");
  });
});
