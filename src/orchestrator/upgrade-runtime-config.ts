import os from "node:os";

import type { Logger } from "../logger";
import { DEFAULT_SELF_UPDATE_TIMEOUT_MS } from "./orchestrator-constants";
import type {
  OrchestratorOptions,
  SelfUpdateRunner,
  UpgradeRestartPlanner,
  UpgradeVersionProbe,
} from "./orchestrator-config-types";
import { parseCsvValues } from "./helpers";
import { buildDefaultUpgradeRestartPlan, probeInstalledVersion, runSelfUpdateCommand } from "./upgrade-utils";

export interface UpgradeRuntimeConfig {
  matrixAdminUsers: Set<string>;
  upgradeAllowedUsers: Set<string>;
  upgradeLockOwner: string;
  selfUpdateRunner: SelfUpdateRunner;
  upgradeRestartPlanner: UpgradeRestartPlanner;
  upgradeVersionProbe: UpgradeVersionProbe;
}

export function resolveUpgradeRuntimeConfig(input: {
  options: OrchestratorOptions | undefined;
  logger: Logger;
}): UpgradeRuntimeConfig {
  const matrixAdminUsers = new Set(
    (input.options?.matrixAdminUsers ?? parseCsvValues(process.env.MATRIX_ADMIN_USERS ?? ""))
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  const upgradeAllowedUsers = new Set(
    (input.options?.upgradeAllowedUsers ?? parseCsvValues(process.env.MATRIX_UPGRADE_ALLOWED_USERS ?? ""))
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  const upgradeLockOwner = `pid:${process.pid}@${os.hostname()}`;
  const selfUpdateTimeoutMs = Math.max(1_000, input.options?.selfUpdateTimeoutMs ?? DEFAULT_SELF_UPDATE_TIMEOUT_MS);
  const selfUpdateRunner =
    input.options?.selfUpdateRunner ??
    ((runnerInput) =>
      runSelfUpdateCommand({
        version: runnerInput.version,
        timeoutMs: selfUpdateTimeoutMs,
      }));
  const upgradeRestartPlanner =
    input.options?.upgradeRestartPlanner ??
    (() =>
      buildDefaultUpgradeRestartPlan({
        logger: input.logger,
      }));
  const upgradeVersionProbe = input.options?.upgradeVersionProbe ?? (() => probeInstalledVersion(selfUpdateTimeoutMs));

  return {
    matrixAdminUsers,
    upgradeAllowedUsers,
    upgradeLockOwner,
    selfUpdateRunner,
    upgradeRestartPlanner,
    upgradeVersionProbe,
  };
}
