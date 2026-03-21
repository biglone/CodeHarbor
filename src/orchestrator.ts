import { Mutex } from "async-mutex";

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
import { Logger } from "./logger";
import {
  type RuntimeMetricsSnapshot,
} from "./metrics";
import {
  NpmRegistryUpdateChecker,
  type PackageUpdateChecker,
  resolvePackageVersion,
} from "./package-update-checker";
import { RateLimiter } from "./rate-limiter";
import {
  BackendModelRouter,
  type BackendModelRouteProfile,
  type BackendModelRouteTaskType,
} from "./routing/backend-model-router";
import {
  type RuntimeHotConfigPayload,
} from "./runtime-hot-config";
import {
  ARCHIVE_REASON_MAX_ATTEMPTS,
  createRetryPolicy,
  type RetryPolicy,
} from "./reliability/retry-policy";
import {
  AUTODEV_GIT_COMMIT_HISTORY_MAX,
  BACKEND_ROUTE_DIAG_HISTORY_MAX,
  CONTEXT_BRIDGE_HISTORY_LIMIT,
  CONTEXT_BRIDGE_MAX_CHARS,
  DEFAULT_AUTODEV_DETAILED_PROGRESS_ENABLED,
  DEFAULT_AUTODEV_LOOP_MAX_MINUTES,
  DEFAULT_AUTODEV_LOOP_MAX_RUNS,
  DEFAULT_AUTODEV_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_TASK_QUEUE_RECOVERY_BATCH_LIMIT,
  DEFAULT_TASK_QUEUE_RETRY_POLICY,
  DEFAULT_UPGRADE_LOCK_TTL_MS,
  DEFAULT_WORKFLOW_ROLE_SKILLS_ENABLED,
  DEFAULT_WORKFLOW_ROLE_SKILLS_MODE,
  RUN_SNAPSHOT_MAX_ENTRIES,
  RUN_SNAPSHOT_TTL_MS,
  WORKFLOW_DIAG_SNAPSHOT_KEY,
} from "./orchestrator/orchestrator-constants";
import {
  StateStore,
  type TaskFailureArchiveRecord,
  type TaskQueueEnqueueInput,
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
  type WorkflowRoleSkillDisclosureMode,
  type WorkflowRoleSkillPolicyOverride,
} from "./workflow/role-skills";
import {
  formatError,
  parseEnvBoolean,
  parseEnvPositiveInt,
} from "./orchestrator/helpers";
import {
  buildWorkflowRoleSkillStatus as runBuildWorkflowRoleSkillStatus,
  resolveWorkflowRoleSkillPolicy as runResolveWorkflowRoleSkillPolicy,
  setWorkflowRoleSkillPolicyOverride as runSetWorkflowRoleSkillPolicyOverride,
} from "./orchestrator/workflow-role-skill-policy";
import { recordCliCompatPrompt as runRecordCliCompatPrompt } from "./orchestrator/cli-compat-prompt-recorder";
import {
  listAutoDevGitCommitRecords as runListAutoDevGitCommitRecords,
  recordAutoDevGitCommit as runRecordAutoDevGitCommit,
  type AutoDevGitCommitRecord,
} from "./orchestrator/autodev-git-commit-history";
import {
  type AutoDevGitCommitResult,
} from "./orchestrator/autodev-git";
import {
  type AutoDevRunSnapshot,
  type AutoDevRunContext,
} from "./orchestrator/autodev-runner";
import {
  ensureBackendRuntime as runEnsureBackendRuntime,
  prepareBackendRuntimeForSession as runPrepareBackendRuntimeForSession,
} from "./orchestrator/backend-runtime-management";
import {
  resolveManualBackendProfile as runResolveManualBackendProfile,
  resolveSessionBackendStatusProfile as runResolveSessionBackendStatusProfile,
} from "./orchestrator/backend-profile-selection";
import {
  cancelRunningExecutionInAllRuntimes as runCancelRunningExecutionInAllRuntimes,
  clearSessionFromAllRuntimes as runClearSessionFromAllRuntimes,
  getBackendRuntimeStats as runGetBackendRuntimeStats,
  hasBackendRuntime as runHasBackendRuntime,
  serializeBackendProfile as runSerializeBackendProfile,
} from "./orchestrator/backend-runtime-registry";
import {
  classifyBackendTaskType,
  parseControlCommand,
} from "./orchestrator/command-routing";
import {
  collectLocalAttachmentPaths,
  formatMimeAllowlist,
} from "./orchestrator/media-progress";
import {
  finishProgress as runFinishProgress,
  handleProgress as runHandleProgress,
  sendProgressUpdate as runSendProgressUpdate,
  startTypingHeartbeat as runStartTypingHeartbeat,
  type SendProgressContext,
} from "./orchestrator/progress-dispatch";
import {
  isApiTaskPayloadEquivalent,
  normalizeApiTaskRequestId,
  parseQueuedInboundPayload,
  type QueuedInboundPayload,
} from "./orchestrator/queue-payload";
import { pruneRunSnapshots as runPruneRunSnapshots } from "./orchestrator/snapshot-pruning";
import { pruneSessionLocks as runPruneSessionLocks } from "./orchestrator/session-locks";
import { sendFailureNotice as runSendFailureNotice } from "./orchestrator/failure-notice-dispatch";
import { persistRuntimeMetricsSnapshot as runPersistRuntimeMetricsSnapshot } from "./orchestrator/runtime-metrics-persistence";
import { resolveRoomRuntimeConfig as runResolveRoomRuntimeConfig } from "./orchestrator/room-runtime-config";
import { AutoDevRuntimeMetrics, MediaMetrics, RequestMetrics } from "./orchestrator/runtime-metrics";
import { buildStatusCommandDispatchContext as runBuildStatusCommandDispatchContext } from "./orchestrator/status-command-context";
import { buildDiagCommandDispatchContext as runBuildDiagCommandDispatchContext } from "./orchestrator/diag-command-context";
import { buildAutoDevRunCommandDispatchContext as runBuildAutoDevRunCommandDispatchContext } from "./orchestrator/autodev-run-command-context";
import { buildControlCommandDispatchContext as runBuildControlCommandDispatchContext } from "./orchestrator/control-command-context";
import { buildStopCommandDispatchContext as runBuildStopCommandDispatchContext } from "./orchestrator/stop-command-context";
import { buildBackendCommandDispatchContext as runBuildBackendCommandDispatchContext } from "./orchestrator/backend-command-context";
import { buildUpgradeCommandDispatchContext as runBuildUpgradeCommandDispatchContext } from "./orchestrator/upgrade-command-context";
import { buildAgentRunRequestContext as runBuildAgentRunRequestContext } from "./orchestrator/agent-run-request-context";
import { buildChatRequestDispatchContext as runBuildChatRequestDispatchContext } from "./orchestrator/chat-request-context";
import { buildWorkflowRunCommandDispatchContext as runBuildWorkflowRunCommandDispatchContext } from "./orchestrator/workflow-run-command-context";
import { buildLockedMessageDispatchContext as runBuildLockedMessageDispatchContext } from "./orchestrator/locked-message-context";
import { buildNonBlockingStatusRouteContext as runBuildNonBlockingStatusRouteContext } from "./orchestrator/non-blocking-status-context";
import {
  executeLockedAutoDevRun as runExecuteLockedAutoDevRun,
  executeLockedChatRun as runExecuteLockedChatRun,
  executeLockedWorkflowRun as runExecuteLockedWorkflowRun,
} from "./orchestrator/locked-message-run-executors";
import { resolveUpgradeRuntimeConfig as runResolveUpgradeRuntimeConfig } from "./orchestrator/upgrade-runtime-config";
import { resolveWorkflowRuntimeConfig as runResolveWorkflowRuntimeConfig } from "./orchestrator/workflow-runtime-config";
import {
  formatBackendRouteProfile,
} from "./orchestrator/diagnostic-formatters";
import type {
  OrchestratorOptions,
  SelfUpdateRunner,
  UpgradeRestartPlanner,
  UpgradeVersionProbe,
} from "./orchestrator/orchestrator-config-types";
import {
  type ControlCommand,
} from "./orchestrator/control-command-handler";
import { sendControlCommand as runSendControlCommand } from "./orchestrator/control-command-dispatch";
import { sendBackendCommand as runSendBackendCommand } from "./orchestrator/backend-command-dispatch";
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
import { tryHandleNonBlockingStatusRoute as runNonBlockingStatusRoute } from "./orchestrator/non-blocking-status-route";
import { executeLockedMessage } from "./orchestrator/locked-message-execution";
import { sendWorkflowRunRequest as runSendWorkflowRunRequest } from "./orchestrator/workflow-run-dispatch";
import { sendStopCommand as runSendStopCommand } from "./orchestrator/stop-command-dispatch";
import { sendUpgradeCommand as runSendUpgradeCommand } from "./orchestrator/upgrade-command-dispatch";
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
import type {
  ApiTaskQueryResult,
  ApiTaskSubmitInput,
  ApiTaskSubmitResult,
} from "./orchestrator/orchestrator-api-types";
import {
  ApiTaskIdempotencyConflictError,
} from "./orchestrator/orchestrator-api-types";
import type {
  BackendRuntimeBundle,
  DocumentExtractionSummary,
  ImageSelectionResult,
  RequestOutcome,
  RoomRuntimeConfig,
  RunningExecution,
  SessionBackendDecision,
  SessionBackendOverride,
  SessionLockEntry,
} from "./orchestrator/orchestrator-types";
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
import {
  acquireUpgradeExecutionLock as runAcquireUpgradeExecutionLock,
  authorizeUpgradeRequest as runAuthorizeUpgradeRequest,
  createUpgradeRun as runCreateUpgradeRun,
  finishUpgradeRun as runFinishUpgradeRun,
  getLatestUpgradeRun as runGetLatestUpgradeRun,
  getRecentUpgradeRuns as runGetRecentUpgradeRuns,
  getUpgradeExecutionLockSnapshot as runGetUpgradeExecutionLockSnapshot,
  getUpgradeRunStats as runGetUpgradeRunStats,
  releaseUpgradeExecutionLock as runReleaseUpgradeExecutionLock,
} from "./orchestrator/upgrade-state-access";
import {
  getTaskQueueStateStore as runGetTaskQueueStateStore,
  getUpgradeStateStore as runGetUpgradeStateStore,
  listTaskQueueFailureArchive as runListTaskQueueFailureArchive,
} from "./orchestrator/state-store-access";
import {
  sendAutoDevStatusCommand as runSendAutoDevStatusCommand,
  sendStatusCommand as runSendStatusCommand,
  sendWorkflowStatusCommand as runSendWorkflowStatusCommand,
} from "./orchestrator/status-command-dispatch";
import { sendDiagCommand as runSendDiagCommand } from "./orchestrator/diag-command-dispatch";

export { buildApiTaskEventId, buildSessionKey };
export type { ApiTaskQueryResult, ApiTaskSubmitInput, ApiTaskSubmitResult, ApiTaskStage } from "./orchestrator/orchestrator-api-types";
export { ApiTaskIdempotencyConflictError } from "./orchestrator/orchestrator-api-types";

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
    const workflowRuntimeConfig = runResolveWorkflowRuntimeConfig({
      options,
      executor,
      logger: this.logger,
    });
    this.workflowRoleSkillCatalog = workflowRuntimeConfig.workflowRoleSkillCatalog;
    this.workflowRoleSkillDefaultPolicy = workflowRuntimeConfig.workflowRoleSkillDefaultPolicy;
    this.workflowPlanContextMaxChars = workflowRuntimeConfig.workflowPlanContextMaxChars;
    this.workflowOutputContextMaxChars = workflowRuntimeConfig.workflowOutputContextMaxChars;
    this.workflowFeedbackContextMaxChars = workflowRuntimeConfig.workflowFeedbackContextMaxChars;
    this.workflowRunner = workflowRuntimeConfig.workflowRunner;
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
    const upgradeRuntimeConfig = runResolveUpgradeRuntimeConfig({
      options,
      logger: this.logger,
    });
    this.matrixAdminUsers = upgradeRuntimeConfig.matrixAdminUsers;
    this.upgradeAllowedUsers = upgradeRuntimeConfig.upgradeAllowedUsers;
    this.upgradeLockOwner = upgradeRuntimeConfig.upgradeLockOwner;
    this.selfUpdateRunner = upgradeRuntimeConfig.selfUpdateRunner;
    this.upgradeRestartPlanner = upgradeRuntimeConfig.upgradeRestartPlanner;
    this.upgradeVersionProbe = upgradeRuntimeConfig.upgradeVersionProbe;
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
          this.buildLockedMessageDispatchContext(),
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

  private buildLockedMessageDispatchContext(): Parameters<typeof executeLockedMessage>[0] {
    return runBuildLockedMessageDispatchContext({
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
      classifyBackendTaskType: (workflowCommand, autoDevCommand) => classifyBackendTaskType(workflowCommand, autoDevCommand),
      resolveSessionBackendDecision: (input) => this.resolveSessionBackendDecision(input),
      prepareBackendRuntimeForSession: (targetSessionKey, profile) =>
        this.prepareBackendRuntimeForSession(targetSessionKey, profile),
      setSessionLastBackendDecision: (targetSessionKey, decision) =>
        this.sessionLastBackendDecisions.set(targetSessionKey, decision),
      recordBackendRouteDecision: (input) => this.recordBackendRouteDecision(input),
      executeWorkflowRun: async (input) => {
        await runExecuteLockedWorkflowRun(
          {
            buildAgentRunRequestContext: () => this.buildAgentRunRequestContext(),
            handleWorkflowRunCommand: (objective, sessionKey, message, requestId, workdir) =>
              this.handleWorkflowRunCommand(objective, sessionKey, message, requestId, workdir),
            sendWorkflowFailure: (conversationId, error) => this.sendWorkflowFailure(conversationId, error),
          },
          input,
        );
      },
      executeAutoDevRun: async (input) => {
        await runExecuteLockedAutoDevRun(
          {
            buildAgentRunRequestContext: () => this.buildAgentRunRequestContext(),
            handleAutoDevRunCommand: (taskId, sessionKey, message, requestId, workdir) =>
              this.handleAutoDevRunCommand(taskId, sessionKey, message, requestId, workdir),
            sendAutoDevFailure: (conversationId, error) => this.sendAutoDevFailure(conversationId, error),
          },
          input,
        );
      },
      executeChatRun: (input) =>
        runExecuteLockedChatRun(
          {
            buildChatRequestDispatchContext: () => this.buildChatRequestDispatchContext(),
          },
          input,
        ),
    });
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
      runBuildNonBlockingStatusRouteContext({
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
      }),
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
    await runSendControlCommand(
      this.buildControlCommandDispatchContext(),
      {
        command,
        sessionKey,
        message,
        requestId,
      },
    );
  }

  private buildControlCommandDispatchContext(): Parameters<typeof runSendControlCommand>[0] {
    return runBuildControlCommandDispatchContext({
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
    });
  }

  private async sendStatusCommand(sessionKey: string, message: InboundMessage): Promise<void> {
    await runSendStatusCommand(
      this.buildStatusCommandDispatchContext(),
      {
        sessionKey,
        message,
      },
    );
  }

  private async handleWorkflowStatusCommand(sessionKey: string, message: InboundMessage): Promise<void> {
    await runSendWorkflowStatusCommand(
      this.buildStatusCommandDispatchContext(),
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
    await runSendAutoDevStatusCommand(
      this.buildStatusCommandDispatchContext(),
      {
        sessionKey,
        message,
        workdir,
      },
    );
  }

  private buildStatusCommandDispatchContext() {
    return runBuildStatusCommandDispatchContext({
      botNoticePrefix: this.botNoticePrefix,
      groupDirectModeEnabled: this.groupDirectModeEnabled,
      updateCheckTtlMs: this.updateCheckTtlMs,
      cliCompatEnabled: this.cliCompat.enabled,
      workflowEnabled: this.workflowRunner.isEnabled(),
      autoDevDetailedProgressDefaultEnabled: this.autoDevDetailedProgressDefaultEnabled,
      workflowPlanContextMaxChars: this.workflowPlanContextMaxChars,
      workflowOutputContextMaxChars: this.workflowOutputContextMaxChars,
      workflowFeedbackContextMaxChars: this.workflowFeedbackContextMaxChars,
      autoDevLoopMaxRuns: this.autoDevLoopMaxRuns,
      autoDevLoopMaxMinutes: this.autoDevLoopMaxMinutes,
      autoDevAutoCommit: this.autoDevAutoCommit,
      autoDevMaxConsecutiveFailures: this.autoDevMaxConsecutiveFailures,
      stateStore: this.stateStore,
      resolveRoomRuntimeConfig: (conversationId: string) => this.resolveRoomRuntimeConfig(conversationId),
      getRuntimeMetricsSnapshot: () => this.metrics.snapshot(this.runningExecutions.size),
      getRateLimiterSnapshot: () => this.rateLimiter.snapshot(),
      getBackendRuntimeStats: () => this.getBackendRuntimeStats(),
      workflowSnapshots: this.workflowSnapshots,
      autoDevSnapshots: this.autoDevSnapshots,
      activeAutoDevLoopSessions: this.activeAutoDevLoopSessions,
      pendingAutoDevLoopStopRequests: this.pendingAutoDevLoopStopRequests,
      pendingStopRequests: this.pendingStopRequests,
      isAutoDevDetailedProgressEnabled: (targetSessionKey: string) => this.isAutoDevDetailedProgressEnabled(targetSessionKey),
      listWorkflowDiagRunsBySession: (kind: "autodev", targetSessionKey: string, limit: number) =>
        this.listWorkflowDiagRunsBySession(kind, targetSessionKey, limit),
      listWorkflowDiagEvents: (runId: string, limit?: number) => this.listWorkflowDiagEvents(runId, limit),
      buildWorkflowRoleSkillStatus: (targetSessionKey: string) => this.buildWorkflowRoleSkillStatus(targetSessionKey),
      getPackageUpdateStatus: () => this.packageUpdateChecker.getStatus(),
      getLatestUpgradeRun: () => this.getLatestUpgradeRun(),
      getRecentUpgradeRuns: (limit: number) => this.getRecentUpgradeRuns(limit),
      getUpgradeRunStats: () => this.getUpgradeRunStats(),
      getUpgradeExecutionLockSnapshot: () => this.getUpgradeExecutionLockSnapshot(),
      resolveSessionBackendStatusProfile: (targetSessionKey: string) => this.resolveSessionBackendStatusProfile(targetSessionKey),
      sessionBackendOverrides: this.sessionBackendOverrides,
      sessionLastBackendDecisions: this.sessionLastBackendDecisions,
      formatBackendToolLabel: (profile: BackendModelRouteProfile) => this.formatBackendToolLabel(profile),
      sendNotice: (conversationId: string, text: string) => this.channel.sendNotice(conversationId, text),
    });
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
      this.buildAutoDevRunCommandDispatchContext(),
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

  private buildAutoDevRunCommandDispatchContext(): Parameters<typeof runHandleAutoDevRunCommand>[0] {
    return runBuildAutoDevRunCommandDispatchContext({
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
    });
  }

  private buildAgentRunRequestContext(): Parameters<typeof executeAgentRunRequest>[0] {
    return runBuildAgentRunRequestContext({
      logger: this.logger,
      sessionActiveWindowMs: this.sessionActiveWindowMs,
      stateStore: this.stateStore,
      workflowRunner: this.workflowRunner,
      recordRequestMetrics: (outcome, queueMs, execMs, sendMs) =>
        this.recordRequestMetrics(outcome, queueMs, execMs, sendMs),
      persistRuntimeMetricsSnapshot: () => this.persistRuntimeMetricsSnapshot(),
    });
  }

  private buildChatRequestDispatchContext(): Parameters<typeof executeChatRequest>[0] {
    return runBuildChatRequestDispatchContext({
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
      recordCliCompatPrompt: (entry) => runRecordCliCompatPrompt(this.cliCompatRecorder, this.logger, entry),
      buildConversationBridgeContext: (targetSessionKey) =>
        runBuildConversationBridgeContext({
          messages: this.stateStore.listRecentConversationMessages(targetSessionKey, CONTEXT_BRIDGE_HISTORY_LIMIT),
          maxChars: CONTEXT_BRIDGE_MAX_CHARS,
        }),
      transcribeAudioAttachments: (targetMessage, targetRequestId, targetSessionKey) =>
        this.transcribeAudioAttachments(targetMessage, targetRequestId, targetSessionKey),
      prepareImageAttachments: (targetMessage, targetRequestId, targetSessionKey) =>
        this.prepareImageAttachments(targetMessage, targetRequestId, targetSessionKey),
      prepareDocumentAttachments: (targetMessage, targetRequestId, targetSessionKey) =>
        this.prepareDocumentAttachments(targetMessage, targetRequestId, targetSessionKey),
      buildExecutionPrompt: (prompt, targetMessage, audioTranscripts, documents, bridgeContext) =>
        runBuildExecutionPrompt({
          prompt,
          message: targetMessage,
          audioTranscripts,
          extractedDocuments: documents,
          bridgeContext,
        }),
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
    });
  }

  private recordAutoDevGitCommit(sessionKey: string, taskId: string, result: AutoDevGitCommitResult): void {
    runRecordAutoDevGitCommit(this.autoDevGitCommitRecords, sessionKey, taskId, result, AUTODEV_GIT_COMMIT_HISTORY_MAX);
  }

  private listAutoDevGitCommitRecords(limit: number): AutoDevGitCommitRecord[] {
    return runListAutoDevGitCommitRecords(this.autoDevGitCommitRecords, limit);
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
    return runSendWorkflowRunRequest(
      this.buildWorkflowRunDispatchContext(),
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

  private buildWorkflowRunDispatchContext(): Parameters<typeof runSendWorkflowRunRequest>[0] {
    return runBuildWorkflowRunCommandDispatchContext({
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
    });
  }

  private async sendWorkflowFailure(conversationId: string, error: unknown): Promise<number> {
    return runSendFailureNotice(
      {
        sendNotice: (targetConversationId, text) => this.channel.sendNotice(targetConversationId, text),
        sendMessage: (targetConversationId, text) => this.channel.sendMessage(targetConversationId, text),
      },
      conversationId,
      error,
      "workflow",
    );
  }

  private async sendAutoDevFailure(conversationId: string, error: unknown): Promise<number> {
    return runSendFailureNotice(
      {
        sendNotice: (targetConversationId, text) => this.channel.sendNotice(targetConversationId, text),
        sendMessage: (targetConversationId, text) => this.channel.sendMessage(targetConversationId, text),
      },
      conversationId,
      error,
      "autodev",
    );
  }

  private async handleStopCommand(sessionKey: string, message: InboundMessage, requestId: string): Promise<void> {
    await runSendStopCommand(
      this.buildStopCommandDispatchContext(),
      {
        sessionKey,
        message,
        requestId,
      },
    );
  }

  private buildStopCommandDispatchContext(): Parameters<typeof runSendStopCommand>[0] {
    return runBuildStopCommandDispatchContext({
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
    });
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
    return runStartTypingHeartbeat(this.buildProgressDispatchContext(), conversationId);
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
    await runHandleProgress(this.buildProgressDispatchContext(), {
      conversationId,
      isDirectMessage,
      progress,
      getLastProgressAt,
      setLastProgressAt,
      getLastProgressText,
      setLastProgressText,
      getProgressNoticeEventId,
      setProgressNoticeEventId,
    });
  }

  private async finishProgress(ctx: SendProgressContext, summary: string): Promise<void> {
    await runFinishProgress(this.buildProgressDispatchContext(), ctx, summary);
  }

  private async sendProgressUpdate(ctx: SendProgressContext, text: string): Promise<void> {
    await runSendProgressUpdate(this.buildProgressDispatchContext(), ctx, text);
  }

  private buildProgressDispatchContext(): Parameters<typeof runHandleProgress>[0] {
    return {
      progressUpdatesEnabled: this.progressUpdatesEnabled,
      progressMinIntervalMs: this.progressMinIntervalMs,
      typingTimeoutMs: this.typingTimeoutMs,
      cliCompatEnabled: this.cliCompat.enabled,
      botNoticePrefix: this.botNoticePrefix,
      packageUpdateChecker: this.packageUpdateChecker,
      channel: this.channel,
      logger: this.logger,
    };
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

  private resolveRoomRuntimeConfig(conversationId: string): RoomRuntimeConfig {
    return runResolveRoomRuntimeConfig({
      conversationId,
      configService: this.configService,
      roomTriggerPolicies: this.roomTriggerPolicies,
      defaultGroupTriggerPolicy: this.defaultGroupTriggerPolicy,
      defaultCodexWorkdir: this.defaultCodexWorkdir,
    });
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
    return runPrepareBackendRuntimeForSession({
      sessionKey,
      profile,
      defaultBackendProfile: this.defaultBackendProfile,
      stateStore: this.stateStore,
      sessionBackendProfiles: this.sessionBackendProfiles,
      workflowSnapshots: this.workflowSnapshots,
      autoDevSnapshots: this.autoDevSnapshots,
      clearSessionFromAllRuntimes: (targetSessionKey) => this.clearSessionFromAllRuntimes(targetSessionKey),
      ensureBackendRuntime: (targetProfile) => this.ensureBackendRuntime(targetProfile),
    });
  }

  private resolveSessionBackendStatusProfile(sessionKey: string): BackendModelRouteProfile {
    return runResolveSessionBackendStatusProfile({
      sessionKey,
      sessionBackendOverrides: this.sessionBackendOverrides,
      sessionBackendProfiles: this.sessionBackendProfiles,
      defaultBackendProfile: this.defaultBackendProfile,
    });
  }

  private resolveManualBackendProfile(provider: "codex" | "claude"): BackendModelRouteProfile {
    return runResolveManualBackendProfile(provider, this.defaultBackendProfile);
  }

  private ensureBackendRuntime(profile: BackendModelRouteProfile): BackendRuntimeBundle {
    return runEnsureBackendRuntime({
      profile,
      backendRuntimes: this.backendRuntimes,
      executorFactory: this.executorFactory,
    });
  }

  private hasBackendRuntime(profile: BackendModelRouteProfile): boolean {
    return runHasBackendRuntime(this.backendRuntimes, profile);
  }

  private serializeBackendProfile(profile: BackendModelRouteProfile): string {
    return runSerializeBackendProfile(profile);
  }

  private clearSessionFromAllRuntimes(sessionKey: string): void {
    runClearSessionFromAllRuntimes(this.backendRuntimes, sessionKey);
  }

  private cancelRunningExecutionInAllRuntimes(sessionKey: string): void {
    runCancelRunningExecutionInAllRuntimes(this.backendRuntimes, sessionKey);
  }

  private getBackendRuntimeStats(): { workerCount: number; runningCount: number } {
    return runGetBackendRuntimeStats(this.backendRuntimes);
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
    return runResolveWorkflowRoleSkillPolicy({
      sessionKey,
      workflowRoleSkillPolicyOverrides: this.workflowRoleSkillPolicyOverrides,
      workflowRoleSkillDefaultPolicy: this.workflowRoleSkillDefaultPolicy,
      defaultEnabled: DEFAULT_WORKFLOW_ROLE_SKILLS_ENABLED,
      defaultMode: DEFAULT_WORKFLOW_ROLE_SKILLS_MODE,
    });
  }

  private setWorkflowRoleSkillPolicyOverride(sessionKey: string, next: WorkflowRoleSkillPolicyOverride): void {
    runSetWorkflowRoleSkillPolicyOverride({
      sessionKey,
      next,
      workflowRoleSkillPolicyOverrides: this.workflowRoleSkillPolicyOverrides,
      workflowRoleSkillDefaultPolicy: this.workflowRoleSkillDefaultPolicy,
      defaultEnabled: DEFAULT_WORKFLOW_ROLE_SKILLS_ENABLED,
      defaultMode: DEFAULT_WORKFLOW_ROLE_SKILLS_MODE,
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
    return runBuildWorkflowRoleSkillStatus({
      sessionKey,
      workflowRoleSkillCatalog: this.workflowRoleSkillCatalog,
      workflowRoleSkillPolicyOverrides: this.workflowRoleSkillPolicyOverrides,
      workflowRoleSkillPolicy: this.resolveWorkflowRoleSkillPolicy(sessionKey),
    });
  }

  private pruneRunSnapshots(now: number): void {
    runPruneRunSnapshots({
      workflowSnapshots: this.workflowSnapshots,
      autoDevSnapshots: this.autoDevSnapshots,
      now,
      ttlMs: RUN_SNAPSHOT_TTL_MS,
      maxEntries: RUN_SNAPSHOT_MAX_ENTRIES,
    });
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
    runPruneSessionLocks(this.sessionLocks, now, this.lockTtlMs);
  }

  private async handleUpgradeCommand(message: InboundMessage): Promise<void> {
    await runSendUpgradeCommand(this.buildUpgradeCommandDispatchContext(), message);
  }

  private buildUpgradeCommandDispatchContext(): Parameters<typeof runSendUpgradeCommand>[0] {
    return runBuildUpgradeCommandDispatchContext({
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
    });
  }

  private authorizeUpgradeRequest(message: InboundMessage): { allowed: true } | { allowed: false; reason: string } {
    return runAuthorizeUpgradeRequest(message, this.upgradeAllowedUsers, this.matrixAdminUsers);
  }

  private createUpgradeRun(requestedBy: string, targetVersion: string | null): number | null {
    return runCreateUpgradeRun(
      {
        getUpgradeStateStore: () => this.getUpgradeStateStore(),
        logger: this.logger,
      },
      requestedBy,
      targetVersion,
    );
  }

  private finishUpgradeRun(
    runId: number | null,
    input: { status: "succeeded" | "failed"; installedVersion: string | null; error: string | null },
  ): void {
    runFinishUpgradeRun(
      {
        getUpgradeStateStore: () => this.getUpgradeStateStore(),
        logger: this.logger,
      },
      runId,
      input,
    );
  }

  private getLatestUpgradeRun(): UpgradeRunRecord | null {
    return runGetLatestUpgradeRun({
      getUpgradeStateStore: () => this.getUpgradeStateStore(),
      logger: this.logger,
    });
  }

  private getRecentUpgradeRuns(limit: number): UpgradeRunRecord[] {
    return runGetRecentUpgradeRuns(
      {
        getUpgradeStateStore: () => this.getUpgradeStateStore(),
        logger: this.logger,
      },
      limit,
    );
  }

  private getUpgradeRunStats(): UpgradeRunStats {
    return runGetUpgradeRunStats({
      getUpgradeStateStore: () => this.getUpgradeStateStore(),
      logger: this.logger,
    });
  }

  private getUpgradeExecutionLockSnapshot(): UpgradeExecutionLockRecord | null {
    return runGetUpgradeExecutionLockSnapshot({
      getUpgradeStateStore: () => this.getUpgradeStateStore(),
      logger: this.logger,
    });
  }

  private acquireUpgradeExecutionLock(): { acquired: boolean; owner: string | null; expiresAt: number | null } {
    return runAcquireUpgradeExecutionLock(
      {
        getUpgradeStateStore: () => this.getUpgradeStateStore(),
        logger: this.logger,
      },
      this.upgradeLockOwner,
      DEFAULT_UPGRADE_LOCK_TTL_MS,
    );
  }

  private releaseUpgradeExecutionLock(): void {
    runReleaseUpgradeExecutionLock(
      {
        getUpgradeStateStore: () => this.getUpgradeStateStore(),
        logger: this.logger,
      },
      this.upgradeLockOwner,
    );
  }

  private getTaskQueueStateStore(): TaskQueueStateStore | null {
    return runGetTaskQueueStateStore(this.stateStore) as TaskQueueStateStore | null;
  }

  private listTaskQueueFailureArchive(limit: number): TaskFailureArchiveRecord[] {
    return runListTaskQueueFailureArchive(this.stateStore, this.logger, limit);
  }

  private getUpgradeStateStore(): UpgradeStateStore | null {
    return runGetUpgradeStateStore(this.stateStore) as UpgradeStateStore | null;
  }

  private async handleBackendCommand(sessionKey: string, message: InboundMessage): Promise<void> {
    await runSendBackendCommand(
      this.buildBackendCommandDispatchContext(),
      {
        sessionKey,
        message,
      },
    );
  }

  private buildBackendCommandDispatchContext(): Parameters<typeof runSendBackendCommand>[0] {
    return runBuildBackendCommandDispatchContext({
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
    });
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
    await runSendDiagCommand(this.buildDiagCommandDispatchContext(), message);
  }

  private buildDiagCommandDispatchContext(): Parameters<typeof runSendDiagCommand>[0] {
    return runBuildDiagCommandDispatchContext({
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
      listWorkflowDiagRuns: (kind: "workflow" | "autodev", limit: number) => this.listWorkflowDiagRuns(kind, limit),
      listWorkflowDiagEvents: (runId: string, limit?: number) => this.listWorkflowDiagEvents(runId, limit),
      autoDevSnapshots: this.autoDevSnapshots,
      listAutoDevGitCommitRecords: (limit: number) => this.listAutoDevGitCommitRecords(limit),
      listRecentAutoDevGitCommitEventSummaries: (limit: number) => this.listRecentAutoDevGitCommitEventSummaries(limit),
      resolveSessionBackendStatusProfile: (sessionKey: string) => this.resolveSessionBackendStatusProfile(sessionKey),
      sessionBackendOverrides: this.sessionBackendOverrides,
      sessionLastBackendDecisions: this.sessionLastBackendDecisions,
      getBackendModelRouterStats: () => this.backendModelRouter.getStats(),
      listBackendRouteDiagRecords: (limit: number, sessionKey: string) => this.listBackendRouteDiagRecords(limit, sessionKey),
      getTaskQueueStateStore: () => this.getTaskQueueStateStore(),
      listTaskQueueFailureArchive: (limit: number) => this.listTaskQueueFailureArchive(limit),
      getRecentUpgradeRuns: (limit: number) => this.getRecentUpgradeRuns(limit),
      getUpgradeExecutionLockSnapshot: () => this.getUpgradeExecutionLockSnapshot(),
      getUpgradeRunStats: () => this.getUpgradeRunStats(),
      sendNotice: (conversationId: string, text: string) => this.channel.sendNotice(conversationId, text),
    });
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
    runPersistRuntimeMetricsSnapshot(this.stateStore, this.logger, "orchestrator", this.getRuntimeMetricsSnapshot());
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
