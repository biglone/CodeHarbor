import type { AutoDevRunSnapshot } from "./autodev-runner";

export function createIdleAutoDevSnapshot(): AutoDevRunSnapshot {
  return {
    state: "idle",
    startedAt: null,
    endedAt: null,
    taskId: null,
    taskDescription: null,
    approved: null,
    repairRounds: 0,
    error: null,
    mode: "idle",
    loopRound: 0,
    loopCompletedRuns: 0,
    loopMaxRuns: 0,
    loopDeadlineAt: null,
    lastGitCommitSummary: null,
    lastGitCommitAt: null,
  };
}
