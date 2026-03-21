import type { TaskQueueRecord } from "../store/state-store";

export interface ApiTaskSubmitInput {
  conversationId: string;
  senderId: string;
  text: string;
  idempotencyKey: string;
  requestId?: string;
  isDirectMessage?: boolean;
  mentionsBot?: boolean;
  repliesToBot?: boolean;
}

export interface ApiTaskSubmitResult {
  created: boolean;
  task: TaskQueueRecord;
  sessionKey: string;
  eventId: string;
  requestId: string;
}

export type ApiTaskStage = "queued" | "retrying" | "executing" | "completed" | "failed";

export interface ApiTaskQueryResult {
  taskId: number;
  status: TaskQueueRecord["status"];
  stage: ApiTaskStage;
  errorSummary: string | null;
}

export class ApiTaskIdempotencyConflictError extends Error {
  readonly sessionKey: string;
  readonly eventId: string;

  constructor(sessionKey: string, eventId: string) {
    super(`Idempotency-Key conflict for session ${sessionKey}: payload differs from existing request.`);
    this.sessionKey = sessionKey;
    this.eventId = eventId;
  }
}
