import { Mutex } from "async-mutex";
import fs from "node:fs/promises";

import { MatrixChannel } from "./channels/matrix-channel";
import { CliCompatRecorder } from "./compat/cli-compat-recorder";
import { ConfigService } from "./config-service";
import { CliCompatConfig, TriggerPolicy, type RoomTriggerPolicyOverrides } from "./config";
import {
  CodexExecutionCancelledError,
  CodexExecutor,
  type CodexExecutionHandle,
  type CodexProgressEvent,
} from "./executor/codex-executor";
import { CodexSessionRuntime } from "./executor/codex-session-runtime";
import { Logger } from "./logger";
import { RateLimiter, type RateLimitDecision, type RateLimiterOptions } from "./rate-limiter";
import { StateStore } from "./store/state-store";
import { InboundMessage } from "./types";
import { extractCommandText } from "./utils/message";

interface OrchestratorOptions {
  lockTtlMs?: number;
  lockPruneIntervalMs?: number;
  progressUpdatesEnabled?: boolean;
  progressMinIntervalMs?: number;
  typingTimeoutMs?: number;
  commandPrefix?: string;
  matrixUserId?: string;
  sessionActiveWindowMinutes?: number;
  defaultGroupTriggerPolicy?: TriggerPolicy;
  roomTriggerPolicies?: RoomTriggerPolicyOverrides;
  rateLimiterOptions?: RateLimiterOptions;
  cliCompat?: CliCompatConfig;
  configService?: ConfigService;
  defaultCodexWorkdir?: string;
}

interface SessionLockEntry {
  mutex: Mutex;
  lastUsedAt: number;
}

type RouteDecision =
  | { kind: "ignore" }
  | { kind: "execute"; prompt: string }
  | { kind: "command"; command: "status" | "stop" | "reset" };

type RequestOutcome =
  | "success"
  | "failed"
  | "timeout"
  | "cancelled"
  | "rate_limited"
  | "ignored"
  | "duplicate";

interface RunningExecution {
  requestId: string;
  startedAt: number;
  cancel: () => void;
}

interface SendProgressContext {
  conversationId: string;
  isDirectMessage: boolean;
  getProgressNoticeEventId: () => string | null;
  setProgressNoticeEventId: (next: string) => void;
}

interface RoomRuntimeConfig {
  source: "default" | "room";
  enabled: boolean;
  triggerPolicy: TriggerPolicy;
  workdir: string;
}

class RequestMetrics {
  private total = 0;
  private success = 0;
  private failed = 0;
  private timeout = 0;
  private cancelled = 0;
  private rateLimited = 0;
  private ignored = 0;
  private duplicate = 0;
  private totalQueueMs = 0;
  private totalExecMs = 0;
  private totalSendMs = 0;

  record(outcome: RequestOutcome, queueMs: number, execMs: number, sendMs: number): void {
    this.total += 1;
    this.totalQueueMs += Math.max(0, queueMs);
    this.totalExecMs += Math.max(0, execMs);
    this.totalSendMs += Math.max(0, sendMs);

    if (outcome === "success") {
      this.success += 1;
      return;
    }
    if (outcome === "failed") {
      this.failed += 1;
      return;
    }
    if (outcome === "timeout") {
      this.timeout += 1;
      return;
    }
    if (outcome === "cancelled") {
      this.cancelled += 1;
      return;
    }
    if (outcome === "rate_limited") {
      this.rateLimited += 1;
      return;
    }
    if (outcome === "ignored") {
      this.ignored += 1;
      return;
    }
    this.duplicate += 1;
  }

  snapshot(activeExecutions: number): {
    total: number;
    success: number;
    failed: number;
    timeout: number;
    cancelled: number;
    rateLimited: number;
    ignored: number;
    duplicate: number;
    activeExecutions: number;
    avgQueueMs: number;
    avgExecMs: number;
    avgSendMs: number;
  } {
    const divisor = this.total > 0 ? this.total : 1;
    return {
      total: this.total,
      success: this.success,
      failed: this.failed,
      timeout: this.timeout,
      cancelled: this.cancelled,
      rateLimited: this.rateLimited,
      ignored: this.ignored,
      duplicate: this.duplicate,
      activeExecutions,
      avgQueueMs: Math.round(this.totalQueueMs / divisor),
      avgExecMs: Math.round(this.totalExecMs / divisor),
      avgSendMs: Math.round(this.totalSendMs / divisor),
    };
  }
}

export class Orchestrator {
  private readonly channel: MatrixChannel;
  private readonly executor: CodexExecutor;
  private readonly sessionRuntime: CodexSessionRuntime;
  private readonly stateStore: StateStore;
  private readonly logger: Logger;
  private readonly sessionLocks = new Map<string, SessionLockEntry>();
  private readonly runningExecutions = new Map<string, RunningExecution>();
  private readonly lockTtlMs: number;
  private readonly lockPruneIntervalMs: number;
  private readonly progressUpdatesEnabled: boolean;
  private readonly progressMinIntervalMs: number;
  private readonly typingTimeoutMs: number;
  private readonly commandPrefix: string;
  private readonly matrixUserId: string;
  private readonly sessionActiveWindowMs: number;
  private readonly defaultGroupTriggerPolicy: TriggerPolicy;
  private readonly roomTriggerPolicies: RoomTriggerPolicyOverrides;
  private readonly configService: ConfigService | null;
  private readonly defaultCodexWorkdir: string;
  private readonly rateLimiter: RateLimiter;
  private readonly cliCompat: CliCompatConfig;
  private readonly cliCompatRecorder: CliCompatRecorder | null;
  private readonly metrics = new RequestMetrics();
  private lastLockPruneAt = 0;

  constructor(
    channel: MatrixChannel,
    executor: CodexExecutor,
    stateStore: StateStore,
    logger: Logger,
    options?: OrchestratorOptions,
  ) {
    this.channel = channel;
    this.executor = executor;
    this.stateStore = stateStore;
    this.logger = logger;
    this.lockTtlMs = options?.lockTtlMs ?? 30 * 60 * 1000;
    this.lockPruneIntervalMs = options?.lockPruneIntervalMs ?? 5 * 60 * 1000;
    this.progressUpdatesEnabled = options?.progressUpdatesEnabled ?? false;
    this.cliCompat = options?.cliCompat ?? {
      enabled: false,
      passThroughEvents: false,
      preserveWhitespace: false,
      disableReplyChunkSplit: false,
      progressThrottleMs: 300,
      fetchMedia: false,
      recordPath: null,
    };
    this.cliCompatRecorder = this.cliCompat.recordPath ? new CliCompatRecorder(this.cliCompat.recordPath) : null;
    const defaultProgressInterval = options?.progressMinIntervalMs ?? 2_500;
    this.progressMinIntervalMs = this.cliCompat.enabled ? this.cliCompat.progressThrottleMs : defaultProgressInterval;
    this.typingTimeoutMs = options?.typingTimeoutMs ?? 10_000;
    this.commandPrefix = (options?.commandPrefix ?? "").trim();
    this.matrixUserId = options?.matrixUserId ?? "";
    const sessionActiveWindowMinutes = options?.sessionActiveWindowMinutes ?? 20;
    this.sessionActiveWindowMs = Math.max(1, sessionActiveWindowMinutes) * 60_000;
    this.defaultGroupTriggerPolicy = options?.defaultGroupTriggerPolicy ?? {
      allowMention: true,
      allowReply: true,
      allowActiveWindow: true,
      allowPrefix: true,
    };
    this.roomTriggerPolicies = options?.roomTriggerPolicies ?? {};
    this.configService = options?.configService ?? null;
    this.defaultCodexWorkdir = options?.defaultCodexWorkdir ?? process.cwd();
    this.rateLimiter = new RateLimiter(
      options?.rateLimiterOptions ?? {
        windowMs: 60_000,
        maxRequestsPerUser: 20,
        maxRequestsPerRoom: 120,
        maxConcurrentGlobal: 8,
        maxConcurrentPerUser: 1,
        maxConcurrentPerRoom: 4,
      },
    );
    this.sessionRuntime = new CodexSessionRuntime(this.executor);
  }

  async handleMessage(message: InboundMessage): Promise<void> {
    const receivedAt = Date.now();
    const requestId = message.requestId || message.eventId;
    const sessionKey = buildSessionKey(message);

    const directCommand = parseControlCommand(message.text.trim());
    if (directCommand === "stop") {
      if (this.stateStore.hasProcessedEvent(sessionKey, message.eventId)) {
        this.metrics.record("duplicate", 0, 0, 0);
        this.logger.debug("Duplicate stop command ignored", { requestId, eventId: message.eventId, sessionKey });
        return;
      }
      await this.handleStopCommand(sessionKey, message, requestId);
      this.stateStore.markEventProcessed(sessionKey, message.eventId);
      return;
    }

    const lock = this.getLock(sessionKey);
    await lock.runExclusive(async () => {
      const queueWaitMs = Date.now() - receivedAt;

      if (this.stateStore.hasProcessedEvent(sessionKey, message.eventId)) {
        this.metrics.record("duplicate", queueWaitMs, 0, 0);
        this.logger.debug("Duplicate event ignored", { requestId, eventId: message.eventId, sessionKey, queueWaitMs });
        return;
      }

      const roomConfig = this.resolveRoomRuntimeConfig(message.conversationId);
      const route = this.routeMessage(message, sessionKey, roomConfig);
      if (route.kind === "ignore") {
        this.metrics.record("ignored", queueWaitMs, 0, 0);
        this.logger.debug("Message ignored by routing policy", {
          requestId,
          sessionKey,
          isDirectMessage: message.isDirectMessage,
          mentionsBot: message.mentionsBot,
          repliesToBot: message.repliesToBot,
        });
        return;
      }

      if (route.kind === "command") {
        await this.handleControlCommand(route.command, sessionKey, message, requestId);
        this.stateStore.markEventProcessed(sessionKey, message.eventId);
        return;
      }

      const rateDecision = this.rateLimiter.tryAcquire({
        userId: message.senderId,
        roomId: message.conversationId,
      });
      if (!rateDecision.allowed) {
        this.metrics.record("rate_limited", queueWaitMs, 0, 0);
        await this.channel.sendNotice(message.conversationId, buildRateLimitNotice(rateDecision));
        this.stateStore.markEventProcessed(sessionKey, message.eventId);
        this.logger.warn("Request rejected by rate limiter", {
          requestId,
          sessionKey,
          reason: rateDecision.reason,
          retryAfterMs: rateDecision.retryAfterMs ?? null,
          queueWaitMs,
        });
        return;
      }

      this.stateStore.activateSession(sessionKey, this.sessionActiveWindowMs);
      const previousCodexSessionId = this.stateStore.getCodexSessionId(sessionKey);
      const executionPrompt = this.buildExecutionPrompt(route.prompt, message);
      const imagePaths = collectImagePaths(message);
      let lastProgressAt = 0;
      let lastProgressText = "";
      let progressNoticeEventId: string | null = null;
      let progressChain: Promise<void> = Promise.resolve();
      let executionHandle: CodexExecutionHandle | null = null;
      let executionDurationMs = 0;
      let sendDurationMs = 0;
      const requestStartedAt = Date.now();
      let cancelRequested = false;

      this.runningExecutions.set(sessionKey, {
        requestId,
        startedAt: requestStartedAt,
        cancel: () => {
          cancelRequested = true;
          executionHandle?.cancel();
        },
      });

      await this.recordCliCompatPrompt({
        requestId,
        sessionKey,
        conversationId: message.conversationId,
        senderId: message.senderId,
        prompt: executionPrompt,
        imageCount: imagePaths.length,
      });
      this.logger.info("Processing message", {
        requestId,
        sessionKey,
        hasCodexSession: Boolean(previousCodexSessionId),
        queueWaitMs,
        attachmentCount: message.attachments.length,
        workdir: roomConfig.workdir,
        roomConfigSource: roomConfig.source,
        isDirectMessage: message.isDirectMessage,
        mentionsBot: message.mentionsBot,
        repliesToBot: message.repliesToBot,
      });

      const stopTyping = this.startTypingHeartbeat(message.conversationId);

      try {
        const executionStartedAt = Date.now();
        executionHandle = this.sessionRuntime.startExecution(
          sessionKey,
          executionPrompt,
          previousCodexSessionId,
          (progress) => {
            progressChain = progressChain
              .then(() =>
                this.handleProgress(
                  message.conversationId,
                  message.isDirectMessage,
                  progress,
                  () => lastProgressAt,
                  (next) => {
                    lastProgressAt = next;
                  },
                  () => lastProgressText,
                  (next) => {
                    lastProgressText = next;
                  },
                  () => progressNoticeEventId,
                  (next) => {
                    progressNoticeEventId = next;
                  },
                ),
              )
              .catch((progressError) => {
                this.logger.debug("Failed to process progress callback", { progressError });
              });
          },
          {
            passThroughRawEvents: this.cliCompat.enabled && this.cliCompat.passThroughEvents,
            imagePaths,
            workdir: roomConfig.workdir,
          },
        );
        const running = this.runningExecutions.get(sessionKey);
        if (running?.requestId === requestId) {
          running.startedAt = executionStartedAt;
          running.cancel = () => {
            cancelRequested = true;
            executionHandle?.cancel();
          };
        }
        if (cancelRequested) {
          executionHandle.cancel();
        }

        const result = await executionHandle.result;
        executionDurationMs = Date.now() - executionStartedAt;
        await progressChain;

        const sendStartedAt = Date.now();
        await this.channel.sendMessage(message.conversationId, result.reply);
        await this.finishProgress(
          {
            conversationId: message.conversationId,
            isDirectMessage: message.isDirectMessage,
            getProgressNoticeEventId: () => progressNoticeEventId,
            setProgressNoticeEventId: (next) => {
              progressNoticeEventId = next;
            },
          },
          `处理完成（耗时 ${formatDurationMs(Date.now() - requestStartedAt)}）`,
        );
        sendDurationMs = Date.now() - sendStartedAt;

        this.stateStore.commitExecutionSuccess(sessionKey, message.eventId, result.sessionId);
        this.metrics.record("success", queueWaitMs, executionDurationMs, sendDurationMs);
        this.logger.info("Request completed", {
          requestId,
          sessionKey,
          status: "success",
          queueWaitMs,
          executionDurationMs,
          sendDurationMs,
          totalDurationMs: Date.now() - receivedAt,
        });
      } catch (error) {
        const status = classifyExecutionOutcome(error);
        executionDurationMs = Date.now() - requestStartedAt;
        await progressChain;

        await this.finishProgress(
          {
            conversationId: message.conversationId,
            isDirectMessage: message.isDirectMessage,
            getProgressNoticeEventId: () => progressNoticeEventId,
            setProgressNoticeEventId: (next) => {
              progressNoticeEventId = next;
            },
          },
          buildFailureProgressSummary(status, requestStartedAt, error),
        );

        if (status !== "cancelled") {
          try {
            await this.channel.sendMessage(
              message.conversationId,
              `[CodeHarbor] Failed to process request: ${formatError(error)}`,
            );
          } catch (sendError) {
            this.logger.error("Failed to send error reply to Matrix", sendError);
          }
        }

        this.stateStore.commitExecutionHandled(sessionKey, message.eventId);
        this.metrics.record(status, queueWaitMs, executionDurationMs, sendDurationMs);
        this.logger.error("Request failed", {
          requestId,
          sessionKey,
          status,
          queueWaitMs,
          executionDurationMs,
          totalDurationMs: Date.now() - receivedAt,
          error: formatError(error),
        });
      } finally {
        const running = this.runningExecutions.get(sessionKey);
        if (running?.requestId === requestId) {
          this.runningExecutions.delete(sessionKey);
        }
        rateDecision.release?.();
        await stopTyping();
        await cleanupAttachmentFiles(imagePaths);
      }
    });
  }

  private routeMessage(message: InboundMessage, sessionKey: string, roomConfig: RoomRuntimeConfig): RouteDecision {
    const incomingRaw = message.text;
    const incomingTrimmed = incomingRaw.trim();
    if (!incomingTrimmed && message.attachments.length === 0) {
      return { kind: "ignore" };
    }

    if (!message.isDirectMessage && !roomConfig.enabled) {
      return { kind: "ignore" };
    }

    const groupPolicy = message.isDirectMessage ? null : roomConfig.triggerPolicy;
    const prefixAllowed = message.isDirectMessage || Boolean(groupPolicy?.allowPrefix);
    const prefixTriggered = prefixAllowed && this.commandPrefix.length > 0;
    const prefixedText = prefixTriggered ? extractCommandText(incomingTrimmed, this.commandPrefix) : null;

    const activeSession =
      message.isDirectMessage || groupPolicy?.allowActiveWindow
        ? this.stateStore.isSessionActive(sessionKey)
        : false;

    const conversationalTrigger =
      message.isDirectMessage ||
      (Boolean(groupPolicy?.allowMention) && message.mentionsBot) ||
      (Boolean(groupPolicy?.allowReply) && message.repliesToBot) ||
      activeSession;

    if (!conversationalTrigger && prefixedText === null) {
      return { kind: "ignore" };
    }

    let normalized = prefixedText ?? (this.cliCompat.preserveWhitespace ? incomingRaw : incomingTrimmed);
    if (prefixedText === null && message.mentionsBot && !this.cliCompat.enabled) {
      normalized = stripLeadingBotMention(normalized, this.matrixUserId);
    }
    const normalizedTrimmed = normalized.trim();
    if (!normalizedTrimmed && message.attachments.length === 0) {
      return { kind: "ignore" };
    }

    const command = parseControlCommand(normalizedTrimmed);
    if (command) {
      return { kind: "command", command };
    }

    if (!this.cliCompat.preserveWhitespace || prefixedText !== null) {
      normalized = normalizedTrimmed;
    }

    return { kind: "execute", prompt: normalized };
  }

  private async handleControlCommand(
    command: "status" | "stop" | "reset",
    sessionKey: string,
    message: InboundMessage,
    requestId: string,
  ): Promise<void> {
    if (command === "stop") {
      await this.handleStopCommand(sessionKey, message, requestId);
      return;
    }

    if (command === "reset") {
      this.stateStore.clearCodexSessionId(sessionKey);
      this.stateStore.activateSession(sessionKey, this.sessionActiveWindowMs);
      this.sessionRuntime.clearSession(sessionKey);
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 上下文已重置。你可以继续直接发送新需求。",
      );
      return;
    }

    const status = this.stateStore.getSessionStatus(sessionKey);
    const roomConfig = this.resolveRoomRuntimeConfig(message.conversationId);
    const scope = message.isDirectMessage ? "私聊（免前缀）" : "群聊（按房间触发策略）";
    const activeUntil = status.activeUntil ?? "未激活";
    const metrics = this.metrics.snapshot(this.runningExecutions.size);
    const limiter = this.rateLimiter.snapshot();
    const runtime = this.sessionRuntime.getRuntimeStats();

    await this.channel.sendNotice(
      message.conversationId,
      `[CodeHarbor] 当前状态
- 会话类型: ${scope}
- 激活中: ${status.isActive ? "是" : "否"}
- activeUntil: ${activeUntil}
- 已绑定 Codex 会话: ${status.hasCodexSession ? "是" : "否"}
- 当前工作目录: ${roomConfig.workdir}
- 运行中任务: ${metrics.activeExecutions}
- 指标: total=${metrics.total}, success=${metrics.success}, failed=${metrics.failed}, timeout=${metrics.timeout}, cancelled=${metrics.cancelled}, rate_limited=${metrics.rateLimited}
- 平均耗时: queue=${metrics.avgQueueMs}ms, exec=${metrics.avgExecMs}ms, send=${metrics.avgSendMs}ms
- 限流并发: global=${limiter.activeGlobal}, users=${limiter.activeUsers}, rooms=${limiter.activeRooms}
- CLI runtime: workers=${runtime.workerCount}, running=${runtime.runningCount}, compat_mode=${
        this.cliCompat.enabled ? "on" : "off"
      }`,
    );
  }

  private async handleStopCommand(sessionKey: string, message: InboundMessage, requestId: string): Promise<void> {
    this.stateStore.deactivateSession(sessionKey);
    this.stateStore.clearCodexSessionId(sessionKey);
    this.sessionRuntime.clearSession(sessionKey);

    const running = this.runningExecutions.get(sessionKey);
    if (running) {
      this.sessionRuntime.cancelRunningExecution(sessionKey);
      running.cancel();
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 已请求停止当前任务，并已清理会话上下文。",
      );
      this.logger.info("Stop command cancelled running execution", {
        requestId,
        sessionKey,
        targetRequestId: running.requestId,
        runningForMs: Date.now() - running.startedAt,
      });
      return;
    }

    await this.channel.sendNotice(
      message.conversationId,
      "[CodeHarbor] 会话已停止。后续在群聊中请提及/回复我，或在私聊直接发送消息。",
    );
  }

  private startTypingHeartbeat(conversationId: string): () => Promise<void> {
    let stopped = false;
    const refreshIntervalMs = Math.max(1_000, Math.floor(this.typingTimeoutMs / 2));

    const sendTyping = async (isTyping: boolean): Promise<void> => {
      try {
        await this.channel.setTyping(conversationId, isTyping, isTyping ? this.typingTimeoutMs : 0);
      } catch (error) {
        this.logger.debug("Failed to update typing state", { conversationId, isTyping, error });
      }
    };

    void sendTyping(true);
    const timer = setInterval(() => {
      if (stopped) {
        return;
      }
      void sendTyping(true);
    }, refreshIntervalMs);
    timer.unref?.();

    return async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      await sendTyping(false);
    };
  }

  private async handleProgress(
    conversationId: string,
    isDirectMessage: boolean,
    progress: CodexProgressEvent,
    getLastProgressAt: () => number,
    setLastProgressAt: (next: number) => void,
    getLastProgressText: () => string,
    setLastProgressText: (next: string) => void,
    getProgressNoticeEventId: () => string | null,
    setProgressNoticeEventId: (next: string) => void,
  ): Promise<void> {
    if (!this.progressUpdatesEnabled) {
      return;
    }

    const progressText = mapProgressText(progress, this.cliCompat.enabled);
    if (!progressText) {
      return;
    }

    const now = Date.now();
    if (now - getLastProgressAt() < this.progressMinIntervalMs && progress.stage !== "turn_started") {
      return;
    }
    if (progressText === getLastProgressText()) {
      return;
    }

    setLastProgressAt(now);
    setLastProgressText(progressText);

    await this.sendProgressUpdate(
      {
        conversationId,
        isDirectMessage,
        getProgressNoticeEventId,
        setProgressNoticeEventId,
      },
      `[CodeHarbor] ${progressText}`,
    );
  }

  private async finishProgress(ctx: SendProgressContext, summary: string): Promise<void> {
    if (!this.progressUpdatesEnabled) {
      return;
    }
    await this.sendProgressUpdate(ctx, `[CodeHarbor] ${summary}`);
  }

  private async sendProgressUpdate(ctx: SendProgressContext, text: string): Promise<void> {
    try {
      if (ctx.isDirectMessage) {
        await this.channel.sendNotice(ctx.conversationId, text);
        return;
      }

      const eventId = await this.channel.upsertProgressNotice(
        ctx.conversationId,
        text,
        ctx.getProgressNoticeEventId(),
      );
      ctx.setProgressNoticeEventId(eventId);
    } catch (error) {
      this.logger.debug("Failed to send progress update", {
        conversationId: ctx.conversationId,
        text,
        error,
      });
    }
  }

  private resolveGroupPolicy(conversationId: string): TriggerPolicy {
    const override = this.roomTriggerPolicies[conversationId] ?? {};
    return {
      allowMention: override.allowMention ?? this.defaultGroupTriggerPolicy.allowMention,
      allowReply: override.allowReply ?? this.defaultGroupTriggerPolicy.allowReply,
      allowActiveWindow: override.allowActiveWindow ?? this.defaultGroupTriggerPolicy.allowActiveWindow,
      allowPrefix: override.allowPrefix ?? this.defaultGroupTriggerPolicy.allowPrefix,
    };
  }

  private resolveRoomRuntimeConfig(conversationId: string): RoomRuntimeConfig {
    const fallbackPolicy = this.resolveGroupPolicy(conversationId);
    if (!this.configService) {
      return {
        source: "default",
        enabled: true,
        triggerPolicy: fallbackPolicy,
        workdir: this.defaultCodexWorkdir,
      };
    }

    return this.configService.resolveRoomConfig(conversationId, fallbackPolicy);
  }

  private buildExecutionPrompt(prompt: string, message: InboundMessage): string {
    if (message.attachments.length === 0) {
      return prompt;
    }

    const attachmentSummary = message.attachments
      .map((attachment) => {
        const size = attachment.sizeBytes === null ? "unknown" : `${attachment.sizeBytes}`;
        const mime = attachment.mimeType ?? "unknown";
        const source = attachment.mxcUrl ?? "none";
        const local = attachment.localPath ?? "none";
        return `- kind=${attachment.kind} name=${attachment.name} mime=${mime} size=${size} source=${source} local=${local}`;
      })
      .join("\n");

    const promptBody = prompt.trim() ? prompt : "(no text body)";
    return `${promptBody}\n\n[attachments]\n${attachmentSummary}\n[/attachments]`;
  }

  private async recordCliCompatPrompt(entry: {
    requestId: string;
    sessionKey: string;
    conversationId: string;
    senderId: string;
    prompt: string;
    imageCount: number;
  }): Promise<void> {
    if (!this.cliCompatRecorder) {
      return;
    }
    try {
      await this.cliCompatRecorder.append({
        timestamp: new Date().toISOString(),
        requestId: entry.requestId,
        sessionKey: entry.sessionKey,
        conversationId: entry.conversationId,
        senderId: entry.senderId,
        prompt: entry.prompt,
        imageCount: entry.imageCount,
      });
    } catch (error) {
      this.logger.warn("Failed to record cli compat prompt", {
        requestId: entry.requestId,
        error,
      });
    }
  }

  private getLock(key: string): Mutex {
    const now = Date.now();
    if (now - this.lastLockPruneAt >= this.lockPruneIntervalMs) {
      this.lastLockPruneAt = now;
      this.pruneSessionLocks(now);
    }

    let entry = this.sessionLocks.get(key);
    if (!entry) {
      entry = {
        mutex: new Mutex(),
        lastUsedAt: now,
      };
      this.sessionLocks.set(key, entry);
    }
    entry.lastUsedAt = now;
    return entry.mutex;
  }

  private pruneSessionLocks(now: number): void {
    const expireBefore = now - this.lockTtlMs;
    for (const [sessionKey, entry] of this.sessionLocks.entries()) {
      if (entry.lastUsedAt >= expireBefore) {
        continue;
      }
      if (entry.mutex.isLocked()) {
        continue;
      }
      this.sessionLocks.delete(sessionKey);
    }
  }
}

export function buildSessionKey(message: InboundMessage): string {
  return `${message.channel}:${message.conversationId}:${message.senderId}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function collectImagePaths(message: InboundMessage): string[] {
  const seen = new Set<string>();
  for (const attachment of message.attachments) {
    if (attachment.kind !== "image" || !attachment.localPath) {
      continue;
    }
    seen.add(attachment.localPath);
  }
  return [...seen];
}

async function cleanupAttachmentFiles(imagePaths: string[]): Promise<void> {
  await Promise.all(
    imagePaths.map(async (imagePath) => {
      try {
        await fs.unlink(imagePath);
      } catch {
        // Ignore cleanup failure: temp files are best-effort.
      }
    }),
  );
}

function mapProgressText(progress: CodexProgressEvent, cliCompatMode: boolean): string | null {
  if (progress.stage === "turn_started") {
    return "开始处理请求，正在思考...";
  }
  if (progress.stage === "reasoning" && progress.message) {
    const normalized = progress.message.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return null;
    }
    const maxLen = 180;
    return normalized.length > maxLen ? `思考中: ${normalized.slice(0, maxLen)}...` : `思考中: ${normalized}`;
  }
  if (progress.stage === "item_completed" && progress.message) {
    return `阶段完成: ${progress.message}`;
  }
  if (cliCompatMode && progress.stage === "stderr" && progress.message) {
    const text = progress.message.length > 220 ? `${progress.message.slice(0, 220)}...` : progress.message;
    return `stderr: ${text}`;
  }
  if (cliCompatMode && progress.stage === "raw_event") {
    if (!progress.message) {
      return null;
    }
    return `事件: ${progress.message}`;
  }
  return null;
}

function parseControlCommand(text: string): "status" | "stop" | "reset" | null {
  const command = text.split(/\s+/, 1)[0].toLowerCase();
  if (command === "/status") {
    return "status";
  }
  if (command === "/stop") {
    return "stop";
  }
  if (command === "/reset") {
    return "reset";
  }
  return null;
}

function stripLeadingBotMention(text: string, matrixUserId: string): string {
  if (!matrixUserId) {
    return text;
  }
  const escapedUserId = escapeRegex(matrixUserId);
  const mentionPattern = new RegExp(`^\\s*(?:<)?${escapedUserId}(?:>)?[\\s,:，：-]*`, "i");
  return text.replace(mentionPattern, "").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = ((durationMs % 60_000) / 1_000).toFixed(1);
  return `${minutes}m${seconds}s`;
}

function buildRateLimitNotice(decision: RateLimitDecision): string {
  if (decision.reason === "user_requests_per_window" || decision.reason === "room_requests_per_window") {
    const retrySec = Math.max(1, Math.ceil((decision.retryAfterMs ?? 1_000) / 1_000));
    return `[CodeHarbor] 请求过于频繁，请在 ${retrySec} 秒后重试。`;
  }
  return "[CodeHarbor] 当前任务并发较高，请稍后再试。";
}

function classifyExecutionOutcome(error: unknown): Extract<RequestOutcome, "failed" | "timeout" | "cancelled"> {
  if (error instanceof CodexExecutionCancelledError) {
    return "cancelled";
  }
  const message = formatError(error).toLowerCase();
  if (message.includes("timed out")) {
    return "timeout";
  }
  return "failed";
}

function buildFailureProgressSummary(
  status: Extract<RequestOutcome, "failed" | "timeout" | "cancelled">,
  startedAt: number,
  error: unknown,
): string {
  const elapsed = formatDurationMs(Date.now() - startedAt);
  if (status === "cancelled") {
    return `处理已取消（耗时 ${elapsed}）`;
  }
  if (status === "timeout") {
    return `处理超时（耗时 ${elapsed}）: ${formatError(error)}`;
  }
  return `处理失败（耗时 ${elapsed}）: ${formatError(error)}`;
}
