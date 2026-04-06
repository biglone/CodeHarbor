import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { executeAutoDevWorkflowStageWithTaskListGuard } from "../src/orchestrator/autodev-stage-executor";
import type { InboundMessage } from "../src/types";

function createMessage(text = "/autodev run"): InboundMessage {
  return {
    requestId: "request-stage-executor",
    channel: "matrix",
    conversationId: "conversation-stage-executor",
    senderId: "user-stage-executor",
    eventId: "$event-stage-executor",
    text,
    attachments: [],
    isDirectMessage: true,
    mentionsBot: false,
    repliesToBot: false,
  };
}

describe("AutoDev stage executor", () => {
  it("returns stage result when workflow and task-list guard pass", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-stage-exec-"));
    const taskListPath = path.join(workdir, "TASK_LIST.md");
    await fs.writeFile(taskListPath, "| 任务ID | 状态 |\n|---|---|\n| T1 | ⬜ |\n", "utf8");

    const notices: string[] = [];
    const diagEvents: string[] = [];
    const result = await executeAutoDevWorkflowStageWithTaskListGuard({
      outputLanguage: "en",
      objective: "finish T1",
      sessionKey: "session-stage-pass",
      message: createMessage(),
      requestId: "request-stage-pass",
      workdir,
      workflowDiagRunId: "run-stage-pass",
      taskListPath,
      runWorkflowCommand: async () => ({
        objective: "finish T1",
        plan: "plan",
        output: "output",
        review: "APPROVED",
        approved: true,
        repairRounds: 0,
        durationMs: 12,
      }),
      guardTaskListOwnership: async () => ({
        changed: false,
        restored: true,
        finalClean: true,
        error: null,
      }),
      buildReviewerTaskListPolicyContextSummary: () => null,
      appendWorkflowDiagEvent: (_runId, _kind, _stage, _round, message) => {
        diagEvents.push(message);
      },
      sendNotice: async (_conversationId, text) => {
        notices.push(text);
      },
    });

    try {
      expect(result).not.toBeNull();
      expect(result?.taskListPolicyPassed).toBe(true);
      expect(result?.taskListMutationObservedDuringWorkflow).toBe(false);
      expect(notices).toEqual([]);
      expect(diagEvents).toEqual([]);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it("throws when guard cannot restore forbidden TASK_LIST mutation", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-stage-exec-fail-"));
    const taskListPath = path.join(workdir, "TASK_LIST.md");
    await fs.writeFile(taskListPath, "| 任务ID | 状态 |\n|---|---|\n| T2 | ⬜ |\n", "utf8");

    const notices: string[] = [];
    const guardResults = [
      {
        changed: true,
        restored: false,
        finalClean: false,
        error: "restore failed",
      },
      {
        changed: true,
        restored: false,
        finalClean: false,
        error: "restore failed",
      },
    ];

    try {
      await expect(
        executeAutoDevWorkflowStageWithTaskListGuard({
          outputLanguage: "en",
          objective: "finish T2",
          sessionKey: "session-stage-fail",
          message: createMessage(),
          requestId: "request-stage-fail",
          workdir,
          workflowDiagRunId: "run-stage-fail",
          taskListPath,
          runWorkflowCommand: async () => ({
            objective: "finish T2",
            plan: "plan",
            output: "output",
            review: "REJECT",
            approved: false,
            repairRounds: 0,
            durationMs: 10,
          }),
          guardTaskListOwnership: async () => {
            return guardResults.shift() ?? {
              changed: false,
              restored: true,
              finalClean: true,
              error: null,
            };
          },
          buildReviewerTaskListPolicyContextSummary: () => null,
          appendWorkflowDiagEvent: () => {},
          sendNotice: async (_conversationId, text) => {
            notices.push(text);
          },
        }),
      ).rejects.toThrow("restore failed");
      expect(notices.at(-1)).toContain("AutoDev policy guard");
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });
});
