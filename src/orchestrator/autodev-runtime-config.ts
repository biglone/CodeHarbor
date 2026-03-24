import {
  DEFAULT_AUTODEV_AUTO_RELEASE_ENABLED,
  DEFAULT_AUTODEV_AUTO_RELEASE_PUSH,
  DEFAULT_AUTODEV_DETAILED_PROGRESS_ENABLED,
  DEFAULT_AUTODEV_INIT_ENHANCEMENT_ENABLED,
  DEFAULT_AUTODEV_INIT_ENHANCEMENT_MAX_CHARS,
  DEFAULT_AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS,
  DEFAULT_AUTODEV_LOOP_MAX_MINUTES,
  DEFAULT_AUTODEV_LOOP_MAX_RUNS,
  DEFAULT_AUTODEV_MAX_CONSECUTIVE_FAILURES,
} from "./orchestrator-constants";
import type { OrchestratorOptions } from "./orchestrator-config-types";
import { parseEnvBoolean, parseEnvPositiveInt } from "./helpers";

export interface AutoDevRuntimeConfig {
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevAutoReleaseEnabled: boolean;
  autoDevAutoReleasePush: boolean;
  autoDevMaxConsecutiveFailures: number;
  autoDevDetailedProgressDefaultEnabled: boolean;
  autoDevInitEnhancementEnabled: boolean;
  autoDevInitEnhancementTimeoutMs: number;
  autoDevInitEnhancementMaxChars: number;
}

export function resolveAutoDevRuntimeConfig(options?: OrchestratorOptions): AutoDevRuntimeConfig {
  return {
    autoDevLoopMaxRuns: Math.max(
      1,
      options?.autoDevLoopMaxRuns ??
        parseEnvPositiveInt(process.env.AUTODEV_LOOP_MAX_RUNS, DEFAULT_AUTODEV_LOOP_MAX_RUNS),
    ),
    autoDevLoopMaxMinutes: Math.max(
      1,
      options?.autoDevLoopMaxMinutes ??
        parseEnvPositiveInt(process.env.AUTODEV_LOOP_MAX_MINUTES, DEFAULT_AUTODEV_LOOP_MAX_MINUTES),
    ),
    autoDevAutoCommit: options?.autoDevAutoCommit ?? parseEnvBoolean(process.env.AUTODEV_AUTO_COMMIT, true),
    autoDevAutoReleaseEnabled:
      options?.autoDevAutoReleaseEnabled ??
      parseEnvBoolean(process.env.AUTODEV_AUTO_RELEASE_ENABLED, DEFAULT_AUTODEV_AUTO_RELEASE_ENABLED),
    autoDevAutoReleasePush:
      options?.autoDevAutoReleasePush ??
      parseEnvBoolean(process.env.AUTODEV_AUTO_RELEASE_PUSH, DEFAULT_AUTODEV_AUTO_RELEASE_PUSH),
    autoDevMaxConsecutiveFailures: Math.max(
      1,
      options?.autoDevMaxConsecutiveFailures ??
        parseEnvPositiveInt(process.env.AUTODEV_MAX_CONSECUTIVE_FAILURES, DEFAULT_AUTODEV_MAX_CONSECUTIVE_FAILURES),
    ),
    autoDevDetailedProgressDefaultEnabled:
      options?.autoDevDetailedProgressEnabled ?? DEFAULT_AUTODEV_DETAILED_PROGRESS_ENABLED,
    autoDevInitEnhancementEnabled:
      options?.autoDevInitEnhancementEnabled ??
      parseEnvBoolean(process.env.AUTODEV_INIT_ENHANCEMENT_ENABLED, DEFAULT_AUTODEV_INIT_ENHANCEMENT_ENABLED),
    autoDevInitEnhancementTimeoutMs: Math.max(
      1,
      options?.autoDevInitEnhancementTimeoutMs ??
        parseEnvPositiveInt(
          process.env.AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS,
          DEFAULT_AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS,
        ),
    ),
    autoDevInitEnhancementMaxChars: Math.max(
      1,
      options?.autoDevInitEnhancementMaxChars ??
        parseEnvPositiveInt(process.env.AUTODEV_INIT_ENHANCEMENT_MAX_CHARS, DEFAULT_AUTODEV_INIT_ENHANCEMENT_MAX_CHARS),
    ),
  };
}
