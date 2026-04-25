import type { PackageUpdateStatus } from "../package-update-checker";
import type { BackendModelRouteProfile } from "../routing/backend-model-router";
import type { RateLimiterSnapshot } from "../rate-limiter";
import type { UpgradeExecutionLockRecord, UpgradeRunRecord, UpgradeRunStats } from "../store/state-store";
import type { AutoDevRunSnapshot } from "./autodev-runner";
import {
  sendAutoDevStatusCommand as runSendAutoDevStatusCommand,
  sendStatusCommand as runSendStatusCommand,
} from "./status-command-dispatch";
import type { SessionBackendDecision, SessionBackendOverride } from "./orchestrator-types";
import type { WorkflowDiagEventRecord, WorkflowDiagRunRecord } from "./workflow-diag";
import type { WorkflowRunSnapshot } from "../workflow/multi-agent-workflow";

type StatusCommandDispatchContext = Parameters<typeof runSendStatusCommand>[0] &
  Parameters<typeof runSendAutoDevStatusCommand>[0];

interface StatusCommandContextInput {
  botNoticePrefix: string;
  outputLanguage: StatusCommandDispatchContext["outputLanguage"];
  matrixUserId: string;
  groupDirectModeEnabled: boolean;
  updateCheckTtlMs: number;
  cliCompatEnabled: boolean;
  workflowEnabled: boolean;
  autoDevDetailedProgressDefaultEnabled: boolean;
  autoDevStageOutputEchoDefaultEnabled: boolean;
  workflowPlanContextMaxChars: number | null;
  workflowOutputContextMaxChars: number | null;
  workflowFeedbackContextMaxChars: number | null;
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevAutoReleaseEnabled: boolean;
  autoDevAutoReleasePush: boolean;
  autoDevMaxConsecutiveFailures: number;
  autoDevRunArchiveEnabled: boolean;
  autoDevRunArchiveDir: string;
  autoDevValidationStrict: boolean;
  autoDevSecondaryReviewEnabled: boolean;
  autoDevSecondaryReviewTarget: string;
  autoDevSecondaryReviewRequireGatePassed: boolean;
  autoDevInitEnhancementEnabled: boolean;
  autoDevInitEnhancementTimeoutMs: number;
  autoDevInitEnhancementMaxChars: number;
  stateStore: {
    getSessionStatus: (sessionKey: string) => {
      isActive: boolean;
      activeUntil: string | null;
      hasCodexSession: boolean;
    };
    getCodexSessionWorkdir?: (sessionKey: string) => string | null;
  };
  resolveRoomRuntimeConfig: (conversationId: string) => {
    source: "default" | "room";
    enabled: boolean;
    triggerPolicy: {
      allowMention: boolean;
      allowReply: boolean;
      allowActiveWindow: boolean;
      allowPrefix: boolean;
    };
    workdir: string;
  };
  getRuntimeMetricsSnapshot: () => {
    activeExecutions: number;
    total: number;
    success: number;
    failed: number;
    timeout: number;
    cancelled: number;
    rateLimited: number;
    avgQueueMs: number;
    avgExecMs: number;
    avgSendMs: number;
  };
  getRateLimiterSnapshot: () => RateLimiterSnapshot;
  getBackendRuntimeStats: () => { workerCount: number; runningCount: number };
  workflowSnapshots: Map<string, WorkflowRunSnapshot>;
  autoDevSnapshots: Map<string, AutoDevRunSnapshot>;
  activeAutoDevLoopSessions: Set<string>;
  pendingAutoDevLoopStopRequests: Set<string>;
  pendingStopRequests: Set<string>;
  isAutoDevDetailedProgressEnabled: (sessionKey: string) => boolean;
  isAutoDevStageOutputEchoEnabled: (sessionKey: string) => boolean;
  listWorkflowDiagRunsBySession: (kind: "autodev", sessionKey: string, limit: number) => WorkflowDiagRunRecord[];
  listWorkflowDiagEvents: (runId: string, limit?: number) => WorkflowDiagEventRecord[];
  buildWorkflowRoleSkillStatus: (sessionKey: string) => {
    enabled: boolean;
    mode: string;
    maxChars: number;
    override: string;
    loaded: string;
  };
  getPackageUpdateStatus: () => Promise<PackageUpdateStatus>;
  getLatestUpgradeRun: () => UpgradeRunRecord | null;
  getRecentUpgradeRuns: (limit: number) => UpgradeRunRecord[];
  getUpgradeRunStats: () => UpgradeRunStats;
  getUpgradeExecutionLockSnapshot: () => UpgradeExecutionLockRecord | null;
  resolveSessionBackendStatusProfile: (sessionKey: string) => BackendModelRouteProfile;
  sessionBackendOverrides: Map<string, SessionBackendOverride>;
  sessionLastBackendDecisions: Map<string, SessionBackendDecision>;
  formatBackendToolLabel: (profile: BackendModelRouteProfile) => string;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

interface StatusCommandRuntimeConfigInput {
  botNoticePrefix: string;
  outputLanguage: StatusCommandDispatchContext["outputLanguage"];
  matrixUserId: string;
  groupDirectModeEnabled: boolean;
  updateCheckTtlMs: number;
  cliCompat: { enabled: boolean };
  workflowRunner: { isEnabled: () => boolean };
  autoDevDetailedProgressDefaultEnabled: boolean;
  autoDevStageOutputEchoDefaultEnabled: boolean;
  workflowPlanContextMaxChars: number | null;
  workflowOutputContextMaxChars: number | null;
  workflowFeedbackContextMaxChars: number | null;
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevAutoReleaseEnabled: boolean;
  autoDevAutoReleasePush: boolean;
  autoDevMaxConsecutiveFailures: number;
  autoDevRunArchiveEnabled: boolean;
  autoDevRunArchiveDir: string;
  autoDevValidationStrict: boolean;
  autoDevSecondaryReviewEnabled: boolean;
  autoDevSecondaryReviewTarget: string;
  autoDevSecondaryReviewRequireGatePassed: boolean;
  autoDevInitEnhancementEnabled: boolean;
  autoDevInitEnhancementTimeoutMs: number;
  autoDevInitEnhancementMaxChars: number;
}

interface StatusCommandRuntimeSnapshotInput {
  stateStore: StatusCommandContextInput["stateStore"];
  workflowSnapshots: Map<string, WorkflowRunSnapshot>;
  autoDevSnapshots: Map<string, AutoDevRunSnapshot>;
  activeAutoDevLoopSessions: Set<string>;
  pendingAutoDevLoopStopRequests: Set<string>;
  pendingStopRequests: Set<string>;
  sessionBackendOverrides: Map<string, SessionBackendOverride>;
  sessionLastBackendDecisions: Map<string, SessionBackendDecision>;
}

interface StatusCommandRuntimeActionInput {
  resolveRoomRuntimeConfig: StatusCommandContextInput["resolveRoomRuntimeConfig"];
  metrics: { snapshot: (activeExecutions: number) => ReturnType<StatusCommandContextInput["getRuntimeMetricsSnapshot"]> };
  runningExecutions: { size: number };
  rateLimiter: { snapshot: () => RateLimiterSnapshot };
  getBackendRuntimeStats: StatusCommandContextInput["getBackendRuntimeStats"];
  isAutoDevDetailedProgressEnabled: StatusCommandContextInput["isAutoDevDetailedProgressEnabled"];
  isAutoDevStageOutputEchoEnabled: StatusCommandContextInput["isAutoDevStageOutputEchoEnabled"];
  listWorkflowDiagRunsBySession: StatusCommandContextInput["listWorkflowDiagRunsBySession"];
  listWorkflowDiagEvents: StatusCommandContextInput["listWorkflowDiagEvents"];
  buildWorkflowRoleSkillStatus: StatusCommandContextInput["buildWorkflowRoleSkillStatus"];
  packageUpdateChecker: { getStatus: () => Promise<PackageUpdateStatus> };
  getLatestUpgradeRun: StatusCommandContextInput["getLatestUpgradeRun"];
  getRecentUpgradeRuns: StatusCommandContextInput["getRecentUpgradeRuns"];
  getUpgradeRunStats: StatusCommandContextInput["getUpgradeRunStats"];
  getUpgradeExecutionLockSnapshot: StatusCommandContextInput["getUpgradeExecutionLockSnapshot"];
  resolveSessionBackendStatusProfile: StatusCommandContextInput["resolveSessionBackendStatusProfile"];
  formatBackendToolLabel: StatusCommandContextInput["formatBackendToolLabel"];
  sendNotice: StatusCommandContextInput["sendNotice"];
}

interface StatusCommandRuntimeContextInput {
  config: StatusCommandRuntimeConfigInput;
  snapshots: StatusCommandRuntimeSnapshotInput;
  actions: StatusCommandRuntimeActionInput;
}

export function buildStatusCommandDispatchContext(input: StatusCommandContextInput): StatusCommandDispatchContext {
  return {
    botNoticePrefix: input.botNoticePrefix,
    outputLanguage: input.outputLanguage,
    matrixUserId: input.matrixUserId,
    groupDirectModeEnabled: input.groupDirectModeEnabled,
    updateCheckTtlMs: input.updateCheckTtlMs,
    cliCompatEnabled: input.cliCompatEnabled,
    workflowEnabled: input.workflowEnabled,
    autoDevDetailedProgressDefaultEnabled: input.autoDevDetailedProgressDefaultEnabled,
    autoDevStageOutputEchoDefaultEnabled: input.autoDevStageOutputEchoDefaultEnabled,
    workflowPlanContextMaxChars: input.workflowPlanContextMaxChars,
    workflowOutputContextMaxChars: input.workflowOutputContextMaxChars,
    workflowFeedbackContextMaxChars: input.workflowFeedbackContextMaxChars,
    autoDevLoopMaxRuns: input.autoDevLoopMaxRuns,
    autoDevLoopMaxMinutes: input.autoDevLoopMaxMinutes,
    autoDevAutoCommit: input.autoDevAutoCommit,
    autoDevAutoReleaseEnabled: input.autoDevAutoReleaseEnabled,
    autoDevAutoReleasePush: input.autoDevAutoReleasePush,
    autoDevMaxConsecutiveFailures: input.autoDevMaxConsecutiveFailures,
    autoDevRunArchiveEnabled: input.autoDevRunArchiveEnabled,
    autoDevRunArchiveDir: input.autoDevRunArchiveDir,
    autoDevValidationStrict: input.autoDevValidationStrict,
    autoDevSecondaryReviewEnabled: input.autoDevSecondaryReviewEnabled,
    autoDevSecondaryReviewTarget: input.autoDevSecondaryReviewTarget,
    autoDevSecondaryReviewRequireGatePassed: input.autoDevSecondaryReviewRequireGatePassed,
    autoDevInitEnhancementEnabled: input.autoDevInitEnhancementEnabled,
    autoDevInitEnhancementTimeoutMs: input.autoDevInitEnhancementTimeoutMs,
    autoDevInitEnhancementMaxChars: input.autoDevInitEnhancementMaxChars,
    getSessionStatus: (sessionKey: string) => input.stateStore.getSessionStatus(sessionKey),
    getCodexSessionWorkdir: input.stateStore.getCodexSessionWorkdir
      ? (sessionKey: string) => input.stateStore.getCodexSessionWorkdir?.(sessionKey) ?? null
      : undefined,
    resolveRoomRuntimeConfig: (conversationId: string) => input.resolveRoomRuntimeConfig(conversationId),
    getRuntimeMetricsSnapshot: () => input.getRuntimeMetricsSnapshot(),
    getRateLimiterSnapshot: () => input.getRateLimiterSnapshot(),
    getBackendRuntimeStats: () => input.getBackendRuntimeStats(),
    getWorkflowSnapshot: (sessionKey: string) => input.workflowSnapshots.get(sessionKey) ?? null,
    getAutoDevSnapshot: (sessionKey: string) => input.autoDevSnapshots.get(sessionKey) ?? null,
    hasActiveAutoDevLoopSession: (sessionKey: string) => input.activeAutoDevLoopSessions.has(sessionKey),
    hasPendingAutoDevLoopStopRequest: (sessionKey: string) => input.pendingAutoDevLoopStopRequests.has(sessionKey),
    hasPendingStopRequest: (sessionKey: string) => input.pendingStopRequests.has(sessionKey),
    isAutoDevDetailedProgressEnabled: (sessionKey: string) => input.isAutoDevDetailedProgressEnabled(sessionKey),
    isAutoDevStageOutputEchoEnabled: (sessionKey: string) => input.isAutoDevStageOutputEchoEnabled(sessionKey),
    listWorkflowDiagRunsBySession: (kind: "autodev", sessionKey: string, limit: number) =>
      input.listWorkflowDiagRunsBySession(kind, sessionKey, limit),
    listWorkflowDiagEvents: (runId: string, limit?: number) => input.listWorkflowDiagEvents(runId, limit),
    buildWorkflowRoleSkillStatus: (sessionKey: string) => input.buildWorkflowRoleSkillStatus(sessionKey),
    getPackageUpdateStatus: () => input.getPackageUpdateStatus(),
    getLatestUpgradeRun: () => input.getLatestUpgradeRun(),
    getRecentUpgradeRuns: (limit: number) => input.getRecentUpgradeRuns(limit),
    getUpgradeRunStats: () => input.getUpgradeRunStats(),
    getUpgradeExecutionLockSnapshot: () => input.getUpgradeExecutionLockSnapshot(),
    resolveSessionBackendStatusProfile: (sessionKey: string) => input.resolveSessionBackendStatusProfile(sessionKey),
    hasSessionBackendOverride: (sessionKey: string) => input.sessionBackendOverrides.has(sessionKey),
    getSessionBackendDecision: (sessionKey: string) => input.sessionLastBackendDecisions.get(sessionKey) ?? null,
    formatBackendToolLabel: (profile: BackendModelRouteProfile) => input.formatBackendToolLabel(profile),
    sendNotice: (conversationId: string, text: string) => input.sendNotice(conversationId, text),
  };
}

export function buildStatusCommandDispatchContextFromRuntime(
  input: StatusCommandRuntimeContextInput,
): StatusCommandDispatchContext {
  return buildStatusCommandDispatchContext({
    botNoticePrefix: input.config.botNoticePrefix,
    outputLanguage: input.config.outputLanguage,
    matrixUserId: input.config.matrixUserId,
    groupDirectModeEnabled: input.config.groupDirectModeEnabled,
    updateCheckTtlMs: input.config.updateCheckTtlMs,
    cliCompatEnabled: input.config.cliCompat.enabled,
    workflowEnabled: input.config.workflowRunner.isEnabled(),
    autoDevDetailedProgressDefaultEnabled: input.config.autoDevDetailedProgressDefaultEnabled,
    autoDevStageOutputEchoDefaultEnabled: input.config.autoDevStageOutputEchoDefaultEnabled,
    workflowPlanContextMaxChars: input.config.workflowPlanContextMaxChars,
    workflowOutputContextMaxChars: input.config.workflowOutputContextMaxChars,
    workflowFeedbackContextMaxChars: input.config.workflowFeedbackContextMaxChars,
    autoDevLoopMaxRuns: input.config.autoDevLoopMaxRuns,
    autoDevLoopMaxMinutes: input.config.autoDevLoopMaxMinutes,
    autoDevAutoCommit: input.config.autoDevAutoCommit,
    autoDevAutoReleaseEnabled: input.config.autoDevAutoReleaseEnabled,
    autoDevAutoReleasePush: input.config.autoDevAutoReleasePush,
    autoDevMaxConsecutiveFailures: input.config.autoDevMaxConsecutiveFailures,
    autoDevRunArchiveEnabled: input.config.autoDevRunArchiveEnabled,
    autoDevRunArchiveDir: input.config.autoDevRunArchiveDir,
    autoDevValidationStrict: input.config.autoDevValidationStrict,
    autoDevSecondaryReviewEnabled: input.config.autoDevSecondaryReviewEnabled,
    autoDevSecondaryReviewTarget: input.config.autoDevSecondaryReviewTarget,
    autoDevSecondaryReviewRequireGatePassed: input.config.autoDevSecondaryReviewRequireGatePassed,
    autoDevInitEnhancementEnabled: input.config.autoDevInitEnhancementEnabled,
    autoDevInitEnhancementTimeoutMs: input.config.autoDevInitEnhancementTimeoutMs,
    autoDevInitEnhancementMaxChars: input.config.autoDevInitEnhancementMaxChars,
    stateStore: input.snapshots.stateStore,
    workflowSnapshots: input.snapshots.workflowSnapshots,
    autoDevSnapshots: input.snapshots.autoDevSnapshots,
    activeAutoDevLoopSessions: input.snapshots.activeAutoDevLoopSessions,
    pendingAutoDevLoopStopRequests: input.snapshots.pendingAutoDevLoopStopRequests,
    pendingStopRequests: input.snapshots.pendingStopRequests,
    sessionBackendOverrides: input.snapshots.sessionBackendOverrides,
    sessionLastBackendDecisions: input.snapshots.sessionLastBackendDecisions,
    resolveRoomRuntimeConfig: input.actions.resolveRoomRuntimeConfig,
    getRuntimeMetricsSnapshot: () => input.actions.metrics.snapshot(input.actions.runningExecutions.size),
    getRateLimiterSnapshot: () => input.actions.rateLimiter.snapshot(),
    getBackendRuntimeStats: input.actions.getBackendRuntimeStats,
    isAutoDevDetailedProgressEnabled: input.actions.isAutoDevDetailedProgressEnabled,
    isAutoDevStageOutputEchoEnabled: input.actions.isAutoDevStageOutputEchoEnabled,
    listWorkflowDiagRunsBySession: input.actions.listWorkflowDiagRunsBySession,
    listWorkflowDiagEvents: input.actions.listWorkflowDiagEvents,
    buildWorkflowRoleSkillStatus: input.actions.buildWorkflowRoleSkillStatus,
    getPackageUpdateStatus: () => input.actions.packageUpdateChecker.getStatus(),
    getLatestUpgradeRun: input.actions.getLatestUpgradeRun,
    getRecentUpgradeRuns: input.actions.getRecentUpgradeRuns,
    getUpgradeRunStats: input.actions.getUpgradeRunStats,
    getUpgradeExecutionLockSnapshot: input.actions.getUpgradeExecutionLockSnapshot,
    resolveSessionBackendStatusProfile: input.actions.resolveSessionBackendStatusProfile,
    formatBackendToolLabel: input.actions.formatBackendToolLabel,
    sendNotice: input.actions.sendNotice,
  });
}
