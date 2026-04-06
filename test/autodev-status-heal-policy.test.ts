import { describe, expect, it } from "vitest";

import { deriveExpectedAutoDevTaskStatusFromRun } from "../src/orchestrator/autodev-status-heal-policy";
import type { WorkflowDiagRunRecord } from "../src/orchestrator/workflow-diag";

function makeRun(overrides?: Partial<WorkflowDiagRunRecord>): WorkflowDiagRunRecord {
  return {
    runId: "run-1",
    kind: "autodev",
    sessionKey: "session-1",
    conversationId: "conversation-1",
    requestId: "request-1",
    objective: "objective",
    taskId: "T10.10",
    taskDescription: "task",
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

describe("autodev status-heal policy", () => {
  it("prioritizes explicit taskStatus from run message", () => {
    const run = makeRun({
      lastMessage: "AutoDev task result: task=T10.10, taskStatus=✅, completionGate=failed",
      approved: false,
    });

    expect(deriveExpectedAutoDevTaskStatusFromRun(run)).toBe("completed");
  });

  it("maps completionGate passed/failed to completed/in_progress", () => {
    expect(
      deriveExpectedAutoDevTaskStatusFromRun(
        makeRun({
          lastMessage: "AutoDev task result: completionGate=passed",
        }),
      ),
    ).toBe("completed");

    expect(
      deriveExpectedAutoDevTaskStatusFromRun(
        makeRun({
          lastMessage: "AutoDev task result: completionGate=failed",
        }),
      ),
    ).toBe("in_progress");
  });

  it("falls back to reviewer approval when message has no status/gate", () => {
    expect(
      deriveExpectedAutoDevTaskStatusFromRun(
        makeRun({
          lastMessage: "AutoDev task result without gate",
          approved: false,
        }),
      ),
    ).toBe("in_progress");

    expect(
      deriveExpectedAutoDevTaskStatusFromRun(
        makeRun({
          lastMessage: "AutoDev task result without gate",
          approved: true,
        }),
      ),
    ).toBeNull();
  });
});
