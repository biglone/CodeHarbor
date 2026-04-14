import { createHmac } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ApiServer, type ApiTaskLifecycleSubscribeFn, type TaskSubmissionService } from "../src/api-server";
import { Logger } from "../src/logger";
import {
  ApiTaskIdempotencyConflictError,
  Orchestrator,
  type ApiTaskActionResult,
  type ApiTaskLifecycleEvent,
  type ApiTaskListInput,
  type ApiTaskListResult,
  type ApiTaskQueryResult,
  type ApiTaskSubmitInput,
  type ApiTaskSubmitResult,
} from "../src/orchestrator";
import { StateStore } from "../src/store/state-store";

class FakeTaskSubmissionService implements TaskSubmissionService {
  calls: ApiTaskSubmitInput[] = [];
  listCalls: ApiTaskListInput[] = [];
  queryCalls: number[] = [];
  cancelCalls: number[] = [];
  retryCalls: number[] = [];
  nextResult: ApiTaskSubmitResult = buildSubmitResult({ created: true, taskId: 1 });
  nextListResult: ApiTaskListResult = buildListResult();
  nextCancelResult: ApiTaskActionResult | null = buildActionResult({
    taskId: 1,
    action: "cancel",
    updated: true,
    previousStatus: "pending",
    status: "failed",
    stage: "failed",
    errorSummary: "cancelled by api",
  });
  nextRetryResult: ApiTaskActionResult | null = buildActionResult({
    taskId: 1,
    action: "retry",
    updated: true,
    previousStatus: "failed",
    status: "pending",
    stage: "queued",
    errorSummary: null,
  });
  nextQueryResult: ApiTaskQueryResult | null = buildQueryResult({
    taskId: 1,
    status: "pending",
    stage: "queued",
    errorSummary: null,
  });
  nextError: unknown = null;

  submitApiTask(input: ApiTaskSubmitInput): ApiTaskSubmitResult {
    this.calls.push(input);
    if (this.nextError) {
      throw this.nextError;
    }
    return this.nextResult;
  }

  listApiTasks(input: ApiTaskListInput): ApiTaskListResult {
    this.listCalls.push(input);
    if (this.nextError) {
      throw this.nextError;
    }
    return this.nextListResult;
  }

  getApiTaskById(taskId: number): ApiTaskQueryResult | null {
    this.queryCalls.push(taskId);
    if (this.nextError) {
      throw this.nextError;
    }
    return this.nextQueryResult;
  }

  cancelApiTask(taskId: number): ApiTaskActionResult | null {
    this.cancelCalls.push(taskId);
    if (this.nextError) {
      throw this.nextError;
    }
    return this.nextCancelResult;
  }

  retryApiTask(taskId: number): ApiTaskActionResult | null {
    this.retryCalls.push(taskId);
    if (this.nextError) {
      throw this.nextError;
    }
    return this.nextRetryResult;
  }
}

class RecoveryChannel {
  sent: Array<{ conversationId: string; text: string }> = [];
  notices: Array<{ conversationId: string; text: string }> = [];

  async start(): Promise<void> {}

  async sendMessage(conversationId: string, text: string): Promise<void> {
    this.sent.push({ conversationId, text });
  }

  async sendNotice(conversationId: string, text: string): Promise<void> {
    this.notices.push({ conversationId, text });
  }

  async setTyping(): Promise<void> {}

  async upsertProgressNotice(_conversationId: string, _text: string, replaceEventId: string | null): Promise<string> {
    return replaceEventId ?? "$progress";
  }

  async stop(): Promise<void> {}
}

class HangingExecutor {
  callCount = 0;

  startExecution(): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.callCount += 1;
    return {
      result: new Promise(() => {}),
      cancel: () => {},
    };
  }
}

class FastExecutor {
  callCount = 0;
  calls: string[] = [];

  startExecution(text: string, sessionId: string | null): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.callCount += 1;
    this.calls.push(text);
    return {
      result: Promise.resolve({
        sessionId: sessionId ?? "thread-recovered",
        reply: `ok:${text}`,
      }),
      cancel: () => {},
    };
  }
}

function buildSubmitResult(input: { created: boolean; taskId: number }): ApiTaskSubmitResult {
  return {
    created: input.created,
    sessionKey: "matrix:!room:example.com:@ci:example.com",
    eventId: "$api-event",
    requestId: "api-request-1",
    task: {
      id: input.taskId,
      sessionKey: "matrix:!room:example.com:@ci:example.com",
      eventId: "$api-event",
      requestId: "api-request-1",
      payloadJson: "{}",
      status: "pending",
      attempt: 0,
      enqueuedAt: Date.now(),
      nextRetryAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      lastError: null,
    },
  };
}

function buildQueryResult(input: {
  taskId: number;
  status: ApiTaskQueryResult["status"];
  stage: ApiTaskQueryResult["stage"];
  errorSummary: string | null;
}): ApiTaskQueryResult {
  return {
    taskId: input.taskId,
    status: input.status,
    stage: input.stage,
    errorSummary: input.errorSummary,
  };
}

function buildListResult(input?: Partial<ApiTaskListResult>): ApiTaskListResult {
  return {
    total: input?.total ?? 0,
    items: input?.items ?? [],
  };
}

function buildActionResult(input: ApiTaskActionResult): ApiTaskActionResult {
  return {
    ...input,
  };
}

function buildLifecycleEvent(input: Partial<ApiTaskLifecycleEvent> & Pick<ApiTaskLifecycleEvent, "taskId" | "stage">): ApiTaskLifecycleEvent {
  return {
    taskId: input.taskId,
    stage: input.stage,
    sessionKey: input.sessionKey ?? "matrix:!room:example.com:@ci:example.com",
    eventId: input.eventId ?? "$api-event",
    requestId: input.requestId ?? "api-request-1",
    status: input.status ?? "pending",
    attempt: input.attempt ?? 0,
    enqueuedAt: input.enqueuedAt ?? Date.now() - 1_000,
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    nextRetryAt: input.nextRetryAt ?? null,
    errorSummary: input.errorSummary ?? null,
    externalContext: input.externalContext ?? {
      source: "api",
      eventId: null,
      workflowId: null,
      externalRef: null,
      matrixConversationId: "!room:example.com",
      matrixSenderId: "@ci:example.com",
      ci: null,
      ticket: null,
      metadata: {},
    },
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: (await response.json()) as unknown,
  };
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>,
  timeoutMs = 2_000,
): Promise<{ event: string; data: unknown }> {
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = "";

  while (Date.now() - startedAt <= timeoutMs) {
    const chunk = await new Promise<ReadableStreamReadResult<Uint8Array<ArrayBufferLike>>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for SSE event."));
      }, timeoutMs);
      void reader
        .read()
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
    if (chunk.done) {
      throw new Error("SSE stream closed before receiving event.");
    }
    buffer += decoder.decode(chunk.value, { stream: true });

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex < 0) {
        break;
      }
      const rawFrame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      if (!rawFrame.trim() || rawFrame.startsWith(":")) {
        continue;
      }
      let event = "message";
      const dataLines: string[] = [];
      for (const line of rawFrame.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }
      if (dataLines.length === 0) {
        continue;
      }
      return {
        event,
        data: JSON.parse(dataLines.join("\n")) as unknown,
      };
    }
  }

  throw new Error("Timed out waiting for SSE event.");
}

function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  const digest = createHmac("sha256", secret).update(timestamp).update(".").update(rawBody).digest("hex");
  return `sha256=${digest}`;
}

async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for expected condition.");
}

async function createSqliteStateStore(prefix = "codeharbor-api-recovery-"): Promise<{ dir: string; store: StateStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    store: new StateStore(path.join(dir, "state.db"), path.join(dir, "state.json"), 200, 30, 500),
  };
}

describe("ApiServer", () => {
  const startedServers: ApiServer[] = [];

  afterEach(async () => {
    while (startedServers.length > 0) {
      const server = startedServers.pop();
      if (!server) {
        continue;
      }
      await server.stop();
    }
  });

  async function createApiServer(
    service: TaskSubmissionService,
    options?: {
      webhookSecret?: string | null;
      webhookTimestampToleranceSeconds?: number;
      apiTokenScopes?: string[];
      auditRecorder?: (event: unknown) => void;
      subscribeTaskLifecycle?: ApiTaskLifecycleSubscribeFn;
    },
  ): Promise<string> {
    const server = new ApiServer(new Logger("error"), service, {
      host: "127.0.0.1",
      port: 0,
      apiToken: "secret-token",
      apiTokenScopes: options?.apiTokenScopes,
      webhookSecret: options?.webhookSecret ?? null,
      webhookTimestampToleranceSeconds: options?.webhookTimestampToleranceSeconds ?? 300,
      subscribeTaskLifecycle: options?.subscribeTaskLifecycle,
      auditRecorder: options?.auditRecorder,
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    if (!address) {
      throw new Error("api server address unavailable");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it("rejects task submission without bearer token", async () => {
    const service = new FakeTaskSubmissionService();
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-1",
      },
      body: JSON.stringify({
        conversationId: "!room:example.com",
        senderId: "@ci:example.com",
        text: "run checks",
      }),
    });

    expect(response.status).toBe(401);
    expect(service.calls).toHaveLength(0);
  });

  it("supports fine-grained API token scopes", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextQueryResult = buildQueryResult({
      taskId: 7,
      status: "pending",
      stage: "queued",
      errorSummary: null,
    });
    const baseUrl = await createApiServer(service, {
      apiTokenScopes: ["tasks.read.api"],
    });

    const submitDenied = await fetchJson(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
        "idempotency-key": "scope-denied-1",
      },
      body: JSON.stringify({
        conversationId: "!room:example.com",
        senderId: "@ci:example.com",
        text: "run checks",
      }),
    });
    expect(submitDenied.status).toBe(403);
    expect(JSON.stringify(submitDenied.body)).toContain("tasks.submit.api");

    const queryAllowed = await fetchJson(`${baseUrl}/api/tasks/7`, {
      method: "GET",
      headers: {
        authorization: "Bearer secret-token",
      },
    });
    expect(queryAllowed.status).toBe(200);
  });

  it("supports submit-only API token scope", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextResult = buildSubmitResult({ created: true, taskId: 9 });
    service.nextQueryResult = buildQueryResult({
      taskId: 9,
      status: "pending",
      stage: "queued",
      errorSummary: null,
    });
    const baseUrl = await createApiServer(service, {
      apiTokenScopes: ["tasks.submit.api"],
    });

    const submitAllowed = await fetchJson(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
        "idempotency-key": "scope-submit-1",
      },
      body: JSON.stringify({
        conversationId: "!room:example.com",
        senderId: "@ci:example.com",
        text: "run checks",
      }),
    });
    expect(submitAllowed.status).toBe(202);

    const queryDenied = await fetchJson(`${baseUrl}/api/tasks/9`, {
      method: "GET",
      headers: {
        authorization: "Bearer secret-token",
      },
    });
    expect(queryDenied.status).toBe(403);
    expect(JSON.stringify(queryDenied.body)).toContain("tasks.read.api");
  });

  it("emits API audit events for denied requests", async () => {
    const service = new FakeTaskSubmissionService();
    const audits: unknown[] = [];
    const baseUrl = await createApiServer(service, {
      auditRecorder: (event) => audits.push(event),
    });

    const response = await fetchJson(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "audit-denied-1",
      },
      body: JSON.stringify({
        conversationId: "!room:example.com",
        senderId: "@ci:example.com",
        text: "run checks",
      }),
    });

    expect(response.status).toBe(401);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(
      expect.objectContaining({
        surface: "api",
        outcome: "denied",
        reason: "unauthorized",
        action: "tasks.submit.api",
        path: "/api/tasks",
      }),
    );
  });

  it("classifies API validation failures as denied audit events", async () => {
    const service = new FakeTaskSubmissionService();
    const audits: unknown[] = [];
    const baseUrl = await createApiServer(service, {
      auditRecorder: (event) => audits.push(event),
    });

    const response = await fetchJson(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
        "x-request-id": "req-api-400",
      },
      body: JSON.stringify({
        conversationId: "!room:example.com",
        senderId: "@ci:example.com",
        text: "run checks",
      }),
    });

    expect(response.status).toBe(400);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(
      expect.objectContaining({
        surface: "api",
        outcome: "denied",
        path: "/api/tasks",
      }),
    );
    expect(audits[0]).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          statusCode: 400,
          requestId: "req-api-400",
        }),
      }),
    );
  });

  it("rejects task submission without Idempotency-Key header", async () => {
    const service = new FakeTaskSubmissionService();
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
      body: JSON.stringify({
        conversationId: "!room:example.com",
        senderId: "@ci:example.com",
        text: "run checks",
      }),
    });

    expect(response.status).toBe(400);
    expect(service.calls).toHaveLength(0);
  });

  it("accepts first submission and returns 202", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextResult = buildSubmitResult({ created: true, taskId: 11 });
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
        "idempotency-key": "idem-accepted-1",
      },
      body: JSON.stringify({
        conversationId: "!room:example.com",
        senderId: "@ci:example.com",
        text: "run checks",
      }),
    });

    const responseText = JSON.stringify(response.body);
    expect(response.status).toBe(202);
    expect(responseText).toContain('"created":true');
    expect(responseText).toContain('"deduplicated":false');
    expect(responseText).toContain('"taskId":11');
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]).toEqual(
      expect.objectContaining({
        conversationId: "!room:example.com",
        senderId: "@ci:example.com",
        text: "run checks",
        idempotencyKey: "idem-accepted-1",
        isDirectMessage: true,
        mentionsBot: false,
        repliesToBot: false,
      }),
    );
  });

  it("returns 200 for idempotent duplicate submission", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextResult = buildSubmitResult({ created: false, taskId: 23 });
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
        "idempotency-key": "idem-dup-1",
      },
      body: JSON.stringify({
        conversationId: "!room:example.com",
        senderId: "@ci:example.com",
        text: "run checks",
      }),
    });

    const responseText = JSON.stringify(response.body);
    expect(response.status).toBe(200);
    expect(responseText).toContain('"created":false');
    expect(responseText).toContain('"deduplicated":true');
    expect(responseText).toContain('"taskId":23');
  });

  it("returns 409 when idempotency key is reused with a different payload", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextError = new ApiTaskIdempotencyConflictError(
      "matrix:!room:example.com:@ci:example.com",
      "$api-event",
    );
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
        "idempotency-key": "idem-conflict-1",
      },
      body: JSON.stringify({
        conversationId: "!room:example.com",
        senderId: "@ci:example.com",
        text: "run checks",
      }),
    });

    const responseText = JSON.stringify(response.body);
    expect(response.status).toBe(409);
    expect(responseText).toContain('"code":"IDEMPOTENCY_CONFLICT"');
  });

  it("returns task list snapshot for GET /api/tasks", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextListResult = buildListResult({
      total: 2,
      items: [
        {
          taskId: 8,
          sessionKey: "matrix:!room:example.com:@ci:example.com",
          eventId: "$api-task-8",
          requestId: "req-8",
          status: "pending",
          stage: "queued",
          errorSummary: null,
          attempt: 0,
          enqueuedAt: 1000,
          nextRetryAt: null,
          startedAt: null,
          finishedAt: null,
          source: "ci",
          roomId: "!room:example.com",
        },
      ],
    });
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(
      `${baseUrl}/api/tasks?status=pending&source=ci&roomId=!room:example.com&from=100&to=200&limit=50&offset=10`,
      {
        method: "GET",
        headers: {
          authorization: "Bearer secret-token",
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      data: {
        total: 2,
        items: [
          {
            taskId: 8,
            sessionKey: "matrix:!room:example.com:@ci:example.com",
            eventId: "$api-task-8",
            requestId: "req-8",
            status: "pending",
            stage: "queued",
            errorSummary: null,
            attempt: 0,
            enqueuedAt: 1000,
            nextRetryAt: null,
            startedAt: null,
            finishedAt: null,
            source: "ci",
            roomId: "!room:example.com",
          },
        ],
      },
    });
    expect(service.listCalls).toEqual([
      {
        status: "pending",
        source: "ci",
        roomId: "!room:example.com",
        from: 100,
        to: 200,
        limit: 50,
        offset: 10,
      },
    ]);
  });

  it("rejects task list query without bearer token", async () => {
    const service = new FakeTaskSubmissionService();
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks?status=pending`, {
      method: "GET",
    });

    expect(response.status).toBe(401);
    expect(service.listCalls).toHaveLength(0);
  });

  it("rejects invalid task list query parameters", async () => {
    const service = new FakeTaskSubmissionService();
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks?status=queued&limit=0`, {
      method: "GET",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    expect(response.status).toBe(400);
    expect(service.listCalls).toHaveLength(0);
  });

  it("cancels pending task via POST /api/tasks/:taskId/cancel", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextCancelResult = buildActionResult({
      taskId: 42,
      action: "cancel",
      updated: true,
      previousStatus: "pending",
      status: "failed",
      stage: "failed",
      errorSummary: "cancelled by api",
    });
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks/42/cancel`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      data: {
        taskId: 42,
        action: "cancel",
        updated: true,
        previousStatus: "pending",
        status: "failed",
        stage: "failed",
        errorSummary: "cancelled by api",
      },
    });
    expect(service.cancelCalls).toEqual([42]);
  });

  it("retries failed task via POST /api/tasks/:taskId/retry", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextRetryResult = buildActionResult({
      taskId: 88,
      action: "retry",
      updated: true,
      previousStatus: "failed",
      status: "pending",
      stage: "queued",
      errorSummary: null,
    });
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks/88/retry`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      data: {
        taskId: 88,
        action: "retry",
        updated: true,
        previousStatus: "failed",
        status: "pending",
        stage: "queued",
        errorSummary: null,
      },
    });
    expect(service.retryCalls).toEqual([88]);
  });

  it("returns 409 when task state does not allow requested action", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextCancelResult = buildActionResult({
      taskId: 99,
      action: "cancel",
      updated: false,
      previousStatus: "running",
      status: "running",
      stage: "executing",
      errorSummary: null,
    });
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks/99/cancel`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain('"code":"TASK_STATE_CONFLICT"');
    expect(service.cancelCalls).toEqual([99]);
  });

  it("returns 404 for unknown task action target", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextRetryResult = null;
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks/404/retry`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    expect(response.status).toBe(404);
    expect(service.retryCalls).toEqual([404]);
  });

  it("rejects task action without bearer token", async () => {
    const service = new FakeTaskSubmissionService();
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks/7/cancel`, {
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(service.cancelCalls).toHaveLength(0);
  });

  it("streams task lifecycle events via GET /api/tasks/:taskId/events", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextQueryResult = buildQueryResult({
      taskId: 77,
      status: "pending",
      stage: "queued",
      errorSummary: null,
    });
    let lifecycleListener: (event: ApiTaskLifecycleEvent) => void = () => {};
    const baseUrl = await createApiServer(service, {
      subscribeTaskLifecycle: (_taskId, listener) => {
        lifecycleListener = listener;
        return () => {
          if (lifecycleListener === listener) {
            lifecycleListener = () => {};
          }
        };
      },
    });

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/tasks/77/events`, {
      method: "GET",
      headers: {
        authorization: "Bearer secret-token",
      },
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(service.queryCalls).toEqual([77]);
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();

    const snapshot = await readSseEvent(reader);
    expect(snapshot).toEqual({
      event: "snapshot",
      data: expect.objectContaining({
        type: "snapshot",
        taskId: 77,
        status: "pending",
        stage: "queued",
        errorSummary: null,
      }),
    });

    lifecycleListener(
      buildLifecycleEvent({
        taskId: 77,
        stage: "executing",
        status: "running",
        attempt: 1,
        startedAt: Date.now(),
      }),
    );
    const lifecycle = await readSseEvent(reader);
    expect(lifecycle).toEqual({
      event: "lifecycle",
      data: expect.objectContaining({
        type: "lifecycle",
        taskId: 77,
        stage: "executing",
        status: "running",
        attempt: 1,
      }),
    });

    await reader.cancel();
    controller.abort();
  });

  it("returns 404 for task event stream when task does not exist", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextQueryResult = null;
    const baseUrl = await createApiServer(service, {
      subscribeTaskLifecycle: () => () => {},
    });

    const response = await fetchJson(`${baseUrl}/api/tasks/404/events`, {
      method: "GET",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    expect(response.status).toBe(404);
    expect(service.queryCalls).toEqual([404]);
  });

  it("rejects task event stream for submit-only token scope", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextQueryResult = buildQueryResult({
      taskId: 9,
      status: "pending",
      stage: "queued",
      errorSummary: null,
    });
    const baseUrl = await createApiServer(service, {
      apiTokenScopes: ["tasks.submit.api"],
      subscribeTaskLifecycle: () => () => {},
    });

    const response = await fetchJson(`${baseUrl}/api/tasks/9/events`, {
      method: "GET",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    expect(response.status).toBe(403);
    expect(service.queryCalls).toHaveLength(0);
  });

  it("returns task status snapshot for GET /api/tasks/:taskId", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextQueryResult = buildQueryResult({
      taskId: 42,
      status: "running",
      stage: "executing",
      errorSummary: null,
    });
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks/42`, {
      method: "GET",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      data: {
        taskId: 42,
        status: "running",
        stage: "executing",
        errorSummary: null,
      },
    });
    expect(service.queryCalls).toEqual([42]);
  });

  it("rejects task query without bearer token", async () => {
    const service = new FakeTaskSubmissionService();
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks/7`, {
      method: "GET",
    });

    expect(response.status).toBe(401);
    expect(service.queryCalls).toHaveLength(0);
  });

  it("rejects task query when taskId is invalid", async () => {
    const service = new FakeTaskSubmissionService();
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks/not-a-number`, {
      method: "GET",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    expect(response.status).toBe(400);
    expect(service.queryCalls).toHaveLength(0);
  });

  it("returns 404 when queried task does not exist", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextQueryResult = null;
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks/404`, {
      method: "GET",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    expect(response.status).toBe(404);
    expect(service.queryCalls).toEqual([404]);
  });

  it("returns failed task error summary in query response", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextQueryResult = buildQueryResult({
      taskId: 55,
      status: "failed",
      stage: "failed",
      errorSummary: "HTTP 429 Too Many Requests",
    });
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks/55`, {
      method: "GET",
      headers: {
        authorization: "Bearer secret-token",
      },
    });

    const responseText = JSON.stringify(response.body);
    expect(response.status).toBe(200);
    expect(responseText).toContain('"status":"failed"');
    expect(responseText).toContain('"stage":"failed"');
    expect(responseText).toContain('"errorSummary":"HTTP 429 Too Many Requests"');
  });

  it("rejects webhook request when signature is invalid", async () => {
    const service = new FakeTaskSubmissionService();
    const webhookSecret = "whsec_test";
    const baseUrl = await createApiServer(service, { webhookSecret });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      conversationId: "!room:example.com",
      repository: "acme/service",
    });

    const response = await fetchJson(`${baseUrl}/api/webhooks/ci`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codeharbor-timestamp": timestamp,
        "x-codeharbor-signature": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      },
      body: rawBody,
    });

    expect(response.status).toBe(401);
    expect(service.calls).toHaveLength(0);
  });

  it("classifies webhook availability failures as error audit events", async () => {
    const service = new FakeTaskSubmissionService();
    const audits: unknown[] = [];
    const baseUrl = await createApiServer(service, {
      webhookSecret: null,
      auditRecorder: (event) => audits.push(event),
    });

    const response = await fetchJson(`${baseUrl}/api/webhooks/ci`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-webhook-503",
      },
      body: JSON.stringify({
        conversationId: "!room:example.com",
        repository: "acme/service",
      }),
    });

    expect(response.status).toBe(503);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(
      expect.objectContaining({
        surface: "webhook",
        outcome: "error",
        reason: "webhook_unavailable",
        action: "webhook.ingest.ci",
      }),
    );
    expect(audits[0]).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          statusCode: 503,
          requestId: "req-webhook-503",
        }),
      }),
    );
  });

  it("rejects webhook request when timestamp is outside tolerance", async () => {
    const service = new FakeTaskSubmissionService();
    const webhookSecret = "whsec_test";
    const baseUrl = await createApiServer(service, {
      webhookSecret,
      webhookTimestampToleranceSeconds: 30,
    });
    const timestamp = String(Math.floor(Date.now() / 1000) - 3_600);
    const rawBody = JSON.stringify({
      conversationId: "!room:example.com",
      repository: "acme/service",
    });

    const response = await fetchJson(`${baseUrl}/api/webhooks/ci`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codeharbor-timestamp": timestamp,
        "x-codeharbor-signature": signWebhookPayload(webhookSecret, timestamp, rawBody),
      },
      body: rawBody,
    });

    expect(response.status).toBe(401);
    expect(service.calls).toHaveLength(0);
  });

  it("maps CI webhook payload into task submission", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextResult = buildSubmitResult({ created: true, taskId: 77 });
    const webhookSecret = "whsec_ci";
    const baseUrl = await createApiServer(service, { webhookSecret });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      conversationId: "!ci-room:example.com",
      repository: "acme/backend",
      pipeline: "build-and-test",
      status: "failed",
      branch: "main",
      commit: "abcdef12",
      url: "https://ci.example.com/runs/77",
      summary: "integration tests failed",
      requestId: "ci-request-77",
    });

    const response = await fetchJson(`${baseUrl}/api/webhooks/ci`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codeharbor-timestamp": timestamp,
        "x-codeharbor-signature": signWebhookPayload(webhookSecret, timestamp, rawBody),
        "x-codeharbor-event-id": "ci-run-77",
      },
      body: rawBody,
    });

    const responseText = JSON.stringify(response.body);
    expect(response.status).toBe(202);
    expect(responseText).toContain('"source":"ci"');
    expect(responseText).toContain('"taskId":77');
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]).toEqual(
      expect.objectContaining({
        conversationId: "!ci-room:example.com",
        senderId: "@ci:webhook.codeharbor",
        idempotencyKey: "webhook:ci:ci-run-77",
        requestId: "ci-request-77",
        isDirectMessage: false,
        externalContext: expect.objectContaining({
          source: "ci",
          matrixConversationId: "!ci-room:example.com",
          matrixSenderId: "@ci:webhook.codeharbor",
          ci: expect.objectContaining({
            repository: "acme/backend",
            pipeline: "build-and-test",
            status: "failed",
          }),
        }),
      }),
    );
    expect(service.calls[0]?.text).toContain("[CI Webhook]");
    expect(service.calls[0]?.text).toContain("Repository: acme/backend");
    expect(service.calls[0]?.text).toContain("Status: failed");
  });

  it("maps ticket webhook payload into task submission", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextResult = buildSubmitResult({ created: true, taskId: 88 });
    const webhookSecret = "whsec_ticket";
    const baseUrl = await createApiServer(service, { webhookSecret });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      roomId: "!ops-room:example.com",
      issueKey: "OPS-88",
      summary: "Release blocked by migration error",
      status: "open",
      priority: "P1",
      reporter: "@oncall:example.com",
      description: "Need triage before release window closes.",
      eventId: "ticket-event-88",
    });

    const response = await fetchJson(`${baseUrl}/api/webhooks/ticket`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codeharbor-timestamp": timestamp,
        "x-codeharbor-signature": signWebhookPayload(webhookSecret, timestamp, rawBody),
      },
      body: rawBody,
    });

    const responseText = JSON.stringify(response.body);
    expect(response.status).toBe(202);
    expect(responseText).toContain('"source":"ticket"');
    expect(responseText).toContain('"taskId":88');
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]).toEqual(
      expect.objectContaining({
        conversationId: "!ops-room:example.com",
        senderId: "@oncall:example.com",
        idempotencyKey: "webhook:ticket:ticket-event-88",
        requestId: "ticket-event-88",
        isDirectMessage: false,
        externalContext: expect.objectContaining({
          source: "ticket",
          matrixConversationId: "!ops-room:example.com",
          matrixSenderId: "@oncall:example.com",
          ticket: expect.objectContaining({
            ticketId: "OPS-88",
            title: "Release blocked by migration error",
          }),
        }),
      }),
    );
    expect(service.calls[0]?.text).toContain("[Ticket Webhook]");
    expect(service.calls[0]?.text).toContain("Ticket: OPS-88");
  });

  it("accepts external context on /api/tasks payload", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextResult = buildSubmitResult({ created: true, taskId: 66 });
    const baseUrl = await createApiServer(service);

    const response = await fetchJson(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
        "idempotency-key": "idem-external-context-1",
      },
      body: JSON.stringify({
        conversationId: "!room:example.com",
        senderId: "@ci:example.com",
        text: "run checks",
        externalContext: {
          source: "ci",
          workflowId: "build-66",
          ci: {
            repository: "acme/backend",
            status: "running",
          },
          metadata: {
            provider: "github-actions",
          },
        },
      }),
    });

    expect(response.status).toBe(202);
    expect(service.calls).toHaveLength(1);
    expect(service.calls[0]?.externalContext).toEqual(
      expect.objectContaining({
        source: "ci",
        workflowId: "build-66",
        ci: expect.objectContaining({
          repository: "acme/backend",
          status: "running",
        }),
        metadata: expect.objectContaining({
          provider: "github-actions",
        }),
      }),
    );
  });

  it("returns 422 when webhook payload misses required mapping fields", async () => {
    const service = new FakeTaskSubmissionService();
    const webhookSecret = "whsec_ci";
    const baseUrl = await createApiServer(service, { webhookSecret });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      conversationId: "!ci-room:example.com",
      status: "failed",
    });

    const response = await fetchJson(`${baseUrl}/api/webhooks/ci`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codeharbor-timestamp": timestamp,
        "x-codeharbor-signature": signWebhookPayload(webhookSecret, timestamp, rawBody),
      },
      body: rawBody,
    });

    expect(response.status).toBe(422);
    expect(service.calls).toHaveLength(0);
  });

  it("returns 409 for webhook idempotency conflict", async () => {
    const service = new FakeTaskSubmissionService();
    service.nextError = new ApiTaskIdempotencyConflictError(
      "matrix:!room:example.com:@ci:example.com",
      "$api-event",
    );
    const webhookSecret = "whsec_conflict";
    const baseUrl = await createApiServer(service, { webhookSecret });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({
      conversationId: "!ci-room:example.com",
      repository: "acme/backend",
      status: "failed",
      eventId: "ci-event-conflict",
    });

    const response = await fetchJson(`${baseUrl}/api/webhooks/ci`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codeharbor-timestamp": timestamp,
        "x-codeharbor-signature": signWebhookPayload(webhookSecret, timestamp, rawBody),
      },
      body: rawBody,
    });

    const responseText = JSON.stringify(response.body);
    expect(response.status).toBe(409);
    expect(responseText).toContain('"code":"IDEMPOTENCY_CONFLICT"');
  });

  it("recovers API and webhook queued tasks after restart", async () => {
    const { dir, store } = await createSqliteStateStore("codeharbor-api-webhook-recovery-");
    try {
      const beforeRestartChannel = new RecoveryChannel();
      const beforeRestartExecutor = new HangingExecutor();
      const beforeRestart = new Orchestrator(
        beforeRestartChannel as never,
        beforeRestartExecutor as never,
        store as never,
        new Logger("error") as never,
        {
          commandPrefix: "!code",
          matrixUserId: "@bot:example.com",
          progressUpdatesEnabled: false,
        },
      );
      const webhookSecret = "whsec_recovery";
      const baseUrl = await createApiServer(beforeRestart, { webhookSecret });

      const apiSubmit = await fetchJson(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
          "idempotency-key": "idem-recovery-api-1",
        },
        body: JSON.stringify({
          conversationId: "!api-recovery-room:example.com",
          senderId: "@api:example.com",
          text: "api restart recovery task",
        }),
      });
      expect(apiSubmit.status).toBe(202);

      const ciTimestamp = String(Math.floor(Date.now() / 1000));
      const ciBody = JSON.stringify({
        conversationId: "!ci-recovery-room:example.com",
        repository: "acme/backend",
        status: "failed",
        eventId: "ci-recovery-1",
      });
      const ciSubmit = await fetchJson(`${baseUrl}/api/webhooks/ci`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codeharbor-timestamp": ciTimestamp,
          "x-codeharbor-signature": signWebhookPayload(webhookSecret, ciTimestamp, ciBody),
        },
        body: ciBody,
      });
      expect(ciSubmit.status).toBe(202);

      const ticketTimestamp = String(Math.floor(Date.now() / 1000));
      const ticketBody = JSON.stringify({
        roomId: "!ticket-recovery-room:example.com",
        issueKey: "OPS-7788",
        summary: "queue recovery validation",
        eventId: "ticket-recovery-1",
      });
      const ticketSubmit = await fetchJson(`${baseUrl}/api/webhooks/ticket`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codeharbor-timestamp": ticketTimestamp,
          "x-codeharbor-signature": signWebhookPayload(webhookSecret, ticketTimestamp, ticketBody),
        },
        body: ticketBody,
      });
      expect(ticketSubmit.status).toBe(202);

      await waitForCondition(() => {
        const counts = store.getTaskQueueStatusCounts();
        return counts.running === 3;
      }, 8_000);

      const afterRestartChannel = new RecoveryChannel();
      const afterRestartExecutor = new FastExecutor();
      const afterRestart = new Orchestrator(
        afterRestartChannel as never,
        afterRestartExecutor as never,
        store as never,
        new Logger("error") as never,
        {
          commandPrefix: "!code",
          matrixUserId: "@bot:example.com",
          progressUpdatesEnabled: false,
        },
      );

      await afterRestart.bootstrapTaskQueueRecovery();
      await waitForCondition(() => {
        const counts = store.getTaskQueueStatusCounts();
        return counts.pending === 0 && counts.running === 0 && counts.succeeded === 3;
      }, 10_000);

      const tasks = afterRestart.listApiTasks({ limit: 10 }).items;
      expect(tasks).toHaveLength(3);
      expect(tasks.every((task) => task.status === "succeeded" && task.stage === "completed")).toBe(true);
      expect(new Set(tasks.map((task) => task.source))).toEqual(new Set(["api", "ci", "ticket"]));
      expect(afterRestartExecutor.callCount).toBe(3);
      expect(afterRestartExecutor.calls.some((text) => text.includes("api restart recovery task"))).toBe(true);
      expect(afterRestartExecutor.calls.some((text) => text.includes("[CI Webhook]"))).toBe(true);
      expect(afterRestartExecutor.calls.some((text) => text.includes("[Ticket Webhook]"))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
