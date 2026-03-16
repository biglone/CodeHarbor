import { describe, expect, it, vi } from "vitest";

import { CodexExecutionCancelledError } from "../src/executor/codex-executor";
import { Orchestrator } from "../src/orchestrator";
import { InboundMessage } from "../src/types";

class FakeChannel {
  sent: Array<{ conversationId: string; text: string }> = [];
  notices: Array<{ conversationId: string; text: string }> = [];
  upserts: Array<{ conversationId: string; text: string; replaceEventId: string | null }> = [];

  async sendMessage(conversationId: string, text: string): Promise<void> {
    this.sent.push({ conversationId, text });
  }

  async sendNotice(conversationId: string, text: string): Promise<void> {
    this.notices.push({ conversationId, text });
  }

  async setTyping(_conversationId: string, _isTyping: boolean, _timeoutMs: number): Promise<void> {}

  async upsertProgressNotice(conversationId: string, text: string, replaceEventId: string | null): Promise<string> {
    this.upserts.push({ conversationId, text, replaceEventId });
    return replaceEventId ?? `$progress-${this.upserts.length}`;
  }
}

interface SessionState {
  codexSessionId: string | null;
  processedEventIds: Set<string>;
  activeUntil: string | null;
}

class InMemoryStateStore {
  private readonly sessions = new Map<string, SessionState>();

  getCodexSessionId(sessionKey: string): string | null {
    return this.ensureSession(sessionKey).codexSessionId;
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
    const activeUntil = this.ensureSession(sessionKey).activeUntil;
    if (!activeUntil) {
      return false;
    }
    return Date.now() <= Date.parse(activeUntil);
  }

  activateSession(sessionKey: string, activeWindowMs: number): void {
    this.ensureSession(sessionKey).activeUntil = new Date(Date.now() + activeWindowMs).toISOString();
  }

  deactivateSession(sessionKey: string): void {
    this.ensureSession(sessionKey).activeUntil = null;
  }

  getSessionStatus(sessionKey: string): { hasCodexSession: boolean; activeUntil: string | null; isActive: boolean } {
    const session = this.ensureSession(sessionKey);
    return {
      hasCodexSession: Boolean(session.codexSessionId),
      activeUntil: session.activeUntil,
      isActive: this.isSessionActive(sessionKey),
    };
  }

  private ensureSession(sessionKey: string): SessionState {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }
    const created: SessionState = {
      codexSessionId: null,
      processedEventIds: new Set<string>(),
      activeUntil: null,
    };
    this.sessions.set(sessionKey, created);
    return created;
  }
}

type ScenarioInput = {
  prompt: string;
  sessionId: string | null;
  onProgress?: (event: { stage: string; message?: string }) => void;
  startOptions?: { workdir?: string };
};

type ScenarioOutput = {
  result: Promise<{ sessionId: string; reply: string }>;
  cancel: () => void;
};

class ScriptedExecutor {
  calls: Array<{ prompt: string; sessionId: string | null; workdir: string | null }> = [];
  private scenario: (input: ScenarioInput) => ScenarioOutput;

  constructor(scenario?: (input: ScenarioInput) => ScenarioOutput) {
    this.scenario =
      scenario ??
      ((input) => ({
        result: Promise.resolve({ sessionId: input.sessionId ?? "thread-1", reply: `ok:${input.prompt}` }),
        cancel: () => {},
      }));
  }

  setScenario(next: (input: ScenarioInput) => ScenarioOutput): void {
    this.scenario = next;
  }

  startExecution(
    prompt: string,
    sessionId: string | null,
    onProgress?: (event: { stage: string; message?: string }) => void,
    startOptions?: { workdir?: string },
  ): ScenarioOutput {
    this.calls.push({ prompt, sessionId, workdir: startOptions?.workdir ?? null });
    return this.scenario({ prompt, sessionId, onProgress, startOptions });
  }
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let eventSeq = 0;
function makeInbound(partial: Partial<InboundMessage> = {}): InboundMessage {
  eventSeq += 1;
  return {
    requestId: `req-${eventSeq}`,
    channel: "matrix",
    conversationId: "!room:example.com",
    senderId: "@alice:example.com",
    eventId: `$event-${eventSeq}`,
    text: "hello",
    attachments: [],
    isDirectMessage: false,
    mentionsBot: false,
    repliesToBot: false,
    ...partial,
  };
}

describe("Matrix e2e regression", () => {
  it("handles direct-message request flow", async () => {
    const channel = new FakeChannel();
    const executor = new ScriptedExecutor();
    const store = new InMemoryStateStore();

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
    });

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "fix this" }));

    expect(executor.calls).toHaveLength(1);
    expect(channel.sent[0]?.text).toBe("ok:fix this");
  });

  it("handles group mention and reply flows", async () => {
    const channel = new FakeChannel();
    const executor = new ScriptedExecutor();
    const store = new InMemoryStateStore();

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
    });

    await orchestrator.handleMessage(
      makeInbound({
        text: "@bot:example.com do it",
        mentionsBot: true,
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        text: "follow-up",
        repliesToBot: true,
      }),
    );

    expect(executor.calls).toHaveLength(2);
    expect(channel.sent[0]?.text).toBe("ok:do it");
    expect(channel.sent[1]?.text).toBe("ok:follow-up");
  });

  it("coalesces group progress updates into edited status notice", async () => {
    const channel = new FakeChannel();
    const executor = new ScriptedExecutor((input) => {
      input.onProgress?.({ stage: "turn_started" });
      input.onProgress?.({ stage: "reasoning", message: "thinking" });
      return {
        result: Promise.resolve({ sessionId: input.sessionId ?? "thread-1", reply: "done" }),
        cancel: () => {},
      };
    });
    const store = new InMemoryStateStore();

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: true,
      progressMinIntervalMs: 0,
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
    });

    await orchestrator.handleMessage(makeInbound({ text: "@bot:example.com run", mentionsBot: true }));

    expect(channel.upserts.length).toBeGreaterThanOrEqual(2);
    expect(channel.upserts[0]?.text).toContain("[CodeHarbor v");
    expect(channel.upserts[0]?.replaceEventId).toBeNull();
    expect(channel.upserts.slice(1).every((entry) => Boolean(entry.replaceEventId))).toBe(true);
  });

  it("cancels an in-flight execution with /stop", async () => {
    const channel = new FakeChannel();
    const executor = new ScriptedExecutor();
    const store = new InMemoryStateStore();

    let rejectRunning: ((error: unknown) => void) | null = null;
    executor.setScenario(() => {
      const result = new Promise<{ sessionId: string; reply: string }>((_resolve, reject) => {
        rejectRunning = reject;
      });
      return {
        result,
        cancel: () => {
          rejectRunning?.(new CodexExecutionCancelledError());
        },
      };
    });

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      packageUpdateChecker: {
        getStatus: async () => ({
          packageName: "codeharbor",
          currentVersion: "0.1.24",
          latestVersion: "0.1.25",
          state: "update_available",
          checkedAt: new Date().toISOString(),
          error: null,
          upgradeCommand: "npm install -g codeharbor@latest",
        }),
      },
    });

    const running = orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "long running" }));
    await Promise.resolve();

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "/stop" }));
    await expect(running).resolves.toBeUndefined();

    expect(channel.notices.some((entry) => entry.text.includes("已请求停止当前任务"))).toBe(true);
  });

  it("runs /agents workflow and reports /agents status when enabled", async () => {
    const channel = new FakeChannel();
    const store = new InMemoryStateStore();
    const executor = new ScriptedExecutor((input) => {
      if (input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "planner-thread",
            reply: "1) plan\n2) execute\n3) verify",
          }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[role:reviewer]")) {
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "reviewer-thread",
            reply: "VERDICT: APPROVED\nSUMMARY: pass\nISSUES:\n- none",
          }),
          cancel: () => {},
        };
      }
      return {
        result: Promise.resolve({
          sessionId: input.sessionId ?? "executor-thread",
          reply: "delivery result",
        }),
        cancel: () => {},
      };
    });

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      multiAgentWorkflow: {
        enabled: true,
        autoRepairMaxRounds: 1,
      },
    });

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "/agents run 生成发布摘要" }));
    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "/agents status" }));

    expect(executor.calls[0]?.prompt).toContain("[role:planner]");
    expect(executor.calls[1]?.prompt).toContain("[role:executor]");
    expect(executor.calls[2]?.prompt).toContain("[role:reviewer]");
    expect(channel.sent.some((entry) => entry.text.includes("Multi-Agent workflow 完成"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("state: succeeded"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("approved: yes"))).toBe(true);
  });

  it("cancels in-flight /agents run with /stop", async () => {
    const channel = new FakeChannel();
    const store = new InMemoryStateStore();
    let rejectRunning: ((error: unknown) => void) | null = null;
    const executor = new ScriptedExecutor((input) => {
      if (!input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "thread-fast",
            reply: "ok",
          }),
          cancel: () => {},
        };
      }
      const result = new Promise<{ sessionId: string; reply: string }>((_resolve, reject) => {
        rejectRunning = reject;
      });
      return {
        result,
        cancel: () => {
          rejectRunning?.(new CodexExecutionCancelledError());
        },
      };
    });

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      multiAgentWorkflow: {
        enabled: true,
        autoRepairMaxRounds: 1,
      },
    });

    const running = orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "/agents run 长任务" }));
    await Promise.resolve();

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "/stop" }));
    await expect(running).resolves.toBeUndefined();

    expect(channel.notices.some((entry) => entry.text.includes("已请求停止当前任务"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("Multi-Agent workflow 已取消"))).toBe(true);
  });

  it("rejects over-limit requests", async () => {
    const channel = new FakeChannel();
    const executor = new ScriptedExecutor();
    const store = new InMemoryStateStore();

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      rateLimiterOptions: {
        windowMs: 60_000,
        maxRequestsPerUser: 1,
        maxRequestsPerRoom: 100,
        maxConcurrentGlobal: 100,
        maxConcurrentPerUser: 100,
        maxConcurrentPerRoom: 100,
      },
    });

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "first" }));
    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "second" }));

    expect(executor.calls).toHaveLength(1);
    expect(channel.notices.some((entry) => entry.text.includes("请求过于频繁"))).toBe(true);
  });

  it("routes concurrent multi-room requests to mapped workdirs", async () => {
    const channel = new FakeChannel();
    const store = new InMemoryStateStore();
    const releases: Array<() => void> = [];
    const executor = new ScriptedExecutor((input) => {
      const result = new Promise<{ sessionId: string; reply: string }>((resolve) => {
        releases.push(() => {
          resolve({
            sessionId: input.sessionId ?? `thread-${releases.length + 1}`,
            reply: `ok:${input.prompt}`,
          });
        });
      });
      return {
        result,
        cancel: () => {},
      };
    });
    const configService = {
      resolveRoomConfig: vi.fn((roomId: string) => ({
        source: "room",
        enabled: true,
        triggerPolicy: {
          allowMention: true,
          allowReply: true,
          allowActiveWindow: true,
          allowPrefix: true,
        },
        workdir: roomId === "!room-a:example.com" ? "/tmp/project-a" : "/tmp/project-b",
      })),
    };

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      configService: configService as never,
      defaultCodexWorkdir: "/tmp/default",
      rateLimiterOptions: {
        windowMs: 60_000,
        maxRequestsPerUser: 100,
        maxRequestsPerRoom: 100,
        maxConcurrentGlobal: 10,
        maxConcurrentPerUser: 2,
        maxConcurrentPerRoom: 2,
      },
    });

    const requestA = orchestrator.handleMessage(
      makeInbound({
        conversationId: "!room-a:example.com",
        text: "@bot:example.com task a",
        mentionsBot: true,
      }),
    );
    const requestB = orchestrator.handleMessage(
      makeInbound({
        conversationId: "!room-b:example.com",
        text: "@bot:example.com task b",
        mentionsBot: true,
      }),
    );

    await vi.waitFor(() => {
      expect(executor.calls).toHaveLength(2);
    });
    expect(executor.calls.map((call) => call.workdir).sort()).toEqual(["/tmp/project-a", "/tmp/project-b"]);

    for (const release of releases) {
      release();
    }
    await Promise.all([requestA, requestB]);

    expect(channel.sent).toEqual(
      expect.arrayContaining([
        { conversationId: "!room-a:example.com", text: "ok:task a" },
        { conversationId: "!room-b:example.com", text: "ok:task b" },
      ]),
    );
  });

  it("keeps status and reset command flow stable", async () => {
    const channel = new FakeChannel();
    const executor = new ScriptedExecutor();
    const store = new InMemoryStateStore();

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
    });

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "first task" }));
    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "/status" }));
    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "/reset" }));
    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "second task" }));

    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[0]?.sessionId).toBeNull();
    expect(executor.calls[1]?.sessionId).toBeNull();
    expect(channel.notices.some((entry) => entry.text.includes("当前状态"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("当前版本:"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("更新检查:"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("更新检查时间:"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("上下文已重置"))).toBe(true);
  });

  it("shows current version and update hint for /version command", async () => {
    const channel = new FakeChannel();
    const executor = new ScriptedExecutor();
    const store = new InMemoryStateStore();
    const getStatus = vi.fn(async () => ({
      packageName: "codeharbor",
      currentVersion: "0.1.27",
      latestVersion: "0.1.28",
      state: "update_available" as const,
      checkedAt: "2026-03-16T03:11:22.000Z",
      error: null,
      upgradeCommand: "npm install -g codeharbor@latest",
    }));

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      packageUpdateChecker: {
        getStatus,
      },
    });

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "/version" }));

    expect(executor.calls).toHaveLength(0);
    expect(getStatus).toHaveBeenCalledWith({ forceRefresh: true });
    expect(channel.notices.some((entry) => entry.text.includes("版本信息"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("当前版本: 0.1.27"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("发现新版本 0.1.28"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("检查时间: 2026-03-16T03:11:22.000Z"))).toBe(true);
  });

  it("returns failure message when executor errors", async () => {
    const channel = new FakeChannel();
    const executor = new ScriptedExecutor(() => ({
      result: Promise.reject(new Error("boom")),
      cancel: () => {},
    }));
    const store = new InMemoryStateStore();

    const orchestrator = new Orchestrator(channel as never, executor as never, store as never, logger as never, {
      progressUpdatesEnabled: false,
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
    });

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "explode" }));

    expect(channel.sent.some((entry) => entry.text.includes("Failed to process request: boom"))).toBe(true);
  });
});
