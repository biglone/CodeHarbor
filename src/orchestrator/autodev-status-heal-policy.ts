import type { AutoDevTaskStatus } from "../workflow/autodev";
import type { WorkflowDiagRunRecord } from "./workflow-diag";

export function deriveExpectedAutoDevTaskStatusFromRun(run: WorkflowDiagRunRecord): AutoDevTaskStatus | null {
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
