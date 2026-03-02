import { describe, expect, it, vi } from "vitest";

import { Orchestrator } from "../src/orchestrator";
import { InboundMessage } from "../src/types";

class FakeChannel {
  sent: Array<{ conversationId: string; text: string }> = [];

  async sendMessage(conversationId: string, text: string): Promise<void> {
    this.sent.push({ conversationId, text });
  }
}

class FakeExecutor {
  callCount = 0;

  async execute(text: string, sessionId: string | null): Promise<{ sessionId: string; reply: string }> {
    this.callCount += 1;
    return { sessionId: sessionId ?? "thread-1", reply: `ok:${text}` };
  }
}

class FakeStateStore {
  private codexSessionId: string | null = null;
  private readonly eventIds = new Set<string>();

  getCodexSessionId(): string | null {
    return this.codexSessionId;
  }

  setCodexSessionId(_sessionKey: string, value: string): void {
    this.codexSessionId = value;
  }

  markEventIfNew(_sessionKey: string, eventId: string): boolean {
    if (this.eventIds.has(eventId)) {
      return false;
    }
    this.eventIds.add(eventId);
    return true;
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
  });
});
