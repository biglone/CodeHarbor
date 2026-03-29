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
        listWorkflowDiagRunsByRequestId: () => [],
        listWorkflowDiagEvents: () => [],
        listMediaEventsByRequestId: () => [],
        sendNotice: async (_conversationId, text) => {
          notices.push(text);
        },
      },
      makeMessage("/trace"),
    );

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("用法: /trace <requestId>");
  });

  it("returns not-found notice when no trace data exists", async () => {
    const sendNotice = vi.fn(async (_conversationId: string, _text: string) => {});
    await handleTraceCommand(
      {
        outputLanguage: "en",
        botNoticePrefix: "[CodeHarbor]",
        getRequestTraceById: () => null,
        listWorkflowDiagRunsByRequestId: () => [],
        listWorkflowDiagEvents: () => [],
        listMediaEventsByRequestId: () => [],
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
      executionPrompt: "执行提示词",
      startedAt: "2026-03-29T10:00:00.000Z",
      endedAt: "2026-03-29T10:00:03.000Z",
      status: "succeeded",
      error: null,
      reply: "已经完成修复",
      sessionId: "thread-1",
      progress: [
        {
          at: "2026-03-29T10:00:01.000Z",
          stage: "command_execution",
          message: "running tests",
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
        listWorkflowDiagRunsByRequestId: () => [run],
        listWorkflowDiagEvents: () => [
          {
            runId: "diag-1",
            kind: "autodev",
            stage: "executor",
            round: 1,
            message: "patch applied",
            at: "2026-03-29T10:00:02.000Z",
          },
        ],
        listMediaEventsByRequestId: () => [
          {
            at: "2026-03-29T10:00:01.500Z",
            type: "image.accepted",
            requestId: "req-200",
            sessionKey: trace.sessionKey,
            detail: "count=1",
          },
        ],
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
  });
});
