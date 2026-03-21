import type { BackendModelRouteProfile } from "../routing/backend-model-router";
import { normalizeBackendProfile } from "./command-routing";
import type { BackendRuntimeBundle } from "./orchestrator-types";

export function hasBackendRuntime(
  backendRuntimes: Map<string, BackendRuntimeBundle>,
  profile: BackendModelRouteProfile,
): boolean {
  return backendRuntimes.has(serializeBackendProfile(profile));
}

export function serializeBackendProfile(profile: BackendModelRouteProfile): string {
  return JSON.stringify(normalizeBackendProfile(profile));
}

export function clearSessionFromAllRuntimes(
  backendRuntimes: Map<string, BackendRuntimeBundle>,
  sessionKey: string,
): void {
  for (const runtime of backendRuntimes.values()) {
    runtime.sessionRuntime.clearSession(sessionKey);
  }
}

export function cancelRunningExecutionInAllRuntimes(
  backendRuntimes: Map<string, BackendRuntimeBundle>,
  sessionKey: string,
): void {
  for (const runtime of backendRuntimes.values()) {
    runtime.sessionRuntime.cancelRunningExecution(sessionKey);
  }
}

export function getBackendRuntimeStats(backendRuntimes: Map<string, BackendRuntimeBundle>): {
  workerCount: number;
  runningCount: number;
} {
  let workerCount = 0;
  let runningCount = 0;
  for (const runtime of backendRuntimes.values()) {
    const stats = runtime.sessionRuntime.getRuntimeStats();
    workerCount += stats.workerCount;
    runningCount += stats.runningCount;
  }
  return {
    workerCount,
    runningCount,
  };
}
