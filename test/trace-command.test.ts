import { describe, expect, it, vi } from "vitest";

import { handleTraceCommand } from "../src/orchestrator/trace-command";
import type { InboundMessage } from "../src/types";
import type { RequestTraceRecord } from "../src/orchestrator/request-trace";
import type { WorkflowDiagRunRecord } from "../src/orchestrator/workflow-diag";

function makeMessage(text: string): InboundMessage {
  return {
    requestId: "req-test",
    channel: "matrix",
    conversationId: "!room:example.com",
    senderId: "@alice:example.com",
    eventId: "$evt-1",
    text,
    attachments: [],
    isDirectMessage: true,
    mentionsBot: false,
    repliesToBot: false,
  };
}

describe("trace command", () => {
  it("shows usage when requestId is missing", async () => {
    const notices: string[] = [];
    await handleTraceCommand(
      {
        outputLanguage: "zh",
        botNoticePrefix: "[CodeHarbor]",
        getRequestTraceById: () => null,
        findLatestRequestIdBySession: () => null,
        listWorkflowDiagRunsByRequestId: () => [],
        listWorkflowDiagEvents: () => [],
        listMediaEventsByRequestId: () => [],
        isAdminUser: () => false,
        sendNotice: async (_conversationId, text) => {
          notices.push(text);
        },
      },
      makeMessage("/trace"),
    );

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("用法: /trace <requestId|latest>");
  });

  it("returns not-found notice when no trace data exists", async () => {
    const sendNotice = vi.fn(async (_conversationId: string, _text: string) => {});
    await handleTraceCommand(
      {
        outputLanguage: "en",
        botNoticePrefix: "[CodeHarbor]",
        getRequestTraceById: () => null,
        findLatestRequestIdBySession: () => null,
        listWorkflowDiagRunsByRequestId: () => [],
        listWorkflowDiagEvents: () => [],
        listMediaEventsByRequestId: () => [],
        isAdminUser: () => false,
        sendNotice,
      },
      makeMessage("/trace req-404"),
    );

    expect(sendNotice).toHaveBeenCalledTimes(1);
    const text = String(sendNotice.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("Request trace");
    expect(text).toContain("requestId: req-404");
    expect(text).toContain("not found in memory");
  });

  it("renders request trace with workflow/media sections", async () => {
    const trace: RequestTraceRecord = {
      requestId: "req-200",
      sessionKey: "matrix:!room:example.com:@alice:example.com",
      conversationId: "!room:example.com",
      kind: "chat",
      provider: "codex",
      model: "gpt-5.4",
      prompt: "请继续",
      executionPrompt: "authorization=Bearer sk-test-secret-value",
      startedAt: "2026-03-29T10:00:00.000Z",
      endedAt: "2026-03-29T10:00:03.000Z",
      status: "succeeded",
      error: null,
      reply: "已经完成修复 token=top-secret-token",
      sessionId: "thread-1",
      progress: [
        {
          at: "2026-03-29T10:00:01.000Z",
          stage: "command_execution",
          message: "running tests password=my-password",
        },
      ],
    };
    const run: WorkflowDiagRunRecord = {
      runId: "diag-1",
      kind: "autodev",
      sessionKey: trace.sessionKey,
      conversationId: trace.conversationId,
      requestId: "req-200",
      objective: "修复问题",
      taskId: "T6.5",
      taskDescription: "trace support",
      status: "succeeded",
      startedAt: "2026-03-29T10:00:00.000Z",
      endedAt: "2026-03-29T10:00:04.000Z",
      durationMs: 4000,
      approved: true,
      repairRounds: 0,
      error: null,
      lastStage: "completed",
      lastMessage: "done",
      updatedAt: "2026-03-29T10:00:04.000Z",
    };
    const sendNotice = vi.fn(async (_conversationId: string, _text: string) => {});

    await handleTraceCommand(
      {
        outputLanguage: "zh",
        botNoticePrefix: "[CodeHarbor]",
        getRequestTraceById: (requestId) => (requestId === "req-200" ? trace : null),
        findLatestRequestIdBySession: () => "req-200",
        listWorkflowDiagRunsByRequestId: () => [run],
        listWorkflowDiagEvents: () => [
          {
            runId: "diag-1",
            kind: "autodev",
            stage: "executor",
            round: 1,
            message: "patch applied secret=abc",
            at: "2026-03-29T10:00:02.000Z",
          },
        ],
        listMediaEventsByRequestId: () => [
          {
            at: "2026-03-29T10:00:01.500Z",
            type: "image.accepted",
            requestId: "req-200",
            sessionKey: trace.sessionKey,
            detail: "count=1 token=abc",
          },
        ],
        isAdminUser: () => false,
        sendNotice,
      },
      makeMessage("/trace req-200"),
    );

    expect(sendNotice).toHaveBeenCalledTimes(1);
    const text = String(sendNotice.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("请求追踪");
    expect(text).toContain("requestId: req-200");
    expect(text).toContain("status: succeeded");
    expect(text).toContain("workflowDiag:");
    expect(text).toContain("run=diag-1");
    expect(text).toContain("mediaEvents:");
    expect(text).toContain("image.accepted");
    expect(text).not.toContain("top-secret-token");
    expect(text).not.toContain("my-password");
    expect(text).toContain("token=***");
    expect(text).toContain("password=***");
  });

  it("blocks cross-session trace reads for non-admin sender", async () => {
    const trace: RequestTraceRecord = {
      requestId: "req-300",
      sessionKey: "matrix:!room:example.com:@bob:example.com",
      conversationId: "!room:example.com",
      kind: "chat",
      provider: "codex",
      model: null,
      prompt: "hello",
      executionPrompt: "hello",
      startedAt: "2026-03-29T10:00:00.000Z",
      endedAt: null,
      status: "running",
      error: null,
      reply: null,
      sessionId: null,
      progress: [],
    };
    const sendNotice = vi.fn(async (_conversationId: string, _text: string) => {});
    await handleTraceCommand(
      {
        outputLanguage: "zh",
        botNoticePrefix: "[CodeHarbor]",
        getRequestTraceById: () => trace,
        findLatestRequestIdBySession: () => "req-300",
        listWorkflowDiagRunsByRequestId: () => [],
        listWorkflowDiagEvents: () => [],
        listMediaEventsByRequestId: () => [],
        isAdminUser: () => false,
        sendNotice,
      },
      makeMessage("/trace req-300"),
    );

    expect(sendNotice).toHaveBeenCalledTimes(1);
    const text = String(sendNotice.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("status: forbidden");
    expect(text).toContain("仅同一会话发送者或管理员可查看");
  });

  it("resolves /trace latest using current session latest requestId", async () => {
    const sendNotice = vi.fn(async (_conversationId: string, _text: string) => {});
    await handleTraceCommand(
      {
        outputLanguage: "en",
        botNoticePrefix: "[CodeHarbor]",
        getRequestTraceById: (requestId) =>
          requestId === "req-latest"
            ? {
                requestId: "req-latest",
                sessionKey: "matrix:!room:example.com:@alice:example.com",
                conversationId: "!room:example.com",
                kind: "chat",
                provider: "codex",
                model: null,
                prompt: "hello",
                executionPrompt: "hello",
                startedAt: "2026-03-29T10:00:00.000Z",
                endedAt: "2026-03-29T10:00:01.000Z",
                status: "succeeded",
                error: null,
                reply: "ok",
                sessionId: "thread-1",
                progress: [],
              }
            : null,
        findLatestRequestIdBySession: () => "req-latest",
        listWorkflowDiagRunsByRequestId: () => [],
        listWorkflowDiagEvents: () => [],
        listMediaEventsByRequestId: () => [],
        isAdminUser: () => false,
        sendNotice,
      },
      makeMessage("/trace latest"),
    );

    expect(sendNotice).toHaveBeenCalledTimes(1);
    const text = String(sendNotice.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("Request trace");
    expect(text).toContain("requestId: req-latest");
  });

  it("returns latest-not-found notice when current session has no trace record", async () => {
    const sendNotice = vi.fn(async (_conversationId: string, _text: string) => {});
    await handleTraceCommand(
      {
        outputLanguage: "zh",
        botNoticePrefix: "[CodeHarbor]",
        getRequestTraceById: () => null,
        findLatestRequestIdBySession: () => null,
        listWorkflowDiagRunsByRequestId: () => [],
        listWorkflowDiagEvents: () => [],
        listMediaEventsByRequestId: () => [],
        isAdminUser: () => false,
        sendNotice,
      },
      makeMessage("/trace latest"),
    );

    expect(sendNotice).toHaveBeenCalledTimes(1);
    const text = String(sendNotice.mock.calls[0]?.[1] ?? "");
    expect(text).toContain("status: 未找到");
    expect(text).toContain("当前会话没有最近可用追踪记录");
  });
});
