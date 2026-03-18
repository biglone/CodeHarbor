import { Mutex } from "async-mutex";
import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { AudioTranscriber, type AudioTranscriberLike, type AudioTranscript } from "./audio-transcriber";
import { type Channel } from "./channels/channel";
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
import {
  DEFAULT_DOCUMENT_MAX_BYTES,
  extractDocumentText,
  type SupportedDocumentFormat,
} from "./document-extractor";
import { Logger } from "./logger";
import {
  DEFAULT_DURATION_HISTOGRAM_BUCKETS_MS,
  MutableHistogram,
  type AutoDevLoopStopReasonMetric,
  type AutoDevRunOutcomeMetric,
  type RequestOutcomeMetric,
  type RuntimeMetricsSnapshot,
} from "./metrics";
import {
  formatPackageUpdateHint,
  NpmRegistryUpdateChecker,
  type PackageUpdateChecker,
  resolvePackageVersion,
} from "./package-update-checker";
import { RateLimiter, type RateLimitDecision, type RateLimiterOptions } from "./rate-limiter";
import {
  ARCHIVE_REASON_MAX_ATTEMPTS,
  ARCHIVE_REASON_NON_RETRYABLE,
  classifyRetryDecision,
  createRetryPolicy,
  type RetryDecision,
  type RetryPolicy,
  type RetryPolicyInput,
} from "./reliability/retry-policy";
import {
  StateStore,
  type TaskFailureArchiveRecord,
  type TaskQueueEnqueueInput,
  type TaskQueuePendingSessionRecord,
  type TaskQueueRecord,
  type UpgradeExecutionLockRecord,
  type UpgradeRunRecord,
  type UpgradeRunStats,
} from "./store/state-store";
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
  type AutoDevTask,
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
    executionTimeoutMs?: number;
  };
  packageUpdateChecker?: PackageUpdateChecker;
  updateCheckTtlMs?: number;
  audioTranscriber?: AudioTranscriberLike;
  configService?: ConfigService;
  defaultCodexWorkdir?: string;
  aiCliProvider?: "codex" | "claude";
  aiCliModel?: string | null;
  matrixAdminUsers?: string[];
  executorFactory?: (provider: "codex" | "claude") => CodexExecutor;
  upgradeAllowedUsers?: string[];
  selfUpdateTimeoutMs?: number;
  selfUpdateRunner?: SelfUpdateRunner;
  upgradeRestartPlanner?: UpgradeRestartPlanner;
  upgradeVersionProbe?: UpgradeVersionProbe;
  taskQueueRecoveryEnabled?: boolean;
  taskQueueRecoveryBatchLimit?: number;
  taskQueueRetryPolicy?: RetryPolicyInput;
  autoDevLoopMaxRuns?: number;
  autoDevLoopMaxMinutes?: number;
  autoDevAutoCommit?: boolean;
  autoDevMaxConsecutiveFailures?: number;
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

type RequestOutcome = RequestOutcomeMetric;

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

interface ImageSelectionResult {
  imagePaths: string[];
  acceptedCount: number;
  skippedMissingPath: number;
  skippedUnsupportedMime: number;
  skippedTooLarge: number;
  skippedOverLimit: number;
  notice: string | null;
}

interface ExtractedDocumentContext {
  name: string;
  format: SupportedDocumentFormat;
  sizeBytes: number;
  text: string;
}

interface DocumentExtractionSummary {
  documents: ExtractedDocumentContext[];
  notice: string | null;
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
  mode: "idle" | "single" | "loop";
  loopRound: number;
  loopCompletedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAt: string | null;
  lastGitCommitSummary: string | null;
  lastGitCommitAt: string | null;
}

interface AutoDevGitBaseline {
  available: boolean;
  cleanBeforeRun: boolean;
}

type AutoDevGitCommitResult =
  | { kind: "committed"; commitHash: string; commitSubject: string; changedFiles: string[] }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string };

interface AutoDevRunContext {
  mode: "single" | "loop";
  loopRound: number;
  loopCompletedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAt: string | null;
}

interface AutoDevFailurePolicyResult {
  blocked: boolean;
  streak: number;
  task: AutoDevTask;
}

interface AutoDevGitCommitRecord {
  at: string;
  sessionKey: string;
  taskId: string;
  result: AutoDevGitCommitResult;
}

export interface ApiTaskSubmitInput {
  conversationId: string;
  senderId: string;
  text: string;
  idempotencyKey: string;
  requestId?: string;
  isDirectMessage?: boolean;
  mentionsBot?: boolean;
  repliesToBot?: boolean;
}

export interface ApiTaskSubmitResult {
  created: boolean;
  task: TaskQueueRecord;
  sessionKey: string;
  eventId: string;
  requestId: string;
}

export type ApiTaskStage = "queued" | "retrying" | "executing" | "completed" | "failed";

export interface ApiTaskQueryResult {
  taskId: number;
  status: TaskQueueRecord["status"];
  stage: ApiTaskStage;
  errorSummary: string | null;
}

export class ApiTaskIdempotencyConflictError extends Error {
  readonly sessionKey: string;
  readonly eventId: string;

  constructor(sessionKey: string, eventId: string) {
    super(`Idempotency-Key conflict for session ${sessionKey}: payload differs from existing request.`);
    this.sessionKey = sessionKey;
    this.eventId = eventId;
  }
}

interface SelfUpdateResult {
  installedVersion: string | null;
  stdout: string;
  stderr: string;
}
interface UpgradeVersionProbeResult {
  version: string | null;
  source: string;
  error: string | null;
}

type SelfUpdateRunner = (input: { version: string | null }) => Promise<SelfUpdateResult>;
interface UpgradeRestartPlan {
  summary: string;
  apply: () => Promise<void>;
}
type UpgradeRestartPlanner = () => Promise<UpgradeRestartPlan>;
type UpgradeVersionProbe = () => Promise<UpgradeVersionProbeResult>;
type UpgradeStateStore = Pick<
  StateStore,
  | "createUpgradeRun"
  | "finishUpgradeRun"
  | "getLatestUpgradeRun"
  | "listRecentUpgradeRuns"
  | "getUpgradeRunStats"
  | "acquireUpgradeExecutionLock"
  | "releaseUpgradeExecutionLock"
  | "getUpgradeExecutionLock"
>;

interface QueuedInboundPayload {
  message: InboundMessage;
  receivedAt: number;
  prompt: string | null;
}

type TaskQueueStateStore = Pick<
  StateStore,
  | "enqueueTask"
  | "claimNextTask"
  | "getTaskById"
  | "hasPendingTask"
  | "clearPendingTasks"
  | "listPendingTaskSessions"
  | "finishTask"
  | "failTask"
  | "scheduleRetry"
  | "failAndArchive"
  | "recoverTasks"
  | "hasReadyTask"
  | "getNextPendingRetryAt"
  | "getTaskQueueStatusCounts"
>;

type WorkflowDiagRunKind = "workflow" | "autodev";
type WorkflowDiagRunStatus = "running" | "succeeded" | "failed" | "cancelled";

interface WorkflowDiagRunRecord {
  runId: string;
  kind: WorkflowDiagRunKind;
  sessionKey: string;
  conversationId: string;
  requestId: string;
  objective: string;
  taskId: string | null;
  taskDescription: string | null;
  status: WorkflowDiagRunStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  approved: boolean | null;
  repairRounds: number;
  error: string | null;
  lastStage: string | null;
  lastMessage: string | null;
  updatedAt: string;
}

interface WorkflowDiagEventRecord {
  runId: string;
  kind: WorkflowDiagRunKind;
  stage: string;
  round: number;
  message: string;
  at: string;
}

interface WorkflowDiagStorePayload {
  version: 1;
  updatedAt: string;
  runs: WorkflowDiagRunRecord[];
  events: WorkflowDiagEventRecord[];
}

const RUN_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
const RUN_SNAPSHOT_MAX_ENTRIES = 500;
const CONTEXT_BRIDGE_HISTORY_LIMIT = 16;
const CONTEXT_BRIDGE_MAX_CHARS = 8_000;
const DEFAULT_SELF_UPDATE_TIMEOUT_MS = 20 * 60 * 1_000;
const DEFAULT_UPGRADE_LOCK_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_TASK_QUEUE_RECOVERY_BATCH_LIMIT = 200;
const WORKFLOW_DIAG_SNAPSHOT_KEY = "workflow_diag";
const WORKFLOW_DIAG_MAX_RUNS = 120;
const WORKFLOW_DIAG_MAX_EVENTS = 2_000;
const DEFAULT_AUTODEV_LOOP_MAX_RUNS = 20;
const DEFAULT_AUTODEV_LOOP_MAX_MINUTES = 120;
const DEFAULT_AUTODEV_MAX_CONSECUTIVE_FAILURES = 3;
const AUTODEV_GIT_COMMIT_HISTORY_MAX = 120;
const AUTODEV_GIT_ARTIFACT_BASENAME_REGEX = /^(autodev|workflow|planner|executor|reviewer)#\d+$/i;
const DEFAULT_TASK_QUEUE_RETRY_POLICY: RetryPolicyInput = {
  maxAttempts: 4,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
};

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
  private readonly queueDurationMs = new MutableHistogram(DEFAULT_DURATION_HISTOGRAM_BUCKETS_MS);
  private readonly executionDurationMs = new MutableHistogram(DEFAULT_DURATION_HISTOGRAM_BUCKETS_MS);
  private readonly sendDurationMs = new MutableHistogram(DEFAULT_DURATION_HISTOGRAM_BUCKETS_MS);

  record(outcome: RequestOutcome, queueMs: number, execMs: number, sendMs: number): void {
    const safeQueueMs = Math.max(0, queueMs);
    const safeExecMs = Math.max(0, execMs);
    const safeSendMs = Math.max(0, sendMs);
    this.total += 1;
    this.totalQueueMs += safeQueueMs;
    this.totalExecMs += safeExecMs;
    this.totalSendMs += safeSendMs;
    this.queueDurationMs.observe(safeQueueMs);
    this.executionDurationMs.observe(safeExecMs);
    this.sendDurationMs.observe(safeSendMs);

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

  runtimeSnapshot(): RuntimeMetricsSnapshot["request"] {
    return {
      total: this.total,
      outcomes: {
        success: this.success,
        failed: this.failed,
        timeout: this.timeout,
        cancelled: this.cancelled,
        rate_limited: this.rateLimited,
        ignored: this.ignored,
        duplicate: this.duplicate,
      },
      queueDurationMs: this.queueDurationMs.snapshot(),
      executionDurationMs: this.executionDurationMs.snapshot(),
      sendDurationMs: this.sendDurationMs.snapshot(),
    };
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

class AutoDevRuntimeMetrics {
  private succeeded = 0;
  private failed = 0;
  private cancelled = 0;
  private loopNoTask = 0;
  private loopDrained = 0;
  private loopMaxRuns = 0;
  private loopDeadline = 0;
  private loopStopRequested = 0;
  private loopTaskIncomplete = 0;
  private tasksBlocked = 0;

  recordRunOutcome(outcome: AutoDevRunOutcomeMetric): void {
    if (outcome === "succeeded") {
      this.succeeded += 1;
      return;
    }
    if (outcome === "failed") {
      this.failed += 1;
      return;
    }
    this.cancelled += 1;
  }

  recordLoopStop(reason: AutoDevLoopStopReasonMetric): void {
    if (reason === "no_task") {
      this.loopNoTask += 1;
      return;
    }
    if (reason === "drained") {
      this.loopDrained += 1;
      return;
    }
    if (reason === "max_runs") {
      this.loopMaxRuns += 1;
      return;
    }
    if (reason === "deadline") {
      this.loopDeadline += 1;
      return;
    }
    if (reason === "stop_requested") {
      this.loopStopRequested += 1;
      return;
    }
    this.loopTaskIncomplete += 1;
  }

  recordTaskBlocked(): void {
    this.tasksBlocked += 1;
  }

  runtimeSnapshot(): RuntimeMetricsSnapshot["autodev"] {
    return {
      runs: {
        succeeded: this.succeeded,
        failed: this.failed,
        cancelled: this.cancelled,
      },
      loopStops: {
        no_task: this.loopNoTask,
        drained: this.loopDrained,
        max_runs: this.loopMaxRuns,
        deadline: this.loopDeadline,
        stop_requested: this.loopStopRequested,
        task_incomplete: this.loopTaskIncomplete,
      },
      tasksBlocked: this.tasksBlocked,
    };
  }
}

interface MediaMetricCounters {
  imageAccepted: number;
  imageSkippedMissingPath: number;
  imageSkippedUnsupportedMime: number;
  imageSkippedTooLarge: number;
  imageSkippedOverLimit: number;
  audioTranscribed: number;
  audioFailed: number;
  audioSkippedTooLarge: number;
  claudeImageFallbackTriggered: number;
  claudeImageFallbackSucceeded: number;
  claudeImageFallbackFailed: number;
}

interface MediaMetricEvent {
  at: string;
  type: string;
  requestId: string;
  sessionKey: string;
  detail: string;
}

class MediaMetrics {
  private readonly counters: MediaMetricCounters = {
    imageAccepted: 0,
    imageSkippedMissingPath: 0,
    imageSkippedUnsupportedMime: 0,
    imageSkippedTooLarge: 0,
    imageSkippedOverLimit: 0,
    audioTranscribed: 0,
    audioFailed: 0,
    audioSkippedTooLarge: 0,
    claudeImageFallbackTriggered: 0,
    claudeImageFallbackSucceeded: 0,
    claudeImageFallbackFailed: 0,
  };

  private readonly events: MediaMetricEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 300) {
    this.maxEvents = Math.max(20, maxEvents);
  }

  recordImageSelection(input: { requestId: string; sessionKey: string; result: ImageSelectionResult }): void {
    const { requestId, sessionKey, result } = input;
    if (result.imagePaths.length > 0) {
      this.counters.imageAccepted += result.imagePaths.length;
      this.pushEvent(requestId, sessionKey, "image.accepted", `count=${result.imagePaths.length}`);
    }
    if (result.skippedMissingPath > 0) {
      this.counters.imageSkippedMissingPath += result.skippedMissingPath;
      this.pushEvent(requestId, sessionKey, "image.skipped_missing_path", `count=${result.skippedMissingPath}`);
    }
    if (result.skippedUnsupportedMime > 0) {
      this.counters.imageSkippedUnsupportedMime += result.skippedUnsupportedMime;
      this.pushEvent(requestId, sessionKey, "image.skipped_mime", `count=${result.skippedUnsupportedMime}`);
    }
    if (result.skippedTooLarge > 0) {
      this.counters.imageSkippedTooLarge += result.skippedTooLarge;
      this.pushEvent(requestId, sessionKey, "image.skipped_size", `count=${result.skippedTooLarge}`);
    }
    if (result.skippedOverLimit > 0) {
      this.counters.imageSkippedOverLimit += result.skippedOverLimit;
      this.pushEvent(requestId, sessionKey, "image.skipped_limit", `count=${result.skippedOverLimit}`);
    }
  }

  recordAudioTranscription(input: {
    requestId: string;
    sessionKey: string;
    transcribedCount: number;
    failedCount: number;
    skippedTooLarge: number;
  }): void {
    const { requestId, sessionKey, transcribedCount, failedCount, skippedTooLarge } = input;
    if (transcribedCount > 0) {
      this.counters.audioTranscribed += transcribedCount;
      this.pushEvent(requestId, sessionKey, "audio.transcribed", `count=${transcribedCount}`);
    }
    if (failedCount > 0) {
      this.counters.audioFailed += failedCount;
      this.pushEvent(requestId, sessionKey, "audio.failed", `count=${failedCount}`);
    }
    if (skippedTooLarge > 0) {
      this.counters.audioSkippedTooLarge += skippedTooLarge;
      this.pushEvent(requestId, sessionKey, "audio.skipped_size", `count=${skippedTooLarge}`);
    }
  }

  recordClaudeImageFallback(
    status: "triggered" | "succeeded" | "failed",
    input: { requestId: string; sessionKey: string; detail: string },
  ): void {
    if (status === "triggered") {
      this.counters.claudeImageFallbackTriggered += 1;
      this.pushEvent(input.requestId, input.sessionKey, "claude.image_fallback_triggered", input.detail);
      return;
    }
    if (status === "succeeded") {
      this.counters.claudeImageFallbackSucceeded += 1;
      this.pushEvent(input.requestId, input.sessionKey, "claude.image_fallback_succeeded", input.detail);
      return;
    }
    this.counters.claudeImageFallbackFailed += 1;
    this.pushEvent(input.requestId, input.sessionKey, "claude.image_fallback_failed", input.detail);
  }

  snapshot(limit = 10): { counters: MediaMetricCounters; recentEvents: MediaMetricEvent[] } {
    const safeLimit = Math.max(1, Math.floor(limit));
    return {
      counters: { ...this.counters },
      recentEvents: this.events.slice(Math.max(0, this.events.length - safeLimit)).reverse(),
    };
  }

  private pushEvent(requestId: string, sessionKey: string, type: string, detail: string): void {
    this.events.push({
      at: new Date().toISOString(),
      type,
      requestId,
      sessionKey,
      detail,
    });
    if (this.events.length <= this.maxEvents) {
      return;
    }
    this.events.splice(0, this.events.length - this.maxEvents);
  }
}

export class Orchestrator {
  private readonly channel: Channel;
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
  private readonly taskQueueRecoveryEnabled: boolean;
  private readonly taskQueueRecoveryBatchLimit: number;
  private readonly taskQueueRetryPolicy: RetryPolicy;
  private readonly sessionQueueDrains = new Map<string, Promise<void>>();
  private readonly sessionQueueRetryTimers = new Map<string, NodeJS.Timeout>();
  private aiCliProvider: "codex" | "claude";
  private readonly aiCliModel: string | null;
  private readonly botNoticePrefix: string;
  private readonly processStartedAtIso: string;
  private readonly matrixAdminUsers: Set<string>;
  private readonly workflowSnapshots = new Map<string, WorkflowRunSnapshot>();
  private readonly autoDevSnapshots = new Map<string, AutoDevRunSnapshot>();
  private readonly autoDevFailureStreaks = new Map<string, number>();
  private readonly autoDevGitCommitRecords: AutoDevGitCommitRecord[] = [];
  private readonly autoDevLoopMaxRuns: number;
  private readonly autoDevLoopMaxMinutes: number;
  private readonly autoDevAutoCommit: boolean;
  private readonly autoDevMaxConsecutiveFailures: number;
  private readonly upgradeAllowedUsers: Set<string>;
  private readonly upgradeLockOwner: string;
  private readonly selfUpdateRunner: SelfUpdateRunner;
  private readonly upgradeRestartPlanner: UpgradeRestartPlanner;
  private readonly upgradeVersionProbe: UpgradeVersionProbe;
  private readonly upgradeMutex = new Mutex();
  private readonly metrics = new RequestMetrics();
  private readonly autoDevMetrics = new AutoDevRuntimeMetrics();
  private readonly mediaMetrics = new MediaMetrics();
  private workflowDiagStore: WorkflowDiagStorePayload = createEmptyWorkflowDiagStorePayload();
  private lastLockPruneAt = 0;

  constructor(
    channel: Channel,
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
      imageMaxBytes: 10_485_760,
      imageMaxCount: 4,
      imageAllowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
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
      executionTimeoutMs: options?.multiAgentWorkflow?.executionTimeoutMs,
    });
    this.autoDevLoopMaxRuns = Math.max(
      1,
      options?.autoDevLoopMaxRuns ??
        parseEnvPositiveInt(process.env.AUTODEV_LOOP_MAX_RUNS, DEFAULT_AUTODEV_LOOP_MAX_RUNS),
    );
    this.autoDevLoopMaxMinutes = Math.max(
      1,
      options?.autoDevLoopMaxMinutes ??
        parseEnvPositiveInt(process.env.AUTODEV_LOOP_MAX_MINUTES, DEFAULT_AUTODEV_LOOP_MAX_MINUTES),
    );
    this.autoDevAutoCommit = options?.autoDevAutoCommit ?? parseEnvBoolean(process.env.AUTODEV_AUTO_COMMIT, true);
    this.autoDevMaxConsecutiveFailures = Math.max(
      1,
      options?.autoDevMaxConsecutiveFailures ??
        parseEnvPositiveInt(process.env.AUTODEV_MAX_CONSECUTIVE_FAILURES, DEFAULT_AUTODEV_MAX_CONSECUTIVE_FAILURES),
    );
    const currentVersion = resolvePackageVersion();
    this.botNoticePrefix = `[CodeHarbor v${currentVersion}]`;
    this.packageUpdateChecker =
      options?.packageUpdateChecker ??
      new NpmRegistryUpdateChecker({
        packageName: "codeharbor",
        currentVersion,
      });
    this.updateCheckTtlMs = Math.max(0, options?.updateCheckTtlMs ?? 6 * 60 * 60 * 1000);
    this.taskQueueRecoveryEnabled = options?.taskQueueRecoveryEnabled ?? true;
    this.taskQueueRecoveryBatchLimit = Math.max(
      1,
      options?.taskQueueRecoveryBatchLimit ?? DEFAULT_TASK_QUEUE_RECOVERY_BATCH_LIMIT,
    );
    this.taskQueueRetryPolicy = createRetryPolicy({
      ...DEFAULT_TASK_QUEUE_RETRY_POLICY,
      ...options?.taskQueueRetryPolicy,
    });
    this.executorFactory = options?.executorFactory ?? null;
    this.aiCliProvider = options?.aiCliProvider ?? "codex";
    this.aiCliModel = options?.aiCliModel?.trim() || null;
    this.matrixAdminUsers = new Set(
      (options?.matrixAdminUsers ?? parseCsvValues(process.env.MATRIX_ADMIN_USERS ?? ""))
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
    this.upgradeAllowedUsers = new Set(
      (options?.upgradeAllowedUsers ?? parseCsvValues(process.env.MATRIX_UPGRADE_ALLOWED_USERS ?? ""))
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    );
    this.upgradeLockOwner = `pid:${process.pid}@${os.hostname()}`;
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
    this.upgradeVersionProbe = options?.upgradeVersionProbe ?? (() => probeInstalledVersion(selfUpdateTimeoutMs));
    this.processStartedAtIso = new Date(Date.now() - process.uptime() * 1_000).toISOString();
    this.sessionRuntime = new CodexSessionRuntime(this.executor);
    this.workflowDiagStore = this.restoreWorkflowDiagStore();
    this.persistRuntimeMetricsSnapshot();
  }

  async handleMessage(message: InboundMessage): Promise<void> {
    await this.handleMessageInternal(message, Date.now(), {
      bypassQueue: false,
      forcedPrompt: null,
      deferFailureHandlingToQueue: false,
    });
  }

  submitApiTask(input: ApiTaskSubmitInput): ApiTaskSubmitResult {
    const queueStore = this.getTaskQueueStateStore();
    if (!queueStore) {
      throw new Error("Task queue is unavailable.");
    }

    const normalizedConversationId = input.conversationId.trim();
    const normalizedSenderId = input.senderId.trim();
    const normalizedText = input.text.trim();
    const eventId = buildApiTaskEventId(input.idempotencyKey);
    const requestId = normalizeApiTaskRequestId(input.requestId, eventId);
    const message: InboundMessage = {
      requestId,
      channel: "matrix",
      conversationId: normalizedConversationId,
      senderId: normalizedSenderId,
      eventId,
      text: normalizedText,
      attachments: [],
      isDirectMessage: input.isDirectMessage ?? true,
      mentionsBot: input.mentionsBot ?? false,
      repliesToBot: input.repliesToBot ?? false,
    };
    const sessionKey = buildSessionKey(message);
    const payload: QueuedInboundPayload = {
      message,
      receivedAt: Date.now(),
      prompt: message.text,
    };

    const result = queueStore.enqueueTask({
      sessionKey,
      eventId: message.eventId,
      requestId: message.requestId,
      payloadJson: JSON.stringify(payload),
    } satisfies TaskQueueEnqueueInput);

    if (!result.created) {
      const existing = parseQueuedInboundPayload(result.task.payloadJson);
      if (!isApiTaskPayloadEquivalent(existing.message, message)) {
        throw new ApiTaskIdempotencyConflictError(sessionKey, eventId);
      }
    }

    this.startSessionQueueDrain(sessionKey);
    return {
      created: result.created,
      task: result.task,
      sessionKey,
      eventId: result.task.eventId,
      requestId: result.task.requestId,
    };
  }

  getApiTaskById(taskId: number): ApiTaskQueryResult | null {
    const queueStore = this.getTaskQueueStateStore();
    if (!queueStore) {
      throw new Error("Task queue is unavailable.");
    }

    const task = queueStore.getTaskById(taskId);
    if (!task) {
      return null;
    }
    return {
      taskId: task.id,
      status: task.status,
      stage: mapApiTaskStage(task),
      errorSummary: buildApiTaskErrorSummary(task),
    };
  }

  async bootstrapTaskQueueRecovery(): Promise<void> {
    const queueStore = this.getTaskQueueStateStore();
    if (!queueStore) {
      return;
    }
    if (!this.taskQueueRecoveryEnabled) {
      this.logger.info("Task queue recovery disabled by configuration.");
      return;
    }

    try {
      const recovery = queueStore.recoverTasks(this.taskQueueRecoveryBatchLimit);
      const sessions = new Set<string>(recovery.tasks.map((task) => task.sessionKey));
      let afterTaskId = 0;
      while (true) {
        const batch = queueStore.listPendingTaskSessions(this.taskQueueRecoveryBatchLimit, afterTaskId);
        if (batch.length === 0) {
          break;
        }
        for (const item of batch) {
          sessions.add(item.sessionKey);
          afterTaskId = item.firstTaskId;
        }
      }
      for (const sessionKey of sessions) {
        this.startSessionQueueDrain(sessionKey);
      }
      this.logger.info("Task queue recovery completed", {
        requeuedRunning: recovery.requeuedRunning,
        pendingTotal: recovery.pendingTotal,
        recoveredSessions: sessions.size,
        hasMorePending: recovery.hasMorePending,
      });
    } catch (error) {
      this.logger.error("Failed to recover task queue", {
        error: formatError(error),
      });
    }
  }

  private async handleMessageInternal(
    message: InboundMessage,
    receivedAt: number,
    options: {
      bypassQueue: boolean;
      forcedPrompt: string | null;
      deferFailureHandlingToQueue: boolean;
    },
  ): Promise<void> {
    const attachmentPaths = collectLocalAttachmentPaths(message);
    let deferAttachmentCleanup = false;
    let queueDrainSessionKey: string | null = null;

    try {
      const requestId = message.requestId || message.eventId;
      const sessionKey = buildSessionKey(message);

      const directCommand = parseControlCommand(message.text.trim());
      if (directCommand === "stop") {
        if (this.stateStore.hasProcessedEvent(sessionKey, message.eventId)) {
          this.recordRequestMetrics("duplicate", 0, 0, 0);
          this.logger.debug("Duplicate stop command ignored", { requestId, eventId: message.eventId, sessionKey });
          return;
        }
        await this.handleStopCommand(sessionKey, message, requestId);
        this.stateStore.markEventProcessed(sessionKey, message.eventId);
        return;
      }

      if (!options.bypassQueue && options.forcedPrompt === null) {
        const queueWaitMs = Date.now() - receivedAt;
        const roomConfig = this.resolveRoomRuntimeConfig(message.conversationId);
        const route = this.routeMessage(message, sessionKey, roomConfig);
        const handledWithoutLock = await this.tryHandleNonBlockingStatusRoute({
          route,
          sessionKey,
          message,
          requestId,
          roomConfig,
          queueWaitMs,
        });
        if (handledWithoutLock) {
          return;
        }
      }

      const lock = this.getLock(sessionKey);
      await lock.runExclusive(async () => {
        const queueWaitMs = Date.now() - receivedAt;

        if (this.stateStore.hasProcessedEvent(sessionKey, message.eventId)) {
          this.recordRequestMetrics("duplicate", queueWaitMs, 0, 0);
          this.logger.debug("Duplicate event ignored", { requestId, eventId: message.eventId, sessionKey, queueWaitMs });
          return;
        }

        const roomConfig = this.resolveRoomRuntimeConfig(message.conversationId);
        const route: RouteDecision =
          options.forcedPrompt === null
            ? this.routeMessage(message, sessionKey, roomConfig)
            : { kind: "execute", prompt: options.forcedPrompt };
        if (route.kind === "ignore") {
          this.recordRequestMetrics("ignored", queueWaitMs, 0, 0);
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

        if (!options.bypassQueue) {
          const queueStore = this.getTaskQueueStateStore();
          if (queueStore) {
            const payload: QueuedInboundPayload = {
              message,
              receivedAt,
              prompt: route.prompt,
            };
            const enqueueResult = queueStore.enqueueTask({
              sessionKey,
              eventId: message.eventId,
              requestId,
              payloadJson: JSON.stringify(payload),
            } satisfies TaskQueueEnqueueInput);

            if (!enqueueResult.created) {
              this.recordRequestMetrics("duplicate", queueWaitMs, 0, 0);
              this.logger.debug("Duplicate event ignored by task queue dedupe", {
                requestId,
                eventId: message.eventId,
                sessionKey,
                queueWaitMs,
              });
              return;
            }

            deferAttachmentCleanup = true;
            queueDrainSessionKey = sessionKey;
            this.logger.debug("Inbound request queued", {
              requestId,
              eventId: message.eventId,
              sessionKey,
              taskId: enqueueResult.task.id,
            });
            return;
          }
        }

        const rateDecision = this.rateLimiter.tryAcquire({
          userId: message.senderId,
          roomId: message.conversationId,
        });
        if (!rateDecision.allowed) {
          this.recordRequestMetrics("rate_limited", queueWaitMs, 0, 0);
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
            this.recordRequestMetrics("success", queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
          } catch (error) {
            if (!options.deferFailureHandlingToQueue) {
              sendDurationMs += await this.sendWorkflowFailure(message.conversationId, error);
              this.stateStore.commitExecutionHandled(sessionKey, message.eventId);
            }
            const status = classifyExecutionOutcome(error);
            this.recordRequestMetrics(status, queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
            this.logger.error("Workflow request failed", {
              requestId,
              sessionKey,
              error: formatError(error),
            });
            if (options.deferFailureHandlingToQueue) {
              throw error;
            }
          } finally {
            rateDecision.release?.();
            this.persistRuntimeMetricsSnapshot();
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
            this.recordRequestMetrics("success", queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
          } catch (error) {
            if (!options.deferFailureHandlingToQueue) {
              sendDurationMs += await this.sendAutoDevFailure(message.conversationId, error);
              this.stateStore.commitExecutionHandled(sessionKey, message.eventId);
            }
            const status = classifyExecutionOutcome(error);
            this.recordRequestMetrics(status, queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
            this.logger.error("AutoDev request failed", {
              requestId,
              sessionKey,
              error: formatError(error),
            });
            if (options.deferFailureHandlingToQueue) {
              throw error;
            }
          } finally {
            rateDecision.release?.();
            this.persistRuntimeMetricsSnapshot();
          }
          return;
        }

        this.stateStore.activateSession(sessionKey, this.sessionActiveWindowMs);
        const previousCodexSessionId = this.stateStore.getCodexSessionId(sessionKey);
        const allowBridgeContext =
          previousCodexSessionId === null && !this.skipBridgeForNextPrompt.delete(sessionKey);
        const bridgeContext = allowBridgeContext ? this.buildConversationBridgeContext(sessionKey) : null;
        const audioTranscripts = await this.transcribeAudioAttachments(message, requestId, sessionKey);
        const imageSelection = await this.prepareImageAttachments(message, requestId, sessionKey);
        this.mediaMetrics.recordImageSelection({
          requestId,
          sessionKey,
          result: imageSelection,
        });
        if (imageSelection.notice) {
          await this.channel.sendNotice(message.conversationId, imageSelection.notice);
        }
        const documentSummary = await this.prepareDocumentAttachments(message, requestId, sessionKey);
        if (documentSummary.notice) {
          await this.channel.sendNotice(message.conversationId, documentSummary.notice);
        }
        const executionPrompt = this.buildExecutionPrompt(
          route.prompt,
          message,
          audioTranscripts,
          documentSummary.documents,
          bridgeContext,
        );
        const imagePaths = imageSelection.imagePaths;
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
        this.persistRuntimeMetricsSnapshot();

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
          const executeOnce = async (attemptImagePaths: string[]): Promise<{ sessionId: string; reply: string }> => {
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
                imagePaths: attemptImagePaths,
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
            return executionHandle.result;
          };

          let result: { sessionId: string; reply: string };
          try {
            result = await executeOnce(imagePaths);
          } catch (error) {
            if (!shouldRetryClaudeImageFailure(this.aiCliProvider, imagePaths, error)) {
              throw error;
            }
            const reason = summarizeSingleLine(formatError(error), 220);
            this.mediaMetrics.recordClaudeImageFallback("triggered", {
              requestId,
              sessionKey,
              detail: reason,
            });
            await this.channel.sendNotice(
              message.conversationId,
              `[CodeHarbor] 检测到 Claude 图片处理失败，已自动降级为纯文本重试。原因: ${reason}`,
            );
            this.logger.warn("Claude image execution failed, retrying without image inputs", {
              requestId,
              sessionKey,
              imageCount: imagePaths.length,
              reason: formatError(error),
            });
            try {
              result = await executeOnce([]);
              this.mediaMetrics.recordClaudeImageFallback("succeeded", {
                requestId,
                sessionKey,
                detail: "retry_without_images_ok",
              });
            } catch (retryError) {
              this.mediaMetrics.recordClaudeImageFallback("failed", {
                requestId,
                sessionKey,
                detail: summarizeSingleLine(formatError(retryError), 220),
              });
              throw retryError;
            }
          }

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
          this.recordRequestMetrics("success", queueWaitMs, executionDurationMs, sendDurationMs);
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

          if (status !== "cancelled" && !options.deferFailureHandlingToQueue) {
            try {
              await this.channel.sendMessage(
                message.conversationId,
                `[CodeHarbor] Failed to process request: ${formatError(error)}`,
              );
            } catch (sendError) {
              this.logger.error("Failed to send error reply to Matrix", sendError);
            }
          }

          if (!options.deferFailureHandlingToQueue) {
            this.stateStore.commitExecutionHandled(sessionKey, message.eventId);
          }
          this.recordRequestMetrics(status, queueWaitMs, executionDurationMs, sendDurationMs);
          this.logger.error("Request failed", {
            requestId,
            sessionKey,
            status,
            queueWaitMs,
            executionDurationMs,
            totalDurationMs: Date.now() - receivedAt,
            error: formatError(error),
          });
          if (options.deferFailureHandlingToQueue) {
            throw error;
          }
        } finally {
          const running = this.runningExecutions.get(sessionKey);
          if (running?.requestId === requestId) {
            this.runningExecutions.delete(sessionKey);
          }
          rateDecision.release?.();
          this.persistRuntimeMetricsSnapshot();
          await stopTyping();
        }
      });
    } finally {
      if (!deferAttachmentCleanup) {
        await cleanupAttachmentFiles(attachmentPaths);
      }
    }

    if (queueDrainSessionKey) {
      this.startSessionQueueDrain(queueDrainSessionKey);
    }
  }

  private async tryHandleNonBlockingStatusRoute(input: {
    route: RouteDecision;
    sessionKey: string;
    message: InboundMessage;
    requestId: string;
    roomConfig: RoomRuntimeConfig;
    queueWaitMs: number;
  }): Promise<boolean> {
    const { route, sessionKey, message, requestId, roomConfig, queueWaitMs } = input;
    const isReadOnlyControlCommand =
      route.kind === "command" &&
      (route.command === "status" || route.command === "version" || route.command === "help" || route.command === "diag");
    const workflowCommand = route.kind === "execute" && this.workflowRunner.isEnabled() ? parseWorkflowCommand(route.prompt) : null;
    const autoDevCommand = route.kind === "execute" && this.workflowRunner.isEnabled() ? parseAutoDevCommand(route.prompt) : null;
    const isWorkflowStatus = workflowCommand?.kind === "status";
    const isAutoDevStatus = autoDevCommand?.kind === "status";

    if (!isReadOnlyControlCommand && !isWorkflowStatus && !isAutoDevStatus) {
      return false;
    }

    if (this.stateStore.hasProcessedEvent(sessionKey, message.eventId)) {
      this.recordRequestMetrics("duplicate", queueWaitMs, 0, 0);
      this.logger.debug("Duplicate non-blocking status command ignored", {
        requestId,
        eventId: message.eventId,
        sessionKey,
        queueWaitMs,
      });
      return true;
    }

    if (isReadOnlyControlCommand) {
      await this.handleControlCommand(route.command, sessionKey, message, requestId);
    } else if (isWorkflowStatus) {
      await this.handleWorkflowStatusCommand(sessionKey, message);
    } else {
      await this.handleAutoDevStatusCommand(sessionKey, message, roomConfig.workdir);
    }
    this.stateStore.markEventProcessed(sessionKey, message.eventId);
    this.logger.debug("Handled non-blocking status command without waiting for session lock", {
      requestId,
      eventId: message.eventId,
      sessionKey,
      route: route.kind === "command" ? route.command : isWorkflowStatus ? "workflow.status" : "autodev.status",
      queueWaitMs,
    });
    return true;
  }

  private startSessionQueueDrain(sessionKey: string): void {
    if (this.sessionQueueDrains.has(sessionKey)) {
      return;
    }
    this.clearSessionQueueRetryTimer(sessionKey);

    const queueStore = this.getTaskQueueStateStore();
    if (!queueStore) {
      return;
    }
    try {
      if (!queueStore.hasReadyTask(sessionKey)) {
        this.scheduleSessionQueueDrainAtNextRetry(sessionKey, queueStore);
        return;
      }
    } catch (error) {
      this.logger.warn("Failed to inspect ready queued task before drain", {
        sessionKey,
        error: formatError(error),
      });
      return;
    }

    const drainPromise = this.drainSessionQueue(sessionKey)
      .catch((error) => {
        this.logger.error("Session task queue drain failed", {
          sessionKey,
          error: formatError(error),
        });
      })
      .finally(() => {
        const current = this.sessionQueueDrains.get(sessionKey);
        if (current === drainPromise) {
          this.sessionQueueDrains.delete(sessionKey);
        }
        this.reconcileSessionQueueDrain(sessionKey);
      });

    this.sessionQueueDrains.set(sessionKey, drainPromise);
  }

  private async drainSessionQueue(sessionKey: string): Promise<void> {
    const queueStore = this.getTaskQueueStateStore();
    if (!queueStore) {
      return;
    }

    while (true) {
      const task = queueStore.claimNextTask(sessionKey);
      if (!task) {
        return;
      }

      let payload: QueuedInboundPayload | null = null;
      try {
        payload = parseQueuedInboundPayload(task.payloadJson);
        await this.handleMessageInternal(payload.message, payload.receivedAt, {
          bypassQueue: true,
          forcedPrompt: payload.prompt,
          deferFailureHandlingToQueue: true,
        });
        queueStore.finishTask(task.id);
        this.logger.debug("Queued task completed", {
          taskId: task.id,
          sessionKey: task.sessionKey,
          eventId: task.eventId,
          attempt: task.attempt,
        });
      } catch (error) {
        const detail = summarizeSingleLine(formatError(error), 400);
        const retryDecision = classifyQueueTaskRetry(this.taskQueueRetryPolicy, task.attempt, error);

        if (retryDecision.shouldRetry) {
          const delayMs = retryDecision.retryDelayMs ?? 0;
          const nextRetryAt = Date.now() + delayMs;
          queueStore.scheduleRetry(task.id, {
            nextRetryAt,
            error: detail,
          });
          this.logger.warn("Queued task scheduled for retry", {
            taskId: task.id,
            sessionKey: task.sessionKey,
            eventId: task.eventId,
            attempt: task.attempt,
            retryable: retryDecision.retryable,
            nextRetryAt,
            nextRetryAtIso: new Date(nextRetryAt).toISOString(),
            retryDelayMs: delayMs,
            retryReason: retryDecision.retryReason,
            retryAfterMs: retryDecision.retryAfterMs,
            error: formatError(error),
          });
          continue;
        }

        const archiveReason = retryDecision.archiveReason ?? ARCHIVE_REASON_NON_RETRYABLE;
        queueStore.failAndArchive(task.id, {
          error: detail,
          retryReason: retryDecision.retryReason,
          archiveReason,
          retryAfterMs: retryDecision.retryAfterMs,
        });
        this.stateStore.commitExecutionHandled(task.sessionKey, task.eventId);

        if (payload && archiveReason !== "cancelled") {
          await this.sendQueuedTaskFailureNotice(payload.message.conversationId, {
            attempt: task.attempt,
            retryReason: retryDecision.retryReason,
            archiveReason,
            retryAfterMs: retryDecision.retryAfterMs,
            detail,
          });
        }

        this.logger.error("Queued task archived after failure", {
          taskId: task.id,
          sessionKey: task.sessionKey,
          eventId: task.eventId,
          attempt: task.attempt,
          retryable: retryDecision.retryable,
          retryReason: retryDecision.retryReason,
          retryAfterMs: retryDecision.retryAfterMs,
          archiveReason,
          error: formatError(error),
        });
      }
    }
  }

  private reconcileSessionQueueDrain(sessionKey: string): void {
    const queueStore = this.getTaskQueueStateStore();
    if (!queueStore) {
      return;
    }
    try {
      if (queueStore.hasReadyTask(sessionKey)) {
        this.startSessionQueueDrain(sessionKey);
        return;
      }
      this.scheduleSessionQueueDrainAtNextRetry(sessionKey, queueStore);
    } catch (error) {
      this.logger.warn("Failed to reconcile session queue drain state", {
        sessionKey,
        error: formatError(error),
      });
    }
  }

  private scheduleSessionQueueDrainAtNextRetry(sessionKey: string, queueStore: TaskQueueStateStore): void {
    const nextRetryAt = queueStore.getNextPendingRetryAt(sessionKey);
    if (nextRetryAt === null) {
      return;
    }
    this.scheduleSessionQueueDrain(sessionKey, nextRetryAt);
  }

  private scheduleSessionQueueDrain(sessionKey: string, nextRetryAt: number): void {
    this.clearSessionQueueRetryTimer(sessionKey);
    const safeNextRetryAt = Math.max(Date.now(), Math.floor(nextRetryAt));
    const delayMs = Math.max(0, safeNextRetryAt - Date.now());
    if (delayMs <= 0) {
      this.startSessionQueueDrain(sessionKey);
      return;
    }

    const timer = setTimeout(() => {
      const current = this.sessionQueueRetryTimers.get(sessionKey);
      if (current === timer) {
        this.sessionQueueRetryTimers.delete(sessionKey);
      }
      this.startSessionQueueDrain(sessionKey);
    }, delayMs);
    timer.unref?.();
    this.sessionQueueRetryTimers.set(sessionKey, timer);
    this.logger.debug("Session queue drain scheduled for next retry", {
      sessionKey,
      nextRetryAt: safeNextRetryAt,
      nextRetryAtIso: new Date(safeNextRetryAt).toISOString(),
      delayMs,
    });
  }

  private clearSessionQueueRetryTimer(sessionKey: string): void {
    const timer = this.sessionQueueRetryTimers.get(sessionKey);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.sessionQueueRetryTimers.delete(sessionKey);
  }

  private async sendQueuedTaskFailureNotice(
    conversationId: string,
    input: {
      attempt: number;
      retryReason: string;
      archiveReason: string;
      retryAfterMs: number | null;
      detail: string;
    },
  ): Promise<void> {
    const reasonText =
      input.archiveReason === ARCHIVE_REASON_MAX_ATTEMPTS
        ? `达到最大重试次数(${this.taskQueueRetryPolicy.maxAttempts})`
        : `不可重试错误(${input.archiveReason})`;
    const retryAfterText = input.retryAfterMs === null ? "n/a" : `${input.retryAfterMs}ms`;
    try {
      await this.channel.sendMessage(
        conversationId,
        `[CodeHarbor] 请求处理失败并已归档（attempt=${input.attempt}，retryReason=${input.retryReason}，archiveReason=${input.archiveReason}，retryAfterMs=${retryAfterText}，原因: ${reasonText}）：${input.detail}`,
      );
    } catch (error) {
      this.logger.error("Failed to send queued task failure notice", {
        conversationId,
        error: formatError(error),
      });
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
- /autodev status: 查看 AutoDev 任务状态与下一个任务
- /autodev run [taskId]: 执行指定任务；不指定时连续执行任务清单（示例: /autodev run T6.2）
- 多模态状态: ${this.formatMultimodalHelpStatus()}
- /diag version: 查看运行实例诊断信息
- /diag media [count]: 查看最近多模态处理诊断（count 默认 10）
- /diag upgrade [count]: 查看最近升级任务诊断（count 默认 5）
- /diag autodev [count]: 查看自动化开发运行诊断（count 默认 10）
- /diag queue [count]: 查看任务队列状态诊断（count 默认 10）
- /upgrade [version]: 升级并自动重启服务（仅私聊；优先 MATRIX_UPGRADE_ALLOWED_USERS，否则 MATRIX_ADMIN_USERS）
- /backend codex|claude|status: 查看/切换后端工具
- /reset: 清空当前会话上下文
- /stop: 停止当前执行任务
- Matrix 客户端若拦截 / 命令，可发送 //autodev run T6.2（兼容 //agents、//diag、//upgrade）
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
    const upgradeStats = this.getUpgradeRunStats();
    const upgradeLock = this.getUpgradeExecutionLockSnapshot();

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
- 升级指标: total=${upgradeStats.total}, succeeded=${upgradeStats.succeeded}, failed=${upgradeStats.failed}, running=${upgradeStats.running}, avg=${upgradeStats.avgDurationMs}ms
- 升级锁: ${formatUpgradeLockSummary(upgradeLock)}
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
- config: loopMaxRuns=${this.autoDevLoopMaxRuns}, loopMaxMinutes=${this.autoDevLoopMaxMinutes}, autoCommit=${this.autoDevAutoCommit ? "on" : "off"}, maxConsecutiveFailures=${this.autoDevMaxConsecutiveFailures}
- runState: ${snapshot.state}
- runTask: ${snapshot.taskId ? `${snapshot.taskId} ${snapshot.taskDescription ?? ""}`.trim() : "N/A"}
- runMode: ${snapshot.mode}
- runLoop: round=${snapshot.loopRound}, completed=${snapshot.loopCompletedRuns}/${snapshot.loopMaxRuns}, deadline=${snapshot.loopDeadlineAt ?? "N/A"}
- runApproved: ${snapshot.approved === null ? "N/A" : snapshot.approved ? "yes" : "no"}
- runError: ${snapshot.error ?? "N/A"}
- runGitCommit: ${snapshot.lastGitCommitSummary ?? "N/A"}
- runGitCommitAt: ${snapshot.lastGitCommitAt ?? "N/A"}`,
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
    runContext?: AutoDevRunContext,
  ): Promise<void> {
    const requestedTaskId = taskId?.trim() || null;
    const context = await loadAutoDevContext(workdir);
    const activeContext: AutoDevRunContext = runContext ?? {
      mode: requestedTaskId ? "single" : "loop",
      loopRound: requestedTaskId ? 1 : 0,
      loopCompletedRuns: 0,
      loopMaxRuns: requestedTaskId ? 1 : this.autoDevLoopMaxRuns,
      loopDeadlineAt:
        requestedTaskId || this.autoDevLoopMaxMinutes <= 0
          ? null
          : new Date(Date.now() + this.autoDevLoopMaxMinutes * 60_000).toISOString(),
    };
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

    if (!requestedTaskId) {
      const loopStartedAt = Date.now();
      const loopDeadlineAtIso = activeContext.loopDeadlineAt;
      const loopDeadlineAtMs = loopDeadlineAtIso ? Date.parse(loopDeadlineAtIso) : null;
      let completedRuns = 0;
      let attemptedRuns = 0;
      this.setAutoDevSnapshot(sessionKey, {
        state: "running",
        startedAt: new Date(loopStartedAt).toISOString(),
        endedAt: null,
        taskId: null,
        taskDescription: null,
        approved: null,
        repairRounds: 0,
        error: null,
        mode: "loop",
        loopRound: 0,
        loopCompletedRuns: 0,
        loopMaxRuns: activeContext.loopMaxRuns,
        loopDeadlineAt: loopDeadlineAtIso,
        lastGitCommitSummary: null,
        lastGitCommitAt: null,
      });
      while (true) {
        if (this.consumePendingStopRequest(sessionKey)) {
          this.autoDevMetrics.recordLoopStop("stop_requested");
          const endedAtIso = new Date().toISOString();
          this.setAutoDevSnapshot(sessionKey, {
            state: "idle",
            startedAt: new Date(loopStartedAt).toISOString(),
            endedAt: endedAtIso,
            taskId: null,
            taskDescription: null,
            approved: null,
            repairRounds: 0,
            error: "stopped by /stop",
            mode: "loop",
            loopRound: attemptedRuns,
            loopCompletedRuns: completedRuns,
            loopMaxRuns: activeContext.loopMaxRuns,
            loopDeadlineAt: loopDeadlineAtIso,
            lastGitCommitSummary: null,
            lastGitCommitAt: null,
          });
          await this.channel.sendNotice(
            message.conversationId,
            `[CodeHarbor] AutoDev 循环执行已停止。
- completedRuns: ${completedRuns}`,
          );
          return;
        }
        if (attemptedRuns >= activeContext.loopMaxRuns) {
          this.autoDevMetrics.recordLoopStop("max_runs");
          const endedAtIso = new Date().toISOString();
          this.setAutoDevSnapshot(sessionKey, {
            state: "succeeded",
            startedAt: new Date(loopStartedAt).toISOString(),
            endedAt: endedAtIso,
            taskId: null,
            taskDescription: null,
            approved: null,
            repairRounds: 0,
            error: null,
            mode: "loop",
            loopRound: attemptedRuns,
            loopCompletedRuns: completedRuns,
            loopMaxRuns: activeContext.loopMaxRuns,
            loopDeadlineAt: loopDeadlineAtIso,
            lastGitCommitSummary: null,
            lastGitCommitAt: null,
          });
          await this.channel.sendNotice(
            message.conversationId,
            `[CodeHarbor] AutoDev 循环执行已达到上限，已停止。
- attemptedRuns: ${attemptedRuns}
- completedRuns: ${completedRuns}
- loopMaxRuns: ${activeContext.loopMaxRuns}`,
          );
          return;
        }
        if (loopDeadlineAtMs !== null && Date.now() >= loopDeadlineAtMs) {
          this.autoDevMetrics.recordLoopStop("deadline");
          const endedAtIso = new Date().toISOString();
          this.setAutoDevSnapshot(sessionKey, {
            state: "succeeded",
            startedAt: new Date(loopStartedAt).toISOString(),
            endedAt: endedAtIso,
            taskId: null,
            taskDescription: null,
            approved: null,
            repairRounds: 0,
            error: null,
            mode: "loop",
            loopRound: attemptedRuns,
            loopCompletedRuns: completedRuns,
            loopMaxRuns: activeContext.loopMaxRuns,
            loopDeadlineAt: loopDeadlineAtIso,
            lastGitCommitSummary: null,
            lastGitCommitAt: null,
          });
          await this.channel.sendNotice(
            message.conversationId,
            `[CodeHarbor] AutoDev 循环执行已达到时间上限，已停止。
- attemptedRuns: ${attemptedRuns}
- completedRuns: ${completedRuns}
- loopDeadlineAt: ${loopDeadlineAtIso}`,
          );
          return;
        }

        const loopContext = await loadAutoDevContext(workdir);
        const loopTask = selectAutoDevTask(loopContext.tasks);
        if (!loopTask) {
          this.autoDevMetrics.recordLoopStop(completedRuns === 0 ? "no_task" : "drained");
          const endedAtIso = new Date().toISOString();
          this.setAutoDevSnapshot(sessionKey, {
            state: "succeeded",
            startedAt: new Date(loopStartedAt).toISOString(),
            endedAt: endedAtIso,
            taskId: null,
            taskDescription: null,
            approved: null,
            repairRounds: 0,
            error: null,
            mode: "loop",
            loopRound: attemptedRuns,
            loopCompletedRuns: completedRuns,
            loopMaxRuns: activeContext.loopMaxRuns,
            loopDeadlineAt: loopDeadlineAtIso,
            lastGitCommitSummary: null,
            lastGitCommitAt: null,
          });
          if (completedRuns === 0) {
            await this.channel.sendNotice(message.conversationId, "[CodeHarbor] 当前没有可执行任务（pending/in_progress）。");
            return;
          }
          const summary = summarizeAutoDevTasks(loopContext.tasks);
          await this.channel.sendNotice(
            message.conversationId,
            `[CodeHarbor] AutoDev 循环执行完成
- completedRuns: ${completedRuns}
- remaining: pending=${summary.pending}, in_progress=${summary.inProgress}, blocked=${summary.blocked}, cancelled=${summary.cancelled}`,
          );
          return;
        }

        attemptedRuns += 1;
        await this.handleAutoDevRunCommand(loopTask.id, sessionKey, message, requestId, workdir, {
          mode: "loop",
          loopRound: attemptedRuns,
          loopCompletedRuns: completedRuns,
          loopMaxRuns: activeContext.loopMaxRuns,
          loopDeadlineAt: loopDeadlineAtIso,
        });

        const refreshed = await loadAutoDevContext(workdir);
        const refreshedTask = selectAutoDevTask(refreshed.tasks, loopTask.id);
        if (refreshedTask?.status === "completed") {
          completedRuns += 1;
        }
        if (refreshedTask && refreshedTask.status !== "completed") {
          this.autoDevMetrics.recordLoopStop("task_incomplete");
          await this.channel.sendNotice(
            message.conversationId,
            `[CodeHarbor] AutoDev 循环执行暂停：任务 ${refreshedTask.id} 当前状态为 ${statusToSymbol(refreshedTask.status)}。请处理后继续。`,
          );
          return;
        }
      }
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

    const gitBaseline = await this.captureAutoDevGitBaseline(workdir);
    const effectiveContext: AutoDevRunContext = {
      mode: activeContext.mode,
      loopRound: Math.max(1, activeContext.loopRound),
      loopCompletedRuns: Math.max(0, activeContext.loopCompletedRuns),
      loopMaxRuns: Math.max(1, activeContext.loopMaxRuns),
      loopDeadlineAt: activeContext.loopDeadlineAt,
    };
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
      mode: effectiveContext.mode,
      loopRound: effectiveContext.loopRound,
      loopCompletedRuns: effectiveContext.loopCompletedRuns,
      loopMaxRuns: effectiveContext.loopMaxRuns,
      loopDeadlineAt: effectiveContext.loopDeadlineAt,
      lastGitCommitSummary: null,
      lastGitCommitAt: null,
    });
    const workflowDiagRunId = this.beginWorkflowDiagRun({
      kind: "autodev",
      sessionKey,
      conversationId: message.conversationId,
      requestId,
      objective: buildAutoDevObjective(activeTask),
      taskId: activeTask.id,
      taskDescription: activeTask.description,
    });
    this.appendWorkflowDiagEvent(
      workflowDiagRunId,
      "autodev",
      "autodev",
      0,
      `AutoDev 启动任务 ${activeTask.id}: ${activeTask.description}`,
    );

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
        workflowDiagRunId,
        "autodev",
      );
      if (!result) {
        return;
      }

      let finalTask = activeTask;
      let gitCommit: AutoDevGitCommitResult = {
        kind: "skipped",
        reason: "reviewer 未批准，未自动提交",
      };
      if (result.approved) {
        finalTask = await updateAutoDevTaskStatus(context.taskListPath, activeTask, "completed");
        gitCommit = await this.tryAutoDevGitCommit(workdir, finalTask, gitBaseline);
      }
      this.recordAutoDevGitCommit(sessionKey, finalTask.id, gitCommit);
      this.appendWorkflowDiagEvent(
        workflowDiagRunId,
        "autodev",
        "git_commit",
        0,
        `task=${finalTask.id} result=${formatAutoDevGitCommitResult(gitCommit)} files=${formatAutoDevGitChangedFiles(gitCommit)}`,
      );
      this.resetAutoDevFailureStreak(workdir, finalTask.id);
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
        mode: effectiveContext.mode,
        loopRound: effectiveContext.loopRound,
        loopCompletedRuns: effectiveContext.loopCompletedRuns + (finalTask.status === "completed" ? 1 : 0),
        loopMaxRuns: effectiveContext.loopMaxRuns,
        loopDeadlineAt: effectiveContext.loopDeadlineAt,
        lastGitCommitSummary: formatAutoDevGitCommitResult(gitCommit),
        lastGitCommitAt: new Date().toISOString(),
      });
      this.autoDevMetrics.recordRunOutcome("succeeded");

      const refreshed = await loadAutoDevContext(workdir);
      const nextTask = selectAutoDevTask(refreshed.tasks);
      await this.channel.sendNotice(
        message.conversationId,
        `[CodeHarbor] AutoDev 任务结果
- task: ${finalTask.id}
- reviewer approved: ${result.approved ? "yes" : "no"}
- task status: ${statusToSymbol(finalTask.status)}
- git commit: ${formatAutoDevGitCommitResult(gitCommit)}
- git changed files: ${formatAutoDevGitChangedFiles(gitCommit)}
- nextTask: ${nextTask ? formatTaskForDisplay(nextTask) : "N/A"}`,
      );
      this.appendWorkflowDiagEvent(
        workflowDiagRunId,
        "autodev",
        "autodev",
        0,
        `AutoDev 任务结果: task=${finalTask.id}, reviewerApproved=${result.approved ? "yes" : "no"}, taskStatus=${statusToSymbol(finalTask.status)}, gitCommit=${formatAutoDevGitCommitResult(gitCommit)}`,
      );
    } catch (error) {
      const failurePolicy = await this.applyAutoDevFailurePolicy({
        workdir,
        task: activeTask,
        taskListPath: context.taskListPath,
      });
      activeTask = failurePolicy.task;
      if (promotedToInProgress && !failurePolicy.blocked) {
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
        mode: effectiveContext.mode,
        loopRound: effectiveContext.loopRound,
        loopCompletedRuns: effectiveContext.loopCompletedRuns,
        loopMaxRuns: effectiveContext.loopMaxRuns,
        loopDeadlineAt: effectiveContext.loopDeadlineAt,
        lastGitCommitSummary: null,
        lastGitCommitAt: null,
      });
      this.appendWorkflowDiagEvent(
        workflowDiagRunId,
        "autodev",
        "autodev",
        0,
        `AutoDev 失败: ${formatError(error)}, streak=${failurePolicy.streak}, blocked=${
          failurePolicy.blocked ? "yes" : "no"
        }`,
      );
      if (failurePolicy.blocked) {
        this.autoDevMetrics.recordTaskBlocked();
        await this.channel.sendNotice(
          message.conversationId,
          `[CodeHarbor] AutoDev 任务 ${activeTask.id} 连续失败 ${failurePolicy.streak} 次，已标记为阻塞（🚫）。`,
        );
      }
      this.autoDevMetrics.recordRunOutcome(status === "cancelled" ? "cancelled" : "failed");
      if (failurePolicy.blocked && effectiveContext.mode === "loop") {
        return;
      }
      throw error;
    }
  }

  private async captureAutoDevGitBaseline(workdir: string): Promise<AutoDevGitBaseline> {
    const insideRepo = await this.isGitRepository(workdir);
    if (!insideRepo) {
      return {
        available: false,
        cleanBeforeRun: false,
      };
    }
    try {
      const status = await this.runGitCommand(workdir, ["status", "--porcelain"]);
      return {
        available: true,
        cleanBeforeRun: status.trim().length === 0,
      };
    } catch (error) {
      this.logger.warn("Failed to capture AutoDev git baseline", {
        workdir,
        error: formatError(error),
      });
      return {
        available: false,
        cleanBeforeRun: false,
      };
    }
  }

  private async tryAutoDevGitCommit(
    workdir: string,
    task: AutoDevTask,
    baseline: AutoDevGitBaseline,
  ): Promise<AutoDevGitCommitResult> {
    if (!this.autoDevAutoCommit) {
      return {
        kind: "skipped",
        reason: "AUTODEV_AUTO_COMMIT=false",
      };
    }
    if (!baseline.available) {
      return {
        kind: "skipped",
        reason: "未检测到 git 仓库",
      };
    }
    if (!baseline.cleanBeforeRun) {
      return {
        kind: "skipped",
        reason: "运行前存在未提交改动，已跳过自动提交",
      };
    }

    try {
      const removedArtifacts = await this.cleanupAutoDevGitArtifacts(workdir);
      if (removedArtifacts.length > 0) {
        this.logger.warn("Removed AutoDev shell artifact files before git commit", {
          workdir,
          taskId: task.id,
          files: removedArtifacts,
        });
      }

      const preAddStatus = await this.runGitCommand(workdir, ["status", "--porcelain"]);
      if (!preAddStatus.trim()) {
        return {
          kind: "skipped",
          reason: "无文件改动可提交",
        };
      }

      await this.runGitCommand(workdir, ["add", "-A"]);
      const subject = `chore(autodev): complete ${task.id}`;
      const detail = summarizeSingleLine(task.description, 120);
      await this.runGitCommand(workdir, [
        "-c",
        "user.name=CodeHarbor AutoDev",
        "-c",
        "user.email=autodev@codeharbor.local",
        "commit",
        "-m",
        subject,
        "-m",
        `Task: ${task.id} ${detail}\nGenerated-by: CodeHarbor AutoDev`,
      ]);
      const hash = (await this.runGitCommand(workdir, ["rev-parse", "--short", "HEAD"])).trim();
      const changedFiles = await this.listGitCommitChangedFiles(workdir);
      return {
        kind: "committed",
        commitHash: hash || "unknown",
        commitSubject: subject,
        changedFiles,
      };
    } catch (error) {
      const message = formatError(error);
      if (/nothing to commit|no changes added to commit/i.test(message)) {
        return {
          kind: "skipped",
          reason: "无文件改动可提交",
        };
      }
      this.logger.warn("AutoDev git auto-commit failed", {
        workdir,
        taskId: task.id,
        error: message,
      });
      return {
        kind: "failed",
        error: message,
      };
    }
  }

  private async applyAutoDevFailurePolicy(input: {
    workdir: string;
    task: AutoDevTask;
    taskListPath: string;
  }): Promise<AutoDevFailurePolicyResult> {
    const key = this.buildAutoDevFailureKey(input.workdir, input.task.id);
    const streak = (this.autoDevFailureStreaks.get(key) ?? 0) + 1;
    this.autoDevFailureStreaks.set(key, streak);
    if (streak < this.autoDevMaxConsecutiveFailures) {
      return {
        blocked: false,
        streak,
        task: input.task,
      };
    }
    try {
      const blockedTask = await updateAutoDevTaskStatus(input.taskListPath, input.task, "blocked");
      return {
        blocked: true,
        streak,
        task: blockedTask,
      };
    } catch (error) {
      this.logger.warn("Failed to mark AutoDev task as blocked after consecutive failures", {
        taskId: input.task.id,
        streak,
        error: formatError(error),
      });
      return {
        blocked: false,
        streak,
        task: input.task,
      };
    }
  }

  private resetAutoDevFailureStreak(workdir: string, taskId: string): void {
    const key = this.buildAutoDevFailureKey(workdir, taskId);
    this.autoDevFailureStreaks.delete(key);
  }

  private buildAutoDevFailureKey(workdir: string, taskId: string): string {
    return `${workdir}::${taskId.trim().toLowerCase()}`;
  }

  private recordAutoDevGitCommit(sessionKey: string, taskId: string, result: AutoDevGitCommitResult): void {
    this.autoDevGitCommitRecords.push({
      at: new Date().toISOString(),
      sessionKey,
      taskId,
      result,
    });
    if (this.autoDevGitCommitRecords.length > AUTODEV_GIT_COMMIT_HISTORY_MAX) {
      this.autoDevGitCommitRecords.splice(0, this.autoDevGitCommitRecords.length - AUTODEV_GIT_COMMIT_HISTORY_MAX);
    }
  }

  private listAutoDevGitCommitRecords(limit: number): AutoDevGitCommitRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    return this.autoDevGitCommitRecords.slice(Math.max(0, this.autoDevGitCommitRecords.length - safeLimit)).reverse();
  }

  private async listGitCommitChangedFiles(workdir: string): Promise<string[]> {
    const raw = await this.runGitCommand(workdir, ["show", "--name-only", "--pretty=format:", "--no-renames", "HEAD"]);
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private async cleanupAutoDevGitArtifacts(workdir: string): Promise<string[]> {
    const untracked = await this.listUntrackedGitFiles(workdir);
    const targets = untracked.filter((relativePath) => {
      const basename = path.basename(relativePath);
      return AUTODEV_GIT_ARTIFACT_BASENAME_REGEX.test(basename);
    });
    if (targets.length === 0) {
      return [];
    }

    const removed: string[] = [];
    for (const relativePath of targets) {
      const absolutePath = path.join(workdir, relativePath);
      try {
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile() || stat.size !== 0) {
          continue;
        }
        await fs.unlink(absolutePath);
        removed.push(relativePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        this.logger.debug("Failed to remove AutoDev shell artifact file", {
          workdir,
          file: relativePath,
          error: formatError(error),
        });
      }
    }
    return removed;
  }

  private async listUntrackedGitFiles(workdir: string): Promise<string[]> {
    const raw = await this.runGitCommand(workdir, ["ls-files", "--others", "--exclude-standard"]);
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private async isGitRepository(workdir: string): Promise<boolean> {
    try {
      const output = await this.runGitCommand(workdir, ["rev-parse", "--is-inside-work-tree"]);
      return output.trim() === "true";
    } catch {
      return false;
    }
  }

  private async runGitCommand(workdir: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: workdir,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return String(stdout ?? "");
  }

  private async handleWorkflowRunCommand(
    objective: string,
    sessionKey: string,
    message: InboundMessage,
    requestId: string,
    workdir: string,
    diagRunId: string | null = null,
    diagRunKind: WorkflowDiagRunKind = "workflow",
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
    const workflowDiagRunId =
      diagRunId ??
      this.beginWorkflowDiagRun({
        kind: diagRunKind,
        sessionKey,
        conversationId: message.conversationId,
        requestId,
        objective: normalizedObjective,
      });

    const stopTyping = this.startTypingHeartbeat(message.conversationId);
    let cancelWorkflow = (): void => {};
    let cancelRequested = this.consumePendingStopRequest(sessionKey);
    this.runningExecutions.set(sessionKey, {
      requestId,
      startedAt: requestStartedAt,
      cancel: () => {
        cancelRequested = true;
        cancelWorkflow();
      },
    });
    this.persistRuntimeMetricsSnapshot();

    await this.sendProgressUpdate(progressCtx, "[CodeHarbor] Multi-Agent workflow 启动：Planner -> Executor -> Reviewer");
    this.appendWorkflowDiagEvent(
      workflowDiagRunId,
      diagRunKind,
      "workflow",
      0,
      "Multi-Agent workflow 启动：Planner -> Executor -> Reviewer",
    );

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
          this.appendWorkflowDiagEvent(workflowDiagRunId, diagRunKind, event.stage, event.round, event.message);
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
      this.finishWorkflowDiagRun(workflowDiagRunId, {
        status: "succeeded",
        approved: result.approved,
        repairRounds: result.repairRounds,
        error: null,
      });
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
      this.finishWorkflowDiagRun(workflowDiagRunId, {
        status: status === "cancelled" ? "cancelled" : "failed",
        approved: null,
        repairRounds: 0,
        error: formatError(error),
      });
      throw error;
    } finally {
      const running = this.runningExecutions.get(sessionKey);
      if (running?.requestId === requestId) {
        this.runningExecutions.delete(sessionKey);
      }
      this.persistRuntimeMetricsSnapshot();
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

    const queueStore = this.getTaskQueueStateStore();
    const cancelledPending = queueStore ? queueStore.clearPendingTasks(sessionKey).cancelledPending : 0;
    if (cancelledPending > 0) {
      this.logger.info("Stop command cleared pending queued tasks", {
        requestId,
        sessionKey,
        cancelledPending,
      });
    }

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

  private async prepareImageAttachments(
    message: InboundMessage,
    requestId: string,
    sessionKey: string,
  ): Promise<ImageSelectionResult> {
    const result: ImageSelectionResult = {
      imagePaths: [],
      acceptedCount: 0,
      skippedMissingPath: 0,
      skippedUnsupportedMime: 0,
      skippedTooLarge: 0,
      skippedOverLimit: 0,
      notice: null,
    };

    const rawImageAttachments = message.attachments.filter((attachment) => attachment.kind === "image");
    if (rawImageAttachments.length === 0) {
      return result;
    }

    const maxBytes = this.cliCompat.imageMaxBytes;
    const maxCount = this.cliCompat.imageMaxCount;
    const allowlist = new Set(this.cliCompat.imageAllowedMimeTypes.map((item) => item.toLowerCase()));
    const dedup = new Set<string>();

    const acceptedCandidates: string[] = [];
    for (const attachment of rawImageAttachments) {
      const localPath = attachment.localPath;
      if (!localPath) {
        if (this.cliCompat.fetchMedia) {
          result.skippedMissingPath += 1;
        }
        continue;
      }
      if (dedup.has(localPath)) {
        continue;
      }
      dedup.add(localPath);

      const normalizedMimeType = normalizeImageMimeType(attachment.mimeType, localPath);
      if (!normalizedMimeType || !allowlist.has(normalizedMimeType)) {
        result.skippedUnsupportedMime += 1;
        this.logger.warn("Skip image attachment due to unsupported mime type", {
          requestId,
          sessionKey,
          name: attachment.name,
          mimeType: attachment.mimeType,
          normalizedMimeType,
          allowlist: [...allowlist],
        });
        continue;
      }

      const sizeBytes = await this.resolveAttachmentSizeBytes(attachment.sizeBytes, localPath);
      if (sizeBytes !== null && sizeBytes > maxBytes) {
        result.skippedTooLarge += 1;
        this.logger.warn("Skip image attachment due to oversize", {
          requestId,
          sessionKey,
          name: attachment.name,
          sizeBytes,
          maxBytes,
        });
        continue;
      }
      acceptedCandidates.push(localPath);
    }

    result.acceptedCount = acceptedCandidates.length;
    if (acceptedCandidates.length > maxCount) {
      result.imagePaths = acceptedCandidates.slice(0, maxCount);
      result.skippedOverLimit = acceptedCandidates.length - maxCount;
    } else {
      result.imagePaths = acceptedCandidates;
    }

    if (
      result.skippedMissingPath > 0 ||
      result.skippedUnsupportedMime > 0 ||
      result.skippedTooLarge > 0 ||
      result.skippedOverLimit > 0
    ) {
      const parts: string[] = [];
      if (result.skippedMissingPath > 0) {
        parts.push(`未下载到本地 ${result.skippedMissingPath} 张`);
      }
      if (result.skippedUnsupportedMime > 0) {
        parts.push(`格式不支持 ${result.skippedUnsupportedMime} 张（允许: ${this.cliCompat.imageAllowedMimeTypes.join(", ")}）`);
      }
      if (result.skippedTooLarge > 0) {
        parts.push(`超过大小限制 ${result.skippedTooLarge} 张（上限 ${formatByteSize(maxBytes)}）`);
      }
      if (result.skippedOverLimit > 0) {
        parts.push(`超过数量上限 ${result.skippedOverLimit} 张（最多 ${maxCount} 张）`);
      }
      const acceptedText = result.imagePaths.length > 0 ? `已附带 ${result.imagePaths.length} 张图片` : "本次未附带图片";
      result.notice = `[CodeHarbor] 图片处理提示：${acceptedText}；${parts.join("；")}。`;
    }

    return result;
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
      const sizeBytes = await this.resolveAttachmentSizeBytes(attachment.sizeBytes, localPath);
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
      if (skippedTooLarge > 0) {
        this.mediaMetrics.recordAudioTranscription({
          requestId,
          sessionKey,
          transcribedCount: 0,
          failedCount: 0,
          skippedTooLarge,
        });
      }
      return [];
    }

    const startedAt = Date.now();
    try {
      const transcripts = await this.audioTranscriber.transcribeMany(audioAttachments);
      this.mediaMetrics.recordAudioTranscription({
        requestId,
        sessionKey,
        transcribedCount: transcripts.length,
        failedCount: 0,
        skippedTooLarge,
      });
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
      this.mediaMetrics.recordAudioTranscription({
        requestId,
        sessionKey,
        transcribedCount: 0,
        failedCount: audioAttachments.length,
        skippedTooLarge,
      });
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

  private async prepareDocumentAttachments(
    message: InboundMessage,
    requestId: string,
    sessionKey: string,
  ): Promise<DocumentExtractionSummary> {
    const result: DocumentExtractionSummary = {
      documents: [],
      notice: null,
    };

    const fileAttachments = message.attachments.filter((attachment) => attachment.kind === "file");
    if (fileAttachments.length === 0) {
      return result;
    }

    let skippedUnsupportedType = 0;
    let skippedTooLarge = 0;
    let skippedMissingLocalPath = 0;
    let failedExtraction = 0;

    for (const attachment of fileAttachments) {
      const extraction = await extractDocumentText({
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        localPath: attachment.localPath,
        maxBytes: DEFAULT_DOCUMENT_MAX_BYTES,
      });

      if (extraction.ok) {
        result.documents.push({
          name: extraction.name,
          format: extraction.format,
          sizeBytes: extraction.sizeBytes,
          text: extraction.text,
        });
        continue;
      }

      if (extraction.reason === "unsupported_type") {
        skippedUnsupportedType += 1;
        continue;
      }
      if (extraction.reason === "file_too_large") {
        skippedTooLarge += 1;
        continue;
      }
      if (extraction.reason === "missing_local_path") {
        skippedMissingLocalPath += 1;
        continue;
      }

      failedExtraction += 1;
      this.logger.warn("Failed to extract document attachment", {
        requestId,
        sessionKey,
        name: attachment.name,
        mimeType: attachment.mimeType,
        reason: extraction.reason,
        message: extraction.message,
      });
    }

    if (
      skippedUnsupportedType === 0 &&
      skippedTooLarge === 0 &&
      skippedMissingLocalPath === 0 &&
      failedExtraction === 0
    ) {
      return result;
    }

    const parts: string[] = [];
    if (result.documents.length > 0) {
      parts.push(`已提取 ${result.documents.length} 份文档`);
    } else {
      parts.push("未提取到可用文档");
    }
    if (skippedUnsupportedType > 0) {
      parts.push(`类型不支持 ${skippedUnsupportedType} 份（仅支持 txt/pdf/docx）`);
    }
    if (skippedTooLarge > 0) {
      parts.push(`超过大小限制 ${skippedTooLarge} 份（上限 ${formatByteSize(DEFAULT_DOCUMENT_MAX_BYTES)}）`);
    }
    if (skippedMissingLocalPath > 0) {
      parts.push(`未下载到本地 ${skippedMissingLocalPath} 份`);
    }
    if (failedExtraction > 0) {
      parts.push(`解析失败 ${failedExtraction} 份`);
    }
    result.notice = `[CodeHarbor] 文档处理提示：${parts.join("；")}。`;
    return result;
  }

  private async resolveAttachmentSizeBytes(sizeBytes: number | null, localPath: string): Promise<number | null> {
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
    extractedDocuments: ExtractedDocumentContext[],
    bridgeContext: string | null,
  ): string {
    let composed: string;
    if (message.attachments.length === 0 && audioTranscripts.length === 0 && extractedDocuments.length === 0) {
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

      if (extractedDocuments.length > 0) {
        const documentSummary = extractedDocuments
          .map((document) => {
            const normalizedText = document.text.trim() || "(empty)";
            const indentedText = indentMultiline(normalizedText, "  ");
            return `- name=${document.name} format=${document.format} size=${document.sizeBytes}\n${indentedText}`;
          })
          .join("\n");
        sections.push(`[documents]\n${documentSummary}\n[/documents]`);
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
    const distributedLock = this.acquireUpgradeExecutionLock();
    if (!distributedLock.acquired) {
      const lockUntil = distributedLock.expiresAt ? new Date(distributedLock.expiresAt).toISOString() : "unknown";
      await this.channel.sendNotice(
        message.conversationId,
        `[CodeHarbor] 已有升级任务在其他实例执行中（owner=${distributedLock.owner ?? "unknown"}，lockUntil=${lockUntil}）。请稍后再试。`,
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

    try {
      await this.upgradeMutex.runExclusive(async () => {
        try {
          const result = await this.selfUpdateRunner({
            version: parsed.version,
          });
          const restartPlan = await this.upgradeRestartPlanner();
          const versionProbe = await this.upgradeVersionProbe();
          const postCheck = evaluateUpgradePostCheck({
            targetVersion: parsed.version,
            selfUpdateVersion: result.installedVersion,
            versionProbe,
          });
          const elapsed = formatDurationMs(Date.now() - startedAt);
          if (postCheck.ok) {
            const installedVersion = postCheck.installedVersion ?? "unknown";
            await this.channel.sendNotice(
              message.conversationId,
              `${this.botNoticePrefix} 升级任务完成（耗时 ${elapsed}）
- 目标版本: ${targetLabel}
- 已安装版本: ${installedVersion}
- 升级校验: 通过（${postCheck.checkDetail}）
- 服务重启: ${restartPlan.summary}
- 校验建议: 稍后发送 /diag version 或 /version`,
            );
            this.finishUpgradeRun(upgradeRunId, {
              status: "succeeded",
              installedVersion,
              error: null,
            });
          } else {
            const observedVersion = postCheck.installedVersion ?? "unknown";
            await this.channel.sendNotice(
              message.conversationId,
              `${this.botNoticePrefix} 升级后校验失败（耗时 ${elapsed}）
- 目标版本: ${targetLabel}
- 观测版本: ${observedVersion}
- 失败原因: ${postCheck.checkDetail}
- 服务重启: ${restartPlan.summary}
- 恢复建议: 发送 /diag version 查看实例路径；必要时执行 codeharbor self-update --with-admin`,
            );
            this.finishUpgradeRun(upgradeRunId, {
              status: "failed",
              installedVersion: postCheck.installedVersion,
              error: `post-check failed: ${postCheck.checkDetail}`,
            });
          }
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
    } finally {
      this.releaseUpgradeExecutionLock();
    }
  }

  private authorizeUpgradeRequest(message: InboundMessage): { allowed: true } | { allowed: false; reason: string } {
    if (!message.isDirectMessage) {
      return {
        allowed: false,
        reason: "为保证安全，/upgrade 仅支持私聊中执行。",
      };
    }
    if (this.upgradeAllowedUsers.size > 0) {
      if (this.upgradeAllowedUsers.has(message.senderId)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: "当前账号无执行 /upgrade 权限，请联系管理员添加 MATRIX_UPGRADE_ALLOWED_USERS 白名单。",
      };
    }
    if (this.matrixAdminUsers.size === 0 || this.matrixAdminUsers.has(message.senderId)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "当前账号不是 Matrix 管理员（MATRIX_ADMIN_USERS），无法执行 /upgrade。",
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

  private getUpgradeRunStats(): UpgradeRunStats {
    const store = this.getUpgradeStateStore();
    if (!store || typeof store.getUpgradeRunStats !== "function") {
      return {
        total: 0,
        succeeded: 0,
        failed: 0,
        running: 0,
        avgDurationMs: 0,
      };
    }
    try {
      return store.getUpgradeRunStats();
    } catch (error) {
      this.logger.warn("Failed to fetch upgrade run stats", { error });
      return {
        total: 0,
        succeeded: 0,
        failed: 0,
        running: 0,
        avgDurationMs: 0,
      };
    }
  }

  private getUpgradeExecutionLockSnapshot(): UpgradeExecutionLockRecord | null {
    const store = this.getUpgradeStateStore();
    if (!store || typeof store.getUpgradeExecutionLock !== "function") {
      return null;
    }
    try {
      return store.getUpgradeExecutionLock();
    } catch (error) {
      this.logger.warn("Failed to fetch distributed upgrade lock state", { error });
      return null;
    }
  }

  private acquireUpgradeExecutionLock(): { acquired: boolean; owner: string | null; expiresAt: number | null } {
    const store = this.getUpgradeStateStore();
    if (!store || typeof store.acquireUpgradeExecutionLock !== "function") {
      return {
        acquired: true,
        owner: this.upgradeLockOwner,
        expiresAt: null,
      };
    }
    try {
      return store.acquireUpgradeExecutionLock({
        owner: this.upgradeLockOwner,
        ttlMs: DEFAULT_UPGRADE_LOCK_TTL_MS,
      });
    } catch (error) {
      this.logger.warn("Failed to acquire distributed upgrade lock", { error });
      return {
        acquired: false,
        owner: null,
        expiresAt: null,
      };
    }
  }

  private releaseUpgradeExecutionLock(): void {
    const store = this.getUpgradeStateStore();
    if (!store || typeof store.releaseUpgradeExecutionLock !== "function") {
      return;
    }
    try {
      store.releaseUpgradeExecutionLock(this.upgradeLockOwner);
    } catch (error) {
      this.logger.warn("Failed to release distributed upgrade lock", { error });
    }
  }

  private getTaskQueueStateStore(): TaskQueueStateStore | null {
    const maybeStore = this.stateStore as unknown as Partial<TaskQueueStateStore>;
    if (
      typeof maybeStore.enqueueTask !== "function" ||
      typeof maybeStore.claimNextTask !== "function" ||
      typeof maybeStore.getTaskById !== "function" ||
      typeof maybeStore.hasPendingTask !== "function" ||
      typeof maybeStore.clearPendingTasks !== "function" ||
      typeof maybeStore.listPendingTaskSessions !== "function" ||
      typeof maybeStore.finishTask !== "function" ||
      typeof maybeStore.failTask !== "function" ||
      typeof maybeStore.recoverTasks !== "function" ||
      typeof maybeStore.getTaskQueueStatusCounts !== "function"
    ) {
      return null;
    }
    return maybeStore as TaskQueueStateStore;
  }

  private listTaskQueueFailureArchive(limit: number): TaskFailureArchiveRecord[] {
    const stateStore = this.stateStore as StateStore & {
      listTaskFailureArchive?: (limit?: number) => TaskFailureArchiveRecord[];
    };
    if (typeof stateStore.listTaskFailureArchive !== "function") {
      return [];
    }
    try {
      return stateStore.listTaskFailureArchive(limit);
    } catch (error) {
      this.logger.warn("Failed to load task queue failure archive", {
        error: formatError(error),
        limit,
      });
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

  private formatMultimodalHelpStatus(): string {
    const imageEnabled = this.cliCompat.fetchMedia ? "on" : "off";
    const audioEnabled = this.audioTranscriber.isEnabled() ? "on" : "off";
    const mimeText = formatMimeAllowlist(this.cliCompat.imageAllowedMimeTypes);
    const backendImageSupport = this.aiCliProvider === "codex" || this.aiCliProvider === "claude" ? "yes" : "unknown";
    return `图片=${imageEnabled}(max=${this.cliCompat.imageMaxCount},<=${formatByteSize(this.cliCompat.imageMaxBytes)},mime=${mimeText})；语音=${audioEnabled}；后端图片支持=${backendImageSupport}`;
  }

  private async handleDiagCommand(message: InboundMessage): Promise<void> {
    const target = parseDiagTarget(message.text);
    if (!target || target.kind === "help") {
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 用法: /diag version | /diag media [count] | /diag upgrade [count] | /diag autodev [count] | /diag queue [count]",
      );
      return;
    }
    if (target.kind === "version") {
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
      return;
    }
    if (target.kind === "media") {
      const snapshot = this.mediaMetrics.snapshot(target.limit);
      await this.channel.sendNotice(
        message.conversationId,
        `${this.botNoticePrefix} 诊断信息（media）
- backend: ${this.formatBackendToolLabel()}
- imagePolicy: enabled=${this.cliCompat.fetchMedia ? "on" : "off"}, maxCount=${this.cliCompat.imageMaxCount}, maxBytes=${formatByteSize(this.cliCompat.imageMaxBytes)}, allow=${this.cliCompat.imageAllowedMimeTypes.join(",")}
- audioPolicy: enabled=${this.audioTranscriber.isEnabled() ? "on" : "off"}, maxBytes=${formatByteSize(this.cliCompat.audioTranscribeMaxBytes)}, model=${this.cliCompat.audioTranscribeModel}
- counters: image.accepted=${snapshot.counters.imageAccepted}, image.skipped_missing=${snapshot.counters.imageSkippedMissingPath}, image.skipped_mime=${snapshot.counters.imageSkippedUnsupportedMime}, image.skipped_size=${snapshot.counters.imageSkippedTooLarge}, image.skipped_limit=${snapshot.counters.imageSkippedOverLimit}
- counters: audio.transcribed=${snapshot.counters.audioTranscribed}, audio.failed=${snapshot.counters.audioFailed}, audio.skipped_size=${snapshot.counters.audioSkippedTooLarge}
- counters: claude.fallback_triggered=${snapshot.counters.claudeImageFallbackTriggered}, claude.fallback_ok=${snapshot.counters.claudeImageFallbackSucceeded}, claude.fallback_failed=${snapshot.counters.claudeImageFallbackFailed}
- records:
${formatMediaDiagEvents(snapshot.recentEvents)}`,
      );
      return;
    }
    if (target.kind === "autodev") {
      const runs = this.listWorkflowDiagRuns("autodev", target.limit);
      const counts = runs.reduce(
        (acc, run) => {
          if (run.status === "running") {
            acc.running += 1;
          } else if (run.status === "succeeded") {
            acc.succeeded += 1;
          } else if (run.status === "cancelled") {
            acc.cancelled += 1;
          } else {
            acc.failed += 1;
          }
          return acc;
        },
        { running: 0, succeeded: 0, failed: 0, cancelled: 0 },
      );
      const sessionKey = buildSessionKey(message);
      const snapshot = this.autoDevSnapshots.get(sessionKey) ?? createIdleAutoDevSnapshot();
      const commitRecords = this.listAutoDevGitCommitRecords(target.limit);
      const commitText =
        commitRecords.length > 0
          ? formatAutoDevGitCommitRecords(commitRecords)
          : this.listRecentAutoDevGitCommitEventSummaries(target.limit).join("\n") || "- (empty)";
      await this.channel.sendNotice(
        message.conversationId,
        `${this.botNoticePrefix} 诊断信息（autodev）
- recentCount: ${runs.length}
- status: running=${counts.running}, succeeded=${counts.succeeded}, failed=${counts.failed}, cancelled=${counts.cancelled}
- live: state=${snapshot.state}, mode=${snapshot.mode}, loop=${snapshot.loopRound}/${snapshot.loopMaxRuns}, completed=${snapshot.loopCompletedRuns}, deadline=${snapshot.loopDeadlineAt ?? "N/A"}
- config: loopMaxRuns=${this.autoDevLoopMaxRuns}, loopMaxMinutes=${this.autoDevLoopMaxMinutes}, autoCommit=${this.autoDevAutoCommit ? "on" : "off"}, maxConsecutiveFailures=${this.autoDevMaxConsecutiveFailures}
- recentGitCommits:
${commitText}
- records:
${formatAutoDevDiagRuns(runs, (runId) => this.listWorkflowDiagEvents(runId, 5))}`,
      );
      return;
    }
    if (target.kind === "queue") {
      const queueStore = this.getTaskQueueStateStore();
      if (!queueStore) {
        await this.channel.sendNotice(
          message.conversationId,
          `${this.botNoticePrefix} 诊断信息（queue）
- status: unavailable
- reason: 当前实例未启用可恢复任务队列能力`,
        );
        return;
      }
      const counts = queueStore.getTaskQueueStatusCounts();
      const sessions = queueStore.listPendingTaskSessions(target.limit, 0);
      let earliestRetryAt: number | null = null;
      for (const session of sessions) {
        const nextRetryAt = queueStore.getNextPendingRetryAt(session.sessionKey);
        if (nextRetryAt === null) {
          continue;
        }
        if (earliestRetryAt === null || nextRetryAt < earliestRetryAt) {
          earliestRetryAt = nextRetryAt;
        }
      }
      const archive = this.listTaskQueueFailureArchive(target.limit);
      await this.channel.sendNotice(
        message.conversationId,
        `${this.botNoticePrefix} 诊断信息（queue）
- activeExecutions: ${this.runningExecutions.size}
- counts: pending=${counts.pending}, running=${counts.running}, succeeded=${counts.succeeded}, failed=${counts.failed}
- pendingSessions: ${sessions.length}
- earliestRetryAt: ${earliestRetryAt === null ? "N/A" : new Date(earliestRetryAt).toISOString()}
- sessions:
${formatQueuePendingSessions(sessions)}
- archive:
${formatQueueFailureArchive(archive)}`,
      );
      return;
    }

    const runs = this.getRecentUpgradeRuns(target.limit);
    const lock = this.getUpgradeExecutionLockSnapshot();
    const stats = this.getUpgradeRunStats();
    await this.channel.sendNotice(
      message.conversationId,
      `${this.botNoticePrefix} 诊断信息（upgrade）
- recentCount: ${runs.length}
- lock: ${formatUpgradeLockSummary(lock)}
- stats: total=${stats.total}, succeeded=${stats.succeeded}, failed=${stats.failed}, running=${stats.running}, avg=${stats.avgDurationMs}ms
- records:
${formatUpgradeDiagRecords(runs)}`,
    );
  }

  getRuntimeMetricsSnapshot(now = Date.now()): RuntimeMetricsSnapshot {
    return {
      generatedAt: new Date(now).toISOString(),
      startedAt: this.processStartedAtIso,
      activeExecutions: this.runningExecutions.size,
      request: this.metrics.runtimeSnapshot(),
      limiter: this.rateLimiter.snapshot(),
      autodev: this.autoDevMetrics.runtimeSnapshot(),
    };
  }

  private recordRequestMetrics(outcome: RequestOutcome, queueMs: number, execMs: number, sendMs: number): void {
    this.metrics.record(outcome, queueMs, execMs, sendMs);
    this.persistRuntimeMetricsSnapshot();
  }

  private persistRuntimeMetricsSnapshot(): void {
    const stateStore = this.stateStore as StateStore & {
      upsertRuntimeMetricsSnapshot?: (key: string, payloadJson: string) => void;
    };
    if (typeof stateStore.upsertRuntimeMetricsSnapshot !== "function") {
      return;
    }
    try {
      stateStore.upsertRuntimeMetricsSnapshot(
        "orchestrator",
        JSON.stringify(this.getRuntimeMetricsSnapshot()),
      );
    } catch (error) {
      this.logger.debug("Failed to persist runtime metrics snapshot", {
        error: formatError(error),
      });
    }
  }

  private restoreWorkflowDiagStore(): WorkflowDiagStorePayload {
    const stateStore = this.stateStore as StateStore & {
      getRuntimeMetricsSnapshot?: (key: string) => { payloadJson: string } | null;
    };
    if (typeof stateStore.getRuntimeMetricsSnapshot !== "function") {
      return createEmptyWorkflowDiagStorePayload();
    }
    try {
      const record = stateStore.getRuntimeMetricsSnapshot(WORKFLOW_DIAG_SNAPSHOT_KEY);
      return parseWorkflowDiagStorePayload(record?.payloadJson ?? null);
    } catch (error) {
      this.logger.debug("Failed to restore workflow diag store", {
        error: formatError(error),
      });
      return createEmptyWorkflowDiagStorePayload();
    }
  }

  private persistWorkflowDiagStore(): void {
    const stateStore = this.stateStore as StateStore & {
      upsertRuntimeMetricsSnapshot?: (key: string, payloadJson: string) => void;
    };
    if (typeof stateStore.upsertRuntimeMetricsSnapshot !== "function") {
      return;
    }
    try {
      stateStore.upsertRuntimeMetricsSnapshot(WORKFLOW_DIAG_SNAPSHOT_KEY, JSON.stringify(this.workflowDiagStore));
    } catch (error) {
      this.logger.debug("Failed to persist workflow diag store", {
        error: formatError(error),
      });
    }
  }

  private beginWorkflowDiagRun(input: {
    kind: WorkflowDiagRunKind;
    sessionKey: string;
    conversationId: string;
    requestId: string;
    objective: string;
    taskId?: string | null;
    taskDescription?: string | null;
  }): string {
    const nowIso = new Date().toISOString();
    const runId = `${nowIso}-${Math.random().toString(36).slice(2, 8)}`;
    this.workflowDiagStore.runs.push({
      runId,
      kind: input.kind,
      sessionKey: input.sessionKey,
      conversationId: input.conversationId,
      requestId: input.requestId,
      objective: summarizeSingleLine(input.objective, 800),
      taskId: input.taskId?.trim() || null,
      taskDescription: input.taskDescription?.trim() || null,
      status: "running",
      startedAt: nowIso,
      endedAt: null,
      durationMs: null,
      approved: null,
      repairRounds: 0,
      error: null,
      lastStage: null,
      lastMessage: null,
      updatedAt: nowIso,
    });
    if (this.workflowDiagStore.runs.length > WORKFLOW_DIAG_MAX_RUNS) {
      const overflow = this.workflowDiagStore.runs.length - WORKFLOW_DIAG_MAX_RUNS;
      const removedIds = new Set(this.workflowDiagStore.runs.slice(0, overflow).map((run) => run.runId));
      this.workflowDiagStore.runs.splice(0, overflow);
      if (removedIds.size > 0) {
        this.workflowDiagStore.events = this.workflowDiagStore.events.filter((event) => !removedIds.has(event.runId));
      }
    }
    this.workflowDiagStore.updatedAt = nowIso;
    this.persistWorkflowDiagStore();
    return runId;
  }

  private appendWorkflowDiagEvent(
    runId: string,
    kind: WorkflowDiagRunKind,
    stage: string,
    round: number,
    message: string,
  ): void {
    const run = this.workflowDiagStore.runs.find((item) => item.runId === runId);
    if (!run) {
      return;
    }
    const nowIso = new Date().toISOString();
    const normalizedStage = stage.trim() || "unknown";
    const normalizedMessage = summarizeSingleLine(message || "n/a", 600);
    this.workflowDiagStore.events.push({
      runId,
      kind,
      stage: normalizedStage,
      round: Math.max(0, Math.floor(round)),
      message: normalizedMessage,
      at: nowIso,
    });
    if (this.workflowDiagStore.events.length > WORKFLOW_DIAG_MAX_EVENTS) {
      this.workflowDiagStore.events.splice(0, this.workflowDiagStore.events.length - WORKFLOW_DIAG_MAX_EVENTS);
    }
    run.lastStage = normalizedStage;
    run.lastMessage = normalizedMessage;
    run.updatedAt = nowIso;
    this.workflowDiagStore.updatedAt = nowIso;
    this.persistWorkflowDiagStore();
  }

  private finishWorkflowDiagRun(
    runId: string,
    input: {
      status: WorkflowDiagRunStatus;
      approved: boolean | null;
      repairRounds: number;
      error: string | null;
    },
  ): void {
    const run = this.workflowDiagStore.runs.find((item) => item.runId === runId);
    if (!run) {
      return;
    }
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const startedAtMs = Date.parse(run.startedAt);
    run.status = input.status;
    run.endedAt = nowIso;
    run.durationMs = Number.isFinite(startedAtMs) ? Math.max(0, now - startedAtMs) : null;
    run.approved = input.approved;
    run.repairRounds = Math.max(0, Math.floor(input.repairRounds));
    run.error = input.error ? summarizeSingleLine(input.error, 1_000) : null;
    run.updatedAt = nowIso;
    this.workflowDiagStore.updatedAt = nowIso;
    this.persistWorkflowDiagStore();
  }

  private listWorkflowDiagRuns(kind: WorkflowDiagRunKind, limit: number): WorkflowDiagRunRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    return this.workflowDiagStore.runs
      .filter((run) => run.kind === kind)
      .slice()
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, safeLimit);
  }

  private listWorkflowDiagEvents(runId: string, limit = 8): WorkflowDiagEventRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    return this.workflowDiagStore.events
      .filter((event) => event.runId === runId)
      .slice()
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .slice(-safeLimit);
  }

  private listRecentAutoDevGitCommitEventSummaries(limit: number): string[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    return this.workflowDiagStore.events
      .filter((event) => event.kind === "autodev" && event.stage === "git_commit")
      .slice()
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, safeLimit)
      .map((event) => `- at=${event.at} ${event.message}`);
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
    mode: "idle",
    loopRound: 0,
    loopCompletedRuns: 0,
    loopMaxRuns: 0,
    loopDeadlineAt: null,
    lastGitCommitSummary: null,
    lastGitCommitAt: null,
  };
}

export function buildApiTaskEventId(idempotencyKey: string): string {
  const normalized = idempotencyKey.trim();
  if (!normalized) {
    throw new Error("Idempotency-Key is required.");
  }
  const digest = createHash("sha256").update(normalized).digest("hex");
  return `$api-${digest}`;
}

export function buildSessionKey(message: InboundMessage): string {
  return `${message.channel}:${message.conversationId}:${message.senderId}`;
}

function normalizeApiTaskRequestId(requestId: string | undefined, eventId: string): string {
  const normalized = requestId?.trim();
  if (normalized) {
    return normalized;
  }
  return `api-${eventId.slice(1)}`;
}

function isApiTaskPayloadEquivalent(left: InboundMessage, right: InboundMessage): boolean {
  return buildApiTaskPayloadFingerprint(left) === buildApiTaskPayloadFingerprint(right);
}

function buildApiTaskPayloadFingerprint(message: InboundMessage): string {
  return JSON.stringify({
    channel: message.channel,
    conversationId: message.conversationId.trim(),
    senderId: message.senderId.trim(),
    text: message.text.trim(),
    isDirectMessage: message.isDirectMessage,
    mentionsBot: message.mentionsBot,
    repliesToBot: message.repliesToBot,
    attachments: message.attachments.map((attachment) => ({
      kind: attachment.kind,
      name: attachment.name,
      mxcUrl: attachment.mxcUrl,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      localPath: attachment.localPath,
    })),
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function summarizeSingleLine(text: string, maxLen: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "unknown";
  }
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen)}...`;
}

function mapApiTaskStage(task: TaskQueueRecord): ApiTaskStage {
  if (task.status === "pending") {
    return task.nextRetryAt === null ? "queued" : "retrying";
  }
  if (task.status === "running") {
    return "executing";
  }
  if (task.status === "succeeded") {
    return "completed";
  }
  return "failed";
}

function buildApiTaskErrorSummary(task: TaskQueueRecord): string | null {
  const source =
    task.status === "failed"
      ? task.error ?? task.lastError
      : task.status === "pending" && task.nextRetryAt !== null
        ? task.lastError
        : null;
  if (!source) {
    return null;
  }
  return summarizeSingleLine(source, 240);
}

function parseQueuedInboundPayload(payloadJson: string): QueuedInboundPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error("Invalid queued payload JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid queued payload shape.");
  }

  const message = parseQueuedInboundMessage(parsed.message);
  const receivedAt = parseQueuedReceivedAt(parsed.receivedAt);
  const prompt = parseQueuedPrompt(parsed.prompt, message.text);
  return {
    message,
    receivedAt,
    prompt,
  };
}

function parseQueuedInboundMessage(value: unknown): InboundMessage {
  if (!isRecord(value)) {
    throw new Error("Invalid queued payload message.");
  }
  const eventId = parseRequiredString(value.eventId, "message.eventId");
  const requestId = parseOptionalString(value.requestId, eventId);
  const channelRaw = parseOptionalString(value.channel, "matrix");
  if (channelRaw !== "matrix") {
    throw new Error(`Unsupported queued payload channel: ${channelRaw}`);
  }
  const attachments = parseQueuedAttachments(value.attachments);
  return {
    requestId,
    channel: "matrix",
    conversationId: parseRequiredString(value.conversationId, "message.conversationId"),
    senderId: parseRequiredString(value.senderId, "message.senderId"),
    eventId,
    text: parseOptionalString(value.text, ""),
    attachments,
    isDirectMessage: parseOptionalBoolean(value.isDirectMessage),
    mentionsBot: parseOptionalBoolean(value.mentionsBot),
    repliesToBot: parseOptionalBoolean(value.repliesToBot),
  };
}

function parseQueuedAttachments(value: unknown): InboundMessage["attachments"] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Invalid queued payload attachments.");
  }
  return value.map((attachment, index) => parseQueuedAttachment(attachment, index));
}

function parseQueuedAttachment(value: unknown, index: number): InboundMessage["attachments"][number] {
  if (!isRecord(value)) {
    throw new Error(`Invalid queued attachment #${index + 1}.`);
  }
  const kind = parseRequiredString(value.kind, `attachments[${index}].kind`);
  if (kind !== "image" && kind !== "file" && kind !== "audio" && kind !== "video") {
    throw new Error(`Invalid queued attachment kind: ${kind}`);
  }
  return {
    kind,
    name: parseRequiredString(value.name, `attachments[${index}].name`),
    mxcUrl: parseNullableString(value.mxcUrl, `attachments[${index}].mxcUrl`),
    mimeType: parseNullableString(value.mimeType, `attachments[${index}].mimeType`),
    sizeBytes: parseNullableNumber(value.sizeBytes, `attachments[${index}].sizeBytes`),
    localPath: parseNullableString(value.localPath, `attachments[${index}].localPath`),
  };
}

function parseQueuedReceivedAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid queued payload receivedAt.");
  }
  return value;
}

function parseQueuedPrompt(value: unknown, fallbackText: string): string | null {
  if (value === undefined) {
    return fallbackText;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Invalid queued payload prompt.");
  }
  return value;
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid queued payload ${fieldName}.`);
  }
  return value;
}

function parseOptionalString(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error("Invalid queued payload string value.");
  }
  return value;
}

function parseOptionalBoolean(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error("Invalid queued payload boolean value.");
  }
  return value;
}

function parseNullableString(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid queued payload ${fieldName}.`);
  }
  return value;
}

function parseNullableNumber(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid queued payload ${fieldName}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shouldRetryClaudeImageFailure(provider: "codex" | "claude", imagePaths: string[], error: unknown): boolean {
  if (provider !== "claude" || imagePaths.length === 0) {
    return false;
  }
  if (error instanceof CodexExecutionCancelledError) {
    return false;
  }

  const message = formatError(error).toLowerCase();
  if (!message) {
    return false;
  }
  if (message.includes("timed out") || message.includes("timeout") || message.includes("cancelled")) {
    return false;
  }
  if (message.includes("unsupported image extension")) {
    return true;
  }

  const imageSignal =
    message.includes("image") ||
    message.includes("media_type") ||
    message.includes("base64") ||
    message.includes("stream-json") ||
    message.includes("input-format");
  const failureSignal =
    message.includes("invalid") ||
    message.includes("unsupported") ||
    message.includes("failed") ||
    message.includes("error") ||
    message.includes("too large") ||
    message.includes("too many");

  return imageSignal && failureSignal;
}

function normalizeImageMimeType(mimeType: string | null, localPath: string): string | null {
  const normalized = mimeType?.trim().toLowerCase() ?? "";
  if (normalized) {
    return normalized;
  }
  return inferImageMimeTypeFromPath(localPath);
}

function inferImageMimeTypeFromPath(localPath: string): string | null {
  const extension = path.extname(localPath).trim().toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  return null;
}

function formatMimeAllowlist(mimeTypes: string[]): string {
  if (mimeTypes.length === 0) {
    return "none";
  }
  return mimeTypes
    .map((value) => {
      const normalized = value.trim().toLowerCase();
      const slashIndex = normalized.indexOf("/");
      if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
        return normalized || value;
      }
      return normalized.slice(slashIndex + 1);
    })
    .join("/");
}

function formatMediaDiagEvents(events: MediaMetricEvent[]): string {
  if (events.length === 0) {
    return "- (no media records yet)";
  }
  return events
    .map(
      (event, index) =>
        `- #${index + 1} ${event.at} type=${event.type} requestId=${event.requestId} session=${event.sessionKey} detail=${event.detail}`,
    )
    .join("\n");
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

  const command = normalizeSlashCommandToken(text.split(/\s+/, 1)[0] ?? "");
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

function normalizeSlashCommandToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (normalized.startsWith("//")) {
    return normalized.slice(1);
  }
  return normalized;
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

function parseDiagTarget(
  text: string,
):
  | { kind: "version" }
  | { kind: "media"; limit: number }
  | { kind: "upgrade"; limit: number }
  | { kind: "autodev"; limit: number }
  | { kind: "queue"; limit: number }
  | { kind: "help" }
  | null {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return { kind: "help" };
  }
  const diagTokenIndex = tokens.findIndex((token) => normalizeSlashCommandToken(token) === "/diag");
  if (diagTokenIndex < 0) {
    return { kind: "help" };
  }
  const value = (tokens[diagTokenIndex + 1] ?? "").toLowerCase();
  const limitToken = tokens[diagTokenIndex + 2] ?? "";
  if (!value) {
    return { kind: "help" };
  }
  if (value === "version") {
    return { kind: "version" };
  }
  if (value === "media") {
    if (!limitToken) {
      return { kind: "media", limit: 10 };
    }
    const parsed = Number.parseInt(limitToken, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
      return null;
    }
    return { kind: "media", limit: parsed };
  }
  if (value === "upgrade") {
    if (!limitToken) {
      return { kind: "upgrade", limit: 5 };
    }
    const parsed = Number.parseInt(limitToken, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 20) {
      return null;
    }
    return { kind: "upgrade", limit: parsed };
  }
  if (value === "autodev") {
    if (!limitToken) {
      return { kind: "autodev", limit: 10 };
    }
    const parsed = Number.parseInt(limitToken, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
      return null;
    }
    return { kind: "autodev", limit: parsed };
  }
  if (value === "queue") {
    if (!limitToken) {
      return { kind: "queue", limit: 10 };
    }
    const parsed = Number.parseInt(limitToken, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 50) {
      return null;
    }
    return { kind: "queue", limit: parsed };
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

function parseEnvPositiveInt(raw: string | undefined, fallback: number): number {
  const normalized = raw?.trim();
  if (!normalized) {
    return fallback;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function parseEnvBoolean(raw: string | undefined, fallback: boolean): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
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

async function probeInstalledVersion(timeoutMs: number): Promise<UpgradeVersionProbeResult> {
  const invocations = resolveSelfUpdateInvocations();
  let firstError: unknown = null;

  for (const invocation of invocations) {
    const args = [...invocation.prefixArgs, "--version"];
    try {
      const { stdout, stderr } = await execFileAsync(invocation.file, args, {
        timeout: Math.max(1_000, timeoutMs),
        maxBuffer: 256 * 1024,
        env: process.env,
      });
      const output = `${normalizeCommandOutput(stdout)}\n${normalizeCommandOutput(stderr)}`;
      const version = parseSemanticVersion(output);
      if (version) {
        return {
          version,
          source: invocation.label,
          error: null,
        };
      }
    } catch (error) {
      if (!firstError && !isCommandNotFound(error)) {
        firstError = error;
      }
    }
  }

  return {
    version: null,
    source: "unavailable",
    error: firstError ? formatSelfUpdateError(firstError) : null,
  };
}

function evaluateUpgradePostCheck(input: {
  targetVersion: string | null;
  selfUpdateVersion: string | null;
  versionProbe: UpgradeVersionProbeResult;
}): { ok: boolean; installedVersion: string | null; checkDetail: string } {
  const installedVersion = input.versionProbe.version ?? input.selfUpdateVersion;
  const source = input.versionProbe.version ? `version probe (${input.versionProbe.source})` : "self-update output";

  if (!installedVersion) {
    const probeError = input.versionProbe.error ? `; probe=${input.versionProbe.error}` : "";
    return {
      ok: false,
      installedVersion: null,
      checkDetail: `无法确认安装版本${probeError}`,
    };
  }

  if (input.targetVersion && installedVersion !== input.targetVersion) {
    return {
      ok: false,
      installedVersion,
      checkDetail: `期望 ${input.targetVersion}，实际 ${installedVersion}`,
    };
  }

  return {
    ok: true,
    installedVersion,
    checkDetail: `installed=${installedVersion}; source=${source}`,
  };
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

function parseSemanticVersion(text: string): string | null {
  const match = text.match(/\b([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\b/);
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
    return sanitizeSelfUpdateErrorText(formatError(error)) || "unknown self-update error";
  }
  const maybeError = error as ExecFileException & {
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    message?: string;
  };
  const stderr = sanitizeSelfUpdateErrorText(normalizeOptionalCommandOutput(maybeError.stderr));
  if (stderr) {
    return summarizeCommandOutput(stderr);
  }
  const stdout = sanitizeSelfUpdateErrorText(normalizeOptionalCommandOutput(maybeError.stdout));
  if (stdout) {
    return summarizeCommandOutput(stdout);
  }
  return sanitizeSelfUpdateErrorText(maybeError.message?.trim() || formatError(error)) || "unknown self-update error";
}

function sanitizeSelfUpdateErrorText(text: string): string {
  const withoutWarning = text
    .replace(
      /\(\s*node:\d+\)\s*ExperimentalWarning:\s*SQLite is an experimental feature and might change at any time/gi,
      "",
    )
    .replace(/\(Use [`"]?node --trace-warnings[^)]*\)/gi, "");
  const filtered = withoutWarning
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      return true;
    });
  return filtered.join("\n").trim();
}

function normalizeOptionalCommandOutput(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return normalizeCommandOutput(value);
}

function indentMultiline(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
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

function formatByteSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes}B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)}KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
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

function formatUpgradeLockSummary(lock: UpgradeExecutionLockRecord | null): string {
  if (!lock) {
    return "idle";
  }
  return `owner=${lock.owner}, expiresAt=${new Date(lock.expiresAt).toISOString()}`;
}

function formatUpgradeDiagRecords(runs: UpgradeRunRecord[]): string {
  if (runs.length === 0) {
    return "- (empty)";
  }
  return runs
    .map((run) => {
      const finishedAt = run.finishedAt ? new Date(run.finishedAt).toISOString() : "N/A";
      return [
        `- #${run.id} status=${run.status} target=${run.targetVersion ?? "latest"} installed=${run.installedVersion ?? "unknown"}`,
        `  requestedBy=${run.requestedBy ?? "unknown"} startedAt=${new Date(run.startedAt).toISOString()} finishedAt=${finishedAt}`,
        `  error=${run.error ?? "none"}`,
      ].join("\n");
    })
    .join("\n");
}

function createEmptyWorkflowDiagStorePayload(): WorkflowDiagStorePayload {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    runs: [],
    events: [],
  };
}

function parseWorkflowDiagStorePayload(payloadJson: string | null): WorkflowDiagStorePayload {
  if (!payloadJson || !payloadJson.trim()) {
    return createEmptyWorkflowDiagStorePayload();
  }
  try {
    const parsed = JSON.parse(payloadJson) as Partial<WorkflowDiagStorePayload> | null;
    if (!parsed || typeof parsed !== "object") {
      return createEmptyWorkflowDiagStorePayload();
    }
    const runs = Array.isArray(parsed.runs) ? parsed.runs.filter(isWorkflowDiagRunRecord) : [];
    const events = Array.isArray(parsed.events) ? parsed.events.filter(isWorkflowDiagEventRecord) : [];
    const updatedAt = typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt : new Date(0).toISOString();
    return {
      version: 1,
      updatedAt,
      runs: runs.slice(-WORKFLOW_DIAG_MAX_RUNS),
      events: events.slice(-WORKFLOW_DIAG_MAX_EVENTS),
    };
  } catch {
    return createEmptyWorkflowDiagStorePayload();
  }
}

function isWorkflowDiagRunRecord(value: unknown): value is WorkflowDiagRunRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Partial<WorkflowDiagRunRecord>;
  if (typeof row.runId !== "string" || !row.runId.trim()) {
    return false;
  }
  if (row.kind !== "workflow" && row.kind !== "autodev") {
    return false;
  }
  if (typeof row.sessionKey !== "string" || typeof row.conversationId !== "string" || typeof row.requestId !== "string") {
    return false;
  }
  if (typeof row.objective !== "string" || typeof row.startedAt !== "string") {
    return false;
  }
  if (!(typeof row.taskId === "string" || row.taskId === null)) {
    return false;
  }
  if (!(typeof row.taskDescription === "string" || row.taskDescription === null)) {
    return false;
  }
  if (!["running", "succeeded", "failed", "cancelled"].includes(String(row.status ?? ""))) {
    return false;
  }
  if (!(typeof row.endedAt === "string" || row.endedAt === null)) {
    return false;
  }
  if (!(row.durationMs === null || (typeof row.durationMs === "number" && Number.isFinite(row.durationMs)))) {
    return false;
  }
  if (!(typeof row.approved === "boolean" || row.approved === null)) {
    return false;
  }
  if (typeof row.repairRounds !== "number" || !Number.isFinite(row.repairRounds)) {
    return false;
  }
  if (!(typeof row.error === "string" || row.error === null)) {
    return false;
  }
  if (!(typeof row.lastStage === "string" || row.lastStage === null)) {
    return false;
  }
  if (!(typeof row.lastMessage === "string" || row.lastMessage === null)) {
    return false;
  }
  if (typeof row.updatedAt !== "string") {
    return false;
  }
  return true;
}

function isWorkflowDiagEventRecord(value: unknown): value is WorkflowDiagEventRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Partial<WorkflowDiagEventRecord>;
  if (typeof row.runId !== "string" || !row.runId.trim()) {
    return false;
  }
  if (row.kind !== "workflow" && row.kind !== "autodev") {
    return false;
  }
  if (typeof row.stage !== "string" || typeof row.message !== "string" || typeof row.at !== "string") {
    return false;
  }
  if (typeof row.round !== "number" || !Number.isFinite(row.round)) {
    return false;
  }
  return true;
}

function formatAutoDevDiagRuns(
  runs: WorkflowDiagRunRecord[],
  resolveEvents: (runId: string) => WorkflowDiagEventRecord[],
): string {
  if (runs.length === 0) {
    return "- (empty)";
  }
  return runs
    .map((run) => {
      const stageText = run.lastStage ? `${run.lastStage}${run.lastMessage ? `(${run.lastMessage})` : ""}` : "N/A";
      const durationText = run.durationMs === null ? "running" : formatDurationMs(run.durationMs);
      const errorText = run.error ?? "none";
      const events = resolveEvents(run.runId);
      const eventSummary =
        events.length === 0
          ? "events=n/a"
          : `events=${events.map((event) => `${event.stage}#${event.round}`).join(" -> ")}`;
      return [
        `- run=${run.runId} status=${run.status} task=${run.taskId ?? "N/A"} approved=${
          run.approved === null ? "N/A" : run.approved ? "yes" : "no"
        } repairRounds=${run.repairRounds} duration=${durationText}`,
        `  lastStage=${stageText}`,
        `  ${eventSummary}`,
        `  error=${errorText}`,
      ].join("\n");
    })
    .join("\n");
}

function formatAutoDevGitCommitResult(result: AutoDevGitCommitResult): string {
  if (result.kind === "committed") {
    return `committed ${result.commitHash} (${result.commitSubject})`;
  }
  if (result.kind === "skipped") {
    return `skipped (${result.reason})`;
  }
  return `failed (${result.error})`;
}

function formatAutoDevGitChangedFiles(result: AutoDevGitCommitResult): string {
  if (result.kind !== "committed") {
    return "N/A";
  }
  if (result.changedFiles.length === 0) {
    return "(none)";
  }
  const preview = result.changedFiles.slice(0, 8).join(", ");
  if (result.changedFiles.length <= 8) {
    return preview;
  }
  return `${preview}, ... (+${result.changedFiles.length - 8})`;
}

function formatAutoDevGitCommitRecords(records: AutoDevGitCommitRecord[]): string {
  if (records.length === 0) {
    return "- (empty)";
  }
  return records
    .map((record) => {
      const base = `- at=${record.at} session=${record.sessionKey} task=${record.taskId} result=${formatAutoDevGitCommitResult(record.result)}`;
      if (record.result.kind !== "committed") {
        return base;
      }
      return `${base} files=${formatAutoDevGitChangedFiles(record.result)}`;
    })
    .join("\n");
}

function formatQueuePendingSessions(sessions: TaskQueuePendingSessionRecord[]): string {
  if (sessions.length === 0) {
    return "- (empty)";
  }
  return sessions.map((session) => `- firstTaskId=${session.firstTaskId} session=${session.sessionKey}`).join("\n");
}

function formatQueueFailureArchive(records: TaskFailureArchiveRecord[]): string {
  if (records.length === 0) {
    return "- (empty)";
  }
  return records
    .map((record) => {
      return `- #${record.id} task=${record.taskId} attempt=${record.attempt} retryReason=${record.retryReason} archiveReason=${record.archiveReason} failedAt=${new Date(record.failedAt).toISOString()} error=${record.error}`;
    })
    .join("\n");
}

function buildRateLimitNotice(decision: RateLimitDecision): string {
  if (decision.reason === "user_requests_per_window" || decision.reason === "room_requests_per_window") {
    const retrySec = Math.max(1, Math.ceil((decision.retryAfterMs ?? 1_000) / 1_000));
    return `[CodeHarbor] 请求过于频繁，请在 ${retrySec} 秒后重试。`;
  }
  return "[CodeHarbor] 当前任务并发较高，请稍后再试。";
}

function classifyQueueTaskRetry(policy: RetryPolicy, attempt: number, error: unknown): RetryDecision {
  return classifyRetryDecision({
    policy,
    attempt,
    error,
  });
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
