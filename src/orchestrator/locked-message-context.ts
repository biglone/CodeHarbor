import { executeLockedMessage } from "./locked-message-execution";

type LockedMessageDispatchContext = Parameters<typeof executeLockedMessage>[0];

interface LockedMessageContextInput {
  logger: LockedMessageDispatchContext["logger"];
  workflowEnabled: boolean;
  hasProcessedEvent: LockedMessageDispatchContext["hasProcessedEvent"];
  markEventProcessed: LockedMessageDispatchContext["markEventProcessed"];
  recordRequestMetrics: LockedMessageDispatchContext["recordRequestMetrics"];
  resolveRoomRuntimeConfig: LockedMessageDispatchContext["resolveRoomRuntimeConfig"];
  routeMessage: LockedMessageDispatchContext["routeMessage"];
  handleControlCommand: LockedMessageDispatchContext["handleControlCommand"];
  handleWorkflowStatusCommand: LockedMessageDispatchContext["handleWorkflowStatusCommand"];
  handleAutoDevStatusCommand: LockedMessageDispatchContext["handleAutoDevStatusCommand"];
  handleAutoDevProgressCommand: LockedMessageDispatchContext["handleAutoDevProgressCommand"];
  handleAutoDevContentCommand: LockedMessageDispatchContext["handleAutoDevContentCommand"];
  handleAutoDevSkillsCommand: LockedMessageDispatchContext["handleAutoDevSkillsCommand"];
  handleAutoDevLoopStopCommand: LockedMessageDispatchContext["handleAutoDevLoopStopCommand"];
  handleAutoDevReconcileCommand: LockedMessageDispatchContext["handleAutoDevReconcileCommand"];
  handleAutoDevWorkdirCommand: LockedMessageDispatchContext["handleAutoDevWorkdirCommand"];
  handleAutoDevInitCommand: LockedMessageDispatchContext["handleAutoDevInitCommand"];
  tryHandleAutoDevSecondaryReviewReceipt: LockedMessageDispatchContext["tryHandleAutoDevSecondaryReviewReceipt"];
  getTaskQueueStateStore: LockedMessageDispatchContext["getTaskQueueStateStore"];
  tryAcquireRateLimit: LockedMessageDispatchContext["tryAcquireRateLimit"];
  sendNotice: LockedMessageDispatchContext["sendNotice"];
  sendFile: LockedMessageDispatchContext["sendFile"];
  listRecentArtifactBatches: LockedMessageDispatchContext["listRecentArtifactBatches"];
  classifyBackendTaskType: LockedMessageDispatchContext["classifyBackendTaskType"];
  resolveSessionBackendDecision: LockedMessageDispatchContext["resolveSessionBackendDecision"];
  prepareBackendRuntimeForSession: LockedMessageDispatchContext["prepareBackendRuntimeForSession"];
  setSessionLastBackendDecision: LockedMessageDispatchContext["setSessionLastBackendDecision"];
  recordBackendRouteDecision: LockedMessageDispatchContext["recordBackendRouteDecision"];
  executeWorkflowRun: LockedMessageDispatchContext["executeWorkflowRun"];
  executeAutoDevRun: LockedMessageDispatchContext["executeAutoDevRun"];
  executeChatRun: LockedMessageDispatchContext["executeChatRun"];
}

export function buildLockedMessageDispatchContext(
  input: LockedMessageContextInput,
): LockedMessageDispatchContext {
  return {
    logger: input.logger,
    workflowEnabled: input.workflowEnabled,
    hasProcessedEvent: input.hasProcessedEvent,
    markEventProcessed: input.markEventProcessed,
    recordRequestMetrics: input.recordRequestMetrics,
    resolveRoomRuntimeConfig: input.resolveRoomRuntimeConfig,
    routeMessage: input.routeMessage,
    handleControlCommand: input.handleControlCommand,
    handleWorkflowStatusCommand: input.handleWorkflowStatusCommand,
    handleAutoDevStatusCommand: input.handleAutoDevStatusCommand,
    handleAutoDevProgressCommand: input.handleAutoDevProgressCommand,
    handleAutoDevContentCommand: input.handleAutoDevContentCommand,
    handleAutoDevSkillsCommand: input.handleAutoDevSkillsCommand,
    handleAutoDevLoopStopCommand: input.handleAutoDevLoopStopCommand,
    handleAutoDevReconcileCommand: input.handleAutoDevReconcileCommand,
    handleAutoDevWorkdirCommand: input.handleAutoDevWorkdirCommand,
    handleAutoDevInitCommand: input.handleAutoDevInitCommand,
    tryHandleAutoDevSecondaryReviewReceipt: input.tryHandleAutoDevSecondaryReviewReceipt,
    getTaskQueueStateStore: input.getTaskQueueStateStore,
    tryAcquireRateLimit: input.tryAcquireRateLimit,
    sendNotice: input.sendNotice,
    sendFile: input.sendFile,
    listRecentArtifactBatches: input.listRecentArtifactBatches,
    classifyBackendTaskType: input.classifyBackendTaskType,
    resolveSessionBackendDecision: input.resolveSessionBackendDecision,
    prepareBackendRuntimeForSession: input.prepareBackendRuntimeForSession,
    setSessionLastBackendDecision: input.setSessionLastBackendDecision,
    recordBackendRouteDecision: input.recordBackendRouteDecision,
    executeWorkflowRun: input.executeWorkflowRun,
    executeAutoDevRun: input.executeAutoDevRun,
    executeChatRun: input.executeChatRun,
  };
}

interface LockedMessageRuntimeContextInput {
  logger: LockedMessageDispatchContext["logger"];
  workflowEnabled: boolean;
  stateStore: {
    hasProcessedEvent: LockedMessageDispatchContext["hasProcessedEvent"];
    markEventProcessed: LockedMessageDispatchContext["markEventProcessed"];
  };
  recordRequestMetrics: LockedMessageDispatchContext["recordRequestMetrics"];
  resolveRoomRuntimeConfig: LockedMessageDispatchContext["resolveRoomRuntimeConfig"];
  routeMessage: LockedMessageDispatchContext["routeMessage"];
  controlHandlers: Pick<
    LockedMessageDispatchContext,
    | "handleControlCommand"
    | "handleWorkflowStatusCommand"
    | "handleAutoDevStatusCommand"
    | "handleAutoDevProgressCommand"
    | "handleAutoDevContentCommand"
    | "handleAutoDevSkillsCommand"
    | "handleAutoDevLoopStopCommand"
    | "handleAutoDevReconcileCommand"
    | "handleAutoDevWorkdirCommand"
    | "handleAutoDevInitCommand"
    | "tryHandleAutoDevSecondaryReviewReceipt"
  >;
  getTaskQueueStateStore: LockedMessageDispatchContext["getTaskQueueStateStore"];
  rateLimiter: {
    tryAcquire: LockedMessageDispatchContext["tryAcquireRateLimit"];
  };
  sendNotice: LockedMessageDispatchContext["sendNotice"];
  sendFile: LockedMessageDispatchContext["sendFile"];
  listRecentArtifactBatches: LockedMessageDispatchContext["listRecentArtifactBatches"];
  backendHandlers: Pick<
    LockedMessageDispatchContext,
    | "classifyBackendTaskType"
    | "resolveSessionBackendDecision"
    | "prepareBackendRuntimeForSession"
    | "recordBackendRouteDecision"
    | "executeWorkflowRun"
    | "executeAutoDevRun"
    | "executeChatRun"
  > & {
    sessionLastBackendDecisions: Map<string, Parameters<LockedMessageDispatchContext["setSessionLastBackendDecision"]>[1]>;
  };
}

export function buildLockedMessageDispatchContextFromRuntime(
  input: LockedMessageRuntimeContextInput,
): LockedMessageDispatchContext {
  return buildLockedMessageDispatchContext({
    logger: input.logger,
    workflowEnabled: input.workflowEnabled,
    hasProcessedEvent: (sessionKey, eventId) => input.stateStore.hasProcessedEvent(sessionKey, eventId),
    markEventProcessed: (sessionKey, eventId) => input.stateStore.markEventProcessed(sessionKey, eventId),
    recordRequestMetrics: input.recordRequestMetrics,
    resolveRoomRuntimeConfig: input.resolveRoomRuntimeConfig,
    routeMessage: input.routeMessage,
    handleControlCommand: input.controlHandlers.handleControlCommand,
    handleWorkflowStatusCommand: input.controlHandlers.handleWorkflowStatusCommand,
    handleAutoDevStatusCommand: input.controlHandlers.handleAutoDevStatusCommand,
    handleAutoDevProgressCommand: input.controlHandlers.handleAutoDevProgressCommand,
    handleAutoDevContentCommand: input.controlHandlers.handleAutoDevContentCommand,
    handleAutoDevSkillsCommand: input.controlHandlers.handleAutoDevSkillsCommand,
    handleAutoDevLoopStopCommand: input.controlHandlers.handleAutoDevLoopStopCommand,
    handleAutoDevReconcileCommand: input.controlHandlers.handleAutoDevReconcileCommand,
    handleAutoDevWorkdirCommand: input.controlHandlers.handleAutoDevWorkdirCommand,
    handleAutoDevInitCommand: input.controlHandlers.handleAutoDevInitCommand,
    tryHandleAutoDevSecondaryReviewReceipt: input.controlHandlers.tryHandleAutoDevSecondaryReviewReceipt,
    getTaskQueueStateStore: input.getTaskQueueStateStore,
    tryAcquireRateLimit: (request) => input.rateLimiter.tryAcquire(request),
    sendNotice: input.sendNotice,
    sendFile: input.sendFile,
    listRecentArtifactBatches: input.listRecentArtifactBatches,
    classifyBackendTaskType: input.backendHandlers.classifyBackendTaskType,
    resolveSessionBackendDecision: input.backendHandlers.resolveSessionBackendDecision,
    prepareBackendRuntimeForSession: input.backendHandlers.prepareBackendRuntimeForSession,
    setSessionLastBackendDecision: (sessionKey, decision) =>
      input.backendHandlers.sessionLastBackendDecisions.set(sessionKey, decision),
    recordBackendRouteDecision: input.backendHandlers.recordBackendRouteDecision,
    executeWorkflowRun: input.backendHandlers.executeWorkflowRun,
    executeAutoDevRun: input.backendHandlers.executeAutoDevRun,
    executeChatRun: input.backendHandlers.executeChatRun,
  });
}
