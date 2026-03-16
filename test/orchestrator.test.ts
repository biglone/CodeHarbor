import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CodexExecutionCancelledError } from "../src/executor/codex-executor";
import { Orchestrator } from "../src/orchestrator";
import { InboundMessage } from "../src/types";

class FakeChannel {
  sent: Array<{ conversationId: string; text: string }> = [];
  notices: Array<{ conversationId: string; text: string }> = [];
  typing: Array<{ conversationId: string; isTyping: boolean; timeoutMs: number }> = [];
  upserts: Array<{ conversationId: string; text: string; replaceEventId: string | null }> = [];

  async sendMessage(conversationId: string, text: string): Promise<void> {
    this.sent.push({ conversationId, text });
  }

  async sendNotice(conversationId: string, text: string): Promise<void> {
    this.notices.push({ conversationId, text });
  }

  async setTyping(conversationId: string, isTyping: boolean, timeoutMs: number): Promise<void> {
    this.typing.push({ conversationId, isTyping, timeoutMs });
  }

  async upsertProgressNotice(conversationId: string, text: string, replaceEventId: string | null): Promise<string> {
    this.upserts.push({ conversationId, text, replaceEventId });
    return replaceEventId ?? `$notice-${this.upserts.length}`;
  }
}

interface FakeSessionState {
  codexSessionId: string | null;
  processedEventIds: Set<string>;
  activeUntil: string | null;
}

class FakeStateStore {
  private readonly sessions = new Map<string, FakeSessionState>();
  private readonly messages = new Map<
    string,
    Array<{
      id: number;
      sessionKey: string;
      role: "user" | "assistant";
      provider: "codex" | "claude";
      content: string;
      createdAt: number;
    }>
  >();
  private messageId = 0;

  getCodexSessionId(sessionKey: string): string | null {
    return this.sessions.get(sessionKey)?.codexSessionId ?? null;
  }

  setCodexSessionId(sessionKey: string, value: string): void {
    this.ensureSession(sessionKey).codexSessionId = value;
  }

  clearCodexSessionId(sessionKey: string): void {
    this.ensureSession(sessionKey).codexSessionId = null;
  }

  hasProcessedEvent(sessionKey: string, eventId: string): boolean {
    return this.ensureSession(sessionKey).processedEventIds.has(eventId);
  }

  markEventProcessed(sessionKey: string, eventId: string): void {
    this.ensureSession(sessionKey).processedEventIds.add(eventId);
  }

  commitExecutionSuccess(sessionKey: string, eventId: string, codexSessionId: string): void {
    const session = this.ensureSession(sessionKey);
    session.codexSessionId = codexSessionId;
    session.processedEventIds.add(eventId);
  }

  commitExecutionHandled(sessionKey: string, eventId: string): void {
    this.ensureSession(sessionKey).processedEventIds.add(eventId);
  }

  isSessionActive(sessionKey: string): boolean {
    const session = this.sessions.get(sessionKey);
    if (!session || !session.activeUntil) {
      return false;
    }
    return Date.now() <= Date.parse(session.activeUntil);
  }

  activateSession(sessionKey: string, activeWindowMs: number): void {
    this.ensureSession(sessionKey).activeUntil = new Date(Date.now() + activeWindowMs).toISOString();
  }

  deactivateSession(sessionKey: string): void {
    this.ensureSession(sessionKey).activeUntil = null;
  }

  getSessionStatus(sessionKey: string): { hasCodexSession: boolean; activeUntil: string | null; isActive: boolean } {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return { hasCodexSession: false, activeUntil: null, isActive: false };
    }
    return {
      hasCodexSession: Boolean(session.codexSessionId),
      activeUntil: session.activeUntil,
      isActive: this.isSessionActive(sessionKey),
    };
  }

  appendConversationMessage(
    sessionKey: string,
    role: "user" | "assistant",
    provider: "codex" | "claude",
    content: string,
  ): void {
    const normalized = content.trim();
    if (!normalized) {
      return;
    }
    const history = this.messages.get(sessionKey) ?? [];
    this.messageId += 1;
    history.push({
      id: this.messageId,
      sessionKey,
      role,
      provider,
      content: normalized,
      createdAt: Date.now(),
    });
    this.messages.set(sessionKey, history);
  }

  listRecentConversationMessages(
    sessionKey: string,
    limit: number,
  ): Array<{
    id: number;
    sessionKey: string;
    role: "user" | "assistant";
    provider: "codex" | "claude";
    content: string;
    createdAt: number;
  }> {
    const history = this.messages.get(sessionKey) ?? [];
    return history.slice(Math.max(0, history.length - Math.max(1, Math.floor(limit))));
  }

  private ensureSession(sessionKey: string): FakeSessionState {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }
    const created: FakeSessionState = {
      codexSessionId: null,
      processedEventIds: new Set<string>(),
      activeUntil: null,
    };
    this.sessions.set(sessionKey, created);
    return created;
  }
}

class ImmediateExecutor {
  callCount = 0;
  calls: Array<{ text: string; sessionId: string | null; workdir: string | null }> = [];

  startExecution(
    text: string,
    sessionId: string | null,
    _onProgress?: (event: unknown) => void,
    startOptions?: { workdir?: string },
  ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.callCount += 1;
    this.calls.push({
      text,
      sessionId,
      workdir: startOptions?.workdir ?? null,
    });
    return {
      result: Promise.resolve({ sessionId: sessionId ?? "thread-1", reply: `ok:${text}` }),
      cancel: () => {},
    };
  }
}

class CancellableExecutor {
  callCount = 0;
  private rejectCurrent: ((error: unknown) => void) | null = null;

  startExecution(): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.callCount += 1;
    const result = new Promise<{ sessionId: string; reply: string }>((_resolve, reject) => {
      this.rejectCurrent = reject;
    });

    return {
      result,
      cancel: () => {
        this.rejectCurrent?.(new CodexExecutionCancelledError());
      },
    };
  }
}

class WorkflowExecutor {
  callCount = 0;
  reviewCount = 0;
  calls: Array<{ text: string; sessionId: string | null; workdir: string | null }> = [];

  startExecution(
    text: string,
    sessionId: string | null,
    _onProgress?: (event: unknown) => void,
    startOptions?: { workdir?: string },
  ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.callCount += 1;
    this.calls.push({
      text,
      sessionId,
      workdir: startOptions?.workdir ?? null,
    });

    let reply = `echo:${text}`;
    if (text.includes("[role:planner]")) {
      reply = "1) 拆解任务\n2) 编写实现\n3) 验证并交付";
    } else if (text.includes("[role:executor]") && text.includes("[reviewer_feedback]")) {
      reply = "已根据审查反馈完成修复版本。";
    } else if (text.includes("[role:executor]")) {
      reply = "初始交付版本。";
    } else if (text.includes("[role:reviewer]")) {
      this.reviewCount += 1;
      if (this.reviewCount === 1) {
        reply = "VERDICT: REJECTED\nSUMMARY: 首轮不通过\nISSUES:\n- 缺少关键细节";
      } else {
        reply = "VERDICT: APPROVED\nSUMMARY: 通过\nISSUES:\n- none";
      }
    }

    return {
      result: Promise.resolve({
        sessionId: sessionId ?? `wf-thread-${this.callCount}`,
        reply,
      }),
      cancel: () => {},
    };
  }
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeInbound(partial: Partial<InboundMessage> = {}): InboundMessage {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    channel: "matrix",
    conversationId: "!room:example.com",
    senderId: "@alice:example.com",
    eventId: "$event",
    text: "ping",
    attachments: [],
    isDirectMessage: false,
    mentionsBot: false,
    repliesToBot: false,
    ...partial,
  };
}

describe("Orchestrator", () => {
  it("respects room-level trigger policy for prefix-only groups", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      defaultGroupTriggerPolicy: {
        allowMention: false,
        allowReply: false,
        allowActiveWindow: false,
        allowPrefix: true,
      },
      progressUpdatesEnabled: false,
    });

    await orchestrator.handleMessage(
      makeInbound({
        text: "@bot:example.com 你好",
        mentionsBot: true,
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        eventId: "$e2",
        text: "!code 你好",
      }),
    );

    expect(executor.callCount).toBe(1);
    expect(channel.sent[0]?.text).toBe("ok:你好");
  });

  it("processes plain group messages when group direct mode is enabled", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      groupDirectModeEnabled: true,
      progressUpdatesEnabled: false,
    });

    await orchestrator.handleMessage(
      makeInbound({
        text: "直接处理这条群消息",
        mentionsBot: false,
        repliesToBot: false,
      }),
    );

    expect(executor.callCount).toBe(1);
    expect(channel.sent[0]?.text).toBe("ok:直接处理这条群消息");
  });

  it("rejects requests when user is rate-limited", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
      rateLimiterOptions: {
        windowMs: 60_000,
        maxRequestsPerUser: 1,
        maxRequestsPerRoom: 100,
        maxConcurrentGlobal: 10,
        maxConcurrentPerUser: 10,
        maxConcurrentPerRoom: 10,
      },
    });

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "first", eventId: "$r1" }));
    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "second", eventId: "$r2" }));

    expect(executor.callCount).toBe(1);
    expect(channel.notices.some((entry) => entry.text.includes("请求过于频繁"))).toBe(true);
  });

  it("/stop cancels an active execution immediately", async () => {
    const channel = new FakeChannel();
    const executor = new CancellableExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
    });

    const runningPromise = orchestrator.handleMessage(
      makeInbound({
        requestId: "req-main",
        isDirectMessage: true,
        text: "请持续执行",
        eventId: "$main",
      }),
    );

    await Promise.resolve();
    await orchestrator.handleMessage(
      makeInbound({
        requestId: "req-stop",
        isDirectMessage: true,
        text: "/stop",
        eventId: "$stop",
      }),
    );

    await expect(runningPromise).resolves.toBeUndefined();
    expect(channel.notices.some((entry) => entry.text.includes("已请求停止当前任务"))).toBe(true);
    expect(channel.sent.some((entry) => entry.text.includes("Failed to process request"))).toBe(false);
  });

  it("uses room-configured workdir for execution", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
    const store = new FakeStateStore();
    const configService = {
      resolveRoomConfig: vi.fn().mockReturnValue({
        source: "room",
        enabled: true,
        triggerPolicy: {
          allowMention: true,
          allowReply: true,
          allowActiveWindow: true,
          allowPrefix: true,
        },
        workdir: "/tmp/project-b",
      }),
    };
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
      configService: configService as never,
      defaultCodexWorkdir: "/tmp/default-project",
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "执行任务",
        eventId: "$workdir",
      }),
    );

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.workdir).toBe("/tmp/project-b");
  });

  it("ignores group messages when room config is disabled", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
    const store = new FakeStateStore();
    const configService = {
      resolveRoomConfig: vi.fn().mockReturnValue({
        source: "room",
        enabled: false,
        triggerPolicy: {
          allowMention: true,
          allowReply: true,
          allowActiveWindow: true,
          allowPrefix: true,
        },
        workdir: "/tmp/disabled-room",
      }),
    };
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
      configService: configService as never,
      defaultCodexWorkdir: "/tmp/default",
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: false,
        mentionsBot: true,
        text: "@bot:example.com 请处理",
        eventId: "$disabled-room",
      }),
    );

    expect(executor.calls).toHaveLength(0);
    expect(channel.sent).toHaveLength(0);
  });

  it("cleans up hydrated attachment files for ignored messages", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-ignored-attachment-"));
    const imagePath = path.join(tempRoot, "input.png");
    const audioPath = path.join(tempRoot, "voice.m4a");
    await fs.writeFile(imagePath, "payload", "utf8");
    await fs.writeFile(audioPath, "payload", "utf8");

    try {
      const channel = new FakeChannel();
      const executor = new ImmediateExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: false,
          mentionsBot: false,
          repliesToBot: false,
          text: "普通群聊消息",
          eventId: "$ignored-attachment",
          attachments: [
            {
              kind: "image",
              name: "input.png",
              mxcUrl: "mxc://example.com/media",
              mimeType: "image/png",
              sizeBytes: 7,
              localPath: imagePath,
            },
            {
              kind: "audio",
              name: "voice.m4a",
              mxcUrl: "mxc://example.com/audio",
              mimeType: "audio/mp4",
              sizeBytes: 9,
              localPath: audioPath,
            },
          ],
        }),
      );

      await expect(fs.access(imagePath)).rejects.toBeDefined();
      await expect(fs.access(audioPath)).rejects.toBeDefined();
      expect(executor.calls).toHaveLength(0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("appends audio transcript context to prompt", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-audio-"));
    const audioPath = path.join(tempRoot, "voice.m4a");
    await fs.writeFile(audioPath, "payload", "utf8");

    const transcriber = {
      isEnabled: () => true,
      transcribeMany: vi.fn(async () => [{ name: "voice.m4a", text: "请帮我总结会议重点" }]),
    };

    try {
      const channel = new FakeChannel();
      const executor = new ImmediateExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        audioTranscriber: transcriber as never,
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "请处理这个语音",
          eventId: "$audio-transcript",
          attachments: [
            {
              kind: "audio",
              name: "voice.m4a",
              mxcUrl: "mxc://example.com/audio",
              mimeType: "audio/mp4",
              sizeBytes: 99,
              localPath: audioPath,
            },
          ],
        }),
      );

      expect(transcriber.transcribeMany).toHaveBeenCalledTimes(1);
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.text).toContain("[audio_transcripts]");
      expect(executor.calls[0]?.text).toContain("voice.m4a");
      expect(executor.calls[0]?.text).toContain("请帮我总结会议重点");
      await expect(fs.access(audioPath)).rejects.toBeDefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips audio transcription for oversized attachments", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-audio-limit-"));
    const audioPath = path.join(tempRoot, "voice.m4a");
    await fs.writeFile(audioPath, "payload", "utf8");

    const transcriber = {
      isEnabled: () => true,
      transcribeMany: vi.fn(async () => [{ name: "voice.m4a", text: "ignored" }]),
    };

    try {
      const channel = new FakeChannel();
      const executor = new ImmediateExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        audioTranscriber: transcriber as never,
        cliCompat: {
          enabled: false,
          passThroughEvents: false,
          preserveWhitespace: false,
          disableReplyChunkSplit: false,
          progressThrottleMs: 300,
          fetchMedia: false,
          transcribeAudio: true,
          audioTranscribeModel: "gpt-4o-mini-transcribe",
          audioTranscribeTimeoutMs: 120000,
          audioTranscribeMaxChars: 6000,
          audioTranscribeMaxRetries: 1,
          audioTranscribeRetryDelayMs: 800,
          audioTranscribeMaxBytes: 1,
          audioLocalWhisperCommand: null,
          audioLocalWhisperTimeoutMs: 180000,
          recordPath: null,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "请处理这个语音",
          eventId: "$audio-limit",
          attachments: [
            {
              kind: "audio",
              name: "voice.m4a",
              mxcUrl: "mxc://example.com/audio",
              mimeType: "audio/mp4",
              sizeBytes: 9999,
              localPath: audioPath,
            },
          ],
        }),
      );

      expect(transcriber.transcribeMany).not.toHaveBeenCalled();
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.text).not.toContain("[audio_transcripts]");
      await expect(fs.access(audioPath)).rejects.toBeDefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies roomTriggerPolicies override when config service is absent", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
      defaultGroupTriggerPolicy: {
        allowMention: false,
        allowReply: false,
        allowActiveWindow: false,
        allowPrefix: false,
      },
      roomTriggerPolicies: {
        "!room:example.com": {
          allowPrefix: true,
        },
      },
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: false,
        text: "!code do this",
        eventId: "$room-policy",
      }),
    );

    expect(executor.calls).toHaveLength(1);
    expect(channel.sent[0]?.text).toBe("ok:do this");
  });

  it("prunes stale workflow snapshots during lock maintenance", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
      lockPruneIntervalMs: 0,
    });

    const oldIso = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    const runtime = orchestrator as unknown as {
      workflowSnapshots: Map<string, unknown>;
      autoDevSnapshots: Map<string, unknown>;
    };
    runtime.workflowSnapshots.set("old-workflow", {
      state: "succeeded",
      startedAt: oldIso,
      endedAt: oldIso,
      objective: "legacy",
      approved: true,
      repairRounds: 0,
      error: null,
    });
    runtime.autoDevSnapshots.set("old-autodev", {
      state: "failed",
      startedAt: oldIso,
      endedAt: oldIso,
      taskId: "T0.1",
      taskDescription: "legacy",
      approved: null,
      repairRounds: 0,
      error: "stale",
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "触发一次清理",
        eventId: "$snapshot-prune",
      }),
    );

    expect(runtime.workflowSnapshots.has("old-workflow")).toBe(false);
    expect(runtime.autoDevSnapshots.has("old-autodev")).toBe(false);
  });

  it("keeps legacy behavior when workflow is disabled", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/agents run 生成方案",
        eventId: "$legacy-workflow",
      }),
    );

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.text).toBe("/agents run 生成方案");
    expect(channel.sent[0]?.text).toBe("ok:/agents run 生成方案");
  });

  it("keeps legacy behavior for /autodev when workflow is disabled", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/autodev run T1.1",
        eventId: "$legacy-autodev",
      }),
    );

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.text).toBe("/autodev run T1.1");
    expect(channel.sent[0]?.text).toBe("ok:/autodev run T1.1");
  });

  it("runs /autodev and marks selected task completed when approved", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-"));
    const requirementsPath = path.join(tempRoot, "REQUIREMENTS.md");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(requirementsPath, "# Requirements\n- implement T9.1\n", "utf8");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 预估时间 | 优先级 | 依赖 | 状态 |",
        "|--------|----------|----------|--------|------|------|",
        "| T9.1 | 实现自动化能力 | 1h | P0 | - | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    try {
      const channel = new FakeChannel();
      const executor = new WorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run",
          eventId: "$autodev-run",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T9.1 | 实现自动化能力 | 1h | P0 | - | ✅ |");
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 启动任务 T9.1"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 任务结果"))).toBe(true);
      expect(executor.calls.some((call) => call.text.includes("[role:planner]"))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports /autodev status with task summary and next task", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-status-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T1.1 | first | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    try {
      const channel = new FakeChannel();
      const executor = new WorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev status",
          eventId: "$autodev-status",
        }),
      );

      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 状态"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("nextTask: T1.1 first (⬜)"))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs multi-agent workflow when enabled", async () => {
    const channel = new FakeChannel();
    const executor = new WorkflowExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
      multiAgentWorkflow: {
        enabled: true,
        autoRepairMaxRounds: 1,
      },
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/agents run 分析并落盘",
        eventId: "$wf-1",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/agents status",
        eventId: "$wf-status",
      }),
    );

    expect(executor.callCount).toBeGreaterThanOrEqual(5);
    expect(channel.sent.some((entry) => entry.text.includes("Multi-Agent workflow 完成"))).toBe(true);
    expect(channel.sent.some((entry) => entry.text.includes("[planner]"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("state: succeeded"))).toBe(true);
  });
});
