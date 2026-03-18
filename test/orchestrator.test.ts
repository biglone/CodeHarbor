import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { type Channel, type InboundHandler } from "../src/channels/channel";
import { CodexExecutionCancelledError } from "../src/executor/codex-executor";
import { ApiTaskIdempotencyConflictError, Orchestrator, buildSessionKey } from "../src/orchestrator";
import { StateStore } from "../src/store/state-store";
import { InboundMessage } from "../src/types";

class FakeChannel implements Channel {
  sent: Array<{ conversationId: string; text: string }> = [];
  notices: Array<{ conversationId: string; text: string }> = [];
  typing: Array<{ conversationId: string; isTyping: boolean; timeoutMs: number }> = [];
  upserts: Array<{ conversationId: string; text: string; replaceEventId: string | null }> = [];

  async start(_handler: InboundHandler): Promise<void> {}

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

  async stop(): Promise<void> {}
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
  calls: Array<{ text: string; sessionId: string | null; workdir: string | null; imagePaths: string[] }> = [];

  startExecution(
    text: string,
    sessionId: string | null,
    _onProgress?: (event: unknown) => void,
    startOptions?: { workdir?: string; imagePaths?: string[] },
  ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.callCount += 1;
    this.calls.push({
      text,
      sessionId,
      workdir: startOptions?.workdir ?? null,
      imagePaths: startOptions?.imagePaths ? [...startOptions.imagePaths] : [],
    });
    return {
      result: Promise.resolve({ sessionId: sessionId ?? "thread-1", reply: `ok:${text}` }),
      cancel: () => {},
    };
  }
}

type SequencedExecutionOutcome =
  | { kind: "success"; reply?: string }
  | { kind: "error"; error: unknown };

class SequencedExecutor {
  callCount = 0;
  calls: Array<{ text: string; sessionId: string | null; workdir: string | null; imagePaths: string[] }> = [];
  private readonly outcomes: SequencedExecutionOutcome[];

  constructor(outcomes: SequencedExecutionOutcome[]) {
    this.outcomes = outcomes;
  }

  startExecution(
    text: string,
    sessionId: string | null,
    _onProgress?: (event: unknown) => void,
    startOptions?: { workdir?: string; imagePaths?: string[] },
  ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.callCount += 1;
    this.calls.push({
      text,
      sessionId,
      workdir: startOptions?.workdir ?? null,
      imagePaths: startOptions?.imagePaths ? [...startOptions.imagePaths] : [],
    });

    const outcome = this.outcomes[this.callCount - 1] ?? { kind: "success" };
    if (outcome.kind === "error") {
      return {
        result: Promise.reject(outcome.error),
        cancel: () => {},
      };
    }

    return {
      result: Promise.resolve({
        sessionId: sessionId ?? "thread-1",
        reply: outcome.reply ?? `ok:${text}`,
      }),
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

class FailingWorkflowExecutor {
  callCount = 0;

  startExecution(): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    this.callCount += 1;
    return {
      result: Promise.reject(new Error("simulated autodev failure")),
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

const execFileAsync = promisify(execFile);

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

async function createSqliteStateStore(prefix = "codeharbor-orch-queue-"): Promise<{ dir: string; store: StateStore }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    store: new StateStore(path.join(dir, "state.db"), path.join(dir, "state.json"), 200, 30, 500),
  };
}

function enqueueQueuedTask(store: StateStore, message: InboundMessage, prompt = message.text): { sessionKey: string; taskId: number } {
  const sessionKey = buildSessionKey(message);
  const result = store.enqueueTask({
    sessionKey,
    eventId: message.eventId,
    requestId: message.requestId,
    payloadJson: JSON.stringify({
      message,
      receivedAt: Date.now() - 500,
      prompt,
    }),
  });
  return {
    sessionKey,
    taskId: result.task.id,
  };
}

async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for expected condition.");
}

describe("Orchestrator", () => {
  it("respects room-level trigger policy for prefix-only groups", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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

  it("handles /diag and /autodev status without waiting for the active execution lock", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-status-unlocked-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Requirements\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      ["| 任务ID | 任务描述 | 状态 |", "|--------|----------|------|", "| T9.1 | status command check | ⬜ |"].join("\n"),
      "utf8",
    );

    try {
      const channel = new FakeChannel();
      const executor = new CancellableExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      const runningPromise = orchestrator.handleMessage(
        makeInbound({
          requestId: "req-running",
          isDirectMessage: true,
          text: "请持续执行",
          eventId: "$running",
        }),
      );
      await waitForCondition(() => executor.callCount === 1);

      const diagPromise = orchestrator.handleMessage(
        makeInbound({
          requestId: "req-diag",
          isDirectMessage: true,
          text: "/diag queue 3",
          eventId: "$diag-queue",
        }),
      );
      await waitForCondition(() => channel.notices.some((entry) => entry.text.includes("诊断信息（queue）")), 800);
      await diagPromise;

      const autoDevStatusPromise = orchestrator.handleMessage(
        makeInbound({
          requestId: "req-autodev-status",
          isDirectMessage: true,
          text: "/autodev status",
          eventId: "$autodev-status",
        }),
      );
      await waitForCondition(() => channel.notices.some((entry) => entry.text.includes("AutoDev 状态")), 800);
      await autoDevStatusPromise;

      await orchestrator.handleMessage(
        makeInbound({
          requestId: "req-stop-running",
          isDirectMessage: true,
          text: "/stop",
          eventId: "$stop-running",
        }),
      );
      await expect(runningPromise).resolves.toBeUndefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("recovers queued tasks after restart and drains them in order", async () => {
    const { dir, store } = await createSqliteStateStore();
    try {
      const channel = new FakeChannel();
      const executor = new ImmediateExecutor();
      const first = makeInbound({
        requestId: "req-queue-1",
        eventId: "$queue-1",
        isDirectMessage: true,
        text: "first queued task",
      });
      const second = makeInbound({
        requestId: "req-queue-2",
        eventId: "$queue-2",
        isDirectMessage: true,
        text: "second queued task",
      });
      const sessionKey = buildSessionKey(first);
      const task1 = store.enqueueTask({
        sessionKey,
        eventId: first.eventId,
        requestId: first.requestId,
        payloadJson: JSON.stringify({
          message: first,
          receivedAt: Date.now() - 2_000,
          prompt: first.text,
        }),
      });
      const task2 = store.enqueueTask({
        sessionKey,
        eventId: second.eventId,
        requestId: second.requestId,
        payloadJson: JSON.stringify({
          message: second,
          receivedAt: Date.now() - 1_000,
          prompt: second.text,
        }),
      });
      expect(store.claimNextTask(sessionKey)?.id).toBe(task1.task.id);

      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
      });

      await orchestrator.bootstrapTaskQueueRecovery();
      await waitForCondition(() => {
        const counts = store.getTaskQueueStatusCounts();
        return counts.pending === 0 && counts.running === 0 && counts.succeeded === 2;
      });

      expect(store.getTaskById(task1.task.id)?.status).toBe("succeeded");
      expect(store.getTaskById(task2.task.id)?.status).toBe("succeeded");
      expect(executor.calls.map((call) => call.text)).toEqual([first.text, second.text]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("fails malformed queued payload and continues with later tasks", async () => {
    const { dir, store } = await createSqliteStateStore();
    try {
      const channel = new FakeChannel();
      const executor = new ImmediateExecutor();
      const bad = makeInbound({
        requestId: "req-queue-bad",
        eventId: "$queue-bad",
        isDirectMessage: true,
        text: "broken payload",
      });
      const good = makeInbound({
        requestId: "req-queue-good",
        eventId: "$queue-good",
        isDirectMessage: true,
        text: "valid payload",
      });
      const sessionKey = buildSessionKey(bad);
      const badTask = store.enqueueTask({
        sessionKey,
        eventId: bad.eventId,
        requestId: bad.requestId,
        payloadJson: '{"message":',
      });
      const goodTask = store.enqueueTask({
        sessionKey,
        eventId: good.eventId,
        requestId: good.requestId,
        payloadJson: JSON.stringify({
          message: good,
          receivedAt: Date.now() - 500,
          prompt: good.text,
        }),
      });

      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
      });

      await orchestrator.bootstrapTaskQueueRecovery();
      await waitForCondition(() => {
        const counts = store.getTaskQueueStatusCounts();
        return counts.pending === 0 && counts.running === 0;
      });

      expect(store.getTaskById(badTask.task.id)?.status).toBe("failed");
      expect(store.getTaskById(goodTask.task.id)?.status).toBe("succeeded");
      expect(store.getTaskById(badTask.task.id)?.error).toContain("Invalid queued payload");
      expect(store.listTaskFailureArchive(5)[0]).toEqual(
        expect.objectContaining({
          taskId: badTask.task.id,
          retryReason: "invalid_payload",
          archiveReason: "invalid_payload",
        }),
      );
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.text).toBe(good.text);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("retries transient queue failures and eventually succeeds", async () => {
    const { dir, store } = await createSqliteStateStore();
    try {
      const channel = new FakeChannel();
      const transientError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      const executor = new SequencedExecutor([
        { kind: "error", error: transientError },
        { kind: "success", reply: "retry-ok" },
      ]);
      const message = makeInbound({
        requestId: "req-queue-transient",
        eventId: "$queue-transient",
        isDirectMessage: true,
        text: "retry me",
      });
      const queued = enqueueQueuedTask(store, message);

      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        taskQueueRetryPolicy: {
          maxAttempts: 3,
          initialDelayMs: 1,
          maxDelayMs: 5,
          multiplier: 1,
          jitterRatio: 0,
        },
      });

      await orchestrator.bootstrapTaskQueueRecovery();
      await waitForCondition(() => store.getTaskById(queued.taskId)?.status === "succeeded");

      expect(executor.callCount).toBe(2);
      expect(store.getTaskById(queued.taskId)?.attempt).toBe(2);
      expect(store.listTaskFailureArchive(5)).toHaveLength(0);
      expect(store.hasProcessedEvent(queued.sessionKey, message.eventId)).toBe(true);
      expect(channel.sent.some((entry) => entry.text.includes("归档"))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("archives queue task after max retry attempts", async () => {
    const { dir, store } = await createSqliteStateStore();
    try {
      const channel = new FakeChannel();
      const retryableError = Object.assign(new Error("gateway timeout"), { status: 504 });
      const executor = new SequencedExecutor([
        { kind: "error", error: retryableError },
        { kind: "error", error: retryableError },
      ]);
      const message = makeInbound({
        requestId: "req-queue-max-attempts",
        eventId: "$queue-max-attempts",
        isDirectMessage: true,
        text: "always fail",
      });
      const queued = enqueueQueuedTask(store, message);

      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        taskQueueRetryPolicy: {
          maxAttempts: 2,
          initialDelayMs: 1,
          maxDelayMs: 5,
          multiplier: 1,
          jitterRatio: 0,
        },
      });

      await orchestrator.bootstrapTaskQueueRecovery();
      await waitForCondition(() => store.getTaskById(queued.taskId)?.status === "failed");

      expect(executor.callCount).toBe(2);
      expect(store.getTaskById(queued.taskId)?.attempt).toBe(2);
      expect(store.hasProcessedEvent(queued.sessionKey, message.eventId)).toBe(true);
      const archive = store.listTaskFailureArchive(5);
      expect(archive).toHaveLength(1);
      expect(archive[0]).toEqual(
        expect.objectContaining({
          taskId: queued.taskId,
          retryReason: "http_504",
          archiveReason: "max_attempts_reached",
          retryAfterMs: null,
        }),
      );
      expect(channel.sent.some((entry) => entry.text.includes("达到最大重试次数(2)"))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("archives non-retryable queue task errors without retry", async () => {
    const { dir, store } = await createSqliteStateStore();
    try {
      const channel = new FakeChannel();
      const executor = new SequencedExecutor([
        { kind: "error", error: new Error("permission denied") },
        { kind: "success", reply: "should-not-run" },
      ]);
      const message = makeInbound({
        requestId: "req-queue-no-retry",
        eventId: "$queue-no-retry",
        isDirectMessage: true,
        text: "archive directly",
      });
      const queued = enqueueQueuedTask(store, message);

      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        taskQueueRetryPolicy: {
          maxAttempts: 4,
          initialDelayMs: 1,
          maxDelayMs: 5,
          multiplier: 1,
          jitterRatio: 0,
        },
      });

      await orchestrator.bootstrapTaskQueueRecovery();
      await waitForCondition(() => store.getTaskById(queued.taskId)?.status === "failed");

      expect(executor.callCount).toBe(1);
      expect(store.getTaskById(queued.taskId)?.attempt).toBe(1);
      const archive = store.listTaskFailureArchive(5);
      expect(archive).toHaveLength(1);
      expect(archive[0]).toEqual(
        expect.objectContaining({
          taskId: queued.taskId,
          retryReason: "non_retryable_error",
          archiveReason: "non_retryable_error",
          retryAfterMs: null,
        }),
      );
      expect(channel.sent.some((entry) => entry.text.includes("不可重试错误(non_retryable_error)"))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("respects Retry-After before retrying queue tasks", async () => {
    const { dir, store } = await createSqliteStateStore();
    try {
      const channel = new FakeChannel();
      const retryAfterMs = 600;
      const retryableError = Object.assign(new Error("HTTP 429 Too Many Requests"), {
        status: 429,
        retryAfterMs,
      });
      const executor = new SequencedExecutor([
        { kind: "error", error: retryableError },
        { kind: "success", reply: "retry-after-ok" },
      ]);
      const message = makeInbound({
        requestId: "req-queue-retry-after",
        eventId: "$queue-retry-after",
        isDirectMessage: true,
        text: "respect retry after",
      });
      const queued = enqueueQueuedTask(store, message);

      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        taskQueueRetryPolicy: {
          maxAttempts: 3,
          initialDelayMs: 1,
          maxDelayMs: 10,
          multiplier: 1,
          jitterRatio: 0,
        },
      });

      const startedAt = Date.now();
      await orchestrator.bootstrapTaskQueueRecovery();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(executor.callCount).toBe(1);
      await waitForCondition(() => store.getTaskById(queued.taskId)?.status === "succeeded", 3_000);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
      expect(executor.callCount).toBe(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("submits API task into queue and returns idempotent hit for duplicate payload", async () => {
    const { dir, store } = await createSqliteStateStore("codeharbor-orch-api-queue-");
    try {
      const channel = new FakeChannel();
      const executor = new ImmediateExecutor();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
      });

      const first = orchestrator.submitApiTask({
        conversationId: "!api-room:example.com",
        senderId: "@ci:example.com",
        text: "run integration",
        idempotencyKey: "idem-api-1",
      });
      const second = orchestrator.submitApiTask({
        conversationId: "!api-room:example.com",
        senderId: "@ci:example.com",
        text: "run integration",
        idempotencyKey: "idem-api-1",
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.task.id).toBe(first.task.id);
      expect(first.sessionKey).toBe("matrix:!api-room:example.com:@ci:example.com");
      expect(store.listTasks(10)).toHaveLength(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects API idempotency key reuse when payload differs", async () => {
    const { dir, store } = await createSqliteStateStore("codeharbor-orch-api-conflict-");
    try {
      const channel = new FakeChannel();
      const executor = new ImmediateExecutor();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
      });

      orchestrator.submitApiTask({
        conversationId: "!api-room:example.com",
        senderId: "@ci:example.com",
        text: "run integration",
        idempotencyKey: "idem-api-conflict",
      });

      expect(() =>
        orchestrator.submitApiTask({
          conversationId: "!api-room:example.com",
          senderId: "@ci:example.com",
          text: "run deployment",
          idempotencyKey: "idem-api-conflict",
        }),
      ).toThrow(ApiTaskIdempotencyConflictError);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("exposes API task query snapshot with status, stage, and error summary", async () => {
    const { dir, store } = await createSqliteStateStore("codeharbor-orch-api-query-");
    try {
      const channel = new FakeChannel();
      const executor = new ImmediateExecutor();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
      });

      const queued = enqueueQueuedTask(
        store,
        makeInbound({
          requestId: "req-api-query-1",
          eventId: "$api-query-1",
          conversationId: "!api-room:example.com",
          senderId: "@ci:example.com",
          isDirectMessage: true,
          text: "run integration",
        }),
      );

      expect(orchestrator.getApiTaskById(queued.taskId)).toEqual({
        taskId: queued.taskId,
        status: "pending",
        stage: "queued",
        errorSummary: null,
      });

      store.scheduleRetry(queued.taskId, {
        nextRetryAt: Date.now() + 30_000,
        error: "HTTP 429 Too Many Requests",
      });
      expect(orchestrator.getApiTaskById(queued.taskId)).toEqual({
        taskId: queued.taskId,
        status: "pending",
        stage: "retrying",
        errorSummary: "HTTP 429 Too Many Requests",
      });

      store.failTask(queued.taskId, "executor crashed unexpectedly");
      expect(orchestrator.getApiTaskById(queued.taskId)).toEqual({
        taskId: queued.taskId,
        status: "failed",
        stage: "failed",
        errorSummary: "executor crashed unexpectedly",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null when querying unknown API task id", async () => {
    const { dir, store } = await createSqliteStateStore("codeharbor-orch-api-query-miss-");
    try {
      const channel = new FakeChannel();
      const executor = new ImmediateExecutor();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
      });

      expect(orchestrator.getApiTaskById(999999)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
          imageMaxBytes: 10485760,
          imageMaxCount: 4,
          imageAllowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
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

  it("applies image mime/size/count policy and reports skipped items", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-image-policy-"));
    const keepPng = path.join(tempRoot, "keep-1.png");
    const keepJpg = path.join(tempRoot, "keep-2.jpg");
    const extraWebp = path.join(tempRoot, "extra.webp");
    const largePng = path.join(tempRoot, "large.png");
    const unsupportedSvg = path.join(tempRoot, "icon.svg");
    await fs.writeFile(keepPng, "a", "utf8");
    await fs.writeFile(keepJpg, "b", "utf8");
    await fs.writeFile(extraWebp, "c", "utf8");
    await fs.writeFile(largePng, "d", "utf8");
    await fs.writeFile(unsupportedSvg, "e", "utf8");

    try {
      const channel = new FakeChannel();
      const executor = new ImmediateExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        cliCompat: {
          enabled: false,
          passThroughEvents: false,
          preserveWhitespace: false,
          disableReplyChunkSplit: false,
          progressThrottleMs: 300,
          fetchMedia: true,
          imageMaxBytes: 10,
          imageMaxCount: 2,
          imageAllowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
          transcribeAudio: false,
          audioTranscribeModel: "gpt-4o-mini-transcribe",
          audioTranscribeTimeoutMs: 120000,
          audioTranscribeMaxChars: 6000,
          audioTranscribeMaxRetries: 1,
          audioTranscribeRetryDelayMs: 800,
          audioTranscribeMaxBytes: 26214400,
          audioLocalWhisperCommand: null,
          audioLocalWhisperTimeoutMs: 180000,
          recordPath: null,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "分析图片",
          eventId: "$image-policy",
          attachments: [
            {
              kind: "image",
              name: "keep-1.png",
              mxcUrl: "mxc://example.com/keep1",
              mimeType: "image/png",
              sizeBytes: 4,
              localPath: keepPng,
            },
            {
              kind: "image",
              name: "keep-2.jpg",
              mxcUrl: "mxc://example.com/keep2",
              mimeType: "image/jpeg",
              sizeBytes: 5,
              localPath: keepJpg,
            },
            {
              kind: "image",
              name: "large.png",
              mxcUrl: "mxc://example.com/large",
              mimeType: "image/png",
              sizeBytes: 128,
              localPath: largePng,
            },
            {
              kind: "image",
              name: "icon.svg",
              mxcUrl: "mxc://example.com/icon",
              mimeType: "image/svg+xml",
              sizeBytes: 3,
              localPath: unsupportedSvg,
            },
            {
              kind: "image",
              name: "extra.webp",
              mxcUrl: "mxc://example.com/extra",
              mimeType: "image/webp",
              sizeBytes: 6,
              localPath: extraWebp,
            },
          ],
        }),
      );

      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.imagePaths).toEqual([keepPng, keepJpg]);
      expect(channel.notices.some((entry) => entry.text.includes("图片处理提示"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("格式不支持 1 张"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("超过大小限制 1 张"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("超过数量上限 1 张"))).toBe(true);

      await expect(fs.access(keepPng)).rejects.toBeDefined();
      await expect(fs.access(keepJpg)).rejects.toBeDefined();
      await expect(fs.access(extraWebp)).rejects.toBeDefined();
      await expect(fs.access(largePng)).rejects.toBeDefined();
      await expect(fs.access(unsupportedSvg)).rejects.toBeDefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies roomTriggerPolicies override when config service is absent", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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

  it("loops /autodev run without task id until no executable tasks remain", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-loop-"));
    const requirementsPath = path.join(tempRoot, "REQUIREMENTS.md");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(requirementsPath, "# Requirements\n- implement T11.x\n", "utf8");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T11.1 | first loop task | ⬜ |",
        "| T11.2 | second loop task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    try {
      const channel = new FakeChannel();
      const executor = new WorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
          eventId: "$autodev-run-loop",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T11.1 | first loop task | ✅ |");
      expect(updated).toContain("| T11.2 | second loop task | ✅ |");
      expect(channel.notices.filter((entry) => entry.text.includes("AutoDev 启动任务")).length).toBe(2);
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 循环执行完成"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("completedRuns: 2"))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("stops /autodev run loop when loop max runs is reached", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-loop-limit-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T12.1 | first | ⬜ |",
        "| T12.2 | second | ⬜ |",
        "| T12.3 | third | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    try {
      const channel = new FakeChannel();
      const executor = new WorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        autoDevLoopMaxRuns: 2,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run",
          eventId: "$autodev-run-limit",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T12.1 | first | ✅ |");
      expect(updated).toContain("| T12.2 | second | ✅ |");
      expect(updated).toContain("| T12.3 | third | ⬜ |");
      expect(channel.notices.some((entry) => entry.text.includes("循环执行已达到上限"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("loopMaxRuns: 2"))).toBe(true);
      const runtime = orchestrator.getRuntimeMetricsSnapshot();
      expect(runtime.autodev.runs.succeeded).toBe(2);
      expect(runtime.autodev.loopStops.max_runs).toBe(1);
      expect(runtime.autodev.tasksBlocked).toBe(0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("auto-commits autodev changes when reviewer approves and workdir is clean", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-commit-"));
    const requirementsPath = path.join(tempRoot, "REQUIREMENTS.md");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(requirementsPath, "# Requirements\n- implement T10.1\n", "utf8");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 预估时间 | 优先级 | 依赖 | 状态 |",
        "|--------|----------|----------|--------|------|------|",
        "| T10.1 | 自动提交验证 | 1h | P0 | - | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await execFileAsync("git", ["add", "-A"], { cwd: tempRoot });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "commit", "-m", "chore: init autodev test"],
      { cwd: tempRoot },
    );

    try {
      const channel = new FakeChannel();
      const executor = new WorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
          eventId: "$autodev-run-commit",
        }),
      );

      const latest = await execFileAsync("git", ["log", "--oneline", "-n", "1"], { cwd: tempRoot });
      expect(latest.stdout).toContain("chore(autodev): complete T10.1");
      const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: tempRoot });
      expect(status.stdout.trim()).toBe("");
      expect(channel.notices.some((entry) => entry.text.includes("git commit: committed"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("git changed files:"))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips autodev git commit when auto-commit is disabled", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-no-commit-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T13.1 | no auto commit | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await execFileAsync("git", ["add", "-A"], { cwd: tempRoot });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "commit", "-m", "chore: init"],
      { cwd: tempRoot },
    );

    try {
      const channel = new FakeChannel();
      const executor = new WorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        autoDevAutoCommit: false,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T13.1",
          eventId: "$autodev-run-no-commit",
        }),
      );

      const latest = await execFileAsync("git", ["log", "--oneline", "-n", "1"], { cwd: tempRoot });
      expect(latest.stdout).toContain("chore: init");
      expect(latest.stdout).not.toContain("chore(autodev): complete");
      expect(channel.notices.some((entry) => entry.text.includes("AUTODEV_AUTO_COMMIT=false"))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("marks autodev task blocked after consecutive failures", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-fail-streak-"));
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T14.1 | flaky task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    try {
      const channel = new FakeChannel();
      const executor = new FailingWorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        autoDevMaxConsecutiveFailures: 2,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T14.1",
          eventId: "$autodev-run-fail-1",
        }),
      );
      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T14.1",
          eventId: "$autodev-run-fail-2",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T14.1 | flaky task | 🚫 |");
      expect(channel.notices.some((entry) => entry.text.includes("连续失败 2 次"))).toBe(true);
      const runtime = orchestrator.getRuntimeMetricsSnapshot();
      expect(runtime.autodev.runs.failed).toBe(2);
      expect(runtime.autodev.tasksBlocked).toBe(1);
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
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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

  it("shows /diag autodev run records with stage trace", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-diag-autodev-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T2.1 | diag task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    try {
      const channel = new FakeChannel();
      const executor = new WorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
          eventId: "$autodev-diag-run",
        }),
      );
      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/diag autodev 3",
          eventId: "$autodev-diag-view",
        }),
      );

      const notice = channel.notices.find((entry) => entry.text.includes("诊断信息（autodev）"));
      expect(notice).toBeDefined();
      expect(notice?.text).toContain("recentCount:");
      expect(notice?.text).toContain("recentGitCommits:");
      expect(notice?.text).toContain("task=T2.1");
      expect(notice?.text).toContain("未检测到 git 仓库");
      expect(notice?.text).toContain("events=");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("shows /diag queue with counts and pending session details", async () => {
    const { dir, store } = await createSqliteStateStore("codeharbor-orch-diag-queue-");
    try {
      const channel = new FakeChannel();
      const executor = new ImmediateExecutor();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
      });
      const queued = makeInbound({
        requestId: "req-diag-queue",
        eventId: "$diag-queue-pending",
        isDirectMessage: true,
        text: "queued task",
      });
      const sessionKey = buildSessionKey(queued);
      store.enqueueTask({
        sessionKey,
        eventId: queued.eventId,
        requestId: queued.requestId,
        payloadJson: JSON.stringify({
          message: queued,
          receivedAt: Date.now() - 2_000,
          prompt: queued.text,
        }),
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "!code /diag queue 5",
          eventId: "$diag-queue-view",
        }),
      );

      const notice = channel.notices.find((entry) => entry.text.includes("诊断信息（queue）"));
      expect(notice).toBeDefined();
      expect(notice?.text).toContain("counts: pending=1");
      expect(notice?.text).toContain("pendingSessions: 1");
      expect(notice?.text).toContain(`session=${sessionKey}`);
      expect(notice?.text).toContain("archive:");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("runs multi-agent workflow when enabled", async () => {
    const channel = new FakeChannel();
    const executor = new WorkflowExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
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
