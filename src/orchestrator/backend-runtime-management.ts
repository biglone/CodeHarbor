import { CodexSessionRuntime } from "../executor/codex-session-runtime";
import type { CodexExecutor } from "../executor/codex-executor";
import type { BackendModelRouteProfile } from "../routing/backend-model-router";
import type { WorkflowRunSnapshot } from "../workflow/multi-agent-workflow";
import type { AutoDevRunSnapshot } from "./autodev-runner";
import { isSameBackendProfile, normalizeBackendProfile } from "./command-routing";
import { serializeBackendProfile } from "./backend-runtime-registry";
import type { BackendRuntimeBundle } from "./orchestrator-types";

interface BackendStateStoreLike {
  getCodexSessionId: (sessionKey: string) => string | null;
  clearCodexSessionId: (sessionKey: string) => void;
}

export function prepareBackendRuntimeForSession(input: {
  sessionKey: string;
  profile: BackendModelRouteProfile;
  defaultBackendProfile: BackendModelRouteProfile;
  stateStore: BackendStateStoreLike;
  sessionBackendProfiles: Map<string, BackendModelRouteProfile>;
  workflowSnapshots: Map<string, WorkflowRunSnapshot>;
  autoDevSnapshots: Map<string, AutoDevRunSnapshot>;
  clearSessionFromAllRuntimes: (sessionKey: string) => void;
  ensureBackendRuntime: (profile: BackendModelRouteProfile) => BackendRuntimeBundle;
}): BackendRuntimeBundle {
  const nextProfile = normalizeBackendProfile(input.profile);
  const previousProfile = input.sessionBackendProfiles.get(input.sessionKey);
  const hasPersistedSession = input.stateStore.getCodexSessionId(input.sessionKey) !== null;

  const shouldResetSession =
    previousProfile !== undefined
      ? !isSameBackendProfile(previousProfile, nextProfile)
      : hasPersistedSession && !isSameBackendProfile(input.defaultBackendProfile, nextProfile);
  if (shouldResetSession) {
    input.stateStore.clearCodexSessionId(input.sessionKey);
    input.clearSessionFromAllRuntimes(input.sessionKey);
    input.workflowSnapshots.delete(input.sessionKey);
    input.autoDevSnapshots.delete(input.sessionKey);
  }

  const runtime = input.ensureBackendRuntime(nextProfile);
  input.sessionBackendProfiles.set(input.sessionKey, nextProfile);
  return runtime;
}

export function ensureBackendRuntime(input: {
  profile: BackendModelRouteProfile;
  backendRuntimes: Map<string, BackendRuntimeBundle>;
  executorFactory: ((provider: "codex" | "claude" | "gemini", model?: string | null) => CodexExecutor) | null;
}): BackendRuntimeBundle {
  const normalized = normalizeBackendProfile(input.profile);
  const key = serializeBackendProfile(normalized);
  const existing = input.backendRuntimes.get(key);
  if (existing) {
    return existing;
  }
  if (!input.executorFactory) {
    throw new Error("Backend executor factory is unavailable.");
  }
  const executor = input.executorFactory(normalized.provider, normalized.model);
  const bundle: BackendRuntimeBundle = {
    profile: normalized,
    executor,
    sessionRuntime: new CodexSessionRuntime(executor),
  };
  input.backendRuntimes.set(key, bundle);
  return bundle;
}
