import { Mutex } from "async-mutex";

import { MatrixChannel } from "./channels/matrix-channel";
import { CodexExecutor, type CodexProgressEvent } from "./executor/codex-executor";
import { Logger } from "./logger";
import { StateStore } from "./store/state-store";
import { InboundMessage } from "./types";
import { extractCommandText } from "./utils/message";

interface OrchestratorOptions {
  lockTtlMs?: number;
  lockPruneIntervalMs?: number;
  progressUpdatesEnabled?: boolean;
  progressMinIntervalMs?: number;
  typingTimeoutMs?: number;
  commandPrefix?: string;
  matrixUserId?: string;
  sessionActiveWindowMinutes?: number;
}

interface SessionLockEntry {
  mutex: Mutex;
  lastUsedAt: number;
}

type RouteDecision =
  | { kind: "ignore" }
  | { kind: "execute"; prompt: string }
  | { kind: "command"; command: "status" | "stop" | "reset" };

export class Orchestrator {
  private readonly channel: MatrixChannel;
  private readonly executor: CodexExecutor;
  private readonly stateStore: StateStore;
  private readonly logger: Logger;
  private readonly sessionLocks = new Map<string, SessionLockEntry>();
  private readonly lockTtlMs: number;
  private readonly lockPruneIntervalMs: number;
  private readonly progressUpdatesEnabled: boolean;
  private readonly progressMinIntervalMs: number;
  private readonly typingTimeoutMs: number;
  private readonly commandPrefix: string;
  private readonly matrixUserId: string;
  private readonly sessionActiveWindowMs: number;
  private lastLockPruneAt = 0;

  constructor(
    channel: MatrixChannel,
    executor: CodexExecutor,
    stateStore: StateStore,
    logger: Logger,
    options?: OrchestratorOptions,
  ) {
    this.channel = channel;
    this.executor = executor;
    this.stateStore = stateStore;
    this.logger = logger;
    this.lockTtlMs = options?.lockTtlMs ?? 30 * 60 * 1000;
    this.lockPruneIntervalMs = options?.lockPruneIntervalMs ?? 5 * 60 * 1000;
    this.progressUpdatesEnabled = options?.progressUpdatesEnabled ?? false;
    this.progressMinIntervalMs = options?.progressMinIntervalMs ?? 2_500;
    this.typingTimeoutMs = options?.typingTimeoutMs ?? 10_000;
    this.commandPrefix = (options?.commandPrefix ?? "").trim();
    this.matrixUserId = options?.matrixUserId ?? "";
    const sessionActiveWindowMinutes = options?.sessionActiveWindowMinutes ?? 20;
    this.sessionActiveWindowMs = Math.max(1, sessionActiveWindowMinutes) * 60_000;
  }

  async handleMessage(message: InboundMessage): Promise<void> {
    const sessionKey = buildSessionKey(message);
    const lock = this.getLock(sessionKey);

    await lock.runExclusive(async () => {
      if (this.stateStore.hasProcessedEvent(sessionKey, message.eventId)) {
        this.logger.debug("Duplicate event ignored", { eventId: message.eventId });
        return;
      }

      const route = this.routeMessage(message, sessionKey);
      if (route.kind === "ignore") {
        return;
      }

      if (route.kind === "command") {
        await this.handleControlCommand(route.command, sessionKey, message);
        this.stateStore.markEventProcessed(sessionKey, message.eventId);
        return;
      }

      this.stateStore.activateSession(sessionKey, this.sessionActiveWindowMs);
      const previousCodexSessionId = this.stateStore.getCodexSessionId(sessionKey);
      this.logger.info("Processing message", {
        sessionKey,
        hasCodexSession: Boolean(previousCodexSessionId),
        isDirectMessage: message.isDirectMessage,
        mentionsBot: message.mentionsBot,
        repliesToBot: message.repliesToBot,
      });

      const stopTyping = this.startTypingHeartbeat(message.conversationId);
      let lastProgressAt = 0;
      let lastProgressText = "";

      try {
        const result = await this.executor.execute(route.prompt, previousCodexSessionId, (progress) => {
          void this.handleProgress(
            message.conversationId,
            progress,
            () => lastProgressAt,
            (next) => {
              lastProgressAt = next;
            },
            () => lastProgressText,
            (next) => {
              lastProgressText = next;
            },
          );
        });

        if (!previousCodexSessionId || previousCodexSessionId !== result.sessionId) {
          this.stateStore.setCodexSessionId(sessionKey, result.sessionId);
        }
        await this.channel.sendMessage(message.conversationId, result.reply);
        this.stateStore.markEventProcessed(sessionKey, message.eventId);
      } catch (error) {
        this.logger.error("Failed to execute codex request", error);
        try {
          await this.channel.sendMessage(
            message.conversationId,
            `[CodeHarbor] Failed to process request: ${formatError(error)}`,
          );
        } catch (sendError) {
          this.logger.error("Failed to send error reply to Matrix", sendError);
        }
      } finally {
        await stopTyping();
      }
    });
  }

  private routeMessage(message: InboundMessage, sessionKey: string): RouteDecision {
    const incoming = message.text.trim();
    if (!incoming) {
      return { kind: "ignore" };
    }

    const prefixTriggered = this.commandPrefix.length > 0;
    const prefixedText = prefixTriggered ? extractCommandText(incoming, this.commandPrefix) : null;
    const activeSession = this.stateStore.isSessionActive(sessionKey);
    const conversationalTrigger =
      message.isDirectMessage || message.mentionsBot || message.repliesToBot || activeSession;

    if (!conversationalTrigger && prefixedText === null) {
      return { kind: "ignore" };
    }

    let normalized = prefixedText ?? incoming;
    if (prefixedText === null && message.mentionsBot) {
      normalized = stripLeadingBotMention(normalized, this.matrixUserId);
    }
    normalized = normalized.trim();
    if (!normalized) {
      return { kind: "ignore" };
    }

    const command = parseControlCommand(normalized);
    if (command) {
      return { kind: "command", command };
    }
    return { kind: "execute", prompt: normalized };
  }

  private async handleControlCommand(command: "status" | "stop" | "reset", sessionKey: string, message: InboundMessage): Promise<void> {
    if (command === "stop") {
      this.stateStore.deactivateSession(sessionKey);
      this.stateStore.clearCodexSessionId(sessionKey);
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 会话已停止。后续在群聊中请提及/回复我，或在私聊直接发送消息。",
      );
      return;
    }

    if (command === "reset") {
      this.stateStore.clearCodexSessionId(sessionKey);
      this.stateStore.activateSession(sessionKey, this.sessionActiveWindowMs);
      await this.channel.sendNotice(
        message.conversationId,
        "[CodeHarbor] 上下文已重置。你可以继续直接发送新需求。",
      );
      return;
    }

    const status = this.stateStore.getSessionStatus(sessionKey);
    const scope = message.isDirectMessage ? "私聊（免前缀）" : "群聊（提及/回复/激活窗口触发）";
    const activeUntil = status.activeUntil ?? "未激活";
    await this.channel.sendNotice(
      message.conversationId,
      `[CodeHarbor] 当前状态\n- 会话类型: ${scope}\n- 激活中: ${
        status.isActive ? "是" : "否"
      }\n- activeUntil: ${activeUntil}\n- 已绑定 Codex 会话: ${status.hasCodexSession ? "是" : "否"}`,
    );
  }

  private startTypingHeartbeat(conversationId: string): () => Promise<void> {
    let stopped = false;
    const refreshIntervalMs = Math.max(1_000, Math.floor(this.typingTimeoutMs / 2));

    const sendTyping = async (isTyping: boolean): Promise<void> => {
      try {
        await this.channel.setTyping(conversationId, isTyping, isTyping ? this.typingTimeoutMs : 0);
      } catch (error) {
        this.logger.debug("Failed to update typing state", { conversationId, isTyping, error });
      }
    };

    void sendTyping(true);
    const timer = setInterval(() => {
      if (stopped) {
        return;
      }
      void sendTyping(true);
    }, refreshIntervalMs);
    timer.unref?.();

    return async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      await sendTyping(false);
    };
  }

  private async handleProgress(
    conversationId: string,
    progress: CodexProgressEvent,
    getLastProgressAt: () => number,
    setLastProgressAt: (next: number) => void,
    getLastProgressText: () => string,
    setLastProgressText: (next: string) => void,
  ): Promise<void> {
    if (!this.progressUpdatesEnabled) {
      return;
    }

    const progressText = mapProgressText(progress);
    if (!progressText) {
      return;
    }

    const now = Date.now();
    if (now - getLastProgressAt() < this.progressMinIntervalMs && progress.stage !== "turn_started") {
      return;
    }
    if (progressText === getLastProgressText()) {
      return;
    }

    setLastProgressAt(now);
    setLastProgressText(progressText);
    try {
      await this.channel.sendNotice(conversationId, `[CodeHarbor] ${progressText}`);
    } catch (error) {
      this.logger.debug("Failed to send progress update", { conversationId, progress, error });
    }
  }

  private getLock(key: string): Mutex {
    const now = Date.now();
    if (now - this.lastLockPruneAt >= this.lockPruneIntervalMs) {
      this.lastLockPruneAt = now;
      this.pruneSessionLocks(now);
    }

    let entry = this.sessionLocks.get(key);
    if (!entry) {
      entry = {
        mutex: new Mutex(),
        lastUsedAt: now,
      };
      this.sessionLocks.set(key, entry);
    }
    entry.lastUsedAt = now;
    return entry.mutex;
  }

  private pruneSessionLocks(now: number): void {
    const expireBefore = now - this.lockTtlMs;
    for (const [sessionKey, entry] of this.sessionLocks.entries()) {
      if (entry.lastUsedAt >= expireBefore) {
        continue;
      }
      if (entry.mutex.isLocked()) {
        continue;
      }
      this.sessionLocks.delete(sessionKey);
    }
  }
}

export function buildSessionKey(message: InboundMessage): string {
  return `${message.channel}:${message.conversationId}:${message.senderId}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function mapProgressText(progress: CodexProgressEvent): string | null {
  if (progress.stage === "turn_started") {
    return "开始处理请求，正在思考...";
  }
  if (progress.stage === "reasoning" && progress.message) {
    const normalized = progress.message.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return null;
    }
    const maxLen = 180;
    return normalized.length > maxLen ? `思考中: ${normalized.slice(0, maxLen)}...` : `思考中: ${normalized}`;
  }
  if (progress.stage === "item_completed" && progress.message) {
    return `阶段完成: ${progress.message}`;
  }
  return null;
}

function parseControlCommand(text: string): "status" | "stop" | "reset" | null {
  const command = text.split(/\s+/, 1)[0].toLowerCase();
  if (command === "/status") {
    return "status";
  }
  if (command === "/stop") {
    return "stop";
  }
  if (command === "/reset") {
    return "reset";
  }
  return null;
}

function stripLeadingBotMention(text: string, matrixUserId: string): string {
  if (!matrixUserId) {
    return text;
  }
  const escapedUserId = escapeRegex(matrixUserId);
  const mentionPattern = new RegExp(`^\\s*(?:<)?${escapedUserId}(?:>)?[\\s,:，：-]*`, "i");
  return text.replace(mentionPattern, "").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
