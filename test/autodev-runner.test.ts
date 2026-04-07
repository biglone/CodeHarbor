import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { Logger } from "../src/logger";
import { runAutoDevCommand } from "../src/orchestrator/autodev-runner";
import * as statusHeal from "../src/orchestrator/autodev-status-heal";
import type { InboundMessage } from "../src/types";

type RunnerDeps = Parameters<typeof runAutoDevCommand>[0];
const execFileAsync = promisify(execFile);

function makeInbound(partial: Partial<InboundMessage> = {}): InboundMessage {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    channel: "matrix",
    conversationId: "!room:example.com",
    senderId: "@alice:example.com",
    eventId: "$event",
    text: "/autodev run",
    attachments: [],
    isDirectMessage: true,
    mentionsBot: false,
    repliesToBot: false,
    ...partial,
  };
}

function createRunnerDeps(notices: string[]): RunnerDeps {
  return {
    logger: new Logger("error"),
    outputLanguage: "en",
    autoDevLoopMaxRuns: 0,
    autoDevLoopMaxMinutes: 0,
    autoDevAutoCommit: true,
    autoDevAutoReleaseEnabled: false,
    autoDevAutoReleasePush: true,
    autoDevRunArchiveEnabled: false,
    autoDevRunArchiveDir: "",
    autoDevValidationStrict: false,
    autoDevSecondaryReviewEnabled: false,
    autoDevSecondaryReviewTarget: "@review-guard",
    autoDevSecondaryReviewRequireGatePassed: true,
    pendingAutoDevLoopStopRequests: new Set<string>(),
    activeAutoDevLoopSessions: new Set<string>(),
    consumePendingStopRequest: () => false,
    consumePendingAutoDevLoopStopRequest: () => false,
    setAutoDevSnapshot: () => {},
    channelSendNotice: async (_conversationId, text) => {
      notices.push(text);
    },
    beginWorkflowDiagRun: () => "autodev-runner-test",
    appendWorkflowDiagEvent: () => {},
    runWorkflowCommand: async () => {
      throw new Error("workflow should not be executed for completed nested loop task");
    },
    listWorkflowDiagRunsBySession: () => [],
    listWorkflowDiagEvents: () => [],
    recordAutoDevGitCommit: () => {},
    resetAutoDevFailureStreak: () => {},
    resetAutoDevValidationFailureStreak: () => {},
    applyAutoDevFailurePolicy: async (input) => ({
      blocked: false,
      streak: 0,
      task: input.task,
    }),
    applyAutoDevValidationFailurePolicy: async (input) => ({
      blocked: false,
      streak: 0,
      task: input.task,
    }),
    autoDevMetrics: {
      recordRunOutcome: () => {},
      recordLoopStop: () => {},
      recordTaskBlocked: () => {},
    },
  };
}

async function waitForNoticeIncludes(notices: string[], pattern: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (notices.some((entry) => entry.includes(pattern))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timeout waiting for notice: ${pattern}`);
}

describe("AutoDev runner", () => {
  it("skips status self-heal for nested loop task invocation", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-runner-self-heal-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T20.1 | nested loop self-heal guard | ✅ |",
      ].join("\n"),
      "utf8",
    );

    const notices: string[] = [];
    const deps = createRunnerDeps(notices);
    const healSpy = vi.spyOn(statusHeal, "healAutoDevTaskStatuses");

    try {
      await runAutoDevCommand(deps, {
        taskId: "T20.1",
        sessionKey: "sess-autodev-runner-self-heal",
        message: makeInbound({
          text: "/autodev run",
          eventId: "$autodev-runner-self-heal",
        }),
        requestId: "req-autodev-runner-self-heal",
        workdir: tempRoot,
        runContext: {
          mode: "loop",
          loopRound: 1,
          loopCompletedRuns: 0,
          loopMaxRuns: 0,
          loopDeadlineAt: null,
        },
      });

      expect(healSpy).not.toHaveBeenCalled();
      expect(notices.some((text) => text.includes("Task T20.1 is already completed (✅)."))).toBe(true);
      expect(notices.some((text) => text.includes("status self-heal applied"))).toBe(false);
      expect(notices).toMatchInlineSnapshot(`
        [
          "[CodeHarbor] Task T20.1 is already completed (✅).",
        ]
      `);
    } finally {
      healSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("sends secondary review handoff notice after successful completion", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-runner-secondary-review-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T30.1 | secondary review handoff | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const notices: string[] = [];
    const deps = createRunnerDeps(notices);
    deps.autoDevAutoCommit = false;
    deps.autoDevSecondaryReviewEnabled = true;
    deps.autoDevSecondaryReviewTarget = "@review-guard";
    deps.autoDevSecondaryReviewRequireGatePassed = true;
    deps.runWorkflowCommand = async () => ({
      objective: "finish T30.1",
      plan: "plan",
      output: "validation_status: passed",
      review: "APPROVED",
      approved: true,
      repairRounds: 0,
      durationMs: 12,
    });

    try {
      await runAutoDevCommand(deps, {
        taskId: "T30.1",
        sessionKey: "sess-autodev-runner-secondary-review",
        message: makeInbound({
          text: "/autodev run T30.1",
          eventId: "$autodev-runner-secondary-review",
        }),
        requestId: "req-autodev-runner-secondary-review",
        workdir: tempRoot,
      });

      expect(
        notices.some(
          (text) => text.includes("AutoDev secondary review handoff") && text.includes("@review-guard"),
        ),
      ).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("covers secondary review handoff with release gating in one autodev run", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-runner-int-release-review-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Requirements\n- implement T30.2\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T30.2 | integration regression for release+handoff | ⬜ |",
        "",
        "## 大功能 -> 发布映射（执行约定）",
        "| 大功能任务 | 完成后目标版本 | 发布提交示例 |",
        "|------------|----------------|--------------|",
        "| T30.2 | v0.1.52 | `release: v0.1.52 [publish-npm]` |",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify(
        {
          name: "codeharbor-runner-integration-test",
          version: "0.1.51",
          private: true,
          scripts: {
            "test:coverage": "node -e \"process.exit(0)\"",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "package-lock.json"),
      JSON.stringify(
        {
          name: "codeharbor-runner-integration-test",
          version: "0.1.51",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "codeharbor-runner-integration-test",
              version: "0.1.51",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(path.join(tempRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n- none\n", "utf8");

    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await execFileAsync("git", ["add", "-A"], { cwd: tempRoot });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "commit", "-m", "chore: init integration test"],
      { cwd: tempRoot },
    );

    const notices: string[] = [];
    const deps = createRunnerDeps(notices);
    deps.autoDevAutoReleaseEnabled = true;
    deps.autoDevAutoReleasePush = false;
    deps.autoDevSecondaryReviewEnabled = true;
    deps.autoDevSecondaryReviewTarget = "@review-guard";
    deps.autoDevSecondaryReviewRequireGatePassed = true;
    deps.runWorkflowCommand = async () => ({
      objective: "finish T30.2",
      plan: "plan",
      output: "validation_status: passed",
      review: "APPROVED",
      approved: true,
      repairRounds: 0,
      durationMs: 20,
    });

    try {
      await runAutoDevCommand(deps, {
        taskId: "T30.2",
        sessionKey: "sess-autodev-runner-integration-release-review",
        message: makeInbound({
          text: "/autodev run T30.2",
          eventId: "$autodev-runner-int-release-review",
        }),
        requestId: "req-autodev-runner-int-release-review",
        workdir: tempRoot,
      });

      expect(notices.some((text) => text.includes("AutoDev secondary review handoff") && text.includes("@review-guard"))).toBe(true);
      expect(notices.some((text) => text.includes("release: released v0.1.52"))).toBe(true);

      const latest = await execFileAsync("git", ["log", "--oneline", "-n", "1"], { cwd: tempRoot });
      expect(latest.stdout).toContain("release: v0.1.52 [publish-npm]");
      const packageJson = JSON.parse(await fs.readFile(path.join(tempRoot, "package.json"), "utf8")) as { version: string };
      expect(packageJson.version).toBe("0.1.52");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports lock conflict when the same task is started concurrently", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-runner-lock-conflict-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T40.1 | concurrent lock conflict regression | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const noticesA: string[] = [];
    const noticesB: string[] = [];
    const depsA = createRunnerDeps(noticesA);
    const depsB = createRunnerDeps(noticesB);

    depsA.autoDevAutoCommit = false;
    depsB.autoDevAutoCommit = false;

    let secondWorkflowCalls = 0;
    const firstRunGate = { released: false };

    depsA.runWorkflowCommand = async () => {
      while (!firstRunGate.released) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      return {
        objective: "finish T40.1",
        plan: "plan",
        output: "validation_status: passed",
        review: "APPROVED",
        approved: true,
        repairRounds: 0,
        durationMs: 30,
      };
    };
    depsB.runWorkflowCommand = async () => {
      secondWorkflowCalls += 1;
      return {
        objective: "finish T40.1",
        plan: "plan",
        output: "validation_status: passed",
        review: "APPROVED",
        approved: true,
        repairRounds: 0,
        durationMs: 30,
      };
    };

    const firstRunPromise = runAutoDevCommand(depsA, {
      taskId: "T40.1",
      sessionKey: "sess-lock-a",
      message: makeInbound({
        text: "/autodev run T40.1",
        eventId: "$autodev-lock-a",
      }),
      requestId: "req-autodev-lock-a",
      workdir: tempRoot,
    });

    try {
      await waitForNoticeIncludes(noticesA, "AutoDev started task T40.1");

      await runAutoDevCommand(depsB, {
        taskId: "T40.1",
        sessionKey: "sess-lock-b",
        message: makeInbound({
          text: "/autodev run T40.1",
          eventId: "$autodev-lock-b",
        }),
        requestId: "req-autodev-lock-b",
        workdir: tempRoot,
      });

      expect(noticesB.some((text) => text.includes("AutoDev task lock conflict"))).toBe(true);
      expect(noticesB.some((text) => text.includes("AutoDev started task T40.1"))).toBe(false);
      expect(secondWorkflowCalls).toBe(0);
    } finally {
      firstRunGate.released = true;
      await firstRunPromise;
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

});
