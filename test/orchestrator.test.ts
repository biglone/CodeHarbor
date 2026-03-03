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

  startExecution(
    text: string,
    sessionId: string | null,
    _onProgress?: (event: unknown) => void,
  ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.callCount += 1;
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
});
