import { classifyExecutionOutcome } from "./workflow-status";
import { formatError } from "./helpers";
import type { OutputLanguage } from "../config";
import { byOutputLanguage } from "./output-language";

interface FailureNoticeDeps {
  outputLanguage: OutputLanguage;
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
    const label =
      kind === "workflow"
        ? byOutputLanguage(deps.outputLanguage, "多智能体流程已取消。", "Multi-Agent workflow was cancelled.")
        : byOutputLanguage(deps.outputLanguage, "AutoDev 已取消。", "AutoDev was cancelled.");
    await deps.sendNotice(conversationId, `[CodeHarbor] ${label}`);
    return Date.now() - startedAt;
  }

  const label =
    kind === "workflow"
      ? byOutputLanguage(deps.outputLanguage, "多智能体流程失败", "Multi-Agent workflow failed")
      : byOutputLanguage(deps.outputLanguage, "AutoDev 失败", "AutoDev failed");
  await deps.sendMessage(conversationId, `[CodeHarbor] ${label}: ${formatError(error)}`);
  return Date.now() - startedAt;
}
