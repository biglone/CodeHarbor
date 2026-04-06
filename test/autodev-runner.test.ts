import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { Logger } from "../src/logger";
import { runAutoDevCommand } from "../src/orchestrator/autodev-runner";
import * as statusHeal from "../src/orchestrator/autodev-status-heal";
import type { InboundMessage } from "../src/types";

type RunnerDeps = Parameters<typeof runAutoDevCommand>[0];

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
});
