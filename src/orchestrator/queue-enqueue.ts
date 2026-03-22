import type { TaskQueueEnqueueInput } from "../store/state-store";
import type { InboundMessage } from "../types";
import type { QueuedInboundPayload } from "./queue-payload";

interface QueueStoreLike {
  enqueueTask: (input: TaskQueueEnqueueInput) => { created: boolean; task: { id: number } };
}

interface TryEnqueueQueuedInboundRequestDeps {
  getTaskQueueStateStore: () => QueueStoreLike | null;
}

interface TryEnqueueQueuedInboundRequestInput {
  bypassQueue: boolean;
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
  receivedAt: number;
  routePrompt: string;
}

interface TryEnqueueQueuedInboundRequestResult {
  queued: boolean;
  duplicate: boolean;
  taskId: number | null;
}

export function tryEnqueueQueuedInboundRequest(
  deps: TryEnqueueQueuedInboundRequestDeps,
  input: TryEnqueueQueuedInboundRequestInput,
): TryEnqueueQueuedInboundRequestResult {
  if (input.bypassQueue) {
    return { queued: false, duplicate: false, taskId: null };
  }

  const queueStore = deps.getTaskQueueStateStore();
  if (!queueStore) {
    return { queued: false, duplicate: false, taskId: null };
  }

  const payload: QueuedInboundPayload = {
    apiTask: false,
    message: input.message,
    receivedAt: input.receivedAt,
    prompt: input.routePrompt,
    externalContext: {
      source: "api",
      eventId: null,
      workflowId: null,
      externalRef: null,
      matrixConversationId: input.message.conversationId,
      matrixSenderId: input.message.senderId,
      ci: null,
      ticket: null,
      metadata: {},
    },
  };
  const enqueueResult = queueStore.enqueueTask({
    sessionKey: input.sessionKey,
    eventId: input.message.eventId,
    requestId: input.requestId,
    payloadJson: JSON.stringify(payload),
  } satisfies TaskQueueEnqueueInput);

  if (!enqueueResult.created) {
    return { queued: false, duplicate: true, taskId: null };
  }

  return { queued: true, duplicate: false, taskId: enqueueResult.task.id };
}
