import { describe, expect, it, vi } from "vitest";

import { Logger } from "../src/logger";
import {
  buildAutoDevNestedLoopRunContext,
  evaluateAutoDevLoopBoundary,
  handleAutoDevLoopStopIfRequested,
} from "../src/orchestrator/autodev-loop-engine";

describe("AutoDev loop engine", () => {
  it("evaluates loop boundary for max-runs and deadline", () => {
    expect(
      evaluateAutoDevLoopBoundary({
        attemptedRuns: 3,
        loopMaxRuns: 3,
        loopDeadlineAtIso: null,
      }),
    ).toEqual({ shouldStop: true, reason: "max_runs" });

    expect(
      evaluateAutoDevLoopBoundary({
        attemptedRuns: 1,
        loopMaxRuns: 5,
        loopDeadlineAtIso: "2026-04-06T00:00:00.000Z",
        nowMs: Date.parse("2026-04-06T00:00:01.000Z"),
      }),
    ).toEqual({ shouldStop: true, reason: "deadline" });

    expect(
      evaluateAutoDevLoopBoundary({
        attemptedRuns: 1,
        loopMaxRuns: 5,
        loopDeadlineAtIso: "2026-04-06T00:00:00.000Z",
        nowMs: Date.parse("2026-04-05T23:59:59.000Z"),
      }),
    ).toEqual({ shouldStop: false, reason: null });
  });

  it("builds nested loop run context", () => {
    expect(
      buildAutoDevNestedLoopRunContext({
        attemptedRuns: 2,
        completedRuns: 1,
        loopMaxRuns: 8,
        loopDeadlineAtIso: "2026-04-06T01:00:00.000Z",
      }),
    ).toEqual({
      mode: "loop",
      loopRound: 2,
      loopCompletedRuns: 1,
      loopMaxRuns: 8,
      loopDeadlineAt: "2026-04-06T01:00:00.000Z",
    });
  });

  it("handles /stop request and updates loop snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));

    const notices: string[] = [];
    const snapshots: Array<Record<string, unknown>> = [];
    const deps: Parameters<typeof handleAutoDevLoopStopIfRequested>[0] = {
      logger: new Logger("error"),
      outputLanguage: "en",
      consumePendingStopRequest: () => true,
      consumePendingAutoDevLoopStopRequest: () => false,
      setAutoDevSnapshot: (_sessionKey, snapshot) => {
        snapshots.push(snapshot as unknown as Record<string, unknown>);
      },
      channelSendNotice: async (_conversationId, text) => {
        notices.push(text);
      },
      autoDevMetrics: {
        recordLoopStop: () => {},
      },
    };

    try {
      const stopped = await handleAutoDevLoopStopIfRequested(deps, {
        sessionKey: "session-loop-stop",
        conversationId: "conversation-loop-stop",
        loopStartedAt: Date.parse("2026-04-06T08:00:00.000Z"),
        attemptedRuns: 4,
        completedRuns: 2,
        loopMaxRuns: 10,
        loopDeadlineAtIso: "2026-04-06T10:00:00.000Z",
      });

      expect(stopped).toBe(true);
      expect(snapshots).toMatchInlineSnapshot(`
        [
          {
            "approved": null,
            "endedAt": "2026-04-06T09:00:00.000Z",
            "error": "stopped by /stop",
            "lastGitCommitAt": null,
            "lastGitCommitSummary": null,
            "loopCompletedRuns": 2,
            "loopDeadlineAt": "2026-04-06T10:00:00.000Z",
            "loopMaxRuns": 10,
            "loopRound": 4,
            "mode": "loop",
            "repairRounds": 0,
            "startedAt": "2026-04-06T08:00:00.000Z",
            "state": "idle",
            "taskDescription": null,
            "taskId": null,
          },
        ]
      `);
      expect(notices).toMatchInlineSnapshot(`
        [
          "[CodeHarbor] AutoDev loop stopped.
        - completedRuns: 2",
        ]
      `);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles loop-stop request after current task completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T09:30:00.000Z"));

    const notices: string[] = [];
    const snapshots: Array<Record<string, unknown>> = [];
    const deps: Parameters<typeof handleAutoDevLoopStopIfRequested>[0] = {
      logger: new Logger("error"),
      outputLanguage: "en",
      consumePendingStopRequest: () => false,
      consumePendingAutoDevLoopStopRequest: () => true,
      setAutoDevSnapshot: (_sessionKey, snapshot) => {
        snapshots.push(snapshot as unknown as Record<string, unknown>);
      },
      channelSendNotice: async (_conversationId, text) => {
        notices.push(text);
      },
      autoDevMetrics: {
        recordLoopStop: () => {},
      },
    };

    try {
      const stopped = await handleAutoDevLoopStopIfRequested(deps, {
        sessionKey: "session-loop-stop-after-task",
        conversationId: "conversation-loop-stop-after-task",
        loopStartedAt: Date.parse("2026-04-06T09:00:00.000Z"),
        attemptedRuns: 5,
        completedRuns: 3,
        loopMaxRuns: 10,
        loopDeadlineAtIso: "2026-04-06T11:00:00.000Z",
      });

      expect(stopped).toBe(true);
      expect(snapshots).toMatchInlineSnapshot(`
        [
          {
            "approved": null,
            "endedAt": "2026-04-06T09:30:00.000Z",
            "error": null,
            "lastGitCommitAt": null,
            "lastGitCommitSummary": null,
            "loopCompletedRuns": 3,
            "loopDeadlineAt": "2026-04-06T11:00:00.000Z",
            "loopMaxRuns": 10,
            "loopRound": 5,
            "mode": "loop",
            "repairRounds": 0,
            "startedAt": "2026-04-06T09:00:00.000Z",
            "state": "succeeded",
            "taskDescription": null,
            "taskId": null,
          },
        ]
      `);
      expect(notices).toMatchInlineSnapshot(`
        [
          "[CodeHarbor] AutoDev loop stopped as requested (current task is complete).
        - attemptedRuns: 5
        - completedRuns: 3",
        ]
      `);
    } finally {
      vi.useRealTimers();
    }
  });
});
