import { handleAutoDevRunCommand as runHandleAutoDevRunCommand } from "./autodev-run-dispatch";

type AutoDevRunCommandDispatchContext = Parameters<typeof runHandleAutoDevRunCommand>[0];

interface AutoDevRunCommandContextInput {
  logger: AutoDevRunCommandDispatchContext["logger"];
  outputLanguage: AutoDevRunCommandDispatchContext["outputLanguage"];
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevAutoReleaseEnabled: boolean;
  autoDevAutoReleasePush: boolean;
  autoDevMaxConsecutiveFailures: number;
  autoDevRunArchiveEnabled: boolean;
  autoDevRunArchiveDir: string;
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
  listWorkflowDiagRunsBySession: AutoDevRunCommandDispatchContext["listWorkflowDiagRunsBySession"];
  listWorkflowDiagEvents: AutoDevRunCommandDispatchContext["listWorkflowDiagEvents"];
  recordAutoDevGitCommit: AutoDevRunCommandDispatchContext["recordAutoDevGitCommit"];
  autoDevMetrics: AutoDevRunCommandDispatchContext["autoDevMetrics"];
}

interface AutoDevRunCommandRuntimeContextInput {
  logger: AutoDevRunCommandDispatchContext["logger"];
  config: {
    autoDevLoopMaxRuns: number;
    autoDevLoopMaxMinutes: number;
    autoDevAutoCommit: boolean;
    autoDevAutoReleaseEnabled: boolean;
    autoDevAutoReleasePush: boolean;
    autoDevMaxConsecutiveFailures: number;
    autoDevRunArchiveEnabled: boolean;
    autoDevRunArchiveDir: string;
    outputLanguage: AutoDevRunCommandDispatchContext["outputLanguage"];
  };
  state: {
    pendingAutoDevLoopStopRequests: AutoDevRunCommandDispatchContext["pendingAutoDevLoopStopRequests"];
    activeAutoDevLoopSessions: AutoDevRunCommandDispatchContext["activeAutoDevLoopSessions"];
    autoDevFailureStreaks: AutoDevRunCommandDispatchContext["autoDevFailureStreaks"];
  };
  hooks: {
    consumePendingStopRequest: AutoDevRunCommandDispatchContext["consumePendingStopRequest"];
    consumePendingAutoDevLoopStopRequest: AutoDevRunCommandDispatchContext["consumePendingAutoDevLoopStopRequest"];
    setAutoDevSnapshot: AutoDevRunCommandDispatchContext["setAutoDevSnapshot"];
    channelSendNotice: AutoDevRunCommandDispatchContext["channelSendNotice"];
    beginWorkflowDiagRun: AutoDevRunCommandDispatchContext["beginWorkflowDiagRun"];
    appendWorkflowDiagEvent: AutoDevRunCommandDispatchContext["appendWorkflowDiagEvent"];
    runWorkflowCommand: AutoDevRunCommandDispatchContext["runWorkflowCommand"];
    listWorkflowDiagRunsBySession: AutoDevRunCommandDispatchContext["listWorkflowDiagRunsBySession"];
    listWorkflowDiagEvents: AutoDevRunCommandDispatchContext["listWorkflowDiagEvents"];
    recordAutoDevGitCommit: AutoDevRunCommandDispatchContext["recordAutoDevGitCommit"];
  };
  autoDevMetrics: AutoDevRunCommandDispatchContext["autoDevMetrics"];
}

export function buildAutoDevRunCommandDispatchContext(
  input: AutoDevRunCommandContextInput,
): AutoDevRunCommandDispatchContext {
  return {
    logger: input.logger,
    outputLanguage: input.outputLanguage,
    autoDevLoopMaxRuns: input.autoDevLoopMaxRuns,
    autoDevLoopMaxMinutes: input.autoDevLoopMaxMinutes,
    autoDevAutoCommit: input.autoDevAutoCommit,
    autoDevAutoReleaseEnabled: input.autoDevAutoReleaseEnabled,
    autoDevAutoReleasePush: input.autoDevAutoReleasePush,
    autoDevMaxConsecutiveFailures: input.autoDevMaxConsecutiveFailures,
    autoDevRunArchiveEnabled: input.autoDevRunArchiveEnabled,
    autoDevRunArchiveDir: input.autoDevRunArchiveDir,
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
    listWorkflowDiagRunsBySession: input.listWorkflowDiagRunsBySession,
    listWorkflowDiagEvents: input.listWorkflowDiagEvents,
    recordAutoDevGitCommit: input.recordAutoDevGitCommit,
    autoDevMetrics: input.autoDevMetrics,
  };
}

export function buildAutoDevRunCommandDispatchContextFromRuntime(
  input: AutoDevRunCommandRuntimeContextInput,
): AutoDevRunCommandDispatchContext {
  return buildAutoDevRunCommandDispatchContext({
    logger: input.logger,
    outputLanguage: input.config.outputLanguage,
    autoDevLoopMaxRuns: input.config.autoDevLoopMaxRuns,
    autoDevLoopMaxMinutes: input.config.autoDevLoopMaxMinutes,
    autoDevAutoCommit: input.config.autoDevAutoCommit,
    autoDevAutoReleaseEnabled: input.config.autoDevAutoReleaseEnabled,
    autoDevAutoReleasePush: input.config.autoDevAutoReleasePush,
    autoDevMaxConsecutiveFailures: input.config.autoDevMaxConsecutiveFailures,
    autoDevRunArchiveEnabled: input.config.autoDevRunArchiveEnabled,
    autoDevRunArchiveDir: input.config.autoDevRunArchiveDir,
    pendingAutoDevLoopStopRequests: input.state.pendingAutoDevLoopStopRequests,
    activeAutoDevLoopSessions: input.state.activeAutoDevLoopSessions,
    autoDevFailureStreaks: input.state.autoDevFailureStreaks,
    consumePendingStopRequest: input.hooks.consumePendingStopRequest,
    consumePendingAutoDevLoopStopRequest: input.hooks.consumePendingAutoDevLoopStopRequest,
    setAutoDevSnapshot: input.hooks.setAutoDevSnapshot,
    channelSendNotice: input.hooks.channelSendNotice,
    beginWorkflowDiagRun: input.hooks.beginWorkflowDiagRun,
    appendWorkflowDiagEvent: input.hooks.appendWorkflowDiagEvent,
    runWorkflowCommand: input.hooks.runWorkflowCommand,
    listWorkflowDiagRunsBySession: input.hooks.listWorkflowDiagRunsBySession,
    listWorkflowDiagEvents: input.hooks.listWorkflowDiagEvents,
    recordAutoDevGitCommit: input.hooks.recordAutoDevGitCommit,
    autoDevMetrics: input.autoDevMetrics,
  });
}
