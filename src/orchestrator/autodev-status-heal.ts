import type { AutoDevTask, AutoDevTaskStatus } from "../workflow/autodev";
import { updateAutoDevTaskStatus } from "../workflow/autodev";
import type { WorkflowDiagRunRecord } from "./workflow-diag";

export interface AutoDevStatusHealChange {
  taskId: string;
  from: AutoDevTaskStatus;
  to: AutoDevTaskStatus;
  runId: string;
}

interface HealAutoDevTaskStatusesInput {
  taskListPath: string;
  tasks: AutoDevTask[];
  runs: WorkflowDiagRunRecord[];
  targetTaskIds?: string[] | null;
}

export async function healAutoDevTaskStatuses(input: HealAutoDevTaskStatusesInput): Promise<AutoDevStatusHealChange[]> {
  const latestRunByTask = new Map<string, WorkflowDiagRunRecord>();
  for (const run of input.runs) {
    if (!run.taskId || run.status !== "succeeded") {
      continue;
    }
    const normalizedTaskId = run.taskId.trim().toLowerCase();
    if (!normalizedTaskId || latestRunByTask.has(normalizedTaskId)) {
      continue;
    }
    latestRunByTask.set(normalizedTaskId, run);
  }

  const targetFilter =
    input.targetTaskIds && input.targetTaskIds.length > 0
      ? new Set(input.targetTaskIds.map((taskId) => taskId.trim().toLowerCase()).filter(Boolean))
      : null;

  const changes: AutoDevStatusHealChange[] = [];
  for (const task of input.tasks) {
    const normalizedTaskId = task.id.trim().toLowerCase();
    if (!normalizedTaskId) {
      continue;
    }
    if (targetFilter && !targetFilter.has(normalizedTaskId)) {
      continue;
    }
    if (task.status === "blocked" || task.status === "cancelled") {
      continue;
    }
    const run = latestRunByTask.get(normalizedTaskId);
    if (!run) {
      continue;
    }
    const expectedStatus = deriveExpectedTaskStatusFromRun(run);
    if (!expectedStatus || expectedStatus === task.status) {
      continue;
    }
    const updated = await updateAutoDevTaskStatus(input.taskListPath, task, expectedStatus);
    changes.push({
      taskId: updated.id,
      from: task.status,
      to: updated.status,
      runId: run.runId,
    });
  }

  return changes;
}

function deriveExpectedTaskStatusFromRun(run: WorkflowDiagRunRecord): AutoDevTaskStatus | null {
  const lastMessage = run.lastMessage ?? null;
  const statusFromMessage = parseTaskStatusFromRunMessage(lastMessage);
  if (statusFromMessage) {
    return statusFromMessage;
  }
  const completionGateFromMessage = parseCompletionGateFromRunMessage(lastMessage);
  if (completionGateFromMessage === "passed") {
    return "completed";
  }
  if (completionGateFromMessage === "failed") {
    return "in_progress";
  }
  if (run.approved === false) {
    return "in_progress";
  }
  return null;
}

function parseTaskStatusFromRunMessage(message: string | null): AutoDevTaskStatus | null {
  if (!message) {
    return null;
  }
  const match = message.match(/taskStatus\s*=\s*(⬜|🔄|✅|❌|🚫)/u);
  const symbol = match?.[1];
  if (symbol === "⬜") {
    return "pending";
  }
  if (symbol === "🔄") {
    return "in_progress";
  }
  if (symbol === "✅") {
    return "completed";
  }
  if (symbol === "❌") {
    return "cancelled";
  }
  if (symbol === "🚫") {
    return "blocked";
  }
  return null;
}

function parseCompletionGateFromRunMessage(message: string | null): "passed" | "failed" | null {
  if (!message) {
    return null;
  }
  const match = message.match(/completionGate\s*[:=]\s*(passed|failed)/i);
  if (!match) {
    return null;
  }
  const gate = match[1].toLowerCase();
  if (gate === "passed" || gate === "failed") {
    return gate;
  }
  return null;
}
