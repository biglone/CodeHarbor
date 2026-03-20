import { Mutex } from "async-mutex";
import fs from "node:fs/promises";
import os from "node:os";

import { AudioTranscriber, type AudioTranscriberLike, type AudioTranscript } from "./audio-transcriber";
import { type Channel } from "./channels/channel";
import { CliCompatRecorder } from "./compat/cli-compat-recorder";
import { ConfigService } from "./config-service";
import { CliCompatConfig, TriggerPolicy, type RoomTriggerPolicyOverrides } from "./config";
import {
  CodexExecutor,
  type CodexProgressEvent,
} from "./executor/codex-executor";
import { CodexSessionRuntime } from "./executor/codex-session-runtime";
import {
  DEFAULT_DOCUMENT_MAX_BYTES,
  extractDocumentText,
} from "./document-extractor";
import { buildDocumentContextPrompt, type DocumentContextItem } from "./document-context";
import { Logger } from "./logger";
import {
  type RequestOutcomeMetric,
  type RuntimeMetricsSnapshot,
} from "./metrics";
import {
  formatPackageUpdateHint,
  NpmRegistryUpdateChecker,
  type PackageUpdateChecker,
  resolvePackageVersion,
} from "./package-update-checker";
import { RateLimiter, type RateLimiterOptions } from "./rate-limiter";
import {
  BackendModelRouter,
  type BackendModelRouteInput,
  type BackendModelRouteProfile,
  type BackendModelRouteRule,
  type BackendModelRouteTaskType,
} from "./routing/backend-model-router";
import {
  GLOBAL_RUNTIME_HOT_CONFIG_KEY,
  parseRuntimeHotConfigPayload,
  type RuntimeHotConfigPayload,
} from "./runtime-hot-config";
import {
  ARCHIVE_REASON_MAX_ATTEMPTS,
  ARCHIVE_REASON_NON_RETRYABLE,
  createRetryPolicy,
  type RetryPolicy,
  type RetryPolicyInput,
} from "./reliability/retry-policy";
import {
  StateStore,
  type TaskFailureArchiveRecord,
  type TaskQueueEnqueueInput,
  type TaskQueueRecord,
  type UpgradeExecutionLockRecord,
  type UpgradeRunRecord,
  type UpgradeRunStats,
} from "./store/state-store";
import { InboundMessage } from "./types";
import { extractCommandText } from "./utils/message";
import {
  MultiAgentWorkflowRunner,
  type MultiAgentWorkflowRunResult,
  type WorkflowRunSnapshot,
} from "./workflow/multi-agent-workflow";
import {
  type AutoDevTask,
  parseAutoDevCommand,
  updateAutoDevTaskStatus,
} from "./workflow/autodev";
import {
  WorkflowRoleSkillCatalog,
  type WorkflowRole,
  type WorkflowRoleSkillDisclosureMode,
  type WorkflowRoleSkillPolicyOverride,
} from "./workflow/role-skills";
import {
  formatDurationMs,
  formatError,
  formatWorkflowContextBudget,
  formatWorkflowRoleSkillLoaded,
  parseCsvValues,
  parseEnvBoolean,
  parseEnvOptionalPositiveInt,
  parseEnvPositiveInt,
  parseOptionalCsvValues,
  parseRoleSkillAssignments,
  parseRoleSkillDisclosureMode,
  summarizeSingleLine,
} from "./orchestrator/helpers";
import {
  type AutoDevGitCommitResult,
} from "./orchestrator/autodev-git";
import {
  runAutoDevCommand,
  type AutoDevRunContext,
} from "./orchestrator/autodev-runner";
import {
  classifyBackendTaskType,
  isSameBackendProfile,
  normalizeBackendProfile,
  parseBackendTarget,
  parseControlCommand,
  parseUpgradeTarget,
} from "./orchestrator/command-routing";
import {
  collectLocalAttachmentPaths,
  formatMimeAllowlist,
  mapProgressText,
  normalizeImageMimeType,
} from "./orchestrator/media-progress";
import {
  isApiTaskPayloadEquivalent,
  normalizeApiTaskRequestId,
  parseQueuedInboundPayload,
  type QueuedInboundPayload,
} from "./orchestrator/queue-payload";
import {
  buildRateLimitNotice,
  classifyExecutionOutcome,
} from "./orchestrator/workflow-status";
import { AutoDevRuntimeMetrics, MediaMetrics, RequestMetrics } from "./orchestrator/runtime-metrics";
import {
  buildDefaultUpgradeRestartPlan,
  evaluateUpgradePostCheck,
  formatSelfUpdateError,
  probeInstalledVersion,
  runSelfUpdateCommand,
  type SelfUpdateResult,
  type UpgradeRestartPlan,
  type UpgradeVersionProbeResult,
} from "./orchestrator/upgrade-utils";
import {
  describeBackendRouteReason,
  formatBackendRouteProfile,
  isBackendRouteFallbackReason,
} from "./orchestrator/diagnostic-formatters";
import {
  handleControlCommand as runControlCommand,
  type ControlCommand,
} from "./orchestrator/control-command-handler";
import { handleDiagCommand as runDiagCommand } from "./orchestrator/diag-command";
import { executeChatRequest } from "./orchestrator/chat-request";
import { executeAgentRunRequest } from "./orchestrator/agent-run-request";
import {
  handleAutoDevLoopStopCommand as runAutoDevLoopStopCommand,
  handleAutoDevProgressCommand as runAutoDevProgressCommand,
  handleAutoDevSkillsCommand as runAutoDevSkillsCommand,
  type AutoDevControlCommandDeps,
} from "./orchestrator/autodev-control-command";
import { handleAutoDevStatusCommand as runAutoDevStatusCommand } from "./orchestrator/autodev-status-command";
import { tryHandleNonBlockingStatusRoute as runNonBlockingStatusRoute } from "./orchestrator/non-blocking-status-route";
import { handleLockedRouteCommand } from "./orchestrator/locked-route-command";
import { tryEnqueueQueuedInboundRequest } from "./orchestrator/queue-enqueue";
import { executeWorkflowRunRequest } from "./orchestrator/workflow-run-request";
import { handleStatusCommand } from "./orchestrator/status-command";
import { handleWorkflowStatusCommand as runWorkflowStatusCommand } from "./orchestrator/workflow-status-command";
import {
  buildApiTaskErrorSummary,
  buildApiTaskEventId,
  buildSessionKey,
  classifyQueueTaskRetry,
  cleanupAttachmentFiles,
  formatByteSize,
  mapApiTaskStage,
  stripLeadingBotMention,
} from "./orchestrator/misc-utils";
import {
  WORKFLOW_DIAG_MAX_EVENTS,
  WORKFLOW_DIAG_MAX_RUNS,
  createEmptyWorkflowDiagStorePayload,
  parseWorkflowDiagStorePayload,
  type WorkflowDiagEventRecord,
  type WorkflowDiagRunKind,
  type WorkflowDiagRunRecord,
  type WorkflowDiagRunStatus,
  type WorkflowDiagStorePayload,
} from "./orchestrator/workflow-diag";

export { buildApiTaskEventId, buildSessionKey };

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
    planContextMaxChars?: number | null;
    outputContextMaxChars?: number | null;
    feedbackContextMaxChars?: number | null;
    roleSkills?: {
      enabled?: boolean;
      mode?: WorkflowRoleSkillDisclosureMode;
      maxChars?: number;
      roots?: string[];
      roleAssignments?: Partial<Record<WorkflowRole, string[]>>;
    };
  };
  packageUpdateChecker?: PackageUpdateChecker;
  updateCheckTtlMs?: number;
  audioTranscriber?: AudioTranscriberLike;
  configService?: ConfigService;
  defaultCodexWorkdir?: string;
  aiCliProvider?: "codex" | "claude";
  aiCliModel?: string | null;
  backendModelRoutingRules?: BackendModelRouteRule[];
  matrixAdminUsers?: string[];
  executorFactory?: (provider: "codex" | "claude", model?: string | null) => CodexExecutor;
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
  autoDevDetailedProgressEnabled?: boolean;
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

interface SessionBackendOverride {
  profile: BackendModelRouteProfile;
  updatedAt: number;
}

interface SessionBackendDecision {
  profile: BackendModelRouteProfile;
  source: "manual_override" | "rule" | "default";
  reasonCode: "manual_override" | "rule_match" | "default_fallback" | "factory_unavailable";
  ruleId: string | null;
}

interface BackendRuntimeBundle {
  profile: BackendModelRouteProfile;
  executor: CodexExecutor;
  sessionRuntime: CodexSessionRuntime;
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

interface DocumentExtractionSummary {
  documents: DocumentContextItem[];
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

interface BackendRouteDiagRecord {
  at: string;
  sessionKey: string;
  conversationId: string;
  senderId: string;
  taskType: BackendModelRouteTaskType;
  source: SessionBackendDecision["source"];
  reasonCode: SessionBackendDecision["reasonCode"];
  ruleId: string | null;
  profile: BackendModelRouteProfile;
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

type SelfUpdateRunner = (input: { version: string | null }) => Promise<SelfUpdateResult>;
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

const RUN_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
const RUN_SNAPSHOT_MAX_ENTRIES = 500;
const CONTEXT_BRIDGE_HISTORY_LIMIT = 16;
const CONTEXT_BRIDGE_MAX_CHARS = 8_000;
const DEFAULT_SELF_UPDATE_TIMEOUT_MS = 20 * 60 * 1_000;
const DEFAULT_UPGRADE_LOCK_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_TASK_QUEUE_RECOVERY_BATCH_LIMIT = 200;
const WORKFLOW_DIAG_SNAPSHOT_KEY = "workflow_diag";
const DEFAULT_AUTODEV_LOOP_MAX_RUNS = 20;
const DEFAULT_AUTODEV_LOOP_MAX_MINUTES = 120;
const DEFAULT_AUTODEV_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_AUTODEV_DETAILED_PROGRESS_ENABLED = true;
const DEFAULT_WORKFLOW_ROLE_SKILLS_ENABLED = true;
const DEFAULT_WORKFLOW_ROLE_SKILLS_MODE: WorkflowRoleSkillDisclosureMode = "progressive";
const AUTODEV_GIT_COMMIT_HISTORY_MAX = 120;
const BACKEND_ROUTE_DIAG_HISTORY_MAX = 200;
const DEFAULT_TASK_QUEUE_RETRY_POLICY: RetryPolicyInput = {
  maxAttempts: 4,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
};

export class Orchestrator {
  private readonly channel: Channel;
  private readonly executorFactory: ((provider: "codex" | "claude", model?: string | null) => CodexExecutor) | null;
  private readonly backendRuntimes = new Map<string, BackendRuntimeBundle>();
  private readonly sessionBackendOverrides = new Map<string, SessionBackendOverride>();
  private readonly sessionBackendProfiles = new Map<string, BackendModelRouteProfile>();
  private readonly sessionLastBackendDecisions = new Map<string, SessionBackendDecision>();
  private readonly stateStore: StateStore;
  private readonly logger: Logger;
  private readonly sessionLocks = new Map<string, SessionLockEntry>();
  private readonly runningExecutions = new Map<string, RunningExecution>();
  private readonly activeSessionRequestCounts = new Map<string, number>();
  private readonly pendingStopRequests = new Set<string>();
  private readonly pendingAutoDevLoopStopRequests = new Set<string>();
  private readonly activeAutoDevLoopSessions = new Set<string>();
  private readonly skipBridgeForNextPrompt = new Set<string>();
  private readonly lockTtlMs: number;
  private readonly lockPruneIntervalMs: number;
  private progressUpdatesEnabled: boolean;
  private progressMinIntervalMs: number;
  private typingTimeoutMs: number;
  private readonly commandPrefix: string;
  private readonly matrixUserId: string;
  private sessionActiveWindowMs: number;
  private groupDirectModeEnabled: boolean;
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
  private readonly defaultBackendProfile: BackendModelRouteProfile;
  private readonly backendModelRouter: BackendModelRouter;
  private readonly botNoticePrefix: string;
  private readonly processStartedAtIso: string;
  private readonly matrixAdminUsers: Set<string>;
  private readonly workflowSnapshots = new Map<string, WorkflowRunSnapshot>();
  private readonly autoDevSnapshots = new Map<string, AutoDevRunSnapshot>();
  private readonly autoDevFailureStreaks = new Map<string, number>();
  private readonly autoDevGitCommitRecords: AutoDevGitCommitRecord[] = [];
  private readonly backendRouteDiagRecords: BackendRouteDiagRecord[] = [];
  private readonly autoDevLoopMaxRuns: number;
  private readonly autoDevLoopMaxMinutes: number;
  private readonly autoDevAutoCommit: boolean;
  private readonly autoDevMaxConsecutiveFailures: number;
  private readonly autoDevDetailedProgressDefaultEnabled: boolean;
  private readonly autoDevDetailedProgressOverrides = new Map<string, boolean>();
  private readonly workflowRoleSkillCatalog: WorkflowRoleSkillCatalog;
  private readonly workflowRoleSkillDefaultPolicy: WorkflowRoleSkillPolicyOverride;
  private readonly workflowRoleSkillPolicyOverrides = new Map<string, WorkflowRoleSkillPolicyOverride>();
  private readonly workflowPlanContextMaxChars: number | null;
  private readonly workflowOutputContextMaxChars: number | null;
  private readonly workflowFeedbackContextMaxChars: number | null;
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
  private hotConfigVersion = 0;
  private hotConfigRejectedVersion = 0;

  constructor(
    channel: Channel,
    executor: CodexExecutor,
    stateStore: StateStore,
    logger: Logger,
    options?: OrchestratorOptions,
  ) {
    this.channel = channel;
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
    const workflowPlanContextMaxChars =
      options?.multiAgentWorkflow?.planContextMaxChars ??
      parseEnvOptionalPositiveInt(process.env.AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS);
    const workflowOutputContextMaxChars =
      options?.multiAgentWorkflow?.outputContextMaxChars ??
      parseEnvOptionalPositiveInt(process.env.AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS);
    const workflowFeedbackContextMaxChars =
      options?.multiAgentWorkflow?.feedbackContextMaxChars ??
      parseEnvOptionalPositiveInt(process.env.AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS);
    const workflowRoleSkillsEnabled =
      options?.multiAgentWorkflow?.roleSkills?.enabled ??
      parseEnvBoolean(process.env.AGENT_WORKFLOW_ROLE_SKILLS_ENABLED, DEFAULT_WORKFLOW_ROLE_SKILLS_ENABLED);
    const workflowRoleSkillsMode = parseRoleSkillDisclosureMode(
      options?.multiAgentWorkflow?.roleSkills?.mode ?? process.env.AGENT_WORKFLOW_ROLE_SKILLS_MODE,
      DEFAULT_WORKFLOW_ROLE_SKILLS_MODE,
    );
    const workflowRoleSkillsMaxChars =
      options?.multiAgentWorkflow?.roleSkills?.maxChars ??
      parseEnvOptionalPositiveInt(process.env.AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS) ??
      undefined;
    const workflowRoleSkillsRoots = options?.multiAgentWorkflow?.roleSkills?.roots ?? parseOptionalCsvValues(
      process.env.AGENT_WORKFLOW_ROLE_SKILLS_ROOTS,
    );
    const workflowRoleSkillAssignments =
      options?.multiAgentWorkflow?.roleSkills?.roleAssignments ??
      parseRoleSkillAssignments(process.env.AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON);
    this.workflowRoleSkillCatalog = new WorkflowRoleSkillCatalog({
      enabled: workflowRoleSkillsEnabled,
      mode: workflowRoleSkillsMode,
      maxChars: workflowRoleSkillsMaxChars,
      roots: workflowRoleSkillsRoots,
      roleAssignments: workflowRoleSkillAssignments,
    });
    this.workflowRoleSkillDefaultPolicy = {
      enabled: workflowRoleSkillsEnabled,
      mode: workflowRoleSkillsMode,
    };
    this.workflowPlanContextMaxChars = workflowPlanContextMaxChars;
    this.workflowOutputContextMaxChars = workflowOutputContextMaxChars;
    this.workflowFeedbackContextMaxChars = workflowFeedbackContextMaxChars;
    this.workflowRunner = new MultiAgentWorkflowRunner(executor, this.logger, {
      enabled: options?.multiAgentWorkflow?.enabled ?? false,
      autoRepairMaxRounds: options?.multiAgentWorkflow?.autoRepairMaxRounds ?? 1,
      executionTimeoutMs: options?.multiAgentWorkflow?.executionTimeoutMs,
      planContextMaxChars: workflowPlanContextMaxChars,
      outputContextMaxChars: workflowOutputContextMaxChars,
      feedbackContextMaxChars: workflowFeedbackContextMaxChars,
      roleSkillCatalog: this.workflowRoleSkillCatalog,
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
    this.autoDevDetailedProgressDefaultEnabled =
      options?.autoDevDetailedProgressEnabled ?? DEFAULT_AUTODEV_DETAILED_PROGRESS_ENABLED;
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
    this.defaultBackendProfile = {
      provider: options?.aiCliProvider ?? "codex",
      model: options?.aiCliModel?.trim() || null,
    };
    this.backendModelRouter = new BackendModelRouter(options?.backendModelRoutingRules ?? []);
    const defaultBackendProfileKey = this.serializeBackendProfile(this.defaultBackendProfile);
    this.backendRuntimes.set(defaultBackendProfileKey, {
      profile: this.defaultBackendProfile,
      executor,
      sessionRuntime: new CodexSessionRuntime(executor),
    });
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
    let sessionKeyForLifecycle: string | null = null;

    try {
      const requestId = message.requestId || message.eventId;
      this.syncRuntimeHotConfig();
      const sessionKey = buildSessionKey(message);
      sessionKeyForLifecycle = sessionKey;
      this.markSessionRequestStarted(sessionKey);

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

        const routeCommandResult = await handleLockedRouteCommand(
          {
            workflowEnabled: this.workflowRunner.isEnabled(),
            markEventProcessed: (targetSessionKey, eventId) => this.stateStore.markEventProcessed(targetSessionKey, eventId),
            handleControlCommand: (command, targetSessionKey, targetMessage, targetRequestId) =>
              this.handleControlCommand(command, targetSessionKey, targetMessage, targetRequestId),
            handleWorkflowStatusCommand: (targetSessionKey, targetMessage) =>
              this.handleWorkflowStatusCommand(targetSessionKey, targetMessage),
            handleAutoDevStatusCommand: (targetSessionKey, targetMessage, workdir) =>
              this.handleAutoDevStatusCommand(targetSessionKey, targetMessage, workdir),
            handleAutoDevProgressCommand: (targetSessionKey, targetMessage, mode) =>
              this.handleAutoDevProgressCommand(targetSessionKey, targetMessage, mode),
            handleAutoDevSkillsCommand: (targetSessionKey, targetMessage, mode) =>
              this.handleAutoDevSkillsCommand(targetSessionKey, targetMessage, mode),
            handleAutoDevLoopStopCommand: (targetSessionKey, targetMessage) =>
              this.handleAutoDevLoopStopCommand(targetSessionKey, targetMessage),
          },
          {
            route,
            sessionKey,
            message,
            requestId,
            workdir: roomConfig.workdir,
          },
        );
        if (routeCommandResult.handled) {
          return;
        }
        if (route.kind !== "execute") {
          return;
        }
        const { workflowCommand, autoDevCommand } = routeCommandResult;

        const queueEnqueueResult = tryEnqueueQueuedInboundRequest(
          {
            getTaskQueueStateStore: () => this.getTaskQueueStateStore(),
          },
          {
            bypassQueue: options.bypassQueue,
            sessionKey,
            message,
            requestId,
            receivedAt,
            routePrompt: route.prompt,
          },
        );
        if (queueEnqueueResult.duplicate) {
          this.recordRequestMetrics("duplicate", queueWaitMs, 0, 0);
          this.logger.debug("Duplicate event ignored by task queue dedupe", {
            requestId,
            eventId: message.eventId,
            sessionKey,
            queueWaitMs,
          });
          return;
        }
        if (queueEnqueueResult.queued) {
          deferAttachmentCleanup = true;
          queueDrainSessionKey = sessionKey;
          this.logger.debug("Inbound request queued", {
            requestId,
            eventId: message.eventId,
            sessionKey,
            taskId: queueEnqueueResult.taskId,
          });
          return;
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

        const taskType = classifyBackendTaskType(workflowCommand, autoDevCommand);
        const backendDecision = this.resolveSessionBackendDecision({
          sessionKey,
          message,
          taskType,
          routePrompt: route.prompt,
        });
        const backendRuntime = this.prepareBackendRuntimeForSession(sessionKey, backendDecision.profile);
        this.sessionLastBackendDecisions.set(sessionKey, backendDecision);
        this.recordBackendRouteDecision({
          sessionKey,
          message,
          taskType,
          decision: backendDecision,
        });

        if (workflowCommand?.kind === "run") {
          await executeAgentRunRequest(
            {
              logger: this.logger,
              sessionActiveWindowMs: this.sessionActiveWindowMs,
              stateStore: this.stateStore,
              workflowRunner: this.workflowRunner,
              recordRequestMetrics: (outcome, queueMs, execMs, sendMs) =>
                this.recordRequestMetrics(outcome, queueMs, execMs, sendMs),
              persistRuntimeMetricsSnapshot: () => this.persistRuntimeMetricsSnapshot(),
            },
            {
              kind: "workflow",
              sessionKey,
              message,
              requestId,
              queueWaitMs,
              workdir: roomConfig.workdir,
              deferFailureHandlingToQueue: options.deferFailureHandlingToQueue,
              executor: backendRuntime.executor,
              run: async () => {
                await this.handleWorkflowRunCommand(
                  workflowCommand.objective,
                  sessionKey,
                  message,
                  requestId,
                  roomConfig.workdir,
                );
              },
              sendFailure: (conversationId, error) => this.sendWorkflowFailure(conversationId, error),
              releaseRateLimit: () => {
                rateDecision.release?.();
              },
            },
          );
          return;
        }

        if (autoDevCommand?.kind === "run") {
          await executeAgentRunRequest(
            {
              logger: this.logger,
              sessionActiveWindowMs: this.sessionActiveWindowMs,
              stateStore: this.stateStore,
              workflowRunner: this.workflowRunner,
              recordRequestMetrics: (outcome, queueMs, execMs, sendMs) =>
                this.recordRequestMetrics(outcome, queueMs, execMs, sendMs),
              persistRuntimeMetricsSnapshot: () => this.persistRuntimeMetricsSnapshot(),
            },
            {
              kind: "autodev",
              sessionKey,
              message,
              requestId,
              queueWaitMs,
              workdir: roomConfig.workdir,
              deferFailureHandlingToQueue: options.deferFailureHandlingToQueue,
              executor: backendRuntime.executor,
              run: async () => {
                await this.handleAutoDevRunCommand(
                  autoDevCommand.taskId,
                  sessionKey,
                  message,
                  requestId,
                  roomConfig.workdir,
                );
              },
              sendFailure: (conversationId, error) => this.sendAutoDevFailure(conversationId, error),
              releaseRateLimit: () => {
                rateDecision.release?.();
              },
            },
          );
          return;
        }

        await executeChatRequest(
          {
            logger: this.logger,
            sessionActiveWindowMs: this.sessionActiveWindowMs,
            cliCompat: {
              enabled: this.cliCompat.enabled,
              passThroughEvents: this.cliCompat.passThroughEvents,
            },
            stateStore: this.stateStore,
            skipBridgeForNextPrompt: this.skipBridgeForNextPrompt,
            mediaMetrics: this.mediaMetrics,
            runningExecutions: this.runningExecutions,
            consumePendingStopRequest: (targetSessionKey) => this.consumePendingStopRequest(targetSessionKey),
            persistRuntimeMetricsSnapshot: () => this.persistRuntimeMetricsSnapshot(),
            recordRequestMetrics: (outcome, queueMs, execMs, sendMs) =>
              this.recordRequestMetrics(outcome, queueMs, execMs, sendMs),
            recordCliCompatPrompt: (entry) => this.recordCliCompatPrompt(entry),
            buildConversationBridgeContext: (targetSessionKey) => this.buildConversationBridgeContext(targetSessionKey),
            transcribeAudioAttachments: (targetMessage, targetRequestId, targetSessionKey) =>
              this.transcribeAudioAttachments(targetMessage, targetRequestId, targetSessionKey),
            prepareImageAttachments: (targetMessage, targetRequestId, targetSessionKey) =>
              this.prepareImageAttachments(targetMessage, targetRequestId, targetSessionKey),
            prepareDocumentAttachments: (targetMessage, targetRequestId, targetSessionKey) =>
              this.prepareDocumentAttachments(targetMessage, targetRequestId, targetSessionKey),
            buildExecutionPrompt: (basePrompt, targetMessage, audioTranscripts, documents, bridgeContext) =>
              this.buildExecutionPrompt(basePrompt, targetMessage, audioTranscripts, documents, bridgeContext),
            sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
            sendMessage: (conversationId, text) => this.channel.sendMessage(conversationId, text),
            startTypingHeartbeat: (conversationId) => this.startTypingHeartbeat(conversationId),
            handleProgress: (
              conversationId,
              isDirectMessage,
              progress,
              getLastProgressAt,
              setLastProgressAt,
              getLastProgressText,
              setLastProgressText,
              getProgressNoticeEventId,
              setProgressNoticeEventId,
            ) =>
              this.handleProgress(
                conversationId,
                isDirectMessage,
                progress,
                getLastProgressAt,
                setLastProgressAt,
                getLastProgressText,
                setLastProgressText,
                getProgressNoticeEventId,
                setProgressNoticeEventId,
              ),
            finishProgress: (ctx, summary) => this.finishProgress(ctx, summary),
            formatBackendToolLabel: (profile) => this.formatBackendToolLabel(profile),
          },
          {
            message,
            receivedAt,
            queueWaitMs,
            routePrompt: route.prompt,
            sessionKey,
            requestId,
            roomWorkdir: roomConfig.workdir,
            roomConfigSource: roomConfig.source,
            backendProfile: backendDecision.profile,
            backendRouteSource: backendDecision.source,
            backendRouteReason: backendDecision.reasonCode,
            backendRouteRuleId: backendDecision.ruleId,
            sessionRuntime: backendRuntime.sessionRuntime,
            deferFailureHandlingToQueue: options.deferFailureHandlingToQueue,
            releaseRateLimit: () => {
              rateDecision.release?.();
            },
          },
        );
      });
    } finally {
      if (sessionKeyForLifecycle) {
        this.markSessionRequestFinished(sessionKeyForLifecycle);
      }
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
    return runNonBlockingStatusRoute(
      {
        logger: this.logger,
        workflowEnabled: this.workflowRunner.isEnabled(),
        hasProcessedEvent: (sessionKey, eventId) => this.stateStore.hasProcessedEvent(sessionKey, eventId),
        markEventProcessed: (sessionKey, eventId) => this.stateStore.markEventProcessed(sessionKey, eventId),
        recordRequestMetrics: (outcome, queueMs, execMs, sendMs) =>
          this.recordRequestMetrics(outcome, queueMs, execMs, sendMs),
        handleControlCommand: (command, sessionKey, message, requestId) =>
          this.handleControlCommand(command, sessionKey, message, requestId),
        handleWorkflowStatusCommand: (sessionKey, message) => this.handleWorkflowStatusCommand(sessionKey, message),
        handleAutoDevStatusCommand: (sessionKey, message, workdir) =>
          this.handleAutoDevStatusCommand(sessionKey, message, workdir),
        handleAutoDevProgressCommand: (sessionKey, message, mode) =>
          this.handleAutoDevProgressCommand(sessionKey, message, mode),
        handleAutoDevSkillsCommand: (sessionKey, message, mode) => this.handleAutoDevSkillsCommand(sessionKey, message, mode),
        handleAutoDevLoopStopCommand: (sessionKey, message) => this.handleAutoDevLoopStopCommand(sessionKey, message),
      },
      {
        route: input.route,
        sessionKey: input.sessionKey,
        message: input.message,
        requestId: input.requestId,
        workdir: input.roomConfig.workdir,
        queueWaitMs: input.queueWaitMs,
      },
    );
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

    const rawAutoDevCommand = this.workflowRunner.isEnabled() ? parseAutoDevCommand(incomingTrimmed) : null;
    if (
      rawAutoDevCommand?.kind === "status" ||
      rawAutoDevCommand?.kind === "stop" ||
      rawAutoDevCommand?.kind === "progress" ||
      rawAutoDevCommand?.kind === "skills"
    ) {
      return {
        kind: "execute",
        prompt: incomingTrimmed,
      };
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
    command: ControlCommand,
    sessionKey: string,
    message: InboundMessage,
    requestId: string,
  ): Promise<void> {
    await runControlCommand(
      {
        sessionActiveWindowMs: this.sessionActiveWindowMs,
        botNoticePrefix: this.botNoticePrefix,
        stateStore: this.stateStore,
        clearSessionFromAllRuntimes: (targetSessionKey) => this.clearSessionFromAllRuntimes(targetSessionKey),
        sessionBackendOverrides: this.sessionBackendOverrides,
        sessionBackendProfiles: this.sessionBackendProfiles,
        sessionLastBackendDecisions: this.sessionLastBackendDecisions,
        skipBridgeForNextPrompt: this.skipBridgeForNextPrompt,
        workflowSnapshots: this.workflowSnapshots,
        autoDevSnapshots: this.autoDevSnapshots,
        autoDevDetailedProgressOverrides: this.autoDevDetailedProgressOverrides,
        workflowRoleSkillPolicyOverrides: this.workflowRoleSkillPolicyOverrides,
        pendingStopRequests: this.pendingStopRequests,
        pendingAutoDevLoopStopRequests: this.pendingAutoDevLoopStopRequests,
        activeAutoDevLoopSessions: this.activeAutoDevLoopSessions,
        getPackageUpdateStatus: (query) => this.packageUpdateChecker.getStatus(query),
        formatMultimodalHelpStatus: () => this.formatMultimodalHelpStatus(),
        sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
        handleStatusCommand: (targetSessionKey, targetMessage) => this.sendStatusCommand(targetSessionKey, targetMessage),
        handleStopCommand: (targetSessionKey, targetMessage, targetRequestId) =>
          this.handleStopCommand(targetSessionKey, targetMessage, targetRequestId),
        handleBackendCommand: (targetSessionKey, targetMessage) => this.handleBackendCommand(targetSessionKey, targetMessage),
        handleDiagCommand: (targetMessage) => this.handleDiagCommand(targetMessage),
        handleUpgradeCommand: (targetMessage) => this.handleUpgradeCommand(targetMessage),
      },
      {
        command,
        sessionKey,
        message,
        requestId,
      },
    );
  }

  private async sendStatusCommand(sessionKey: string, message: InboundMessage): Promise<void> {
    await handleStatusCommand(
      {
        botNoticePrefix: this.botNoticePrefix,
        groupDirectModeEnabled: this.groupDirectModeEnabled,
        updateCheckTtlMs: this.updateCheckTtlMs,
        cliCompatEnabled: this.cliCompat.enabled,
        workflowEnabled: this.workflowRunner.isEnabled(),
        autoDevDetailedProgressDefaultEnabled: this.autoDevDetailedProgressDefaultEnabled,
        workflowPlanContextMaxChars: this.workflowPlanContextMaxChars,
        workflowOutputContextMaxChars: this.workflowOutputContextMaxChars,
        workflowFeedbackContextMaxChars: this.workflowFeedbackContextMaxChars,
        getSessionStatus: (targetSessionKey) => this.stateStore.getSessionStatus(targetSessionKey),
        resolveRoomRuntimeConfig: (conversationId) => this.resolveRoomRuntimeConfig(conversationId),
        getRuntimeMetricsSnapshot: () => this.metrics.snapshot(this.runningExecutions.size),
        getRateLimiterSnapshot: () => this.rateLimiter.snapshot(),
        getBackendRuntimeStats: () => this.getBackendRuntimeStats(),
        getWorkflowSnapshot: (targetSessionKey) => this.workflowSnapshots.get(targetSessionKey) ?? null,
        getAutoDevSnapshot: (targetSessionKey) => this.autoDevSnapshots.get(targetSessionKey) ?? null,
        hasActiveAutoDevLoopSession: (targetSessionKey) => this.activeAutoDevLoopSessions.has(targetSessionKey),
        hasPendingAutoDevLoopStopRequest: (targetSessionKey) => this.pendingAutoDevLoopStopRequests.has(targetSessionKey),
        hasPendingStopRequest: (targetSessionKey) => this.pendingStopRequests.has(targetSessionKey),
        isAutoDevDetailedProgressEnabled: (targetSessionKey) => this.isAutoDevDetailedProgressEnabled(targetSessionKey),
        listWorkflowDiagRunsBySession: (kind, targetSessionKey, limit) =>
          this.listWorkflowDiagRunsBySession(kind, targetSessionKey, limit),
        listWorkflowDiagEvents: (runId, limit) => this.listWorkflowDiagEvents(runId, limit),
        buildWorkflowRoleSkillStatus: (targetSessionKey) => this.buildWorkflowRoleSkillStatus(targetSessionKey),
        getPackageUpdateStatus: () => this.packageUpdateChecker.getStatus(),
        getLatestUpgradeRun: () => this.getLatestUpgradeRun(),
        getRecentUpgradeRuns: (limit) => this.getRecentUpgradeRuns(limit),
        getUpgradeRunStats: () => this.getUpgradeRunStats(),
        getUpgradeExecutionLockSnapshot: () => this.getUpgradeExecutionLockSnapshot(),
        resolveSessionBackendStatusProfile: (targetSessionKey) => this.resolveSessionBackendStatusProfile(targetSessionKey),
        hasSessionBackendOverride: (targetSessionKey) => this.sessionBackendOverrides.has(targetSessionKey),
        getSessionBackendDecision: (targetSessionKey) => this.sessionLastBackendDecisions.get(targetSessionKey) ?? null,
        formatBackendToolLabel: (profile) => this.formatBackendToolLabel(profile),
        formatWorkflowContextBudget: (value) => formatWorkflowContextBudget(value),
        sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
      },
      {
        sessionKey,
        message,
      },
    );
  }

  private async handleWorkflowStatusCommand(sessionKey: string, message: InboundMessage): Promise<void> {
    await runWorkflowStatusCommand(
      {
        workflowPlanContextMaxChars: this.workflowPlanContextMaxChars,
        workflowOutputContextMaxChars: this.workflowOutputContextMaxChars,
        workflowFeedbackContextMaxChars: this.workflowFeedbackContextMaxChars,
        getWorkflowSnapshot: (targetSessionKey) => this.workflowSnapshots.get(targetSessionKey) ?? null,
        buildWorkflowRoleSkillStatus: (targetSessionKey) => this.buildWorkflowRoleSkillStatus(targetSessionKey),
        formatWorkflowContextBudget: (value) => formatWorkflowContextBudget(value),
        sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
      },
      {
        sessionKey,
        message,
      },
    );
  }

  private async handleAutoDevStatusCommand(
    sessionKey: string,
    message: InboundMessage,
    workdir: string,
  ): Promise<void> {
    await runAutoDevStatusCommand(
      {
        autoDevLoopMaxRuns: this.autoDevLoopMaxRuns,
        autoDevLoopMaxMinutes: this.autoDevLoopMaxMinutes,
        autoDevAutoCommit: this.autoDevAutoCommit,
        autoDevMaxConsecutiveFailures: this.autoDevMaxConsecutiveFailures,
        autoDevDetailedProgressDefaultEnabled: this.autoDevDetailedProgressDefaultEnabled,
        getAutoDevSnapshot: (targetSessionKey) => this.autoDevSnapshots.get(targetSessionKey) ?? null,
        hasActiveAutoDevLoopSession: (targetSessionKey) => this.activeAutoDevLoopSessions.has(targetSessionKey),
        hasPendingAutoDevLoopStopRequest: (targetSessionKey) => this.pendingAutoDevLoopStopRequests.has(targetSessionKey),
        hasPendingStopRequest: (targetSessionKey) => this.pendingStopRequests.has(targetSessionKey),
        isAutoDevDetailedProgressEnabled: (targetSessionKey) => this.isAutoDevDetailedProgressEnabled(targetSessionKey),
        buildWorkflowRoleSkillStatus: (targetSessionKey) => this.buildWorkflowRoleSkillStatus(targetSessionKey),
        listWorkflowDiagRunsBySession: (kind, targetSessionKey, limit) =>
          this.listWorkflowDiagRunsBySession(kind, targetSessionKey, limit),
        listWorkflowDiagEvents: (runId, limit) => this.listWorkflowDiagEvents(runId, limit),
        sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
      },
      {
        sessionKey,
        message,
        workdir,
      },
    );
  }

  private async handleAutoDevProgressCommand(
    sessionKey: string,
    message: InboundMessage,
    mode: "status" | "on" | "off",
  ): Promise<void> {
    await runAutoDevProgressCommand(
      this.buildAutoDevControlCommandDeps(),
      {
        sessionKey,
        message,
        mode,
      },
    );
  }

  private async handleAutoDevSkillsCommand(
    sessionKey: string,
    message: InboundMessage,
    mode: "status" | "on" | "off" | "summary" | "progressive" | "full",
  ): Promise<void> {
    await runAutoDevSkillsCommand(
      this.buildAutoDevControlCommandDeps(),
      {
        sessionKey,
        message,
        mode,
      },
    );
  }

  private async handleAutoDevLoopStopCommand(sessionKey: string, message: InboundMessage): Promise<void> {
    await runAutoDevLoopStopCommand(
      this.buildAutoDevControlCommandDeps(),
      {
        sessionKey,
        message,
      },
    );
  }

  private buildAutoDevControlCommandDeps(): AutoDevControlCommandDeps {
    return {
      autoDevDetailedProgressDefaultEnabled: this.autoDevDetailedProgressDefaultEnabled,
      pendingAutoDevLoopStopRequests: this.pendingAutoDevLoopStopRequests,
      activeAutoDevLoopSessions: this.activeAutoDevLoopSessions,
      isAutoDevDetailedProgressEnabled: (targetSessionKey) => this.isAutoDevDetailedProgressEnabled(targetSessionKey),
      setAutoDevDetailedProgressEnabled: (targetSessionKey, enabled) =>
        this.setAutoDevDetailedProgressEnabled(targetSessionKey, enabled),
      setWorkflowRoleSkillPolicyOverride: (targetSessionKey, next) =>
        this.setWorkflowRoleSkillPolicyOverride(targetSessionKey, next),
      buildWorkflowRoleSkillStatus: (targetSessionKey) => this.buildWorkflowRoleSkillStatus(targetSessionKey),
      sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
    };
  }

  private async handleAutoDevRunCommand(
    taskId: string | null,
    sessionKey: string,
    message: InboundMessage,
    requestId: string,
    workdir: string,
    runContext?: AutoDevRunContext,
  ): Promise<void> {
    await runAutoDevCommand(
      {
        logger: this.logger,
        autoDevLoopMaxRuns: this.autoDevLoopMaxRuns,
        autoDevLoopMaxMinutes: this.autoDevLoopMaxMinutes,
        autoDevAutoCommit: this.autoDevAutoCommit,
        pendingAutoDevLoopStopRequests: this.pendingAutoDevLoopStopRequests,
        activeAutoDevLoopSessions: this.activeAutoDevLoopSessions,
        consumePendingStopRequest: (targetSessionKey) => this.consumePendingStopRequest(targetSessionKey),
        consumePendingAutoDevLoopStopRequest: (targetSessionKey) =>
          this.consumePendingAutoDevLoopStopRequest(targetSessionKey),
        setAutoDevSnapshot: (targetSessionKey, snapshot) => {
          this.setAutoDevSnapshot(targetSessionKey, snapshot);
        },
        channelSendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
        beginWorkflowDiagRun: (input) => this.beginWorkflowDiagRun(input),
        appendWorkflowDiagEvent: (runId, kind, stage, round, eventMessage) =>
          this.appendWorkflowDiagEvent(runId, kind, stage, round, eventMessage),
        runWorkflowCommand: (input) =>
          this.handleWorkflowRunCommand(
            input.objective,
            input.sessionKey,
            input.message,
            input.requestId,
            input.workdir,
            input.diagRunId,
            "autodev",
          ),
        recordAutoDevGitCommit: (targetSessionKey, taskId, result) =>
          this.recordAutoDevGitCommit(targetSessionKey, taskId, result),
        resetAutoDevFailureStreak: (targetWorkdir, targetTaskId) =>
          this.resetAutoDevFailureStreak(targetWorkdir, targetTaskId),
        applyAutoDevFailurePolicy: (input) => this.applyAutoDevFailurePolicy(input),
        autoDevMetrics: this.autoDevMetrics,
      },
      {
        taskId,
        sessionKey,
        message,
        requestId,
        workdir,
        runContext,
      },
    );
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

  private async handleWorkflowRunCommand(
    objective: string,
    sessionKey: string,
    message: InboundMessage,
    requestId: string,
    workdir: string,
    diagRunId: string | null = null,
    diagRunKind: WorkflowDiagRunKind = "workflow",
  ): Promise<MultiAgentWorkflowRunResult | null> {
    return executeWorkflowRunRequest(
      {
        setWorkflowSnapshot: (targetSessionKey, snapshot) => this.setWorkflowSnapshot(targetSessionKey, snapshot),
        beginWorkflowDiagRun: (input) => this.beginWorkflowDiagRun(input),
        startTypingHeartbeat: (conversationId) => this.startTypingHeartbeat(conversationId),
        consumePendingStopRequest: (targetSessionKey) => this.consumePendingStopRequest(targetSessionKey),
        runningExecutions: this.runningExecutions,
        persistRuntimeMetricsSnapshot: () => this.persistRuntimeMetricsSnapshot(),
        sendProgressUpdate: (ctx, text) => this.sendProgressUpdate(ctx, text),
        appendWorkflowDiagEvent: (runId, kind, stage, round, stageMessage) =>
          this.appendWorkflowDiagEvent(runId, kind, stage, round, stageMessage),
        isAutoDevDetailedProgressEnabled: (targetSessionKey) => this.isAutoDevDetailedProgressEnabled(targetSessionKey),
        resolveWorkflowRoleSkillPolicy: (targetSessionKey) => this.resolveWorkflowRoleSkillPolicy(targetSessionKey),
        runWorkflow: (input) => this.workflowRunner.run(input),
        sendMessage: (conversationId, text) => this.channel.sendMessage(conversationId, text),
        finishProgress: (ctx, summary) => this.finishProgress(ctx, summary),
        finishWorkflowDiagRun: (runId, input) => this.finishWorkflowDiagRun(runId, input),
        sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
      },
      {
        objective,
        sessionKey,
        message,
        requestId,
        workdir,
        diagRunId,
        diagRunKind,
      },
    );
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
    this.pendingAutoDevLoopStopRequests.delete(sessionKey);
    this.activeAutoDevLoopSessions.delete(sessionKey);
    this.autoDevDetailedProgressOverrides.delete(sessionKey);
    this.stateStore.deactivateSession(sessionKey);
    this.stateStore.clearCodexSessionId(sessionKey);
    this.clearSessionFromAllRuntimes(sessionKey);
    this.sessionBackendProfiles.delete(sessionKey);
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
      this.cancelRunningExecutionInAllRuntimes(sessionKey);
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
    if (lockEntry?.mutex.isLocked() || this.hasConcurrentSessionRequest(sessionKey)) {
      this.pendingStopRequests.add(sessionKey);
      this.pendingAutoDevLoopStopRequests.delete(sessionKey);
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
    this.pendingAutoDevLoopStopRequests.delete(sessionKey);
    await this.channel.sendNotice(
      message.conversationId,
      "[CodeHarbor] 会话已停止。后续在群聊中请提及/回复我，或在私聊直接发送消息。",
    );
  }

  private markSessionRequestStarted(sessionKey: string): void {
    const current = this.activeSessionRequestCounts.get(sessionKey) ?? 0;
    this.activeSessionRequestCounts.set(sessionKey, current + 1);
  }

  private markSessionRequestFinished(sessionKey: string): void {
    const current = this.activeSessionRequestCounts.get(sessionKey) ?? 0;
    if (current <= 1) {
      this.activeSessionRequestCounts.delete(sessionKey);
      return;
    }
    this.activeSessionRequestCounts.set(sessionKey, current - 1);
  }

  private hasConcurrentSessionRequest(sessionKey: string): boolean {
    return (this.activeSessionRequestCounts.get(sessionKey) ?? 0) > 1;
  }

  private consumePendingStopRequest(sessionKey: string): boolean {
    if (!this.pendingStopRequests.has(sessionKey)) {
      return false;
    }
    this.pendingStopRequests.delete(sessionKey);
    return true;
  }

  private consumePendingAutoDevLoopStopRequest(sessionKey: string): boolean {
    if (!this.pendingAutoDevLoopStopRequests.has(sessionKey)) {
      return false;
    }
    this.pendingAutoDevLoopStopRequests.delete(sessionKey);
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

  private syncRuntimeHotConfig(): void {
    const runtimeStateStore = this.stateStore as StateStore & {
      getRuntimeConfigSnapshot?: (key: string) => {
        version: number;
        payloadJson: string;
        updatedAt: number;
      } | null;
    };
    if (typeof runtimeStateStore.getRuntimeConfigSnapshot !== "function") {
      return;
    }

    let record:
      | {
          version: number;
          payloadJson: string;
          updatedAt: number;
        }
      | null = null;
    try {
      record = runtimeStateStore.getRuntimeConfigSnapshot(GLOBAL_RUNTIME_HOT_CONFIG_KEY);
    } catch (error) {
      this.logger.debug("Failed to read runtime hot config snapshot", {
        error: formatError(error),
      });
      return;
    }
    if (!record) {
      return;
    }

    const latestKnownVersion = Math.max(this.hotConfigVersion, this.hotConfigRejectedVersion);
    if (record.version <= latestKnownVersion) {
      return;
    }

    const hotConfig = parseRuntimeHotConfigPayload(record.payloadJson);
    if (!hotConfig) {
      this.hotConfigRejectedVersion = record.version;
      this.logger.warn("Ignore invalid runtime hot config snapshot payload", {
        version: record.version,
      });
      return;
    }

    try {
      this.applyRuntimeHotConfig(hotConfig);
      this.hotConfigVersion = record.version;
      this.logger.info("Runtime hot config applied", {
        version: record.version,
        updatedAt: new Date(record.updatedAt).toISOString(),
      });
    } catch (error) {
      this.hotConfigRejectedVersion = record.version;
      this.logger.warn("Failed to apply runtime hot config snapshot", {
        version: record.version,
        error: formatError(error),
      });
    }
  }

  private applyRuntimeHotConfig(config: RuntimeHotConfigPayload): void {
    const nextProgressInterval = this.cliCompat.enabled
      ? this.cliCompat.progressThrottleMs
      : Math.max(1, config.matrixProgressMinIntervalMs);
    const nextTypingTimeoutMs = Math.max(1, config.matrixTypingTimeoutMs);
    const nextSessionActiveWindowMs = Math.max(1, config.sessionActiveWindowMinutes) * 60_000;

    this.rateLimiter.updateOptions(config.rateLimiter);
    this.progressUpdatesEnabled = config.matrixProgressUpdates;
    this.progressMinIntervalMs = nextProgressInterval;
    this.typingTimeoutMs = nextTypingTimeoutMs;
    this.sessionActiveWindowMs = nextSessionActiveWindowMs;
    this.groupDirectModeEnabled = config.groupDirectModeEnabled;
    this.defaultGroupTriggerPolicy.allowMention = config.defaultGroupTriggerPolicy.allowMention;
    this.defaultGroupTriggerPolicy.allowReply = config.defaultGroupTriggerPolicy.allowReply;
    this.defaultGroupTriggerPolicy.allowActiveWindow = config.defaultGroupTriggerPolicy.allowActiveWindow;
    this.defaultGroupTriggerPolicy.allowPrefix = config.defaultGroupTriggerPolicy.allowPrefix;
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

  private resolveSessionBackendDecision(input: {
    sessionKey: string;
    message: InboundMessage;
    taskType: BackendModelRouteTaskType;
    routePrompt: string;
  }): SessionBackendDecision {
    const manualOverride = this.sessionBackendOverrides.get(input.sessionKey);
    if (manualOverride) {
      return {
        profile: manualOverride.profile,
        source: "manual_override",
        reasonCode: "manual_override",
        ruleId: null,
      };
    }

    const routeInput: BackendModelRouteInput = {
      roomId: input.message.conversationId,
      senderId: input.message.senderId,
      taskType: input.taskType,
      directMessage: input.message.isDirectMessage,
      text: input.routePrompt,
    };
    const routed = this.backendModelRouter.resolve(routeInput, this.defaultBackendProfile);
    if (!this.executorFactory && !this.hasBackendRuntime(routed.profile)) {
      if (routed.profile.provider !== this.defaultBackendProfile.provider || routed.profile.model !== this.defaultBackendProfile.model) {
        this.logger.warn("Backend/model rule matched but executorFactory is unavailable; falling back to default backend.", {
          sessionKey: input.sessionKey,
          matchedProvider: routed.profile.provider,
          matchedModel: routed.profile.model,
          defaultProvider: this.defaultBackendProfile.provider,
          defaultModel: this.defaultBackendProfile.model,
          ruleId: routed.ruleId,
          taskType: input.taskType,
        });
      }
      return {
        profile: this.defaultBackendProfile,
        source: "default",
        reasonCode: "factory_unavailable",
        ruleId: routed.ruleId,
      };
    }

    return {
      profile: routed.profile,
      source: routed.source,
      reasonCode: routed.reasonCode,
      ruleId: routed.ruleId,
    };
  }

  private prepareBackendRuntimeForSession(sessionKey: string, profile: BackendModelRouteProfile): BackendRuntimeBundle {
    const nextProfile = normalizeBackendProfile(profile);
    const previousProfile = this.sessionBackendProfiles.get(sessionKey);
    const hasPersistedSession = this.stateStore.getCodexSessionId(sessionKey) !== null;

    const shouldResetSession =
      previousProfile !== undefined
        ? !isSameBackendProfile(previousProfile, nextProfile)
        : hasPersistedSession && !isSameBackendProfile(this.defaultBackendProfile, nextProfile);
    if (shouldResetSession) {
      this.stateStore.clearCodexSessionId(sessionKey);
      this.clearSessionFromAllRuntimes(sessionKey);
      this.workflowSnapshots.delete(sessionKey);
      this.autoDevSnapshots.delete(sessionKey);
    }

    const runtime = this.ensureBackendRuntime(nextProfile);
    this.sessionBackendProfiles.set(sessionKey, nextProfile);
    return runtime;
  }

  private resolveSessionBackendStatusProfile(sessionKey: string): BackendModelRouteProfile {
    const override = this.sessionBackendOverrides.get(sessionKey);
    if (override) {
      return override.profile;
    }
    return this.sessionBackendProfiles.get(sessionKey) ?? this.defaultBackendProfile;
  }

  private resolveManualBackendProfile(provider: "codex" | "claude"): BackendModelRouteProfile {
    const model = provider === this.defaultBackendProfile.provider ? this.defaultBackendProfile.model : null;
    return {
      provider,
      model,
    };
  }

  private ensureBackendRuntime(profile: BackendModelRouteProfile): BackendRuntimeBundle {
    const normalized = normalizeBackendProfile(profile);
    const key = this.serializeBackendProfile(normalized);
    const existing = this.backendRuntimes.get(key);
    if (existing) {
      return existing;
    }
    if (!this.executorFactory) {
      throw new Error("Backend executor factory is unavailable.");
    }
    const executor = this.executorFactory(normalized.provider, normalized.model);
    const bundle: BackendRuntimeBundle = {
      profile: normalized,
      executor,
      sessionRuntime: new CodexSessionRuntime(executor),
    };
    this.backendRuntimes.set(key, bundle);
    return bundle;
  }

  private hasBackendRuntime(profile: BackendModelRouteProfile): boolean {
    const key = this.serializeBackendProfile(profile);
    return this.backendRuntimes.has(key);
  }

  private serializeBackendProfile(profile: BackendModelRouteProfile): string {
    const normalized = normalizeBackendProfile(profile);
    return `${normalized.provider}::${normalized.model ?? ""}`;
  }

  private clearSessionFromAllRuntimes(sessionKey: string): void {
    for (const runtime of this.backendRuntimes.values()) {
      runtime.sessionRuntime.clearSession(sessionKey);
    }
  }

  private cancelRunningExecutionInAllRuntimes(sessionKey: string): void {
    for (const runtime of this.backendRuntimes.values()) {
      runtime.sessionRuntime.cancelRunningExecution(sessionKey);
    }
  }

  private getBackendRuntimeStats(): { workerCount: number; runningCount: number } {
    let workerCount = 0;
    let runningCount = 0;
    for (const runtime of this.backendRuntimes.values()) {
      const stats = runtime.sessionRuntime.getRuntimeStats();
      workerCount += stats.workerCount;
      runningCount += stats.runningCount;
    }
    return {
      workerCount,
      runningCount,
    };
  }

  private recordBackendRouteDecision(input: {
    sessionKey: string;
    message: InboundMessage;
    taskType: BackendModelRouteTaskType;
    decision: SessionBackendDecision;
  }): void {
    this.backendRouteDiagRecords.push({
      at: new Date().toISOString(),
      sessionKey: input.sessionKey,
      conversationId: input.message.conversationId,
      senderId: input.message.senderId,
      taskType: input.taskType,
      source: input.decision.source,
      reasonCode: input.decision.reasonCode,
      ruleId: input.decision.ruleId,
      profile: input.decision.profile,
    });
    if (this.backendRouteDiagRecords.length > BACKEND_ROUTE_DIAG_HISTORY_MAX) {
      this.backendRouteDiagRecords.splice(
        0,
        this.backendRouteDiagRecords.length - BACKEND_ROUTE_DIAG_HISTORY_MAX,
      );
    }
  }

  private listBackendRouteDiagRecords(limit: number, sessionKey: string): BackendRouteDiagRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const scoped = this.backendRouteDiagRecords.filter((record) => record.sessionKey === sessionKey);
    return scoped.slice(Math.max(0, scoped.length - safeLimit)).reverse();
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
    extractedDocuments: DocumentContextItem[],
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
        const documentSummary = buildDocumentContextPrompt(extractedDocuments);
        if (documentSummary.content) {
          sections.push(`[documents]\n${documentSummary.content}\n[/documents]`);
        }
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

  private isAutoDevDetailedProgressEnabled(sessionKey: string): boolean {
    return this.autoDevDetailedProgressOverrides.get(sessionKey) ?? this.autoDevDetailedProgressDefaultEnabled;
  }

  private setAutoDevDetailedProgressEnabled(sessionKey: string, enabled: boolean): void {
    if (enabled === this.autoDevDetailedProgressDefaultEnabled) {
      this.autoDevDetailedProgressOverrides.delete(sessionKey);
      return;
    }
    this.autoDevDetailedProgressOverrides.set(sessionKey, enabled);
  }

  private resolveWorkflowRoleSkillPolicy(sessionKey: string): { enabled: boolean; mode: WorkflowRoleSkillDisclosureMode } {
    const override = this.workflowRoleSkillPolicyOverrides.get(sessionKey);
    return {
      enabled: override?.enabled ?? this.workflowRoleSkillDefaultPolicy.enabled ?? DEFAULT_WORKFLOW_ROLE_SKILLS_ENABLED,
      mode: override?.mode ?? this.workflowRoleSkillDefaultPolicy.mode ?? DEFAULT_WORKFLOW_ROLE_SKILLS_MODE,
    };
  }

  private setWorkflowRoleSkillPolicyOverride(sessionKey: string, next: WorkflowRoleSkillPolicyOverride): void {
    const current = this.workflowRoleSkillPolicyOverrides.get(sessionKey) ?? {};
    const mergedEnabled = next.enabled ?? current.enabled ?? this.workflowRoleSkillDefaultPolicy.enabled;
    const mergedMode = next.mode ?? current.mode ?? this.workflowRoleSkillDefaultPolicy.mode;
    const enabled = mergedEnabled ?? DEFAULT_WORKFLOW_ROLE_SKILLS_ENABLED;
    const mode = mergedMode ?? DEFAULT_WORKFLOW_ROLE_SKILLS_MODE;
    const sameAsDefault =
      enabled === (this.workflowRoleSkillDefaultPolicy.enabled ?? DEFAULT_WORKFLOW_ROLE_SKILLS_ENABLED) &&
      mode === (this.workflowRoleSkillDefaultPolicy.mode ?? DEFAULT_WORKFLOW_ROLE_SKILLS_MODE);
    if (sameAsDefault) {
      this.workflowRoleSkillPolicyOverrides.delete(sessionKey);
      return;
    }
    this.workflowRoleSkillPolicyOverrides.set(sessionKey, {
      enabled,
      mode,
    });
  }

  private buildWorkflowRoleSkillStatus(sessionKey: string): {
    enabled: boolean;
    mode: WorkflowRoleSkillDisclosureMode;
    maxChars: number;
    roots: string;
    loaded: string;
    override: string;
  } {
    const policy = this.resolveWorkflowRoleSkillPolicy(sessionKey);
    const snapshot = this.workflowRoleSkillCatalog.getStatusSnapshot();
    const override = this.workflowRoleSkillPolicyOverrides.get(sessionKey);
    return {
      enabled: policy.enabled,
      mode: policy.mode,
      maxChars: snapshot.maxChars,
      roots: snapshot.roots.length > 0 ? snapshot.roots.join(", ") : "(default)",
      loaded: formatWorkflowRoleSkillLoaded(snapshot),
      override: override ? `enabled=${override.enabled ? "on" : "off"}, mode=${override.mode}` : "none",
    };
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
    const manualOverride = this.sessionBackendOverrides.get(sessionKey);
    const statusProfile = this.resolveSessionBackendStatusProfile(sessionKey);
    if (!target || target === "status") {
      const mode = manualOverride ? "manual" : "auto";
      const decision = this.sessionLastBackendDecisions.get(sessionKey);
      const reason = manualOverride ? "manual_override" : decision?.reasonCode ?? "default_fallback";
      const rule = decision?.ruleId ?? "none";
      const reasonDesc = describeBackendRouteReason(reason);
      const fallback = isBackendRouteFallbackReason(reason) ? "yes" : "no";
      await this.channel.sendNotice(
        message.conversationId,
        `[CodeHarbor] 当前后端工具: ${this.formatBackendToolLabel(statusProfile)}\n路由模式: ${mode}\n命中原因: ${reason}\n原因说明: ${reasonDesc}\n命中规则: ${rule}\n是否回退: ${fallback}\n可用命令: /backend codex | /backend claude | /backend auto | /backend status`,
      );
      return;
    }

    if (target === "auto") {
      if (!manualOverride) {
        await this.channel.sendNotice(message.conversationId, "[CodeHarbor] 当前已经处于自动路由模式。");
        return;
      }
      if (this.runningExecutions.has(sessionKey)) {
        await this.channel.sendNotice(
          message.conversationId,
          "[CodeHarbor] 检测到当前会话仍有运行中任务，请等待任务完成后再切换后端工具。",
        );
        return;
      }
      this.sessionBackendOverrides.delete(sessionKey);
      this.stateStore.clearCodexSessionId(sessionKey);
      this.stateStore.activateSession(sessionKey, this.sessionActiveWindowMs);
      this.clearSessionFromAllRuntimes(sessionKey);
      this.sessionBackendProfiles.delete(sessionKey);
      this.workflowSnapshots.delete(sessionKey);
      this.autoDevSnapshots.delete(sessionKey);
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 已恢复自动路由模式。下一个请求会自动注入最近本地会话历史作为桥接上下文。",
      );
      return;
    }

    const targetProfile = this.resolveManualBackendProfile(target);
    if (manualOverride && this.serializeBackendProfile(manualOverride.profile) === this.serializeBackendProfile(targetProfile)) {
      await this.channel.sendNotice(
        message.conversationId,
        `[CodeHarbor] 后端工具已是 ${this.formatBackendToolLabel(targetProfile)}（manual）。`,
      );
      return;
    }

    if (!this.executorFactory && !this.hasBackendRuntime(targetProfile)) {
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 当前运行模式不支持会话内切换后端，请修改 .env 后重启服务。",
      );
      return;
    }
    if (this.runningExecutions.has(sessionKey)) {
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 检测到当前会话仍有运行中任务，请等待任务完成后再切换后端工具。",
      );
      return;
    }

    this.ensureBackendRuntime(targetProfile);
    this.sessionBackendOverrides.set(sessionKey, {
      profile: targetProfile,
      updatedAt: Date.now(),
    });
    this.sessionBackendProfiles.set(sessionKey, targetProfile);
    this.sessionLastBackendDecisions.set(sessionKey, {
      profile: targetProfile,
      source: "manual_override",
      reasonCode: "manual_override",
      ruleId: null,
    });
    this.stateStore.clearCodexSessionId(sessionKey);
    this.stateStore.activateSession(sessionKey, this.sessionActiveWindowMs);
    this.clearSessionFromAllRuntimes(sessionKey);
    this.workflowSnapshots.delete(sessionKey);
    this.autoDevSnapshots.delete(sessionKey);

    await this.channel.sendNotice(
      message.conversationId,
      `[CodeHarbor] 已切换后端工具为 ${this.formatBackendToolLabel(targetProfile)}（manual）。下一个请求会自动注入最近本地会话历史作为桥接上下文。`,
    );
  }

  private formatBackendToolLabel(profile: BackendModelRouteProfile = this.defaultBackendProfile): string {
    return formatBackendRouteProfile(profile);
  }

  private formatMultimodalHelpStatus(): string {
    const imageEnabled = this.cliCompat.fetchMedia ? "on" : "off";
    const audioEnabled = this.audioTranscriber.isEnabled() ? "on" : "off";
    const mimeText = formatMimeAllowlist(this.cliCompat.imageAllowedMimeTypes);
    const backendImageSupport = this.defaultBackendProfile.provider === "codex" || this.defaultBackendProfile.provider === "claude"
      ? "yes"
      : "unknown";
    return `图片=${imageEnabled}(max=${this.cliCompat.imageMaxCount},<=${formatByteSize(this.cliCompat.imageMaxBytes)},mime=${mimeText})；语音=${audioEnabled}；后端图片支持=${backendImageSupport}`;
  }

  private async handleDiagCommand(message: InboundMessage): Promise<void> {
    await runDiagCommand(
      {
        botNoticePrefix: this.botNoticePrefix,
        processStartedAtIso: this.processStartedAtIso,
        defaultBackendProfile: this.defaultBackendProfile,
        autoDevLoopMaxRuns: this.autoDevLoopMaxRuns,
        autoDevLoopMaxMinutes: this.autoDevLoopMaxMinutes,
        autoDevAutoCommit: this.autoDevAutoCommit,
        autoDevMaxConsecutiveFailures: this.autoDevMaxConsecutiveFailures,
        runningExecutionsSize: this.runningExecutions.size,
        cliCompat: {
          fetchMedia: this.cliCompat.fetchMedia,
          imageMaxCount: this.cliCompat.imageMaxCount,
          imageMaxBytes: this.cliCompat.imageMaxBytes,
          imageAllowedMimeTypes: this.cliCompat.imageAllowedMimeTypes,
          audioTranscribeMaxBytes: this.cliCompat.audioTranscribeMaxBytes,
          audioTranscribeModel: this.cliCompat.audioTranscribeModel,
        },
        isAudioTranscriberEnabled: () => this.audioTranscriber.isEnabled(),
        getPackageUpdateStatus: (query) => this.packageUpdateChecker.getStatus(query),
        formatBackendToolLabel: (profile) => this.formatBackendToolLabel(profile),
        mediaMetrics: this.mediaMetrics,
        listWorkflowDiagRuns: (kind, limit) => this.listWorkflowDiagRuns(kind, limit),
        listWorkflowDiagEvents: (runId, limit) => this.listWorkflowDiagEvents(runId, limit),
        getAutoDevSnapshot: (sessionKey) => this.autoDevSnapshots.get(sessionKey) ?? createIdleAutoDevSnapshot(),
        listAutoDevGitCommitRecords: (limit) => this.listAutoDevGitCommitRecords(limit),
        listRecentAutoDevGitCommitEventSummaries: (limit) => this.listRecentAutoDevGitCommitEventSummaries(limit),
        resolveSessionBackendStatusProfile: (sessionKey) => this.resolveSessionBackendStatusProfile(sessionKey),
        getSessionBackendOverride: (sessionKey) => this.sessionBackendOverrides.get(sessionKey),
        getSessionBackendDecision: (sessionKey) => this.sessionLastBackendDecisions.get(sessionKey),
        getBackendModelRouterStats: () => this.backendModelRouter.getStats(),
        listBackendRouteDiagRecords: (limit, sessionKey) => this.listBackendRouteDiagRecords(limit, sessionKey),
        getTaskQueueStateStore: () => this.getTaskQueueStateStore(),
        listTaskQueueFailureArchive: (limit) => this.listTaskQueueFailureArchive(limit),
        getRecentUpgradeRuns: (limit) => this.getRecentUpgradeRuns(limit),
        getUpgradeExecutionLockSnapshot: () => this.getUpgradeExecutionLockSnapshot(),
        getUpgradeRunStats: () => this.getUpgradeRunStats(),
        sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
      },
      message,
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

  private listWorkflowDiagRunsBySession(
    kind: WorkflowDiagRunKind,
    sessionKey: string,
    limit: number,
  ): WorkflowDiagRunRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    return this.workflowDiagStore.runs
      .filter((run) => run.kind === kind && run.sessionKey === sessionKey)
      .slice()
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
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
