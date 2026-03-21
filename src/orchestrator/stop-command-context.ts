import { sendStopCommand as runSendStopCommand } from "./stop-command-dispatch";

type StopCommandDispatchContext = Parameters<typeof runSendStopCommand>[0];

interface StopCommandContextInput {
  logger: StopCommandDispatchContext["logger"];
  pendingAutoDevLoopStopRequests: StopCommandDispatchContext["pendingAutoDevLoopStopRequests"];
  activeAutoDevLoopSessions: StopCommandDispatchContext["activeAutoDevLoopSessions"];
  autoDevDetailedProgressOverrides: StopCommandDispatchContext["autoDevDetailedProgressOverrides"];
  stateStore: StopCommandDispatchContext["stateStore"];
  clearSessionFromAllRuntimes: StopCommandDispatchContext["clearSessionFromAllRuntimes"];
  sessionBackendProfiles: StopCommandDispatchContext["sessionBackendProfiles"];
  skipBridgeForNextPrompt: StopCommandDispatchContext["skipBridgeForNextPrompt"];
  getTaskQueueStateStore: StopCommandDispatchContext["getTaskQueueStateStore"];
  runningExecutions: StopCommandDispatchContext["runningExecutions"];
  pendingStopRequests: StopCommandDispatchContext["pendingStopRequests"];
  cancelRunningExecutionInAllRuntimes: StopCommandDispatchContext["cancelRunningExecutionInAllRuntimes"];
  isSessionBusy: StopCommandDispatchContext["isSessionBusy"];
  sendNotice: StopCommandDispatchContext["sendNotice"];
}

export function buildStopCommandDispatchContext(input: StopCommandContextInput): StopCommandDispatchContext {
  return {
    logger: input.logger,
    pendingAutoDevLoopStopRequests: input.pendingAutoDevLoopStopRequests,
    activeAutoDevLoopSessions: input.activeAutoDevLoopSessions,
    autoDevDetailedProgressOverrides: input.autoDevDetailedProgressOverrides,
    stateStore: input.stateStore,
    clearSessionFromAllRuntimes: input.clearSessionFromAllRuntimes,
    sessionBackendProfiles: input.sessionBackendProfiles,
    skipBridgeForNextPrompt: input.skipBridgeForNextPrompt,
    getTaskQueueStateStore: input.getTaskQueueStateStore,
    runningExecutions: input.runningExecutions,
    pendingStopRequests: input.pendingStopRequests,
    cancelRunningExecutionInAllRuntimes: input.cancelRunningExecutionInAllRuntimes,
    isSessionBusy: input.isSessionBusy,
    sendNotice: input.sendNotice,
  };
}
