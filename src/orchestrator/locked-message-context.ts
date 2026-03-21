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
  handleAutoDevSkillsCommand: LockedMessageDispatchContext["handleAutoDevSkillsCommand"];
  handleAutoDevLoopStopCommand: LockedMessageDispatchContext["handleAutoDevLoopStopCommand"];
  getTaskQueueStateStore: LockedMessageDispatchContext["getTaskQueueStateStore"];
  tryAcquireRateLimit: LockedMessageDispatchContext["tryAcquireRateLimit"];
  sendNotice: LockedMessageDispatchContext["sendNotice"];
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
    handleAutoDevSkillsCommand: input.handleAutoDevSkillsCommand,
    handleAutoDevLoopStopCommand: input.handleAutoDevLoopStopCommand,
    getTaskQueueStateStore: input.getTaskQueueStateStore,
    tryAcquireRateLimit: input.tryAcquireRateLimit,
    sendNotice: input.sendNotice,
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
  handleControlCommand: LockedMessageDispatchContext["handleControlCommand"];
  handleWorkflowStatusCommand: LockedMessageDispatchContext["handleWorkflowStatusCommand"];
  handleAutoDevStatusCommand: LockedMessageDispatchContext["handleAutoDevStatusCommand"];
  handleAutoDevProgressCommand: LockedMessageDispatchContext["handleAutoDevProgressCommand"];
  handleAutoDevSkillsCommand: LockedMessageDispatchContext["handleAutoDevSkillsCommand"];
  handleAutoDevLoopStopCommand: LockedMessageDispatchContext["handleAutoDevLoopStopCommand"];
  getTaskQueueStateStore: LockedMessageDispatchContext["getTaskQueueStateStore"];
  rateLimiter: {
    tryAcquire: LockedMessageDispatchContext["tryAcquireRateLimit"];
  };
  sendNotice: LockedMessageDispatchContext["sendNotice"];
  classifyBackendTaskType: LockedMessageDispatchContext["classifyBackendTaskType"];
  resolveSessionBackendDecision: LockedMessageDispatchContext["resolveSessionBackendDecision"];
  prepareBackendRuntimeForSession: LockedMessageDispatchContext["prepareBackendRuntimeForSession"];
  sessionLastBackendDecisions: Map<string, Parameters<LockedMessageDispatchContext["setSessionLastBackendDecision"]>[1]>;
  recordBackendRouteDecision: LockedMessageDispatchContext["recordBackendRouteDecision"];
  executeWorkflowRun: LockedMessageDispatchContext["executeWorkflowRun"];
  executeAutoDevRun: LockedMessageDispatchContext["executeAutoDevRun"];
  executeChatRun: LockedMessageDispatchContext["executeChatRun"];
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
    handleControlCommand: input.handleControlCommand,
    handleWorkflowStatusCommand: input.handleWorkflowStatusCommand,
    handleAutoDevStatusCommand: input.handleAutoDevStatusCommand,
    handleAutoDevProgressCommand: input.handleAutoDevProgressCommand,
    handleAutoDevSkillsCommand: input.handleAutoDevSkillsCommand,
    handleAutoDevLoopStopCommand: input.handleAutoDevLoopStopCommand,
    getTaskQueueStateStore: input.getTaskQueueStateStore,
    tryAcquireRateLimit: (request) => input.rateLimiter.tryAcquire(request),
    sendNotice: input.sendNotice,
    classifyBackendTaskType: input.classifyBackendTaskType,
    resolveSessionBackendDecision: input.resolveSessionBackendDecision,
    prepareBackendRuntimeForSession: input.prepareBackendRuntimeForSession,
    setSessionLastBackendDecision: (sessionKey, decision) => input.sessionLastBackendDecisions.set(sessionKey, decision),
    recordBackendRouteDecision: input.recordBackendRouteDecision,
    executeWorkflowRun: input.executeWorkflowRun,
    executeAutoDevRun: input.executeAutoDevRun,
    executeChatRun: input.executeChatRun,
  });
}
