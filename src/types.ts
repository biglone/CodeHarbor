export interface InboundMessage {
  channel: "matrix";
  conversationId: string;
  senderId: string;
  eventId: string;
  text: string;
}

export interface CodexExecutionResult {
  sessionId: string;
  reply: string;
}

export interface SessionState {
  codexSessionId: string | null;
  processedEventIds: string[];
  updatedAt: string;
}

export interface StateData {
  sessions: Record<string, SessionState>;
}
