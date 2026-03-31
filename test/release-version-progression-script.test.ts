import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(__dirname, "..", "scripts", "check-release-version-progression.mjs");

function runScript(latestVersion: string, targetVersion: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: "utf8",
    env: {
      ...process.env,
      LATEST_VERSION: latestVersion,
      TARGET_VERSION: targetVersion,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("release version progression policy script", () => {
  it("allows same version retry after failed CI", () => {
    const result = runScript("0.1.10", "0.1.10");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("equals npm latest");
  });

  it("allows next patch/minor/major step", () => {
    expect(runScript("0.1.10", "0.1.11").status).toBe(0);
    expect(runScript("0.1.10", "0.2.0").status).toBe(0);
    expect(runScript("0.1.10", "1.0.0").status).toBe(0);
  });

  it("rejects skipped patch versions", () => {
    const result = runScript("0.1.10", "0.1.12");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release version jump detected");
    expect(result.stderr).toContain("do not skip versions");
  });
});
