import { handleAutoDevRunCommand as runHandleAutoDevRunCommand } from "./autodev-run-dispatch";

type AutoDevRunCommandDispatchContext = Parameters<typeof runHandleAutoDevRunCommand>[0];

interface AutoDevRunCommandContextInput {
  logger: AutoDevRunCommandDispatchContext["logger"];
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevMaxConsecutiveFailures: number;
  pendingAutoDevLoopStopRequests: AutoDevRunCommandDispatchContext["pendingAutoDevLoopStopRequests"];
  activeAutoDevLoopSessions: AutoDevRunCommandDispatchContext["activeAutoDevLoopSessions"];
  autoDevFailureStreaks: AutoDevRunCommandDispatchContext["autoDevFailureStreaks"];
  consumePendingStopRequest: AutoDevRunCommandDispatchContext["consumePendingStopRequest"];
  consumePendingAutoDevLoopStopRequest: AutoDevRunCommandDispatchContext["consumePendingAutoDevLoopStopRequest"];
  setAutoDevSnapshot: AutoDevRunCommandDispatchContext["setAutoDevSnapshot"];
  channelSendNotice: AutoDevRunCommandDispatchContext["channelSendNotice"];
  beginWorkflowDiagRun: AutoDevRunCommandDispatchContext["beginWorkflowDiagRun"];
  appendWorkflowDiagEvent: AutoDevRunCommandDispatchContext["appendWorkflowDiagEvent"];
  runWorkflowCommand: AutoDevRunCommandDispatchContext["runWorkflowCommand"];
  recordAutoDevGitCommit: AutoDevRunCommandDispatchContext["recordAutoDevGitCommit"];
  autoDevMetrics: AutoDevRunCommandDispatchContext["autoDevMetrics"];
}

export function buildAutoDevRunCommandDispatchContext(
  input: AutoDevRunCommandContextInput,
): AutoDevRunCommandDispatchContext {
  return {
    logger: input.logger,
    autoDevLoopMaxRuns: input.autoDevLoopMaxRuns,
    autoDevLoopMaxMinutes: input.autoDevLoopMaxMinutes,
    autoDevAutoCommit: input.autoDevAutoCommit,
    autoDevMaxConsecutiveFailures: input.autoDevMaxConsecutiveFailures,
    pendingAutoDevLoopStopRequests: input.pendingAutoDevLoopStopRequests,
    activeAutoDevLoopSessions: input.activeAutoDevLoopSessions,
    autoDevFailureStreaks: input.autoDevFailureStreaks,
    consumePendingStopRequest: input.consumePendingStopRequest,
    consumePendingAutoDevLoopStopRequest: input.consumePendingAutoDevLoopStopRequest,
    setAutoDevSnapshot: input.setAutoDevSnapshot,
    channelSendNotice: input.channelSendNotice,
    beginWorkflowDiagRun: input.beginWorkflowDiagRun,
    appendWorkflowDiagEvent: input.appendWorkflowDiagEvent,
    runWorkflowCommand: input.runWorkflowCommand,
    recordAutoDevGitCommit: input.recordAutoDevGitCommit,
    autoDevMetrics: input.autoDevMetrics,
  };
}
