import type { Logger } from "../logger";
import { formatError } from "./helpers";

interface QueueStoreLike {
  recoverTasks: (limit: number) => {
    tasks: Array<{ sessionKey: string }>;
    requeuedRunning: number;
    pendingTotal: number;
    hasMorePending: boolean;
  };
  listPendingTaskSessions: (limit: number, afterTaskId: number) => Array<{
    sessionKey: string;
    firstTaskId: number;
  }>;
}

interface TaskQueueRecoveryDeps {
  logger: Logger;
  taskQueueRecoveryEnabled: boolean;
  taskQueueRecoveryBatchLimit: number;
  startSessionQueueDrain: (sessionKey: string) => void;
}

export function bootstrapTaskQueueRecovery(deps: TaskQueueRecoveryDeps, queueStore: QueueStoreLike): void {
  if (!deps.taskQueueRecoveryEnabled) {
    deps.logger.info("Task queue recovery disabled by configuration.");
    return;
  }

  try {
    const recovery = queueStore.recoverTasks(deps.taskQueueRecoveryBatchLimit);
    const sessions = new Set<string>(recovery.tasks.map((task) => task.sessionKey));
    let afterTaskId = 0;
    while (true) {
      const batch = queueStore.listPendingTaskSessions(deps.taskQueueRecoveryBatchLimit, afterTaskId);
      if (batch.length === 0) {
        break;
      }
      for (const item of batch) {
        sessions.add(item.sessionKey);
        afterTaskId = item.firstTaskId;
      }
    }
    for (const sessionKey of sessions) {
      deps.startSessionQueueDrain(sessionKey);
    }
    deps.logger.info("Task queue recovery completed", {
      requeuedRunning: recovery.requeuedRunning,
      pendingTotal: recovery.pendingTotal,
      recoveredSessions: sessions.size,
      hasMorePending: recovery.hasMorePending,
    });
  } catch (error) {
    deps.logger.error("Failed to recover task queue", {
      error: formatError(error),
    });
  }
}
