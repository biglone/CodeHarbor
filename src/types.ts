export interface InboundAttachment {
  kind: "image" | "file" | "audio" | "video";
  name: string;
  mxcUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface InboundMessage {
  requestId: string;
  channel: "matrix";
  conversationId: string;
  senderId: string;
  eventId: string;
  text: string;
  attachments: InboundAttachment[];
  isDirectMessage: boolean;
  mentionsBot: boolean;
  repliesToBot: boolean;
}

export interface CodexExecutionResult {
  sessionId: string;
  reply: string;
}

export interface SessionState {
  codexSessionId: string | null;
  processedEventIds: string[];
  activeUntil: string | null;
  updatedAt: string;
}

export interface StateData {
  sessions: Record<string, SessionState>;
}
