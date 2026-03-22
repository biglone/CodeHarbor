import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { ApiServer, type TaskSubmissionService } from "../src/api-server";
import { Logger } from "../src/logger";
import {
  ApiTaskIdempotencyConflictError,
  type ApiTaskQueryResult,
  type ApiTaskSubmitInput,
  type ApiTaskSubmitResult,
} from "../src/orchestrator";

class FakeTaskSubmissionService implements TaskSubmissionService {
  calls: ApiTaskSubmitInput[] = [];
  queryCalls: number[] = [];
  nextResult: ApiTaskSubmitResult = buildSubmitResult({ created: true, taskId: 1 });
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

  getApiTaskById(taskId: number): ApiTaskQueryResult | null {
    this.queryCalls.push(taskId);
    if (this.nextError) {
      throw this.nextError;
    }
    return this.nextQueryResult;
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

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: (await response.json()) as unknown,
  };
}

function signWebhookPayload(secret: string, timestamp: string, rawBody: string): string {
  const digest = createHmac("sha256", secret).update(timestamp).update(".").update(rawBody).digest("hex");
  return `sha256=${digest}`;
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
    service: FakeTaskSubmissionService,
    options?: {
      webhookSecret?: string | null;
      webhookTimestampToleranceSeconds?: number;
      apiTokenScopes?: string[];
      auditRecorder?: (event: unknown) => void;
    },
  ): Promise<string> {
    const server = new ApiServer(new Logger("error"), service, {
      host: "127.0.0.1",
      port: 0,
      apiToken: "secret-token",
      apiTokenScopes: options?.apiTokenScopes,
      webhookSecret: options?.webhookSecret ?? null,
      webhookTimestampToleranceSeconds: options?.webhookTimestampToleranceSeconds ?? 300,
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
});
