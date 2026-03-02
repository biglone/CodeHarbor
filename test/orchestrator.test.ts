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

class FakeStateStore {
  private codexSessionId: string | null = null;
  private readonly processedEventIds = new Set<string>();

  getCodexSessionId(): string | null {
    return this.codexSessionId;
  }

  setCodexSessionId(_sessionKey: string, value: string): void {
    this.codexSessionId = value;
  }

  hasProcessedEvent(_sessionKey: string, eventId: string): boolean {
    return this.processedEventIds.has(eventId);
  }

  markEventProcessed(_sessionKey: string, eventId: string): void {
    this.processedEventIds.add(eventId);
  }
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("Orchestrator", () => {
  it("ignores duplicate events", async () => {
    const channel = new FakeChannel();
    const executor = new FakeExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never);

    const message: InboundMessage = {
      channel: "matrix",
      conversationId: "!room:example.com",
      senderId: "@alice:example.com",
      eventId: "$event",
      text: "ping",
    };

    await orchestrator.handleMessage(message);
    await orchestrator.handleMessage(message);

    expect(executor.callCount).toBe(1);
    expect(channel.sent).toHaveLength(1);
    expect(channel.typing.length).toBeGreaterThan(0);
  });

  it("prunes stale session locks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const channel = new FakeChannel();
    const executor = new FakeExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      lockTtlMs: 1_000,
      lockPruneIntervalMs: 1,
    });

    const room = "!room:example.com";
    await orchestrator.handleMessage({
      channel: "matrix",
      conversationId: room,
      senderId: "@alice:example.com",
      eventId: "$event-1",
      text: "first",
    });
    await orchestrator.handleMessage({
      channel: "matrix",
      conversationId: room,
      senderId: "@bob:example.com",
      eventId: "$event-2",
      text: "second",
    });

    expect((orchestrator as any).sessionLocks.size).toBe(2);

    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    await orchestrator.handleMessage({
      channel: "matrix",
      conversationId: room,
      senderId: "@carol:example.com",
      eventId: "$event-3",
      text: "third",
    });

    expect((orchestrator as any).sessionLocks.size).toBe(1);
    vi.useRealTimers();
  });

  it("retries duplicate events after a failed execution", async () => {
    const channel = new FakeChannel();
    const store = new FakeStateStore();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    let callCount = 0;
    const executor = {
      execute: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("temporary failure");
        }
        return { sessionId: "thread-1", reply: "ok:retry" };
      }),
    };

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never);

    const message: InboundMessage = {
      channel: "matrix",
      conversationId: "!room:example.com",
      senderId: "@alice:example.com",
      eventId: "$retry-event",
      text: "retry me",
    };

    await orchestrator.handleMessage(message);
    await orchestrator.handleMessage(message);

    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(channel.sent).toEqual([
      {
        conversationId: "!room:example.com",
        text: "[CodeHarbor] Failed to process request: temporary failure",
      },
      {
        conversationId: "!room:example.com",
        text: "ok:retry",
      },
    ]);
  });
});
