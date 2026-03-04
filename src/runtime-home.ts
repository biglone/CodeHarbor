import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LEGACY_RUNTIME_HOME = "/opt/codeharbor";
export const USER_RUNTIME_HOME_DIR = ".codeharbor";
export const DEFAULT_RUNTIME_HOME = path.resolve(os.homedir(), USER_RUNTIME_HOME_DIR);
export const RUNTIME_HOME_ENV_KEY = "CODEHARBOR_HOME";

export function resolveRuntimeHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[RUNTIME_HOME_ENV_KEY]?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  // Backward compatibility: keep existing /opt deployments if .env already exists there.
  const legacyEnvPath = path.resolve(LEGACY_RUNTIME_HOME, ".env");
  if (fs.existsSync(legacyEnvPath)) {
    return LEGACY_RUNTIME_HOME;
  }

  return resolveUserRuntimeHome(env);
}

export function resolveUserRuntimeHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || os.homedir();
  return path.resolve(home, USER_RUNTIME_HOME_DIR);
}
