import type { PackageUpdateStatus } from "../package-update-checker";
import type { RateLimiterSnapshot } from "../rate-limiter";
import type { BackendModelRouteProfile } from "../routing/backend-model-router";
import type { UpgradeExecutionLockRecord, UpgradeRunRecord, UpgradeRunStats } from "../store/state-store";
import type { InboundMessage } from "../types";
import type { WorkflowRunSnapshot } from "../workflow/multi-agent-workflow";
import type { AutoDevRunSnapshot } from "./autodev-runner";
import { handleAutoDevStatusCommand as runAutoDevStatusCommand } from "./autodev-status-command";
import { formatWorkflowContextBudget } from "./helpers";
import { handleStatusCommand } from "./status-command";
import { handleWorkflowStatusCommand as runWorkflowStatusCommand } from "./workflow-status-command";
import type { WorkflowDiagEventRecord, WorkflowDiagRunRecord } from "./workflow-diag";

interface SessionStatusLike {
  isActive: boolean;
  activeUntil: string | null;
  hasCodexSession: boolean;
}

interface RuntimeMetricsSnapshotLike {
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
}

interface RoleSkillStatusLike {
  enabled: boolean;
  mode: string;
  maxChars: number;
  override: string;
  loaded: string;
}

interface BackendDecisionLike {
  reasonCode: "manual_override" | "rule_match" | "default_fallback" | "factory_unavailable";
  ruleId: string | null;
}

interface StatusCommandDispatchContext {
  botNoticePrefix: string;
  groupDirectModeEnabled: boolean;
  updateCheckTtlMs: number;
  cliCompatEnabled: boolean;
  workflowEnabled: boolean;
  autoDevDetailedProgressDefaultEnabled: boolean;
  workflowPlanContextMaxChars: number | null;
  workflowOutputContextMaxChars: number | null;
  workflowFeedbackContextMaxChars: number | null;
  getSessionStatus: (sessionKey: string) => SessionStatusLike;
  resolveRoomRuntimeConfig: (conversationId: string) => { workdir: string };
  getRuntimeMetricsSnapshot: () => RuntimeMetricsSnapshotLike;
  getRateLimiterSnapshot: () => RateLimiterSnapshot;
  getBackendRuntimeStats: () => { workerCount: number; runningCount: number };
  getWorkflowSnapshot: (sessionKey: string) => WorkflowRunSnapshot | null;
  getAutoDevSnapshot: (sessionKey: string) => AutoDevRunSnapshot | null;
  hasActiveAutoDevLoopSession: (sessionKey: string) => boolean;
  hasPendingAutoDevLoopStopRequest: (sessionKey: string) => boolean;
  hasPendingStopRequest: (sessionKey: string) => boolean;
  isAutoDevDetailedProgressEnabled: (sessionKey: string) => boolean;
  listWorkflowDiagRunsBySession: (kind: "autodev", sessionKey: string, limit: number) => WorkflowDiagRunRecord[];
  listWorkflowDiagEvents: (runId: string, limit?: number) => WorkflowDiagEventRecord[];
  buildWorkflowRoleSkillStatus: (sessionKey: string) => RoleSkillStatusLike;
  getPackageUpdateStatus: () => Promise<PackageUpdateStatus>;
  getLatestUpgradeRun: () => UpgradeRunRecord | null;
  getRecentUpgradeRuns: (limit: number) => UpgradeRunRecord[];
  getUpgradeRunStats: () => UpgradeRunStats;
  getUpgradeExecutionLockSnapshot: () => UpgradeExecutionLockRecord | null;
  resolveSessionBackendStatusProfile: (sessionKey: string) => BackendModelRouteProfile;
  hasSessionBackendOverride: (sessionKey: string) => boolean;
  getSessionBackendDecision: (sessionKey: string) => BackendDecisionLike | null;
  formatBackendToolLabel: (profile: BackendModelRouteProfile) => string;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

interface AutoDevStatusContext extends StatusCommandDispatchContext {
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevMaxConsecutiveFailures: number;
}

interface StatusCommandDispatchInput {
  sessionKey: string;
  message: InboundMessage;
}

interface AutoDevStatusDispatchInput extends StatusCommandDispatchInput {
  workdir: string;
}

export async function sendStatusCommand(
  context: StatusCommandDispatchContext,
  input: StatusCommandDispatchInput,
): Promise<void> {
  await handleStatusCommand(
    {
      botNoticePrefix: context.botNoticePrefix,
      groupDirectModeEnabled: context.groupDirectModeEnabled,
      updateCheckTtlMs: context.updateCheckTtlMs,
      cliCompatEnabled: context.cliCompatEnabled,
      workflowEnabled: context.workflowEnabled,
      autoDevDetailedProgressDefaultEnabled: context.autoDevDetailedProgressDefaultEnabled,
      workflowPlanContextMaxChars: context.workflowPlanContextMaxChars,
      workflowOutputContextMaxChars: context.workflowOutputContextMaxChars,
      workflowFeedbackContextMaxChars: context.workflowFeedbackContextMaxChars,
      getSessionStatus: (sessionKey) => context.getSessionStatus(sessionKey),
      resolveRoomRuntimeConfig: (conversationId) => context.resolveRoomRuntimeConfig(conversationId),
      getRuntimeMetricsSnapshot: () => context.getRuntimeMetricsSnapshot(),
      getRateLimiterSnapshot: () => context.getRateLimiterSnapshot(),
      getBackendRuntimeStats: () => context.getBackendRuntimeStats(),
      getWorkflowSnapshot: (sessionKey) => context.getWorkflowSnapshot(sessionKey),
      getAutoDevSnapshot: (sessionKey) => context.getAutoDevSnapshot(sessionKey),
      hasActiveAutoDevLoopSession: (sessionKey) => context.hasActiveAutoDevLoopSession(sessionKey),
      hasPendingAutoDevLoopStopRequest: (sessionKey) => context.hasPendingAutoDevLoopStopRequest(sessionKey),
      hasPendingStopRequest: (sessionKey) => context.hasPendingStopRequest(sessionKey),
      isAutoDevDetailedProgressEnabled: (sessionKey) => context.isAutoDevDetailedProgressEnabled(sessionKey),
      listWorkflowDiagRunsBySession: (kind, sessionKey, limit) => context.listWorkflowDiagRunsBySession(kind, sessionKey, limit),
      listWorkflowDiagEvents: (runId, limit) => context.listWorkflowDiagEvents(runId, limit),
      buildWorkflowRoleSkillStatus: (sessionKey) => context.buildWorkflowRoleSkillStatus(sessionKey),
      getPackageUpdateStatus: () => context.getPackageUpdateStatus(),
      getLatestUpgradeRun: () => context.getLatestUpgradeRun(),
      getRecentUpgradeRuns: (limit) => context.getRecentUpgradeRuns(limit),
      getUpgradeRunStats: () => context.getUpgradeRunStats(),
      getUpgradeExecutionLockSnapshot: () => context.getUpgradeExecutionLockSnapshot(),
      resolveSessionBackendStatusProfile: (sessionKey) => context.resolveSessionBackendStatusProfile(sessionKey),
      hasSessionBackendOverride: (sessionKey) => context.hasSessionBackendOverride(sessionKey),
      getSessionBackendDecision: (sessionKey) => context.getSessionBackendDecision(sessionKey),
      formatBackendToolLabel: (profile) => context.formatBackendToolLabel(profile),
      formatWorkflowContextBudget,
      sendNotice: (conversationId, text) => context.sendNotice(conversationId, text),
    },
    input,
  );
}

export async function sendWorkflowStatusCommand(
  context: Pick<
    StatusCommandDispatchContext,
    | "workflowPlanContextMaxChars"
    | "workflowOutputContextMaxChars"
    | "workflowFeedbackContextMaxChars"
    | "getWorkflowSnapshot"
    | "buildWorkflowRoleSkillStatus"
    | "sendNotice"
  >,
  input: StatusCommandDispatchInput,
): Promise<void> {
  await runWorkflowStatusCommand(
    {
      workflowPlanContextMaxChars: context.workflowPlanContextMaxChars,
      workflowOutputContextMaxChars: context.workflowOutputContextMaxChars,
      workflowFeedbackContextMaxChars: context.workflowFeedbackContextMaxChars,
      getWorkflowSnapshot: (sessionKey) => context.getWorkflowSnapshot(sessionKey),
      buildWorkflowRoleSkillStatus: (sessionKey) => context.buildWorkflowRoleSkillStatus(sessionKey),
      formatWorkflowContextBudget,
      sendNotice: (conversationId, text) => context.sendNotice(conversationId, text),
    },
    input,
  );
}

export async function sendAutoDevStatusCommand(
  context: Pick<
    AutoDevStatusContext,
    | "autoDevLoopMaxRuns"
    | "autoDevLoopMaxMinutes"
    | "autoDevAutoCommit"
    | "autoDevMaxConsecutiveFailures"
    | "autoDevDetailedProgressDefaultEnabled"
    | "getAutoDevSnapshot"
    | "hasActiveAutoDevLoopSession"
    | "hasPendingAutoDevLoopStopRequest"
    | "hasPendingStopRequest"
    | "isAutoDevDetailedProgressEnabled"
    | "buildWorkflowRoleSkillStatus"
    | "listWorkflowDiagRunsBySession"
    | "listWorkflowDiagEvents"
    | "sendNotice"
  >,
  input: AutoDevStatusDispatchInput,
): Promise<void> {
  await runAutoDevStatusCommand(
    {
      autoDevLoopMaxRuns: context.autoDevLoopMaxRuns,
      autoDevLoopMaxMinutes: context.autoDevLoopMaxMinutes,
      autoDevAutoCommit: context.autoDevAutoCommit,
      autoDevMaxConsecutiveFailures: context.autoDevMaxConsecutiveFailures,
      autoDevDetailedProgressDefaultEnabled: context.autoDevDetailedProgressDefaultEnabled,
      getAutoDevSnapshot: (sessionKey) => context.getAutoDevSnapshot(sessionKey),
      hasActiveAutoDevLoopSession: (sessionKey) => context.hasActiveAutoDevLoopSession(sessionKey),
      hasPendingAutoDevLoopStopRequest: (sessionKey) => context.hasPendingAutoDevLoopStopRequest(sessionKey),
      hasPendingStopRequest: (sessionKey) => context.hasPendingStopRequest(sessionKey),
      isAutoDevDetailedProgressEnabled: (sessionKey) => context.isAutoDevDetailedProgressEnabled(sessionKey),
      buildWorkflowRoleSkillStatus: (sessionKey) => context.buildWorkflowRoleSkillStatus(sessionKey),
      listWorkflowDiagRunsBySession: (kind, sessionKey, limit) => context.listWorkflowDiagRunsBySession(kind, sessionKey, limit),
      listWorkflowDiagEvents: (runId, limit) => context.listWorkflowDiagEvents(runId, limit),
      sendNotice: (conversationId, text) => context.sendNotice(conversationId, text),
    },
    {
      sessionKey: input.sessionKey,
      message: input.message,
      workdir: input.workdir,
    },
  );
}
