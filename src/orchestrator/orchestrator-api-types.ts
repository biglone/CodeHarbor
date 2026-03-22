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
  externalContext?: Partial<ApiTaskExternalContext>;
}

export interface ApiTaskSubmitResult {
  created: boolean;
  task: TaskQueueRecord;
  sessionKey: string;
  eventId: string;
  requestId: string;
}

export type ApiTaskStage = "queued" | "retrying" | "executing" | "completed" | "failed";

export type ApiTaskExternalSource = "api" | "ci" | "ticket";

export interface ApiTaskExternalContext {
  source: ApiTaskExternalSource;
  eventId: string | null;
  workflowId: string | null;
  externalRef: string | null;
  matrixConversationId: string;
  matrixSenderId: string;
  ci: {
    repository: string | null;
    pipeline: string | null;
    status: string | null;
    branch: string | null;
    commit: string | null;
    url: string | null;
  } | null;
  ticket: {
    ticketId: string | null;
    title: string | null;
    status: string | null;
    priority: string | null;
    assignee: string | null;
    url: string | null;
  } | null;
  metadata: Record<string, string>;
}

export interface ApiTaskLifecycleEvent {
  stage: ApiTaskStage;
  taskId: number;
  sessionKey: string;
  eventId: string;
  requestId: string;
  status: TaskQueueRecord["status"];
  attempt: number;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  nextRetryAt: number | null;
  errorSummary: string | null;
  externalContext: ApiTaskExternalContext;
}

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
