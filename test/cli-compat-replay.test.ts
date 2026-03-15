import { describe, expect, it, vi } from "vitest";

import { Orchestrator } from "../src/orchestrator";
import { InboundAttachment, InboundMessage } from "../src/types";

class FakeChannel {
  sent: Array<{ conversationId: string; text: string }> = [];
  notices: Array<{ conversationId: string; text: string }> = [];

  async sendMessage(conversationId: string, text: string): Promise<void> {
    this.sent.push({ conversationId, text });
  }

  async sendNotice(conversationId: string, text: string): Promise<void> {
    this.notices.push({ conversationId, text });
  }

  async upsertProgressNotice(_conversationId: string, _text: string, _replaceEventId: string | null): Promise<string> {
    return "$progress";
  }

  async setTyping(_conversationId: string, _isTyping: boolean, _timeoutMs: number): Promise<void> {}
}

interface SessionState {
  codexSessionId: string | null;
  processed: Set<string>;
  activeUntil: string | null;
}

class FakeStateStore {
  private readonly map = new Map<string, SessionState>();

  getCodexSessionId(sessionKey: string): string | null {
    return this.ensure(sessionKey).codexSessionId;
  }

  setCodexSessionId(sessionKey: string, codexSessionId: string): void {
    this.ensure(sessionKey).codexSessionId = codexSessionId;
  }

  clearCodexSessionId(sessionKey: string): void {
    this.ensure(sessionKey).codexSessionId = null;
  }

  hasProcessedEvent(sessionKey: string, eventId: string): boolean {
    return this.ensure(sessionKey).processed.has(eventId);
  }

  markEventProcessed(sessionKey: string, eventId: string): void {
    this.ensure(sessionKey).processed.add(eventId);
  }

  commitExecutionSuccess(sessionKey: string, eventId: string, codexSessionId: string): void {
    const session = this.ensure(sessionKey);
    session.codexSessionId = codexSessionId;
    session.processed.add(eventId);
  }

  commitExecutionHandled(sessionKey: string, eventId: string): void {
    this.ensure(sessionKey).processed.add(eventId);
  }

  isSessionActive(sessionKey: string): boolean {
    const activeUntil = this.ensure(sessionKey).activeUntil;
    if (!activeUntil) {
      return false;
    }
    return Date.now() <= Date.parse(activeUntil);
  }

  activateSession(sessionKey: string, activeWindowMs: number): void {
    this.ensure(sessionKey).activeUntil = new Date(Date.now() + activeWindowMs).toISOString();
  }

  deactivateSession(sessionKey: string): void {
    this.ensure(sessionKey).activeUntil = null;
  }

  getSessionStatus(sessionKey: string): { hasCodexSession: boolean; activeUntil: string | null; isActive: boolean } {
    const session = this.ensure(sessionKey);
    return {
      hasCodexSession: Boolean(session.codexSessionId),
      activeUntil: session.activeUntil,
      isActive: this.isSessionActive(sessionKey),
    };
  }

  private ensure(sessionKey: string): SessionState {
    const existing = this.map.get(sessionKey);
    if (existing) {
      return existing;
    }
    const created: SessionState = {
      codexSessionId: null,
      processed: new Set<string>(),
      activeUntil: null,
    };
    this.map.set(sessionKey, created);
    return created;
  }
}

class CaptureExecutor {
  prompts: string[] = [];

  startExecution(prompt: string, sessionId: string | null): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.prompts.push(prompt);
    return {
      result: Promise.resolve({ sessionId: sessionId ?? "thread-compat", reply: "ok" }),
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
    requestId: "req-compat",
    channel: "matrix",
    conversationId: "!room:example.com",
    senderId: "@alice:example.com",
    eventId: "$event-compat",
    text: "hello",
    attachments: [],
    isDirectMessage: true,
    mentionsBot: false,
    repliesToBot: false,
    ...partial,
  };
}

describe("CLI compat replay", () => {
  it("preserves whitespace in prompt body", async () => {
    const channel = new FakeChannel();
    const executor = new CaptureExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      cliCompat: {
        enabled: true,
        passThroughEvents: true,
        preserveWhitespace: true,
        disableReplyChunkSplit: true,
        progressThrottleMs: 0,
        fetchMedia: false,
        transcribeAudio: false,
        audioTranscribeModel: "gpt-4o-mini-transcribe",
        audioTranscribeTimeoutMs: 120000,
        audioTranscribeMaxChars: 6000,
        recordPath: null,
      },
      matrixUserId: "@bot:example.com",
      commandPrefix: "!code",
    });

    await orchestrator.handleMessage(makeInbound({ text: "  keep me  \nline2" }));

    expect(executor.prompts[0]).toBe("  keep me  \nline2");
  });

  it("does not strip bot mention in compat mode", async () => {
    const channel = new FakeChannel();
    const executor = new CaptureExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      cliCompat: {
        enabled: true,
        passThroughEvents: true,
        preserveWhitespace: true,
        disableReplyChunkSplit: true,
        progressThrottleMs: 0,
        fetchMedia: false,
        transcribeAudio: false,
        audioTranscribeModel: "gpt-4o-mini-transcribe",
        audioTranscribeTimeoutMs: 120000,
        audioTranscribeMaxChars: 6000,
        recordPath: null,
      },
      matrixUserId: "@bot:example.com",
      commandPrefix: "!code",
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: false,
        mentionsBot: true,
        text: "@bot:example.com 你还在吗",
      }),
    );

    expect(executor.prompts[0]).toContain("@bot:example.com");
  });

  it("appends attachment metadata to prompt without dropping text", async () => {
    const channel = new FakeChannel();
    const executor = new CaptureExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      cliCompat: {
        enabled: true,
        passThroughEvents: true,
        preserveWhitespace: true,
        disableReplyChunkSplit: true,
        progressThrottleMs: 0,
        fetchMedia: false,
        transcribeAudio: false,
        audioTranscribeModel: "gpt-4o-mini-transcribe",
        audioTranscribeTimeoutMs: 120000,
        audioTranscribeMaxChars: 6000,
        recordPath: null,
      },
      matrixUserId: "@bot:example.com",
      commandPrefix: "!code",
    });

    const attachments: InboundAttachment[] = [
      {
        kind: "image",
        name: "diagram.png",
        mxcUrl: "mxc://example.com/abc",
        mimeType: "image/png",
        sizeBytes: 1024,
        localPath: "/tmp/diagram.png",
      },
    ];

    await orchestrator.handleMessage(makeInbound({ text: "分析这张图", attachments }));

    expect(executor.prompts[0]).toContain("分析这张图");
    expect(executor.prompts[0]).toContain("[attachments]");
    expect(executor.prompts[0]).toContain("diagram.png");
  });
});
