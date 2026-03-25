import { CodexExecutionCancelledError } from "../executor/codex-executor";
import type { RateLimitDecision } from "../rate-limiter";
import type { OutputLanguage } from "../config";
import { formatDurationMs, formatError } from "./helpers";
import { byOutputLanguage } from "./output-language";

export type ExecutionOutcome = "failed" | "timeout" | "cancelled";

export function buildRateLimitNotice(decision: RateLimitDecision, outputLanguage: OutputLanguage = "zh"): string {
  if (decision.reason === "user_requests_per_window" || decision.reason === "room_requests_per_window") {
    const retrySec = Math.max(1, Math.ceil((decision.retryAfterMs ?? 1_000) / 1_000));
    return byOutputLanguage(
      outputLanguage,
      `[CodeHarbor] 请求过于频繁，请在 ${retrySec} 秒后重试。`,
      `[CodeHarbor] Too many requests. Please retry in ${retrySec}s.`,
    );
  }
  return byOutputLanguage(
    outputLanguage,
    "[CodeHarbor] 当前任务并发较高，请稍后再试。",
    "[CodeHarbor] High concurrency right now. Please retry later.",
  );
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

export function buildFailureProgressSummary(
  status: ExecutionOutcome,
  startedAt: number,
  error: unknown,
  outputLanguage: OutputLanguage = "zh",
): string {
  const elapsed = formatDurationMs(Date.now() - startedAt);
  if (status === "cancelled") {
    return byOutputLanguage(outputLanguage, `处理已取消（耗时 ${elapsed}）`, `Cancelled (${elapsed})`);
  }
  if (status === "timeout") {
    return byOutputLanguage(
      outputLanguage,
      `处理超时（耗时 ${elapsed}）: ${formatError(error)}`,
      `Timed out (${elapsed}): ${formatError(error)}`,
    );
  }
  return byOutputLanguage(
    outputLanguage,
    `处理失败（耗时 ${elapsed}）: ${formatError(error)}`,
    `Failed (${elapsed}): ${formatError(error)}`,
  );
}

export function buildWorkflowResultReply(result: {
  objective: string;
  plan: string;
  output: string;
  review: string;
  approved: boolean;
  repairRounds: number;
  durationMs: number;
}, outputLanguage: OutputLanguage = "zh"): string {
  const verdict = result.approved ? "APPROVED" : "REJECTED";
  if (outputLanguage === "en") {
    const title = result.approved
      ? "[CodeHarbor] Multi-Agent workflow completed (approved)"
      : "[CodeHarbor] Multi-Agent workflow completed (reviewer rejected)";
    return `${title}
- objective: ${result.objective}
- finalVerdict: ${verdict}
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
  const title = result.approved ? "[CodeHarbor] 多智能体流程完成（审查通过）" : "[CodeHarbor] 多智能体流程完成（审查未通过）";
  return `${title}
- 目标: ${result.objective}
- 最终结论: ${verdict}
- 审查通过: ${result.approved ? "是" : "否"}
- 修复轮次: ${result.repairRounds}
- 耗时: ${formatDurationMs(result.durationMs)}

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
