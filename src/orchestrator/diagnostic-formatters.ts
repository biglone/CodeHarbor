export interface AutoDevGitCommitResultLike {
  kind: "committed" | "skipped" | "failed";
  commitHash?: string;
  commitSubject?: string;
  changedFiles?: string[];
  reason?: string;
  error?: string;
}

export interface AutoDevGitCommitRecordLike {
  at: string;
  sessionKey: string;
  taskId: string;
  result: AutoDevGitCommitResultLike;
}

export interface AutoDevReleaseResultLike {
  kind: "released" | "skipped" | "failed";
  version?: string;
  commitHash?: string;
  pushed?: boolean;
  pushError?: string;
  reason?: string;
  error?: string;
}

export interface BackendModelRouteProfileLike {
  provider: string;
  model: string | null;
}

export type BackendRouteReasonCode = "manual_override" | "rule_match" | "default_fallback" | "factory_unavailable";

export interface BackendRouteDiagRecordLike {
  at: string;
  taskType: string;
  source: string;
  reasonCode: BackendRouteReasonCode;
  ruleId: string | null;
  profile: BackendModelRouteProfileLike;
}

export interface QueuePendingSessionLike {
  firstTaskId: number;
  sessionKey: string;
}

export interface QueueFailureArchiveRecordLike {
  id: number;
  taskId: number;
  attempt: number;
  retryReason: string;
  archiveReason: string;
  failedAt: number;
  error: string;
}

export function formatAutoDevGitCommitRecords(records: AutoDevGitCommitRecordLike[]): string {
  if (records.length === 0) {
    return "- (empty)";
  }
  return records
    .map((record) => {
      const base = `- at=${record.at} session=${record.sessionKey} task=${record.taskId} result=${formatAutoDevGitCommitResult(record.result)}`;
      if (record.result.kind !== "committed") {
        return base;
      }
      return `${base} files=${formatAutoDevGitChangedFiles(record.result)}`;
    })
    .join("\n");
}

export function formatBackendRouteDiagRecords(records: BackendRouteDiagRecordLike[], outputLanguage: OutputLanguage = "zh"): string {
  if (records.length === 0) {
    return "- (empty)";
  }
  return records
    .map((record) => {
      return [
        `- at=${record.at} taskType=${record.taskType} backend=${formatBackendRouteProfile(record.profile)}`,
        `  source=${record.source} reason=${record.reasonCode}(${describeBackendRouteReason(record.reasonCode, outputLanguage)}) rule=${
          record.ruleId ?? "none"
        } fallback=${isBackendRouteFallbackReason(record.reasonCode) ? "yes" : "no"}`,
      ].join("\n");
    })
    .join("\n");
}

export function formatBackendRouteProfile(profile: BackendModelRouteProfileLike): string {
  if (!profile.model) {
    return profile.provider;
  }
  return `${profile.provider} (${profile.model})`;
}

export function isBackendRouteFallbackReason(reasonCode: BackendRouteReasonCode): boolean {
  return reasonCode === "default_fallback" || reasonCode === "factory_unavailable";
}

export function describeBackendRouteReason(reasonCode: BackendRouteReasonCode, outputLanguage: OutputLanguage = "zh"): string {
  if (reasonCode === "manual_override") {
    return outputLanguage === "en"
      ? "Session backend is pinned manually via /backend"
      : "会话已通过 /backend 手动固定后端";
  }
  if (reasonCode === "rule_match") {
    return outputLanguage === "en"
      ? "Matched routing rule and selected rule target backend"
      : "命中路由规则并使用规则目标";
  }
  if (reasonCode === "factory_unavailable") {
    return outputLanguage === "en"
      ? "Matched rule but target executor is unavailable; fallback to default backend"
      : "命中规则但目标执行器不可用，回退默认后端";
  }
  return outputLanguage === "en" ? "No rule matched; using default backend" : "未命中规则，使用默认后端";
}

export function formatQueuePendingSessions(sessions: QueuePendingSessionLike[]): string {
  if (sessions.length === 0) {
    return "- (empty)";
  }
  return sessions.map((session) => `- firstTaskId=${session.firstTaskId} session=${session.sessionKey}`).join("\n");
}

export function formatQueueFailureArchive(records: QueueFailureArchiveRecordLike[]): string {
  if (records.length === 0) {
    return "- (empty)";
  }
  return records
    .map((record) => {
      return `- #${record.id} task=${record.taskId} attempt=${record.attempt} retryReason=${record.retryReason} archiveReason=${record.archiveReason} failedAt=${new Date(record.failedAt).toISOString()} error=${record.error}`;
    })
    .join("\n");
}

export function formatAutoDevGitCommitResult(result: AutoDevGitCommitResultLike): string {
  if (result.kind === "committed") {
    return `committed ${result.commitHash ?? "unknown"} (${result.commitSubject ?? "unknown"})`;
  }
  if (result.kind === "skipped") {
    return `skipped (${result.reason ?? "unknown"})`;
  }
  return `failed (${result.error ?? "unknown"})`;
}

export function formatAutoDevGitChangedFiles(result: AutoDevGitCommitResultLike): string {
  const changedFiles = result.changedFiles ?? [];
  if (result.kind !== "committed") {
    return "N/A";
  }
  if (changedFiles.length === 0) {
    return "(none)";
  }
  const preview = changedFiles.slice(0, 8).join(", ");
  if (changedFiles.length <= 8) {
    return preview;
  }
  return `${preview}, ... (+${changedFiles.length - 8})`;
}

export function formatAutoDevReleaseResult(result: AutoDevReleaseResultLike): string {
  if (result.kind === "released") {
    const pushText = result.pushed ? "yes" : "no";
    const pushErrorText = result.pushError ? `, pushError=${result.pushError}` : "";
    return `released v${result.version ?? "unknown"} (commit=${result.commitHash ?? "unknown"}, pushed=${pushText}${pushErrorText})`;
  }
  if (result.kind === "skipped") {
    return `skipped (${result.reason ?? "unknown"})`;
  }
  return `failed (${result.error ?? "unknown"})`;
}
import type { OutputLanguage } from "../config";
