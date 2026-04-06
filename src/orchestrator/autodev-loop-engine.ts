import type { Logger } from "../logger";
import type { OutputLanguage } from "../config";

import { formatError } from "./helpers";
import { byOutputLanguage } from "./output-language";

export type AutoDevLoopBoundaryStopReason = "max_runs" | "deadline";

export interface AutoDevLoopBoundaryDecision {
  shouldStop: boolean;
  reason: AutoDevLoopBoundaryStopReason | null;
}

export interface AutoDevLoopBoundaryInput {
  attemptedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAtIso: string | null;
  nowMs?: number;
}

export interface AutoDevNestedLoopRunContext {
  mode: "loop";
  loopRound: number;
  loopCompletedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAt: string | null;
}

export interface BuildAutoDevNestedLoopRunContextInput {
  attemptedRuns: number;
  completedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAtIso: string | null;
}

export interface AutoDevLoopStopCheckInput {
  sessionKey: string;
  conversationId: string;
  loopStartedAt: number;
  attemptedRuns: number;
  completedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAtIso: string | null;
}

interface AutoDevLoopStopSnapshot {
  state: "idle" | "succeeded";
  startedAt: string;
  endedAt: string;
  taskId: null;
  taskDescription: null;
  approved: null;
  repairRounds: number;
  error: string | null;
  mode: "loop";
  loopRound: number;
  loopCompletedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAt: string | null;
  lastGitCommitSummary: null;
  lastGitCommitAt: null;
}

export interface AutoDevLoopStopDeps {
  logger: Logger;
  outputLanguage: OutputLanguage;
  consumePendingStopRequest: (sessionKey: string) => boolean;
  consumePendingAutoDevLoopStopRequest: (sessionKey: string) => boolean;
  setAutoDevSnapshot: (sessionKey: string, snapshot: AutoDevLoopStopSnapshot) => void;
  channelSendNotice: (conversationId: string, text: string) => Promise<void>;
  autoDevMetrics: {
    recordLoopStop: (reason: "stop_requested") => void;
  };
}

export function evaluateAutoDevLoopBoundary(input: AutoDevLoopBoundaryInput): AutoDevLoopBoundaryDecision {
  if (input.loopMaxRuns > 0 && input.attemptedRuns >= input.loopMaxRuns) {
    return {
      shouldStop: true,
      reason: "max_runs",
    };
  }
  if (!input.loopDeadlineAtIso) {
    return {
      shouldStop: false,
      reason: null,
    };
  }
  const deadlineAtMs = Date.parse(input.loopDeadlineAtIso);
  if (!Number.isFinite(deadlineAtMs)) {
    return {
      shouldStop: false,
      reason: null,
    };
  }
  const nowMs = typeof input.nowMs === "number" && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  if (nowMs >= deadlineAtMs) {
    return {
      shouldStop: true,
      reason: "deadline",
    };
  }
  return {
    shouldStop: false,
    reason: null,
  };
}

export function buildAutoDevNestedLoopRunContext(
  input: BuildAutoDevNestedLoopRunContextInput,
): AutoDevNestedLoopRunContext {
  return {
    mode: "loop",
    loopRound: input.attemptedRuns,
    loopCompletedRuns: input.completedRuns,
    loopMaxRuns: input.loopMaxRuns,
    loopDeadlineAt: input.loopDeadlineAtIso,
  };
}

export async function handleAutoDevLoopStopIfRequested(
  deps: AutoDevLoopStopDeps,
  input: AutoDevLoopStopCheckInput,
): Promise<boolean> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  if (deps.consumePendingStopRequest(input.sessionKey)) {
    deps.autoDevMetrics.recordLoopStop("stop_requested");
    const endedAtIso = new Date().toISOString();
    deps.setAutoDevSnapshot(input.sessionKey, {
      state: "idle",
      startedAt: new Date(input.loopStartedAt).toISOString(),
      endedAt: endedAtIso,
      taskId: null,
      taskDescription: null,
      approved: null,
      repairRounds: 0,
      error: "stopped by /stop",
      mode: "loop",
      loopRound: input.attemptedRuns,
      loopCompletedRuns: input.completedRuns,
      loopMaxRuns: input.loopMaxRuns,
      loopDeadlineAt: input.loopDeadlineAtIso,
      lastGitCommitSummary: null,
      lastGitCommitAt: null,
    });
    await sendAutoDevLoopNoticeBestEffort(
      deps,
      input.conversationId,
      localize(
        `[CodeHarbor] AutoDev 循环执行已停止。
- completedRuns: ${input.completedRuns}`,
        `[CodeHarbor] AutoDev loop stopped.
- completedRuns: ${input.completedRuns}`,
      ),
    );
    return true;
  }

  if (deps.consumePendingAutoDevLoopStopRequest(input.sessionKey)) {
    deps.autoDevMetrics.recordLoopStop("stop_requested");
    const endedAtIso = new Date().toISOString();
    deps.setAutoDevSnapshot(input.sessionKey, {
      state: "succeeded",
      startedAt: new Date(input.loopStartedAt).toISOString(),
      endedAt: endedAtIso,
      taskId: null,
      taskDescription: null,
      approved: null,
      repairRounds: 0,
      error: null,
      mode: "loop",
      loopRound: input.attemptedRuns,
      loopCompletedRuns: input.completedRuns,
      loopMaxRuns: input.loopMaxRuns,
      loopDeadlineAt: input.loopDeadlineAtIso,
      lastGitCommitSummary: null,
      lastGitCommitAt: null,
    });
    await sendAutoDevLoopNoticeBestEffort(
      deps,
      input.conversationId,
      localize(
        `[CodeHarbor] AutoDev 循环执行已按请求停止（当前任务已完成）。
- attemptedRuns: ${input.attemptedRuns}
- completedRuns: ${input.completedRuns}`,
        `[CodeHarbor] AutoDev loop stopped as requested (current task is complete).
- attemptedRuns: ${input.attemptedRuns}
- completedRuns: ${input.completedRuns}`,
      ),
    );
    return true;
  }

  return false;
}

async function sendAutoDevLoopNoticeBestEffort(
  deps: Pick<AutoDevLoopStopDeps, "channelSendNotice" | "logger">,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    await deps.channelSendNotice(conversationId, text);
  } catch (error) {
    deps.logger.warn("Failed to send AutoDev loop notice", {
      conversationId,
      error: formatError(error),
    });
  }
}
