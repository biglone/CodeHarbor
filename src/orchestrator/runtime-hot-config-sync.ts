import type { Logger } from "../logger";
import {
  GLOBAL_RUNTIME_HOT_CONFIG_KEY,
  parseRuntimeHotConfigPayload,
  type RuntimeHotConfigPayload,
} from "../runtime-hot-config";
import { formatError } from "./helpers";

interface RuntimeConfigSnapshotRecord {
  version: number;
  payloadJson: string;
  updatedAt: number;
}

interface RuntimeConfigSnapshotStoreLike {
  getRuntimeConfigSnapshot?: (key: string) => RuntimeConfigSnapshotRecord | null;
}

interface SyncRuntimeHotConfigDeps {
  stateStore: RuntimeConfigSnapshotStoreLike;
  hotConfigVersion: number;
  hotConfigRejectedVersion: number;
  logger: Logger;
  applyRuntimeHotConfig: (config: RuntimeHotConfigPayload) => void;
  setHotConfigVersion: (version: number) => void;
  setHotConfigRejectedVersion: (version: number) => void;
}

export function syncRuntimeHotConfig(deps: SyncRuntimeHotConfigDeps): void {
  if (typeof deps.stateStore.getRuntimeConfigSnapshot !== "function") {
    return;
  }

  let record: RuntimeConfigSnapshotRecord | null = null;
  try {
    record = deps.stateStore.getRuntimeConfigSnapshot(GLOBAL_RUNTIME_HOT_CONFIG_KEY);
  } catch (error) {
    deps.logger.debug("Failed to read runtime hot config snapshot", {
      error: formatError(error),
    });
    return;
  }
  if (!record) {
    return;
  }

  const latestKnownVersion = Math.max(deps.hotConfigVersion, deps.hotConfigRejectedVersion);
  if (record.version <= latestKnownVersion) {
    return;
  }

  const hotConfig = parseRuntimeHotConfigPayload(record.payloadJson);
  if (!hotConfig) {
    deps.setHotConfigRejectedVersion(record.version);
    deps.logger.warn("Ignore invalid runtime hot config snapshot payload", {
      version: record.version,
    });
    return;
  }

  try {
    deps.applyRuntimeHotConfig(hotConfig);
    deps.setHotConfigVersion(record.version);
    deps.logger.info("Runtime hot config applied", {
      version: record.version,
      updatedAt: new Date(record.updatedAt).toISOString(),
    });
  } catch (error) {
    deps.setHotConfigRejectedVersion(record.version);
    deps.logger.warn("Failed to apply runtime hot config snapshot", {
      version: record.version,
      error: formatError(error),
    });
  }
}
