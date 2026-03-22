import { setTimeout as sleep } from "node:timers/promises";

import type { ExternalTaskIntegrationConfig } from "./config";
import type { Logger } from "./logger";
import type { ApiTaskLifecycleEvent } from "./orchestrator/orchestrator-api-types";

type IntegrationSink = "notify" | "ticket";
type IntegrationOutcome = "allowed" | "error";

export interface ExternalTaskIntegrationAuditEvent {
  sink: IntegrationSink;
  targetUrl: string;
  stage: ApiTaskLifecycleEvent["stage"];
  taskId: number;
  source: ApiTaskLifecycleEvent["externalContext"]["source"];
  outcome: IntegrationOutcome;
  reason: string | null;
  attempts: number;
}

interface ExternalTaskIntegrationDispatcherOptions {
  auditRecorder?: (event: ExternalTaskIntegrationAuditEvent) => void;
}

export class ExternalTaskIntegrationDispatcher {
  private readonly logger: Logger;
  private readonly config: ExternalTaskIntegrationConfig;
  private readonly auditRecorder: ((event: ExternalTaskIntegrationAuditEvent) => void) | null;

  constructor(
    logger: Logger,
    config: ExternalTaskIntegrationConfig,
    options: ExternalTaskIntegrationDispatcherOptions = {},
  ) {
    this.logger = logger;
    this.config = config;
    this.auditRecorder = options.auditRecorder ?? null;
  }

  emitTaskLifecycle(event: ApiTaskLifecycleEvent): void {
    if (!this.config.enabled) {
      return;
    }
    const shouldSendNotify = Boolean(this.config.notifyWebhookUrl);
    const shouldSendTicket = Boolean(this.config.ticketWebhookUrl) && shouldDispatchTicketSink(event);
    if (!shouldSendNotify && !shouldSendTicket) {
      return;
    }
    void this.dispatchTaskLifecycle(event);
  }

  private async dispatchTaskLifecycle(event: ApiTaskLifecycleEvent): Promise<void> {
    const deliveries: Promise<void>[] = [];
    if (this.config.notifyWebhookUrl) {
      deliveries.push(
        this.deliverWithRetry({
          sink: "notify",
          targetUrl: this.config.notifyWebhookUrl,
          eventType: "task.lifecycle",
          payload: buildLifecyclePayload(event),
          event,
        }),
      );
    }
    if (this.config.ticketWebhookUrl && shouldDispatchTicketSink(event)) {
      deliveries.push(
        this.deliverWithRetry({
          sink: "ticket",
          targetUrl: this.config.ticketWebhookUrl,
          eventType: "ticket.status",
          payload: buildTicketPayload(event),
          event,
        }),
      );
    }
    if (deliveries.length === 0) {
      return;
    }
    await Promise.allSettled(deliveries);
  }

  private async deliverWithRetry(input: {
    sink: IntegrationSink;
    targetUrl: string;
    eventType: string;
    payload: Record<string, unknown>;
    event: ApiTaskLifecycleEvent;
  }): Promise<void> {
    const maxAttempts = this.config.maxRetries + 1;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        await this.postJson(input.targetUrl, input.payload, input.eventType);
        this.recordAudit({
          sink: input.sink,
          targetUrl: input.targetUrl,
          stage: input.event.stage,
          taskId: input.event.taskId,
          source: input.event.externalContext.source,
          outcome: "allowed",
          reason: null,
          attempts: attempt,
        });
        return;
      } catch (error) {
        const errorMessage = formatError(error);
        const isLastAttempt = attempt >= maxAttempts;
        if (isLastAttempt) {
          this.recordAudit({
            sink: input.sink,
            targetUrl: input.targetUrl,
            stage: input.event.stage,
            taskId: input.event.taskId,
            source: input.event.externalContext.source,
            outcome: "error",
            reason: errorMessage,
            attempts: attempt,
          });
          this.logger.warn("External task integration delivery failed", {
            sink: input.sink,
            taskId: input.event.taskId,
            stage: input.event.stage,
            attempts: attempt,
            error: errorMessage,
          });
          return;
        }

        this.logger.warn("External task integration retry scheduled", {
          sink: input.sink,
          taskId: input.event.taskId,
          stage: input.event.stage,
          attempt,
          retryInMs: this.config.retryDelayMs,
          error: errorMessage,
        });
        if (this.config.retryDelayMs > 0) {
          await sleep(this.config.retryDelayMs);
        }
      }
    }
  }

  private async postJson(url: string, payload: Record<string, unknown>, eventType: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timeout.unref?.();

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-codeharbor-event-type": eventType,
    };
    if (this.config.authToken) {
      headers.authorization = `Bearer ${this.config.authToken}`;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (response.ok) {
        return;
      }

      const bodySnippet = await readResponseSnippet(response);
      const detail = bodySnippet ? ` ${bodySnippet}` : "";
      throw new Error(`HTTP ${response.status}${detail}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private recordAudit(event: ExternalTaskIntegrationAuditEvent): void {
    if (!this.auditRecorder) {
      return;
    }
    try {
      this.auditRecorder(event);
    } catch (error) {
      this.logger.warn("External integration audit recorder failed", {
        error: formatError(error),
      });
    }
  }
}

function shouldDispatchTicketSink(event: ApiTaskLifecycleEvent): boolean {
  return event.externalContext.source === "ticket" && Boolean(event.externalContext.ticket?.ticketId);
}

function buildLifecyclePayload(event: ApiTaskLifecycleEvent): Record<string, unknown> {
  return {
    schema: "codeharbor.task.lifecycle.v1",
    sentAt: new Date().toISOString(),
    stage: event.stage,
    task: {
      id: event.taskId,
      sessionKey: event.sessionKey,
      eventId: event.eventId,
      requestId: event.requestId,
      status: event.status,
      attempt: event.attempt,
      enqueuedAt: event.enqueuedAt,
      startedAt: event.startedAt,
      finishedAt: event.finishedAt,
      nextRetryAt: event.nextRetryAt,
      errorSummary: event.errorSummary,
    },
    externalContext: event.externalContext,
  };
}

function buildTicketPayload(event: ApiTaskLifecycleEvent): Record<string, unknown> {
  return {
    schema: "codeharbor.ticket.status.v1",
    sentAt: new Date().toISOString(),
    stage: event.stage,
    status: event.stage,
    ticket: {
      id: event.externalContext.ticket?.ticketId ?? null,
      title: event.externalContext.ticket?.title ?? null,
      priority: event.externalContext.ticket?.priority ?? null,
      assignee: event.externalContext.ticket?.assignee ?? null,
      url: event.externalContext.ticket?.url ?? null,
    },
    task: {
      id: event.taskId,
      requestId: event.requestId,
      sessionKey: event.sessionKey,
      eventId: event.eventId,
      attempt: event.attempt,
      errorSummary: event.errorSummary,
    },
    matrix: {
      conversationId: event.externalContext.matrixConversationId,
      senderId: event.externalContext.matrixSenderId,
    },
    externalContext: event.externalContext,
  };
}

async function readResponseSnippet(response: Response): Promise<string> {
  try {
    const raw = await response.text();
    const normalized = raw.trim().replace(/\s+/g, " ");
    return normalized.length > 200 ? `${normalized.slice(0, 200)}...` : normalized;
  } catch {
    return "";
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
