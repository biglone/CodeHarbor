import type {
  WorkflowDiagEventRecord,
  WorkflowDiagRunKind,
  WorkflowDiagRunRecord,
  WorkflowDiagStorePayload,
} from "./workflow-diag";

export function listWorkflowDiagRuns(
  store: WorkflowDiagStorePayload,
  kind: WorkflowDiagRunKind,
  limit: number,
): WorkflowDiagRunRecord[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  return store.runs
    .filter((run) => run.kind === kind)
    .slice()
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, safeLimit);
}

export function listWorkflowDiagRunsBySession(
  store: WorkflowDiagStorePayload,
  kind: WorkflowDiagRunKind,
  sessionKey: string,
  limit: number,
): WorkflowDiagRunRecord[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  return store.runs
    .filter((run) => run.kind === kind && run.sessionKey === sessionKey)
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, safeLimit);
}

export function listWorkflowDiagRunsByRequestId(
  store: WorkflowDiagStorePayload,
  requestId: string,
  limit: number,
): WorkflowDiagRunRecord[] {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId) {
    return [];
  }
  const safeLimit = Math.max(1, Math.floor(limit));
  return store.runs
    .filter((run) => run.requestId === normalizedRequestId)
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, safeLimit);
}

export function listWorkflowDiagEvents(
  store: WorkflowDiagStorePayload,
  runId: string,
  limit = 8,
): WorkflowDiagEventRecord[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  return store.events
    .filter((event) => event.runId === runId)
    .slice()
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-safeLimit);
}

export function listRecentAutoDevGitCommitEventSummaries(
  store: WorkflowDiagStorePayload,
  limit: number,
): string[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  return store.events
    .filter((event) => event.kind === "autodev" && event.stage === "git_commit")
    .slice()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, safeLimit)
    .map((event) => `- at=${event.at} ${event.message}`);
}
