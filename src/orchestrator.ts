import { Mutex } from "async-mutex";
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
import { type DocumentContextItem } from "./document-context";
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
  type BackendModelRouteProfile,
  type BackendModelRouteRule,
  type BackendModelRouteTaskType,
} from "./routing/backend-model-router";
import {
  type RuntimeHotConfigPayload,
} from "./runtime-hot-config";
import {
  ARCHIVE_REASON_MAX_ATTEMPTS,
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
import {
  MultiAgentWorkflowRunner,
  type MultiAgentWorkflowRunResult,
  type WorkflowRunSnapshot,
} from "./workflow/multi-agent-workflow";
import {
  WorkflowRoleSkillCatalog,
  type WorkflowRole,
  type WorkflowRoleSkillDisclosureMode,
  type WorkflowRoleSkillPolicyOverride,
} from "./workflow/role-skills";
import {
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
} from "./orchestrator/helpers";
import {
  type AutoDevGitCommitResult,
} from "./orchestrator/autodev-git";
import {
  type AutoDevRunContext,
} from "./orchestrator/autodev-runner";
import {
  classifyBackendTaskType,
  isSameBackendProfile,
  normalizeBackendProfile,
  parseControlCommand,
} from "./orchestrator/command-routing";
import {
  collectLocalAttachmentPaths,
  formatMimeAllowlist,
  mapProgressText,
} from "./orchestrator/media-progress";
import {
  isApiTaskPayloadEquivalent,
  normalizeApiTaskRequestId,
  parseQueuedInboundPayload,
  type QueuedInboundPayload,
} from "./orchestrator/queue-payload";
import {
  classifyExecutionOutcome,
} from "./orchestrator/workflow-status";
import { AutoDevRuntimeMetrics, MediaMetrics, RequestMetrics } from "./orchestrator/runtime-metrics";
import {
  buildDefaultUpgradeRestartPlan,
  probeInstalledVersion,
  runSelfUpdateCommand,
  type SelfUpdateResult,
  type UpgradeRestartPlan,
  type UpgradeVersionProbeResult,
} from "./orchestrator/upgrade-utils";
import {
  formatBackendRouteProfile,
} from "./orchestrator/diagnostic-formatters";
import {
  handleControlCommand as runControlCommand,
  type ControlCommand,
} from "./orchestrator/control-command-handler";
import { handleBackendCommand as runBackendCommand } from "./orchestrator/backend-command";
import { handleDiagCommand as runDiagCommand } from "./orchestrator/diag-command";
import { executeChatRequest } from "./orchestrator/chat-request";
import { executeAgentRunRequest } from "./orchestrator/agent-run-request";
import {
  prepareDocumentAttachments as runPrepareDocumentAttachments,
  prepareImageAttachments as runPrepareImageAttachments,
  transcribeAudioAttachments as runTranscribeAudioAttachments,
} from "./orchestrator/attachment-processing";
import {
  handleAutoDevLoopStopCommand as runAutoDevLoopStopCommand,
  handleAutoDevProgressCommand as runAutoDevProgressCommand,
  handleAutoDevSkillsCommand as runAutoDevSkillsCommand,
  type AutoDevControlCommandDeps,
} from "./orchestrator/autodev-control-command";
import { handleAutoDevStatusCommand as runAutoDevStatusCommand } from "./orchestrator/autodev-status-command";
import { tryHandleNonBlockingStatusRoute as runNonBlockingStatusRoute } from "./orchestrator/non-blocking-status-route";
import { executeLockedMessage } from "./orchestrator/locked-message-execution";
import { executeWorkflowRunRequest } from "./orchestrator/workflow-run-request";
import { handleStatusCommand } from "./orchestrator/status-command";
import { handleStopCommand as runStopCommand } from "./orchestrator/stop-command";
import { handleUpgradeCommand as runUpgradeCommand } from "./orchestrator/upgrade-command";
import { handleWorkflowStatusCommand as runWorkflowStatusCommand } from "./orchestrator/workflow-status-command";
import {
  buildApiTaskErrorSummary,
  buildApiTaskEventId,
  buildSessionKey,
  cleanupAttachmentFiles,
  formatByteSize,
  mapApiTaskStage,
} from "./orchestrator/misc-utils";
import { buildExecutionPrompt as runBuildExecutionPrompt } from "./orchestrator/execution-prompt";
import { routeMessage as runRouteMessage, type RouteDecision } from "./orchestrator/message-routing";
import { buildConversationBridgeContext as runBuildConversationBridgeContext } from "./orchestrator/conversation-bridge";
import { drainSessionQueue as runDrainSessionQueue } from "./orchestrator/task-queue-drain";
import { syncRuntimeHotConfig as runSyncRuntimeHotConfig } from "./orchestrator/runtime-hot-config-sync";
import { resolveSessionBackendDecision as runResolveSessionBackendDecision } from "./orchestrator/backend-decision";
import {
  clearSessionQueueRetryTimer as runClearSessionQueueRetryTimer,
  reconcileSessionQueueDrain as runReconcileSessionQueueDrain,
  scheduleSessionQueueDrain as runScheduleSessionQueueDrain,
  scheduleSessionQueueDrainAtNextRetry as runScheduleSessionQueueDrainAtNextRetry,
  startSessionQueueDrain as runStartSessionQueueDrain,
} from "./orchestrator/task-queue-drain-scheduler";
import {
  WORKFLOW_DIAG_MAX_EVENTS,
  WORKFLOW_DIAG_MAX_RUNS,
  createEmptyWorkflowDiagStorePayload,
  type WorkflowDiagEventRecord,
  type WorkflowDiagRunKind,
  type WorkflowDiagRunRecord,
  type WorkflowDiagRunStatus,
  type WorkflowDiagStorePayload,
} from "./orchestrator/workflow-diag";
import {
  listRecentAutoDevGitCommitEventSummaries as runListRecentAutoDevGitCommitEventSummaries,
  listWorkflowDiagEvents as runListWorkflowDiagEvents,
  listWorkflowDiagRuns as runListWorkflowDiagRuns,
  listWorkflowDiagRunsBySession as runListWorkflowDiagRunsBySession,
} from "./orchestrator/workflow-diag-queries";
import {
  appendWorkflowDiagEvent as runAppendWorkflowDiagEvent,
  beginWorkflowDiagRun as runBeginWorkflowDiagRun,
  finishWorkflowDiagRun as runFinishWorkflowDiagRun,
} from "./orchestrator/workflow-diag-mutations";
import { handleAutoDevRunCommand as runHandleAutoDevRunCommand } from "./orchestrator/autodev-run-dispatch";
import {
  persistWorkflowDiagStore as runPersistWorkflowDiagStore,
  restoreWorkflowDiagStore as runRestoreWorkflowDiagStore,
} from "./orchestrator/workflow-diag-store";
import {
  listBackendRouteDiagRecords as runListBackendRouteDiagRecords,
  recordBackendRouteDecision as runRecordBackendRouteDecision,
  type BackendRouteDiagRecord,
} from "./orchestrator/backend-route-diag";

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
        const lockedResult = await executeLockedMessage(
          {
            logger: this.logger,
            workflowEnabled: this.workflowRunner.isEnabled(),
            hasProcessedEvent: (targetSessionKey, eventId) => this.stateStore.hasProcessedEvent(targetSessionKey, eventId),
            markEventProcessed: (targetSessionKey, eventId) => this.stateStore.markEventProcessed(targetSessionKey, eventId),
            recordRequestMetrics: (outcome, queueMs, execMs, sendMs) =>
              this.recordRequestMetrics(outcome, queueMs, execMs, sendMs),
            resolveRoomRuntimeConfig: (conversationId) => this.resolveRoomRuntimeConfig(conversationId),
            routeMessage: (targetMessage, targetSessionKey, roomConfig) =>
              this.routeMessage(targetMessage, targetSessionKey, roomConfig),
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
            getTaskQueueStateStore: () => this.getTaskQueueStateStore(),
            tryAcquireRateLimit: (input) => this.rateLimiter.tryAcquire(input),
            sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
            classifyBackendTaskType: (workflowCommand, autoDevCommand) =>
              classifyBackendTaskType(workflowCommand, autoDevCommand),
            resolveSessionBackendDecision: (input) => this.resolveSessionBackendDecision(input),
            prepareBackendRuntimeForSession: (targetSessionKey, profile) =>
              this.prepareBackendRuntimeForSession(targetSessionKey, profile),
            setSessionLastBackendDecision: (targetSessionKey, decision) =>
              this.sessionLastBackendDecisions.set(targetSessionKey, decision),
            recordBackendRouteDecision: (input) => this.recordBackendRouteDecision(input),
            executeWorkflowRun: async (input) => {
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
                  sessionKey: input.sessionKey,
                  message: input.message,
                  requestId: input.requestId,
                  queueWaitMs: input.queueWaitMs,
                  workdir: input.workdir,
                  deferFailureHandlingToQueue: input.deferFailureHandlingToQueue,
                  executor: input.executor,
                  run: async () => {
                    await this.handleWorkflowRunCommand(
                      input.objective,
                      input.sessionKey,
                      input.message,
                      input.requestId,
                      input.workdir,
                    );
                  },
                  sendFailure: (conversationId, error) => this.sendWorkflowFailure(conversationId, error),
                  releaseRateLimit: () => {
                    input.releaseRateLimit();
                  },
                },
              );
            },
            executeAutoDevRun: async (input) => {
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
                  sessionKey: input.sessionKey,
                  message: input.message,
                  requestId: input.requestId,
                  queueWaitMs: input.queueWaitMs,
                  workdir: input.workdir,
                  deferFailureHandlingToQueue: input.deferFailureHandlingToQueue,
                  executor: input.executor,
                  run: async () => {
                    await this.handleAutoDevRunCommand(
                      input.taskId,
                      input.sessionKey,
                      input.message,
                      input.requestId,
                      input.workdir,
                    );
                  },
                  sendFailure: (conversationId, error) => this.sendAutoDevFailure(conversationId, error),
                  releaseRateLimit: () => {
                    input.releaseRateLimit();
                  },
                },
              );
            },
            executeChatRun: (input) =>
              executeChatRequest(
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
                  message: input.message,
                  receivedAt: input.receivedAt,
                  queueWaitMs: input.queueWaitMs,
                  routePrompt: input.routePrompt,
                  sessionKey: input.sessionKey,
                  requestId: input.requestId,
                  roomWorkdir: input.roomWorkdir,
                  roomConfigSource: input.roomConfigSource,
                  backendProfile: input.backendProfile,
                  backendRouteSource: input.backendRouteSource,
                  backendRouteReason: input.backendRouteReason,
                  backendRouteRuleId: input.backendRouteRuleId,
                  sessionRuntime: input.sessionRuntime,
                  deferFailureHandlingToQueue: input.deferFailureHandlingToQueue,
                  releaseRateLimit: () => {
                    input.releaseRateLimit();
                  },
                },
              ),
          },
          {
            message,
            requestId,
            sessionKey,
            receivedAt,
            bypassQueue: options.bypassQueue,
            forcedPrompt: options.forcedPrompt,
            deferFailureHandlingToQueue: options.deferFailureHandlingToQueue,
          },
        );

        if (lockedResult.deferAttachmentCleanup) {
          deferAttachmentCleanup = true;
        }
        if (lockedResult.queueDrainSessionKey) {
          queueDrainSessionKey = lockedResult.queueDrainSessionKey;
        }
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
    runStartSessionQueueDrain(
      {
        sessionQueueDrains: this.sessionQueueDrains,
        getTaskQueueStateStore: () => this.getTaskQueueStateStore(),
        clearSessionQueueRetryTimer: (targetSessionKey) => this.clearSessionQueueRetryTimer(targetSessionKey),
        scheduleSessionQueueDrainAtNextRetry: (targetSessionKey, queueStore) =>
          this.scheduleSessionQueueDrainAtNextRetry(targetSessionKey, queueStore),
        drainSessionQueue: (targetSessionKey) => this.drainSessionQueue(targetSessionKey),
        reconcileSessionQueueDrain: (targetSessionKey) => this.reconcileSessionQueueDrain(targetSessionKey),
        logger: this.logger,
      },
      sessionKey,
    );
  }

  private async drainSessionQueue(sessionKey: string): Promise<void> {
    const queueStore = this.getTaskQueueStateStore();
    if (!queueStore) {
      return;
    }
    await runDrainSessionQueue(
      {
        logger: this.logger,
        taskQueueRetryPolicy: this.taskQueueRetryPolicy,
        handleMessageInternal: (message, receivedAt, options) => this.handleMessageInternal(message, receivedAt, options),
        commitExecutionHandled: (targetSessionKey, eventId) => this.stateStore.commitExecutionHandled(targetSessionKey, eventId),
        sendQueuedTaskFailureNotice: (conversationId, input) => this.sendQueuedTaskFailureNotice(conversationId, input),
      },
      {
        sessionKey,
        queueStore,
      },
    );
  }

  private reconcileSessionQueueDrain(sessionKey: string): void {
    runReconcileSessionQueueDrain(
      {
        getTaskQueueStateStore: () => this.getTaskQueueStateStore(),
        startSessionQueueDrain: (targetSessionKey) => this.startSessionQueueDrain(targetSessionKey),
        scheduleSessionQueueDrainAtNextRetry: (targetSessionKey, queueStore) =>
          this.scheduleSessionQueueDrainAtNextRetry(targetSessionKey, queueStore),
        logger: this.logger,
      },
      sessionKey,
    );
  }

  private scheduleSessionQueueDrainAtNextRetry(
    sessionKey: string,
    queueStore: Pick<TaskQueueStateStore, "getNextPendingRetryAt">,
  ): void {
    runScheduleSessionQueueDrainAtNextRetry(
      (targetSessionKey, nextRetryAt) => this.scheduleSessionQueueDrain(targetSessionKey, nextRetryAt),
      sessionKey,
      queueStore,
    );
  }

  private scheduleSessionQueueDrain(sessionKey: string, nextRetryAt: number): void {
    runScheduleSessionQueueDrain(
      {
        sessionQueueRetryTimers: this.sessionQueueRetryTimers,
        clearSessionQueueRetryTimer: (targetSessionKey) => this.clearSessionQueueRetryTimer(targetSessionKey),
        startSessionQueueDrain: (targetSessionKey) => this.startSessionQueueDrain(targetSessionKey),
        logger: this.logger,
      },
      sessionKey,
      nextRetryAt,
    );
  }

  private clearSessionQueueRetryTimer(sessionKey: string): void {
    runClearSessionQueueRetryTimer({
      sessionQueueRetryTimers: this.sessionQueueRetryTimers,
      sessionKey,
    });
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
    return runRouteMessage(
      {
        workflowEnabled: this.workflowRunner.isEnabled(),
        commandPrefix: this.commandPrefix,
        cliCompatEnabled: this.cliCompat.enabled,
        cliPreserveWhitespace: this.cliCompat.preserveWhitespace,
        groupDirectModeEnabled: this.groupDirectModeEnabled,
        matrixUserId: this.matrixUserId,
        isSessionActive: (targetSessionKey) => this.stateStore.isSessionActive(targetSessionKey),
      },
      {
        message,
        sessionKey,
        roomConfig,
      },
    );
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
    await runHandleAutoDevRunCommand(
      {
        logger: this.logger,
        autoDevLoopMaxRuns: this.autoDevLoopMaxRuns,
        autoDevLoopMaxMinutes: this.autoDevLoopMaxMinutes,
        autoDevAutoCommit: this.autoDevAutoCommit,
        autoDevMaxConsecutiveFailures: this.autoDevMaxConsecutiveFailures,
        pendingAutoDevLoopStopRequests: this.pendingAutoDevLoopStopRequests,
        activeAutoDevLoopSessions: this.activeAutoDevLoopSessions,
        autoDevFailureStreaks: this.autoDevFailureStreaks,
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
    await runStopCommand(
      {
        logger: this.logger,
        pendingAutoDevLoopStopRequests: this.pendingAutoDevLoopStopRequests,
        activeAutoDevLoopSessions: this.activeAutoDevLoopSessions,
        autoDevDetailedProgressOverrides: this.autoDevDetailedProgressOverrides,
        stateStore: this.stateStore,
        clearSessionFromAllRuntimes: (targetSessionKey) => this.clearSessionFromAllRuntimes(targetSessionKey),
        sessionBackendProfiles: this.sessionBackendProfiles,
        skipBridgeForNextPrompt: this.skipBridgeForNextPrompt,
        getTaskQueueStateStore: () => this.getTaskQueueStateStore(),
        runningExecutions: this.runningExecutions,
        pendingStopRequests: this.pendingStopRequests,
        cancelRunningExecutionInAllRuntimes: (targetSessionKey) => this.cancelRunningExecutionInAllRuntimes(targetSessionKey),
        isSessionBusy: (targetSessionKey) => {
          const lockEntry = this.sessionLocks.get(targetSessionKey);
          return Boolean(lockEntry?.mutex.isLocked() || this.hasConcurrentSessionRequest(targetSessionKey));
        },
        sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
      },
      {
        sessionKey,
        message,
        requestId,
      },
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
    runSyncRuntimeHotConfig({
      stateStore: this.stateStore,
      hotConfigVersion: this.hotConfigVersion,
      hotConfigRejectedVersion: this.hotConfigRejectedVersion,
      logger: this.logger,
      applyRuntimeHotConfig: (config) => this.applyRuntimeHotConfig(config),
      setHotConfigVersion: (version) => {
        this.hotConfigVersion = version;
      },
      setHotConfigRejectedVersion: (version) => {
        this.hotConfigRejectedVersion = version;
      },
    });
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
    return runResolveSessionBackendDecision(
      {
        sessionBackendOverrides: this.sessionBackendOverrides,
        resolveBackendRoute: (routeInput, fallback) => this.backendModelRouter.resolve(routeInput, fallback),
        defaultBackendProfile: this.defaultBackendProfile,
        canCreateBackendRuntime: Boolean(this.executorFactory),
        hasBackendRuntime: (profile) => this.hasBackendRuntime(profile),
        logger: this.logger,
      },
      input,
    );
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
    runRecordBackendRouteDecision(this.backendRouteDiagRecords, input, BACKEND_ROUTE_DIAG_HISTORY_MAX);
  }

  private listBackendRouteDiagRecords(limit: number, sessionKey: string): BackendRouteDiagRecord[] {
    return runListBackendRouteDiagRecords(this.backendRouteDiagRecords, limit, sessionKey);
  }

  private async prepareImageAttachments(
    message: InboundMessage,
    requestId: string,
    sessionKey: string,
  ): Promise<ImageSelectionResult> {
    return runPrepareImageAttachments(
      {
        cliCompat: this.cliCompat,
        logger: this.logger,
      },
      {
        message,
        requestId,
        sessionKey,
      },
    );
  }

  private async transcribeAudioAttachments(
    message: InboundMessage,
    requestId: string,
    sessionKey: string,
  ): Promise<AudioTranscript[]> {
    return runTranscribeAudioAttachments(
      {
        audioTranscriber: this.audioTranscriber,
        cliCompat: this.cliCompat,
        mediaMetrics: this.mediaMetrics,
        logger: this.logger,
      },
      {
        message,
        requestId,
        sessionKey,
      },
    );
  }

  private async prepareDocumentAttachments(
    message: InboundMessage,
    requestId: string,
    sessionKey: string,
  ): Promise<DocumentExtractionSummary> {
    return runPrepareDocumentAttachments(
      {
        logger: this.logger,
      },
      {
        message,
        requestId,
        sessionKey,
      },
    );
  }

  private buildExecutionPrompt(
    prompt: string,
    message: InboundMessage,
    audioTranscripts: AudioTranscript[],
    extractedDocuments: DocumentContextItem[],
    bridgeContext: string | null,
  ): string {
    return runBuildExecutionPrompt({
      prompt,
      message,
      audioTranscripts,
      extractedDocuments,
      bridgeContext,
    });
  }

  private buildConversationBridgeContext(sessionKey: string): string | null {
    const messages = this.stateStore.listRecentConversationMessages(sessionKey, CONTEXT_BRIDGE_HISTORY_LIMIT);
    return runBuildConversationBridgeContext({
      messages,
      maxChars: CONTEXT_BRIDGE_MAX_CHARS,
    });
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
    await runUpgradeCommand(
      {
        logger: this.logger,
        botNoticePrefix: this.botNoticePrefix,
        upgradeMutex: this.upgradeMutex,
        authorizeUpgradeRequest: (targetMessage) => this.authorizeUpgradeRequest(targetMessage),
        acquireUpgradeExecutionLock: () => this.acquireUpgradeExecutionLock(),
        releaseUpgradeExecutionLock: () => this.releaseUpgradeExecutionLock(),
        createUpgradeRun: (requestedBy, targetVersion) => this.createUpgradeRun(requestedBy, targetVersion),
        finishUpgradeRun: (runId, input) => this.finishUpgradeRun(runId, input),
        selfUpdateRunner: (input) => this.selfUpdateRunner(input),
        upgradeRestartPlanner: () => this.upgradeRestartPlanner(),
        upgradeVersionProbe: () => this.upgradeVersionProbe(),
        sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
      },
      message,
    );
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
    await runBackendCommand(
      {
        sessionActiveWindowMs: this.sessionActiveWindowMs,
        canCreateBackendRuntime: Boolean(this.executorFactory),
        sessionBackendOverrides: this.sessionBackendOverrides,
        sessionBackendProfiles: this.sessionBackendProfiles,
        sessionLastBackendDecisions: this.sessionLastBackendDecisions,
        workflowSnapshots: this.workflowSnapshots,
        autoDevSnapshots: this.autoDevSnapshots,
        runningExecutions: this.runningExecutions,
        stateStore: this.stateStore,
        resolveSessionBackendStatusProfile: (targetSessionKey) => this.resolveSessionBackendStatusProfile(targetSessionKey),
        formatBackendToolLabel: (profile) => this.formatBackendToolLabel(profile),
        resolveManualBackendProfile: (provider) => this.resolveManualBackendProfile(provider),
        serializeBackendProfile: (profile) => this.serializeBackendProfile(profile),
        hasBackendRuntime: (profile) => this.hasBackendRuntime(profile),
        ensureBackendRuntime: (profile) => this.ensureBackendRuntime(profile),
        clearSessionFromAllRuntimes: (targetSessionKey) => this.clearSessionFromAllRuntimes(targetSessionKey),
        sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
      },
      {
        sessionKey,
        message,
      },
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
    return runRestoreWorkflowDiagStore(this.stateStore, WORKFLOW_DIAG_SNAPSHOT_KEY, this.logger);
  }

  private persistWorkflowDiagStore(): void {
    runPersistWorkflowDiagStore(this.stateStore, WORKFLOW_DIAG_SNAPSHOT_KEY, this.workflowDiagStore, this.logger);
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
    const runId = runBeginWorkflowDiagRun({
      store: this.workflowDiagStore,
      maxRuns: WORKFLOW_DIAG_MAX_RUNS,
      kind: input.kind,
      sessionKey: input.sessionKey,
      conversationId: input.conversationId,
      requestId: input.requestId,
      objective: input.objective,
      taskId: input.taskId,
      taskDescription: input.taskDescription,
    });
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
    runAppendWorkflowDiagEvent({
      store: this.workflowDiagStore,
      maxEvents: WORKFLOW_DIAG_MAX_EVENTS,
      runId,
      kind,
      stage,
      round,
      message,
    });
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
    runFinishWorkflowDiagRun({
      store: this.workflowDiagStore,
      runId,
      status: input.status,
      approved: input.approved,
      repairRounds: input.repairRounds,
      error: input.error,
    });
    this.persistWorkflowDiagStore();
  }

  private listWorkflowDiagRuns(kind: WorkflowDiagRunKind, limit: number): WorkflowDiagRunRecord[] {
    return runListWorkflowDiagRuns(this.workflowDiagStore, kind, limit);
  }

  private listWorkflowDiagRunsBySession(
    kind: WorkflowDiagRunKind,
    sessionKey: string,
    limit: number,
  ): WorkflowDiagRunRecord[] {
    return runListWorkflowDiagRunsBySession(this.workflowDiagStore, kind, sessionKey, limit);
  }

  private listWorkflowDiagEvents(runId: string, limit = 8): WorkflowDiagEventRecord[] {
    return runListWorkflowDiagEvents(this.workflowDiagStore, runId, limit);
  }

  private listRecentAutoDevGitCommitEventSummaries(limit: number): string[] {
    return runListRecentAutoDevGitCommitEventSummaries(this.workflowDiagStore, limit);
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
