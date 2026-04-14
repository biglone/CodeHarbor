import type { Logger } from "../logger";
import type { StateStore, TaskFailureArchiveRecord } from "../store/state-store";
import { formatError } from "./helpers";

interface TaskQueueStateStoreLike {
  enqueueTask?: unknown;
  claimNextTask?: unknown;
  getTaskById?: unknown;
  listTaskQueue?: unknown;
  cancelTaskById?: unknown;
  retryTaskById?: unknown;
  hasPendingTask?: unknown;
  clearPendingTasks?: unknown;
  listPendingTaskSessions?: unknown;
  finishTask?: unknown;
  failTask?: unknown;
  recoverTasks?: unknown;
  getTaskQueueStatusCounts?: unknown;
}

interface UpgradeStateStoreLike {
  createUpgradeRun?: unknown;
  finishUpgradeRun?: unknown;
  getLatestUpgradeRun?: unknown;
}

export function getTaskQueueStateStore(stateStore: StateStore): TaskQueueStateStoreLike | null {
  const maybeStore = stateStore as unknown as Partial<TaskQueueStateStoreLike>;
  if (
    typeof maybeStore.enqueueTask !== "function" ||
    typeof maybeStore.claimNextTask !== "function" ||
    typeof maybeStore.getTaskById !== "function" ||
    typeof maybeStore.listTaskQueue !== "function" ||
    typeof maybeStore.cancelTaskById !== "function" ||
    typeof maybeStore.retryTaskById !== "function" ||
    typeof maybeStore.hasPendingTask !== "function" ||
    typeof maybeStore.clearPendingTasks !== "function" ||
    typeof maybeStore.listPendingTaskSessions !== "function" ||
    typeof maybeStore.finishTask !== "function" ||
    typeof maybeStore.failTask !== "function" ||
    typeof maybeStore.recoverTasks !== "function" ||
    typeof maybeStore.getTaskQueueStatusCounts !== "function"
  ) {
    return null;
  }
  return maybeStore;
}

export function listTaskQueueFailureArchive(
  stateStore: StateStore,
  logger: Logger,
  limit: number,
): TaskFailureArchiveRecord[] {
  const store = stateStore as StateStore & {
    listTaskFailureArchive?: (limit?: number) => TaskFailureArchiveRecord[];
  };
  if (typeof store.listTaskFailureArchive !== "function") {
    return [];
  }
  try {
    return store.listTaskFailureArchive(limit);
  } catch (error) {
    logger.warn("Failed to load task queue failure archive", {
      error: formatError(error),
      limit,
    });
    return [];
  }
}

export function getUpgradeStateStore(stateStore: StateStore): UpgradeStateStoreLike | null {
  const maybeStore = stateStore as unknown as Partial<UpgradeStateStoreLike>;
  if (
    typeof maybeStore.createUpgradeRun !== "function" ||
    typeof maybeStore.finishUpgradeRun !== "function" ||
    typeof maybeStore.getLatestUpgradeRun !== "function"
  ) {
    return null;
  }
  return maybeStore;
}
