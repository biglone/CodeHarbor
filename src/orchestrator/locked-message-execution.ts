import path from "node:path";

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
import { dispatchAutoDevCommandWithRegistry, type AutoDevCommandHandlerRegistry } from "./autodev-command-handler-registry";
import { tryEnqueueQueuedInboundRequest } from "./queue-enqueue";
import { formatError } from "./helpers";
import { formatByteSize } from "./misc-utils";
import { parseFileSendIntent, resolveRequestedFile } from "./file-send-intent";

type RouteDecisionLike =
  | { kind: "ignore" }
  | { kind: "execute"; prompt: string }
  | {
      kind: "command";
      command: "status" | "version" | "backend" | "stop" | "reset" | "diag" | "trace" | "help" | "upgrade";
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
    command: "status" | "version" | "backend" | "stop" | "reset" | "diag" | "trace" | "help" | "upgrade",
    sessionKey: string,
    message: InboundMessage,
    requestId: string,
  ) => Promise<void>;
  handleWorkflowStatusCommand: (sessionKey: string, message: InboundMessage) => Promise<void>;
  handleAutoDevStatusCommand: (sessionKey: string, message: InboundMessage, workdir: string) => Promise<void>;
  handleAutoDevProgressCommand: (sessionKey: string, message: InboundMessage, mode: "status" | "on" | "off") => Promise<void>;
  handleAutoDevContentCommand: (sessionKey: string, message: InboundMessage, mode: "status" | "on" | "off") => Promise<void>;
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
  tryHandleAutoDevSecondaryReviewReceipt: (
    sessionKey: string,
    message: InboundMessage,
    prompt: string,
    workdir: string,
  ) => Promise<boolean>;
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
  sendFile: ((conversationId: string, filePath: string, options?: { fileName?: string; mimeType?: string | null }) => Promise<void>) | null;
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
      handleAutoDevContentCommand: (sessionKey, message, mode) =>
        deps.handleAutoDevContentCommand(sessionKey, message, mode),
      handleAutoDevSkillsCommand: (sessionKey, message, mode) => deps.handleAutoDevSkillsCommand(sessionKey, message, mode),
      handleAutoDevLoopStopCommand: (sessionKey, message) => deps.handleAutoDevLoopStopCommand(sessionKey, message),
      handleAutoDevReconcileCommand: (sessionKey, message, workdir) =>
        deps.handleAutoDevReconcileCommand(sessionKey, message, workdir),
      handleAutoDevWorkdirCommand: (sessionKey, message, mode, commandPath, roomWorkdir) =>
        deps.handleAutoDevWorkdirCommand(sessionKey, message, mode, commandPath, roomWorkdir),
      handleAutoDevInitCommand: (sessionKey, message, commandPath, from, dryRun, force, roomWorkdir) =>
        deps.handleAutoDevInitCommand(sessionKey, message, commandPath, from, dryRun, force, roomWorkdir),
      tryHandleAutoDevSecondaryReviewReceipt: (sessionKey, message, prompt, workdir) =>
        deps.tryHandleAutoDevSecondaryReviewReceipt(sessionKey, message, prompt, workdir),
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

  const fileSendIntent = parseFileSendIntent(route.prompt);
  if (fileSendIntent) {
    return await executeSemanticFileSendRequest(
      deps,
      {
        message: input.message,
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        queueWaitMs,
        workdir: roomConfig.workdir,
        intent: fileSendIntent,
      },
    );
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

  const autoDevExecutionRegistry: AutoDevCommandHandlerRegistry = {
    run: async (command, context) => {
      await deps.executeAutoDevRun({
        taskId: command.taskId,
        sessionKey: context.sessionKey,
        message: context.message,
        requestId: input.requestId,
        queueWaitMs,
        workdir: context.workdir,
        deferFailureHandlingToQueue: input.deferFailureHandlingToQueue,
        executor: backendRuntime.executor,
        releaseRateLimit: () => {
          rateDecision.release?.();
        },
      });
    },
  };
  const autoDevExecutionDispatch = await dispatchAutoDevCommandWithRegistry(autoDevCommand, autoDevExecutionRegistry, {
    sessionKey: input.sessionKey,
    message: input.message,
    workdir: roomConfig.workdir,
  });
  if (autoDevExecutionDispatch.handled) {
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  }

  if (autoDevCommand) {
    deps.logger.warn("AutoDev command dispatch fell through; suppressing chat fallback", {
      requestId: input.requestId,
      eventId: input.message.eventId,
      sessionKey: input.sessionKey,
      commandKind: autoDevCommand.kind,
      routePrompt: route.prompt,
      queueWaitMs,
    });
    await deps.sendNotice(
      input.message.conversationId,
      `[CodeHarbor] AutoDev command routing mismatch (kind=${autoDevCommand.kind}); chat fallback is blocked.
- next: retry with /autodev status or /autodev run`,
    );
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
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

async function executeSemanticFileSendRequest(
  deps: ExecuteLockedMessageDeps,
  input: {
    message: InboundMessage;
    requestId: string;
    sessionKey: string;
    queueWaitMs: number;
    workdir: string;
    intent: FileSendIntentLike;
  },
): Promise<ExecuteLockedMessageResult> {
  const rateDecision = deps.tryAcquireRateLimit({
    userId: input.message.senderId,
    roomId: input.message.conversationId,
  });
  if (!rateDecision.allowed) {
    deps.recordRequestMetrics("rate_limited", input.queueWaitMs, 0, 0);
    await deps.sendNotice(input.message.conversationId, buildRateLimitNotice(rateDecision));
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    deps.logger.warn("File send request rejected by rate limiter", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      reason: rateDecision.reason,
      retryAfterMs: rateDecision.retryAfterMs ?? null,
      queueWaitMs: input.queueWaitMs,
      requestedName: input.intent.requestedName,
    });
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  }

  const executionStartedAt = Date.now();
  let sendDurationMs = 0;
  try {
    if (!deps.sendFile) {
      await deps.sendNotice(
        input.message.conversationId,
        "[CodeHarbor] 已识别“发送文件”请求，但当前通道未启用文件附件发送能力。",
      );
      deps.recordRequestMetrics("failed", input.queueWaitMs, Date.now() - executionStartedAt, 0);
      deps.markEventProcessed(input.sessionKey, input.message.eventId);
      return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
    }

    const resolved = await resolveRequestedFile({
      workdir: input.workdir,
      requestedName: input.intent.requestedName,
    });
    if (resolved.status === "workdir_missing") {
      await deps.sendNotice(
        input.message.conversationId,
        `[CodeHarbor] 当前工作目录不可用，无法发送文件。\n- workdir: ${input.workdir}`,
      );
      deps.recordRequestMetrics("failed", input.queueWaitMs, Date.now() - executionStartedAt, 0);
      deps.markEventProcessed(input.sessionKey, input.message.eventId);
      return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
    }
    if (resolved.status === "not_found" || !resolved.file) {
      const target = resolved.requestedName ?? "（未指定文件名）";
      await deps.sendNotice(
        input.message.conversationId,
        `[CodeHarbor] 未找到可发送的文件。\n- target: ${target}\n- workdir: ${input.workdir}`,
      );
      deps.recordRequestMetrics("failed", input.queueWaitMs, Date.now() - executionStartedAt, 0);
      deps.markEventProcessed(input.sessionKey, input.message.eventId);
      return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
    }
    if (resolved.status === "too_large") {
      await deps.sendNotice(
        input.message.conversationId,
        `[CodeHarbor] 文件过大，已拒绝发送。\n- file: ${resolved.file.relativePath}\n- size: ${formatByteSize(resolved.file.sizeBytes)}\n- limit: ${formatByteSize(resolved.maxBytes)}`,
      );
      deps.recordRequestMetrics("failed", input.queueWaitMs, Date.now() - executionStartedAt, 0);
      deps.markEventProcessed(input.sessionKey, input.message.eventId);
      return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
    }

    const sendStartedAt = Date.now();
    await deps.sendFile(
      input.message.conversationId,
      resolved.file.absolutePath,
      {
        fileName: path.basename(resolved.file.absolutePath),
      },
    );
    sendDurationMs = Date.now() - sendStartedAt;
    await deps.sendNotice(
      input.message.conversationId,
      `[CodeHarbor] 文件已发送。\n- file: ${resolved.file.relativePath}\n- size: ${formatByteSize(resolved.file.sizeBytes)}`,
    );
    deps.recordRequestMetrics("success", input.queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    deps.logger.info("Semantic file send request completed", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      queueWaitMs: input.queueWaitMs,
      sendDurationMs,
      requestedName: input.intent.requestedName,
      resolvedFile: resolved.file.relativePath,
      resolvedSizeBytes: resolved.file.sizeBytes,
      workdir: input.workdir,
    });
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  } catch (error) {
    await deps.sendNotice(
      input.message.conversationId,
      `[CodeHarbor] 文件发送失败: ${formatError(error)}`,
    );
    deps.recordRequestMetrics("failed", input.queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    deps.logger.error("Semantic file send request failed", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      requestedName: input.intent.requestedName,
      workdir: input.workdir,
      error: formatError(error),
    });
    return { deferAttachmentCleanup: false, queueDrainSessionKey: null };
  } finally {
    rateDecision.release?.();
  }
}

interface FileSendIntentLike {
  requestedName: string | null;
}
