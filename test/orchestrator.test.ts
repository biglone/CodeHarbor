import { describe, expect, it, vi } from "vitest";

import { Orchestrator } from "../src/orchestrator";
import { InboundMessage } from "../src/types";

class FakeChannel {
  sent: Array<{ conversationId: string; text: string }> = [];
  notices: Array<{ conversationId: string; text: string }> = [];
  typing: Array<{ conversationId: string; isTyping: boolean; timeoutMs: number }> = [];

  async sendMessage(conversationId: string, text: string): Promise<void> {
    this.sent.push({ conversationId, text });
  }

  async sendNotice(conversationId: string, text: string): Promise<void> {
    this.notices.push({ conversationId, text });
  }

  async setTyping(conversationId: string, isTyping: boolean, timeoutMs: number): Promise<void> {
    this.typing.push({ conversationId, isTyping, timeoutMs });
  }
}

class FakeExecutor {
  callCount = 0;

  async execute(
    text: string,
    sessionId: string | null,
    _onProgress?: (event: unknown) => void,
  ): Promise<{ sessionId: string; reply: string }> {
    this.callCount += 1;
    return { sessionId: sessionId ?? "thread-1", reply: `ok:${text}` };
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

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeInbound(partial: Partial<InboundMessage> = {}): InboundMessage {
  return {
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
  it("ignores non-triggered group messages", async () => {
    const channel = new FakeChannel();
    const executor = new FakeExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      sessionActiveWindowMinutes: 20,
    });

    await orchestrator.handleMessage(makeInbound({ text: "hello" }));

    expect(executor.callCount).toBe(0);
    expect(channel.sent).toHaveLength(0);
  });

  it("processes direct messages without prefix", async () => {
    const channel = new FakeChannel();
    const executor = new FakeExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      sessionActiveWindowMinutes: 20,
    });

    await orchestrator.handleMessage(
      makeInbound({
        text: "请帮我优化这段代码",
        isDirectMessage: true,
      }),
    );

    expect(executor.callCount).toBe(1);
    expect(channel.sent[0]?.text).toBe("ok:请帮我优化这段代码");
    expect(channel.typing.some((entry) => entry.isTyping)).toBe(true);
  });

  it("processes group messages when bot is mentioned", async () => {
    const channel = new FakeChannel();
    const executor = new FakeExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      sessionActiveWindowMinutes: 20,
    });

    await orchestrator.handleMessage(
      makeInbound({
        text: "@bot:example.com 修复这个 bug",
        mentionsBot: true,
      }),
    );

    expect(executor.callCount).toBe(1);
    expect(channel.sent[0]?.text).toBe("ok:修复这个 bug");
  });

  it("supports /status and /stop control commands", async () => {
    const channel = new FakeChannel();
    const executor = new FakeExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      sessionActiveWindowMinutes: 20,
    });

    await orchestrator.handleMessage(makeInbound({ text: "/status", isDirectMessage: true, eventId: "$s1" }));
    await orchestrator.handleMessage(makeInbound({ text: "/stop", isDirectMessage: true, eventId: "$s2" }));

    expect(executor.callCount).toBe(0);
    expect(channel.notices.some((entry) => entry.text.includes("当前状态"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("会话已停止"))).toBe(true);
  });

  it("ignores duplicate processed events", async () => {
    const channel = new FakeChannel();
    const executor = new FakeExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      sessionActiveWindowMinutes: 20,
    });

    const message = makeInbound({ text: "hello", isDirectMessage: true });
    await orchestrator.handleMessage(message);
    await orchestrator.handleMessage(message);

    expect(executor.callCount).toBe(1);
    expect(channel.sent).toHaveLength(1);
  });
});
