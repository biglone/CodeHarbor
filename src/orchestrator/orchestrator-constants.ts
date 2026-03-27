import type { WorkflowRoleSkillDisclosureMode } from "../workflow/role-skills";
import type { RetryPolicyInput } from "../reliability/retry-policy";

export const RUN_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
export const RUN_SNAPSHOT_MAX_ENTRIES = 500;
export const CONTEXT_BRIDGE_HISTORY_LIMIT = 16;
export const CONTEXT_BRIDGE_MAX_CHARS = 8_000;
export const DEFAULT_SELF_UPDATE_TIMEOUT_MS = 20 * 60 * 1_000;
export const DEFAULT_UPGRADE_LOCK_TTL_MS = 30 * 60 * 1_000;
export const DEFAULT_TASK_QUEUE_RECOVERY_BATCH_LIMIT = 200;
export const WORKFLOW_DIAG_SNAPSHOT_KEY = "workflow_diag";
export const DEFAULT_AUTODEV_LOOP_MAX_RUNS = 20;
export const DEFAULT_AUTODEV_LOOP_MAX_MINUTES = 120;
export const DEFAULT_AUTODEV_AUTO_RELEASE_ENABLED = true;
export const DEFAULT_AUTODEV_AUTO_RELEASE_PUSH = false;
export const DEFAULT_AUTODEV_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_AUTODEV_RUN_ARCHIVE_ENABLED = true;
export const DEFAULT_AUTODEV_RUN_ARCHIVE_DIR = ".codeharbor/autodev-runs";
export const DEFAULT_AUTODEV_DETAILED_PROGRESS_ENABLED = true;
export const DEFAULT_AUTODEV_INIT_ENHANCEMENT_ENABLED = true;
export const DEFAULT_AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS = 8 * 60 * 1_000;
export const DEFAULT_AUTODEV_INIT_ENHANCEMENT_MAX_CHARS = 4_000;
export const DEFAULT_WORKFLOW_ROLE_SKILLS_ENABLED = true;
export const DEFAULT_WORKFLOW_ROLE_SKILLS_MODE: WorkflowRoleSkillDisclosureMode = "progressive";
export const AUTODEV_GIT_COMMIT_HISTORY_MAX = 120;
export const BACKEND_ROUTE_DIAG_HISTORY_MAX = 200;
export const DEFAULT_TASK_QUEUE_RETRY_POLICY: RetryPolicyInput = {
  maxAttempts: 4,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
};
