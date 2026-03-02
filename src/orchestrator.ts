import { Mutex } from "async-mutex";

import { MatrixChannel } from "./channels/matrix-channel";
import { CodexExecutor } from "./executor/codex-executor";
import { Logger } from "./logger";
import { InboundMessage } from "./types";
import { StateStore } from "./store/state-store";

interface OrchestratorOptions {
  lockTtlMs?: number;
  lockPruneIntervalMs?: number;
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

      try {
        const result = await this.executor.execute(message.text, previousCodexSessionId);
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
      }
    });
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
