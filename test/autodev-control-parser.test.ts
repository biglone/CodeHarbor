import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertAutoDevTargetDirectory,
  evaluateAutoDevLoopStopPermission,
  resolveAutoDevTargetPath,
} from "../src/orchestrator/autodev-control-parser";

describe("autodev control parser", () => {
  it("evaluates loop-stop permissions by active and pending sets", () => {
    const active = new Set<string>(["session-1"]);
    const pending = new Set<string>(["session-2"]);

    expect(
      evaluateAutoDevLoopStopPermission({
        activeAutoDevLoopSessions: active,
        pendingAutoDevLoopStopRequests: pending,
        sessionKey: "session-9",
      }),
    ).toBe("no_active_loop");

    expect(
      evaluateAutoDevLoopStopPermission({
        activeAutoDevLoopSessions: new Set<string>(["session-2"]),
        pendingAutoDevLoopStopRequests: pending,
        sessionKey: "session-2",
      }),
    ).toBe("already_requested");

    expect(
      evaluateAutoDevLoopStopPermission({
        activeAutoDevLoopSessions: active,
        pendingAutoDevLoopStopRequests: pending,
        sessionKey: "session-1",
      }),
    ).toBe("allowed");
  });

  it("asserts target directory existence and directory type", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-parser-assert-"));
    const tempFile = path.join(tempRoot, "note.txt");
    await fs.writeFile(tempFile, "hello", "utf8");

    try {
      await expect(assertAutoDevTargetDirectory(tempRoot)).resolves.toBeUndefined();
      await expect(assertAutoDevTargetDirectory(tempFile)).rejects.toThrow("target is not a directory");
      await expect(assertAutoDevTargetDirectory(path.join(tempRoot, "missing"))).rejects.toThrow();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("resolves path with home/absolute/relative and sibling fallback", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-parser-path-"));
    const codeharborDir = path.join(workspaceRoot, "CodeHarbor");
    const siblingProject = path.join(workspaceRoot, "StrawBerry");
    await fs.mkdir(codeharborDir, { recursive: true });
    await fs.mkdir(siblingProject, { recursive: true });
    await fs.mkdir(path.join(codeharborDir, "exists-in-base"), { recursive: true });

    try {
      expect(resolveAutoDevTargetPath(null, codeharborDir)).toBe(path.resolve(codeharborDir));
      expect(resolveAutoDevTargetPath("  ", codeharborDir)).toBe(path.resolve(codeharborDir));
      expect(resolveAutoDevTargetPath("~", codeharborDir)).toBe(os.homedir());
      expect(resolveAutoDevTargetPath("~/projects", codeharborDir)).toBe(path.join(os.homedir(), "projects"));

      const absoluteInput = path.resolve(workspaceRoot, "AbsoluteProject");
      expect(resolveAutoDevTargetPath(absoluteInput, codeharborDir)).toBe(absoluteInput);

      expect(resolveAutoDevTargetPath("exists-in-base", codeharborDir)).toBe(
        path.resolve(codeharborDir, "exists-in-base"),
      );
      expect(resolveAutoDevTargetPath("nested/project", codeharborDir)).toBe(path.resolve(codeharborDir, "nested/project"));

      // short project name with sibling project existing should prefer sibling workspace
      expect(resolveAutoDevTargetPath("StrawBerry", codeharborDir)).toBe(path.resolve(siblingProject));
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
