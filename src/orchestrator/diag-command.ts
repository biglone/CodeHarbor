import path from "node:path";

import { formatPackageUpdateHint, type PackageUpdateStatus } from "../package-update-checker";
import type { BackendModelRouteProfile } from "../routing/backend-model-router";
import type { UpgradeExecutionLockRecord, UpgradeRunRecord, UpgradeRunStats } from "../store/state-store";
import type { InboundMessage } from "../types";
import type { AutoDevRunSnapshot } from "./autodev-runner";
import {
  parseDiagTarget,
  type DiagTarget,
} from "./command-routing";
import {
  describeBackendRouteReason,
  formatAutoDevGitCommitRecords,
  formatBackendRouteDiagRecords,
  formatQueueFailureArchive,
  formatQueuePendingSessions,
  isBackendRouteFallbackReason,
  type BackendRouteDiagRecordLike,
  type BackendRouteReasonCode,
  type QueueFailureArchiveRecordLike,
} from "./diagnostic-formatters";
import {
  buildDiagAutoDevNotice,
  buildDiagMediaNotice,
  buildDiagQueueNotice,
  buildDiagQueueUnavailableNotice,
  buildDiagRouteNotice,
  buildDiagUpgradeNotice,
  buildDiagUsageNotice,
  buildDiagVersionNotice,
} from "./diag-text";
import { formatDurationMs } from "./helpers";
import { formatMediaDiagEvents } from "./media-progress";
import {
  buildSessionKey,
  formatByteSize,
} from "./misc-utils";
import {
  formatUpgradeDiagRecords,
  formatUpgradeLockSummary,
} from "./upgrade-utils";
import {
  formatAutoDevDiagRuns,
  type WorkflowDiagEventRecord,
  type WorkflowDiagRunRecord,
} from "./workflow-diag";

interface QueueStoreLike {
  getTaskQueueStatusCounts(): { pending: number; running: number; succeeded: number; failed: number };
  listPendingTaskSessions(limit: number, afterTaskId: number): Array<{ firstTaskId: number; sessionKey: string }>;
  getNextPendingRetryAt(sessionKey: string): number | null;
}

interface BackendDecisionLike {
  source: string;
  reasonCode: BackendRouteReasonCode;
  ruleId: string | null;
}

interface MediaMetricsLike {
  snapshot(limit: number): {
    counters: {
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
    };
    recentEvents: Array<{ at: string; type: string; requestId: string; sessionKey: string; detail: string }>;
  };
}

interface DiagCommandDeps {
  botNoticePrefix: string;
  processStartedAtIso: string;
  defaultBackendProfile: BackendModelRouteProfile;
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevAutoReleaseEnabled: boolean;
  autoDevAutoReleasePush: boolean;
  autoDevMaxConsecutiveFailures: number;
  runningExecutionsSize: number;
  cliCompat: {
    fetchMedia: boolean;
    imageMaxCount: number;
    imageMaxBytes: number;
    imageAllowedMimeTypes: string[];
    audioTranscribeMaxBytes: number;
    audioTranscribeModel: string;
  };
  isAudioTranscriberEnabled: () => boolean;
  getPackageUpdateStatus: (query?: { forceRefresh?: boolean }) => Promise<PackageUpdateStatus>;
  formatBackendToolLabel: (profile?: BackendModelRouteProfile) => string;
  mediaMetrics: MediaMetricsLike;
  listWorkflowDiagRuns: (kind: "autodev", limit: number) => WorkflowDiagRunRecord[];
  listWorkflowDiagEvents: (runId: string, limit?: number) => WorkflowDiagEventRecord[];
  getAutoDevSnapshot: (sessionKey: string) => AutoDevRunSnapshot;
  listAutoDevGitCommitRecords: (limit: number) => Array<{
    at: string;
    sessionKey: string;
    taskId: string;
    result:
      | { kind: "committed"; commitHash: string; commitSubject: string; changedFiles: string[] }
      | { kind: "skipped"; reason: string }
      | { kind: "failed"; error: string };
  }>;
  listRecentAutoDevGitCommitEventSummaries: (limit: number) => string[];
  resolveSessionBackendStatusProfile: (sessionKey: string) => BackendModelRouteProfile;
  getSessionBackendOverride: (sessionKey: string) => { profile: BackendModelRouteProfile; updatedAt: number } | undefined;
  getSessionBackendDecision: (sessionKey: string) => BackendDecisionLike | undefined;
  getBackendModelRouterStats: () => { total: number; enabled: number };
  listBackendRouteDiagRecords: (limit: number, sessionKey: string) => BackendRouteDiagRecordLike[];
  getTaskQueueStateStore: () => QueueStoreLike | null;
  listTaskQueueFailureArchive: (limit: number) => QueueFailureArchiveRecordLike[];
  getRecentUpgradeRuns: (limit: number) => UpgradeRunRecord[];
  getUpgradeExecutionLockSnapshot: () => UpgradeExecutionLockRecord | null;
  getUpgradeRunStats: () => UpgradeRunStats;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

export async function handleDiagCommand(deps: DiagCommandDeps, message: InboundMessage): Promise<void> {
  const target = parseDiagTarget(message.text);
  if (!target || target.kind === "help") {
    await deps.sendNotice(message.conversationId, buildDiagUsageNotice());
    return;
  }

  if (target.kind === "version") {
    await handleVersionDiag(deps, message.conversationId);
    return;
  }
  if (target.kind === "media") {
    await handleMediaDiag(deps, message.conversationId, target);
    return;
  }
  if (target.kind === "autodev") {
    await handleAutoDevDiag(deps, message, target);
    return;
  }
  if (target.kind === "route") {
    await handleRouteDiag(deps, message, target);
    return;
  }
  if (target.kind === "queue") {
    await handleQueueDiag(deps, message.conversationId, target);
    return;
  }
  await handleUpgradeDiag(deps, message.conversationId, target);
}

async function handleVersionDiag(deps: DiagCommandDeps, conversationId: string): Promise<void> {
  const packageUpdate = await deps.getPackageUpdateStatus({ forceRefresh: true });
  const uptimeMs = Math.max(0, Math.floor(process.uptime() * 1_000));
  await deps.sendNotice(
    conversationId,
    buildDiagVersionNotice({
      botNoticePrefix: deps.botNoticePrefix,
      processStartedAtIso: deps.processStartedAtIso,
      uptimeText: formatDurationMs(uptimeMs),
      backendLabel: deps.formatBackendToolLabel(),
      currentVersion: packageUpdate.currentVersion,
      latestHint: formatPackageUpdateHint(packageUpdate),
      checkedAt: packageUpdate.checkedAt,
      cliScriptPath: process.argv[1] ? path.resolve(process.argv[1]) : "unknown",
    }),
  );
}

async function handleMediaDiag(deps: DiagCommandDeps, conversationId: string, target: Extract<DiagTarget, { kind: "media" }>): Promise<void> {
  const snapshot = deps.mediaMetrics.snapshot(target.limit);
  const imagePolicy = `enabled=${deps.cliCompat.fetchMedia ? "on" : "off"}, maxCount=${deps.cliCompat.imageMaxCount}, maxBytes=${formatByteSize(deps.cliCompat.imageMaxBytes)}, allow=${deps.cliCompat.imageAllowedMimeTypes.join(",")}`;
  const audioPolicy = `enabled=${deps.isAudioTranscriberEnabled() ? "on" : "off"}, maxBytes=${formatByteSize(deps.cliCompat.audioTranscribeMaxBytes)}, model=${deps.cliCompat.audioTranscribeModel}`;
  await deps.sendNotice(
    conversationId,
    buildDiagMediaNotice({
      botNoticePrefix: deps.botNoticePrefix,
      backendLabel: deps.formatBackendToolLabel(),
      imagePolicy,
      audioPolicy,
      counters: snapshot.counters,
      recordsText: formatMediaDiagEvents(snapshot.recentEvents),
    }),
  );
}

async function handleAutoDevDiag(
  deps: DiagCommandDeps,
  message: InboundMessage,
  target: Extract<DiagTarget, { kind: "autodev" }>,
): Promise<void> {
  const runs = deps.listWorkflowDiagRuns("autodev", target.limit);
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
  const snapshot = deps.getAutoDevSnapshot(sessionKey);
  const commitRecords = deps.listAutoDevGitCommitRecords(target.limit);
  const commitText =
    commitRecords.length > 0
      ? formatAutoDevGitCommitRecords(commitRecords)
      : deps.listRecentAutoDevGitCommitEventSummaries(target.limit).join("\n") || "- (empty)";
  const recordsText = formatAutoDevDiagRuns(runs, (runId) => deps.listWorkflowDiagEvents(runId, 5));

  await deps.sendNotice(
    message.conversationId,
    buildDiagAutoDevNotice({
      botNoticePrefix: deps.botNoticePrefix,
      recentCount: runs.length,
      running: counts.running,
      succeeded: counts.succeeded,
      failed: counts.failed,
      cancelled: counts.cancelled,
      snapshot,
      config: {
        loopMaxRuns: deps.autoDevLoopMaxRuns,
        loopMaxMinutes: deps.autoDevLoopMaxMinutes,
        autoCommit: deps.autoDevAutoCommit,
        autoReleaseEnabled: deps.autoDevAutoReleaseEnabled,
        autoReleasePush: deps.autoDevAutoReleasePush,
        maxConsecutiveFailures: deps.autoDevMaxConsecutiveFailures,
      },
      commitText,
      recordsText,
    }),
  );
}

async function handleRouteDiag(
  deps: DiagCommandDeps,
  message: InboundMessage,
  target: Extract<DiagTarget, { kind: "route" }>,
): Promise<void> {
  const sessionKey = buildSessionKey(message);
  const backendProfile = deps.resolveSessionBackendStatusProfile(sessionKey);
  const backendOverride = deps.getSessionBackendOverride(sessionKey);
  const backendDecision = deps.getSessionBackendDecision(sessionKey);
  const mode = backendOverride ? "manual" : "auto";
  const source = backendOverride ? "manual_override" : backendDecision?.source ?? "default";
  const rawReason = backendOverride ? "manual_override" : backendDecision?.reasonCode ?? "default_fallback";
  const reason = !backendOverride && rawReason === "manual_override" ? "default_fallback" : rawReason;
  const rule = !backendOverride && rawReason === "manual_override" ? "none" : backendDecision?.ruleId ?? "none";
  const reasonDesc = describeBackendRouteReason(reason);
  const fallback = isBackendRouteFallbackReason(reason) ? "yes" : "no";
  const ruleStats = deps.getBackendModelRouterStats();
  const records = deps.listBackendRouteDiagRecords(target.limit, sessionKey);
  await deps.sendNotice(
    message.conversationId,
    buildDiagRouteNotice({
      botNoticePrefix: deps.botNoticePrefix,
      currentBackendLabel: deps.formatBackendToolLabel(backendProfile),
      mode,
      defaultBackendLabel: deps.formatBackendToolLabel(deps.defaultBackendProfile),
      rulesTotal: ruleStats.total,
      rulesEnabled: ruleStats.enabled,
      source,
      reason,
      rule,
      reasonDesc,
      fallback,
      recordsText: formatBackendRouteDiagRecords(records),
    }),
  );
}

async function handleQueueDiag(
  deps: DiagCommandDeps,
  conversationId: string,
  target: Extract<DiagTarget, { kind: "queue" }>,
): Promise<void> {
  const queueStore = deps.getTaskQueueStateStore();
  if (!queueStore) {
    await deps.sendNotice(conversationId, buildDiagQueueUnavailableNotice(deps.botNoticePrefix));
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
  const archive = deps.listTaskQueueFailureArchive(target.limit);
  await deps.sendNotice(
    conversationId,
    buildDiagQueueNotice({
      botNoticePrefix: deps.botNoticePrefix,
      activeExecutions: deps.runningExecutionsSize,
      counts,
      pendingSessions: sessions.length,
      earliestRetryAtIso: earliestRetryAt === null ? "N/A" : new Date(earliestRetryAt).toISOString(),
      sessionsText: formatQueuePendingSessions(sessions),
      archiveText: formatQueueFailureArchive(archive),
    }),
  );
}

async function handleUpgradeDiag(
  deps: DiagCommandDeps,
  conversationId: string,
  target: Extract<DiagTarget, { kind: "upgrade" }>,
): Promise<void> {
  const runs = deps.getRecentUpgradeRuns(target.limit);
  const lock = deps.getUpgradeExecutionLockSnapshot();
  const stats = deps.getUpgradeRunStats();
  await deps.sendNotice(
    conversationId,
    buildDiagUpgradeNotice({
      botNoticePrefix: deps.botNoticePrefix,
      recentCount: runs.length,
      lockText: formatUpgradeLockSummary(lock),
      stats,
      recordsText: formatUpgradeDiagRecords(runs),
    }),
  );
}
