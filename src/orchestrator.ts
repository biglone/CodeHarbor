import { Mutex } from "async-mutex";

import { type AudioTranscriberLike, type AudioTranscript } from "./audio-transcriber";
import { type Channel } from "./channels/channel";
import { CliCompatRecorder } from "./compat/cli-compat-recorder";
import { ConfigService } from "./config-service";
import { CliCompatConfig, TriggerPolicy, type OutputLanguage, type RoomTriggerPolicyOverrides } from "./config";
import {
  CodexExecutor,
  type CodexProgressEvent,
} from "./executor/codex-executor";
import { Logger } from "./logger";
import {
  type RuntimeMetricsSnapshot,
} from "./metrics";
import {
  type PackageUpdateChecker,
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
  type RetryPolicy,
} from "./reliability/retry-policy";
import {
  AUTODEV_GIT_COMMIT_HISTORY_MAX,
  BACKEND_ROUTE_DIAG_HISTORY_MAX,
  CONTEXT_BRIDGE_HISTORY_LIMIT,
  CONTEXT_BRIDGE_MAX_CHARS,
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
  buildWorkflowRoleSkillStatus as runBuildWorkflowRoleSkillStatus,
  resolveWorkflowRoleSkillPolicy as runResolveWorkflowRoleSkillPolicy,
  setWorkflowRoleSkillPolicyOverride as runSetWorkflowRoleSkillPolicyOverride,
} from "./orchestrator/workflow-role-skill-policy";
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
} from "./orchestrator/queue-payload";
import { pruneRunSnapshots as runPruneRunSnapshots } from "./orchestrator/snapshot-pruning";
import { pruneSessionLocks as runPruneSessionLocks } from "./orchestrator/session-locks";
import { sendFailureNotice as runSendFailureNotice } from "./orchestrator/failure-notice-dispatch";
import { formatError } from "./orchestrator/helpers";
import { persistRuntimeMetricsSnapshot as runPersistRuntimeMetricsSnapshot } from "./orchestrator/runtime-metrics-persistence";
import { resolveRoomRuntimeConfig as runResolveRoomRuntimeConfig } from "./orchestrator/room-runtime-config";
import { AutoDevRuntimeMetrics, MediaMetrics, RequestMetrics } from "./orchestrator/runtime-metrics";
import { buildStatusCommandDispatchContextFromRuntime as runBuildStatusCommandDispatchContextFromRuntime } from "./orchestrator/status-command-context";
import { buildDiagCommandDispatchContextFromRuntime as runBuildDiagCommandDispatchContextFromRuntime } from "./orchestrator/diag-command-context";
import { buildAutoDevRunCommandDispatchContextFromRuntime as runBuildAutoDevRunCommandDispatchContextFromRuntime } from "./orchestrator/autodev-run-command-context";
import { buildControlCommandDispatchContextFromRuntime as runBuildControlCommandDispatchContextFromRuntime } from "./orchestrator/control-command-context";
import { buildStopCommandDispatchContext as runBuildStopCommandDispatchContext } from "./orchestrator/stop-command-context";
import { buildBackendCommandDispatchContextFromRuntime as runBuildBackendCommandDispatchContextFromRuntime } from "./orchestrator/backend-command-context";
import { buildUpgradeCommandDispatchContext as runBuildUpgradeCommandDispatchContext } from "./orchestrator/upgrade-command-context";
import { buildAgentRunRequestContext as runBuildAgentRunRequestContext } from "./orchestrator/agent-run-request-context";
import { buildChatRequestDispatchContextFromRuntime as runBuildChatRequestDispatchContextFromRuntime } from "./orchestrator/chat-request-context";
import { buildWorkflowRunCommandDispatchContext as runBuildWorkflowRunCommandDispatchContext } from "./orchestrator/workflow-run-command-context";
import { buildLockedMessageDispatchContextFromRuntime as runBuildLockedMessageDispatchContextFromRuntime } from "./orchestrator/locked-message-context";
import { executeNonBlockingStatusRouteFromRuntime as runExecuteNonBlockingStatusRouteFromRuntime } from "./orchestrator/non-blocking-status-context";
import {
  executeLockedAutoDevRun as runExecuteLockedAutoDevRun,
  executeLockedChatRun as runExecuteLockedChatRun,
  executeLockedWorkflowRun as runExecuteLockedWorkflowRun,
} from "./orchestrator/locked-message-run-executors";
import { resolveUpgradeRuntimeConfig as runResolveUpgradeRuntimeConfig } from "./orchestrator/upgrade-runtime-config";
import { resolveWorkflowRuntimeConfig as runResolveWorkflowRuntimeConfig } from "./orchestrator/workflow-runtime-config";
import { resolveInputRuntimeConfig as runResolveInputRuntimeConfig } from "./orchestrator/input-runtime-config";
import { resolveAutoDevRuntimeConfig as runResolveAutoDevRuntimeConfig } from "./orchestrator/autodev-runtime-config";
import { resolveServiceRuntimeConfig as runResolveServiceRuntimeConfig } from "./orchestrator/service-runtime-config";
import { resolveBackendRuntimeConfig as runResolveBackendRuntimeConfig } from "./orchestrator/backend-runtime-config";
import { resolveSessionRuntimeConfig as runResolveSessionRuntimeConfig } from "./orchestrator/session-runtime-config";
import { submitApiTask as runSubmitApiTask } from "./orchestrator/api-task-submission";
import { bootstrapTaskQueueRecovery as runBootstrapTaskQueueRecovery } from "./orchestrator/task-queue-recovery";
import { sendQueuedTaskFailureNotice as runSendQueuedTaskFailureNotice } from "./orchestrator/queue-failure-notice";
import {
  buildHandleMessageInternalDepsFromRuntime as runBuildHandleMessageInternalDepsFromRuntime,
  handleMessageInternal as runHandleMessageInternal,
} from "./orchestrator/message-handler";
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
  handleAutoDevContentCommand as runAutoDevContentCommand,
  handleAutoDevInitCommand as runAutoDevInitCommand,
  handleAutoDevLoopStopCommand as runAutoDevLoopStopCommand,
  handleAutoDevProgressCommand as runAutoDevProgressCommand,
  handleAutoDevReconcileCommand as runAutoDevReconcileCommand,
  handleAutoDevSkillsCommand as runAutoDevSkillsCommand,
  handleAutoDevWorkdirCommand as runAutoDevWorkdirCommand,
  type AutoDevControlCommandDeps,
  type AutoDevInitEnhancementInput,
  type AutoDevInitEnhancementResult,
} from "./orchestrator/autodev-control-command";
import { executeLockedMessage } from "./orchestrator/locked-message-execution";
import { sendWorkflowRunRequest as runSendWorkflowRunRequest } from "./orchestrator/workflow-run-dispatch";
import { sendStopCommand as runSendStopCommand } from "./orchestrator/stop-command-dispatch";
import { sendUpgradeCommand as runSendUpgradeCommand } from "./orchestrator/upgrade-command-dispatch";
import {
  buildApiTaskErrorSummary,
  buildApiTaskEventId,
  buildSessionKey,
  formatByteSize,
  mapApiTaskStage,
} from "./orchestrator/misc-utils";
import { routeMessage as runRouteMessage, type RouteDecision } from "./orchestrator/message-routing";
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
  ApiTaskLifecycleEvent,
  ApiTaskQueryResult,
  ApiTaskSubmitInput,
  ApiTaskSubmitResult,
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
export type {
  ApiTaskExternalContext,
  ApiTaskExternalSource,
  ApiTaskLifecycleEvent,
  ApiTaskQueryResult,
  ApiTaskStage,
  ApiTaskSubmitInput,
  ApiTaskSubmitResult,
} from "./orchestrator/orchestrator-api-types";
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
  private readonly contextBridgeHistoryLimit: number;
  private readonly contextBridgeMaxChars: number;
  private readonly lockTtlMs: number;
  private readonly lockPruneIntervalMs: number;
  private progressUpdatesEnabled: boolean;
  private progressMinIntervalMs: number;
  private typingTimeoutMs: number;
  private readonly commandPrefix: string;
  private outputLanguage: OutputLanguage;
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
  private readonly onApiTaskLifecycleEvent: ((event: ApiTaskLifecycleEvent) => void) | null;
  private readonly sessionQueueDrains = new Map<string, Promise<void>>();
  private readonly sessionQueueRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly defaultBackendProfile: BackendModelRouteProfile;
  private readonly backendModelRouter: BackendModelRouter;
  private readonly botNoticePrefix: string;
  private readonly processStartedAtIso: string;
  private readonly matrixAdminUsers: Set<string>;
  private readonly workflowSnapshots = new Map<string, WorkflowRunSnapshot>();
  private readonly autoDevSnapshots = new Map<string, AutoDevRunSnapshot>();
  private readonly autoDevWorkdirOverrides = new Map<string, string>();
  private readonly autoDevFailureStreaks = new Map<string, number>();
  private readonly autoDevGitCommitRecords: AutoDevGitCommitRecord[] = [];
  private readonly backendRouteDiagRecords: BackendRouteDiagRecord[] = [];
  private readonly autoDevLoopMaxRuns: number;
  private readonly autoDevLoopMaxMinutes: number;
  private readonly autoDevAutoCommit: boolean;
  private readonly autoDevAutoReleaseEnabled: boolean;
  private readonly autoDevAutoReleasePush: boolean;
  private readonly autoDevMaxConsecutiveFailures: number;
  private readonly autoDevRunArchiveEnabled: boolean;
  private readonly autoDevRunArchiveDir: string;
  private readonly autoDevDetailedProgressDefaultEnabled: boolean;
  private readonly autoDevStageOutputEchoDefaultEnabled: boolean;
  private readonly autoDevInitEnhancementEnabled: boolean;
  private readonly autoDevInitEnhancementTimeoutMs: number;
  private readonly autoDevInitEnhancementMaxChars: number;
  private readonly autoDevDetailedProgressOverrides = new Map<string, boolean>();
  private readonly autoDevStageOutputEchoOverrides = new Map<string, boolean>();
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
    const inputRuntimeConfig = runResolveInputRuntimeConfig({ options });
    this.cliCompat = inputRuntimeConfig.cliCompat;
    this.cliCompatRecorder = inputRuntimeConfig.cliCompatRecorder;
    this.audioTranscriber = inputRuntimeConfig.audioTranscriber;
    this.progressMinIntervalMs = inputRuntimeConfig.progressMinIntervalMs;
    this.typingTimeoutMs = inputRuntimeConfig.typingTimeoutMs;
    const sessionRuntimeConfig = runResolveSessionRuntimeConfig(options);
    this.commandPrefix = sessionRuntimeConfig.commandPrefix;
    this.outputLanguage = options?.outputLanguage === "en" ? "en" : "zh";
    this.matrixUserId = sessionRuntimeConfig.matrixUserId;
    this.sessionActiveWindowMs = sessionRuntimeConfig.sessionActiveWindowMs;
    this.groupDirectModeEnabled = sessionRuntimeConfig.groupDirectModeEnabled;
    this.defaultGroupTriggerPolicy = sessionRuntimeConfig.defaultGroupTriggerPolicy;
    this.roomTriggerPolicies = sessionRuntimeConfig.roomTriggerPolicies;
    this.configService = sessionRuntimeConfig.configService;
    this.defaultCodexWorkdir = sessionRuntimeConfig.defaultCodexWorkdir;
    this.rateLimiter = sessionRuntimeConfig.rateLimiter;
    this.contextBridgeHistoryLimit =
      typeof options?.contextBridgeHistoryLimit === "number" && Number.isFinite(options.contextBridgeHistoryLimit)
        ? Math.max(1, Math.floor(options.contextBridgeHistoryLimit))
        : CONTEXT_BRIDGE_HISTORY_LIMIT;
    this.contextBridgeMaxChars =
      typeof options?.contextBridgeMaxChars === "number" && Number.isFinite(options.contextBridgeMaxChars)
        ? Math.max(200, Math.floor(options.contextBridgeMaxChars))
        : CONTEXT_BRIDGE_MAX_CHARS;
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
    const autoDevRuntimeConfig = runResolveAutoDevRuntimeConfig(options);
    this.autoDevLoopMaxRuns = autoDevRuntimeConfig.autoDevLoopMaxRuns;
    this.autoDevLoopMaxMinutes = autoDevRuntimeConfig.autoDevLoopMaxMinutes;
    this.autoDevAutoCommit = autoDevRuntimeConfig.autoDevAutoCommit;
    this.autoDevAutoReleaseEnabled = autoDevRuntimeConfig.autoDevAutoReleaseEnabled;
    this.autoDevAutoReleasePush = autoDevRuntimeConfig.autoDevAutoReleasePush;
    this.autoDevMaxConsecutiveFailures = autoDevRuntimeConfig.autoDevMaxConsecutiveFailures;
    this.autoDevRunArchiveEnabled = autoDevRuntimeConfig.autoDevRunArchiveEnabled;
    this.autoDevRunArchiveDir = autoDevRuntimeConfig.autoDevRunArchiveDir;
    this.autoDevDetailedProgressDefaultEnabled = autoDevRuntimeConfig.autoDevDetailedProgressDefaultEnabled;
    this.autoDevStageOutputEchoDefaultEnabled = autoDevRuntimeConfig.autoDevStageOutputEchoDefaultEnabled;
    this.autoDevInitEnhancementEnabled = autoDevRuntimeConfig.autoDevInitEnhancementEnabled;
    this.autoDevInitEnhancementTimeoutMs = autoDevRuntimeConfig.autoDevInitEnhancementTimeoutMs;
    this.autoDevInitEnhancementMaxChars = autoDevRuntimeConfig.autoDevInitEnhancementMaxChars;
    const serviceRuntimeConfig = runResolveServiceRuntimeConfig(options);
    this.botNoticePrefix = serviceRuntimeConfig.botNoticePrefix;
    this.packageUpdateChecker = serviceRuntimeConfig.packageUpdateChecker;
    this.updateCheckTtlMs = serviceRuntimeConfig.updateCheckTtlMs;
    this.taskQueueRecoveryEnabled = serviceRuntimeConfig.taskQueueRecoveryEnabled;
    this.taskQueueRecoveryBatchLimit = serviceRuntimeConfig.taskQueueRecoveryBatchLimit;
    this.taskQueueRetryPolicy = serviceRuntimeConfig.taskQueueRetryPolicy;
    this.onApiTaskLifecycleEvent = options?.onApiTaskLifecycleEvent ?? null;
    const backendRuntimeConfig = runResolveBackendRuntimeConfig({
      options,
      executor,
    });
    this.executorFactory = backendRuntimeConfig.executorFactory;
    this.defaultBackendProfile = backendRuntimeConfig.defaultBackendProfile;
    this.backendModelRouter = backendRuntimeConfig.backendModelRouter;
    this.backendRuntimes.set(backendRuntimeConfig.defaultBackendRuntimeKey, backendRuntimeConfig.defaultBackendRuntimeBundle);
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

    return runSubmitApiTask(
      {
        startSessionQueueDrain: (sessionKey) => this.startSessionQueueDrain(sessionKey),
        emitApiTaskLifecycleEvent: (event) => this.emitApiTaskLifecycleEvent(event),
      },
      queueStore,
      input,
    );
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
    runBootstrapTaskQueueRecovery(
      {
        logger: this.logger,
        taskQueueRecoveryEnabled: this.taskQueueRecoveryEnabled,
        taskQueueRecoveryBatchLimit: this.taskQueueRecoveryBatchLimit,
        startSessionQueueDrain: (sessionKey) => this.startSessionQueueDrain(sessionKey),
      },
      queueStore,
    );
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
    await runHandleMessageInternal(
      runBuildHandleMessageInternalDepsFromRuntime({
        syncRuntimeHotConfig: this.syncRuntimeHotConfig.bind(this),
        buildSessionKey,
        markSessionRequestStarted: this.markSessionRequestStarted.bind(this),
        markSessionRequestFinished: this.markSessionRequestFinished.bind(this),
        tryHandleDirectStopCommand: this.tryHandleDirectStopCommand.bind(this),
        tryHandleUnlockedStatusCommand: this.tryHandleUnlockedStatusCommand.bind(this),
        getLock: this.getLock.bind(this),
        buildLockedMessageDispatchContext: this.buildLockedMessageDispatchContext.bind(this),
        startSessionQueueDrain: this.startSessionQueueDrain.bind(this),
      }),
      {
        message,
        receivedAt,
        options,
      },
    );
  }

  private async tryHandleDirectStopCommand(input: {
    message: InboundMessage;
    requestId: string;
    sessionKey: string;
  }): Promise<boolean> {
    const directCommand = parseControlCommand(input.message.text.trim());
    if (directCommand !== "stop") {
      return false;
    }
    if (this.stateStore.hasProcessedEvent(input.sessionKey, input.message.eventId)) {
      this.recordRequestMetrics("duplicate", 0, 0, 0);
      this.logger.debug("Duplicate stop command ignored", {
        requestId: input.requestId,
        eventId: input.message.eventId,
        sessionKey: input.sessionKey,
      });
      return true;
    }
    await this.handleStopCommand(input.sessionKey, input.message, input.requestId);
    this.stateStore.markEventProcessed(input.sessionKey, input.message.eventId);
    return true;
  }

  private async tryHandleUnlockedStatusCommand(input: {
    message: InboundMessage;
    requestId: string;
    sessionKey: string;
    receivedAt: number;
    options: {
      bypassQueue: boolean;
      forcedPrompt: string | null;
    };
  }): Promise<boolean> {
    if (input.options.bypassQueue || input.options.forcedPrompt !== null) {
      return false;
    }
    const queueWaitMs = Date.now() - input.receivedAt;
    const roomConfig = this.resolveRoomRuntimeConfig(input.message.conversationId);
    const route = this.routeMessage(input.message, input.sessionKey, roomConfig);
    return this.tryHandleNonBlockingStatusRoute({
      route,
      sessionKey: input.sessionKey,
      message: input.message,
      requestId: input.requestId,
      roomConfig,
      queueWaitMs,
    });
  }

  private buildLockedMessageDispatchContext(): Parameters<typeof executeLockedMessage>[0] {
    return runBuildLockedMessageDispatchContextFromRuntime({
      logger: this.logger,
      workflowEnabled: this.workflowRunner.isEnabled(),
      stateStore: this.stateStore,
      recordRequestMetrics: this.recordRequestMetrics.bind(this),
      resolveRoomRuntimeConfig: this.resolveRoomRuntimeConfig.bind(this),
      routeMessage: this.routeMessage.bind(this),
      controlHandlers: {
        handleControlCommand: this.handleControlCommand.bind(this),
        handleWorkflowStatusCommand: this.handleWorkflowStatusCommand.bind(this),
        handleAutoDevStatusCommand: this.handleAutoDevStatusCommand.bind(this),
        handleAutoDevProgressCommand: this.handleAutoDevProgressCommand.bind(this),
        handleAutoDevContentCommand: this.handleAutoDevContentCommand.bind(this),
        handleAutoDevSkillsCommand: this.handleAutoDevSkillsCommand.bind(this),
        handleAutoDevLoopStopCommand: this.handleAutoDevLoopStopCommand.bind(this),
        handleAutoDevReconcileCommand: this.handleAutoDevReconcileCommand.bind(this),
        handleAutoDevWorkdirCommand: this.handleAutoDevWorkdirCommand.bind(this),
        handleAutoDevInitCommand: this.handleAutoDevInitCommand.bind(this),
      },
      getTaskQueueStateStore: this.getTaskQueueStateStore.bind(this),
      rateLimiter: this.rateLimiter,
      sendNotice: this.channel.sendNotice.bind(this.channel),
      backendHandlers: {
        classifyBackendTaskType,
        resolveSessionBackendDecision: this.resolveSessionBackendDecision.bind(this),
        prepareBackendRuntimeForSession: this.prepareBackendRuntimeForSession.bind(this),
        sessionLastBackendDecisions: this.sessionLastBackendDecisions,
        recordBackendRouteDecision: this.recordBackendRouteDecision.bind(this),
        executeWorkflowRun: this.executeLockedWorkflowRun.bind(this),
        executeAutoDevRun: this.executeLockedAutoDevRun.bind(this),
        executeChatRun: this.executeLockedChatRun.bind(this),
      },
    });
  }

  private async executeLockedWorkflowRun(input: Parameters<typeof runExecuteLockedWorkflowRun>[1]): Promise<void> {
    await runExecuteLockedWorkflowRun(
      {
        buildAgentRunRequestContext: () => this.buildAgentRunRequestContext(),
        handleWorkflowRunCommand: (objective, sessionKey, message, requestId, workdir) =>
          this.handleWorkflowRunCommand(objective, sessionKey, message, requestId, workdir),
        sendWorkflowFailure: (conversationId, error) => this.sendWorkflowFailure(conversationId, error),
      },
      input,
    );
  }

  private async executeLockedAutoDevRun(input: Parameters<typeof runExecuteLockedAutoDevRun>[1]): Promise<void> {
    await runExecuteLockedAutoDevRun(
      {
        buildAgentRunRequestContext: () => this.buildAgentRunRequestContext(),
        handleAutoDevRunCommand: (taskId, sessionKey, message, requestId, workdir) =>
          this.handleAutoDevRunCommand(taskId, sessionKey, message, requestId, workdir),
        sendAutoDevFailure: (conversationId, error) => this.sendAutoDevFailure(conversationId, error),
      },
      input,
    );
  }

  private executeLockedChatRun(input: Parameters<typeof runExecuteLockedChatRun>[1]): Promise<void> {
    return runExecuteLockedChatRun(
      {
        buildChatRequestDispatchContext: () => this.buildChatRequestDispatchContext(),
      },
      input,
    );
  }

  private async tryHandleNonBlockingStatusRoute(input: {
    route: RouteDecision;
    sessionKey: string;
    message: InboundMessage;
    requestId: string;
    roomConfig: RoomRuntimeConfig;
    queueWaitMs: number;
  }): Promise<boolean> {
    return runExecuteNonBlockingStatusRouteFromRuntime(
      {
        logger: this.logger,
        workflowEnabled: this.workflowRunner.isEnabled(),
        hasProcessedEvent: this.stateStore.hasProcessedEvent.bind(this.stateStore),
        markEventProcessed: this.stateStore.markEventProcessed.bind(this.stateStore),
        recordRequestMetrics: this.recordRequestMetrics.bind(this),
        handleControlCommand: this.handleControlCommand.bind(this),
        handleWorkflowStatusCommand: this.handleWorkflowStatusCommand.bind(this),
        handleAutoDevStatusCommand: this.handleAutoDevStatusCommand.bind(this),
        handleAutoDevProgressCommand: this.handleAutoDevProgressCommand.bind(this),
        handleAutoDevContentCommand: this.handleAutoDevContentCommand.bind(this),
        handleAutoDevSkillsCommand: this.handleAutoDevSkillsCommand.bind(this),
        handleAutoDevLoopStopCommand: this.handleAutoDevLoopStopCommand.bind(this),
        handleAutoDevReconcileCommand: this.handleAutoDevReconcileCommand.bind(this),
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
        scheduleSessionQueueDrainAtNextRetry: (targetSessionKey, queueStore, now) =>
          this.scheduleSessionQueueDrainAtNextRetry(targetSessionKey, queueStore, now),
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
        emitApiTaskLifecycleEvent: (event) => this.emitApiTaskLifecycleEvent(event),
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
        scheduleSessionQueueDrainAtNextRetry: (targetSessionKey, queueStore, now) =>
          this.scheduleSessionQueueDrainAtNextRetry(targetSessionKey, queueStore, now),
        logger: this.logger,
      },
      sessionKey,
    );
  }

  private scheduleSessionQueueDrainAtNextRetry(
    sessionKey: string,
    queueStore: Pick<TaskQueueStateStore, "getNextPendingRetryAt">,
    now?: number,
  ): void {
    runScheduleSessionQueueDrainAtNextRetry(
      (targetSessionKey, nextRetryAt) => this.scheduleSessionQueueDrain(targetSessionKey, nextRetryAt),
      sessionKey,
      queueStore,
      now,
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
    await runSendQueuedTaskFailureNotice(
      {
        outputLanguage: this.outputLanguage,
        taskQueueRetryMaxAttempts: this.taskQueueRetryPolicy.maxAttempts,
        sendMessage: (targetConversationId, text) => this.channel.sendMessage(targetConversationId, text),
        logger: this.logger,
      },
      conversationId,
      input,
    );
  }

  private emitApiTaskLifecycleEvent(event: ApiTaskLifecycleEvent): void {
    if (!this.onApiTaskLifecycleEvent) {
      return;
    }
    try {
      this.onApiTaskLifecycleEvent(event);
    } catch (error) {
      this.logger.warn("API task lifecycle callback failed", {
        taskId: event.taskId,
        stage: event.stage,
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
    return runBuildControlCommandDispatchContextFromRuntime({
      sessionActiveWindowMs: this.sessionActiveWindowMs,
      botNoticePrefix: this.botNoticePrefix,
      outputLanguage: this.outputLanguage,
      stateStore: this.stateStore,
      clearSessionFromAllRuntimes: this.clearSessionFromAllRuntimes.bind(this),
      sessionBackendOverrides: this.sessionBackendOverrides,
      sessionBackendProfiles: this.sessionBackendProfiles,
      sessionLastBackendDecisions: this.sessionLastBackendDecisions,
      skipBridgeForNextPrompt: this.skipBridgeForNextPrompt,
      workflowSnapshots: this.workflowSnapshots,
      autoDevSnapshots: this.autoDevSnapshots,
      autoDevWorkdirOverrides: this.autoDevWorkdirOverrides,
      clearPersistedAutoDevWorkdirOverride: (targetSessionKey) =>
        this.clearPersistedAutoDevWorkdirOverride(targetSessionKey),
      autoDevDetailedProgressOverrides: this.autoDevDetailedProgressOverrides,
      workflowRoleSkillPolicyOverrides: this.workflowRoleSkillPolicyOverrides,
      pendingStopRequests: this.pendingStopRequests,
      pendingAutoDevLoopStopRequests: this.pendingAutoDevLoopStopRequests,
      activeAutoDevLoopSessions: this.activeAutoDevLoopSessions,
      packageUpdateChecker: this.packageUpdateChecker,
      formatMultimodalHelpStatus: this.formatMultimodalHelpStatus.bind(this),
      sendNotice: this.channel.sendNotice.bind(this.channel),
      handlers: {
        handleStatusCommand: this.sendStatusCommand.bind(this),
        handleStopCommand: this.handleStopCommand.bind(this),
        handleBackendCommand: this.handleBackendCommand.bind(this),
        handleDiagCommand: this.handleDiagCommand.bind(this),
        handleUpgradeCommand: this.handleUpgradeCommand.bind(this),
      },
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
    const effectiveWorkdir = this.resolveAutoDevWorkdir(sessionKey, workdir);
    await runSendAutoDevStatusCommand(
      this.buildStatusCommandDispatchContext(),
      {
        sessionKey,
        message,
        workdir: effectiveWorkdir,
      },
    );
  }

  private buildStatusCommandDispatchContext() {
    return runBuildStatusCommandDispatchContextFromRuntime({
      config: {
        botNoticePrefix: this.botNoticePrefix,
        outputLanguage: this.outputLanguage,
        groupDirectModeEnabled: this.groupDirectModeEnabled,
        updateCheckTtlMs: this.updateCheckTtlMs,
        cliCompat: this.cliCompat,
        workflowRunner: this.workflowRunner,
        autoDevDetailedProgressDefaultEnabled: this.autoDevDetailedProgressDefaultEnabled,
        autoDevStageOutputEchoDefaultEnabled: this.autoDevStageOutputEchoDefaultEnabled,
        workflowPlanContextMaxChars: this.workflowPlanContextMaxChars,
        workflowOutputContextMaxChars: this.workflowOutputContextMaxChars,
        workflowFeedbackContextMaxChars: this.workflowFeedbackContextMaxChars,
        autoDevLoopMaxRuns: this.autoDevLoopMaxRuns,
        autoDevLoopMaxMinutes: this.autoDevLoopMaxMinutes,
        autoDevAutoCommit: this.autoDevAutoCommit,
        autoDevAutoReleaseEnabled: this.autoDevAutoReleaseEnabled,
        autoDevAutoReleasePush: this.autoDevAutoReleasePush,
        autoDevMaxConsecutiveFailures: this.autoDevMaxConsecutiveFailures,
        autoDevRunArchiveEnabled: this.autoDevRunArchiveEnabled,
        autoDevRunArchiveDir: this.autoDevRunArchiveDir,
        autoDevInitEnhancementEnabled: this.autoDevInitEnhancementEnabled,
        autoDevInitEnhancementTimeoutMs: this.autoDevInitEnhancementTimeoutMs,
        autoDevInitEnhancementMaxChars: this.autoDevInitEnhancementMaxChars,
      },
      snapshots: {
        stateStore: this.stateStore,
        workflowSnapshots: this.workflowSnapshots,
        autoDevSnapshots: this.autoDevSnapshots,
        activeAutoDevLoopSessions: this.activeAutoDevLoopSessions,
        pendingAutoDevLoopStopRequests: this.pendingAutoDevLoopStopRequests,
        pendingStopRequests: this.pendingStopRequests,
        sessionBackendOverrides: this.sessionBackendOverrides,
        sessionLastBackendDecisions: this.sessionLastBackendDecisions,
      },
      actions: {
        resolveRoomRuntimeConfig: this.resolveRoomRuntimeConfig.bind(this),
        metrics: this.metrics,
        runningExecutions: this.runningExecutions,
        rateLimiter: this.rateLimiter,
        getBackendRuntimeStats: this.getBackendRuntimeStats.bind(this),
        isAutoDevDetailedProgressEnabled: this.isAutoDevDetailedProgressEnabled.bind(this),
        isAutoDevStageOutputEchoEnabled: this.isAutoDevStageOutputEchoEnabled.bind(this),
        listWorkflowDiagRunsBySession: this.listWorkflowDiagRunsBySession.bind(this),
        listWorkflowDiagEvents: this.listWorkflowDiagEvents.bind(this),
        buildWorkflowRoleSkillStatus: this.buildWorkflowRoleSkillStatus.bind(this),
        packageUpdateChecker: this.packageUpdateChecker,
        getLatestUpgradeRun: this.getLatestUpgradeRun.bind(this),
        getRecentUpgradeRuns: this.getRecentUpgradeRuns.bind(this),
        getUpgradeRunStats: this.getUpgradeRunStats.bind(this),
        getUpgradeExecutionLockSnapshot: this.getUpgradeExecutionLockSnapshot.bind(this),
        resolveSessionBackendStatusProfile: this.resolveSessionBackendStatusProfile.bind(this),
        formatBackendToolLabel: this.formatBackendToolLabel.bind(this),
        sendNotice: this.channel.sendNotice.bind(this.channel),
      },
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

  private async handleAutoDevContentCommand(
    sessionKey: string,
    message: InboundMessage,
    mode: "status" | "on" | "off",
  ): Promise<void> {
    await runAutoDevContentCommand(
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

  private async handleAutoDevReconcileCommand(
    sessionKey: string,
    message: InboundMessage,
    workdir: string,
  ): Promise<void> {
    const effectiveWorkdir = this.resolveAutoDevWorkdir(sessionKey, workdir);
    await runAutoDevReconcileCommand(
      this.buildAutoDevControlCommandDeps(),
      {
        sessionKey,
        message,
        workdir: effectiveWorkdir,
      },
    );
  }

  private async handleAutoDevWorkdirCommand(
    sessionKey: string,
    message: InboundMessage,
    mode: "status" | "set" | "clear",
    targetPath: string | null,
    roomWorkdir: string,
  ): Promise<void> {
    await runAutoDevWorkdirCommand(
      this.buildAutoDevControlCommandDeps(),
      {
        sessionKey,
        message,
        mode,
        path: targetPath,
        roomWorkdir,
      },
    );
  }

  private async handleAutoDevInitCommand(
    sessionKey: string,
    message: InboundMessage,
    targetPath: string | null,
    from: string | null,
    dryRun: boolean,
    force: boolean,
    roomWorkdir: string,
  ): Promise<void> {
    await runAutoDevInitCommand(
      this.buildAutoDevControlCommandDeps(),
      {
        sessionKey,
        message,
        path: targetPath,
        from,
        dryRun,
        force,
        roomWorkdir,
      },
    );
  }

  private buildAutoDevControlCommandDeps(): AutoDevControlCommandDeps {
    return {
      autoDevDetailedProgressDefaultEnabled: this.autoDevDetailedProgressDefaultEnabled,
      autoDevStageOutputEchoDefaultEnabled: this.autoDevStageOutputEchoDefaultEnabled,
      outputLanguage: this.outputLanguage,
      pendingAutoDevLoopStopRequests: this.pendingAutoDevLoopStopRequests,
      activeAutoDevLoopSessions: this.activeAutoDevLoopSessions,
      isAutoDevDetailedProgressEnabled: (targetSessionKey) => this.isAutoDevDetailedProgressEnabled(targetSessionKey),
      setAutoDevDetailedProgressEnabled: (targetSessionKey, enabled) =>
        this.setAutoDevDetailedProgressEnabled(targetSessionKey, enabled),
      isAutoDevStageOutputEchoEnabled: (targetSessionKey) => this.isAutoDevStageOutputEchoEnabled(targetSessionKey),
      setAutoDevStageOutputEchoEnabled: (targetSessionKey, enabled) =>
        this.setAutoDevStageOutputEchoEnabled(targetSessionKey, enabled),
      setWorkflowRoleSkillPolicyOverride: (targetSessionKey, next) =>
        this.setWorkflowRoleSkillPolicyOverride(targetSessionKey, next),
      buildWorkflowRoleSkillStatus: (targetSessionKey) => this.buildWorkflowRoleSkillStatus(targetSessionKey),
      getAutoDevWorkdirOverride: (targetSessionKey) => this.getAutoDevWorkdirOverride(targetSessionKey),
      setAutoDevWorkdirOverride: (targetSessionKey, targetWorkdir) =>
        this.setAutoDevWorkdirOverride(targetSessionKey, targetWorkdir),
      clearAutoDevWorkdirOverride: (targetSessionKey) => this.clearAutoDevWorkdirOverride(targetSessionKey),
      runAutoDevInitEnhancement: (input) => this.runAutoDevInitEnhancement(input),
      listWorkflowDiagRunsBySession: (kind, sessionKey, limit) =>
        this.listWorkflowDiagRunsBySession(kind, sessionKey, limit),
      sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
    };
  }

  private async runAutoDevInitEnhancement(
    input: AutoDevInitEnhancementInput,
  ): Promise<AutoDevInitEnhancementResult> {
    if (!this.autoDevInitEnhancementEnabled) {
      return {
        applied: false,
        summary: "disabled by AUTODEV_INIT_ENHANCEMENT_ENABLED=false",
      };
    }
    const roleSkillPolicy = this.resolveWorkflowRoleSkillPolicy(input.sessionKey);
    const plannerSkillPrompt = this.workflowRoleSkillCatalog.buildPrompt({
      role: "planner",
      stage: "planner",
      round: 0,
      policy: roleSkillPolicy,
    });
    const prompt = this.buildAutoDevInitEnhancementPrompt(input, plannerSkillPrompt.text);
    const backendDecision = this.resolveSessionBackendDecision({
      sessionKey: input.sessionKey,
      message: input.message,
      taskType: "autodev_run",
      routePrompt: "/autodev init",
    });
    const backendRuntime = this.prepareBackendRuntimeForSession(input.sessionKey, backendDecision.profile);
    this.sessionLastBackendDecisions.set(input.sessionKey, backendDecision);
    this.recordBackendRouteDecision({
      sessionKey: input.sessionKey,
      message: input.message,
      taskType: "autodev_run",
      decision: backendDecision,
    });

    const previousCodexSessionId = this.stateStore.getCodexSessionId(input.sessionKey);
    const executionResult = await backendRuntime.executor.execute(prompt, previousCodexSessionId, undefined, {
      workdir: input.workdir,
      timeoutMs: this.autoDevInitEnhancementTimeoutMs,
    });
    this.stateStore.setCodexSessionId(input.sessionKey, executionResult.sessionId);
    return this.parseAutoDevInitEnhancementResult(executionResult.reply);
  }

  private buildAutoDevInitEnhancementPrompt(
    input: AutoDevInitEnhancementInput,
    plannerSkillPrompt: string | null,
  ): string {
    const sourceDocsRaw =
      input.sourceDocs.length > 0
        ? input.sourceDocs.map((doc) => `- ${doc}`).join("\n")
        : "- (none; rely on workspace docs)";
    const sourceDocs = this.truncateInitEnhancementPromptSection(sourceDocsRaw);
    const skillPrompt = this.truncateInitEnhancementPromptSection(plannerSkillPrompt ?? "");
    const skillBlock = skillPrompt ? `${skillPrompt}\n\n` : "";
    return [
      "You are executing Stage B for `/autodev init` in this repository.",
      "",
      "Goal:",
      "- Improve `REQUIREMENTS.md` and `TASK_LIST.md` from generated baseline using available project design documents.",
      "",
      "Hard constraints:",
      "- Edit only `REQUIREMENTS.md` and `TASK_LIST.md`.",
      "- Keep markdown structure valid and concise.",
      "- `TASK_LIST.md` must remain parseable as task table rows for AutoDev.",
      "- Keep clear dependencies and executable acceptance criteria.",
      "- If uncertain, keep baseline content; do not invent external facts.",
      "",
      "Focus source documents:",
      sourceDocs,
      "",
      "Target files:",
      `- ${input.requirementsPath}`,
      `- ${input.taskListPath}`,
      "",
      "Return format (strict):",
      "INIT_ENHANCEMENT: APPLIED | SKIPPED",
      "SUMMARY: <one line>",
      "",
      skillBlock,
      "Now perform the file edits directly in workspace and return the strict format.",
    ]
      .join("\n")
      .trim();
  }

  private truncateInitEnhancementPromptSection(text: string): string {
    const normalized = text.trim();
    if (!normalized) {
      return "";
    }
    if (normalized.length <= this.autoDevInitEnhancementMaxChars) {
      return normalized;
    }
    const sliced = normalized.slice(0, Math.max(0, this.autoDevInitEnhancementMaxChars)).trimEnd();
    return `${sliced}\n... [truncated by AUTODEV_INIT_ENHANCEMENT_MAX_CHARS=${this.autoDevInitEnhancementMaxChars}]`;
  }

  private parseAutoDevInitEnhancementResult(reply: string): AutoDevInitEnhancementResult {
    const trimmed = reply.trim();
    const statusMatch = trimmed.match(/INIT_ENHANCEMENT:\s*(APPLIED|SKIPPED)/i);
    const summaryMatch = trimmed.match(/SUMMARY:\s*(.+)/i);
    const summary = summaryMatch?.[1]?.trim() || trimmed.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
    return {
      applied: (statusMatch?.[1] ?? "APPLIED").toUpperCase() === "APPLIED",
      summary,
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
    const effectiveWorkdir = this.resolveAutoDevWorkdir(sessionKey, workdir);
    await runHandleAutoDevRunCommand(
      this.buildAutoDevRunCommandDispatchContext(),
      {
        taskId,
        sessionKey,
        message,
        requestId,
        workdir: effectiveWorkdir,
        runContext,
      },
    );
  }

  private resolveAutoDevWorkdir(sessionKey: string, roomWorkdir: string): string {
    return this.getAutoDevWorkdirOverride(sessionKey) ?? roomWorkdir;
  }

  private getAutoDevWorkdirOverride(sessionKey: string): string | null {
    const inMemory = this.autoDevWorkdirOverrides.get(sessionKey);
    if (inMemory) {
      return inMemory;
    }
    const persisted = this.readPersistedAutoDevWorkdirOverride(sessionKey);
    if (persisted) {
      this.autoDevWorkdirOverrides.set(sessionKey, persisted);
      return persisted;
    }
    return null;
  }

  private setAutoDevWorkdirOverride(sessionKey: string, workdir: string): void {
    this.autoDevWorkdirOverrides.set(sessionKey, workdir);
    const stateStoreWithAutoDevWorkdir = this.stateStore as unknown as {
      setAutoDevWorkdirOverride?: (targetSessionKey: string, targetWorkdir: string) => void;
    };
    if (typeof stateStoreWithAutoDevWorkdir.setAutoDevWorkdirOverride === "function") {
      stateStoreWithAutoDevWorkdir.setAutoDevWorkdirOverride(sessionKey, workdir);
    }
  }

  private clearAutoDevWorkdirOverride(sessionKey: string): void {
    this.autoDevWorkdirOverrides.delete(sessionKey);
    this.clearPersistedAutoDevWorkdirOverride(sessionKey);
  }

  private readPersistedAutoDevWorkdirOverride(sessionKey: string): string | null {
    const stateStoreWithAutoDevWorkdir = this.stateStore as unknown as {
      getAutoDevWorkdirOverride?: (targetSessionKey: string) => string | null;
    };
    if (typeof stateStoreWithAutoDevWorkdir.getAutoDevWorkdirOverride !== "function") {
      return null;
    }
    return stateStoreWithAutoDevWorkdir.getAutoDevWorkdirOverride(sessionKey);
  }

  private clearPersistedAutoDevWorkdirOverride(sessionKey: string): void {
    const stateStoreWithAutoDevWorkdir = this.stateStore as unknown as {
      clearAutoDevWorkdirOverride?: (targetSessionKey: string) => void;
    };
    if (typeof stateStoreWithAutoDevWorkdir.clearAutoDevWorkdirOverride === "function") {
      stateStoreWithAutoDevWorkdir.clearAutoDevWorkdirOverride(sessionKey);
    }
  }

  private buildAutoDevRunCommandDispatchContext(): Parameters<typeof runHandleAutoDevRunCommand>[0] {
    return runBuildAutoDevRunCommandDispatchContextFromRuntime({
      logger: this.logger,
      config: {
        autoDevLoopMaxRuns: this.autoDevLoopMaxRuns,
        autoDevLoopMaxMinutes: this.autoDevLoopMaxMinutes,
        autoDevAutoCommit: this.autoDevAutoCommit,
        autoDevAutoReleaseEnabled: this.autoDevAutoReleaseEnabled,
        autoDevAutoReleasePush: this.autoDevAutoReleasePush,
        autoDevMaxConsecutiveFailures: this.autoDevMaxConsecutiveFailures,
        autoDevRunArchiveEnabled: this.autoDevRunArchiveEnabled,
        autoDevRunArchiveDir: this.autoDevRunArchiveDir,
        outputLanguage: this.outputLanguage,
      },
      state: {
        pendingAutoDevLoopStopRequests: this.pendingAutoDevLoopStopRequests,
        activeAutoDevLoopSessions: this.activeAutoDevLoopSessions,
        autoDevFailureStreaks: this.autoDevFailureStreaks,
      },
      hooks: {
        consumePendingStopRequest: this.consumePendingStopRequest.bind(this),
        consumePendingAutoDevLoopStopRequest: this.consumePendingAutoDevLoopStopRequest.bind(this),
        setAutoDevSnapshot: this.setAutoDevSnapshot.bind(this),
        channelSendNotice: this.channel.sendNotice.bind(this.channel),
        beginWorkflowDiagRun: this.beginWorkflowDiagRun.bind(this),
        appendWorkflowDiagEvent: this.appendWorkflowDiagEvent.bind(this),
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
        listWorkflowDiagRunsBySession: (kind, sessionKey, limit) =>
          this.listWorkflowDiagRunsBySession(kind, sessionKey, limit),
        listWorkflowDiagEvents: (runId, limit) => this.listWorkflowDiagEvents(runId, limit),
        recordAutoDevGitCommit: this.recordAutoDevGitCommit.bind(this),
      },
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
    return runBuildChatRequestDispatchContextFromRuntime({
      logger: this.logger,
      outputLanguage: this.outputLanguage,
      sessionActiveWindowMs: this.sessionActiveWindowMs,
      cliCompatEnabled: this.cliCompat.enabled,
      cliCompatPassThroughEvents: this.cliCompat.passThroughEvents,
      stateStore: this.stateStore,
      skipBridgeForNextPrompt: this.skipBridgeForNextPrompt,
      mediaMetrics: this.mediaMetrics,
      runningExecutions: this.runningExecutions,
      consumePendingStopRequest: (targetSessionKey) => this.consumePendingStopRequest(targetSessionKey),
      persistRuntimeMetricsSnapshot: () => this.persistRuntimeMetricsSnapshot(),
      recordRequestMetrics: (outcome, queueMs, execMs, sendMs) =>
        this.recordRequestMetrics(outcome, queueMs, execMs, sendMs),
      cliCompatRecorder: this.cliCompatRecorder,
      contextBridgeHistoryLimit: this.contextBridgeHistoryLimit,
      contextBridgeMaxChars: this.contextBridgeMaxChars,
      transcribeAudioAttachments: (targetMessage, targetRequestId, targetSessionKey) =>
        this.transcribeAudioAttachments(targetMessage, targetRequestId, targetSessionKey),
      prepareImageAttachments: (targetMessage, targetRequestId, targetSessionKey) =>
        this.prepareImageAttachments(targetMessage, targetRequestId, targetSessionKey),
      prepareDocumentAttachments: (targetMessage, targetRequestId, targetSessionKey) =>
        this.prepareDocumentAttachments(targetMessage, targetRequestId, targetSessionKey),
      sendNotice: (conversationId, text) => this.channel.sendNotice(conversationId, text),
      sendMessage: (conversationId, text, options) => this.channel.sendMessage(conversationId, text, options),
      startTypingHeartbeat: (conversationId) => this.startTypingHeartbeat(conversationId),
      handleProgress: (...args) => this.forwardChatRequestProgress(...args),
      finishProgress: (ctx, summary) => this.finishProgress(ctx, summary),
      formatBackendToolLabel: (profile) => this.formatBackendToolLabel(profile),
    });
  }

  private forwardChatRequestProgress(
    ...args: Parameters<Parameters<typeof executeChatRequest>[0]["handleProgress"]>
  ): Promise<void> {
    return this.handleProgress(...args);
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
      outputLanguage: this.outputLanguage,
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
      isAutoDevStageOutputEchoEnabled: (targetSessionKey) => this.isAutoDevStageOutputEchoEnabled(targetSessionKey),
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
        outputLanguage: this.outputLanguage,
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
        outputLanguage: this.outputLanguage,
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
      sessionLastBackendDecisions: this.sessionLastBackendDecisions,
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
      outputLanguage: this.outputLanguage,
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
    if (config.outputLanguage) {
      this.outputLanguage = config.outputLanguage;
    }
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

  private resolveManualBackendProfile(input: {
    provider: "codex" | "claude";
    model?: string | null;
  }): BackendModelRouteProfile {
    return runResolveManualBackendProfile(input, this.defaultBackendProfile);
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

  private isAutoDevStageOutputEchoEnabled(sessionKey: string): boolean {
    return this.autoDevStageOutputEchoOverrides.get(sessionKey) ?? this.autoDevStageOutputEchoDefaultEnabled;
  }

  private setAutoDevStageOutputEchoEnabled(sessionKey: string, enabled: boolean): void {
    if (enabled === this.autoDevStageOutputEchoDefaultEnabled) {
      this.autoDevStageOutputEchoOverrides.delete(sessionKey);
      return;
    }
    this.autoDevStageOutputEchoOverrides.set(sessionKey, enabled);
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
      outputLanguage: this.outputLanguage,
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
    return runBuildBackendCommandDispatchContextFromRuntime({
      outputLanguage: this.outputLanguage,
      sessionActiveWindowMs: this.sessionActiveWindowMs,
      canCreateBackendRuntime: Boolean(this.executorFactory),
      state: {
        sessionBackendOverrides: this.sessionBackendOverrides,
        sessionBackendProfiles: this.sessionBackendProfiles,
        sessionLastBackendDecisions: this.sessionLastBackendDecisions,
        workflowSnapshots: this.workflowSnapshots,
        autoDevSnapshots: this.autoDevSnapshots,
        runningExecutions: this.runningExecutions,
        stateStore: this.stateStore,
      },
      hooks: {
        resolveSessionBackendStatusProfile: this.resolveSessionBackendStatusProfile.bind(this),
        formatBackendToolLabel: this.formatBackendToolLabel.bind(this),
        resolveManualBackendProfile: this.resolveManualBackendProfile.bind(this),
        serializeBackendProfile: this.serializeBackendProfile.bind(this),
        hasBackendRuntime: this.hasBackendRuntime.bind(this),
        ensureBackendRuntime: this.ensureBackendRuntime.bind(this),
        clearSessionFromAllRuntimes: this.clearSessionFromAllRuntimes.bind(this),
        sendNotice: this.channel.sendNotice.bind(this.channel),
      },
    });
  }

  private formatBackendToolLabel(profile: BackendModelRouteProfile = this.defaultBackendProfile): string {
    return formatBackendRouteProfile(profile);
  }

  private formatMultimodalHelpStatus(): string {
    const imageEnabled = this.cliCompat.fetchMedia ? "on" : "off";
    const audioEnabled = this.audioTranscriber.isEnabled() ? "on" : "off";
    const mimeText = formatMimeAllowlist(this.cliCompat.imageAllowedMimeTypes);
    const backendImageSupport =
      this.defaultBackendProfile.provider === "codex" || this.defaultBackendProfile.provider === "claude"
        ? "yes"
        : "unknown";
    if (this.outputLanguage === "en") {
      return `image=${imageEnabled}(max=${this.cliCompat.imageMaxCount},<=${formatByteSize(
        this.cliCompat.imageMaxBytes,
      )},mime=${mimeText}); audio=${audioEnabled}; backendImageSupport=${backendImageSupport}`;
    }
    return `图片=${imageEnabled}(max=${this.cliCompat.imageMaxCount},<=${formatByteSize(this.cliCompat.imageMaxBytes)},mime=${mimeText})；语音=${audioEnabled}；后端图片支持=${backendImageSupport}`;
  }

  private async handleDiagCommand(message: InboundMessage): Promise<void> {
    await runSendDiagCommand(this.buildDiagCommandDispatchContext(), message);
  }

  private buildDiagCommandDispatchContext(): Parameters<typeof runSendDiagCommand>[0] {
    return runBuildDiagCommandDispatchContextFromRuntime({
      outputLanguage: this.outputLanguage,
      botNoticePrefix: this.botNoticePrefix,
      processStartedAtIso: this.processStartedAtIso,
      defaultBackendProfile: this.defaultBackendProfile,
      autoDevConfig: {
        loopMaxRuns: this.autoDevLoopMaxRuns,
        loopMaxMinutes: this.autoDevLoopMaxMinutes,
        autoCommit: this.autoDevAutoCommit,
        autoReleaseEnabled: this.autoDevAutoReleaseEnabled,
        autoReleasePush: this.autoDevAutoReleasePush,
        maxConsecutiveFailures: this.autoDevMaxConsecutiveFailures,
      },
      runningExecutions: this.runningExecutions,
      cliCompat: this.cliCompat,
      audioTranscriber: this.audioTranscriber,
      packageUpdateChecker: this.packageUpdateChecker,
      formatBackendToolLabel: this.formatBackendToolLabel.bind(this),
      mediaMetrics: this.mediaMetrics,
      listWorkflowDiagRuns: this.listWorkflowDiagRuns.bind(this),
      listWorkflowDiagEvents: this.listWorkflowDiagEvents.bind(this),
      autoDevSnapshots: this.autoDevSnapshots,
      listAutoDevGitCommitRecords: this.listAutoDevGitCommitRecords.bind(this),
      listRecentAutoDevGitCommitEventSummaries: this.listRecentAutoDevGitCommitEventSummaries.bind(this),
      resolveSessionBackendStatusProfile: this.resolveSessionBackendStatusProfile.bind(this),
      sessionBackendOverrides: this.sessionBackendOverrides,
      sessionLastBackendDecisions: this.sessionLastBackendDecisions,
      backendModelRouter: this.backendModelRouter,
      listBackendRouteDiagRecords: this.listBackendRouteDiagRecords.bind(this),
      getTaskQueueStateStore: this.getTaskQueueStateStore.bind(this),
      listTaskQueueFailureArchive: this.listTaskQueueFailureArchive.bind(this),
      getRecentUpgradeRuns: this.getRecentUpgradeRuns.bind(this),
      getUpgradeExecutionLockSnapshot: this.getUpgradeExecutionLockSnapshot.bind(this),
      getUpgradeRunStats: this.getUpgradeRunStats.bind(this),
      sendNotice: this.channel.sendNotice.bind(this.channel),
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
