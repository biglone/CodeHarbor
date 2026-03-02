import { Mutex } from "async-mutex";

import { MatrixChannel } from "./channels/matrix-channel";
import { CodexExecutor } from "./executor/codex-executor";
import { Logger } from "./logger";
import { InboundMessage } from "./types";
import { StateStore } from "./store/state-store";

export class Orchestrator {
  private readonly channel: MatrixChannel;
  private readonly executor: CodexExecutor;
  private readonly stateStore: StateStore;
  private readonly logger: Logger;
  private readonly sessionLocks = new Map<string, Mutex>();

  constructor(channel: MatrixChannel, executor: CodexExecutor, stateStore: StateStore, logger: Logger) {
    this.channel = channel;
    this.executor = executor;
    this.stateStore = stateStore;
    this.logger = logger;
  }

  async handleMessage(message: InboundMessage): Promise<void> {
    const sessionKey = buildSessionKey(message);
    const lock = this.getLock(sessionKey);

    await lock.runExclusive(async () => {
      const isNew = this.stateStore.markEventIfNew(sessionKey, message.eventId);
      if (!isNew) {
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
      } catch (error) {
        this.logger.error("Failed to execute codex request", error);
        await this.channel.sendMessage(
          message.conversationId,
          `[CodeHarbor] Failed to process request: ${formatError(error)}`,
        );
      }
    });
  }

  private getLock(key: string): Mutex {
    let mutex = this.sessionLocks.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.sessionLocks.set(key, mutex);
    }
    return mutex;
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
