import type { Logger } from "../logger";
import type { RequestOutcomeMetric } from "../metrics";
import type { RateLimitDecision } from "../rate-limiter";
import type { BackendModelRouteProfile, BackendModelRouteTaskType } from "../routing/backend-model-router";
import type { InboundMessage } from "../types";
import type { CodexExecutor } from "../executor/codex-executor";
import type { CodexSessionRuntime } from "../executor/codex-session-runtime";
import type { TriggerPolicy } from "../config";
import { buildRateLimitNotice } from "./workflow-status";
import { handleLockedRouteCommand, type AutoDevCommandLike, type WorkflowCommandLike } from "./locked-route-command";
import { tryEnqueueQueuedInboundRequest } from "./queue-enqueue";

type RouteDecisionLike =
  | { kind: "ignore" }
  | { kind: "execute"; prompt: string }
  | {
      kind: "command";
      command: "status" | "version" | "backend" | "stop" | "reset" | "diag" | "help" | "upgrade";
    };

interface RoomRuntimeConfigLike {
  enabled: boolean;
  triggerPolicy: TriggerPolicy;
  source: "default" | "room";
  workdir: string;
}

interface BackendDecisionLike {
  profile: BackendModelRouteProfile;
  source: "rule" | "default" | "manual_override";
  reasonCode: "manual_override" | "rule_match" | "default_fallback" | "factory_unavailable";
  ruleId: string | null;
}

interface BackendRuntimeLike {
  executor: CodexExecutor;
  sessionRuntime: CodexSessionRuntime;
}

interface ExecuteLockedMessageDeps {
  logger: Logger;
  workflowEnabled: boolean;
  hasProcessedEvent: (sessionKey: string, eventId: string) => boolean;
  markEventProcessed: (sessionKey: string, eventId: string) => void;
  recordRequestMetrics: (outcome: RequestOutcomeMetric, queueMs: number, execMs: number, sendMs: number) => void;
  resolveRoomRuntimeConfig: (conversationId: string) => RoomRuntimeConfigLike;
  routeMessage: (message: InboundMessage, sessionKey: string, roomConfig: RoomRuntimeConfigLike) => RouteDecisionLike;
  handleControlCommand: (
    command: "status" | "version" | "backend" | "stop" | "reset" | "diag" | "help" | "upgrade",
    sessionKey: string,
    message: InboundMessage,
    requestId: string,
  ) => Promise<void>;
  handleWorkflowStatusCommand: (sessionKey: string, message: InboundMessage) => Promise<void>;
  handleAutoDevStatusCommand: (sessionKey: string, message: InboundMessage, workdir: string) => Promise<void>;
  handleAutoDevProgressCommand: (sessionKey: string, message: InboundMessage, mode: "status" | "on" | "off") => Promise<void>;
  handleAutoDevSkillsCommand: (
    sessionKey: string,
    message: InboundMessage,
    mode: "status" | "on" | "off" | "summary" | "progressive" | "full",
  ) => Promise<void>;
  handleAutoDevLoopStopCommand: (sessionKey: string, message: InboundMessage) => Promise<void>;
  handleAutoDevReconcileCommand: (sessionKey: string, message: InboundMessage, workdir: string) => Promise<void>;
  handleAutoDevWorkdirCommand: (
    sessionKey: string,
    message: InboundMessage,
    mode: "status" | "set" | "clear",
    path: string | null,
    roomWorkdir: string,
  ) => Promise<void>;
  handleAutoDevInitCommand: (
    sessionKey: string,
    message: InboundMessage,
    path: string | null,
    from: string | null,
    dryRun: boolean,
    force: boolean,
    roomWorkdir: string,
  ) => Promise<void>;
  getTaskQueueStateStore: () => {
    enqueueTask: (input: {
      sessionKey: string;
      eventId: string;
      requestId: string;
      payloadJson: string;
    }) => { created: boolean; task: { id: number } };
  } | null;
  tryAcquireRateLimit: (input: { userId: string; roomId: string }) => RateLimitDecision;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
  classifyBackendTaskType: (
    workflowCommand: WorkflowCommandLike,
    autoDevCommand: AutoDevCommandLike,
  ) => BackendModelRouteTaskType;
  resolveSessionBackendDecision: (input: {
    sessionKey: string;
    message: InboundMessage;
    taskType: BackendModelRouteTaskType;
    routePrompt: string;
  }) => BackendDecisionLike;
  prepareBackendRuntimeForSession: (sessionKey: string, profile: BackendModelRouteProfile) => BackendRuntimeLike;
  setSessionLastBackendDecision: (sessionKey: string, decision: BackendDecisionLike) => void;
  recordBackendRouteDecision: (input: {
    sessionKey: string;
    message: InboundMessage;
    taskType: BackendModelRouteTaskType;
    decision: BackendDecisionLike;
  }) => void;
  executeWorkflowRun: (input: {
    objective: string;
    sessionKey: string;
    message: InboundMessage;
    requestId: string;
    queueWaitMs: number;
    workdir: string;
    deferFailureHandlingToQueue: boolean;
    executor: CodexExecutor;
    releaseRateLimit: () => void;
  }) => Promise<void>;
  executeAutoDevRun: (input: {
    taskId: string | null;
    sessionKey: string;
    message: InboundMessage;
    requestId: string;
    queueWaitMs: number;
    workdir: string;
    deferFailureHandlingToQueue: boolean;
    executor: CodexExecutor;
    releaseRateLimit: () => void;
  }) => Promise<void>;
  executeChatRun: (input: {
    message: InboundMessage;
    receivedAt: number;
    queueWaitMs: number;
    routePrompt: string;
    sessionKey: string;
    requestId: string;
    roomWorkdir: string;
    roomConfigSource: "default" | "room";
    backendProfile: BackendModelRouteProfile;
    backendRouteSource: string;
    backendRouteReason: string;
    backendRouteRuleId: string | null;
    sessionRuntime: CodexSessionRuntime;
    deferFailureHandlingToQueue: boolean;
    releaseRateLimit: () => void;
  }) => Promise<void>;
}

interface ExecuteLockedMessageInput {
  message: InboundMessage;
  requestId: string;
  sessionKey: string;
  receivedAt: number;
  bypassQueue: boolean;
  forcedPrompt: string | null;
  deferFailureHandlingToQueue: boolean;
}

export interface ExecuteLockedMessageResult {
  deferAttachmentCleanup: boolean;
  queueDrainSessionKey: string | null;
}

export async function executeLockedMessage(
  deps: ExecuteLockedMessageDeps,
  input: ExecuteLockedMessageInput,
): Promise<ExecuteLockedMessageResult> {
  const queueWaitMs = Date.now() - input.receivedAt;
  if (deps.hasProcessedEvent(input.sessionKey, input.message.eventId)) {
    deps.recordRequestMetrics("duplicate", queueWaitMs, 0, 0);
    deps.logger.debug("Duplicate event ignored", {
      requestId: input.requestId,
      eventId: input.message.eventId,
      sessionKey: input.sessionKey,
      queueWaitMs,
    });
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  }

  const roomConfig = deps.resolveRoomRuntimeConfig(input.message.conversationId);
  const route: RouteDecisionLike =
    input.forcedPrompt === null
      ? deps.routeMessage(input.message, input.sessionKey, roomConfig)
      : { kind: "execute", prompt: input.forcedPrompt };
  if (route.kind === "ignore") {
    deps.recordRequestMetrics("ignored", queueWaitMs, 0, 0);
    deps.logger.debug("Message ignored by routing policy", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      isDirectMessage: input.message.isDirectMessage,
      mentionsBot: input.message.mentionsBot,
      repliesToBot: input.message.repliesToBot,
    });
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  }

  const routeCommandResult = await handleLockedRouteCommand(
    {
      workflowEnabled: deps.workflowEnabled,
      markEventProcessed: (sessionKey, eventId) => deps.markEventProcessed(sessionKey, eventId),
      sendNotice: (conversationId, text) => deps.sendNotice(conversationId, text),
      handleControlCommand: (command, sessionKey, message, requestId) =>
        deps.handleControlCommand(command, sessionKey, message, requestId),
      handleWorkflowStatusCommand: (sessionKey, message) => deps.handleWorkflowStatusCommand(sessionKey, message),
      handleAutoDevStatusCommand: (sessionKey, message, workdir) =>
        deps.handleAutoDevStatusCommand(sessionKey, message, workdir),
      handleAutoDevProgressCommand: (sessionKey, message, mode) =>
        deps.handleAutoDevProgressCommand(sessionKey, message, mode),
      handleAutoDevSkillsCommand: (sessionKey, message, mode) => deps.handleAutoDevSkillsCommand(sessionKey, message, mode),
      handleAutoDevLoopStopCommand: (sessionKey, message) => deps.handleAutoDevLoopStopCommand(sessionKey, message),
      handleAutoDevReconcileCommand: (sessionKey, message, workdir) =>
        deps.handleAutoDevReconcileCommand(sessionKey, message, workdir),
      handleAutoDevWorkdirCommand: (sessionKey, message, mode, commandPath, roomWorkdir) =>
        deps.handleAutoDevWorkdirCommand(sessionKey, message, mode, commandPath, roomWorkdir),
      handleAutoDevInitCommand: (sessionKey, message, commandPath, from, dryRun, force, roomWorkdir) =>
        deps.handleAutoDevInitCommand(sessionKey, message, commandPath, from, dryRun, force, roomWorkdir),
    },
    {
      route,
      sessionKey: input.sessionKey,
      message: input.message,
      requestId: input.requestId,
      workdir: roomConfig.workdir,
    },
  );
  if (routeCommandResult.handled) {
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  }
  if (route.kind !== "execute") {
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  }

  const queueEnqueueResult = tryEnqueueQueuedInboundRequest(
    {
      getTaskQueueStateStore: deps.getTaskQueueStateStore,
    },
    {
      bypassQueue: input.bypassQueue,
      sessionKey: input.sessionKey,
      message: input.message,
      requestId: input.requestId,
      receivedAt: input.receivedAt,
      routePrompt: route.prompt,
    },
  );
  if (queueEnqueueResult.duplicate) {
    deps.recordRequestMetrics("duplicate", queueWaitMs, 0, 0);
    deps.logger.debug("Duplicate event ignored by task queue dedupe", {
      requestId: input.requestId,
      eventId: input.message.eventId,
      sessionKey: input.sessionKey,
      queueWaitMs,
    });
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  }
  if (queueEnqueueResult.queued) {
    deps.logger.debug("Inbound request queued", {
      requestId: input.requestId,
      eventId: input.message.eventId,
      sessionKey: input.sessionKey,
      taskId: queueEnqueueResult.taskId,
    });
    return { deferAttachmentCleanup: true, queueDrainSessionKey: input.sessionKey };
  }

  const rateDecision = deps.tryAcquireRateLimit({
    userId: input.message.senderId,
    roomId: input.message.conversationId,
  });
  if (!rateDecision.allowed) {
    deps.recordRequestMetrics("rate_limited", queueWaitMs, 0, 0);
    await deps.sendNotice(input.message.conversationId, buildRateLimitNotice(rateDecision));
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    deps.logger.warn("Request rejected by rate limiter", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      reason: rateDecision.reason,
      retryAfterMs: rateDecision.retryAfterMs ?? null,
      queueWaitMs,
    });
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  }

  const { workflowCommand, autoDevCommand } = routeCommandResult;
  const taskType = deps.classifyBackendTaskType(workflowCommand, autoDevCommand);
  const backendDecision = deps.resolveSessionBackendDecision({
    sessionKey: input.sessionKey,
    message: input.message,
    taskType,
    routePrompt: route.prompt,
  });
  const backendRuntime = deps.prepareBackendRuntimeForSession(input.sessionKey, backendDecision.profile);
  deps.setSessionLastBackendDecision(input.sessionKey, backendDecision);
  deps.recordBackendRouteDecision({
    sessionKey: input.sessionKey,
    message: input.message,
    taskType,
    decision: backendDecision,
  });

  if (workflowCommand?.kind === "run") {
    await deps.executeWorkflowRun({
      objective: workflowCommand.objective,
      sessionKey: input.sessionKey,
      message: input.message,
      requestId: input.requestId,
      queueWaitMs,
      workdir: roomConfig.workdir,
      deferFailureHandlingToQueue: input.deferFailureHandlingToQueue,
      executor: backendRuntime.executor,
      releaseRateLimit: () => {
        rateDecision.release?.();
      },
    });
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  }

  if (autoDevCommand?.kind === "run") {
    await deps.executeAutoDevRun({
      taskId: autoDevCommand.taskId,
      sessionKey: input.sessionKey,
      message: input.message,
      requestId: input.requestId,
      queueWaitMs,
      workdir: roomConfig.workdir,
      deferFailureHandlingToQueue: input.deferFailureHandlingToQueue,
      executor: backendRuntime.executor,
      releaseRateLimit: () => {
        rateDecision.release?.();
      },
    });
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  }

  await deps.executeChatRun({
    message: input.message,
    receivedAt: input.receivedAt,
    queueWaitMs,
    routePrompt: route.prompt,
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    roomWorkdir: roomConfig.workdir,
    roomConfigSource: roomConfig.source,
    backendProfile: backendDecision.profile,
    backendRouteSource: backendDecision.source,
    backendRouteReason: backendDecision.reasonCode,
    backendRouteRuleId: backendDecision.ruleId,
    sessionRuntime: backendRuntime.sessionRuntime,
    deferFailureHandlingToQueue: input.deferFailureHandlingToQueue,
    releaseRateLimit: () => {
      rateDecision.release?.();
    },
  });
  return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
}
