import type { Logger } from "../logger";
import type { StateStore } from "../store/state-store";
import { formatError } from "./helpers";
import {
  createEmptyWorkflowDiagStorePayload,
  parseWorkflowDiagStorePayload,
  type WorkflowDiagStorePayload,
} from "./workflow-diag";

interface RuntimeMetricsSnapshotStoreLike {
  getRuntimeMetricsSnapshot?: (key: string) => { payloadJson: string } | null;
  upsertRuntimeMetricsSnapshot?: (key: string, payloadJson: string) => void;
}

export function restoreWorkflowDiagStore(
  stateStore: StateStore,
  workflowDiagSnapshotKey: string,
  logger: Logger,
): WorkflowDiagStorePayload {
  const store = stateStore as StateStore & RuntimeMetricsSnapshotStoreLike;
  if (typeof store.getRuntimeMetricsSnapshot !== "function") {
    return createEmptyWorkflowDiagStorePayload();
  }
  try {
    const record = store.getRuntimeMetricsSnapshot(workflowDiagSnapshotKey);
    return parseWorkflowDiagStorePayload(record?.payloadJson ?? null);
  } catch (error) {
    logger.debug("Failed to restore workflow diag store", {
      error: formatError(error),
    });
    return createEmptyWorkflowDiagStorePayload();
  }
}

export function persistWorkflowDiagStore(
  stateStore: StateStore,
  workflowDiagSnapshotKey: string,
  payload: WorkflowDiagStorePayload,
  logger: Logger,
): void {
  const store = stateStore as StateStore & RuntimeMetricsSnapshotStoreLike;
  if (typeof store.upsertRuntimeMetricsSnapshot !== "function") {
    return;
  }
  try {
    store.upsertRuntimeMetricsSnapshot(workflowDiagSnapshotKey, JSON.stringify(payload));
  } catch (error) {
    logger.debug("Failed to persist workflow diag store", {
      error: formatError(error),
    });
  }
}
