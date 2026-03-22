import type { Logger } from "../logger";
import { ARCHIVE_REASON_NON_RETRYABLE, type RetryPolicy } from "../reliability/retry-policy";
import type { InboundMessage } from "../types";
import { formatError, summarizeSingleLine } from "./helpers";
import { classifyQueueTaskRetry } from "./misc-utils";
import type { ApiTaskLifecycleEvent } from "./orchestrator-api-types";
import { parseQueuedInboundPayload, type QueuedInboundPayload } from "./queue-payload";

interface TaskQueueRecordLike {
  id: number;
  sessionKey: string;
  eventId: string;
  requestId: string;
  attempt: number;
  status: "pending" | "running" | "succeeded" | "failed";
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  nextRetryAt: number | null;
  error: string | null;
  lastError: string | null;
  payloadJson: string;
}

interface TaskQueueStateStoreLike {
  claimNextTask: (sessionKey: string) => TaskQueueRecordLike | null;
  finishTask: (taskId: number) => void;
  scheduleRetry: (taskId: number, input: { nextRetryAt: number; error: string }) => void;
  failAndArchive: (
    taskId: number,
    input: {
      error: string;
      retryReason: string;
      archiveReason: string;
      retryAfterMs: number | null;
    },
  ) => void;
}

interface QueueTaskFailureNoticeInput {
  attempt: number;
  retryReason: string;
  archiveReason: string;
  retryAfterMs: number | null;
  detail: string;
}

interface DrainSessionQueueDeps {
  logger: Logger;
  taskQueueRetryPolicy: RetryPolicy;
  handleMessageInternal: (
    message: InboundMessage,
    receivedAt: number,
    options: {
      bypassQueue: boolean;
      forcedPrompt: string | null;
      deferFailureHandlingToQueue: boolean;
    },
  ) => Promise<void>;
  commitExecutionHandled: (sessionKey: string, eventId: string) => void;
  sendQueuedTaskFailureNotice: (conversationId: string, input: QueueTaskFailureNoticeInput) => Promise<void>;
  emitApiTaskLifecycleEvent?: (event: ApiTaskLifecycleEvent) => void;
}

interface DrainSessionQueueInput {
  sessionKey: string;
  queueStore: TaskQueueStateStoreLike;
}

export async function drainSessionQueue(
  deps: DrainSessionQueueDeps,
  input: DrainSessionQueueInput,
): Promise<void> {
  while (true) {
    const task = input.queueStore.claimNextTask(input.sessionKey);
    if (!task) {
      return;
    }

    let payload: QueuedInboundPayload | null = null;
    try {
      payload = parseQueuedInboundPayload(task.payloadJson);
      if (payload.apiTask) {
        deps.emitApiTaskLifecycleEvent?.({
          stage: "executing",
          taskId: task.id,
          sessionKey: task.sessionKey,
          eventId: task.eventId,
          requestId: task.requestId,
          status: "running",
          attempt: task.attempt,
          enqueuedAt: task.enqueuedAt,
          startedAt: task.startedAt,
          finishedAt: null,
          nextRetryAt: null,
          errorSummary: null,
          externalContext: payload.externalContext,
        });
      }
      await deps.handleMessageInternal(payload.message, payload.receivedAt, {
        bypassQueue: true,
        forcedPrompt: payload.prompt,
        deferFailureHandlingToQueue: true,
      });
      input.queueStore.finishTask(task.id);
      if (payload.apiTask) {
        deps.emitApiTaskLifecycleEvent?.({
          stage: "completed",
          taskId: task.id,
          sessionKey: task.sessionKey,
          eventId: task.eventId,
          requestId: task.requestId,
          status: "succeeded",
          attempt: task.attempt,
          enqueuedAt: task.enqueuedAt,
          startedAt: task.startedAt,
          finishedAt: Date.now(),
          nextRetryAt: null,
          errorSummary: null,
          externalContext: payload.externalContext,
        });
      }
      deps.logger.debug("Queued task completed", {
        taskId: task.id,
        sessionKey: task.sessionKey,
        eventId: task.eventId,
        attempt: task.attempt,
      });
    } catch (error) {
      const detail = summarizeSingleLine(formatError(error), 400);
      const retryDecision = classifyQueueTaskRetry(deps.taskQueueRetryPolicy, task.attempt, error);

      if (retryDecision.shouldRetry) {
        const delayMs = retryDecision.retryDelayMs ?? 0;
        const nextRetryAt = Date.now() + delayMs;
        input.queueStore.scheduleRetry(task.id, {
          nextRetryAt,
          error: detail,
        });
        if (payload?.apiTask) {
          deps.emitApiTaskLifecycleEvent?.({
            stage: "retrying",
            taskId: task.id,
            sessionKey: task.sessionKey,
            eventId: task.eventId,
            requestId: task.requestId,
            status: "pending",
            attempt: task.attempt,
            enqueuedAt: task.enqueuedAt,
            startedAt: null,
            finishedAt: null,
            nextRetryAt,
            errorSummary: detail,
            externalContext: payload.externalContext,
          });
        }
        deps.logger.warn("Queued task scheduled for retry", {
          taskId: task.id,
          sessionKey: task.sessionKey,
          eventId: task.eventId,
          attempt: task.attempt,
          retryable: retryDecision.retryable,
          nextRetryAt,
          nextRetryAtIso: new Date(nextRetryAt).toISOString(),
          retryDelayMs: delayMs,
          retryReason: retryDecision.retryReason,
          retryAfterMs: retryDecision.retryAfterMs,
          error: formatError(error),
        });
        continue;
      }

      const archiveReason = retryDecision.archiveReason ?? ARCHIVE_REASON_NON_RETRYABLE;
      input.queueStore.failAndArchive(task.id, {
        error: detail,
        retryReason: retryDecision.retryReason,
        archiveReason,
        retryAfterMs: retryDecision.retryAfterMs,
      });
      deps.commitExecutionHandled(task.sessionKey, task.eventId);

      if (payload?.apiTask) {
        deps.emitApiTaskLifecycleEvent?.({
          stage: "failed",
          taskId: task.id,
          sessionKey: task.sessionKey,
          eventId: task.eventId,
          requestId: task.requestId,
          status: "failed",
          attempt: task.attempt,
          enqueuedAt: task.enqueuedAt,
          startedAt: task.startedAt,
          finishedAt: Date.now(),
          nextRetryAt: null,
          errorSummary: detail,
          externalContext: payload.externalContext,
        });
      }

      if (payload && archiveReason !== "cancelled") {
        await deps.sendQueuedTaskFailureNotice(payload.message.conversationId, {
          attempt: task.attempt,
          retryReason: retryDecision.retryReason,
          archiveReason,
          retryAfterMs: retryDecision.retryAfterMs,
          detail,
        });
      }

      deps.logger.error("Queued task archived after failure", {
        taskId: task.id,
        sessionKey: task.sessionKey,
        eventId: task.eventId,
        attempt: task.attempt,
        retryable: retryDecision.retryable,
        retryReason: retryDecision.retryReason,
        retryAfterMs: retryDecision.retryAfterMs,
        archiveReason,
        error: formatError(error),
      });
    }
  }
}
