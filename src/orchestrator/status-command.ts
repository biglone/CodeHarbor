import { formatPackageUpdateHint, type PackageUpdateStatus } from "../package-update-checker";
import type { RateLimiterSnapshot } from "../rate-limiter";
import type { BackendModelRouteProfile } from "../routing/backend-model-router";
import type { UpgradeExecutionLockRecord, UpgradeRunRecord, UpgradeRunStats } from "../store/state-store";
import type { InboundMessage } from "../types";
import { createIdleWorkflowSnapshot, type WorkflowRunSnapshot } from "../workflow/multi-agent-workflow";
import type { AutoDevRunSnapshot } from "./autodev-runner";
import { createIdleAutoDevSnapshot } from "./autodev-snapshot";
import {
  describeBackendRouteReason,
  isBackendRouteFallbackReason,
  type BackendRouteReasonCode,
} from "./diagnostic-formatters";
import { buildStatusNotice } from "./control-text";
import {
  formatCacheTtl,
  formatRunWindowDuration,
} from "./helpers";
import {
  formatLatestUpgradeSummary,
  formatRecentUpgradeRunsSummary,
  formatUpgradeLockSummary,
} from "./upgrade-utils";
import {
  type WorkflowDiagEventRecord,
  type WorkflowDiagRunRecord,
} from "./workflow-diag";

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

interface BackendDecisionLike {
  reasonCode: BackendRouteReasonCode;
  ruleId: string | null;
}

interface RoleSkillStatusLike {
  enabled: boolean;
  mode: string;
  maxChars: number;
  override: string;
  loaded: string;
}

interface StatusCommandDeps {
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
  formatWorkflowContextBudget: (value: number | null) => string;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

interface StatusCommandInput {
  sessionKey: string;
  message: InboundMessage;
}

export async function handleStatusCommand(deps: StatusCommandDeps, input: StatusCommandInput): Promise<void> {
  const status = deps.getSessionStatus(input.sessionKey);
  const roomConfig = deps.resolveRoomRuntimeConfig(input.message.conversationId);
  const scope = input.message.isDirectMessage
    ? "私聊（免前缀）"
    : deps.groupDirectModeEnabled
      ? "群聊（默认直通）"
      : "群聊（按房间触发策略）";
  const activeUntil = status.activeUntil ?? "未激活";
  const metrics = deps.getRuntimeMetricsSnapshot();
  const limiter = deps.getRateLimiterSnapshot();
  const runtime = deps.getBackendRuntimeStats();
  const workflow = deps.getWorkflowSnapshot(input.sessionKey) ?? createIdleWorkflowSnapshot();
  const autoDev = deps.getAutoDevSnapshot(input.sessionKey) ?? createIdleAutoDevSnapshot();
  const autoDevTask =
    autoDev.taskId && autoDev.taskDescription
      ? `${autoDev.taskId} ${autoDev.taskDescription}`.trim()
      : autoDev.taskId
        ? autoDev.taskId
        : "N/A";
  const autoDevLoopActive = deps.hasActiveAutoDevLoopSession(input.sessionKey) ? "yes" : "no";
  const autoDevLoopStopRequested = deps.hasPendingAutoDevLoopStopRequest(input.sessionKey) ? "yes" : "no";
  const autoDevStopRequested = deps.hasPendingStopRequest(input.sessionKey) ? "yes" : "no";
  const autoDevDetailedProgress = deps.isAutoDevDetailedProgressEnabled(input.sessionKey) ? "on" : "off";
  const autoDevDetailedProgressDefault = deps.autoDevDetailedProgressDefaultEnabled ? "on" : "off";
  const autoDevRunDuration = formatRunWindowDuration(autoDev.startedAt, autoDev.endedAt);
  const autoDevDiagRun = deps.listWorkflowDiagRunsBySession("autodev", input.sessionKey, 1)[0] ?? null;
  const autoDevLatestStageEvent = autoDevDiagRun ? deps.listWorkflowDiagEvents(autoDevDiagRun.runId, 1)[0] ?? null : null;
  const autoDevStageSummary = autoDevLatestStageEvent
    ? `${autoDevLatestStageEvent.stage}#${autoDevLatestStageEvent.round}@${autoDevLatestStageEvent.at}`
    : autoDevDiagRun?.lastStage
      ? `${autoDevDiagRun.lastStage}@${autoDevDiagRun.updatedAt}`
      : "N/A";
  const autoDevStageMessage = autoDevLatestStageEvent?.message ?? autoDevDiagRun?.lastMessage ?? "N/A";
  const roleSkillStatus = deps.buildWorkflowRoleSkillStatus(input.sessionKey);
  const packageUpdate = await deps.getPackageUpdateStatus();
  const latestUpgrade = deps.getLatestUpgradeRun();
  const recentUpgrades = deps.getRecentUpgradeRuns(3);
  const upgradeStats = deps.getUpgradeRunStats();
  const upgradeLock = deps.getUpgradeExecutionLockSnapshot();
  const backendProfile = deps.resolveSessionBackendStatusProfile(input.sessionKey);
  const backendRouteMode = deps.hasSessionBackendOverride(input.sessionKey) ? "manual" : "auto";
  const backendDecision = deps.getSessionBackendDecision(input.sessionKey);
  const backendRouteReason = backendRouteMode === "manual" ? "manual_override" : backendDecision?.reasonCode ?? "default_fallback";
  const backendRouteRuleId = backendDecision?.ruleId ?? "none";
  const backendRouteReasonDesc = describeBackendRouteReason(backendRouteReason);
  const backendRouteFallback = isBackendRouteFallbackReason(backendRouteReason) ? "yes" : "no";

  await deps.sendNotice(
    input.message.conversationId,
    buildStatusNotice({
      botNoticePrefix: deps.botNoticePrefix,
      scope,
      isActive: status.isActive,
      activeUntil,
      hasCodexSession: status.hasCodexSession,
      workdir: roomConfig.workdir,
      backendLabel: deps.formatBackendToolLabel(backendProfile),
      backendRouteMode,
      backendRouteReason,
      backendRouteRuleId,
      backendRouteReasonDesc,
      backendRouteFallback,
      currentVersion: packageUpdate.currentVersion,
      updateHint: formatPackageUpdateHint(packageUpdate),
      checkedAt: packageUpdate.checkedAt,
      updateCacheTtlText: formatCacheTtl(deps.updateCheckTtlMs),
      latestUpgradeSummary: formatLatestUpgradeSummary(latestUpgrade),
      recentUpgradesSummary: formatRecentUpgradeRunsSummary(recentUpgrades),
      upgradeStats,
      upgradeLockSummary: formatUpgradeLockSummary(upgradeLock),
      metrics,
      limiter,
      runtime,
      cliCompatEnabled: deps.cliCompatEnabled,
      workflowEnabled: deps.workflowEnabled,
      workflowState: workflow.state,
      workflowPlanBudget: deps.formatWorkflowContextBudget(deps.workflowPlanContextMaxChars),
      workflowOutputBudget: deps.formatWorkflowContextBudget(deps.workflowOutputContextMaxChars),
      workflowFeedbackBudget: deps.formatWorkflowContextBudget(deps.workflowFeedbackContextMaxChars),
      roleSkillStatus,
      autoDevState: autoDev.state,
      autoDevMode: autoDev.mode,
      autoDevTask,
      autoDevRunDuration,
      autoDevLoopRound: autoDev.loopRound,
      autoDevLoopMaxRuns: autoDev.loopMaxRuns,
      autoDevLoopCompletedRuns: autoDev.loopCompletedRuns,
      autoDevLoopDeadlineAt: autoDev.loopDeadlineAt,
      autoDevLoopActive,
      autoDevLoopStopRequested,
      autoDevStopRequested,
      autoDevDetailedProgress,
      autoDevDetailedProgressDefault,
      autoDevDiagRunId: autoDevDiagRun?.runId ?? "N/A",
      autoDevDiagRunStatus: autoDevDiagRun?.status ?? "N/A",
      autoDevStageSummary,
      autoDevStageMessage,
    }),
  );
}
