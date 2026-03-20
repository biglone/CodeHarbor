import type { Logger } from "../logger";
import { formatError } from "./helpers";

interface TaskQueueStateStoreLike {
  hasReadyTask: (sessionKey: string) => boolean;
  getNextPendingRetryAt: (sessionKey: string) => number | null;
}

type QueueDrainTimer = ReturnType<typeof setTimeout>;

interface StartSessionQueueDrainDeps {
  sessionQueueDrains: Map<string, Promise<void>>;
  getTaskQueueStateStore: () => TaskQueueStateStoreLike | null;
  clearSessionQueueRetryTimer: (sessionKey: string) => void;
  scheduleSessionQueueDrainAtNextRetry: (sessionKey: string, queueStore: TaskQueueStateStoreLike) => void;
  drainSessionQueue: (sessionKey: string) => Promise<void>;
  reconcileSessionQueueDrain: (sessionKey: string) => void;
  logger: Logger;
}

interface ReconcileSessionQueueDrainDeps {
  getTaskQueueStateStore: () => TaskQueueStateStoreLike | null;
  startSessionQueueDrain: (sessionKey: string) => void;
  scheduleSessionQueueDrainAtNextRetry: (sessionKey: string, queueStore: TaskQueueStateStoreLike) => void;
  logger: Logger;
}

interface ScheduleSessionQueueDrainDeps {
  sessionQueueRetryTimers: Map<string, QueueDrainTimer>;
  clearSessionQueueRetryTimer: (sessionKey: string) => void;
  startSessionQueueDrain: (sessionKey: string) => void;
  logger: Logger;
}

interface ClearSessionQueueRetryTimerInput {
  sessionQueueRetryTimers: Map<string, QueueDrainTimer>;
  sessionKey: string;
}

export function startSessionQueueDrain(deps: StartSessionQueueDrainDeps, sessionKey: string): void {
  if (deps.sessionQueueDrains.has(sessionKey)) {
    return;
  }
  deps.clearSessionQueueRetryTimer(sessionKey);

  const queueStore = deps.getTaskQueueStateStore();
  if (!queueStore) {
    return;
  }
  try {
    if (!queueStore.hasReadyTask(sessionKey)) {
      deps.scheduleSessionQueueDrainAtNextRetry(sessionKey, queueStore);
      return;
    }
  } catch (error) {
    deps.logger.warn("Failed to inspect ready queued task before drain", {
      sessionKey,
      error: formatError(error),
    });
    return;
  }

  const drainPromise = deps
    .drainSessionQueue(sessionKey)
    .catch((error) => {
      deps.logger.error("Session task queue drain failed", {
        sessionKey,
        error: formatError(error),
      });
    })
    .finally(() => {
      const current = deps.sessionQueueDrains.get(sessionKey);
      if (current === drainPromise) {
        deps.sessionQueueDrains.delete(sessionKey);
      }
      deps.reconcileSessionQueueDrain(sessionKey);
    });

  deps.sessionQueueDrains.set(sessionKey, drainPromise);
}

export function reconcileSessionQueueDrain(deps: ReconcileSessionQueueDrainDeps, sessionKey: string): void {
  const queueStore = deps.getTaskQueueStateStore();
  if (!queueStore) {
    return;
  }
  try {
    if (queueStore.hasReadyTask(sessionKey)) {
      deps.startSessionQueueDrain(sessionKey);
      return;
    }
    deps.scheduleSessionQueueDrainAtNextRetry(sessionKey, queueStore);
  } catch (error) {
    deps.logger.warn("Failed to reconcile session queue drain state", {
      sessionKey,
      error: formatError(error),
    });
  }
}

export function scheduleSessionQueueDrainAtNextRetry(
  scheduleSessionQueueDrainFn: (sessionKey: string, nextRetryAt: number) => void,
  sessionKey: string,
  queueStore: Pick<TaskQueueStateStoreLike, "getNextPendingRetryAt">,
): void {
  const nextRetryAt = queueStore.getNextPendingRetryAt(sessionKey);
  if (nextRetryAt === null) {
    return;
  }
  scheduleSessionQueueDrainFn(sessionKey, nextRetryAt);
}

export function scheduleSessionQueueDrain(
  deps: ScheduleSessionQueueDrainDeps,
  sessionKey: string,
  nextRetryAt: number,
): void {
  deps.clearSessionQueueRetryTimer(sessionKey);
  const safeNextRetryAt = Math.max(Date.now(), Math.floor(nextRetryAt));
  const delayMs = Math.max(0, safeNextRetryAt - Date.now());
  if (delayMs <= 0) {
    deps.startSessionQueueDrain(sessionKey);
    return;
  }

  const timer = setTimeout(() => {
    const current = deps.sessionQueueRetryTimers.get(sessionKey);
    if (current === timer) {
      deps.sessionQueueRetryTimers.delete(sessionKey);
    }
    deps.startSessionQueueDrain(sessionKey);
  }, delayMs);
  timer.unref?.();
  deps.sessionQueueRetryTimers.set(sessionKey, timer);
  deps.logger.debug("Session queue drain scheduled for next retry", {
    sessionKey,
    nextRetryAt: safeNextRetryAt,
    nextRetryAtIso: new Date(safeNextRetryAt).toISOString(),
    delayMs,
  });
}

export function clearSessionQueueRetryTimer(input: ClearSessionQueueRetryTimerInput): void {
  const timer = input.sessionQueueRetryTimers.get(input.sessionKey);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  input.sessionQueueRetryTimers.delete(input.sessionKey);
}
