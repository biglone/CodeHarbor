import { describe, expect, it, vi } from "vitest";

import { executeChatRequest } from "../src/orchestrator/chat-request";
import type { RecentArtifactBatch } from "../src/orchestrator/file-send-intent";
import type { InboundMessage } from "../src/types";

function createMessage(text: string): InboundMessage {
  return {
    requestId: "req-1",
    channel: "matrix",
    conversationId: "!room:example.com",
    senderId: "@alice:example.com",
    eventId: "$event-1",
    text,
    attachments: [],
    isDirectMessage: true,
    mentionsBot: true,
    repliesToBot: false,
  };
}

describe("executeChatRequest structured file delivery", () => {
  it("strips model action block and sends referenced recent artifacts", async () => {
    const recentArtifactBatches: RecentArtifactBatch[] = [
      {
        requestId: "req-prev",
        workdir: "/workspace/demo",
        createdAt: Date.now(),
        files: [
          {
            absolutePath: "/workspace/demo/video/episode-10.mp4",
            relativePath: "video/episode-10.mp4",
            sizeBytes: 1024,
            mtimeMs: Date.now() - 1,
          },
          {
            absolutePath: "/workspace/demo/video/episode-9.mp4",
            relativePath: "video/episode-9.mp4",
            sizeBytes: 1024,
            mtimeMs: Date.now() - 2,
          },
        ],
      },
    ];

    const appendConversationMessage = vi.fn();
    const sendMessage = vi.fn(async () => {});
    const sendNotice = vi.fn(async () => {});
    const sendFile = vi.fn(async () => {});
    const recordCliCompatPrompt = vi.fn(async () => {});

    await executeChatRequest(
      {
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        } as never,
        outputLanguage: "zh-CN" as never,
        sessionActiveWindowMs: 60_000,
        cliCompat: { enabled: false, passThroughEvents: false },
        stateStore: {
          activateSession: vi.fn(),
          getCodexSessionId: vi.fn(() => null),
          appendConversationMessage,
          commitExecutionSuccess: vi.fn(),
          commitExecutionHandled: vi.fn(),
        },
        skipBridgeForNextPrompt: new Set<string>(),
        mediaMetrics: {
          recordImageSelection: vi.fn(),
          recordClaudeImageFallback: vi.fn(),
        },
        runningExecutions: new Map(),
        consumePendingStopRequest: vi.fn(() => false),
        persistRuntimeMetricsSnapshot: vi.fn(),
        recordRequestMetrics: vi.fn(),
        captureArtifactSnapshot: vi.fn(async () => null),
        recordArtifactBatch: vi.fn(),
        listRecentArtifactBatches: vi.fn(() => recentArtifactBatches),
        recordCliCompatPrompt,
        buildConversationBridgeContext: vi.fn(() => null),
        transcribeAudioAttachments: vi.fn(async () => []),
        prepareImageAttachments: vi.fn(async () => ({
          imagePaths: [],
          acceptedCount: 0,
          skippedMissingPath: 0,
          skippedMissingLocalFile: 0,
          skippedUnsupportedMime: 0,
          skippedTooLarge: 0,
          skippedOverLimit: 0,
          notice: null,
        })),
        prepareDocumentAttachments: vi.fn(async () => ({
          documents: [],
          notice: null,
        })),
        buildExecutionPrompt: vi.fn((basePrompt, _message, _audio, _documents, _bridge, _autoDev, artifactContext) =>
          artifactContext ? `${basePrompt}\n\n${artifactContext}` : basePrompt,
        ),
        resolveAutoDevRuntimeContext: vi.fn(async () => null),
        recordRequestTraceStart: vi.fn(),
        recordRequestTraceProgress: vi.fn(),
        recordRequestTraceFinish: vi.fn(),
        sendNotice,
        sendMessage,
        sendFile,
        startTypingHeartbeat: vi.fn(() => async () => {}),
        handleProgress: vi.fn(async () => {}),
        finishProgress: vi.fn(async () => {}),
        formatBackendToolLabel: vi.fn(() => "codex"),
      },
      {
        message: createMessage("把这两个视频发给我"),
        receivedAt: Date.now() - 100,
        queueWaitMs: 5,
        routePrompt: "把这两个视频发给我",
        sessionKey: "matrix:!room:example.com:@alice:example.com",
        requestId: "req-1",
        roomWorkdir: "/workspace/demo",
        roomConfigSource: "default",
        backendProfile: { provider: "codex", model: null },
        backendRouteSource: "default",
        backendRouteReason: "default_fallback",
        backendRouteRuleId: null,
        sessionRuntime: {
          startExecution: () => ({
            result: Promise.resolve({
              sessionId: "session-1",
              reply:
                "收到，我现在发给你。\n[codeharbor_action]\n{\"type\":\"send_files\",\"files\":[\"video/episode-10.mp4\",\"video/episode-9.mp4\"]}\n[/codeharbor_action]",
            }),
            cancel: () => {},
          }),
        } as never,
        deferFailureHandlingToQueue: false,
        releaseRateLimit: () => {},
      },
    );

    expect(recordCliCompatPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("[codeharbor_action]"),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "!room:example.com",
      "收到，我现在发给你。",
      expect.objectContaining({ requestId: "req-1" }),
    );
    expect(sendFile.mock.calls.map((call) => call.at(1))).toEqual([
      "/workspace/demo/video/episode-10.mp4",
      "/workspace/demo/video/episode-9.mp4",
    ]);
    expect(sendNotice).not.toHaveBeenCalledWith(
      "!room:example.com",
      expect.stringContaining("[codeharbor_action]"),
    );
    expect(appendConversationMessage).toHaveBeenCalledWith(
      "matrix:!room:example.com:@alice:example.com",
      "assistant",
      "codex",
      "收到，我现在发给你。",
    );
  });
});
