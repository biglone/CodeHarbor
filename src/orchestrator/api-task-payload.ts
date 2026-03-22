import type { InboundMessage } from "../types";
import { buildApiTaskEventId, buildSessionKey } from "./misc-utils";
import type { ApiTaskExternalContext, ApiTaskSubmitInput } from "./orchestrator-api-types";
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
  const externalContext = normalizeExternalContext(input.externalContext, message);
  return {
    message,
    sessionKey: buildSessionKey(message),
    payload: {
      apiTask: true,
      message,
      receivedAt: Date.now(),
      prompt: message.text,
      externalContext,
    },
  };
}

function normalizeExternalContext(
  input: Partial<ApiTaskExternalContext> | undefined,
  message: Pick<InboundMessage, "conversationId" | "senderId">,
): ApiTaskExternalContext {
  const source =
    input?.source === "api" || input?.source === "ci" || input?.source === "ticket" ? input.source : "api";
  return {
    source,
    eventId: normalizeNullableString(input?.eventId),
    workflowId: normalizeNullableString(input?.workflowId),
    externalRef: normalizeNullableString(input?.externalRef),
    matrixConversationId: normalizeNullableString(input?.matrixConversationId) ?? message.conversationId,
    matrixSenderId: normalizeNullableString(input?.matrixSenderId) ?? message.senderId,
    ci: normalizeCiContext(input?.ci),
    ticket: normalizeTicketContext(input?.ticket),
    metadata: normalizeMetadata(input?.metadata),
  };
}

function normalizeCiContext(value: ApiTaskExternalContext["ci"] | undefined): ApiTaskExternalContext["ci"] {
  if (!value) {
    return null;
  }
  return {
    repository: normalizeNullableString(value.repository),
    pipeline: normalizeNullableString(value.pipeline),
    status: normalizeNullableString(value.status),
    branch: normalizeNullableString(value.branch),
    commit: normalizeNullableString(value.commit),
    url: normalizeNullableString(value.url),
  };
}

function normalizeTicketContext(value: ApiTaskExternalContext["ticket"] | undefined): ApiTaskExternalContext["ticket"] {
  if (!value) {
    return null;
  }
  return {
    ticketId: normalizeNullableString(value.ticketId),
    title: normalizeNullableString(value.title),
    status: normalizeNullableString(value.status),
    priority: normalizeNullableString(value.priority),
    assignee: normalizeNullableString(value.assignee),
    url: normalizeNullableString(value.url),
  };
}

function normalizeMetadata(value: ApiTaskExternalContext["metadata"] | undefined): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    output[key] = normalized;
  }
  return output;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}
