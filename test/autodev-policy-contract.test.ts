import { describe, expect, it } from "vitest";

import { evaluateAutoDevLoopBoundary } from "../src/orchestrator/autodev-loop-engine";
import {
  evaluateAutoDevCompletionGate,
  formatAutoDevCompletionGateReasons,
} from "../src/orchestrator/autodev-completion-gate-policy";
import { inferAutoDevValidation } from "../src/orchestrator/autodev-validation-policy";
import { deriveExpectedAutoDevTaskStatusFromRun } from "../src/orchestrator/autodev-status-heal-policy";
import type { WorkflowDiagRunRecord } from "../src/orchestrator/workflow-diag";

function makeRun(overrides?: Partial<WorkflowDiagRunRecord>): WorkflowDiagRunRecord {
  return {
    runId: "run-contract-1",
    kind: "autodev",
    sessionKey: "session-contract",
    conversationId: "conversation-contract",
    requestId: "request-contract",
    objective: "contract",
    taskId: "T-contract",
    taskDescription: "contract",
    status: "succeeded",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    durationMs: 1,
    approved: null,
    repairRounds: 0,
    error: null,
    lastStage: "autodev",
    lastMessage: null,
    updatedAt: new Date(1).toISOString(),
    ...overrides,
  };
}

describe("autodev policy contract matrix", () => {
  it("loop boundary contract", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const output = [
      evaluateAutoDevLoopBoundary({ attemptedRuns: 0, loopMaxRuns: 3, loopDeadlineAtIso: null, nowMs: now }),
      evaluateAutoDevLoopBoundary({ attemptedRuns: 3, loopMaxRuns: 3, loopDeadlineAtIso: null, nowMs: now }),
      evaluateAutoDevLoopBoundary({
        attemptedRuns: 1,
        loopMaxRuns: 0,
        loopDeadlineAtIso: "2025-12-31T23:59:59.000Z",
        nowMs: now,
      }),
      evaluateAutoDevLoopBoundary({ attemptedRuns: 1, loopMaxRuns: 0, loopDeadlineAtIso: "invalid", nowMs: now }),
    ];

    expect(output).toEqual([
      { shouldStop: false, reason: null },
      { shouldStop: true, reason: "max_runs" },
      { shouldStop: true, reason: "deadline" },
      { shouldStop: false, reason: null },
    ]);
  });

  it("completion gate contract", () => {
    const matrix = [
      evaluateAutoDevCompletionGate({
        reviewerApproved: true,
        validationPassed: true,
        taskListPolicyPassed: true,
        commitRequired: true,
        gitCommit: {
          kind: "committed",
          commitHash: "abc",
          commitSubject: "feat: contract",
          changedFiles: ["TASK_LIST.md"],
        },
      }),
      evaluateAutoDevCompletionGate({
        reviewerApproved: false,
        validationPassed: true,
        taskListPolicyPassed: true,
        commitRequired: false,
        gitCommit: { kind: "skipped", reason: "disabled" },
      }),
      evaluateAutoDevCompletionGate({
        reviewerApproved: true,
        validationPassed: false,
        taskListPolicyPassed: false,
        commitRequired: true,
        gitCommit: { kind: "skipped", reason: "no commit" },
      }),
    ];

    expect(matrix).toEqual([
      { passed: true, reasons: [] },
      { passed: false, reasons: ["reviewer_not_approved"] },
      {
        passed: false,
        reasons: ["validation_not_passed", "task_list_policy_violated", "auto_commit_not_committed"],
      },
    ]);
    expect(formatAutoDevCompletionGateReasons(matrix[2].reasons, "en")).toBe(
      "validation-not-passed, task-list-policy-violated, auto-commit-not-committed",
    );
    expect(formatAutoDevCompletionGateReasons(matrix[2].reasons, "zh")).toBe(
      "验证未通过, TASK_LIST写入策略违反, 自动提交未成功",
    );
  });

  it("validation inference contract", () => {
    const matrix = [
      inferAutoDevValidation({
        output: "validation_status: passed",
        review: "",
        strictMode: true,
      }),
      inferAutoDevValidation({
        output: "validation_status: failed",
        review: "",
        strictMode: false,
      }),
      inferAutoDevValidation({
        output: ["validation_status: passed", "__EXIT_CODES__: unit=1", "expected exit: 1"].join("\n"),
        review: "",
        strictMode: false,
      }),
      inferAutoDevValidation({
        output: "no structured evidence",
        review: "all passed",
        strictMode: false,
      }),
      inferAutoDevValidation({
        output: "no structured evidence",
        review: "all passed",
        strictMode: true,
      }),
    ];

    expect(matrix).toEqual([
      { passed: true, failureClass: null, evidenceSource: "structured" },
      { passed: false, failureClass: "structured_status_fail", evidenceSource: "structured" },
      { passed: true, failureClass: null, evidenceSource: "structured" },
      { passed: true, failureClass: null, evidenceSource: "scoped_text" },
      { passed: false, failureClass: "strict_missing_structured_evidence", evidenceSource: "none" },
    ]);
  });

  it("status-heal contract", () => {
    const matrix = [
      deriveExpectedAutoDevTaskStatusFromRun(
        makeRun({
          lastMessage: "AutoDev task result: taskStatus=✅, completionGate=failed",
          approved: false,
        }),
      ),
      deriveExpectedAutoDevTaskStatusFromRun(makeRun({ lastMessage: "AutoDev task result: completionGate=passed" })),
      deriveExpectedAutoDevTaskStatusFromRun(makeRun({ lastMessage: "AutoDev task result: completionGate=failed" })),
      deriveExpectedAutoDevTaskStatusFromRun(makeRun({ lastMessage: "AutoDev task result", approved: false })),
      deriveExpectedAutoDevTaskStatusFromRun(makeRun({ lastMessage: "AutoDev task result", approved: true })),
    ];

    expect(matrix).toEqual(["completed", "completed", "in_progress", "in_progress", null]);
  });
});
