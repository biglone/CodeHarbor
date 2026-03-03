import path from "node:path";

export const DEFAULT_RUNTIME_HOME = "/opt/codeharbor";
export const RUNTIME_HOME_ENV_KEY = "CODEHARBOR_HOME";

export function resolveRuntimeHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[RUNTIME_HOME_ENV_KEY]?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return DEFAULT_RUNTIME_HOME;
}
