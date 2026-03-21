import { buildApiTaskPayload } from "./api-task-payload";
import { ApiTaskIdempotencyConflictError, type ApiTaskSubmitInput, type ApiTaskSubmitResult } from "./orchestrator-api-types";
import { isApiTaskPayloadEquivalent, parseQueuedInboundPayload } from "./queue-payload";
import type { TaskQueueEnqueueInput, TaskQueueEnqueueResult } from "../store/state-store";

interface QueueStoreLike {
  enqueueTask: (input: TaskQueueEnqueueInput) => TaskQueueEnqueueResult;
}

interface SubmitApiTaskDeps {
  startSessionQueueDrain: (sessionKey: string) => void;
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

  deps.startSessionQueueDrain(sessionKey);
  return {
    created: result.created,
    task: result.task,
    sessionKey,
    eventId: result.task.eventId,
    requestId: result.task.requestId,
  };
}
