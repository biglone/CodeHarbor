import path from "node:path";

import { describe, expect, it } from "vitest";

import { formatPreflightReport, runStartupPreflight } from "../src/preflight";

describe("runStartupPreflight", () => {
  it("reports missing required env keys", async () => {
    const result = await runStartupPreflight({
      cwd: "/tmp/work",
      env: {
        CODEX_BIN: "codex",
        CODEX_WORKDIR: "/tmp/work",
      },
      checkCodexBinary: async () => {},
      fileExists: () => true,
      isDirectory: () => true,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.filter((issue) => issue.code === "missing_env")).toHaveLength(3);
  });

  it("reports codex binary execution failure", async () => {
    const result = await runStartupPreflight({
      cwd: "/tmp/work",
      env: {
        MATRIX_HOMESERVER: "https://matrix.example.com",
        MATRIX_USER_ID: "@bot:example.com",
        MATRIX_ACCESS_TOKEN: "token",
        CODEX_BIN: "codex",
        CODEX_WORKDIR: "/tmp/work",
      },
      checkCodexBinary: async () => {
        throw new Error("ENOENT");
      },
      fileExists: () => true,
      isDirectory: () => true,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "missing_codex_bin")).toBe(true);
  });

  it("falls back to discovered codex binary when configured path is stale", async () => {
    const checks: string[] = [];
    const result = await runStartupPreflight({
      cwd: "/tmp/work",
      env: {
        MATRIX_HOMESERVER: "https://matrix.example.com",
        MATRIX_USER_ID: "@bot:example.com",
        MATRIX_ACCESS_TOKEN: "token",
        CODEX_BIN: "/tmp/missing/codex",
        CODEX_WORKDIR: "/tmp/work",
        HOME: "/home/tester",
      },
      checkCodexBinary: async (bin) => {
        checks.push(bin);
        if (bin === "/usr/bin/codex") {
          return;
        }
        throw new Error("ENOENT");
      },
      fileExists: () => true,
      isDirectory: () => true,
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedCodexBin).toBe("/usr/bin/codex");
    expect(result.usedCodexFallback).toBe(true);
    expect(checks[0]).toBe("/tmp/missing/codex");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        level: "warn",
        code: "codex_bin_fallback",
      }),
    );
  });

  it("keeps warnings non-fatal", async () => {
    const cwd = "/tmp/work";
    const envPath = path.resolve(cwd, ".env");

    const result = await runStartupPreflight({
      cwd,
      env: {
        MATRIX_HOMESERVER: "https://matrix.example.com",
        MATRIX_USER_ID: "@bot:example.com",
        MATRIX_ACCESS_TOKEN: "token",
        CODEX_BIN: "codex",
        CODEX_WORKDIR: cwd,
      },
      checkCodexBinary: async () => {},
      fileExists: (targetPath) => targetPath !== envPath,
      isDirectory: () => true,
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([
      expect.objectContaining({
        level: "warn",
        code: "missing_dotenv",
      }),
    ]);
  });

  it("supports claude provider binary probing", async () => {
    const checks: string[] = [];
    const result = await runStartupPreflight({
      cwd: "/tmp/work",
      env: {
        MATRIX_HOMESERVER: "https://matrix.example.com",
        MATRIX_USER_ID: "@bot:example.com",
        MATRIX_ACCESS_TOKEN: "token",
        AI_CLI_PROVIDER: "claude",
        CODEX_WORKDIR: "/tmp/work",
      },
      checkCodexBinary: async (bin) => {
        checks.push(bin);
        if (bin === "claude") {
          return;
        }
        throw new Error("ENOENT");
      },
      fileExists: () => true,
      isDirectory: () => true,
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedCodexBin).toBe("claude");
    expect(checks[0]).toBe("claude");
  });

  it("supports gemini provider binary probing", async () => {
    const checks: string[] = [];
    const result = await runStartupPreflight({
      cwd: "/tmp/work",
      env: {
        MATRIX_HOMESERVER: "https://matrix.example.com",
        MATRIX_USER_ID: "@bot:example.com",
        MATRIX_ACCESS_TOKEN: "token",
        AI_CLI_PROVIDER: "gemini",
        CODEX_WORKDIR: "/tmp/work",
      },
      checkCodexBinary: async (bin) => {
        checks.push(bin);
        if (bin === "gemini") {
          return;
        }
        throw new Error("ENOENT");
      },
      fileExists: () => true,
      isDirectory: () => true,
    });

    expect(result.ok).toBe(true);
    expect(result.resolvedCodexBin).toBe("gemini");
    expect(checks[0]).toBe("gemini");
  });
});

describe("formatPreflightReport", () => {
  it("renders actionable report text", () => {
    const report = formatPreflightReport(
      {
        ok: false,
        issues: [
          {
            level: "error",
            code: "missing_env",
            check: "MATRIX_ACCESS_TOKEN",
            message: "MATRIX_ACCESS_TOKEN is required.",
            fix: "Run codeharbor init.",
          },
        ],
      },
      "start",
    );

    expect(report).toContain('Preflight check failed for "codeharbor start"');
    expect(report).toContain("[ERROR] MATRIX_ACCESS_TOKEN");
    expect(report).toContain("fix: Run codeharbor init.");
  });
});
