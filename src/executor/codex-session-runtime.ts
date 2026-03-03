import {
  CodexExecutionHandle,
  CodexExecutionStartOptions,
  CodexExecutor,
  CodexProgressHandler,
} from "./codex-executor";

export interface CodexSessionRuntimeOptions {
  idleTtlMs: number;
}

interface SessionWorkerState {
  lastUsedAt: number;
  lastSessionId: string | null;
  runningHandle: CodexExecutionHandle | null;
}

export class CodexSessionRuntime {
  private readonly executor: CodexExecutor;
  private readonly idleTtlMs: number;
  private readonly workers = new Map<string, SessionWorkerState>();

  constructor(executor: CodexExecutor, options?: Partial<CodexSessionRuntimeOptions>) {
    this.executor = executor;
    this.idleTtlMs = options?.idleTtlMs ?? 30 * 60 * 1000;
  }

  startExecution(
    sessionKey: string,
    prompt: string,
    persistedSessionId: string | null,
    onProgress?: CodexProgressHandler,
    startOptions?: CodexExecutionStartOptions,
  ): CodexExecutionHandle {
    this.prune(Date.now());
    const worker = this.getOrCreateWorker(sessionKey, persistedSessionId);
    const effectiveSessionId = worker.lastSessionId ?? persistedSessionId;
    worker.lastUsedAt = Date.now();

    const handle = this.executor.startExecution(prompt, effectiveSessionId, onProgress, startOptions);
    worker.runningHandle = handle;

    const result = handle.result
      .then((executionResult) => {
        worker.lastSessionId = executionResult.sessionId;
        worker.lastUsedAt = Date.now();
        return executionResult;
      })
      .finally(() => {
        if (worker.runningHandle === handle) {
          worker.runningHandle = null;
        }
      });

    return {
      result,
      cancel: () => {
        handle.cancel();
      },
    };
  }

  clearSession(sessionKey: string): void {
    const worker = this.workers.get(sessionKey);
    if (!worker) {
      return;
    }
    worker.lastSessionId = null;
    worker.lastUsedAt = Date.now();
  }

  cancelRunningExecution(sessionKey: string): boolean {
    const worker = this.workers.get(sessionKey);
    if (!worker?.runningHandle) {
      return false;
    }
    worker.runningHandle.cancel();
    worker.lastUsedAt = Date.now();
    return true;
  }

  getRuntimeStats(): { workerCount: number; runningCount: number } {
    let runningCount = 0;
    for (const worker of this.workers.values()) {
      if (worker.runningHandle) {
        runningCount += 1;
      }
    }
    return {
      workerCount: this.workers.size,
      runningCount,
    };
  }

  private getOrCreateWorker(sessionKey: string, persistedSessionId: string | null): SessionWorkerState {
    const existing = this.workers.get(sessionKey);
    if (existing) {
      if (persistedSessionId && !existing.lastSessionId) {
        existing.lastSessionId = persistedSessionId;
      }
      return existing;
    }
    const created: SessionWorkerState = {
      lastUsedAt: Date.now(),
      lastSessionId: persistedSessionId,
      runningHandle: null,
    };
    this.workers.set(sessionKey, created);
    return created;
  }

  private prune(now: number): void {
    const expireBefore = now - this.idleTtlMs;
    for (const [key, worker] of this.workers.entries()) {
      if (worker.lastUsedAt >= expireBefore) {
        continue;
      }
      if (worker.runningHandle) {
        continue;
      }
      this.workers.delete(key);
    }
  }
}
