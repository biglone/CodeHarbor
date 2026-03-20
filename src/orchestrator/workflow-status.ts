import { CodexExecutionCancelledError } from "../executor/codex-executor";
import type { RateLimitDecision } from "../rate-limiter";
import { formatDurationMs, formatError } from "./helpers";

export type ExecutionOutcome = "failed" | "timeout" | "cancelled";

export function buildRateLimitNotice(decision: RateLimitDecision): string {
  if (decision.reason === "user_requests_per_window" || decision.reason === "room_requests_per_window") {
    const retrySec = Math.max(1, Math.ceil((decision.retryAfterMs ?? 1_000) / 1_000));
    return `[CodeHarbor] 请求过于频繁，请在 ${retrySec} 秒后重试。`;
  }
  return "[CodeHarbor] 当前任务并发较高，请稍后再试。";
}

export function classifyExecutionOutcome(error: unknown): ExecutionOutcome {
  if (error instanceof CodexExecutionCancelledError) {
    return "cancelled";
  }
  const message = formatError(error).toLowerCase();
  if (message.includes("timed out")) {
    return "timeout";
  }
  return "failed";
}

export function buildFailureProgressSummary(status: ExecutionOutcome, startedAt: number, error: unknown): string {
  const elapsed = formatDurationMs(Date.now() - startedAt);
  if (status === "cancelled") {
    return `处理已取消（耗时 ${elapsed}）`;
  }
  if (status === "timeout") {
    return `处理超时（耗时 ${elapsed}）: ${formatError(error)}`;
  }
  return `处理失败（耗时 ${elapsed}）: ${formatError(error)}`;
}

export function buildWorkflowResultReply(result: {
  objective: string;
  plan: string;
  output: string;
  review: string;
  approved: boolean;
  repairRounds: number;
  durationMs: number;
}): string {
  return `[CodeHarbor] Multi-Agent workflow 完成
- objective: ${result.objective}
- approved: ${result.approved ? "yes" : "no"}
- repairRounds: ${result.repairRounds}
- duration: ${formatDurationMs(result.durationMs)}

[planner]
${result.plan}
[/planner]

[executor]
${result.output}
[/executor]

[reviewer]
${result.review}
[/reviewer]`;
}
