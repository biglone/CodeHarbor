import type { InboundMessage } from "../types";
import { buildApiTaskEventId, buildSessionKey } from "./misc-utils";
import type { ApiTaskSubmitInput } from "./orchestrator-api-types";
import { normalizeApiTaskRequestId, type QueuedInboundPayload } from "./queue-payload";

export function buildApiTaskPayload(input: ApiTaskSubmitInput): {
  message: InboundMessage;
  sessionKey: string;
  payload: QueuedInboundPayload;
} {
  const normalizedConversationId = input.conversationId.trim();
  const normalizedSenderId = input.senderId.trim();
  const normalizedText = input.text.trim();
  const eventId = buildApiTaskEventId(input.idempotencyKey);
  const requestId = normalizeApiTaskRequestId(input.requestId, eventId);
  const message: InboundMessage = {
    requestId,
    channel: "matrix",
    conversationId: normalizedConversationId,
    senderId: normalizedSenderId,
    eventId,
    text: normalizedText,
    attachments: [],
    isDirectMessage: input.isDirectMessage ?? true,
    mentionsBot: input.mentionsBot ?? false,
    repliesToBot: input.repliesToBot ?? false,
  };
  return {
    message,
    sessionKey: buildSessionKey(message),
    payload: {
      message,
      receivedAt: Date.now(),
      prompt: message.text,
    },
  };
}
