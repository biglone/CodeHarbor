import type {
  WorkflowDiagRunKind,
  WorkflowDiagRunStatus,
  WorkflowDiagStorePayload,
} from "./workflow-diag";
import { summarizeSingleLine } from "./helpers";

interface BeginWorkflowDiagRunInput {
  store: WorkflowDiagStorePayload;
  maxRuns: number;
  kind: WorkflowDiagRunKind;
  sessionKey: string;
  conversationId: string;
  requestId: string;
  objective: string;
  taskId?: string | null;
  taskDescription?: string | null;
}

interface AppendWorkflowDiagEventInput {
  store: WorkflowDiagStorePayload;
  maxEvents: number;
  runId: string;
  kind: WorkflowDiagRunKind;
  stage: string;
  round: number;
  message: string;
}

interface FinishWorkflowDiagRunInput {
  store: WorkflowDiagStorePayload;
  runId: string;
  status: WorkflowDiagRunStatus;
  approved: boolean | null;
  repairRounds: number;
  error: string | null;
}

export function beginWorkflowDiagRun(input: BeginWorkflowDiagRunInput): string {
  const nowIso = new Date().toISOString();
  const runId = `${nowIso}-${Math.random().toString(36).slice(2, 8)}`;
  input.store.runs.push({
    runId,
    kind: input.kind,
    sessionKey: input.sessionKey,
    conversationId: input.conversationId,
    requestId: input.requestId,
    objective: summarizeSingleLine(input.objective, 800),
    taskId: input.taskId?.trim() || null,
    taskDescription: input.taskDescription?.trim() || null,
    status: "running",
    startedAt: nowIso,
    endedAt: null,
    durationMs: null,
    approved: null,
    repairRounds: 0,
    error: null,
    lastStage: null,
    lastMessage: null,
    updatedAt: nowIso,
  });
  if (input.store.runs.length > input.maxRuns) {
    const overflow = input.store.runs.length - input.maxRuns;
    const removedIds = new Set(input.store.runs.slice(0, overflow).map((run) => run.runId));
    input.store.runs.splice(0, overflow);
    if (removedIds.size > 0) {
      input.store.events = input.store.events.filter((event) => !removedIds.has(event.runId));
    }
  }
  input.store.updatedAt = nowIso;
  return runId;
}

export function appendWorkflowDiagEvent(input: AppendWorkflowDiagEventInput): void {
  const run = input.store.runs.find((item) => item.runId === input.runId);
  if (!run) {
    return;
  }
  const nowIso = new Date().toISOString();
  const normalizedStage = input.stage.trim() || "unknown";
  const normalizedMessage = summarizeSingleLine(input.message || "n/a", 600);
  input.store.events.push({
    runId: input.runId,
    kind: input.kind,
    stage: normalizedStage,
    round: Math.max(0, Math.floor(input.round)),
    message: normalizedMessage,
    at: nowIso,
  });
  if (input.store.events.length > input.maxEvents) {
    input.store.events.splice(0, input.store.events.length - input.maxEvents);
  }
  run.lastStage = normalizedStage;
  run.lastMessage = normalizedMessage;
  run.updatedAt = nowIso;
  input.store.updatedAt = nowIso;
}

export function finishWorkflowDiagRun(input: FinishWorkflowDiagRunInput): void {
  const run = input.store.runs.find((item) => item.runId === input.runId);
  if (!run) {
    return;
  }
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const startedAtMs = Date.parse(run.startedAt);
  run.status = input.status;
  run.endedAt = nowIso;
  run.durationMs = Number.isFinite(startedAtMs) ? Math.max(0, now - startedAtMs) : null;
  run.approved = input.approved;
  run.repairRounds = Math.max(0, Math.floor(input.repairRounds));
  run.error = input.error ? summarizeSingleLine(input.error, 1_000) : null;
  run.updatedAt = nowIso;
  input.store.updatedAt = nowIso;
}
