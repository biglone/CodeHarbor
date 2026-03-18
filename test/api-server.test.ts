import { afterEach, describe, expect, it } from "vitest";

import { ApiServer, type TaskSubmissionService } from "../src/api-server";
import { Logger } from "../src/logger";
import {
  ApiTaskIdempotencyConflictError,
  type ApiTaskSubmitInput,
  type ApiTaskSubmitResult,
} from "../src/orchestrator";

class FakeTaskSubmissionService implements TaskSubmissionService {
  calls: ApiTaskSubmitInput[] = [];
  nextResult: ApiTaskSubmitResult = buildSubmitResult({ created: true, taskId: 1 });
  nextError: unknown = null;

  submitApiTask(input: ApiTaskSubmitInput): ApiTaskSubmitResult {
    this.calls.push(input);
    if (this.nextError) {
      throw this.nextError;
    }
    return this.nextResult;
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

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: (await response.json()) as unknown,
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

  async function createApiServer(service: FakeTaskSubmissionService): Promise<string> {
    const server = new ApiServer(new Logger("error"), service, {
      host: "127.0.0.1",
      port: 0,
      apiToken: "secret-token",
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
});
