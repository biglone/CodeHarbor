import {
  NpmRegistryUpdateChecker,
  resolvePackageVersion,
  type PackageUpdateChecker,
} from "../package-update-checker";
import { createRetryPolicy, type RetryPolicy } from "../reliability/retry-policy";
import {
  DEFAULT_TASK_QUEUE_RECOVERY_BATCH_LIMIT,
  DEFAULT_TASK_QUEUE_RETRY_POLICY,
} from "./orchestrator-constants";
import type { OrchestratorOptions } from "./orchestrator-config-types";

export interface ServiceRuntimeConfig {
  botNoticePrefix: string;
  packageUpdateChecker: PackageUpdateChecker;
  updateCheckTtlMs: number;
  taskQueueRecoveryEnabled: boolean;
  taskQueueRecoveryBatchLimit: number;
  taskQueueRetryPolicy: RetryPolicy;
}

export function resolveServiceRuntimeConfig(options?: OrchestratorOptions): ServiceRuntimeConfig {
  const currentVersion = resolvePackageVersion();
  return {
    botNoticePrefix: `[CodeHarbor v${currentVersion}]`,
    packageUpdateChecker:
      options?.packageUpdateChecker ??
      new NpmRegistryUpdateChecker({
        packageName: "codeharbor",
        currentVersion,
      }),
    updateCheckTtlMs: Math.max(0, options?.updateCheckTtlMs ?? 6 * 60 * 60 * 1000),
    taskQueueRecoveryEnabled: options?.taskQueueRecoveryEnabled ?? true,
    taskQueueRecoveryBatchLimit: Math.max(
      1,
      options?.taskQueueRecoveryBatchLimit ?? DEFAULT_TASK_QUEUE_RECOVERY_BATCH_LIMIT,
    ),
    taskQueueRetryPolicy: createRetryPolicy({
      ...DEFAULT_TASK_QUEUE_RETRY_POLICY,
      ...options?.taskQueueRetryPolicy,
    }),
  };
}
