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
    let cancelled = false;
    let activeHandle: CodexExecutionHandle | null = null;

    const runAttempt = (sessionIdForAttempt: string | null): Promise<{ sessionId: string; reply: string }> => {
      const handle = this.executor.startExecution(prompt, sessionIdForAttempt, onProgress, startOptions);
      activeHandle = handle;
      worker.runningHandle = handle;
      return handle.result.catch((error) => {
        if (
          !cancelled &&
          sessionIdForAttempt &&
          isRecoverableSessionResumeError(error)
        ) {
          worker.lastSessionId = null;
          worker.lastUsedAt = Date.now();
          return runAttempt(null);
        }
        throw error;
      }).finally(() => {
        if (worker.runningHandle === handle) {
          worker.runningHandle = null;
        }
      });
    };

    const result = runAttempt(effectiveSessionId).then((executionResult) => {
      worker.lastSessionId = executionResult.sessionId;
      worker.lastUsedAt = Date.now();
      return executionResult;
    });

    return {
      result,
      cancel: () => {
        cancelled = true;
        activeHandle?.cancel();
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

function isRecoverableSessionResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("error resuming session")) {
    return true;
  }
  if (normalized.includes("invalid session identifier")) {
    return true;
  }
  if (normalized.includes("use --list-sessions")) {
    return true;
  }
  return false;
}
