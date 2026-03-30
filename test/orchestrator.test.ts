import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { type Channel, type InboundHandler, type SendMessageOptions } from "../src/channels/channel";
import { DEFAULT_DOCUMENT_MAX_BYTES } from "../src/document-extractor";
import { CodexExecutionCancelledError } from "../src/executor/codex-executor";
import {
  ApiTaskIdempotencyConflictError,
  type ApiTaskLifecycleEvent,
  Orchestrator,
  buildSessionKey,
} from "../src/orchestrator";
import { GLOBAL_RUNTIME_HOT_CONFIG_KEY } from "../src/runtime-hot-config";
import { StateStore } from "../src/store/state-store";
import { InboundMessage } from "../src/types";

class FakeChannel implements Channel {
  sent: Array<{ conversationId: string; text: string; options?: SendMessageOptions }> = [];
  notices: Array<{ conversationId: string; text: string }> = [];
  typing: Array<{ conversationId: string; isTyping: boolean; timeoutMs: number }> = [];
  upserts: Array<{ conversationId: string; text: string; replaceEventId: string | null }> = [];

  async start(_handler: InboundHandler): Promise<void> {}

  async sendMessage(conversationId: string, text: string, options?: SendMessageOptions): Promise<void> {
    this.sent.push({ conversationId, text, options });
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

class NoticeFailingChannel extends FakeChannel {
  override async sendNotice(conversationId: string, text: string): Promise<void> {
    this.notices.push({ conversationId, text });
    throw new Error("simulated notice send failure");
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
  private readonly runtimeConfigSnapshots = new Map<
    string,
    { key: string; version: number; payloadJson: string; updatedAt: number }
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

  upsertRuntimeConfigSnapshot(
    key: string,
    payloadJson: string,
  ): { key: string; version: number; payloadJson: string; updatedAt: number } {
    const existing = this.runtimeConfigSnapshots.get(key);
    const next = {
      key,
      version: (existing?.version ?? 0) + 1,
      payloadJson,
      updatedAt: Date.now(),
    };
    this.runtimeConfigSnapshots.set(key, next);
    return next;
  }

  getRuntimeConfigSnapshot(key: string): { key: string; version: number; payloadJson: string; updatedAt: number } | null {
    return this.runtimeConfigSnapshots.get(key) ?? null;
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

class TaggedExecutor {
  callCount = 0;
  calls: Array<{ text: string; sessionId: string | null; workdir: string | null; imagePaths: string[] }> = [];
  private readonly tag: string;

  constructor(tag: string) {
    this.tag = tag;
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
    return {
      result: Promise.resolve({ sessionId: sessionId ?? `${this.tag}-session`, reply: `${this.tag}:${text}` }),
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

interface DeferredExecutionEntry {
  text: string;
  sessionId: string | null;
  resolve: (value: { sessionId: string; reply: string }) => void;
  reject: (error: unknown) => void;
}

class DeferredExecutor {
  callCount = 0;
  calls: Array<{ text: string; sessionId: string | null; workdir: string | null; imagePaths: string[] }> = [];
  private readonly pending: Array<DeferredExecutionEntry | undefined> = [];

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

    const pendingIndex = this.pending.length;
    const result = new Promise<{ sessionId: string; reply: string }>((resolve, reject) => {
      this.pending[pendingIndex] = {
        text,
        sessionId,
        resolve,
        reject,
      };
    });

    return {
      result,
      cancel: () => {
        const pending = this.pending[pendingIndex];
        if (!pending) {
          return;
        }
        this.pending[pendingIndex] = undefined;
        pending.reject(new CodexExecutionCancelledError());
      },
    };
  }

  resolveCall(index: number, reply?: string): void {
    const pending = this.pending[index];
    if (!pending) {
      throw new Error(`No pending call at index ${index}.`);
    }
    this.pending[index] = undefined;
    pending.resolve({
      sessionId: pending.sessionId ?? "thread-1",
      reply: reply ?? `ok:${pending.text}`,
    });
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

class LargeContextWorkflowExecutor {
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

    if (text.includes("[role:planner]")) {
      return {
        result: Promise.resolve({
          sessionId: sessionId ?? `wf-thread-${this.callCount}`,
          reply: "1) 规划\n2) 实施\n3) 复核",
        }),
        cancel: () => {},
      };
    }

    if (text.includes("[role:executor]")) {
      return {
        result: Promise.resolve({
          sessionId: sessionId ?? `wf-thread-${this.callCount}`,
          reply: "x".repeat(24_000),
        }),
        cancel: () => {},
      };
    }

    return {
      result: Promise.resolve({
        sessionId: sessionId ?? `wf-thread-${this.callCount}`,
        reply: "VERDICT: APPROVED\nSUMMARY: ok\nISSUES:\n- none",
      }),
      cancel: () => {},
    };
  }
}

class GracefulLoopWorkflowExecutor {
  callCount = 0;
  reviewerCount = 0;
  firstReviewerCancelled = false;
  calls: Array<{ text: string; sessionId: string | null; workdir: string | null }> = [];
  private pendingFirstReviewer:
    | {
        sessionId: string | null;
        resolve: (value: { sessionId: string; reply: string }) => void;
        reject: (error: unknown) => void;
      }
    | null = null;

  isFirstReviewerPending(): boolean {
    return this.pendingFirstReviewer !== null;
  }

  releaseFirstReviewer(): void {
    if (!this.pendingFirstReviewer) {
      throw new Error("No pending first reviewer call.");
    }
    const pending = this.pendingFirstReviewer;
    this.pendingFirstReviewer = null;
    pending.resolve({
      sessionId: pending.sessionId ?? "wf-thread-reviewer-1",
      reply: "VERDICT: APPROVED\nSUMMARY: 通过\nISSUES:\n- none",
    });
  }

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

    if (text.includes("[role:planner]")) {
      return {
        result: Promise.resolve({
          sessionId: sessionId ?? `wf-thread-${this.callCount}`,
          reply: "1) 执行任务\n2) 校验结果\n3) 更新任务状态",
        }),
        cancel: () => {},
      };
    }

    if (text.includes("[role:executor]")) {
      return {
        result: Promise.resolve({
          sessionId: sessionId ?? `wf-thread-${this.callCount}`,
          reply: "执行完成。",
        }),
        cancel: () => {},
      };
    }

    if (text.includes("[role:reviewer]")) {
      this.reviewerCount += 1;
      if (this.reviewerCount === 1) {
        const result = new Promise<{ sessionId: string; reply: string }>((resolve, reject) => {
          this.pendingFirstReviewer = {
            sessionId,
            resolve,
            reject,
          };
        });
        return {
          result,
          cancel: () => {
            this.firstReviewerCancelled = true;
            if (!this.pendingFirstReviewer) {
              return;
            }
            const pending = this.pendingFirstReviewer;
            this.pendingFirstReviewer = null;
            pending.reject(new CodexExecutionCancelledError());
          },
        };
      }
      return {
        result: Promise.resolve({
          sessionId: sessionId ?? `wf-thread-${this.callCount}`,
          reply: "VERDICT: APPROVED\nSUMMARY: 通过\nISSUES:\n- none",
        }),
        cancel: () => {},
      };
    }

    return {
      result: Promise.resolve({
        sessionId: sessionId ?? `wf-thread-${this.callCount}`,
        reply: `echo:${text}`,
      }),
      cancel: () => {},
    };
  }
}

class ArtifactWorkflowExecutor extends WorkflowExecutor {
  private createdArtifacts = false;

  override startExecution(
    text: string,
    sessionId: string | null,
    onProgress?: (event: unknown) => void,
    startOptions?: { workdir?: string },
  ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } {
    if (!this.createdArtifacts && text.includes("[role:executor]")) {
      const workdir = startOptions?.workdir;
      if (workdir) {
        for (const file of ["autodev#0", "workflow#0", "planner#0", "executor#0", "reviewer#0"]) {
          writeFileSync(path.join(workdir, file), "", "utf8");
        }
        this.createdArtifacts = true;
      }
    }
    return super.startExecution(text, sessionId, onProgress, startOptions);
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

  it("routes backend/model using configured rules for chat requests", async () => {
    const channel = new FakeChannel();
    const codexExecutor = new TaggedExecutor("codex");
    const claudeExecutor = new TaggedExecutor("claude");
    const store = new FakeStateStore();
    const executorFactory = vi.fn((provider: "codex" | "claude", _model?: string | null) =>
      provider === "claude" ? (claudeExecutor as never) : (codexExecutor as never),
    );
    const orchestrator = new Orchestrator(channel, codexExecutor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
      aiCliProvider: "codex",
      aiCliModel: "gpt-5",
      backendModelRoutingRules: [
        {
          id: "prefer-claude-chat",
          enabled: true,
          priority: 100,
          when: {
            taskTypes: ["chat"],
            textIncludes: ["anthropic"],
          },
          target: {
            provider: "claude",
            model: "claude-sonnet-4-5",
          },
        },
      ],
      executorFactory: executorFactory as never,
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "please ask anthropic model",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/status",
        eventId: "$backend-rule-status",
      }),
    );

    expect(codexExecutor.callCount).toBe(0);
    expect(claudeExecutor.callCount).toBe(1);
    expect(executorFactory).toHaveBeenCalledWith("claude", "claude-sonnet-4-5");
    expect(channel.sent.some((entry) => entry.text.includes("claude:please ask anthropic model"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("backend route: mode=auto, reason=rule_match, rule=prefer-claude-chat"))).toBe(true);
  });

  it("falls back to default backend when routing rule needs unavailable executor", async () => {
    const channel = new FakeChannel();
    const codexExecutor = new TaggedExecutor("codex");
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel, codexExecutor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
      aiCliProvider: "codex",
      aiCliModel: "gpt-5",
      backendModelRoutingRules: [
        {
          id: "prefer-claude-chat",
          enabled: true,
          priority: 100,
          when: {
            taskTypes: ["chat"],
            textIncludes: ["anthropic"],
          },
          target: {
            provider: "claude",
            model: "claude-sonnet-4-5",
          },
        },
      ],
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "please ask anthropic model",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/status",
        eventId: "$backend-fallback-status",
      }),
    );

    expect(codexExecutor.callCount).toBe(1);
    expect(channel.sent.some((entry) => entry.text.includes("codex:please ask anthropic model"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("backend route: mode=auto, reason=factory_unavailable, rule=prefer-claude-chat"))).toBe(true);
  });

  it("shows /diag route with rule hit and fallback reason details", async () => {
    const channel = new FakeChannel();
    const codexExecutor = new TaggedExecutor("codex");
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel, codexExecutor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
      aiCliProvider: "codex",
      aiCliModel: "gpt-5",
      backendModelRoutingRules: [
        {
          id: "prefer-claude-chat",
          enabled: true,
          priority: 100,
          when: {
            taskTypes: ["chat"],
            textIncludes: ["anthropic"],
          },
          target: {
            provider: "claude",
            model: "claude-sonnet-4-5",
          },
        },
      ],
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "please ask anthropic model",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/diag route 5",
        eventId: "$diag-route",
      }),
    );

    const notice = channel.notices.find((entry) => entry.text.includes("诊断信息（route）"));
    expect(notice).toBeDefined();
    expect(notice?.text).toContain("rules: total=1, enabled=1");
    expect(notice?.text).toContain("lastDecision: source=default, reason=factory_unavailable, rule=prefer-claude-chat");
    expect(notice?.text).toContain("reasonDesc: 命中规则但目标执行器不可用，回退默认后端");
    expect(notice?.text).toContain("fallback: yes");
    expect(notice?.text).toContain("taskType=chat");
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

  it("applies hot runtime config snapshot for new requests", async () => {
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

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "first", eventId: "$hr1" }));
    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "second", eventId: "$hr2" }));

    store.upsertRuntimeConfigSnapshot(
      GLOBAL_RUNTIME_HOT_CONFIG_KEY,
      JSON.stringify({
        rateLimiter: {
          windowMs: 60_000,
          maxRequestsPerUser: 2,
          maxRequestsPerRoom: 100,
          maxConcurrentGlobal: 10,
          maxConcurrentPerUser: 10,
          maxConcurrentPerRoom: 10,
        },
        matrixProgressUpdates: false,
        matrixProgressMinIntervalMs: 2_500,
        matrixTypingTimeoutMs: 10_000,
        sessionActiveWindowMinutes: 20,
        groupDirectModeEnabled: false,
        defaultGroupTriggerPolicy: {
          allowMention: true,
          allowReply: true,
          allowActiveWindow: true,
          allowPrefix: true,
        },
      }),
    );

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "third", eventId: "$hr3" }));

    expect(executor.callCount).toBe(2);
    expect(channel.notices.filter((entry) => entry.text.includes("请求过于频繁"))).toHaveLength(1);
  });

  it("keeps runtime state unchanged when hot config snapshot is invalid", async () => {
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

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "first", eventId: "$hi1" }));

    store.upsertRuntimeConfigSnapshot(
      GLOBAL_RUNTIME_HOT_CONFIG_KEY,
      JSON.stringify({
        rateLimiter: {
          windowMs: 60_000,
          maxRequestsPerUser: -1,
          maxRequestsPerRoom: 100,
          maxConcurrentGlobal: 10,
          maxConcurrentPerUser: 10,
          maxConcurrentPerRoom: 10,
        },
        matrixProgressUpdates: false,
        matrixProgressMinIntervalMs: 2_500,
        matrixTypingTimeoutMs: 10_000,
        sessionActiveWindowMinutes: 20,
        groupDirectModeEnabled: false,
        defaultGroupTriggerPolicy: {
          allowMention: true,
          allowReply: true,
          allowActiveWindow: true,
          allowPrefix: true,
        },
      }),
    );

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "second", eventId: "$hi2" }));

    expect(executor.callCount).toBe(1);
    expect(channel.notices.some((entry) => entry.text.includes("请求过于频繁"))).toBe(true);
  });

  it("applies a later valid hot config snapshot after rejecting an invalid snapshot", async () => {
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

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "first", eventId: "$hv1" }));

    store.upsertRuntimeConfigSnapshot(
      GLOBAL_RUNTIME_HOT_CONFIG_KEY,
      JSON.stringify({
        rateLimiter: {
          windowMs: 60_000,
          maxRequestsPerUser: -1,
          maxRequestsPerRoom: 100,
          maxConcurrentGlobal: 10,
          maxConcurrentPerUser: 10,
          maxConcurrentPerRoom: 10,
        },
        matrixProgressUpdates: false,
        matrixProgressMinIntervalMs: 2_500,
        matrixTypingTimeoutMs: 10_000,
        sessionActiveWindowMinutes: 20,
        groupDirectModeEnabled: false,
        defaultGroupTriggerPolicy: {
          allowMention: true,
          allowReply: true,
          allowActiveWindow: true,
          allowPrefix: true,
        },
      }),
    );

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "second", eventId: "$hv2" }));

    store.upsertRuntimeConfigSnapshot(
      GLOBAL_RUNTIME_HOT_CONFIG_KEY,
      JSON.stringify({
        rateLimiter: {
          windowMs: 60_000,
          maxRequestsPerUser: 2,
          maxRequestsPerRoom: 100,
          maxConcurrentGlobal: 10,
          maxConcurrentPerUser: 10,
          maxConcurrentPerRoom: 10,
        },
        matrixProgressUpdates: false,
        matrixProgressMinIntervalMs: 2_500,
        matrixTypingTimeoutMs: 10_000,
        sessionActiveWindowMinutes: 20,
        groupDirectModeEnabled: false,
        defaultGroupTriggerPolicy: {
          allowMention: true,
          allowReply: true,
          allowActiveWindow: true,
          allowPrefix: true,
        },
      }),
    );

    await orchestrator.handleMessage(makeInbound({ isDirectMessage: true, text: "third", eventId: "$hv3" }));

    expect(executor.callCount).toBe(2);
    expect(channel.notices.filter((entry) => entry.text.includes("请求过于频繁"))).toHaveLength(1);
  });

  it("applies hot config only to new requests and does not rollback in-flight requests", async () => {
    const channel = new FakeChannel();
    const executor = new DeferredExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
      rateLimiterOptions: {
        windowMs: 60_000,
        maxRequestsPerUser: 20,
        maxRequestsPerRoom: 120,
        maxConcurrentGlobal: 1,
        maxConcurrentPerUser: 2,
        maxConcurrentPerRoom: 2,
      },
    });

    const firstRequest = orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        senderId: "@alice:example.com",
        eventId: "$hn1",
        text: "first",
      }),
    );
    await waitForCondition(() => executor.callCount === 1);

    store.upsertRuntimeConfigSnapshot(
      GLOBAL_RUNTIME_HOT_CONFIG_KEY,
      JSON.stringify({
        rateLimiter: {
          windowMs: 60_000,
          maxRequestsPerUser: 20,
          maxRequestsPerRoom: 120,
          maxConcurrentGlobal: 2,
          maxConcurrentPerUser: 2,
          maxConcurrentPerRoom: 2,
        },
        matrixProgressUpdates: false,
        matrixProgressMinIntervalMs: 2_500,
        matrixTypingTimeoutMs: 10_000,
        sessionActiveWindowMinutes: 20,
        groupDirectModeEnabled: false,
        defaultGroupTriggerPolicy: {
          allowMention: true,
          allowReply: true,
          allowActiveWindow: true,
          allowPrefix: true,
        },
      }),
    );

    const secondRequest = orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        senderId: "@bob:example.com",
        eventId: "$hn2",
        text: "second",
      }),
    );
    await waitForCondition(() => executor.callCount === 2);

    executor.resolveCall(0, "first-done");
    executor.resolveCall(1, "second-done");
    await Promise.all([firstRequest, secondRequest]);

    expect(channel.notices.some((entry) => entry.text.includes("请求过于频繁"))).toBe(false);
    expect(channel.sent.map((entry) => entry.text)).toEqual(expect.arrayContaining(["first-done", "second-done"]));
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
      await waitForCondition(() => store.getTaskById(queued.taskId)?.status === "succeeded", 8_000);

      expect(executor.callCount).toBe(2);
      expect(store.getTaskById(queued.taskId)?.attempt).toBe(2);
      expect(store.listTaskFailureArchive(5)).toHaveLength(0);
      expect(store.hasProcessedEvent(queued.sessionKey, message.eventId)).toBe(true);
      expect(channel.sent.some((entry) => entry.text.includes("归档"))).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

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
      await waitForCondition(() => store.getTaskById(queued.taskId)?.status === "failed", 20_000);

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
  }, 30_000);

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
  }, 15_000);

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
      await waitForCondition(() => {
        const task = store.getTaskById(queued.taskId);
        return task?.status === "pending" && task.nextRetryAt !== null;
      }, 3_000);
      const retryingTask = store.getTaskById(queued.taskId);
      expect(retryingTask?.nextRetryAt).not.toBeNull();
      const waitUntilRetryMs = Math.max(0, (retryingTask?.nextRetryAt ?? Date.now()) - Date.now());
      await new Promise((resolve) => setTimeout(resolve, waitUntilRetryMs + 80));
      await orchestrator.bootstrapTaskQueueRecovery();
      await waitForCondition(() => store.getTaskById(queued.taskId)?.status === "succeeded", 10_000);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
      expect(executor.callCount).toBe(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

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

  it("emits API lifecycle stages across queue execution and retry", async () => {
    const { dir, store } = await createSqliteStateStore("codeharbor-orch-api-lifecycle-");
    try {
      const channel = new FakeChannel();
      const executor = new SequencedExecutor([
        { kind: "error", error: new Error("temporary upstream issue") },
        { kind: "success", reply: "ok-after-retry" },
      ]);
      const lifecycleEvents: ApiTaskLifecycleEvent[] = [];
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
        onApiTaskLifecycleEvent: (event) => lifecycleEvents.push(event),
      });

      const queued = orchestrator.submitApiTask({
        conversationId: "!api-room:example.com",
        senderId: "@ci:example.com",
        text: "run lifecycle verification",
        idempotencyKey: "idem-api-lifecycle",
        externalContext: {
          source: "ci",
          workflowId: "build-123",
          ci: {
            repository: "acme/backend",
            pipeline: "integration",
            status: "running",
            branch: null,
            commit: null,
            url: null,
          },
          ticket: null,
          metadata: {
            provider: "github-actions",
          },
        },
      });

      await waitForCondition(() => store.getTaskById(queued.task.id)?.status === "succeeded", 60_000);
      expect(lifecycleEvents.map((event) => event.stage)).toEqual(
        expect.arrayContaining(["queued", "executing", "retrying", "completed"]),
      );
      expect(lifecycleEvents.filter((event) => event.stage === "executing")).toHaveLength(2);
      expect(lifecycleEvents.some((event) => event.stage === "retrying" && event.nextRetryAt !== null)).toBe(true);
      expect(lifecycleEvents[0]?.externalContext.source).toBe("ci");
      expect(lifecycleEvents[0]?.externalContext.matrixConversationId).toBe("!api-room:example.com");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 90_000);

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

  it("injects multimodal summary metadata for Matrix rendering", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-multimodal-summary-"));
    const imagePath = path.join(tempRoot, "diagram.png");
    const audioPath = path.join(tempRoot, "voice.m4a");
    await fs.writeFile(imagePath, "image", "utf8");
    await fs.writeFile(audioPath, "audio", "utf8");

    const transcriber = {
      isEnabled: () => true,
      transcribeMany: vi.fn(async () => [{ name: "voice.m4a", text: "请先修复 P0，再推进发布流程。" }]),
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
          text: "请结合图片和语音给出结论",
          eventId: "$multimodal-summary",
          attachments: [
            {
              kind: "image",
              name: "diagram.png",
              mxcUrl: "mxc://example.com/image",
              mimeType: "image/png",
              sizeBytes: 64,
              localPath: imagePath,
            },
            {
              kind: "audio",
              name: "voice.m4a",
              mxcUrl: "mxc://example.com/audio",
              mimeType: "audio/mp4",
              sizeBytes: 64,
              localPath: audioPath,
            },
          ],
        }),
      );

      expect(channel.sent).toHaveLength(1);
      expect(channel.sent[0]?.options?.multimodalSummary).toEqual({
        images: {
          total: 1,
          included: 1,
          names: ["diagram.png"],
        },
        audio: {
          total: 1,
          transcribed: 1,
          items: [
            {
              name: "voice.m4a",
              summary: "请先修复 P0，再推进发布流程。",
            },
          ],
        },
      });
      await expect(fs.access(imagePath)).rejects.toBeDefined();
      await expect(fs.access(audioPath)).rejects.toBeDefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("aligns multimodal image summary with claude image fallback retry", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-claude-image-fallback-"));
    const imagePath = path.join(tempRoot, "diagram.png");
    await fs.writeFile(imagePath, "image", "utf8");

    try {
      const channel = new FakeChannel();
      const executor = new SequencedExecutor([
        {
          kind: "error",
          error: new Error("unsupported image extension"),
        },
        {
          kind: "success",
          reply: "ok:retry-without-images",
        },
      ]);
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        aiCliProvider: "claude",
        aiCliModel: "claude-sonnet-4-5",
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "请分析图片",
          eventId: "$claude-image-fallback-summary",
          attachments: [
            {
              kind: "image",
              name: "diagram.png",
              mxcUrl: "mxc://example.com/image",
              mimeType: "image/png",
              sizeBytes: 64,
              localPath: imagePath,
            },
          ],
        }),
      );

      expect(executor.callCount).toBe(2);
      expect(executor.calls[0]?.imagePaths).toEqual([imagePath]);
      expect(executor.calls[1]?.imagePaths).toEqual([]);
      expect(channel.notices.some((entry) => entry.text.includes("已自动降级为纯文本重试"))).toBe(true);
      expect(channel.sent).toHaveLength(1);
      expect(channel.sent[0]?.options?.multimodalSummary).toEqual({
        images: {
          total: 1,
          included: 0,
          names: [],
        },
        audio: null,
      });
      await expect(fs.access(imagePath)).rejects.toBeDefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not inject multimodal summary metadata for plain text requests", async () => {
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
        text: "普通文本请求",
        eventId: "$plain-no-multimodal",
      }),
    );

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.options?.multimodalSummary).toBeNull();
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

  it("appends extracted document text context to prompt", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-doc-"));
    const txtPath = path.join(tempRoot, "plan.txt");
    await fs.writeFile(txtPath, "第一行\n第二行", "utf8");

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
          isDirectMessage: true,
          text: "请参考附件文档",
          eventId: "$doc-context",
          attachments: [
            {
              kind: "file",
              name: "plan.txt",
              mxcUrl: "mxc://example.com/doc",
              mimeType: "text/plain",
              sizeBytes: 30,
              localPath: txtPath,
            },
          ],
        }),
      );

      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.text).toContain("[documents]");
      expect(executor.calls[0]?.text).toContain("name=plan.txt format=txt");
      expect(executor.calls[0]?.text).toContain("summary=第一行 第二行");
      expect(executor.calls[0]?.text).toContain("chunk_1:");
      expect(executor.calls[0]?.text).toContain("第一行");
      expect(executor.calls[0]?.text).toContain("第二行");
      expect(channel.notices.some((entry) => entry.text.includes("文档处理提示"))).toBe(false);
      await expect(fs.access(txtPath)).rejects.toBeDefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("chunks long document context and avoids injecting full raw text", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-doc-chunk-"));
    const txtPath = path.join(tempRoot, "long.txt");
    const tailMarker = "TAIL_MARKER_SHOULD_NOT_BE_INCLUDED";
    const longText = `${"段落A ".repeat(900)}\n\n${"段落B ".repeat(900)}\n\n${tailMarker}`;
    await fs.writeFile(txtPath, longText, "utf8");

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
          isDirectMessage: true,
          text: "请分块处理长文档",
          eventId: "$doc-chunk",
          attachments: [
            {
              kind: "file",
              name: "long.txt",
              mxcUrl: "mxc://example.com/doc-long",
              mimeType: "text/plain",
              sizeBytes: 12000,
              localPath: txtPath,
            },
          ],
        }),
      );

      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.text).toContain("[documents]");
      expect(executor.calls[0]?.text).toContain("summary=");
      expect(executor.calls[0]?.text).toContain("chunk_1:");
      expect(executor.calls[0]?.text).toContain("[truncated] omitted_chunks=");
      expect(executor.calls[0]?.text).not.toContain(tailMarker);
      await expect(fs.access(txtPath)).rejects.toBeDefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports unsupported, oversized, and failed document extractions via notice", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-doc-notice-"));
    const txtPath = path.join(tempRoot, "ok.txt");
    const unsupportedPath = path.join(tempRoot, "ignore.md");
    const brokenDirPath = path.join(tempRoot, "broken.txt");
    await fs.writeFile(txtPath, "可提取文档内容", "utf8");
    await fs.writeFile(unsupportedPath, "unsupported", "utf8");
    await fs.mkdir(brokenDirPath, { recursive: true });

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
          isDirectMessage: true,
          text: "处理文档混合输入",
          eventId: "$doc-notice",
          attachments: [
            {
              kind: "file",
              name: "ok.txt",
              mxcUrl: "mxc://example.com/ok",
              mimeType: "text/plain",
              sizeBytes: 64,
              localPath: txtPath,
            },
            {
              kind: "file",
              name: "ignore.md",
              mxcUrl: "mxc://example.com/md",
              mimeType: "text/markdown",
              sizeBytes: 32,
              localPath: unsupportedPath,
            },
            {
              kind: "file",
              name: "large.pdf",
              mxcUrl: "mxc://example.com/large",
              mimeType: "application/pdf",
              sizeBytes: DEFAULT_DOCUMENT_MAX_BYTES + 1,
              localPath: null,
            },
            {
              kind: "file",
              name: "broken.txt",
              mxcUrl: "mxc://example.com/broken",
              mimeType: "text/plain",
              sizeBytes: null,
              localPath: brokenDirPath,
            },
          ],
        }),
      );

      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.text).toContain("[documents]");
      expect(executor.calls[0]?.text).toContain("可提取文档内容");
      expect(channel.notices.some((entry) => entry.text.includes("文档处理提示"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("类型不支持 1 份"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("超过大小限制 1 份"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("解析失败 1 份"))).toBe(true);
      await expect(fs.access(txtPath)).rejects.toBeDefined();
      await expect(fs.access(unsupportedPath)).rejects.toBeDefined();
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

  it("skips missing local image file even when attachment metadata includes size", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-image-missing-local-"));
    const missingPng = path.join(tempRoot, "missing.png");

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
          imageMaxBytes: 10485760,
          imageMaxCount: 4,
          imageAllowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
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
          eventId: "$image-missing-local",
          attachments: [
            {
              kind: "image",
              name: "missing.png",
              mxcUrl: "mxc://example.com/missing",
              mimeType: "image/png",
              sizeBytes: 64,
              localPath: missingPng,
            },
          ],
        }),
      );

      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.imagePaths).toEqual([]);
      expect(channel.notices.some((entry) => entry.text.includes("图片处理提示"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("本地文件不存在 1 张"))).toBe(true);

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/diag media 5",
          eventId: "$diag-image-missing-local",
        }),
      );

      const mediaDiagNotice = channel.notices.find((entry) => entry.text.includes("诊断信息（media）"));
      expect(mediaDiagNotice).toBeDefined();
      expect(mediaDiagNotice?.text).toContain("image.skipped_missing=1");
      expect(mediaDiagNotice?.text).toContain("image.skipped_missing_local_file=1");
      expect(mediaDiagNotice?.text).toContain("type=image.skipped_missing_local_file");
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

  it("rejects invalid /autodev subcommands instead of routing to chat", async () => {
    const channel = new FakeChannel();
    const executor = new ImmediateExecutor();
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
        text: "/autodev 润",
        eventId: "$autodev-invalid-subcommand",
      }),
    );

    expect(executor.calls).toHaveLength(0);
    expect(channel.sent).toHaveLength(0);
    expect(channel.notices.some((entry) => entry.text.includes("invalid /autodev subcommand"))).toBe(true);
  });

  it("keeps /autodev workdir override after orchestrator restart", async () => {
    const { dir, store } = await createSqliteStateStore("codeharbor-orch-autodev-workdir-");
    const targetWorkdir = path.join(dir, "workspace-autodev");
    await fs.mkdir(targetWorkdir, { recursive: true });

    const options = {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      outputLanguage: "en" as const,
      progressUpdatesEnabled: false,
      multiAgentWorkflow: {
        enabled: true,
        autoRepairMaxRounds: 1,
      },
    };

    try {
      const firstChannel = new FakeChannel();
      const firstExecutor = new ImmediateExecutor();
      const first = new Orchestrator(firstChannel, firstExecutor as never, store as never, logger as never, options);

      await first.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: `/autodev workdir ${targetWorkdir}`,
          eventId: "$autodev-workdir-set",
        }),
      );
      expect(firstChannel.notices.some((entry) => entry.text.includes("AutoDev workdir updated"))).toBe(true);

      const secondChannel = new FakeChannel();
      const secondExecutor = new ImmediateExecutor();
      const second = new Orchestrator(secondChannel, secondExecutor as never, store as never, logger as never, options);

      await second.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev workdir",
          eventId: "$autodev-workdir-status-1",
        }),
      );

      const statusBeforeReset = secondChannel.notices.at(-1)?.text ?? "";
      expect(statusBeforeReset).toContain(`effectiveWorkdir: ${path.resolve(targetWorkdir)}`);
      expect(statusBeforeReset).toContain(`override: ${path.resolve(targetWorkdir)}`);

      await second.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/reset",
          eventId: "$autodev-workdir-reset",
        }),
      );
      await second.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev workdir",
          eventId: "$autodev-workdir-status-2",
        }),
      );

      const statusAfterReset = secondChannel.notices.at(-1)?.text ?? "";
      expect(statusAfterReset).toContain("override: none");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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

  it("keeps autodev run successful when Matrix notice sending fails", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-notice-failure-"));
    const requirementsPath = path.join(tempRoot, "REQUIREMENTS.md");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(requirementsPath, "# Requirements\n- implement T9.2\n", "utf8");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 预估时间 | 优先级 | 依赖 | 状态 |",
        "|--------|----------|----------|--------|------|------|",
        "| T9.2 | notice failure should not fail run | 1h | P0 | - | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    try {
      const channel = new NoticeFailingChannel();
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

      await expect(
        orchestrator.handleMessage(
          makeInbound({
            isDirectMessage: true,
            text: "/autodev run T9.2",
            eventId: "$autodev-run-notice-failure",
          }),
        ),
      ).resolves.toBeUndefined();

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T9.2 | notice failure should not fail run | 1h | P0 | - | ✅ |");
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

  it("supports /autodev stop to finish current task then stop loop", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-loop-stop-"));
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
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
      const executor = new GracefulLoopWorkflowExecutor();
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

      const runPromise = orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run",
          eventId: "$autodev-run-loop-stop",
        }),
      );
      await waitForCondition(() => executor.isFirstReviewerPending(), 2_000);

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev stop",
          eventId: "$autodev-loop-stop-command",
        }),
      );

      expect(channel.notices.some((entry) => entry.text.includes("当前任务执行完成后停止 AutoDev 循环"))).toBe(true);

      executor.releaseFirstReviewer();
      await runPromise;

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T11.1 | first loop task | ✅ |");
      expect(updated).toContain("| T11.2 | second loop task | ⬜ |");
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 循环执行已按请求停止"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("completedRuns: 1"))).toBe(true);
      expect(executor.firstReviewerCancelled).toBe(false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("handles /autodev stop in group even when active window is expired", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-loop-stop-group-"));
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
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
      const executor = new GracefulLoopWorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        sessionActiveWindowMinutes: 0,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      const runPromise = orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: false,
          conversationId: "!room:example.com",
          senderId: "@alice:example.com",
          text: "!code /autodev run",
          eventId: "$autodev-run-loop-stop-group",
        }),
      );
      await waitForCondition(() => executor.isFirstReviewerPending(), 2_000);

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: false,
          conversationId: "!room:example.com",
          senderId: "@alice:example.com",
          text: "/autodev stop",
          mentionsBot: false,
          repliesToBot: false,
          eventId: "$autodev-loop-stop-command-group",
        }),
      );

      expect(channel.notices.some((entry) => entry.text.includes("当前任务执行完成后停止 AutoDev 循环"))).toBe(true);

      executor.releaseFirstReviewer();
      await runPromise;

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T11.1 | first loop task | ✅ |");
      expect(updated).toContain("| T11.2 | second loop task | ⬜ |");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not start next loop task when /autodev stop arrives between iterations", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-loop-stop-race-"));
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
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

    const originalReadFile = fs.readFile.bind(fs) as (...args: unknown[]) => Promise<string>;
    let taskListReadCount = 0;
    let injectedStop = false;
    let readFileSpy: { mockRestore: () => void } | null = null;

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

      readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args: unknown[]) => {
        const target = String(args[0] ?? "");
        if (path.resolve(target) === path.resolve(taskListPath)) {
          taskListReadCount += 1;
          if (!injectedStop && taskListReadCount === 6) {
            injectedStop = true;
            await orchestrator.handleMessage(
              makeInbound({
                isDirectMessage: true,
                text: "/autodev stop",
                eventId: "$autodev-loop-stop-race",
              }),
            );
          }
        }
        return originalReadFile(...args);
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run",
          eventId: "$autodev-run-loop-race",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(injectedStop).toBe(true);
      expect(updated).toContain("| T11.1 | first loop task | ✅ |");
      expect(updated).toContain("| T11.2 | second loop task | ⬜ |");
      expect(channel.notices.some((entry) => entry.text.includes("当前任务执行完成后停止 AutoDev 循环"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 循环执行已按请求停止"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 启动任务 T11.2"))).toBe(false);
    } finally {
      readFileSpy?.mockRestore();
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
      expect(channel.notices.some((entry) => entry.text.includes("循环执行已达到轮次上限，已暂停"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("loopMaxRuns: 2"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("继续执行: /autodev run"))).toBe(true);
      const runtime = orchestrator.getRuntimeMetricsSnapshot();
      expect(runtime.autodev.runs.succeeded).toBe(2);
      expect(runtime.autodev.loopStops.max_runs).toBe(1);
      expect(runtime.autodev.tasksBlocked).toBe(0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats loop max runs = 0 as unlimited", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-loop-unlimited-runs-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T12.4 | first | ⬜ |",
        "| T12.5 | second | ⬜ |",
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
        autoDevLoopMaxRuns: 0,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run",
          eventId: "$autodev-run-unlimited-runs",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T12.4 | first | ✅ |");
      expect(updated).toContain("| T12.5 | second | ✅ |");
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 循环执行完成"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("轮次上限"))).toBe(false);
      const runtime = orchestrator.getRuntimeMetricsSnapshot();
      expect(runtime.autodev.runs.succeeded).toBe(2);
      expect(runtime.autodev.loopStops.max_runs).toBe(0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("stops /autodev run loop when a round produces no task-list state change", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-loop-no-progress-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    const initialTaskList = [
      "| 任务ID | 任务描述 | 状态 |",
      "|--------|----------|------|",
      "| T12.9 | no progress task | ⬜ |",
    ].join("\n");
    await fs.writeFile(taskListPath, initialTaskList, "utf8");

    const originalReadFile = fs.readFile.bind(fs) as (...args: unknown[]) => Promise<string>;
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args: unknown[]) => {
      const targetPath = path.resolve(String(args[0] ?? ""));
      if (targetPath === path.resolve(taskListPath)) {
        return initialTaskList;
      }
      return originalReadFile(...args);
    });

    try {
      const channel = new FakeChannel();
      const executor = new WorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        autoDevLoopMaxRuns: 20,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run",
          eventId: "$autodev-run-no-progress",
        }),
      );

      expect(channel.notices.some((entry) => entry.text.includes("未产生任务状态变化"))).toBe(true);
      const runtime = orchestrator.getRuntimeMetricsSnapshot();
      expect(runtime.autodev.loopStops.no_progress).toBe(1);
    } finally {
      readFileSpy.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails fast before /autodev run task execution when git worktree is dirty", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-preflight-single-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T15.1 | preflight single | ⬜ |",
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
    await fs.writeFile(path.join(tempRoot, "DIRTY_NOTE.md"), "dirty\n", "utf8");

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
          text: "/autodev run T15.1",
          eventId: "$autodev-run-preflight-single",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T15.1 | preflight single | ⬜ |");
      expect(executor.callCount).toBe(0);
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 已停止（Git preflight 未通过）"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("dirtyFiles: DIRTY_NOTE.md"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("git status"))).toBe(true);
      const runtime = orchestrator.getRuntimeMetricsSnapshot();
      expect(runtime.autodev.runs.failed).toBe(1);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails fast in /autodev run loop when git worktree is dirty", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-preflight-loop-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T15.2 | preflight loop one | ⬜ |",
        "| T15.3 | preflight loop two | ⬜ |",
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
    await fs.writeFile(path.join(tempRoot, "DIRTY_LOOP.md"), "dirty\n", "utf8");

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
          eventId: "$autodev-run-preflight-loop",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T15.2 | preflight loop one | ⬜ |");
      expect(updated).toContain("| T15.3 | preflight loop two | ⬜ |");
      expect(executor.callCount).toBe(0);
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 已停止（Git preflight 未通过）"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("dirtyFiles: DIRTY_LOOP.md"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("mode: loop"))).toBe(true);
      const runtime = orchestrator.getRuntimeMetricsSnapshot();
      expect(runtime.autodev.runs.failed).toBe(1);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("auto-stashes dirty worktree in preflight when AUTODEV_PREFLIGHT_AUTO_STASH=true", async () => {
    const previous = process.env.AUTODEV_PREFLIGHT_AUTO_STASH;
    process.env.AUTODEV_PREFLIGHT_AUTO_STASH = "true";

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-preflight-auto-stash-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T15.4 | preflight auto stash | ⬜ |",
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
    await fs.writeFile(path.join(tempRoot, "DIRTY_AUTO_STASH.md"), "dirty\n", "utf8");

    try {
      const channel = new FakeChannel();
      const executor = new WorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        outputLanguage: "en",
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T15.4",
          eventId: "$autodev-run-preflight-auto-stash",
        }),
      );

      expect(executor.callCount).toBeGreaterThan(0);
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev stopped (Git preflight failed)"))).toBe(false);
      expect(channel.notices.some((entry) => entry.text.includes("dirty worktree auto-stashed; continuing run"))).toBe(true);
      const stashList = (await execFileAsync("git", ["stash", "list"], { cwd: tempRoot })).stdout;
      expect(stashList).toContain("codeharbor autodev preflight auto-stash");
    } finally {
      if (previous === undefined) {
        delete process.env.AUTODEV_PREFLIGHT_AUTO_STASH;
      } else {
        process.env.AUTODEV_PREFLIGHT_AUTO_STASH = previous;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rolls back forbidden TASK_LIST drift introduced during workflow", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-status-reconcile-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.1 | drift reconcile task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const driftExecutor = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: "delivered output",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: (async () => {
              const raw = await fs.readFile(taskListPath, "utf8");
              const drifted = raw.replace("| T16.1 | drift reconcile task | ⬜ |", "| T16.1 | drift reconcile task | ✅ |");
              await fs.writeFile(taskListPath, drifted, "utf8");
              return {
                sessionId: sessionId ?? "wf-thread-reviewer",
                reply: "VERDICT: REJECTED\nSUMMARY: reject this task\nISSUES:\n- missing validation",
              };
            })(),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, driftExecutor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.1",
          eventId: "$autodev-run-status-reconcile",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.1 | drift reconcile task | 🔄 |");
      expect(channel.notices.some((entry) => entry.text.includes("task status: 🔄"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 策略保护"))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows completion gate when TASK_LIST drift is auto-restored", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-tasklist-policy-gate-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.11 | task list policy gate | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const policyExecutor = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: "VALIDATION_STATUS: PASS\n__EXIT_CODES__ unit=0",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: (async () => {
              const raw = await fs.readFile(taskListPath, "utf8");
              const drifted = raw.replace("| T16.11 | task list policy gate | ⬜ |", "| T16.11 | task list policy gate | ✅ |");
              await fs.writeFile(taskListPath, drifted, "utf8");
              return {
                sessionId: sessionId ?? "wf-thread-reviewer",
                reply: "VERDICT: APPROVED\nSUMMARY: reviewer approved",
              };
            })(),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, policyExecutor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        outputLanguage: "en",
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.11",
          eventId: "$autodev-run-tasklist-policy-gate",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.11 | task list policy gate | ✅ |");
      const resultNotice = channel.notices.find((entry) => entry.text.includes("AutoDev task result"))?.text ?? "";
      expect(resultNotice).toContain("reviewer approved: yes");
      expect(resultNotice).toContain("completionGate: passed");
      expect(resultNotice).toContain("completionGateReasons: N/A");
      expect(resultNotice).toContain("task status: ✅");
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev policy guard"))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps task in_progress when completion gate fails on explicit validation failure", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-completion-gate-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.2 | completion gate task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const gateExecutor = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: "VALIDATION: tests failed with timeout in gateway suite",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-reviewer",
              reply: "VERDICT: APPROVED\nSUMMARY: reviewer approved",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, gateExecutor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        outputLanguage: "en",
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.2",
          eventId: "$autodev-run-completion-gate",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.2 | completion gate task | 🔄 |");
      expect(channel.notices.some((entry) => entry.text.includes("completionGate: failed"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("验证") || entry.text.includes("validation"))).toBe(true);
      const resultNotice = [...channel.notices]
        .reverse()
        .find((entry) => entry.text.includes("AutoDev task result"))?.text ?? "";
      expect(resultNotice).toContain("git commit: skipped (validation not passed; auto commit skipped)");
      expect(resultNotice).not.toContain("reviewer not approved; auto commit skipped");

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev status",
          eventId: "$autodev-status-completion-gate",
        }),
      );
      const statusNotice = [...channel.notices]
        .reverse()
        .find((entry) => entry.text.includes("[CodeHarbor] AutoDev status"))?.text ?? "";
      expect(statusNotice).toContain("runState: completed_with_gate_failed");
      expect(statusNotice).toContain("runValidationFailureClass: scoped_text_failure");
      expect(statusNotice).toContain("runValidationEvidenceSource: scoped_text");
      const runValidationAtLine = statusNotice
        .split("\n")
        .find((line) => line.startsWith("- runValidationAt: "));
      expect(runValidationAtLine).toBeDefined();
      expect(runValidationAtLine ?? "").not.toContain("N/A");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not treat '0 failed' summary as validation failure", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-validation-zero-failed-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.6 | validation zero failed task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const executorWithZeroFailed = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: "VALIDATION: 23 passed, 0 failed",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-reviewer",
              reply: "VERDICT: APPROVED\nSUMMARY: validated",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executorWithZeroFailed as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        outputLanguage: "en",
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.6",
          eventId: "$autodev-run-validation-zero-failed",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.6 | validation zero failed task | ✅ |");
      const resultNotice = [...channel.notices]
        .reverse()
        .find((entry) => entry.text.includes("AutoDev task result"))?.text ?? "";
      expect(resultNotice).toContain("completionGate: passed");
      expect(resultNotice).not.toContain("validation-not-passed");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not fail validation when non-validation sections mention '失败' but validation section passed", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-validation-scope-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.7 | validation scope task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const executorWithNonValidationFailureWording = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: [
                "最终可执行结果",
                "已完成 T2.5。",
                "",
                "验证结果",
                "node --test services/gateway/tests/inbound-events.test.js：31/31 通过。",
                "node --test services/gateway/tests/entrypoint.test.js：23/23 通过。",
                "bash services/run-smoke-tests.sh：全部 [PASS]。",
                "",
                "风险说明",
                "复杂模型超时且回退失败场景已覆盖。",
              ].join("\n"),
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-reviewer",
              reply: "VERDICT: APPROVED\nSUMMARY: validated",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(
        channel,
        executorWithNonValidationFailureWording as never,
        store as never,
        logger as never,
        {
          commandPrefix: "!code",
          matrixUserId: "@bot:example.com",
          progressUpdatesEnabled: false,
          outputLanguage: "en",
          defaultCodexWorkdir: tempRoot,
          multiAgentWorkflow: {
            enabled: true,
            autoRepairMaxRounds: 0,
          },
        },
      );

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.7",
          eventId: "$autodev-run-validation-scope",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.7 | validation scope task | ✅ |");
      const resultNotice = [...channel.notices]
        .reverse()
        .find((entry) => entry.text.includes("AutoDev task result"))?.text ?? "";
      expect(resultNotice).toContain("completionGate: passed");
      expect(resultNotice).not.toContain("validation-not-passed");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats explicit VALIDATION_STATUS FAIL as validation failure", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-validation-status-fail-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.8 | validation status fail task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const executorWithValidationStatusFail = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: [
                "最终可执行结果",
                "已完成任务。",
                "",
                "VALIDATION_STATUS: FAIL",
                "验证结果",
                "node --test services/gateway/tests/inbound-events.test.js：31/31 通过。",
              ].join("\n"),
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-reviewer",
              reply: "VERDICT: APPROVED\nSUMMARY: validated",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executorWithValidationStatusFail as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        outputLanguage: "en",
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.8",
          eventId: "$autodev-run-validation-status-fail",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.8 | validation status fail task | 🔄 |");
      const resultNotice = [...channel.notices]
        .reverse()
        .find((entry) => entry.text.includes("AutoDev task result"))?.text ?? "";
      expect(resultNotice).toContain("completionGate: failed");
      expect(resultNotice).toContain("validation-not-passed");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("prioritizes __EXIT_CODES__ non-zero as validation failure even when status says PASS", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-validation-exitcode-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.9 | validation exitcode task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const executorWithExitCodeFailure = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: [
                "最终可执行结果",
                "已完成任务。",
                "",
                "VALIDATION_STATUS: PASS",
                "__EXIT_CODES__ inbound=0 entrypoint=1",
                "验证结果",
                "node --test services/gateway/tests/inbound-events.test.js：31/31 通过。",
              ].join("\n"),
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-reviewer",
              reply: "VERDICT: APPROVED\nSUMMARY: validated",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executorWithExitCodeFailure as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        outputLanguage: "en",
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.9",
          eventId: "$autodev-run-validation-exitcode",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.9 | validation exitcode task | 🔄 |");
      const resultNotice = [...channel.notices]
        .reverse()
        .find((entry) => entry.text.includes("AutoDev task result"))?.text ?? "";
      expect(resultNotice).toContain("completionGate: failed");
      expect(resultNotice).toContain("validation-not-passed");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("allows expected non-zero exit codes when validation status is PASS and evidence is explicit", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-validation-expected-nonzero-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.10 | validation expected non-zero task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const executorWithExpectedNonZero = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: [
                "最终可执行结果",
                "已完成任务。",
                "",
                "VALIDATION",
                "bash deploy/scripts/respeaker-precheck.sh --jetson-host '$(id)'：PASS（按预期拒绝，exit 2）",
                "bash deploy/scripts/respeaker-precheck.sh --jetson-host 'a;id'：PASS（按预期拒绝，exit 2）",
                "",
                "VALIDATION_STATUS: PASS",
                "__EXIT_CODES__ dry_run=0 precheck_subshell=2 precheck_semicolon=2",
              ].join("\n"),
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-reviewer",
              reply: "VERDICT: APPROVED\nSUMMARY: validated",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executorWithExpectedNonZero as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        outputLanguage: "en",
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.10",
          eventId: "$autodev-run-validation-expected-nonzero",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.10 | validation expected non-zero task | ✅ |");
      const resultNotice = [...channel.notices]
        .reverse()
        .find((entry) => entry.text.includes("AutoDev task result"))?.text ?? "";
      expect(resultNotice).toContain("completionGate: passed");
      expect(resultNotice).not.toContain("validation-not-passed");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails completion gate in strict validation mode when structured validation evidence is missing", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-validation-strict-missing-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.12 | validation strict missing evidence task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const executorWithoutStructuredValidation = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: "VALIDATION: 23 passed, 0 failed",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-reviewer",
              reply: "VERDICT: APPROVED\nSUMMARY: validated",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(
        channel,
        executorWithoutStructuredValidation as never,
        store as never,
        logger as never,
        {
          commandPrefix: "!code",
          matrixUserId: "@bot:example.com",
          progressUpdatesEnabled: false,
          outputLanguage: "en",
          defaultCodexWorkdir: tempRoot,
          autoDevValidationStrict: true,
          multiAgentWorkflow: {
            enabled: true,
            autoRepairMaxRounds: 0,
          },
        },
      );

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.12",
          eventId: "$autodev-run-validation-strict-missing",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.12 | validation strict missing evidence task | 🔄 |");
      const resultNotice = [...channel.notices]
        .reverse()
        .find((entry) => entry.text.includes("AutoDev task result"))?.text ?? "";
      expect(resultNotice).toContain("completionGate: failed");
      expect(resultNotice).toContain("validation-not-passed");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("self-heals stale completed status from previous rejected run before executing task again", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-self-heal-run-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.3 | self heal run task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    let callCount = 0;
    const rejectExecutor = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        callCount += 1;
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: "output",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-reviewer",
              reply: "VERDICT: REJECTED\nSUMMARY: still not approved\nISSUES:\n- missing detail",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, rejectExecutor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.3",
          eventId: "$autodev-run-self-heal-first",
        }),
      );
      const callsAfterFirstRun = callCount;
      expect(callsAfterFirstRun).toBeGreaterThan(0);

      const drifted = (await fs.readFile(taskListPath, "utf8")).replace(
        "| T16.3 | self heal run task | 🔄 |",
        "| T16.3 | self heal run task | ✅ |",
      );
      await fs.writeFile(taskListPath, drifted, "utf8");

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.3",
          eventId: "$autodev-run-self-heal-second",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.3 | self heal run task | 🔄 |");
      expect(callCount).toBeGreaterThan(callsAfterFirstRun);
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 状态自愈"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("already completed"))).toBe(false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("self-heals stale completed status during /autodev status", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-self-heal-status-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.4 | self heal status task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const rejectExecutor = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: "output",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-reviewer",
              reply: "VERDICT: REJECTED\nSUMMARY: still not approved\nISSUES:\n- missing detail",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, rejectExecutor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.4",
          eventId: "$autodev-status-heal-run-first",
        }),
      );

      const drifted = (await fs.readFile(taskListPath, "utf8")).replace(
        "| T16.4 | self heal status task | 🔄 |",
        "| T16.4 | self heal status task | ✅ |",
      );
      await fs.writeFile(taskListPath, drifted, "utf8");

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev status",
          eventId: "$autodev-status-heal-check",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.4 | self heal status task | 🔄 |");
      const statusNotice = [...channel.notices]
        .reverse()
        .find((entry) => entry.text.includes("[CodeHarbor] AutoDev 状态"))?.text ?? "";
      expect(statusNotice).toContain("taskAutoHeal: T16.4:completed->in_progress");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("supports /autodev reconcile to fix stale task states from recent run records", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-reconcile-command-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T16.5 | reconcile task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const rejectExecutor = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: "output",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-reviewer",
              reply: "VERDICT: REJECTED\nSUMMARY: not approved\nISSUES:\n- missing detail",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, rejectExecutor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T16.5",
          eventId: "$autodev-reconcile-run-first",
        }),
      );

      const drifted = (await fs.readFile(taskListPath, "utf8")).replace(
        "| T16.5 | reconcile task | 🔄 |",
        "| T16.5 | reconcile task | ✅ |",
      );
      await fs.writeFile(taskListPath, drifted, "utf8");

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev reconcile",
          eventId: "$autodev-reconcile-command",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T16.5 | reconcile task | 🔄 |");
      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 状态对账完成"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("T16.5"))).toBe(true);
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
      expect(latest.stdout).toMatch(/(feat|fix|docs|test|chore)\([a-z0-9-]+\): .* \(T10\.1\)/);
      const latestBody = await execFileAsync("git", ["log", "--pretty=%B", "-n", "1"], { cwd: tempRoot });
      expect(latestBody.stdout).toContain("Task-ID: T10.1");
      expect(latestBody.stdout).toContain("Changed-files:");
      expect(latestBody.stdout).toContain("Generated-by: CodeHarbor AutoDev");
      const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: tempRoot });
      expect(status.stdout.trim()).toBe("");
      expect(channel.notices.some((entry) => entry.text.includes("git commit: committed"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("git changed files:"))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses configured git author identity for autodev commits", async () => {
    const previousAuthorName = process.env.AUTODEV_GIT_AUTHOR_NAME;
    const previousAuthorEmail = process.env.AUTODEV_GIT_AUTHOR_EMAIL;
    process.env.AUTODEV_GIT_AUTHOR_NAME = "CodeHarbor CI Bot";
    process.env.AUTODEV_GIT_AUTHOR_EMAIL = "ci-bot@example.com";

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-author-"));
    const requirementsPath = path.join(tempRoot, "REQUIREMENTS.md");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(requirementsPath, "# Requirements\n- implement T10.2\n", "utf8");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 预估时间 | 优先级 | 依赖 | 状态 |",
        "|--------|----------|----------|--------|------|------|",
        "| T10.2 | 自定义作者验证 | 1h | P0 | - | ⬜ |",
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
          eventId: "$autodev-run-commit-custom-author",
        }),
      );

      const authorInfo = await execFileAsync("git", ["log", "--pretty=%an%n%ae", "-n", "1"], { cwd: tempRoot });
      expect(authorInfo.stdout).toContain("CodeHarbor CI Bot");
      expect(authorInfo.stdout).toContain("ci-bot@example.com");
    } finally {
      if (previousAuthorName === undefined) {
        delete process.env.AUTODEV_GIT_AUTHOR_NAME;
      } else {
        process.env.AUTODEV_GIT_AUTHOR_NAME = previousAuthorName;
      }
      if (previousAuthorEmail === undefined) {
        delete process.env.AUTODEV_GIT_AUTHOR_EMAIL;
      } else {
        process.env.AUTODEV_GIT_AUTHOR_EMAIL = previousAuthorEmail;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates release commit for mapped big-feature task after autodev completion", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-release-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Requirements\n- implement T8.1\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T8.1 | big feature one | ⬜ |",
        "",
        "## 大功能 -> 发布映射（执行约定）",
        "| 大功能任务 | 完成后目标版本 | 发布提交示例 |",
        "|------------|----------------|--------------|",
        "| T8.1 | v0.1.52 | `release: v0.1.52 [publish-npm]` |",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify(
        {
          name: "codeharbor-release-test",
          version: "0.1.51",
          private: true,
          scripts: {
            "test:coverage": "node -e \"process.exit(0)\"",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "package-lock.json"),
      JSON.stringify(
        {
          name: "codeharbor-release-test",
          version: "0.1.51",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "codeharbor-release-test",
              version: "0.1.51",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "CHANGELOG.md"),
      ["# Changelog", "", "## [Unreleased]", "", "- (none yet)", ""].join("\n"),
      "utf8",
    );

    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await execFileAsync("git", ["add", "-A"], { cwd: tempRoot });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "commit", "-m", "chore: init release test"],
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
          text: "/autodev run T8.1",
          eventId: "$autodev-run-release",
        }),
      );

      const latest = await execFileAsync("git", ["log", "--oneline", "-n", "1"], { cwd: tempRoot });
      expect(latest.stdout).toContain("release: v0.1.52 [publish-npm]");
      const packageJson = JSON.parse(await fs.readFile(path.join(tempRoot, "package.json"), "utf8")) as { version: string };
      expect(packageJson.version).toBe("0.1.52");
      const changelog = await fs.readFile(path.join(tempRoot, "CHANGELOG.md"), "utf8");
      expect(changelog).toContain("## [0.1.52] -");
      expect(changelog).toContain("AutoDev feature delivered: T8.1");
      expect(channel.notices.some((entry) => entry.text.includes("release: released v0.1.52"))).toBe(true);
      const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: tempRoot });
      expect(status.stdout.trim()).toBe("");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses release mapping section when non-release milestone table has conflicting versions", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-release-mapping-section-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Requirements\n- implement T8.1\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T8.1 | big feature one | ⬜ |",
        "",
        "## 大功能 -> 发布映射（执行约定）",
        "| 大功能任务 | 完成后目标版本 | 发布提交示例 |",
        "|------------|----------------|--------------|",
        "| T8.1 | v0.1.52 | `release: v0.1.52 [publish-npm]` |",
        "",
        "## 社区优先级 -> 可执行里程碑（排序参考，不用于自动发布）",
        "| 任务ID | 社区讨论目标版本 | 说明 |",
        "|--------|------------------|------|",
        "| T8.1 | v0.9.99 | should be ignored by auto release parser |",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify(
        {
          name: "codeharbor-release-test",
          version: "0.1.51",
          private: true,
          scripts: {
            "test:coverage": "node -e \"process.exit(0)\"",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "package-lock.json"),
      JSON.stringify(
        {
          name: "codeharbor-release-test",
          version: "0.1.51",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "codeharbor-release-test",
              version: "0.1.51",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "CHANGELOG.md"),
      ["# Changelog", "", "## [Unreleased]", "", "- (none yet)", ""].join("\n"),
      "utf8",
    );

    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await execFileAsync("git", ["add", "-A"], { cwd: tempRoot });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "commit", "-m", "chore: init release test"],
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
          text: "/autodev run T8.1",
          eventId: "$autodev-run-release-mapping-section",
        }),
      );

      const latest = await execFileAsync("git", ["log", "--oneline", "-n", "1"], { cwd: tempRoot });
      expect(latest.stdout).toContain("release: v0.1.52 [publish-npm]");
      const packageJson = JSON.parse(await fs.readFile(path.join(tempRoot, "package.json"), "utf8")) as { version: string };
      expect(packageJson.version).toBe("0.1.52");
      expect(channel.notices.some((entry) => entry.text.includes("release: released v0.1.52"))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks autodev release commit when test:coverage precheck fails", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-release-precheck-fail-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Requirements\n- implement T8.1\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T8.1 | big feature one | ⬜ |",
        "",
        "## 大功能 -> 发布映射（执行约定）",
        "| 大功能任务 | 完成后目标版本 | 发布提交示例 |",
        "|------------|----------------|--------------|",
        "| T8.1 | v0.1.52 | `release: v0.1.52 [publish-npm]` |",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify(
        {
          name: "codeharbor-release-test",
          version: "0.1.51",
          private: true,
          scripts: {
            "test:coverage": "node -e \"process.exit(1)\"",
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "package-lock.json"),
      JSON.stringify(
        {
          name: "codeharbor-release-test",
          version: "0.1.51",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "codeharbor-release-test",
              version: "0.1.51",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "CHANGELOG.md"),
      ["# Changelog", "", "## [Unreleased]", "", "- (none yet)", ""].join("\n"),
      "utf8",
    );

    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await execFileAsync("git", ["add", "-A"], { cwd: tempRoot });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "commit", "-m", "chore: init release test"],
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
          text: "/autodev run T8.1",
          eventId: "$autodev-run-release-precheck-fail",
        }),
      );

      const latest = await execFileAsync("git", ["log", "--oneline", "-n", "1"], { cwd: tempRoot });
      expect(latest.stdout).toMatch(/(feat|fix|docs|test|chore)\([a-z0-9-]+\): .* \(T8\.1\)/);
      expect(latest.stdout).not.toContain("release: v0.1.52 [publish-npm]");

      const packageJson = JSON.parse(await fs.readFile(path.join(tempRoot, "package.json"), "utf8")) as { version: string };
      expect(packageJson.version).toBe("0.1.51");

      const changelog = await fs.readFile(path.join(tempRoot, "CHANGELOG.md"), "utf8");
      expect(changelog).not.toContain("## [0.1.52] -");
      expect(channel.notices.some((entry) => entry.text.includes("release: failed (release precheck failed: npm run test:coverage"))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips autodev release when auto-release is disabled", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-release-disabled-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Requirements\n- implement T8.1\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T8.1 | big feature one | ⬜ |",
        "",
        "## 大功能 -> 发布映射（执行约定）",
        "| 大功能任务 | 完成后目标版本 | 发布提交示例 |",
        "|------------|----------------|--------------|",
        "| T8.1 | v0.1.52 | `release: v0.1.52 [publish-npm]` |",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify(
        {
          name: "codeharbor-release-test",
          version: "0.1.51",
          private: true,
        },
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "package-lock.json"),
      JSON.stringify(
        {
          name: "codeharbor-release-test",
          version: "0.1.51",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "codeharbor-release-test",
              version: "0.1.51",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await execFileAsync("git", ["add", "-A"], { cwd: tempRoot });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "commit", "-m", "chore: init release test"],
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
        autoDevAutoReleaseEnabled: false,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T8.1",
          eventId: "$autodev-run-release-disabled",
        }),
      );

      const latest = await execFileAsync("git", ["log", "--oneline", "-n", "1"], { cwd: tempRoot });
      expect(latest.stdout).toMatch(/(feat|fix|docs|test|chore)\([a-z0-9-]+\): .* \(T8\.1\)/);
      const packageJson = JSON.parse(await fs.readFile(path.join(tempRoot, "package.json"), "utf8")) as { version: string };
      expect(packageJson.version).toBe("0.1.51");
      expect(channel.notices.some((entry) => entry.text.includes("AUTODEV_AUTO_RELEASE_ENABLED=false"))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("removes shell-style stage artifact files before autodev auto-commit", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-artifact-cleanup-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Requirements\n- implement T10.2\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T10.2 | artifact cleanup | ⬜ |",
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
      const executor = new ArtifactWorkflowExecutor();
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
          text: "/autodev run T10.2",
          eventId: "$autodev-run-artifact-cleanup",
        }),
      );

      const latestFiles = await execFileAsync("git", ["show", "--name-only", "--pretty=format:", "-n", "1"], { cwd: tempRoot });
      expect(latestFiles.stdout).not.toContain("autodev#0");
      expect(latestFiles.stdout).not.toContain("workflow#0");
      expect(latestFiles.stdout).not.toContain("planner#0");
      expect(latestFiles.stdout).not.toContain("executor#0");
      expect(latestFiles.stdout).not.toContain("reviewer#0");

      for (const file of ["autodev#0", "workflow#0", "planner#0", "executor#0", "reviewer#0"]) {
        const exists = await fs
          .stat(path.join(tempRoot, file))
          .then(() => true)
          .catch(() => false);
        expect(exists).toBe(false);
      }
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

  it("marks autodev task blocked after repeated same validation failure class", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-validation-fuse-"));
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T14.2 | validation fuse task | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const repeatedValidationFailureExecutor = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-planner",
              reply: "1) plan",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-executor",
              reply: "VALIDATION: tests failed in gateway suite",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-thread-reviewer",
              reply: "VERDICT: APPROVED\nSUMMARY: reviewer approved",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "wf-thread-default",
            reply: "ok",
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(
        channel,
        repeatedValidationFailureExecutor as never,
        store as never,
        logger as never,
        {
          commandPrefix: "!code",
          matrixUserId: "@bot:example.com",
          progressUpdatesEnabled: false,
          outputLanguage: "en",
          defaultCodexWorkdir: tempRoot,
          autoDevMaxConsecutiveFailures: 2,
          multiAgentWorkflow: {
            enabled: true,
            autoRepairMaxRounds: 0,
          },
        },
      );

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T14.2",
          eventId: "$autodev-run-validation-fuse-1",
        }),
      );
      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T14.2",
          eventId: "$autodev-run-validation-fuse-2",
        }),
      );

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T14.2 | validation fuse task | 🚫 |");
      expect(channel.notices.some((entry) => entry.text.includes("validation fuse"))).toBe(true);
      const runtime = orchestrator.getRuntimeMetricsSnapshot();
      expect(runtime.autodev.tasksBlocked).toBe(1);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips git preflight auto-stash when /autodev run has no executable tasks", async () => {
    const previous = process.env.AUTODEV_PREFLIGHT_AUTO_STASH;
    process.env.AUTODEV_PREFLIGHT_AUTO_STASH = "true";

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-loop-no-task-preflight-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    const completedTaskList = [
      "| 任务ID | 任务描述 | 状态 |",
      "|--------|----------|------|",
      "| T16.12 | no executable loop task | ✅ |",
    ].join("\n");
    await fs.writeFile(taskListPath, completedTaskList, "utf8");

    await execFileAsync("git", ["init"], { cwd: tempRoot });
    await execFileAsync("git", ["add", "-A"], { cwd: tempRoot });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "commit", "-m", "chore: init"],
      { cwd: tempRoot },
    );
    await fs.writeFile(path.join(tempRoot, "DIRTY_NO_TASK.md"), "dirty\n", "utf8");

    try {
      const secondChannel = new FakeChannel();
      const store = new FakeStateStore();
      const second = new Orchestrator(secondChannel, new WorkflowExecutor() as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        outputLanguage: "en",
        autoDevAutoCommit: true,
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await second.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run",
          eventId: "$autodev-run-loop-no-task-preflight",
        }),
      );

      expect(secondChannel.notices.some((entry) => entry.text.includes("No executable tasks (pending/in_progress)."))).toBe(true);
      expect(secondChannel.notices.some((entry) => entry.text.includes("dirty worktree auto-stashed; continuing run"))).toBe(
        false,
      );
      const stashList = (await execFileAsync("git", ["stash", "list"], { cwd: tempRoot })).stdout;
      expect(stashList).not.toContain("codeharbor autodev preflight auto-stash");
    } finally {
      if (previous === undefined) {
        delete process.env.AUTODEV_PREFLIGHT_AUTO_STASH;
      } else {
        process.env.AUTODEV_PREFLIGHT_AUTO_STASH = previous;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports /autodev status with task summary and current task", async () => {
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

      const statusNotice = channel.notices.find((entry) => entry.text.includes("AutoDev 状态"))?.text ?? "";
      expect(statusNotice).toContain("AutoDev 状态");
      expect(statusNotice).toContain("currentTask: N/A");
      expect(statusNotice).toContain("gitPreflight: no_repo");
      expect(statusNotice).toContain("runWindow: startedAt=N/A, endedAt=N/A, duration=N/A");
      expect(statusNotice).toContain("runControl: loopActive=no, loopStopRequested=no, stopRequested=no");
      expect(statusNotice).toContain("workflowDiag: runId=N/A");
      expect(statusNotice).toContain("stageTrace:");
      expect(statusNotice).toContain("- (empty)");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists autodev run archive file after /autodev run", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-archive-run-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T1.4 | archive run task | ⬜ |",
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
        autoDevRunArchiveEnabled: true,
        autoDevRunArchiveDir: ".codeharbor/autodev-runs-test",
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T1.4",
          eventId: "$autodev-run-archive",
        }),
      );

      const archiveRoot = path.join(tempRoot, ".codeharbor", "autodev-runs-test");
      const dateDirs = await fs.readdir(archiveRoot);
      expect(dateDirs.length).toBeGreaterThan(0);
      const files = await fs.readdir(path.join(archiveRoot, dateDirs[0]));
      const jsonFiles = files.filter((name) => name.endsWith(".json"));
      expect(jsonFiles.length).toBeGreaterThan(0);

      const payload = JSON.parse(
        await fs.readFile(path.join(archiveRoot, dateDirs[0], jsonFiles[0]), "utf8"),
      ) as {
        task: { id: string };
        workflowResult: { output: string };
        status: string;
      };
      expect(payload.task.id).toBe("T1.4");
      expect(payload.status).toBe("succeeded");
      expect(typeof payload.workflowResult.output).toBe("string");
      expect(payload.workflowResult.output.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("shows auto-release push warning in /autodev status when auto push is disabled", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-status-release-warning-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T1.3 | release warning task | ⬜ |",
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
        autoDevAutoReleaseEnabled: true,
        autoDevAutoReleasePush: false,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev status",
          eventId: "$autodev-status-release-warning",
        }),
      );

      const statusNotice = channel.notices.find((entry) => entry.text.includes("AutoDev 状态"))?.text ?? "";
      expect(statusNotice).toContain("warning: autoRelease=on 但 autoReleasePush=off");
      expect(statusNotice).toContain("git push");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports /autodev status with workflow stage trace details", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-status-trace-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Req\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T1.2 | trace task | ⬜ |",
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
          text: "/autodev run T1.2",
          eventId: "$autodev-status-run",
        }),
      );
      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev status",
          eventId: "$autodev-status-after-run",
        }),
      );

      const statusNotice = [...channel.notices]
        .reverse()
        .find((entry) => entry.text.includes("AutoDev 状态"))?.text ?? "";
      expect(statusNotice).toContain("workflowDiag: runId=");
      expect(statusNotice).toContain("status=succeeded");
      expect(statusNotice).toContain("workflowStage: stage=");
      expect(statusNotice).toContain("stageTrace:");
      expect(statusNotice).toContain("stage=planner");
      expect(statusNotice).toContain("stage=executor");
      expect(statusNotice).toContain("stage=reviewer");
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

    expect(executor.callCount).toBeGreaterThanOrEqual(4);
    expect(channel.sent.some((entry) => entry.text.includes("多智能体流程完成"))).toBe(true);
    expect(channel.sent.some((entry) => entry.text.includes("[planner]"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("state: succeeded"))).toBe(true);
  });

  it("emits detailed workflow progress notices with agent and stage execution details", async () => {
    const channel = new FakeChannel();
    const executor = new WorkflowExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: true,
      packageUpdateChecker: {
        getStatus: async () => ({
          packageName: "codeharbor",
          currentVersion: "0.1.48",
          latestVersion: "0.1.48",
          state: "up_to_date",
          checkedAt: "2026-03-19T00:00:00.000Z",
          error: null,
          upgradeCommand: "npm install -g codeharbor@latest",
        }),
      },
      multiAgentWorkflow: {
        enabled: true,
        autoRepairMaxRounds: 1,
      },
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/agents run 输出详细进度",
        eventId: "$wf-progress-detail",
      }),
    );

    expect(channel.notices.some((entry) => entry.text.includes("[PLANNER] 代理=planner，轮次=1"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("规划代理执行完成"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("[EXECUTOR] 代理=executor，轮次=1"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("[REVIEWER] 代理=reviewer，轮次=1"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("verdict=REJECTED"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("审查代理契约补全启动"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("审查代理契约补全完成"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("多智能体流程完成"))).toBe(true);
  });

  it("supports /autodev progress off and switches workflow progress to concise mode", async () => {
    const channel = new FakeChannel();
    const executor = new WorkflowExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: true,
      packageUpdateChecker: {
        getStatus: async () => ({
          packageName: "codeharbor",
          currentVersion: "0.1.48",
          latestVersion: "0.1.48",
          state: "up_to_date",
          checkedAt: "2026-03-19T00:00:00.000Z",
          error: null,
          upgradeCommand: "npm install -g codeharbor@latest",
        }),
      },
      multiAgentWorkflow: {
        enabled: true,
        autoRepairMaxRounds: 1,
      },
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/autodev progress off",
        eventId: "$autodev-progress-off",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/autodev status",
        eventId: "$autodev-status-after-progress-off",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/agents run 验证简洁进度回显",
        eventId: "$wf-progress-compact",
      }),
    );

    expect(channel.notices.some((entry) => entry.text.includes("AutoDev 过程回显已更新"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("detailedProgress: off"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("[PLANNER] 轮次=1"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("[PLANNER] 代理=planner"))).toBe(false);
    expect(channel.notices.some((entry) => entry.text.includes("timeout="))).toBe(false);
  });

  it("emits autodev workflow progress as timeline notices in group chats when detailed progress is enabled", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-group-timeline-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Requirements\n- timeline progress\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T8.1 | group progress timeline | ⬜ |",
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
        progressUpdatesEnabled: true,
        progressMinIntervalMs: 0,
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: false,
          mentionsBot: true,
          text: "@bot:example.com /autodev run T8.1",
          eventId: "$autodev-group-progress-timeline",
        }),
      );

      expect(channel.notices.some((entry) => entry.text.includes("多智能体流程启动"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("[PLANNER]"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("多智能体流程完成"))).toBe(true);
      expect(channel.upserts).toHaveLength(0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("echoes autodev stage outputs by default and supports /autodev content off", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-content-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Requirements\n- deliver T4.x\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T4.1 | stage content echo on | ⬜ |",
        "| T4.2 | stage content echo off | ⬜ |",
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
        progressUpdatesEnabled: true,
        defaultCodexWorkdir: tempRoot,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 1,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T4.1",
          eventId: "$autodev-content-on",
        }),
      );

      const stageOutputNoticesAfterOn = channel.notices.filter(
        (entry) => entry.text.includes("阶段产出") && entry.text.includes("planner_output"),
      );
      expect(stageOutputNoticesAfterOn.length).toBeGreaterThanOrEqual(1);
      expect(channel.notices.some((entry) => entry.text.includes("executor_output"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("reviewer_output"))).toBe(true);
      const beforeOffCount = channel.notices.filter((entry) => entry.text.includes("阶段产出")).length;

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev content off",
          eventId: "$autodev-content-off",
        }),
      );
      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T4.2",
          eventId: "$autodev-content-off-run",
        }),
      );

      expect(channel.notices.some((entry) => entry.text.includes("AutoDev 阶段内容回显已更新"))).toBe(true);
      const afterOffCount = channel.notices.filter((entry) => entry.text.includes("阶段产出")).length;
      expect(afterOffCount).toBe(beforeOffCount);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("switches command and workflow progress text to english when outputLanguage=en", async () => {
    const channel = new FakeChannel();
    const executor = new WorkflowExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: true,
      outputLanguage: "en",
      packageUpdateChecker: {
        getStatus: async () => ({
          packageName: "codeharbor",
          currentVersion: "0.1.56",
          latestVersion: "0.1.56",
          state: "up_to_date",
          checkedAt: "2026-03-22T00:00:00.000Z",
          error: null,
          upgradeCommand: "npm install -g codeharbor@latest",
        }),
      },
      multiAgentWorkflow: {
        enabled: true,
        autoRepairMaxRounds: 0,
      },
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/help",
        eventId: "$help-en",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/agents run produce english progress",
        eventId: "$workflow-en",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/backend status",
        eventId: "$backend-en",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/diag version",
        eventId: "$diag-en",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/agents status",
        eventId: "$agents-status-en",
      }),
    );

    expect(channel.notices.some((entry) => entry.text.includes("Available commands"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("Multi-Agent workflow started"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("Planner started plan generation"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("Current backend tool:"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("Diagnosis (version)"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("Multi-Agent workflow status"))).toBe(true);
  });

  it("keeps core english command and autodev status notices free from CJK text", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-i18n-en-"));
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Requirements\n\n## Scope\n- English only\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "TASK_LIST.md"),
      [
        "| Task ID | Task Description | Status |",
        "|---------|-------------------|--------|",
        "| T1.1 | English i18n consistency task | ⬜ |",
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
        outputLanguage: "en",
        defaultCodexWorkdir: tempRoot,
        packageUpdateChecker: {
          getStatus: async () => ({
            packageName: "codeharbor",
            currentVersion: "0.1.64",
            latestVersion: "0.1.64",
            state: "up_to_date",
            checkedAt: "2026-03-24T00:00:00.000Z",
            error: null,
            upgradeCommand: "npm install -g codeharbor@latest",
          }),
        },
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/help",
          eventId: "$help-en-cjk-check",
        }),
      );
      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/status",
          eventId: "$status-en-cjk-check",
        }),
      );
      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T1.1",
          eventId: "$autodev-run-en-cjk-check",
        }),
      );
      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev status",
          eventId: "$autodev-status-en-cjk-check",
        }),
      );

      const cjkPattern = /[\u3400-\u9FFF]/;
      const helpNotice = channel.notices.find((entry) => entry.text.includes("Available commands"))?.text ?? "";
      const statusNotice = channel.notices.find((entry) => entry.text.includes("Current status"))?.text ?? "";
      const autoDevStatusNotice = [...channel.notices]
        .reverse()
        .find((entry) => entry.text.includes("[CodeHarbor] AutoDev status"))?.text ?? "";

      expect(helpNotice).not.toMatch(cjkPattern);
      expect(statusNotice).not.toMatch(cjkPattern);
      expect(autoDevStatusNotice).not.toMatch(cjkPattern);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("covers init -> status -> run for sibling, subdir, and empty repo targets", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-init-e2e-"));
    const roomWorkdir = path.join(workspaceRoot, "CodeHarbor");
    await fs.mkdir(roomWorkdir, { recursive: true });

    const scenarios = [
      { name: "sibling", arg: "StrawBerry", targetWorkdir: path.join(workspaceRoot, "StrawBerry") },
      { name: "subdir", arg: "apps/strawberry", targetWorkdir: path.join(roomWorkdir, "apps", "strawberry") },
      { name: "empty", arg: path.join(workspaceRoot, "empty-repo"), targetWorkdir: path.join(workspaceRoot, "empty-repo") },
    ];

    try {
      for (const scenario of scenarios) {
        await fs.mkdir(scenario.targetWorkdir, { recursive: true });

        const channel = new FakeChannel();
        const executor = new WorkflowExecutor();
        const store = new FakeStateStore();
        const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
          commandPrefix: "!code",
          matrixUserId: "@bot:example.com",
          progressUpdatesEnabled: false,
          outputLanguage: "en",
          defaultCodexWorkdir: roomWorkdir,
          multiAgentWorkflow: {
            enabled: true,
            autoRepairMaxRounds: 0,
          },
        });

        await orchestrator.handleMessage(
          makeInbound({
            isDirectMessage: true,
            text: `/autodev init ${scenario.arg}`,
            eventId: `$autodev-init-e2e-${scenario.name}`,
          }),
        );
        const initNotice = [...channel.notices]
          .reverse()
          .find((entry) => entry.text.includes("AutoDev task compass is ready"))?.text ?? "";
        expect(initNotice).toContain(`targetWorkdir: ${scenario.targetWorkdir}`);

        await orchestrator.handleMessage(
          makeInbound({
            isDirectMessage: true,
            text: "/autodev status",
            eventId: `$autodev-status-e2e-${scenario.name}`,
          }),
        );
        const statusNotice = [...channel.notices]
          .reverse()
          .find((entry) => entry.text.includes("[CodeHarbor] AutoDev status"))?.text ?? "";
        expect(statusNotice).toContain(`workdir: ${scenario.targetWorkdir}`);
        expect(statusNotice).toContain("pending=");

        await orchestrator.handleMessage(
          makeInbound({
            isDirectMessage: true,
            text: "/autodev run",
            eventId: `$autodev-run-e2e-${scenario.name}`,
          }),
        );
        expect(channel.notices.some((entry) => entry.text.includes("No executable tasks"))).toBe(false);
        const resultNotice = [...channel.notices]
          .reverse()
          .find((entry) => entry.text.includes("AutoDev task result"))?.text ?? "";
        expect(resultNotice).toContain("task status:");

        const taskListRaw = await fs.readFile(path.join(scenario.targetWorkdir, "TASK_LIST.md"), "utf8");
        expect(taskListRaw).toContain("T0.1");
      }
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("injects completed autodev runtime context into follow-up chat prompts", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-orch-autodev-followup-context-"));
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(path.join(tempRoot, "REQUIREMENTS.md"), "# Requirements\n\n## Scope\n- follow-up prompt context\n", "utf8");
    await fs.writeFile(
      taskListPath,
      [
        "| Task ID | Task Description | Status |",
        "|---------|-------------------|--------|",
        "| T6.5 | follow-up context sync | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    const promptCalls: string[] = [];
    const deterministicWorkflowExecutor = {
      startExecution: (
        text: string,
        sessionId: string | null,
      ): { result: Promise<{ sessionId: string; reply: string }>; cancel: () => void } => {
        promptCalls.push(text);
        if (text.includes("[role:planner]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-planner",
              reply: "1) implement\n2) verify\n3) deliver",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:executor]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-executor",
              reply: "VALIDATION_STATUS: PASS\n__EXIT_CODES__ unit=0",
            }),
            cancel: () => {},
          };
        }
        if (text.includes("[role:reviewer]")) {
          return {
            result: Promise.resolve({
              sessionId: sessionId ?? "wf-reviewer",
              reply: "VERDICT: APPROVED\nSUMMARY: approved",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: sessionId ?? "chat-session",
            reply: `ok:${text}`,
          }),
          cancel: () => {},
        };
      },
    };

    try {
      const channel = new FakeChannel();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(
        channel,
        deterministicWorkflowExecutor as never,
        store as never,
        logger as never,
        {
          commandPrefix: "!code",
          matrixUserId: "@bot:example.com",
          progressUpdatesEnabled: false,
          outputLanguage: "en",
          defaultCodexWorkdir: tempRoot,
          autoDevAutoCommit: false,
          multiAgentWorkflow: {
            enabled: true,
            autoRepairMaxRounds: 0,
          },
        },
      );

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/autodev run T6.5",
          eventId: "$autodev-followup-context-run",
        }),
      );
      const updatedTaskList = await fs.readFile(taskListPath, "utf8");
      expect(updatedTaskList).toContain("| T6.5 | follow-up context sync | ✅ |");

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "Any follow-up actions?",
          eventId: "$autodev-followup-context-chat",
        }),
      );

      const followUpPrompt = [...promptCalls].reverse().find((entry) => entry.includes("Any follow-up actions?")) ?? "";
      expect(followUpPrompt).toContain("[autodev_runtime]");
      expect(followUpPrompt).toContain("status=completed");
      expect(followUpPrompt).toContain("nextTask=N/A");
      expect(followUpPrompt).toContain("Do not suggest rerunning completed tasks");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("supports /autodev skills mode switch and injects role skills into workflow prompts", async () => {
    const channel = new FakeChannel();
    const executor = new WorkflowExecutor();
    const store = new FakeStateStore();
    const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
      commandPrefix: "!code",
      matrixUserId: "@bot:example.com",
      progressUpdatesEnabled: false,
      multiAgentWorkflow: {
        enabled: true,
        autoRepairMaxRounds: 0,
      },
    });

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/autodev skills full",
        eventId: "$autodev-skills-full",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/autodev status",
        eventId: "$autodev-status-after-skills-full",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/agents run 验证角色技能注入",
        eventId: "$wf-role-skills-full",
      }),
    );

    expect(channel.notices.some((entry) => entry.text.includes("AutoDev 角色技能设置"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("mode: full"))).toBe(true);
    expect(channel.notices.some((entry) => entry.text.includes("roleSkills: enabled=on, mode=full"))).toBe(true);

    const plannerPromptWithSkills = executor.calls.find((call) => call.text.includes("[role:planner]"))?.text ?? "";
    expect(plannerPromptWithSkills).toContain("[role_skills]");
    expect(plannerPromptWithSkills).toContain("disclosure=full");

    executor.calls.length = 0;

    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/autodev skills off",
        eventId: "$autodev-skills-off",
      }),
    );
    await orchestrator.handleMessage(
      makeInbound({
        isDirectMessage: true,
        text: "/agents run 验证关闭角色技能",
        eventId: "$wf-role-skills-off",
      }),
    );

    const plannerPromptWithoutSkills = executor.calls.find((call) => call.text.includes("[role:planner]"))?.text ?? "";
    expect(plannerPromptWithoutSkills).not.toContain("[role_skills]");
  });

  it("applies AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS when assembling reviewer prompt", async () => {
    const previous = process.env.AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS;
    process.env.AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS = "1200";

    try {
      const channel = new FakeChannel();
      const executor = new LargeContextWorkflowExecutor();
      const store = new FakeStateStore();
      const orchestrator = new Orchestrator(channel, executor as never, store as never, logger as never, {
        commandPrefix: "!code",
        matrixUserId: "@bot:example.com",
        progressUpdatesEnabled: false,
        multiAgentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 0,
        },
      });

      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/agents run 输出超长上下文以测试预算",
          eventId: "$wf-context-budget",
        }),
      );
      await orchestrator.handleMessage(
        makeInbound({
          isDirectMessage: true,
          text: "/status",
          eventId: "$wf-context-budget-status",
        }),
      );

      const reviewerPrompt = executor.calls.find((call) => call.text.includes("[role:reviewer]"))?.text ?? "";
      expect(reviewerPrompt).toContain("executor_output truncated");
      expect(reviewerPrompt.length).toBeLessThan(3_200);
      expect(channel.notices.some((entry) => entry.text.includes("Multi-Agent context:"))).toBe(true);
      expect(channel.notices.some((entry) => entry.text.includes("output=1200"))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS;
      } else {
        process.env.AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS = previous;
      }
    }
  });
});
