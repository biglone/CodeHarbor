import type { Logger } from "../logger";
import type { RuntimeMetricsSnapshot } from "../metrics";
import type { StateStore } from "../store/state-store";

export function persistRuntimeMetricsSnapshot(
  stateStore: StateStore,
  logger: Logger,
  key: string,
  snapshot: RuntimeMetricsSnapshot,
): void {
  const store = stateStore as StateStore & {
    upsertRuntimeMetricsSnapshot?: (targetKey: string, payloadJson: string) => void;
  };
  if (typeof store.upsertRuntimeMetricsSnapshot !== "function") {
    return;
  }
  try {
    store.upsertRuntimeMetricsSnapshot(
      key,
      JSON.stringify(snapshot),
    );
  } catch (error) {
    logger.debug("Failed to persist runtime metrics snapshot", {
      error,
    });
  }
}
