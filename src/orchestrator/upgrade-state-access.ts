import type { Logger } from "../logger";
import type { UpgradeExecutionLockRecord, UpgradeRunRecord, UpgradeRunStats } from "../store/state-store";
import type { InboundMessage } from "../types";

interface UpgradeStateStoreLike {
  createUpgradeRun?: (input: { requestedBy: string; targetVersion: string | null }) => number;
  finishUpgradeRun?: (
    runId: number,
    input: { status: "succeeded" | "failed"; installedVersion: string | null; error: string | null },
  ) => void;
  getLatestUpgradeRun?: () => UpgradeRunRecord | null;
  listRecentUpgradeRuns?: (limit: number) => UpgradeRunRecord[];
  getUpgradeRunStats?: () => UpgradeRunStats;
  acquireUpgradeExecutionLock?: (input: { owner: string; ttlMs: number }) => {
    acquired: boolean;
    owner: string | null;
    expiresAt: number | null;
  };
  releaseUpgradeExecutionLock?: (owner: string) => void;
  getUpgradeExecutionLock?: () => UpgradeExecutionLockRecord | null;
}

interface UpgradeStoreAccessorDeps {
  getUpgradeStateStore: () => UpgradeStateStoreLike | null;
  logger: Logger;
}

export function authorizeUpgradeRequest(
  message: InboundMessage,
  upgradeAllowedUsers: Set<string>,
  matrixAdminUsers: Set<string>,
): { allowed: true } | { allowed: false; reason: string } {
  if (!message.isDirectMessage) {
    return {
      allowed: false,
      reason: "为保证安全，/upgrade 仅支持私聊中执行。",
    };
  }
  if (upgradeAllowedUsers.size > 0) {
    if (upgradeAllowedUsers.has(message.senderId)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "当前账号无执行 /upgrade 权限，请联系管理员添加 MATRIX_UPGRADE_ALLOWED_USERS 白名单。",
    };
  }
  if (matrixAdminUsers.size === 0 || matrixAdminUsers.has(message.senderId)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: "当前账号不是 Matrix 管理员（MATRIX_ADMIN_USERS），无法执行 /upgrade。",
  };
}

export function createUpgradeRun(
  deps: UpgradeStoreAccessorDeps,
  requestedBy: string,
  targetVersion: string | null,
): number | null {
  const store = deps.getUpgradeStateStore();
  if (!store || typeof store.createUpgradeRun !== "function") {
    return null;
  }
  try {
    return store.createUpgradeRun({
      requestedBy,
      targetVersion,
    });
  } catch (error) {
    deps.logger.warn("Failed to create upgrade run record", { error });
    return null;
  }
}

export function finishUpgradeRun(
  deps: UpgradeStoreAccessorDeps,
  runId: number | null,
  input: { status: "succeeded" | "failed"; installedVersion: string | null; error: string | null },
): void {
  if (runId === null) {
    return;
  }
  const store = deps.getUpgradeStateStore();
  if (!store || typeof store.finishUpgradeRun !== "function") {
    return;
  }
  try {
    store.finishUpgradeRun(runId, input);
  } catch (error) {
    deps.logger.warn("Failed to finalize upgrade run record", { runId, error });
  }
}

export function getLatestUpgradeRun(deps: UpgradeStoreAccessorDeps): UpgradeRunRecord | null {
  const store = deps.getUpgradeStateStore();
  if (!store || typeof store.getLatestUpgradeRun !== "function") {
    return null;
  }
  try {
    return store.getLatestUpgradeRun();
  } catch (error) {
    deps.logger.warn("Failed to fetch latest upgrade run record", { error });
    return null;
  }
}

export function getRecentUpgradeRuns(deps: UpgradeStoreAccessorDeps, limit: number): UpgradeRunRecord[] {
  const store = deps.getUpgradeStateStore();
  if (!store || typeof store.listRecentUpgradeRuns !== "function") {
    return [];
  }
  try {
    return store.listRecentUpgradeRuns(limit);
  } catch (error) {
    deps.logger.warn("Failed to fetch recent upgrade run records", { error, limit });
    return [];
  }
}

export function getUpgradeRunStats(deps: UpgradeStoreAccessorDeps): UpgradeRunStats {
  const store = deps.getUpgradeStateStore();
  if (!store || typeof store.getUpgradeRunStats !== "function") {
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
      running: 0,
      avgDurationMs: 0,
    };
  }
  try {
    return store.getUpgradeRunStats();
  } catch (error) {
    deps.logger.warn("Failed to fetch upgrade run stats", { error });
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
      running: 0,
      avgDurationMs: 0,
    };
  }
}

export function getUpgradeExecutionLockSnapshot(
  deps: UpgradeStoreAccessorDeps,
): UpgradeExecutionLockRecord | null {
  const store = deps.getUpgradeStateStore();
  if (!store || typeof store.getUpgradeExecutionLock !== "function") {
    return null;
  }
  try {
    return store.getUpgradeExecutionLock();
  } catch (error) {
    deps.logger.warn("Failed to fetch distributed upgrade lock state", { error });
    return null;
  }
}

export function acquireUpgradeExecutionLock(
  deps: UpgradeStoreAccessorDeps,
  owner: string,
  ttlMs: number,
): { acquired: boolean; owner: string | null; expiresAt: number | null } {
  const store = deps.getUpgradeStateStore();
  if (!store || typeof store.acquireUpgradeExecutionLock !== "function") {
    return {
      acquired: true,
      owner,
      expiresAt: null,
    };
  }
  try {
    return store.acquireUpgradeExecutionLock({
      owner,
      ttlMs,
    });
  } catch (error) {
    deps.logger.warn("Failed to acquire distributed upgrade lock", { error });
    return {
      acquired: false,
      owner: null,
      expiresAt: null,
    };
  }
}

export function releaseUpgradeExecutionLock(deps: UpgradeStoreAccessorDeps, owner: string): void {
  const store = deps.getUpgradeStateStore();
  if (!store || typeof store.releaseUpgradeExecutionLock !== "function") {
    return;
  }
  try {
    store.releaseUpgradeExecutionLock(owner);
  } catch (error) {
    deps.logger.warn("Failed to release distributed upgrade lock", { error });
  }
}
