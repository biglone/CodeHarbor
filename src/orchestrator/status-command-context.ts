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
  groupDirectModeEnabled: boolean;
  updateCheckTtlMs: number;
  cliCompatEnabled: boolean;
  workflowEnabled: boolean;
  autoDevDetailedProgressDefaultEnabled: boolean;
  workflowPlanContextMaxChars: number | null;
  workflowOutputContextMaxChars: number | null;
  workflowFeedbackContextMaxChars: number | null;
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevMaxConsecutiveFailures: number;
  stateStore: {
    getSessionStatus: (sessionKey: string) => {
      isActive: boolean;
      activeUntil: string | null;
      hasCodexSession: boolean;
    };
  };
  resolveRoomRuntimeConfig: (conversationId: string) => { workdir: string };
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

export function buildStatusCommandDispatchContext(input: StatusCommandContextInput): StatusCommandDispatchContext {
  return {
    botNoticePrefix: input.botNoticePrefix,
    groupDirectModeEnabled: input.groupDirectModeEnabled,
    updateCheckTtlMs: input.updateCheckTtlMs,
    cliCompatEnabled: input.cliCompatEnabled,
    workflowEnabled: input.workflowEnabled,
    autoDevDetailedProgressDefaultEnabled: input.autoDevDetailedProgressDefaultEnabled,
    workflowPlanContextMaxChars: input.workflowPlanContextMaxChars,
    workflowOutputContextMaxChars: input.workflowOutputContextMaxChars,
    workflowFeedbackContextMaxChars: input.workflowFeedbackContextMaxChars,
    autoDevLoopMaxRuns: input.autoDevLoopMaxRuns,
    autoDevLoopMaxMinutes: input.autoDevLoopMaxMinutes,
    autoDevAutoCommit: input.autoDevAutoCommit,
    autoDevMaxConsecutiveFailures: input.autoDevMaxConsecutiveFailures,
    getSessionStatus: (sessionKey: string) => input.stateStore.getSessionStatus(sessionKey),
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
