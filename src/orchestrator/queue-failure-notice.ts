import type { Logger } from "../logger";
import type { OutputLanguage } from "../config";
import { ARCHIVE_REASON_MAX_ATTEMPTS } from "../reliability/retry-policy";
import { formatError } from "./helpers";
import { byOutputLanguage } from "./output-language";

interface QueueFailureNoticeInput {
  attempt: number;
  retryReason: string;
  archiveReason: string;
  retryAfterMs: number | null;
  detail: string;
}

interface QueueFailureNoticeDeps {
  outputLanguage: OutputLanguage;
  taskQueueRetryMaxAttempts: number;
  sendMessage: (conversationId: string, text: string) => Promise<void>;
  logger: Logger;
}

export async function sendQueuedTaskFailureNotice(
  deps: QueueFailureNoticeDeps,
  conversationId: string,
  input: QueueFailureNoticeInput,
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  const reasonText =
    input.archiveReason === ARCHIVE_REASON_MAX_ATTEMPTS
      ? localize(`达到最大重试次数(${deps.taskQueueRetryMaxAttempts})`, `max retry attempts reached (${deps.taskQueueRetryMaxAttempts})`)
      : localize(`不可重试错误(${input.archiveReason})`, `non-retryable error (${input.archiveReason})`);
  const retryAfterText = input.retryAfterMs === null ? "N/A" : `${input.retryAfterMs}ms`;
  try {
    await deps.sendMessage(
      conversationId,
      localize(
        `[CodeHarbor] 请求处理失败并已归档（attempt=${input.attempt}，retryReason=${input.retryReason}，archiveReason=${input.archiveReason}，retryAfterMs=${retryAfterText}，原因: ${reasonText}）：${input.detail}`,
        `[CodeHarbor] Request failed and archived (attempt=${input.attempt}, retryReason=${input.retryReason}, archiveReason=${input.archiveReason}, retryAfterMs=${retryAfterText}, reason=${reasonText}): ${input.detail}`,
      ),
    );
  } catch (error) {
    deps.logger.error("Failed to send queued task failure notice", {
      conversationId,
      error: formatError(error),
    });
  }
}
