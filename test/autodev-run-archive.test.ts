import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { persistAutoDevRunArchive } from "../src/orchestrator/autodev-run-archive";

const execFileAsync = promisify(execFile);

function createLoggerStub() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("persistAutoDevRunArchive", () => {
  it("writes autodev run archive JSON under date-partitioned directory", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-archive-"));
    try {
      const result = await persistAutoDevRunArchive({
        enabled: true,
        archiveDir: ".codeharbor/autodev-runs",
        workdir,
        logger: createLoggerStub() as never,
        record: {
          version: 1,
          archivedAt: "2026-03-27T00:00:00.000Z",
          startedAt: "2026-03-27T00:00:00.000Z",
          endedAt: "2026-03-27T00:01:00.000Z",
          status: "succeeded",
          workdir,
          sessionKey: "matrix:room:user",
          conversationId: "!room:example.com",
          requestId: "req-1",
          workflowDiagRunId: "2026-03-27T00:00:00.000Z-abc123",
          mode: "single",
          loop: {
            round: 1,
            completedRuns: 0,
            maxRuns: 1,
            deadlineAt: null,
          },
          task: {
            id: "T1.1",
            description: "archive test",
            lineIndex: 3,
            finalStatus: "completed",
          },
          gate: {
            reviewerApproved: true,
            validationPassed: true,
            taskListPolicyPassed: true,
            completionPassed: true,
            completionReasons: [],
          },
          git: {
            commitSummary: "committed abc123",
            changedFiles: "src/a.ts",
            releaseSummary: "skipped",
          },
          failure: {
            streak: null,
            blocked: null,
            error: null,
          },
          workflowResult: {
            objective: "test",
            plan: "plan",
            output: "output",
            review: "review",
            approved: true,
            repairRounds: 0,
            durationMs: 1_000,
          },
          events: [
            {
              runId: "2026-03-27T00:00:00.000Z-abc123",
              kind: "autodev",
              stage: "planner",
              round: 1,
              message: "Planner completed",
              at: "2026-03-27T00:00:10.000Z",
            },
          ],
        },
      });

      expect(result.written).toBe(true);
      expect(result.filePath).toBeTruthy();
      expect(result.filePath?.includes(path.join(".codeharbor", "autodev-runs", "2026-03-27"))).toBe(true);
      const content = await fs.readFile(result.filePath!, "utf8");
      const parsed = JSON.parse(content) as { task: { id: string }; workflowResult: { approved: boolean } };
      expect(parsed.task.id).toBe("T1.1");
      expect(parsed.workflowResult.approved).toBe(true);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it("skips writing archive when disabled", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-archive-disabled-"));
    try {
      const result = await persistAutoDevRunArchive({
        enabled: false,
        archiveDir: ".codeharbor/autodev-runs",
        workdir,
        logger: createLoggerStub() as never,
        record: {
          version: 1,
          archivedAt: "2026-03-27T00:00:00.000Z",
          startedAt: "2026-03-27T00:00:00.000Z",
          endedAt: "2026-03-27T00:00:01.000Z",
          status: "failed",
          workdir,
          sessionKey: "matrix:room:user",
          conversationId: "!room:example.com",
          requestId: "req-2",
          workflowDiagRunId: "2026-03-27T00:00:00.000Z-abc999",
          mode: "single",
          loop: {
            round: 1,
            completedRuns: 0,
            maxRuns: 1,
            deadlineAt: null,
          },
          task: {
            id: "T1.2",
            description: "disabled archive",
            lineIndex: 4,
            finalStatus: "in_progress",
          },
          gate: {
            reviewerApproved: null,
            validationPassed: null,
            taskListPolicyPassed: null,
            completionPassed: null,
            completionReasons: [],
          },
          git: {
            commitSummary: null,
            changedFiles: null,
            releaseSummary: null,
          },
          failure: {
            streak: 1,
            blocked: false,
            error: "failed",
          },
          workflowResult: null,
          events: [],
        },
      });

      expect(result.written).toBe(false);
      expect(result.filePath).toBeNull();
      const archiveDir = path.join(workdir, ".codeharbor", "autodev-runs");
      const exists = await fs
        .stat(archiveDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it("keeps git worktree clean by excluding archive directory from git status", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-archive-git-clean-"));
    try {
      await execFileAsync("git", ["init"], { cwd: workdir });
      await fs.writeFile(path.join(workdir, "README.md"), "# temp\n", "utf8");
      await execFileAsync("git", ["add", "-A"], { cwd: workdir });
      await execFileAsync(
        "git",
        ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "commit", "-m", "chore: init"],
        { cwd: workdir },
      );

      const result = await persistAutoDevRunArchive({
        enabled: true,
        archiveDir: ".codeharbor/autodev-runs",
        workdir,
        logger: createLoggerStub() as never,
        record: {
          version: 1,
          archivedAt: "2026-03-27T00:00:00.000Z",
          startedAt: "2026-03-27T00:00:00.000Z",
          endedAt: "2026-03-27T00:00:01.000Z",
          status: "succeeded",
          workdir,
          sessionKey: "matrix:room:user",
          conversationId: "!room:example.com",
          requestId: "req-3",
          workflowDiagRunId: "2026-03-27T00:00:00.000Z-clean",
          mode: "single",
          loop: {
            round: 1,
            completedRuns: 1,
            maxRuns: 1,
            deadlineAt: null,
          },
          task: {
            id: "T1.3",
            description: "git clean archive",
            lineIndex: 5,
            finalStatus: "completed",
          },
          gate: {
            reviewerApproved: true,
            validationPassed: true,
            taskListPolicyPassed: true,
            completionPassed: true,
            completionReasons: [],
          },
          git: {
            commitSummary: "skipped",
            changedFiles: null,
            releaseSummary: "skipped",
          },
          failure: {
            streak: null,
            blocked: null,
            error: null,
          },
          workflowResult: null,
          events: [],
        },
      });

      expect(result.written).toBe(true);
      const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: workdir });
      expect(status.stdout.trim()).toBe("");
      const excludePath = path.join(workdir, ".git", "info", "exclude");
      const excludeContent = await fs.readFile(excludePath, "utf8");
      expect(excludeContent).toContain("/.codeharbor/autodev-runs/");
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });
});
