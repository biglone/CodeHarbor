import type { CodexExecutor } from "../executor/codex-executor";
import { CodexSessionRuntime } from "../executor/codex-session-runtime";
import { BackendModelRouter, type BackendModelRouteProfile } from "../routing/backend-model-router";
import type { BackendRuntimeBundle } from "./orchestrator-types";
import type { OrchestratorOptions } from "./orchestrator-config-types";
import { serializeBackendProfile } from "./backend-runtime-registry";

export interface BackendRuntimeConfig {
  executorFactory: ((provider: "codex" | "claude", model?: string | null) => CodexExecutor) | null;
  defaultBackendProfile: BackendModelRouteProfile;
  backendModelRouter: BackendModelRouter;
  defaultBackendRuntimeKey: string;
  defaultBackendRuntimeBundle: BackendRuntimeBundle;
}

export function resolveBackendRuntimeConfig(input: {
  options: OrchestratorOptions | undefined;
  executor: CodexExecutor;
}): BackendRuntimeConfig {
  const defaultBackendProfile: BackendModelRouteProfile = {
    provider: input.options?.aiCliProvider ?? "codex",
    model: input.options?.aiCliModel?.trim() || null,
  };

  return {
    executorFactory: input.options?.executorFactory ?? null,
    defaultBackendProfile,
    backendModelRouter: new BackendModelRouter(input.options?.backendModelRoutingRules ?? []),
    defaultBackendRuntimeKey: serializeBackendProfile(defaultBackendProfile),
    defaultBackendRuntimeBundle: {
      profile: defaultBackendProfile,
      executor: input.executor,
      sessionRuntime: new CodexSessionRuntime(input.executor),
    },
  };
}
