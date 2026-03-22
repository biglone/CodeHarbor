import { buildApiTaskPayload } from "./api-task-payload";
import {
  ApiTaskIdempotencyConflictError,
  type ApiTaskLifecycleEvent,
  type ApiTaskSubmitInput,
  type ApiTaskSubmitResult,
} from "./orchestrator-api-types";
import { isApiTaskPayloadEquivalent, parseQueuedInboundPayload } from "./queue-payload";
import type { TaskQueueEnqueueInput, TaskQueueEnqueueResult } from "../store/state-store";

interface QueueStoreLike {
  enqueueTask: (input: TaskQueueEnqueueInput) => TaskQueueEnqueueResult;
}

interface SubmitApiTaskDeps {
  startSessionQueueDrain: (sessionKey: string) => void;
  emitApiTaskLifecycleEvent?: (event: ApiTaskLifecycleEvent) => void;
}

export function submitApiTask(
  deps: SubmitApiTaskDeps,
  queueStore: QueueStoreLike,
  input: ApiTaskSubmitInput,
): ApiTaskSubmitResult {
  const { message, sessionKey, payload } = buildApiTaskPayload(input);
  const result = queueStore.enqueueTask({
    sessionKey,
    eventId: message.eventId,
    requestId: message.requestId,
    payloadJson: JSON.stringify(payload),
  });

  if (!result.created) {
    const existing = parseQueuedInboundPayload(result.task.payloadJson);
    if (!isApiTaskPayloadEquivalent(existing.message, message)) {
      throw new ApiTaskIdempotencyConflictError(sessionKey, message.eventId);
    }
  }

  if (result.created) {
    deps.emitApiTaskLifecycleEvent?.({
      stage: "queued",
      taskId: result.task.id,
      sessionKey,
      eventId: result.task.eventId,
      requestId: result.task.requestId,
      status: result.task.status,
      attempt: result.task.attempt,
      enqueuedAt: result.task.enqueuedAt,
      startedAt: result.task.startedAt,
      finishedAt: result.task.finishedAt,
      nextRetryAt: result.task.nextRetryAt,
      errorSummary: result.task.error ?? result.task.lastError,
      externalContext: payload.externalContext,
    });
  }

  deps.startSessionQueueDrain(sessionKey);
  return {
    created: result.created,
    task: result.task,
    sessionKey,
    eventId: result.task.eventId,
    requestId: result.task.requestId,
  };
}
