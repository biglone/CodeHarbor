import { Mutex } from "async-mutex";

import { MatrixChannel } from "./channels/matrix-channel";
import { CodexExecutor, type CodexProgressEvent } from "./executor/codex-executor";
import { Logger } from "./logger";
import { InboundMessage } from "./types";
import { StateStore } from "./store/state-store";

interface OrchestratorOptions {
  lockTtlMs?: number;
  lockPruneIntervalMs?: number;
  progressUpdatesEnabled?: boolean;
  progressMinIntervalMs?: number;
  typingTimeoutMs?: number;
}

interface SessionLockEntry {
  mutex: Mutex;
  lastUsedAt: number;
}

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
  }

  async handleMessage(message: InboundMessage): Promise<void> {
    const sessionKey = buildSessionKey(message);
    const lock = this.getLock(sessionKey);

    await lock.runExclusive(async () => {
      if (this.stateStore.hasProcessedEvent(sessionKey, message.eventId)) {
        this.logger.debug("Duplicate event ignored", { eventId: message.eventId });
        return;
      }

      const previousCodexSessionId = this.stateStore.getCodexSessionId(sessionKey);
      this.logger.info("Processing message", {
        sessionKey,
        hasCodexSession: Boolean(previousCodexSessionId),
      });

      const stopTyping = this.startTypingHeartbeat(message.conversationId);
      let lastProgressAt = 0;
      let lastProgressText = "";

      try {
        const result = await this.executor.execute(message.text, previousCodexSessionId, (progress) => {
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
