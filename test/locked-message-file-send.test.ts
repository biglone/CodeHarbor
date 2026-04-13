import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeLockedMessage } from "../src/orchestrator/locked-message-execution";
import type { RecentArtifactBatch } from "../src/orchestrator/file-send-intent";
import type { InboundMessage } from "../src/types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }),
  );
  tempDirs.length = 0;
});

async function createTempWorkdir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-locked-file-send-"));
  tempDirs.push(directory);
  return directory;
}

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

function createDeps(workdir: string, recentArtifactBatches: RecentArtifactBatch[] = []) {
  const sendFile = vi.fn<
    (conversationId: string, filePath: string, options?: { fileName?: string; mimeType?: string | null }) => Promise<void>
  >(async () => {});
  const sendNotice = vi.fn<(conversationId: string, text: string) => Promise<void>>(async () => {});
  const executeChatRun = vi.fn(async () => {});
  const release = vi.fn();
  const markEventProcessed = vi.fn();
  const recordRequestMetrics = vi.fn();

  const deps = {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    workflowEnabled: false,
    hasProcessedEvent: vi.fn(() => false),
    markEventProcessed,
    recordRequestMetrics,
    resolveRoomRuntimeConfig: vi.fn(() => ({
      enabled: true,
      triggerPolicy: {
        allowMention: true,
        allowReply: true,
        allowActiveWindow: true,
        allowPrefix: true,
      },
      source: "default" as const,
      workdir,
    })),
    routeMessage: vi.fn((message: InboundMessage) => ({
      kind: "execute" as const,
      prompt: message.text,
    })),
    handleControlCommand: vi.fn(async () => {}),
    handleWorkflowStatusCommand: vi.fn(async () => {}),
    handleAutoDevStatusCommand: vi.fn(async () => {}),
    handleAutoDevProgressCommand: vi.fn(async () => {}),
    handleAutoDevContentCommand: vi.fn(async () => {}),
    handleAutoDevSkillsCommand: vi.fn(async () => {}),
    handleAutoDevLoopStopCommand: vi.fn(async () => {}),
    handleAutoDevReconcileCommand: vi.fn(async () => {}),
    handleAutoDevWorkdirCommand: vi.fn(async () => {}),
    handleAutoDevInitCommand: vi.fn(async () => {}),
    tryHandleAutoDevSecondaryReviewReceipt: vi.fn(async () => false),
    getTaskQueueStateStore: vi.fn(() => null),
    tryAcquireRateLimit: vi.fn(() => ({
      allowed: true,
      release,
    })),
    sendNotice,
    sendFile,
    listRecentArtifactBatches: vi.fn(() => recentArtifactBatches),
    classifyBackendTaskType: vi.fn(() => "chat"),
    resolveSessionBackendDecision: vi.fn(() => ({
      profile: { provider: "codex" as const, model: null },
      source: "default" as const,
      reasonCode: "default_fallback" as const,
      ruleId: null,
    })),
    prepareBackendRuntimeForSession: vi.fn(() => ({
      executor: {} as never,
      sessionRuntime: {} as never,
    })),
    setSessionLastBackendDecision: vi.fn(),
    recordBackendRouteDecision: vi.fn(),
    executeWorkflowRun: vi.fn(async () => {}),
    executeAutoDevRun: vi.fn(async () => {}),
    executeChatRun,
  };

  return {
    deps,
    spies: {
      sendFile,
      sendNotice,
      executeChatRun,
      release,
      markEventProcessed,
      recordRequestMetrics,
    },
  };
}

describe("executeLockedMessage semantic file send", () => {
  it("detects and sends matched local file without invoking AI runtime", async () => {
    const workdir = await createTempWorkdir();
    const artifact = path.join(workdir, "dist", "result.mp4");
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "video-bytes");

    const message = createMessage("把生成的 result.mp4 文件发送给我");
    const { deps, spies } = createDeps(workdir);

    await executeLockedMessage(deps as never, {
      message,
      requestId: message.requestId,
      sessionKey: "matrix:!room:example.com:@alice:example.com",
      receivedAt: Date.now() - 20,
      bypassQueue: false,
      forcedPrompt: null,
      deferFailureHandlingToQueue: false,
    });

    expect(spies.sendFile).toHaveBeenCalledTimes(1);
    expect(spies.sendFile.mock.calls[0]?.[1]).toBe(artifact);
    expect(spies.executeChatRun).not.toHaveBeenCalled();
    expect(spies.markEventProcessed).toHaveBeenCalledWith(
      "matrix:!room:example.com:@alice:example.com",
      message.eventId,
    );
    expect(spies.release).toHaveBeenCalledTimes(1);
    expect(spies.recordRequestMetrics).toHaveBeenCalledWith("success", expect.any(Number), expect.any(Number), expect.any(Number));
  });

  it("sends latest video for generic video request instead of newer non-video log", async () => {
    const workdir = await createTempWorkdir();
    const video = path.join(workdir, "dist", "lesson-5.mp4");
    const log = path.join(workdir, "data", "003967.log");
    await fs.mkdir(path.dirname(video), { recursive: true });
    await fs.mkdir(path.dirname(log), { recursive: true });
    await fs.writeFile(video, "video-bytes");
    await new Promise((resolve) => setTimeout(resolve, 12));
    await fs.writeFile(log, "log-bytes");

    const message = createMessage("接着完成下一节的视频，并把生成好的视频直接发给我");
    const { deps, spies } = createDeps(workdir);

    await executeLockedMessage(deps as never, {
      message,
      requestId: message.requestId,
      sessionKey: "matrix:!room:example.com:@alice:example.com",
      receivedAt: Date.now() - 20,
      bypassQueue: false,
      forcedPrompt: null,
      deferFailureHandlingToQueue: false,
    });

    expect(spies.sendFile).toHaveBeenCalledTimes(1);
    expect(spies.sendFile.mock.calls[0]?.[1]).toBe(video);
    expect(spies.executeChatRun).not.toHaveBeenCalled();
    expect(spies.markEventProcessed).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit filename requests on direct fallback path even when recent artifact batches exist", async () => {
    const workdir = await createTempWorkdir();
    const artifact = path.join(workdir, "dist", "result.mp4");
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, "video-bytes");

    const message = createMessage("把生成的 result.mp4 文件发送给我");
    const { deps, spies } = createDeps(workdir, [
      {
        requestId: "req-batch",
        workdir,
        createdAt: Date.now(),
        files: [
          {
            absolutePath: artifact,
            relativePath: "dist/result.mp4",
            sizeBytes: 11,
            mtimeMs: Date.now(),
          },
        ],
      },
    ]);

    await executeLockedMessage(deps as never, {
      message,
      requestId: message.requestId,
      sessionKey: "matrix:!room:example.com:@alice:example.com",
      receivedAt: Date.now() - 20,
      bypassQueue: false,
      forcedPrompt: null,
      deferFailureHandlingToQueue: false,
    });

    expect(spies.sendFile).toHaveBeenCalledTimes(1);
    expect(spies.executeChatRun).not.toHaveBeenCalled();
  });

  it("sends multiple matched videos when user asks for four video files", async () => {
    const workdir = await createTempWorkdir();
    const files = [
      path.join(workdir, "video-auto-pipeline", "agent-skill-episode7-v1-no-rightbars.mp4"),
      path.join(workdir, "video-auto-pipeline", "agent-skill-episode8-v1-no-rightbars.mp4"),
      path.join(workdir, "video-auto-pipeline", "agent-skill-episode9-v1-no-rightbars.mp4"),
      path.join(workdir, "video-auto-pipeline", "agent-skill-episode10-v1-no-rightbars.mp4"),
    ];
    await fs.mkdir(path.dirname(files[0]!), { recursive: true });
    for (const file of files) {
      await fs.writeFile(file, path.basename(file));
      await new Promise((resolve) => setTimeout(resolve, 12));
    }

    const message = createMessage("这四个视频文件以消息的形式发给我");
    const { deps, spies } = createDeps(workdir);

    await executeLockedMessage(deps as never, {
      message,
      requestId: message.requestId,
      sessionKey: "matrix:!room:example.com:@alice:example.com",
      receivedAt: Date.now() - 20,
      bypassQueue: false,
      forcedPrompt: null,
      deferFailureHandlingToQueue: false,
    });

    expect(spies.sendFile).toHaveBeenCalledTimes(4);
    expect(spies.sendFile.mock.calls.map((call) => call[1])).toEqual([
      files[3],
      files[2],
      files[1],
      files[0],
    ]);
    expect(spies.executeChatRun).not.toHaveBeenCalled();
    expect(spies.markEventProcessed).toHaveBeenCalledTimes(1);
    expect(String(spies.sendNotice.mock.calls.at(-1)?.[1] ?? "")).toContain("已发送 4 个文件");
  });

  it("routes contextual file-delivery requests to chat runtime when recent artifact batches exist", async () => {
    const workdir = await createTempWorkdir();
    const batchFiles = [
      path.join(workdir, "video-auto-pipeline", "agent-skill-episode7-v1-no-rightbars.mp4"),
      path.join(workdir, "video-auto-pipeline", "agent-skill-episode8-v1-no-rightbars.mp4"),
      path.join(workdir, "video-auto-pipeline", "agent-skill-episode9-v1-no-rightbars.mp4"),
      path.join(workdir, "video-auto-pipeline", "agent-skill-episode10-v1-no-rightbars.mp4"),
    ];
    await fs.mkdir(path.dirname(batchFiles[0]!), { recursive: true });
    for (const file of batchFiles) {
      await fs.writeFile(file, path.basename(file));
      await new Promise((resolve) => setTimeout(resolve, 12));
    }

    const recentArtifactBatches: RecentArtifactBatch[] = [
      {
        requestId: "req-batch",
        workdir,
        createdAt: Date.now(),
        files: [
          { absolutePath: batchFiles[3]!, relativePath: "video-auto-pipeline/agent-skill-episode10-v1-no-rightbars.mp4", sizeBytes: 38, mtimeMs: Date.now() - 1 },
          { absolutePath: batchFiles[2]!, relativePath: "video-auto-pipeline/agent-skill-episode9-v1-no-rightbars.mp4", sizeBytes: 37, mtimeMs: Date.now() - 2 },
          { absolutePath: batchFiles[1]!, relativePath: "video-auto-pipeline/agent-skill-episode8-v1-no-rightbars.mp4", sizeBytes: 37, mtimeMs: Date.now() - 3 },
          { absolutePath: batchFiles[0]!, relativePath: "video-auto-pipeline/agent-skill-episode7-v1-no-rightbars.mp4", sizeBytes: 37, mtimeMs: Date.now() - 4 },
        ],
      },
    ];

    const message = createMessage("把这四个视频文件发给我");
    const { deps, spies } = createDeps(workdir, recentArtifactBatches);

    await executeLockedMessage(deps as never, {
      message,
      requestId: message.requestId,
      sessionKey: "matrix:!room:example.com:@alice:example.com",
      receivedAt: Date.now() - 20,
      bypassQueue: false,
      forcedPrompt: null,
      deferFailureHandlingToQueue: false,
    });

    expect(spies.sendFile).not.toHaveBeenCalled();
    expect(spies.executeChatRun).toHaveBeenCalledTimes(1);
    const chatRunInput = spies.executeChatRun.mock.calls.at(0)?.at(0);
    expect(chatRunInput).toMatchObject({
      routePrompt: "把这四个视频文件发给我",
      roomWorkdir: workdir,
    });
  });

  it("sends not-found notice when requested file is missing", async () => {
    const workdir = await createTempWorkdir();
    const message = createMessage("把生成的 missing.mp4 文件发送给我");
    const { deps, spies } = createDeps(workdir);

    await executeLockedMessage(deps as never, {
      message,
      requestId: message.requestId,
      sessionKey: "matrix:!room:example.com:@alice:example.com",
      receivedAt: Date.now() - 20,
      bypassQueue: false,
      forcedPrompt: null,
      deferFailureHandlingToQueue: false,
    });

    expect(spies.sendFile).not.toHaveBeenCalled();
    expect(spies.executeChatRun).not.toHaveBeenCalled();
    expect(spies.sendNotice).toHaveBeenCalledTimes(1);
    expect(String(spies.sendNotice.mock.calls[0]?.[1] ?? "")).toContain("未找到可发送的文件");
    expect(spies.markEventProcessed).toHaveBeenCalledTimes(1);
    expect(spies.recordRequestMetrics).toHaveBeenCalledWith("failed", expect.any(Number), expect.any(Number), 0);
  });
});
