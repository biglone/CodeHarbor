import { Mutex } from "async-mutex";
import { execFile, type ExecFileException } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AudioTranscriber, type AudioTranscriberLike, type AudioTranscript } from "./audio-transcriber";
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
import {
  formatPackageUpdateHint,
  NpmRegistryUpdateChecker,
  type PackageUpdateChecker,
  resolvePackageVersion,
} from "./package-update-checker";
import { RateLimiter, type RateLimitDecision, type RateLimiterOptions } from "./rate-limiter";
import { StateStore, type UpgradeRunRecord } from "./store/state-store";
import { InboundMessage } from "./types";
import { extractCommandText } from "./utils/message";
import {
  createIdleWorkflowSnapshot,
  MultiAgentWorkflowRunner,
  parseWorkflowCommand,
  type MultiAgentWorkflowRunResult,
  type WorkflowRunSnapshot,
} from "./workflow/multi-agent-workflow";
import {
  buildAutoDevObjective,
  formatTaskForDisplay,
  loadAutoDevContext,
  parseAutoDevCommand,
  selectAutoDevTask,
  statusToSymbol,
  summarizeAutoDevTasks,
  updateAutoDevTaskStatus,
} from "./workflow/autodev";

interface OrchestratorOptions {
  lockTtlMs?: number;
  lockPruneIntervalMs?: number;
  progressUpdatesEnabled?: boolean;
  progressMinIntervalMs?: number;
  typingTimeoutMs?: number;
  commandPrefix?: string;
  matrixUserId?: string;
  sessionActiveWindowMinutes?: number;
  groupDirectModeEnabled?: boolean;
  defaultGroupTriggerPolicy?: TriggerPolicy;
  roomTriggerPolicies?: RoomTriggerPolicyOverrides;
  rateLimiterOptions?: RateLimiterOptions;
  cliCompat?: CliCompatConfig;
  multiAgentWorkflow?: {
    enabled: boolean;
    autoRepairMaxRounds: number;
  };
  packageUpdateChecker?: PackageUpdateChecker;
  updateCheckTtlMs?: number;
  audioTranscriber?: AudioTranscriberLike;
  configService?: ConfigService;
  defaultCodexWorkdir?: string;
  aiCliProvider?: "codex" | "claude";
  aiCliModel?: string | null;
  executorFactory?: (provider: "codex" | "claude") => CodexExecutor;
  upgradeAllowedUsers?: string[];
  selfUpdateTimeoutMs?: number;
  selfUpdateRunner?: SelfUpdateRunner;
  upgradeRestartPlanner?: UpgradeRestartPlanner;
}

interface SessionLockEntry {
  mutex: Mutex;
  lastUsedAt: number;
}

type RouteDecision =
  | { kind: "ignore" }
  | { kind: "execute"; prompt: string }
  | {
      kind: "command";
      command: "status" | "version" | "backend" | "stop" | "reset" | "diag" | "help" | "upgrade";
    };

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

interface AutoDevRunSnapshot {
  state: "idle" | "running" | "succeeded" | "failed";
  startedAt: string | null;
  endedAt: string | null;
  taskId: string | null;
  taskDescription: string | null;
  approved: boolean | null;
  repairRounds: number;
  error: string | null;
}

interface SelfUpdateResult {
  installedVersion: string | null;
  stdout: string;
  stderr: string;
}

type SelfUpdateRunner = (input: { version: string | null }) => Promise<SelfUpdateResult>;
interface UpgradeRestartPlan {
  summary: string;
  apply: () => Promise<void>;
}
type UpgradeRestartPlanner = () => Promise<UpgradeRestartPlan>;
type UpgradeStateStore = Pick<
  StateStore,
  "createUpgradeRun" | "finishUpgradeRun" | "getLatestUpgradeRun" | "listRecentUpgradeRuns"
>;

const RUN_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
const RUN_SNAPSHOT_MAX_ENTRIES = 500;
const CONTEXT_BRIDGE_HISTORY_LIMIT = 16;
const CONTEXT_BRIDGE_MAX_CHARS = 8_000;
const DEFAULT_SELF_UPDATE_TIMEOUT_MS = 20 * 60 * 1_000;

const execFileAsync = promisify(execFile);

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
  private executor: CodexExecutor;
  private sessionRuntime: CodexSessionRuntime;
  private readonly executorFactory: ((provider: "codex" | "claude") => CodexExecutor) | null;
  private readonly stateStore: StateStore;
  private readonly logger: Logger;
  private readonly sessionLocks = new Map<string, SessionLockEntry>();
  private readonly runningExecutions = new Map<string, RunningExecution>();
  private readonly pendingStopRequests = new Set<string>();
  private readonly skipBridgeForNextPrompt = new Set<string>();
  private readonly lockTtlMs: number;
  private readonly lockPruneIntervalMs: number;
  private readonly progressUpdatesEnabled: boolean;
  private readonly progressMinIntervalMs: number;
  private readonly typingTimeoutMs: number;
  private readonly commandPrefix: string;
  private readonly matrixUserId: string;
  private readonly sessionActiveWindowMs: number;
  private readonly groupDirectModeEnabled: boolean;
  private readonly defaultGroupTriggerPolicy: TriggerPolicy;
  private readonly roomTriggerPolicies: RoomTriggerPolicyOverrides;
  private readonly configService: ConfigService | null;
  private readonly defaultCodexWorkdir: string;
  private readonly rateLimiter: RateLimiter;
  private readonly cliCompat: CliCompatConfig;
  private readonly cliCompatRecorder: CliCompatRecorder | null;
  private readonly audioTranscriber: AudioTranscriberLike;
  private readonly workflowRunner: MultiAgentWorkflowRunner;
  private readonly packageUpdateChecker: PackageUpdateChecker;
  private readonly updateCheckTtlMs: number;
  private aiCliProvider: "codex" | "claude";
  private readonly aiCliModel: string | null;
  private readonly botNoticePrefix: string;
  private readonly processStartedAtIso: string;
  private readonly workflowSnapshots = new Map<string, WorkflowRunSnapshot>();
  private readonly autoDevSnapshots = new Map<string, AutoDevRunSnapshot>();
  private readonly upgradeAllowedUsers: Set<string>;
  private readonly selfUpdateRunner: SelfUpdateRunner;
  private readonly upgradeRestartPlanner: UpgradeRestartPlanner;
  private readonly upgradeMutex = new Mutex();
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
      transcribeAudio: false,
      audioTranscribeModel: "gpt-4o-mini-transcribe",
      audioTranscribeTimeoutMs: 120_000,
      audioTranscribeMaxChars: 6_000,
      audioTranscribeMaxRetries: 1,
      audioTranscribeRetryDelayMs: 800,
      audioTranscribeMaxBytes: 26_214_400,
      audioLocalWhisperCommand: null,
      audioLocalWhisperTimeoutMs: 180_000,
      recordPath: null,
    };
    this.cliCompatRecorder = this.cliCompat.recordPath ? new CliCompatRecorder(this.cliCompat.recordPath) : null;
    this.audioTranscriber =
      options?.audioTranscriber ??
      new AudioTranscriber({
        enabled: this.cliCompat.transcribeAudio,
        apiKey: process.env.OPENAI_API_KEY?.trim() || null,
        model: this.cliCompat.audioTranscribeModel,
        timeoutMs: this.cliCompat.audioTranscribeTimeoutMs,
        maxChars: this.cliCompat.audioTranscribeMaxChars,
        maxRetries: this.cliCompat.audioTranscribeMaxRetries,
        retryDelayMs: this.cliCompat.audioTranscribeRetryDelayMs,
        localWhisperCommand: this.cliCompat.audioLocalWhisperCommand,
        localWhisperTimeoutMs: this.cliCompat.audioLocalWhisperTimeoutMs,
      });
    const defaultProgressInterval = options?.progressMinIntervalMs ?? 2_500;
    this.progressMinIntervalMs = this.cliCompat.enabled ? this.cliCompat.progressThrottleMs : defaultProgressInterval;
    this.typingTimeoutMs = options?.typingTimeoutMs ?? 10_000;
    this.commandPrefix = (options?.commandPrefix ?? "").trim();
    this.matrixUserId = options?.matrixUserId ?? "";
    const sessionActiveWindowMinutes = options?.sessionActiveWindowMinutes ?? 20;
    this.sessionActiveWindowMs = Math.max(1, sessionActiveWindowMinutes) * 60_000;
    this.groupDirectModeEnabled = options?.groupDirectModeEnabled ?? false;
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
    this.workflowRunner = new MultiAgentWorkflowRunner(this.executor, this.logger, {
      enabled: options?.multiAgentWorkflow?.enabled ?? false,
      autoRepairMaxRounds: options?.multiAgentWorkflow?.autoRepairMaxRounds ?? 1,
    });
    const currentVersion = resolvePackageVersion();
    this.botNoticePrefix = `[CodeHarbor v${currentVersion}]`;
    this.packageUpdateChecker =
      options?.packageUpdateChecker ??
      new NpmRegistryUpdateChecker({
        packageName: "codeharbor",
        currentVersion,
      });
    this.updateCheckTtlMs = Math.max(0, options?.updateCheckTtlMs ?? 6 * 60 * 60 * 1000);
    this.executorFactory = options?.executorFactory ?? null;
    this.aiCliProvider = options?.aiCliProvider ?? "codex";
    this.aiCliModel = options?.aiCliModel?.trim() || null;
    this.upgradeAllowedUsers = new Set(
      (options?.upgradeAllowedUsers ?? parseCsvValues(process.env.MATRIX_UPGRADE_ALLOWED_USERS ?? ""))
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
    const selfUpdateTimeoutMs = Math.max(1_000, options?.selfUpdateTimeoutMs ?? DEFAULT_SELF_UPDATE_TIMEOUT_MS);
    this.selfUpdateRunner =
      options?.selfUpdateRunner ??
      ((input) =>
        runSelfUpdateCommand({
          version: input.version,
          timeoutMs: selfUpdateTimeoutMs,
        }));
    this.upgradeRestartPlanner =
      options?.upgradeRestartPlanner ??
      (() =>
        buildDefaultUpgradeRestartPlan({
          logger: this.logger,
        }));
    this.processStartedAtIso = new Date(Date.now() - process.uptime() * 1_000).toISOString();
    this.sessionRuntime = new CodexSessionRuntime(this.executor);
  }

  async handleMessage(message: InboundMessage): Promise<void> {
    const attachmentPaths = collectLocalAttachmentPaths(message);
    try {
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

        const workflowCommand = this.workflowRunner.isEnabled() ? parseWorkflowCommand(route.prompt) : null;
        const autoDevCommand = this.workflowRunner.isEnabled() ? parseAutoDevCommand(route.prompt) : null;
        if (workflowCommand?.kind === "status") {
          await this.handleWorkflowStatusCommand(sessionKey, message);
          this.stateStore.markEventProcessed(sessionKey, message.eventId);
          return;
        }
        if (autoDevCommand?.kind === "status") {
          await this.handleAutoDevStatusCommand(sessionKey, message, roomConfig.workdir);
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

        if (workflowCommand?.kind === "run") {
          const executionStartedAt = Date.now();
          let sendDurationMs = 0;
          this.stateStore.activateSession(sessionKey, this.sessionActiveWindowMs);
          try {
            const sendStartedAt = Date.now();
            await this.handleWorkflowRunCommand(
              workflowCommand.objective,
              sessionKey,
              message,
              requestId,
              roomConfig.workdir,
            );
            sendDurationMs += Date.now() - sendStartedAt;
            this.stateStore.markEventProcessed(sessionKey, message.eventId);
            this.metrics.record("success", queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
          } catch (error) {
            sendDurationMs += await this.sendWorkflowFailure(message.conversationId, error);
            this.stateStore.commitExecutionHandled(sessionKey, message.eventId);
            const status = classifyExecutionOutcome(error);
            this.metrics.record(status, queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
            this.logger.error("Workflow request failed", {
              requestId,
              sessionKey,
              error: formatError(error),
            });
          } finally {
            rateDecision.release?.();
          }
          return;
        }

        if (autoDevCommand?.kind === "run") {
          const executionStartedAt = Date.now();
          let sendDurationMs = 0;
          this.stateStore.activateSession(sessionKey, this.sessionActiveWindowMs);
          try {
            const sendStartedAt = Date.now();
            await this.handleAutoDevRunCommand(
              autoDevCommand.taskId,
              sessionKey,
              message,
              requestId,
              roomConfig.workdir,
            );
            sendDurationMs += Date.now() - sendStartedAt;
            this.stateStore.markEventProcessed(sessionKey, message.eventId);
            this.metrics.record("success", queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
          } catch (error) {
            sendDurationMs += await this.sendAutoDevFailure(message.conversationId, error);
            this.stateStore.commitExecutionHandled(sessionKey, message.eventId);
            const status = classifyExecutionOutcome(error);
            this.metrics.record(status, queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
            this.logger.error("AutoDev request failed", {
              requestId,
              sessionKey,
              error: formatError(error),
            });
          } finally {
            rateDecision.release?.();
          }
          return;
        }

        this.stateStore.activateSession(sessionKey, this.sessionActiveWindowMs);
        const previousCodexSessionId = this.stateStore.getCodexSessionId(sessionKey);
        const allowBridgeContext =
          previousCodexSessionId === null && !this.skipBridgeForNextPrompt.delete(sessionKey);
        const bridgeContext = allowBridgeContext ? this.buildConversationBridgeContext(sessionKey) : null;
        const audioTranscripts = await this.transcribeAudioAttachments(message, requestId, sessionKey);
        const executionPrompt = this.buildExecutionPrompt(route.prompt, message, audioTranscripts, bridgeContext);
        const imagePaths = collectImagePaths(message);
        let lastProgressAt = 0;
        let lastProgressText = "";
        let progressNoticeEventId: string | null = null;
        let progressChain: Promise<void> = Promise.resolve();
        let executionHandle: CodexExecutionHandle | null = null;
        let executionDurationMs = 0;
        let sendDurationMs = 0;
        const requestStartedAt = Date.now();
        let cancelRequested = this.consumePendingStopRequest(sessionKey);

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
        this.stateStore.appendConversationMessage(sessionKey, "user", this.aiCliProvider, route.prompt);
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
          this.stateStore.appendConversationMessage(sessionKey, "assistant", this.aiCliProvider, result.reply);
          await this.finishProgress(
            {
              conversationId: message.conversationId,
              isDirectMessage: message.isDirectMessage,
              getProgressNoticeEventId: () => progressNoticeEventId,
              setProgressNoticeEventId: (next) => {
                progressNoticeEventId = next;
              },
            },
            `处理完成（后端工具: ${this.formatBackendToolLabel()}；耗时 ${formatDurationMs(Date.now() - requestStartedAt)}）`,
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
        }
      });
    } finally {
      await cleanupAttachmentFiles(attachmentPaths);
    }
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
      this.groupDirectModeEnabled ||
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
    command: "status" | "version" | "backend" | "stop" | "reset" | "diag" | "help" | "upgrade",
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
      this.skipBridgeForNextPrompt.add(sessionKey);
      this.workflowSnapshots.delete(sessionKey);
      this.autoDevSnapshots.delete(sessionKey);
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 上下文已重置。你可以继续直接发送新需求。",
      );
      return;
    }

    if (command === "version") {
      const packageUpdate = await this.packageUpdateChecker.getStatus({ forceRefresh: true });
      await this.channel.sendNotice(
        message.conversationId,
        `${this.botNoticePrefix} 版本信息\n- 当前版本: ${packageUpdate.currentVersion}\n- 更新检查: ${formatPackageUpdateHint(packageUpdate)}\n- 检查时间: ${packageUpdate.checkedAt}`,
      );
      return;
    }

    if (command === "backend") {
      await this.handleBackendCommand(sessionKey, message);
      return;
    }

    if (command === "diag") {
      await this.handleDiagCommand(message);
      return;
    }

    if (command === "help") {
      await this.channel.sendNotice(
        message.conversationId,
        `${this.botNoticePrefix} 可用命令
- /help: 查看命令帮助
- /status: 查看会话状态（版本检查为缓存结果）
- /version: 实时检查最新版本
- /diag version: 查看运行实例诊断信息
- /upgrade [version]: 升级并自动重启服务（仅私聊；可配管理员白名单）
- /backend codex|claude|status: 查看/切换后端工具
- /reset: 清空当前会话上下文
- /stop: 停止当前执行任务
- help|帮助|菜单: /help 的文本别名（用于 Matrix 拦截 /help 的客户端）`,
      );
      return;
    }

    if (command === "upgrade") {
      await this.handleUpgradeCommand(message);
      return;
    }

    const status = this.stateStore.getSessionStatus(sessionKey);
    const roomConfig = this.resolveRoomRuntimeConfig(message.conversationId);
    const scope = message.isDirectMessage
      ? "私聊（免前缀）"
      : this.groupDirectModeEnabled
        ? "群聊（默认直通）"
        : "群聊（按房间触发策略）";
    const activeUntil = status.activeUntil ?? "未激活";
    const metrics = this.metrics.snapshot(this.runningExecutions.size);
    const limiter = this.rateLimiter.snapshot();
    const runtime = this.sessionRuntime.getRuntimeStats();
    const workflow = this.workflowSnapshots.get(sessionKey) ?? createIdleWorkflowSnapshot();
    const autoDev = this.autoDevSnapshots.get(sessionKey) ?? createIdleAutoDevSnapshot();
    const packageUpdate = await this.packageUpdateChecker.getStatus();
    const latestUpgrade = this.getLatestUpgradeRun();
    const recentUpgrades = this.getRecentUpgradeRuns(3);

    await this.channel.sendNotice(
      message.conversationId,
      `${this.botNoticePrefix} 当前状态
- 会话类型: ${scope}
- 激活中: ${status.isActive ? "是" : "否"}
- activeUntil: ${activeUntil}
- 已绑定会话: ${status.hasCodexSession ? "是" : "否"}
- 当前工作目录: ${roomConfig.workdir}
- AI CLI: ${this.formatBackendToolLabel()}
- 当前版本: ${packageUpdate.currentVersion}
- 更新检查: ${formatPackageUpdateHint(packageUpdate)}
- 更新检查时间: ${packageUpdate.checkedAt}
- 更新来源: 缓存结果（TTL=${formatCacheTtl(this.updateCheckTtlMs)}，发送 /version 可实时刷新）
- 最近升级: ${formatLatestUpgradeSummary(latestUpgrade)}
- 升级记录: ${formatRecentUpgradeRunsSummary(recentUpgrades)}
- 运行中任务: ${metrics.activeExecutions}
- 指标: total=${metrics.total}, success=${metrics.success}, failed=${metrics.failed}, timeout=${metrics.timeout}, cancelled=${metrics.cancelled}, rate_limited=${metrics.rateLimited}
- 平均耗时: queue=${metrics.avgQueueMs}ms, exec=${metrics.avgExecMs}ms, send=${metrics.avgSendMs}ms
- 限流并发: global=${limiter.activeGlobal}, users=${limiter.activeUsers}, rooms=${limiter.activeRooms}
- CLI runtime: workers=${runtime.workerCount}, running=${runtime.runningCount}, compat_mode=${
        this.cliCompat.enabled ? "on" : "off"
      }
- Multi-Agent workflow: enabled=${this.workflowRunner.isEnabled() ? "on" : "off"}, state=${workflow.state}
- AutoDev: enabled=${this.workflowRunner.isEnabled() ? "on" : "off"}, state=${autoDev.state}, task=${autoDev.taskId ?? "N/A"}`,
    );
  }

  private async handleWorkflowStatusCommand(sessionKey: string, message: InboundMessage): Promise<void> {
    const snapshot = this.workflowSnapshots.get(sessionKey) ?? createIdleWorkflowSnapshot();
    await this.channel.sendNotice(
      message.conversationId,
      `[CodeHarbor] Multi-Agent 工作流状态
- state: ${snapshot.state}
- startedAt: ${snapshot.startedAt ?? "N/A"}
- endedAt: ${snapshot.endedAt ?? "N/A"}
- objective: ${snapshot.objective ?? "N/A"}
- approved: ${snapshot.approved === null ? "N/A" : snapshot.approved ? "yes" : "no"}
- repairRounds: ${snapshot.repairRounds}
- error: ${snapshot.error ?? "N/A"}`,
    );
  }

  private async handleAutoDevStatusCommand(
    sessionKey: string,
    message: InboundMessage,
    workdir: string,
  ): Promise<void> {
    const snapshot = this.autoDevSnapshots.get(sessionKey) ?? createIdleAutoDevSnapshot();
    try {
      const context = await loadAutoDevContext(workdir);
      const summary = summarizeAutoDevTasks(context.tasks);
      const nextTask = selectAutoDevTask(context.tasks);

      await this.channel.sendNotice(
        message.conversationId,
        `[CodeHarbor] AutoDev 状态
- workdir: ${workdir}
- REQUIREMENTS.md: ${context.requirementsContent ? "found" : "missing"}
- TASK_LIST.md: ${context.taskListContent ? "found" : "missing"}
- tasks: total=${summary.total}, pending=${summary.pending}, in_progress=${summary.inProgress}, completed=${summary.completed}, blocked=${summary.blocked}, cancelled=${summary.cancelled}
- nextTask: ${nextTask ? formatTaskForDisplay(nextTask) : "N/A"}
- runState: ${snapshot.state}
- runTask: ${snapshot.taskId ? `${snapshot.taskId} ${snapshot.taskDescription ?? ""}`.trim() : "N/A"}
- runApproved: ${snapshot.approved === null ? "N/A" : snapshot.approved ? "yes" : "no"}
- runError: ${snapshot.error ?? "N/A"}`,
      );
    } catch (error) {
      await this.channel.sendNotice(message.conversationId, `[CodeHarbor] AutoDev 状态读取失败: ${formatError(error)}`);
    }
  }

  private async handleAutoDevRunCommand(
    taskId: string | null,
    sessionKey: string,
    message: InboundMessage,
    requestId: string,
    workdir: string,
  ): Promise<void> {
    const requestedTaskId = taskId?.trim() || null;
    const context = await loadAutoDevContext(workdir);
    if (!context.requirementsContent) {
      await this.channel.sendNotice(
        message.conversationId,
        `[CodeHarbor] AutoDev 需要 ${context.requirementsPath}，请先准备需求文档。`,
      );
      return;
    }
    if (!context.taskListContent) {
      await this.channel.sendNotice(
        message.conversationId,
        `[CodeHarbor] AutoDev 需要 ${context.taskListPath}，请先准备任务清单。`,
      );
      return;
    }
    if (context.tasks.length === 0) {
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 未在 TASK_LIST.md 识别到任务（需包含任务 ID 与状态列）。",
      );
      return;
    }

    const selectedTask = selectAutoDevTask(context.tasks, requestedTaskId);
    if (!selectedTask) {
      if (requestedTaskId) {
        await this.channel.sendNotice(message.conversationId, `[CodeHarbor] 未找到任务 ${requestedTaskId}。`);
        return;
      }
      await this.channel.sendNotice(message.conversationId, "[CodeHarbor] 当前没有可执行任务（pending/in_progress）。");
      return;
    }
    if (selectedTask.status === "completed") {
      await this.channel.sendNotice(message.conversationId, `[CodeHarbor] 任务 ${selectedTask.id} 已完成（✅）。`);
      return;
    }
    if (selectedTask.status === "cancelled") {
      await this.channel.sendNotice(message.conversationId, `[CodeHarbor] 任务 ${selectedTask.id} 已取消（❌）。`);
      return;
    }

    let activeTask = selectedTask;
    let promotedToInProgress = false;
    if (selectedTask.status === "pending") {
      activeTask = await updateAutoDevTaskStatus(context.taskListPath, selectedTask, "in_progress");
      promotedToInProgress = true;
    }

    const startedAtIso = new Date().toISOString();
    this.setAutoDevSnapshot(sessionKey, {
      state: "running",
      startedAt: startedAtIso,
      endedAt: null,
      taskId: activeTask.id,
      taskDescription: activeTask.description,
      approved: null,
      repairRounds: 0,
      error: null,
    });

    await this.channel.sendNotice(
      message.conversationId,
      `[CodeHarbor] AutoDev 启动任务 ${activeTask.id}: ${activeTask.description}`,
    );

    try {
      const result = await this.handleWorkflowRunCommand(
        buildAutoDevObjective(activeTask),
        sessionKey,
        message,
        requestId,
        workdir,
      );
      if (!result) {
        return;
      }

      let finalTask = activeTask;
      if (result.approved) {
        finalTask = await updateAutoDevTaskStatus(context.taskListPath, activeTask, "completed");
      }
      const endedAtIso = new Date().toISOString();
      this.setAutoDevSnapshot(sessionKey, {
        state: "succeeded",
        startedAt: startedAtIso,
        endedAt: endedAtIso,
        taskId: finalTask.id,
        taskDescription: finalTask.description,
        approved: result.approved,
        repairRounds: result.repairRounds,
        error: null,
      });

      const refreshed = await loadAutoDevContext(workdir);
      const nextTask = selectAutoDevTask(refreshed.tasks);
      await this.channel.sendNotice(
        message.conversationId,
        `[CodeHarbor] AutoDev 任务结果
- task: ${finalTask.id}
- reviewer approved: ${result.approved ? "yes" : "no"}
- task status: ${statusToSymbol(finalTask.status)}
- nextTask: ${nextTask ? formatTaskForDisplay(nextTask) : "N/A"}`,
      );
    } catch (error) {
      if (promotedToInProgress) {
        try {
          await updateAutoDevTaskStatus(context.taskListPath, activeTask, "pending");
        } catch (restoreError) {
          this.logger.warn("Failed to restore AutoDev task status after failure", {
            taskId: activeTask.id,
            error: formatError(restoreError),
          });
        }
      }

      const status = classifyExecutionOutcome(error);
      const endedAtIso = new Date().toISOString();
      this.setAutoDevSnapshot(sessionKey, {
        state: status === "cancelled" ? "idle" : "failed",
        startedAt: startedAtIso,
        endedAt: endedAtIso,
        taskId: activeTask.id,
        taskDescription: activeTask.description,
        approved: null,
        repairRounds: 0,
        error: formatError(error),
      });
      throw error;
    }
  }

  private async handleWorkflowRunCommand(
    objective: string,
    sessionKey: string,
    message: InboundMessage,
    requestId: string,
    workdir: string,
  ): Promise<MultiAgentWorkflowRunResult | null> {
    const normalizedObjective = objective.trim();
    if (!normalizedObjective) {
      await this.channel.sendNotice(message.conversationId, "[CodeHarbor] /agents run 需要提供任务目标。");
      return null;
    }

    const requestStartedAt = Date.now();
    let progressNoticeEventId: string | null = null;
    const progressCtx: SendProgressContext = {
      conversationId: message.conversationId,
      isDirectMessage: message.isDirectMessage,
      getProgressNoticeEventId: () => progressNoticeEventId,
      setProgressNoticeEventId: (next) => {
        progressNoticeEventId = next;
      },
    };

    const startedAtIso = new Date().toISOString();
    this.setWorkflowSnapshot(sessionKey, {
      state: "running",
      startedAt: startedAtIso,
      endedAt: null,
      objective: normalizedObjective,
      approved: null,
      repairRounds: 0,
      error: null,
    });

    const stopTyping = this.startTypingHeartbeat(message.conversationId);
    let cancelWorkflow = (): void => {};
    let cancelRequested = false;
    this.runningExecutions.set(sessionKey, {
      requestId,
      startedAt: requestStartedAt,
      cancel: () => {
        cancelRequested = true;
        cancelWorkflow();
      },
    });

    await this.sendProgressUpdate(progressCtx, "[CodeHarbor] Multi-Agent workflow 启动：Planner -> Executor -> Reviewer");

    try {
      const result = await this.workflowRunner.run({
        objective: normalizedObjective,
        workdir,
        onRegisterCancel: (cancel) => {
          cancelWorkflow = cancel;
          if (cancelRequested) {
            cancelWorkflow();
          }
        },
        onProgress: async (event) => {
          const stepLabel = event.stage.toUpperCase();
          await this.sendProgressUpdate(progressCtx, `[CodeHarbor] [${stepLabel}] ${event.message}`);
        },
      });

      const endedAtIso = new Date().toISOString();
      this.setWorkflowSnapshot(sessionKey, {
        state: "succeeded",
        startedAt: startedAtIso,
        endedAt: endedAtIso,
        objective: normalizedObjective,
        approved: result.approved,
        repairRounds: result.repairRounds,
        error: null,
      });

      await this.channel.sendMessage(message.conversationId, buildWorkflowResultReply(result));
      await this.finishProgress(progressCtx, `多智能体流程完成（耗时 ${formatDurationMs(Date.now() - requestStartedAt)}）`);
      return result;
    } catch (error) {
      const status = classifyExecutionOutcome(error);
      const endedAtIso = new Date().toISOString();
      this.setWorkflowSnapshot(sessionKey, {
        state: status === "cancelled" ? "idle" : "failed",
        startedAt: startedAtIso,
        endedAt: endedAtIso,
        objective: normalizedObjective,
        approved: null,
        repairRounds: 0,
        error: formatError(error),
      });
      await this.finishProgress(progressCtx, buildFailureProgressSummary(status, requestStartedAt, error));
      throw error;
    } finally {
      const running = this.runningExecutions.get(sessionKey);
      if (running?.requestId === requestId) {
        this.runningExecutions.delete(sessionKey);
      }
      await stopTyping();
    }
  }

  private async sendWorkflowFailure(conversationId: string, error: unknown): Promise<number> {
    const startedAt = Date.now();
    const status = classifyExecutionOutcome(error);
    if (status === "cancelled") {
      await this.channel.sendNotice(conversationId, "[CodeHarbor] Multi-Agent workflow 已取消。");
      return Date.now() - startedAt;
    }

    await this.channel.sendMessage(conversationId, `[CodeHarbor] Multi-Agent workflow 失败: ${formatError(error)}`);
    return Date.now() - startedAt;
  }

  private async sendAutoDevFailure(conversationId: string, error: unknown): Promise<number> {
    const startedAt = Date.now();
    const status = classifyExecutionOutcome(error);
    if (status === "cancelled") {
      await this.channel.sendNotice(conversationId, "[CodeHarbor] AutoDev 已取消。");
      return Date.now() - startedAt;
    }

    await this.channel.sendMessage(conversationId, `[CodeHarbor] AutoDev 失败: ${formatError(error)}`);
    return Date.now() - startedAt;
  }

  private async handleStopCommand(sessionKey: string, message: InboundMessage, requestId: string): Promise<void> {
    this.stateStore.deactivateSession(sessionKey);
    this.stateStore.clearCodexSessionId(sessionKey);
    this.sessionRuntime.clearSession(sessionKey);
    this.skipBridgeForNextPrompt.add(sessionKey);

    const running = this.runningExecutions.get(sessionKey);
    if (running) {
      this.pendingStopRequests.delete(sessionKey);
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

    const lockEntry = this.sessionLocks.get(sessionKey);
    if (lockEntry?.mutex.isLocked()) {
      this.pendingStopRequests.add(sessionKey);
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 已请求停止当前任务，并已清理会话上下文。",
      );
      this.logger.info("Stop command queued for pending execution", {
        requestId,
        sessionKey,
      });
      return;
    }

    this.pendingStopRequests.delete(sessionKey);
    await this.channel.sendNotice(
      message.conversationId,
      "[CodeHarbor] 会话已停止。后续在群聊中请提及/回复我，或在私聊直接发送消息。",
    );
  }

  private consumePendingStopRequest(sessionKey: string): boolean {
    if (!this.pendingStopRequests.has(sessionKey)) {
      return false;
    }
    this.pendingStopRequests.delete(sessionKey);
    return true;
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
      `${this.botNoticePrefix} ${progressText}`,
    );
  }

  private async finishProgress(ctx: SendProgressContext, summary: string): Promise<void> {
    if (!this.progressUpdatesEnabled) {
      return;
    }
    let updateHint = "";
    try {
      const packageUpdate = await this.packageUpdateChecker.getStatus();
      updateHint = `；${formatPackageUpdateHint(packageUpdate)}`;
    } catch (error) {
      this.logger.debug("Failed to resolve package update status for progress summary", { error });
    }
    await this.sendProgressUpdate(ctx, `${this.botNoticePrefix} ${summary}${updateHint}`);
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

  private async transcribeAudioAttachments(
    message: InboundMessage,
    requestId: string,
    sessionKey: string,
  ): Promise<AudioTranscript[]> {
    if (!this.audioTranscriber.isEnabled()) {
      return [];
    }

    const rawAudioAttachments = message.attachments.filter(
      (attachment) => attachment.kind === "audio" && Boolean(attachment.localPath),
    );
    if (rawAudioAttachments.length === 0) {
      return [];
    }

    const maxBytes = this.cliCompat.audioTranscribeMaxBytes;
    const audioAttachments: Array<{ name: string; mimeType: string | null; localPath: string }> = [];
    let skippedTooLarge = 0;
    for (const attachment of rawAudioAttachments) {
      const localPath = attachment.localPath as string;
      const sizeBytes = await this.resolveAudioAttachmentSizeBytes(attachment.sizeBytes, localPath);
      if (sizeBytes !== null && sizeBytes > maxBytes) {
        skippedTooLarge += 1;
        this.logger.warn("Skip audio transcription for oversized attachment", {
          requestId,
          sessionKey,
          name: attachment.name,
          sizeBytes,
          maxBytes,
        });
        continue;
      }
      audioAttachments.push({
        name: attachment.name,
        mimeType: attachment.mimeType,
        localPath,
      });
    }

    if (audioAttachments.length === 0) {
      return [];
    }

    const startedAt = Date.now();
    try {
      const transcripts = await this.audioTranscriber.transcribeMany(audioAttachments);
      this.logger.info("Audio transcription completed", {
        requestId,
        sessionKey,
        attachmentCount: audioAttachments.length,
        transcriptCount: transcripts.length,
        skippedTooLarge,
        durationMs: Date.now() - startedAt,
      });
      return transcripts;
    } catch (error) {
      this.logger.warn("Audio transcription failed, continuing without transcripts", {
        requestId,
        sessionKey,
        attachmentCount: audioAttachments.length,
        skippedTooLarge,
        durationMs: Date.now() - startedAt,
        error: formatError(error),
      });
      return [];
    }
  }

  private async resolveAudioAttachmentSizeBytes(sizeBytes: number | null, localPath: string): Promise<number | null> {
    if (sizeBytes !== null) {
      return sizeBytes;
    }
    try {
      const stats = await fs.stat(localPath);
      return stats.size;
    } catch {
      return null;
    }
  }

  private buildExecutionPrompt(
    prompt: string,
    message: InboundMessage,
    audioTranscripts: AudioTranscript[],
    bridgeContext: string | null,
  ): string {
    let composed: string;
    if (message.attachments.length === 0 && audioTranscripts.length === 0) {
      composed = prompt;
    } else {
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
      const sections = [promptBody];
      if (attachmentSummary) {
        sections.push(`[attachments]\n${attachmentSummary}\n[/attachments]`);
      }

      if (audioTranscripts.length > 0) {
        const transcriptSummary = audioTranscripts
          .map((transcript) => `- name=${transcript.name} text=${transcript.text.replace(/\s+/g, " ").trim()}`)
          .join("\n");
        sections.push(`[audio_transcripts]\n${transcriptSummary}\n[/audio_transcripts]`);
      }
      composed = sections.join("\n\n");
    }

    if (!bridgeContext) {
      return composed;
    }
    return `${bridgeContext}\n\n[current_request]\n${composed}`;
  }

  private buildConversationBridgeContext(sessionKey: string): string | null {
    const messages = this.stateStore.listRecentConversationMessages(sessionKey, CONTEXT_BRIDGE_HISTORY_LIMIT);
    if (messages.length === 0) {
      return null;
    }

    const lines = messages
      .map((message) => {
        const role = message.role === "user" ? "user" : "assistant";
        const compact = message.content.replace(/\s+/g, " ").trim();
        const truncated = compact.length > 1_000 ? `${compact.slice(0, 1000)}...` : compact;
        return `- [${message.provider}] ${role}: ${truncated}`;
      })
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return null;
    }

    const selected: string[] = [];
    let usedChars = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (usedChars + line.length + 1 > CONTEXT_BRIDGE_MAX_CHARS) {
        continue;
      }
      selected.push(line);
      usedChars += line.length + 1;
    }
    if (selected.length === 0) {
      return null;
    }
    selected.reverse();

    return [
      "[conversation_bridge]",
      "The following local chat history is from the same conversation before backend switch. Use it as context.",
      "Do not reprint full history unless user asks.",
      ...selected,
      "[/conversation_bridge]",
    ].join("\n");
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

  private setWorkflowSnapshot(sessionKey: string, snapshot: WorkflowRunSnapshot): void {
    this.workflowSnapshots.set(sessionKey, snapshot);
    this.pruneRunSnapshots(Date.now());
  }

  private setAutoDevSnapshot(sessionKey: string, snapshot: AutoDevRunSnapshot): void {
    this.autoDevSnapshots.set(sessionKey, snapshot);
    this.pruneRunSnapshots(Date.now());
  }

  private pruneRunSnapshots(now: number): void {
    pruneSnapshotMap(
      this.workflowSnapshots,
      now,
      (snapshot) => snapshot.state !== "running",
      (snapshot) => snapshot.endedAt ?? snapshot.startedAt,
    );
    pruneSnapshotMap(
      this.autoDevSnapshots,
      now,
      (snapshot) => snapshot.state !== "running",
      (snapshot) => snapshot.endedAt ?? snapshot.startedAt,
    );
  }

  private getLock(key: string): Mutex {
    const now = Date.now();
    if (now - this.lastLockPruneAt >= this.lockPruneIntervalMs) {
      this.lastLockPruneAt = now;
      this.pruneSessionLocks(now);
      this.pruneRunSnapshots(now);
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

  private async handleUpgradeCommand(message: InboundMessage): Promise<void> {
    const auth = this.authorizeUpgradeRequest(message);
    if (!auth.allowed) {
      await this.channel.sendNotice(message.conversationId, `[CodeHarbor] ${auth.reason}`);
      return;
    }

    const parsed = parseUpgradeTarget(message.text);
    if (!parsed.ok) {
      await this.channel.sendNotice(message.conversationId, `[CodeHarbor] ${parsed.reason}`);
      return;
    }

    if (this.upgradeMutex.isLocked()) {
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 已有升级任务在执行中，请稍后发送 /diag version 或 /version 查看结果。",
      );
      return;
    }

    const targetLabel = parsed.version ? parsed.version : "latest";
    const upgradeRunId = this.createUpgradeRun(message.senderId, parsed.version);
    const startedAt = Date.now();
    await this.channel.sendNotice(
      message.conversationId,
      `${this.botNoticePrefix} 已开始升级（目标: ${targetLabel}），将安装 npm 最新包并自动重启服务。`,
    );

    await this.upgradeMutex.runExclusive(async () => {
      try {
        const result = await this.selfUpdateRunner({
          version: parsed.version,
        });
        const restartPlan = await this.upgradeRestartPlanner();
        const elapsed = formatDurationMs(Date.now() - startedAt);
        const installedVersion = result.installedVersion ?? "unknown";
        await this.channel.sendNotice(
          message.conversationId,
          `${this.botNoticePrefix} 升级任务完成（耗时 ${elapsed}）
- 目标版本: ${targetLabel}
- 已安装版本: ${installedVersion}
- 服务重启: ${restartPlan.summary}
- 校验建议: 稍后发送 /diag version 或 /version`,
        );
        this.finishUpgradeRun(upgradeRunId, {
          status: "succeeded",
          installedVersion,
          error: null,
        });
        try {
          await restartPlan.apply();
        } catch (restartError) {
          this.logger.warn("Failed to apply post-upgrade restart plan", { restartError });
        }
      } catch (error) {
        const errorText = formatSelfUpdateError(error);
        const elapsed = formatDurationMs(Date.now() - startedAt);
        await this.channel.sendNotice(
          message.conversationId,
          `${this.botNoticePrefix} 升级失败（耗时 ${elapsed}）
- 错误: ${errorText}
- 兜底命令: codeharbor self-update --with-admin`,
        );
        this.finishUpgradeRun(upgradeRunId, {
          status: "failed",
          installedVersion: null,
          error: errorText,
        });
      }
    });
  }

  private authorizeUpgradeRequest(message: InboundMessage): { allowed: true } | { allowed: false; reason: string } {
    if (!message.isDirectMessage) {
      return {
        allowed: false,
        reason: "为保证安全，/upgrade 仅支持私聊中执行。",
      };
    }
    if (this.upgradeAllowedUsers.size === 0) {
      return { allowed: true };
    }
    if (this.upgradeAllowedUsers.has(message.senderId)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "当前账号无执行 /upgrade 权限，请联系管理员添加 MATRIX_UPGRADE_ALLOWED_USERS 白名单。",
    };
  }

  private createUpgradeRun(requestedBy: string, targetVersion: string | null): number | null {
    const store = this.getUpgradeStateStore();
    if (!store) {
      return null;
    }
    try {
      return store.createUpgradeRun({
        requestedBy,
        targetVersion,
      });
    } catch (error) {
      this.logger.warn("Failed to create upgrade run record", { error });
      return null;
    }
  }

  private finishUpgradeRun(
    runId: number | null,
    input: { status: "succeeded" | "failed"; installedVersion: string | null; error: string | null },
  ): void {
    if (runId === null) {
      return;
    }
    const store = this.getUpgradeStateStore();
    if (!store) {
      return;
    }
    try {
      store.finishUpgradeRun(runId, input);
    } catch (error) {
      this.logger.warn("Failed to finalize upgrade run record", { runId, error });
    }
  }

  private getLatestUpgradeRun(): UpgradeRunRecord | null {
    const store = this.getUpgradeStateStore();
    if (!store) {
      return null;
    }
    try {
      return store.getLatestUpgradeRun();
    } catch (error) {
      this.logger.warn("Failed to fetch latest upgrade run record", { error });
      return null;
    }
  }

  private getRecentUpgradeRuns(limit: number): UpgradeRunRecord[] {
    const store = this.getUpgradeStateStore();
    if (!store || typeof store.listRecentUpgradeRuns !== "function") {
      return [];
    }
    try {
      return store.listRecentUpgradeRuns(limit);
    } catch (error) {
      this.logger.warn("Failed to fetch recent upgrade run records", { error, limit });
      return [];
    }
  }

  private getUpgradeStateStore(): UpgradeStateStore | null {
    const maybeStore = this.stateStore as unknown as Partial<UpgradeStateStore>;
    if (
      typeof maybeStore.createUpgradeRun !== "function" ||
      typeof maybeStore.finishUpgradeRun !== "function" ||
      typeof maybeStore.getLatestUpgradeRun !== "function"
    ) {
      return null;
    }
    return maybeStore as UpgradeStateStore;
  }

  private async handleBackendCommand(sessionKey: string, message: InboundMessage): Promise<void> {
    const target = parseBackendTarget(message.text);
    if (!target || target === "status") {
      await this.channel.sendNotice(
        message.conversationId,
        `[CodeHarbor] 当前后端工具: ${this.formatBackendToolLabel()}\n可用命令: /backend codex | /backend claude | /backend status`,
      );
      return;
    }
    if (target === this.aiCliProvider) {
      await this.channel.sendNotice(message.conversationId, `[CodeHarbor] 后端工具已是 ${target}。`);
      return;
    }
    if (!this.executorFactory) {
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 当前运行模式不支持会话内切换后端，请修改 .env 后重启服务。",
      );
      return;
    }
    if (this.runningExecutions.size > 0) {
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 检测到仍有运行中任务，请等待任务完成后再切换后端工具。",
      );
      return;
    }

    this.executor = this.executorFactory(target);
    this.sessionRuntime = new CodexSessionRuntime(this.executor);
    this.aiCliProvider = target;
    this.stateStore.clearCodexSessionId(sessionKey);
    this.stateStore.activateSession(sessionKey, this.sessionActiveWindowMs);
    this.workflowSnapshots.delete(sessionKey);
    this.autoDevSnapshots.delete(sessionKey);

    await this.channel.sendNotice(
      message.conversationId,
      `[CodeHarbor] 已切换后端工具为 ${this.formatBackendToolLabel()}。下一个请求会自动注入最近本地会话历史作为桥接上下文。`,
    );
  }

  private formatBackendToolLabel(): string {
    if (!this.aiCliModel) {
      return this.aiCliProvider;
    }
    return `${this.aiCliProvider} (${this.aiCliModel})`;
  }

  private async handleDiagCommand(message: InboundMessage): Promise<void> {
    const target = parseDiagTarget(message.text);
    if (!target || target === "help") {
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 用法: /diag version",
      );
      return;
    }
    if (target !== "version") {
      return;
    }

    const packageUpdate = await this.packageUpdateChecker.getStatus({ forceRefresh: true });
    const cliScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "unknown";
    const uptimeMs = Math.max(0, Math.floor(process.uptime() * 1_000));

    await this.channel.sendNotice(
      message.conversationId,
      `${this.botNoticePrefix} 诊断信息（version）
- pid: ${process.pid}
- startedAt: ${this.processStartedAtIso}
- uptime: ${formatDurationMs(uptimeMs)}
- node: ${process.version}
- nodeExecPath: ${process.execPath}
- cliScriptPath: ${cliScriptPath}
- cwd: ${process.cwd()}
- backend: ${this.formatBackendToolLabel()}
- currentVersion: ${packageUpdate.currentVersion}
- latestHint: ${formatPackageUpdateHint(packageUpdate)}
- checkedAt: ${packageUpdate.checkedAt}`,
    );
  }
}

function pruneSnapshotMap<T>(
  snapshots: Map<string, T>,
  now: number,
  isPrunable: (snapshot: T) => boolean,
  resolveSnapshotTimeIso: (snapshot: T) => string | null,
): void {
  const staleKeys: string[] = [];
  const candidatesForOverflow: Array<{ key: string; timestamp: number }> = [];

  for (const [key, snapshot] of snapshots.entries()) {
    if (!isPrunable(snapshot)) {
      continue;
    }

    const timeIso = resolveSnapshotTimeIso(snapshot);
    if (!timeIso) {
      staleKeys.push(key);
      continue;
    }

    const timestamp = Date.parse(timeIso);
    if (!Number.isFinite(timestamp)) {
      staleKeys.push(key);
      continue;
    }

    if (now - timestamp > RUN_SNAPSHOT_TTL_MS) {
      staleKeys.push(key);
      continue;
    }

    candidatesForOverflow.push({ key, timestamp });
  }

  for (const key of staleKeys) {
    snapshots.delete(key);
  }

  if (snapshots.size <= RUN_SNAPSHOT_MAX_ENTRIES) {
    return;
  }

  const overflow = snapshots.size - RUN_SNAPSHOT_MAX_ENTRIES;
  if (overflow <= 0) {
    return;
  }

  candidatesForOverflow.sort((a, b) => a.timestamp - b.timestamp);
  for (let i = 0; i < overflow && i < candidatesForOverflow.length; i += 1) {
    snapshots.delete(candidatesForOverflow[i].key);
  }
}

function createIdleAutoDevSnapshot(): AutoDevRunSnapshot {
  return {
    state: "idle",
    startedAt: null,
    endedAt: null,
    taskId: null,
    taskDescription: null,
    approved: null,
    repairRounds: 0,
    error: null,
  };
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

function collectLocalAttachmentPaths(message: InboundMessage): string[] {
  const seen = new Set<string>();
  for (const attachment of message.attachments) {
    if (!attachment.localPath) {
      continue;
    }
    seen.add(attachment.localPath);
  }
  return [...seen];
}

async function cleanupAttachmentFiles(attachmentPaths: string[]): Promise<void> {
  await Promise.all(
    attachmentPaths.map(async (attachmentPath) => {
      try {
        await fs.unlink(attachmentPath);
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

function parseControlCommand(
  text: string,
): "status" | "version" | "backend" | "stop" | "reset" | "diag" | "help" | "upgrade" | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === "help" || normalized === "帮助" || normalized === "菜单") {
    return "help";
  }
  if (isPlainUpgradeCommand(normalized)) {
    return "upgrade";
  }

  const command = text.split(/\s+/, 1)[0].toLowerCase();
  if (command === "/status") {
    return "status";
  }
  if (command === "/version") {
    return "version";
  }
  if (command === "/backend") {
    return "backend";
  }
  if (command === "/stop") {
    return "stop";
  }
  if (command === "/reset") {
    return "reset";
  }
  if (command === "/diag") {
    return "diag";
  }
  if (command === "/help") {
    return "help";
  }
  if (command === "/upgrade") {
    return "upgrade";
  }
  return null;
}

function isPlainUpgradeCommand(normalized: string): boolean {
  if (normalized === "upgrade" || normalized === "升级") {
    return true;
  }
  const match = normalized.match(/^(upgrade|升级)\s+(.+)$/);
  if (!match) {
    return false;
  }
  const argument = match[2]?.trim() ?? "";
  if (!argument || argument === "latest") {
    return true;
  }
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(argument);
}

function parseDiagTarget(text: string): "version" | "help" | null {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 2) {
    return "help";
  }
  const value = tokens[1]?.toLowerCase() ?? "";
  if (value === "version") {
    return "version";
  }
  return null;
}

function parseBackendTarget(text: string): "codex" | "claude" | "status" | null {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length < 2) {
    return "status";
  }
  const value = tokens[1]?.toLowerCase() ?? "";
  if (value === "codex") {
    return "codex";
  }
  if (value === "claude") {
    return "claude";
  }
  if (value === "status") {
    return "status";
  }
  return null;
}

function parseUpgradeTarget(text: string): { ok: true; version: string | null } | { ok: false; reason: string } {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((item) => item.length > 0);
  if (tokens.length <= 1) {
    return { ok: true, version: null };
  }
  if (tokens.length > 2) {
    return {
      ok: false,
      reason: "用法: /upgrade [version]（示例: /upgrade 或 /upgrade 0.1.33）",
    };
  }

  const raw = tokens[1]?.trim() ?? "";
  if (!raw || raw.toLowerCase() === "latest") {
    return { ok: true, version: null };
  }

  const normalized = raw.startsWith("v") ? raw.slice(1) : raw;
  const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
  if (!semverPattern.test(normalized)) {
    return {
      ok: false,
      reason: "版本号格式无效。请使用 x.y.z（例如 0.1.33）或留空表示 latest。",
    };
  }
  return {
    ok: true,
    version: normalized,
  };
}

function parseCsvValues(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function runSelfUpdateCommand(input: { version: string | null; timeoutMs: number }): Promise<SelfUpdateResult> {
  const invocations = resolveSelfUpdateInvocations();
  let lastError: unknown = null;

  for (const invocation of invocations) {
    const args = [...invocation.prefixArgs, "self-update", "--with-admin", "--skip-restart"];
    if (input.version) {
      args.push("--version", input.version);
    }

    try {
      const { stdout, stderr } = await execFileAsync(invocation.file, args, {
        timeout: input.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          CODEHARBOR_SKIP_POSTINSTALL_RESTART: "1",
        },
      });

      const stdoutText = normalizeCommandOutput(stdout);
      const stderrText = normalizeCommandOutput(stderr);
      return {
        installedVersion: parseInstalledVersionFromSelfUpdateOutput(stdoutText + "\n" + stderrText),
        stdout: stdoutText,
        stderr: stderrText,
      };
    } catch (error) {
      if (isCommandNotFound(error)) {
        lastError = error;
        continue;
      }
      throw new Error(`self-update command failed (${invocation.label}): ${formatSelfUpdateError(error)}`, {
        cause: error,
      });
    }
  }

  throw new Error(`unable to run self-update command: ${formatSelfUpdateError(lastError)}`, {
    cause: lastError ?? undefined,
  });
}

async function buildDefaultUpgradeRestartPlan(input: { logger: Logger }): Promise<UpgradeRestartPlan> {
  if (process.platform !== "linux") {
    return {
      summary: "已跳过（非 Linux 平台）",
      apply: async () => {},
    };
  }
  if (!(await isSystemctlCommandAvailable())) {
    return {
      summary: "已跳过（未检测到 systemctl）",
      apply: async () => {},
    };
  }

  const hasMainService = await isSystemdUnitInstalled("codeharbor.service");
  if (!hasMainService) {
    return {
      summary: "已跳过（未检测到 codeharbor.service）",
      apply: async () => {},
    };
  }
  const hasAdminService = await isSystemdUnitInstalled("codeharbor-admin.service");

  if (!isLikelySystemdServiceProcess()) {
    return {
      summary: "已跳过（当前非 systemd 服务上下文）",
      apply: async () => {},
    };
  }

  return {
    summary: `已触发（signal${hasAdminService ? ", main+admin" : ", main"}）`,
    apply: async () => {
      if (hasAdminService) {
        const adminPid = await readSystemdUnitMainPid("codeharbor-admin.service");
        if (adminPid !== null && adminPid > 1 && adminPid !== process.pid) {
          try {
            process.kill(adminPid, "SIGTERM");
          } catch (error) {
            input.logger.warn("Failed to signal codeharbor-admin process for restart", {
              adminPid,
              error,
            });
          }
        }
      }

      const timer = setTimeout(() => {
        try {
          process.kill(process.pid, "SIGTERM");
        } catch (error) {
          input.logger.warn("Failed to signal current process for restart", { error });
        }
      }, 1200);
      timer.unref?.();
    },
  };
}

async function isSystemctlCommandAvailable(): Promise<boolean> {
  try {
    await execFileAsync("systemctl", ["--version"], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

async function isSystemdUnitInstalled(unitName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["list-unit-files", unitName, "--no-legend"], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      env: process.env,
    });
    const output = normalizeCommandOutput(stdout);
    if (!output) {
      return false;
    }
    return output
      .split(/\r?\n/)
      .some((line) => line.trim().startsWith(`${unitName} `));
  } catch {
    return false;
  }
}

async function readSystemdUnitMainPid(unitName: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["show", unitName, "--property", "MainPID", "--value"], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      env: process.env,
    });
    const text = normalizeCommandOutput(stdout);
    if (!text) {
      return null;
    }
    const value = Number.parseInt(text, 10);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isLikelySystemdServiceProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOCATION_ID || env.SYSTEMD_EXEC_PID || env.JOURNAL_STREAM);
}

function resolveSelfUpdateInvocations(): Array<{ file: string; prefixArgs: string[]; label: string }> {
  const candidates: Array<{ file: string; prefixArgs: string[]; label: string }> = [];

  const cliArgvPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (cliArgvPath && existsSync(cliArgvPath)) {
    candidates.push({
      file: process.execPath,
      prefixArgs: [cliArgvPath],
      label: `node ${cliArgvPath}`,
    });
  }

  const bundledCliPath = path.resolve(__dirname, "cli.js");
  if (existsSync(bundledCliPath)) {
    candidates.push({
      file: process.execPath,
      prefixArgs: [bundledCliPath],
      label: `node ${bundledCliPath}`,
    });
  }

  const uniqueCandidates: Array<{ file: string; prefixArgs: string[]; label: string }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.file}::${candidate.prefixArgs.join(" ")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueCandidates.push(candidate);
  }

  uniqueCandidates.push({
    file: "codeharbor",
    prefixArgs: [],
    label: "codeharbor",
  });
  return uniqueCandidates;
}

function parseInstalledVersionFromSelfUpdateOutput(output: string): string | null {
  const match = output.match(/Installed version:\s*([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/i);
  return match?.[1] ?? null;
}

function normalizeCommandOutput(value: string | Buffer): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return value.toString("utf8").trim();
}

function isCommandNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeError = error as NodeJS.ErrnoException;
  return maybeError.code === "ENOENT";
}

function formatSelfUpdateError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return formatError(error);
  }
  const maybeError = error as ExecFileException & {
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    message?: string;
  };
  const stderr = normalizeOptionalCommandOutput(maybeError.stderr);
  if (stderr) {
    return summarizeCommandOutput(stderr);
  }
  const stdout = normalizeOptionalCommandOutput(maybeError.stdout);
  if (stdout) {
    return summarizeCommandOutput(stdout);
  }
  return maybeError.message?.trim() || formatError(error);
}

function normalizeOptionalCommandOutput(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return normalizeCommandOutput(value);
}

function summarizeCommandOutput(text: string, maxLen = 400): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen)}...`;
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

function formatCacheTtl(ttlMs: number): string {
  if (ttlMs < 1_000) {
    return `${ttlMs}ms`;
  }
  if (ttlMs < 60_000) {
    return `${Math.round(ttlMs / 1_000)}s`;
  }
  if (ttlMs < 60 * 60_000) {
    return `${Math.round(ttlMs / 60_000)}m`;
  }
  return `${(ttlMs / (60 * 60_000)).toFixed(1)}h`;
}

function formatLatestUpgradeSummary(run: UpgradeRunRecord | null): string {
  if (!run) {
    return "暂无记录";
  }
  if (run.status === "running") {
    return `#${run.id} 进行中（startedAt=${new Date(run.startedAt).toISOString()}）`;
  }
  if (run.status === "succeeded") {
    return `#${run.id} 成功（target=${run.targetVersion ?? "latest"}, installed=${run.installedVersion ?? "unknown"}, at=${
      run.finishedAt ? new Date(run.finishedAt).toISOString() : "unknown"
    }）`;
  }
  return `#${run.id} 失败（target=${run.targetVersion ?? "latest"}, at=${
    run.finishedAt ? new Date(run.finishedAt).toISOString() : "unknown"
  }, error=${run.error ?? "unknown"}）`;
}

function formatRecentUpgradeRunsSummary(runs: UpgradeRunRecord[]): string {
  if (runs.length === 0) {
    return "暂无记录";
  }
  return runs
    .map((run) => {
      const statusText = run.status === "succeeded" ? "ok" : run.status === "failed" ? "failed" : "running";
      const time = run.finishedAt ?? run.startedAt;
      return `#${run.id}:${statusText}@${new Date(time).toISOString()}`;
    })
    .join(" | ");
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

function buildWorkflowResultReply(result: {
  objective: string;
  plan: string;
  output: string;
  review: string;
  approved: boolean;
  repairRounds: number;
  durationMs: number;
}): string {
  return `[CodeHarbor] Multi-Agent workflow 完成
- objective: ${result.objective}
- approved: ${result.approved ? "yes" : "no"}
- repairRounds: ${result.repairRounds}
- duration: ${formatDurationMs(result.durationMs)}

[planner]
${result.plan}
[/planner]

[executor]
${result.output}
[/executor]

[reviewer]
${result.review}
[/reviewer]`;
}
