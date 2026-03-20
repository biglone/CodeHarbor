import {
  formatDurationMs,
  formatWorkflowDiagRunDuration,
  summarizeSingleLine,
} from "./helpers";

export type WorkflowDiagRunKind = "workflow" | "autodev";
export type WorkflowDiagRunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface WorkflowDiagRunRecord {
  runId: string;
  kind: WorkflowDiagRunKind;
  sessionKey: string;
  conversationId: string;
  requestId: string;
  objective: string;
  taskId: string | null;
  taskDescription: string | null;
  status: WorkflowDiagRunStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  approved: boolean | null;
  repairRounds: number;
  error: string | null;
  lastStage: string | null;
  lastMessage: string | null;
  updatedAt: string;
}

export interface WorkflowDiagEventRecord {
  runId: string;
  kind: WorkflowDiagRunKind;
  stage: string;
  round: number;
  message: string;
  at: string;
}

export interface WorkflowDiagStorePayload {
  version: 1;
  updatedAt: string;
  runs: WorkflowDiagRunRecord[];
  events: WorkflowDiagEventRecord[];
}

export const WORKFLOW_DIAG_MAX_RUNS = 120;
export const WORKFLOW_DIAG_MAX_EVENTS = 2_000;

export function createEmptyWorkflowDiagStorePayload(): WorkflowDiagStorePayload {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    runs: [],
    events: [],
  };
}

export function parseWorkflowDiagStorePayload(payloadJson: string | null): WorkflowDiagStorePayload {
  if (!payloadJson || !payloadJson.trim()) {
    return createEmptyWorkflowDiagStorePayload();
  }
  try {
    const parsed = JSON.parse(payloadJson) as Partial<WorkflowDiagStorePayload> | null;
    if (!parsed || typeof parsed !== "object") {
      return createEmptyWorkflowDiagStorePayload();
    }
    const runs = Array.isArray(parsed.runs) ? parsed.runs.filter(isWorkflowDiagRunRecord) : [];
    const events = Array.isArray(parsed.events) ? parsed.events.filter(isWorkflowDiagEventRecord) : [];
    const updatedAt = typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt : new Date(0).toISOString();
    return {
      version: 1,
      updatedAt,
      runs: runs.slice(-WORKFLOW_DIAG_MAX_RUNS),
      events: events.slice(-WORKFLOW_DIAG_MAX_EVENTS),
    };
  } catch {
    return createEmptyWorkflowDiagStorePayload();
  }
}

export function formatAutoDevDiagRuns(
  runs: WorkflowDiagRunRecord[],
  resolveEvents: (runId: string) => WorkflowDiagEventRecord[],
): string {
  if (runs.length === 0) {
    return "- (empty)";
  }
  return runs
    .map((run) => {
      const stageText = run.lastStage ? `${run.lastStage}${run.lastMessage ? `(${run.lastMessage})` : ""}` : "N/A";
      const durationText = run.durationMs === null ? "running" : formatDurationMs(run.durationMs);
      const errorText = run.error ?? "none";
      const events = resolveEvents(run.runId);
      const eventSummary =
        events.length === 0
          ? "events=n/a"
          : `events=${events.map((event) => `${event.stage}#${event.round}`).join(" -> ")}`;
      return [
        `- run=${run.runId} status=${run.status} task=${run.taskId ?? "N/A"} approved=${
          run.approved === null ? "N/A" : run.approved ? "yes" : "no"
        } repairRounds=${run.repairRounds} duration=${durationText}`,
        `  lastStage=${stageText}`,
        `  ${eventSummary}`,
        `  error=${errorText}`,
      ].join("\n");
    })
    .join("\n");
}

export function formatAutoDevStatusRunSummaries(runs: WorkflowDiagRunRecord[]): string {
  if (runs.length === 0) {
    return "- (empty)";
  }
  return runs
    .map((run) => {
      const task = run.taskId
        ? `${run.taskId}${run.taskDescription ? ` ${run.taskDescription}` : ""}`.trim()
        : "N/A";
      const stage = run.lastStage ? `${run.lastStage}${run.lastMessage ? `(${run.lastMessage})` : ""}` : "N/A";
      const approvedText = run.approved === null ? "N/A" : run.approved ? "yes" : "no";
      return `- run=${run.runId} status=${run.status} task=${task} approved=${approvedText} duration=${formatWorkflowDiagRunDuration(run)} updatedAt=${run.updatedAt} lastStage=${summarizeSingleLine(stage, 180)}`;
    })
    .join("\n");
}

export function formatAutoDevStatusStageTrace(events: WorkflowDiagEventRecord[]): string {
  if (events.length === 0) {
    return "- (empty)";
  }
  return events
    .map((event, index) => {
      return `- #${index + 1} at=${event.at} stage=${event.stage} round=${event.round} message=${summarizeSingleLine(event.message, 180)}`;
    })
    .join("\n");
}

function isWorkflowDiagRunRecord(value: unknown): value is WorkflowDiagRunRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Partial<WorkflowDiagRunRecord>;
  if (typeof row.runId !== "string" || !row.runId.trim()) {
    return false;
  }
  if (row.kind !== "workflow" && row.kind !== "autodev") {
    return false;
  }
  if (typeof row.sessionKey !== "string" || typeof row.conversationId !== "string" || typeof row.requestId !== "string") {
    return false;
  }
  if (typeof row.objective !== "string" || typeof row.startedAt !== "string") {
    return false;
  }
  if (!(typeof row.taskId === "string" || row.taskId === null)) {
    return false;
  }
  if (!(typeof row.taskDescription === "string" || row.taskDescription === null)) {
    return false;
  }
  if (!["running", "succeeded", "failed", "cancelled"].includes(String(row.status ?? ""))) {
    return false;
  }
  if (!(typeof row.endedAt === "string" || row.endedAt === null)) {
    return false;
  }
  if (!(row.durationMs === null || (typeof row.durationMs === "number" && Number.isFinite(row.durationMs)))) {
    return false;
  }
  if (!(typeof row.approved === "boolean" || row.approved === null)) {
    return false;
  }
  if (typeof row.repairRounds !== "number" || !Number.isFinite(row.repairRounds)) {
    return false;
  }
  if (!(typeof row.error === "string" || row.error === null)) {
    return false;
  }
  if (!(typeof row.lastStage === "string" || row.lastStage === null)) {
    return false;
  }
  if (!(typeof row.lastMessage === "string" || row.lastMessage === null)) {
    return false;
  }
  if (typeof row.updatedAt !== "string") {
    return false;
  }
  return true;
}

function isWorkflowDiagEventRecord(value: unknown): value is WorkflowDiagEventRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Partial<WorkflowDiagEventRecord>;
  if (typeof row.runId !== "string" || !row.runId.trim()) {
    return false;
  }
  if (row.kind !== "workflow" && row.kind !== "autodev") {
    return false;
  }
  if (typeof row.stage !== "string" || typeof row.message !== "string" || typeof row.at !== "string") {
    return false;
  }
  if (typeof row.round !== "number" || !Number.isFinite(row.round)) {
    return false;
  }
  return true;
}
