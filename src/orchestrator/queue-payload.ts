import type { InboundMessage } from "../types";
import type { ApiTaskExternalContext, ApiTaskExternalSource } from "./orchestrator-api-types";

export interface QueuedInboundPayload {
  apiTask: boolean;
  message: InboundMessage;
  receivedAt: number;
  prompt: string | null;
  externalContext: ApiTaskExternalContext;
}

export function normalizeApiTaskRequestId(requestId: string | undefined, eventId: string): string {
  const normalized = requestId?.trim();
  if (normalized) {
    return normalized;
  }
  return `api-${eventId.slice(1)}`;
}

export function isApiTaskPayloadEquivalent(left: InboundMessage, right: InboundMessage): boolean {
  return buildApiTaskPayloadFingerprint(left) === buildApiTaskPayloadFingerprint(right);
}

export function parseQueuedInboundPayload(payloadJson: string): QueuedInboundPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error("Invalid queued payload JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("Invalid queued payload shape.");
  }

  const message = parseQueuedInboundMessage(parsed.message);
  const apiTask = parseQueuedApiTaskFlag(parsed.apiTask);
  const receivedAt = parseQueuedReceivedAt(parsed.receivedAt);
  const prompt = parseQueuedPrompt(parsed.prompt, message.text);
  const externalContext = parseQueuedExternalContext(parsed.externalContext, message);
  return {
    apiTask,
    message,
    receivedAt,
    prompt,
    externalContext,
  };
}

function buildApiTaskPayloadFingerprint(message: InboundMessage): string {
  return JSON.stringify({
    channel: message.channel,
    conversationId: message.conversationId.trim(),
    senderId: message.senderId.trim(),
    text: message.text.trim(),
    isDirectMessage: message.isDirectMessage,
    mentionsBot: message.mentionsBot,
    repliesToBot: message.repliesToBot,
    attachments: message.attachments.map((attachment) => ({
      kind: attachment.kind,
      name: attachment.name,
      mxcUrl: attachment.mxcUrl,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      localPath: attachment.localPath,
    })),
  });
}

function parseQueuedInboundMessage(value: unknown): InboundMessage {
  if (!isRecord(value)) {
    throw new Error("Invalid queued payload message.");
  }
  const eventId = parseRequiredString(value.eventId, "message.eventId");
  const requestId = parseOptionalString(value.requestId, eventId);
  const channelRaw = parseOptionalString(value.channel, "matrix");
  if (channelRaw !== "matrix") {
    throw new Error(`Unsupported queued payload channel: ${channelRaw}`);
  }
  const attachments = parseQueuedAttachments(value.attachments);
  return {
    requestId,
    channel: "matrix",
    conversationId: parseRequiredString(value.conversationId, "message.conversationId"),
    senderId: parseRequiredString(value.senderId, "message.senderId"),
    eventId,
    text: parseOptionalString(value.text, ""),
    attachments,
    isDirectMessage: parseOptionalBoolean(value.isDirectMessage),
    mentionsBot: parseOptionalBoolean(value.mentionsBot),
    repliesToBot: parseOptionalBoolean(value.repliesToBot),
  };
}

function parseQueuedAttachments(value: unknown): InboundMessage["attachments"] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Invalid queued payload attachments.");
  }
  return value.map((attachment, index) => parseQueuedAttachment(attachment, index));
}

function parseQueuedAttachment(value: unknown, index: number): InboundMessage["attachments"][number] {
  if (!isRecord(value)) {
    throw new Error(`Invalid queued attachment #${index + 1}.`);
  }
  const kind = parseRequiredString(value.kind, `attachments[${index}].kind`);
  if (kind !== "image" && kind !== "file" && kind !== "audio" && kind !== "video") {
    throw new Error(`Invalid queued attachment kind: ${kind}`);
  }
  return {
    kind,
    name: parseRequiredString(value.name, `attachments[${index}].name`),
    mxcUrl: parseNullableString(value.mxcUrl, `attachments[${index}].mxcUrl`),
    mimeType: parseNullableString(value.mimeType, `attachments[${index}].mimeType`),
    sizeBytes: parseNullableNumber(value.sizeBytes, `attachments[${index}].sizeBytes`),
    localPath: parseNullableString(value.localPath, `attachments[${index}].localPath`),
  };
}

function parseQueuedReceivedAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid queued payload receivedAt.");
  }
  return value;
}

function parseQueuedPrompt(value: unknown, fallbackText: string): string | null {
  if (value === undefined) {
    return fallbackText;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Invalid queued payload prompt.");
  }
  return value;
}

function parseQueuedApiTaskFlag(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error("Invalid queued payload apiTask.");
  }
  return value;
}

function parseQueuedExternalContext(value: unknown, message: InboundMessage): ApiTaskExternalContext {
  const fallback = createDefaultExternalContext(message);
  if (!isRecord(value)) {
    return fallback;
  }

  const sourceRaw = parseNullableString(value.source, "externalContext.source");
  const source = normalizeExternalSource(sourceRaw) ?? fallback.source;
  const ci = parseQueuedCiContext(value.ci);
  const ticket = parseQueuedTicketContext(value.ticket);

  return {
    source,
    eventId: parseNullableString(value.eventId, "externalContext.eventId"),
    workflowId: parseNullableString(value.workflowId, "externalContext.workflowId"),
    externalRef: parseNullableString(value.externalRef, "externalContext.externalRef"),
    matrixConversationId:
      parseNullableString(value.matrixConversationId, "externalContext.matrixConversationId") ?? message.conversationId,
    matrixSenderId: parseNullableString(value.matrixSenderId, "externalContext.matrixSenderId") ?? message.senderId,
    ci,
    ticket,
    metadata: parseQueuedMetadata(value.metadata),
  };
}

function createDefaultExternalContext(message: InboundMessage): ApiTaskExternalContext {
  return {
    source: "api",
    eventId: null,
    workflowId: null,
    externalRef: null,
    matrixConversationId: message.conversationId,
    matrixSenderId: message.senderId,
    ci: null,
    ticket: null,
    metadata: {},
  };
}

function normalizeExternalSource(value: string | null): ApiTaskExternalSource | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "api" || normalized === "ci" || normalized === "ticket") {
    return normalized;
  }
  return null;
}

function parseQueuedCiContext(value: unknown): ApiTaskExternalContext["ci"] {
  if (!isRecord(value)) {
    return null;
  }
  return {
    repository: parseNullableString(value.repository, "externalContext.ci.repository"),
    pipeline: parseNullableString(value.pipeline, "externalContext.ci.pipeline"),
    status: parseNullableString(value.status, "externalContext.ci.status"),
    branch: parseNullableString(value.branch, "externalContext.ci.branch"),
    commit: parseNullableString(value.commit, "externalContext.ci.commit"),
    url: parseNullableString(value.url, "externalContext.ci.url"),
  };
}

function parseQueuedTicketContext(value: unknown): ApiTaskExternalContext["ticket"] {
  if (!isRecord(value)) {
    return null;
  }
  return {
    ticketId: parseNullableString(value.ticketId, "externalContext.ticket.ticketId"),
    title: parseNullableString(value.title, "externalContext.ticket.title"),
    status: parseNullableString(value.status, "externalContext.ticket.status"),
    priority: parseNullableString(value.priority, "externalContext.ticket.priority"),
    assignee: parseNullableString(value.assignee, "externalContext.ticket.assignee"),
    url: parseNullableString(value.url, "externalContext.ticket.url"),
  };
}

function parseQueuedMetadata(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
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

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid queued payload ${fieldName}.`);
  }
  return value;
}

function parseOptionalString(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error("Invalid queued payload string value.");
  }
  return value;
}

function parseOptionalBoolean(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error("Invalid queued payload boolean value.");
  }
  return value;
}

function parseNullableString(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid queued payload ${fieldName}.`);
  }
  return value;
}

function parseNullableNumber(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid queued payload ${fieldName}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
