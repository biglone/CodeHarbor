import type { OutputLanguage } from "../config";

export function buildDiagVersionNotice(input: {
  botNoticePrefix: string;
  processStartedAtIso: string;
  uptimeText: string;
  backendLabel: string;
  currentVersion: string;
  latestHint: string;
  checkedAt: string;
  cliScriptPath: string;
}, outputLanguage: OutputLanguage = "zh"): string {
  if (outputLanguage === "en") {
    return `${input.botNoticePrefix} Diagnosis (version)
- pid: ${process.pid}
- startedAt: ${input.processStartedAtIso}
- uptime: ${input.uptimeText}
- node: ${process.version}
- nodeExecPath: ${process.execPath}
- cliScriptPath: ${input.cliScriptPath}
- cwd: ${process.cwd()}
- backend: ${input.backendLabel}
- currentVersion: ${input.currentVersion}
- latestHint: ${input.latestHint}
- checkedAt: ${input.checkedAt}`;
  }
  return `${input.botNoticePrefix} 诊断信息（version）
- pid: ${process.pid}
- startedAt: ${input.processStartedAtIso}
- uptime: ${input.uptimeText}
- node: ${process.version}
- nodeExecPath: ${process.execPath}
- cliScriptPath: ${input.cliScriptPath}
- cwd: ${process.cwd()}
- backend: ${input.backendLabel}
- currentVersion: ${input.currentVersion}
- latestHint: ${input.latestHint}
- checkedAt: ${input.checkedAt}`;
}

export function buildDiagUsageNotice(outputLanguage: OutputLanguage = "zh"): string {
  if (outputLanguage === "en") {
    return "[CodeHarbor] usage: /diag version | /diag media [count] | /diag upgrade [count] | /diag route [count] | /diag autodev [count] | /diag queue [count] | /diag limiter [count]";
  }
  return "[CodeHarbor] 用法: /diag version | /diag media [count] | /diag upgrade [count] | /diag route [count] | /diag autodev [count] | /diag queue [count] | /diag limiter [count]";
}

export function buildDiagMediaNotice(input: {
  botNoticePrefix: string;
  backendLabel: string;
  imagePolicy: string;
  audioPolicy: string;
  counters: {
    imageAccepted: number;
    imageSkippedMissingPath: number;
    imageSkippedMissingLocalFile: number;
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
  recordsText: string;
}, outputLanguage: OutputLanguage = "zh"): string {
  if (outputLanguage === "en") {
    return `${input.botNoticePrefix} Diagnosis (media)
- backend: ${input.backendLabel}
- imagePolicy: ${input.imagePolicy}
- audioPolicy: ${input.audioPolicy}
- counters: image.accepted=${input.counters.imageAccepted}, image.skipped_missing=${input.counters.imageSkippedMissingPath + input.counters.imageSkippedMissingLocalFile}, image.skipped_missing_path=${input.counters.imageSkippedMissingPath}, image.skipped_missing_local_file=${input.counters.imageSkippedMissingLocalFile}, image.skipped_mime=${input.counters.imageSkippedUnsupportedMime}, image.skipped_size=${input.counters.imageSkippedTooLarge}, image.skipped_limit=${input.counters.imageSkippedOverLimit}
- counters: audio.transcribed=${input.counters.audioTranscribed}, audio.failed=${input.counters.audioFailed}, audio.skipped_size=${input.counters.audioSkippedTooLarge}
- counters: claude.fallback_triggered=${input.counters.claudeImageFallbackTriggered}, claude.fallback_ok=${input.counters.claudeImageFallbackSucceeded}, claude.fallback_failed=${input.counters.claudeImageFallbackFailed}
- records:
${input.recordsText}`;
  }
  return `${input.botNoticePrefix} 诊断信息（media）
- backend: ${input.backendLabel}
- imagePolicy: ${input.imagePolicy}
- audioPolicy: ${input.audioPolicy}
- counters: image.accepted=${input.counters.imageAccepted}, image.skipped_missing=${input.counters.imageSkippedMissingPath + input.counters.imageSkippedMissingLocalFile}, image.skipped_missing_path=${input.counters.imageSkippedMissingPath}, image.skipped_missing_local_file=${input.counters.imageSkippedMissingLocalFile}, image.skipped_mime=${input.counters.imageSkippedUnsupportedMime}, image.skipped_size=${input.counters.imageSkippedTooLarge}, image.skipped_limit=${input.counters.imageSkippedOverLimit}
- counters: audio.transcribed=${input.counters.audioTranscribed}, audio.failed=${input.counters.audioFailed}, audio.skipped_size=${input.counters.audioSkippedTooLarge}
- counters: claude.fallback_triggered=${input.counters.claudeImageFallbackTriggered}, claude.fallback_ok=${input.counters.claudeImageFallbackSucceeded}, claude.fallback_failed=${input.counters.claudeImageFallbackFailed}
- records:
${input.recordsText}`;
}

export function buildDiagAutoDevNotice(input: {
  botNoticePrefix: string;
  recentCount: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  snapshot: {
    state: string;
    mode: string;
    loopRound: number;
    loopMaxRuns: number;
    loopCompletedRuns: number;
    loopDeadlineAt: string | null;
  };
  config: {
    loopMaxRuns: number;
    loopMaxMinutes: number;
    autoCommit: boolean;
    autoReleaseEnabled: boolean;
    autoReleasePush: boolean;
    maxConsecutiveFailures: number;
  };
  commitText: string;
  recordsText: string;
}, outputLanguage: OutputLanguage = "zh"): string {
  if (outputLanguage === "en") {
    return `${input.botNoticePrefix} Diagnosis (autodev)
- recentCount: ${input.recentCount}
- status: running=${input.running}, succeeded=${input.succeeded}, failed=${input.failed}, cancelled=${input.cancelled}
- live: state=${input.snapshot.state}, mode=${input.snapshot.mode}, loop=${input.snapshot.loopRound}/${input.snapshot.loopMaxRuns}, completed=${input.snapshot.loopCompletedRuns}, deadline=${input.snapshot.loopDeadlineAt ?? "N/A"}
- config: loopMaxRuns=${input.config.loopMaxRuns}, loopMaxMinutes=${input.config.loopMaxMinutes}, autoCommit=${input.config.autoCommit ? "on" : "off"}, autoRelease=${input.config.autoReleaseEnabled ? "on" : "off"}, autoReleasePush=${input.config.autoReleasePush ? "on" : "off"}, maxConsecutiveFailures=${input.config.maxConsecutiveFailures}
- recentGitCommits:
${input.commitText}
- records:
${input.recordsText}`;
  }
  return `${input.botNoticePrefix} 诊断信息（autodev）
- recentCount: ${input.recentCount}
- status: running=${input.running}, succeeded=${input.succeeded}, failed=${input.failed}, cancelled=${input.cancelled}
- live: state=${input.snapshot.state}, mode=${input.snapshot.mode}, loop=${input.snapshot.loopRound}/${input.snapshot.loopMaxRuns}, completed=${input.snapshot.loopCompletedRuns}, deadline=${input.snapshot.loopDeadlineAt ?? "N/A"}
- config: loopMaxRuns=${input.config.loopMaxRuns}, loopMaxMinutes=${input.config.loopMaxMinutes}, autoCommit=${input.config.autoCommit ? "on" : "off"}, autoRelease=${input.config.autoReleaseEnabled ? "on" : "off"}, autoReleasePush=${input.config.autoReleasePush ? "on" : "off"}, maxConsecutiveFailures=${input.config.maxConsecutiveFailures}
- recentGitCommits:
${input.commitText}
- records:
${input.recordsText}`;
}

export function buildDiagRouteNotice(input: {
  botNoticePrefix: string;
  currentBackendLabel: string;
  mode: string;
  defaultBackendLabel: string;
  rulesTotal: number;
  rulesEnabled: number;
  source: string;
  reason: string;
  rule: string;
  reasonDesc: string;
  fallback: string;
  recordsText: string;
}, outputLanguage: OutputLanguage = "zh"): string {
  if (outputLanguage === "en") {
    return `${input.botNoticePrefix} Diagnosis (route)
- current: backend=${input.currentBackendLabel}, mode=${input.mode}
- defaultBackend: ${input.defaultBackendLabel}
- rules: total=${input.rulesTotal}, enabled=${input.rulesEnabled}
- lastDecision: source=${input.source}, reason=${input.reason}, rule=${input.rule}
- reasonDesc: ${input.reasonDesc}
- fallback: ${input.fallback}
- records:
${input.recordsText}`;
  }
  return `${input.botNoticePrefix} 诊断信息（route）
- current: backend=${input.currentBackendLabel}, mode=${input.mode}
- defaultBackend: ${input.defaultBackendLabel}
- rules: total=${input.rulesTotal}, enabled=${input.rulesEnabled}
- lastDecision: source=${input.source}, reason=${input.reason}, rule=${input.rule}
- reasonDesc: ${input.reasonDesc}
- fallback: ${input.fallback}
- records:
${input.recordsText}`;
}

export function buildDiagQueueUnavailableNotice(
  botNoticePrefix: string,
  outputLanguage: OutputLanguage = "zh",
): string {
  if (outputLanguage === "en") {
    return `${botNoticePrefix} Diagnosis (queue)
- status: unavailable
- reason: resilient task queue is not enabled on this instance`;
  }
  return `${botNoticePrefix} 诊断信息（queue）
- status: unavailable
- reason: 当前实例未启用可恢复任务队列能力`;
}

export function buildDiagQueueNotice(input: {
  botNoticePrefix: string;
  activeExecutions: number;
  counts: { pending: number; running: number; succeeded: number; failed: number };
  pendingSessions: number;
  earliestRetryAtIso: string;
  sessionsText: string;
  archiveText: string;
}, outputLanguage: OutputLanguage = "zh"): string {
  if (outputLanguage === "en") {
    return `${input.botNoticePrefix} Diagnosis (queue)
- activeExecutions: ${input.activeExecutions}
- counts: pending=${input.counts.pending}, running=${input.counts.running}, succeeded=${input.counts.succeeded}, failed=${input.counts.failed}
- pendingSessions: ${input.pendingSessions}
- earliestRetryAt: ${input.earliestRetryAtIso}
- sessions:
${input.sessionsText}
- archive:
${input.archiveText}`;
  }
  return `${input.botNoticePrefix} 诊断信息（queue）
- activeExecutions: ${input.activeExecutions}
- counts: pending=${input.counts.pending}, running=${input.counts.running}, succeeded=${input.counts.succeeded}, failed=${input.counts.failed}
- pendingSessions: ${input.pendingSessions}
- earliestRetryAt: ${input.earliestRetryAtIso}
- sessions:
${input.sessionsText}
- archive:
${input.archiveText}`;
}

export function buildDiagLimiterNotice(input: {
  botNoticePrefix: string;
  mode: "local" | "redis";
  sharedBackendEnabled: boolean;
  fallbackToLocal: boolean;
  active: {
    global: number;
    users: number;
    rooms: number;
  };
  totals: {
    decisions: number;
    allowed: number;
    denied: number;
    rejectionRatePercent: number;
  };
  decisionBreakdown: {
    localAllowed: number;
    localDenied: number;
    sharedAllowed: number;
    sharedDenied: number;
    sharedErrors: number;
    fallbackAllowed: number;
    fallbackDenied: number;
  };
  deniedByReason: {
    userRequests: number;
    roomRequests: number;
    globalConcurrency: number;
    userConcurrency: number;
    roomConcurrency: number;
  };
  recovery: {
    count: number;
    lastMs: number;
    avgMs: number;
    pendingSinceIso: string | null;
    pendingForMs: number;
  };
  recordsText: string;
}, outputLanguage: OutputLanguage = "zh"): string {
  if (outputLanguage === "en") {
    return `${input.botNoticePrefix} Diagnosis (limiter)
- mode: shared=${input.mode}, backendReady=${input.sharedBackendEnabled ? "yes" : "no"}, fallbackToLocal=${input.fallbackToLocal ? "on" : "off"}
- active: global=${input.active.global}, users=${input.active.users}, rooms=${input.active.rooms}
- totals: decisions=${input.totals.decisions}, allowed=${input.totals.allowed}, denied=${input.totals.denied}, rejection=${input.totals.rejectionRatePercent}%
- breakdown: local.allow=${input.decisionBreakdown.localAllowed}, local.deny=${input.decisionBreakdown.localDenied}, shared.allow=${input.decisionBreakdown.sharedAllowed}, shared.deny=${input.decisionBreakdown.sharedDenied}, shared.error=${input.decisionBreakdown.sharedErrors}, fallback.allow=${input.decisionBreakdown.fallbackAllowed}, fallback.deny=${input.decisionBreakdown.fallbackDenied}
- deniedByReason: user.window=${input.deniedByReason.userRequests}, room.window=${input.deniedByReason.roomRequests}, global.conc=${input.deniedByReason.globalConcurrency}, user.conc=${input.deniedByReason.userConcurrency}, room.conc=${input.deniedByReason.roomConcurrency}
- recovery: count=${input.recovery.count}, last=${input.recovery.lastMs}ms, avg=${input.recovery.avgMs}ms, pendingSince=${input.recovery.pendingSinceIso ?? "N/A"}, pendingFor=${input.recovery.pendingForMs}ms
- records:
${input.recordsText}`;
  }
  return `${input.botNoticePrefix} 诊断信息（limiter）
- mode: shared=${input.mode}, backendReady=${input.sharedBackendEnabled ? "yes" : "no"}, fallbackToLocal=${input.fallbackToLocal ? "on" : "off"}
- active: global=${input.active.global}, users=${input.active.users}, rooms=${input.active.rooms}
- totals: decisions=${input.totals.decisions}, allowed=${input.totals.allowed}, denied=${input.totals.denied}, rejection=${input.totals.rejectionRatePercent}%
- breakdown: local.allow=${input.decisionBreakdown.localAllowed}, local.deny=${input.decisionBreakdown.localDenied}, shared.allow=${input.decisionBreakdown.sharedAllowed}, shared.deny=${input.decisionBreakdown.sharedDenied}, shared.error=${input.decisionBreakdown.sharedErrors}, fallback.allow=${input.decisionBreakdown.fallbackAllowed}, fallback.deny=${input.decisionBreakdown.fallbackDenied}
- deniedByReason: user.window=${input.deniedByReason.userRequests}, room.window=${input.deniedByReason.roomRequests}, global.conc=${input.deniedByReason.globalConcurrency}, user.conc=${input.deniedByReason.userConcurrency}, room.conc=${input.deniedByReason.roomConcurrency}
- recovery: count=${input.recovery.count}, last=${input.recovery.lastMs}ms, avg=${input.recovery.avgMs}ms, pendingSince=${input.recovery.pendingSinceIso ?? "N/A"}, pendingFor=${input.recovery.pendingForMs}ms
- records:
${input.recordsText}`;
}

export function buildDiagUpgradeNotice(input: {
  botNoticePrefix: string;
  recentCount: number;
  lockText: string;
  stats: { total: number; succeeded: number; failed: number; running: number; avgDurationMs: number };
  recordsText: string;
}, outputLanguage: OutputLanguage = "zh"): string {
  if (outputLanguage === "en") {
    return `${input.botNoticePrefix} Diagnosis (upgrade)
- recentCount: ${input.recentCount}
- lock: ${input.lockText}
- stats: total=${input.stats.total}, succeeded=${input.stats.succeeded}, failed=${input.stats.failed}, running=${input.stats.running}, avg=${input.stats.avgDurationMs}ms
- records:
${input.recordsText}`;
  }
  return `${input.botNoticePrefix} 诊断信息（upgrade）
- recentCount: ${input.recentCount}
- lock: ${input.lockText}
- stats: total=${input.stats.total}, succeeded=${input.stats.succeeded}, failed=${input.stats.failed}, running=${input.stats.running}, avg=${input.stats.avgDurationMs}ms
- records:
${input.recordsText}`;
}
