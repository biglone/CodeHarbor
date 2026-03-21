import type { BackendModelRouteProfile } from "../routing/backend-model-router";
import type { SessionBackendOverride } from "./orchestrator-types";

export function resolveSessionBackendStatusProfile(input: {
  sessionKey: string;
  sessionBackendOverrides: Map<string, SessionBackendOverride>;
  sessionBackendProfiles: Map<string, BackendModelRouteProfile>;
  defaultBackendProfile: BackendModelRouteProfile;
}): BackendModelRouteProfile {
  const override = input.sessionBackendOverrides.get(input.sessionKey);
  if (override) {
    return override.profile;
  }
  return input.sessionBackendProfiles.get(input.sessionKey) ?? input.defaultBackendProfile;
}

export function resolveManualBackendProfile(
  input: {
    provider: "codex" | "claude";
    model?: string | null;
  },
  defaultBackendProfile: BackendModelRouteProfile,
): BackendModelRouteProfile {
  const normalizedInputModel = typeof input.model === "string" ? input.model.trim() || null : null;
  if (normalizedInputModel !== null) {
    return {
      provider: input.provider,
      model: normalizedInputModel,
    };
  }
  const model = input.provider === defaultBackendProfile.provider ? defaultBackendProfile.model : null;
  return {
    provider: input.provider,
    model,
  };
}
