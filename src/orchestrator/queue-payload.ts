import type { InboundMessage } from "../types";

export interface QueuedInboundPayload {
  message: InboundMessage;
  receivedAt: number;
  prompt: string | null;
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
  const receivedAt = parseQueuedReceivedAt(parsed.receivedAt);
  const prompt = parseQueuedPrompt(parsed.prompt, message.text);
  return {
    message,
    receivedAt,
    prompt,
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
