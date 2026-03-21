import { classifyExecutionOutcome } from "./workflow-status";
import { formatError } from "./helpers";

interface FailureNoticeDeps {
  sendNotice: (conversationId: string, text: string) => Promise<void>;
  sendMessage: (conversationId: string, text: string) => Promise<void>;
}

export async function sendFailureNotice(
  deps: FailureNoticeDeps,
  conversationId: string,
  error: unknown,
  kind: "workflow" | "autodev",
): Promise<number> {
  const startedAt = Date.now();
  const status = classifyExecutionOutcome(error);
  if (status === "cancelled") {
    const label = kind === "workflow" ? "Multi-Agent workflow 已取消。" : "AutoDev 已取消。";
    await deps.sendNotice(conversationId, `[CodeHarbor] ${label}`);
    return Date.now() - startedAt;
  }

  const label = kind === "workflow" ? "Multi-Agent workflow 失败" : "AutoDev 失败";
  await deps.sendMessage(conversationId, `[CodeHarbor] ${label}: ${formatError(error)}`);
  return Date.now() - startedAt;
}
