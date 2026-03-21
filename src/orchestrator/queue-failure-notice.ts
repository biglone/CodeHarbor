import type { Logger } from "../logger";
import { ARCHIVE_REASON_MAX_ATTEMPTS } from "../reliability/retry-policy";
import { formatError } from "./helpers";

interface QueueFailureNoticeInput {
  attempt: number;
  retryReason: string;
  archiveReason: string;
  retryAfterMs: number | null;
  detail: string;
}

interface QueueFailureNoticeDeps {
  taskQueueRetryMaxAttempts: number;
  sendMessage: (conversationId: string, text: string) => Promise<void>;
  logger: Logger;
}

export async function sendQueuedTaskFailureNotice(
  deps: QueueFailureNoticeDeps,
  conversationId: string,
  input: QueueFailureNoticeInput,
): Promise<void> {
  const reasonText =
    input.archiveReason === ARCHIVE_REASON_MAX_ATTEMPTS
      ? `达到最大重试次数(${deps.taskQueueRetryMaxAttempts})`
      : `不可重试错误(${input.archiveReason})`;
  const retryAfterText = input.retryAfterMs === null ? "n/a" : `${input.retryAfterMs}ms`;
  try {
    await deps.sendMessage(
      conversationId,
      `[CodeHarbor] 请求处理失败并已归档（attempt=${input.attempt}，retryReason=${input.retryReason}，archiveReason=${input.archiveReason}，retryAfterMs=${retryAfterText}，原因: ${reasonText}）：${input.detail}`,
    );
  } catch (error) {
    deps.logger.error("Failed to send queued task failure notice", {
      conversationId,
      error: formatError(error),
    });
  }
}
