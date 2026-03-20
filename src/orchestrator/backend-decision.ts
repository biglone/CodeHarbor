import type { Logger } from "../logger";
import type {
  BackendModelRouteDecision,
  BackendModelRouteInput,
  BackendModelRouteProfile,
  BackendModelRouteTaskType,
} from "../routing/backend-model-router";
import type { InboundMessage } from "../types";

interface SessionBackendOverrideLike {
  profile: BackendModelRouteProfile;
}

interface SessionBackendDecisionLike {
  profile: BackendModelRouteProfile;
  source: "manual_override" | "rule" | "default";
  reasonCode: "manual_override" | "rule_match" | "default_fallback" | "factory_unavailable";
  ruleId: string | null;
}

interface ResolveSessionBackendDecisionDeps {
  sessionBackendOverrides: Map<string, SessionBackendOverrideLike>;
  resolveBackendRoute: (input: BackendModelRouteInput, fallback: BackendModelRouteProfile) => BackendModelRouteDecision;
  defaultBackendProfile: BackendModelRouteProfile;
  canCreateBackendRuntime: boolean;
  hasBackendRuntime: (profile: BackendModelRouteProfile) => boolean;
  logger: Logger;
}

interface ResolveSessionBackendDecisionInput {
  sessionKey: string;
  message: InboundMessage;
  taskType: BackendModelRouteTaskType;
  routePrompt: string;
}

export function resolveSessionBackendDecision(
  deps: ResolveSessionBackendDecisionDeps,
  input: ResolveSessionBackendDecisionInput,
): SessionBackendDecisionLike {
  const manualOverride = deps.sessionBackendOverrides.get(input.sessionKey);
  if (manualOverride) {
    return {
      profile: manualOverride.profile,
      source: "manual_override",
      reasonCode: "manual_override",
      ruleId: null,
    };
  }

  const routeInput: BackendModelRouteInput = {
    roomId: input.message.conversationId,
    senderId: input.message.senderId,
    taskType: input.taskType,
    directMessage: input.message.isDirectMessage,
    text: input.routePrompt,
  };
  const routed = deps.resolveBackendRoute(routeInput, deps.defaultBackendProfile);
  if (!deps.canCreateBackendRuntime && !deps.hasBackendRuntime(routed.profile)) {
    if (
      routed.profile.provider !== deps.defaultBackendProfile.provider ||
      routed.profile.model !== deps.defaultBackendProfile.model
    ) {
      deps.logger.warn("Backend/model rule matched but executorFactory is unavailable; falling back to default backend.", {
        sessionKey: input.sessionKey,
        matchedProvider: routed.profile.provider,
        matchedModel: routed.profile.model,
        defaultProvider: deps.defaultBackendProfile.provider,
        defaultModel: deps.defaultBackendProfile.model,
        ruleId: routed.ruleId,
        taskType: input.taskType,
      });
    }
    return {
      profile: deps.defaultBackendProfile,
      source: "default",
      reasonCode: "factory_unavailable",
      ruleId: routed.ruleId,
    };
  }

  return {
    profile: routed.profile,
    source: routed.source,
    reasonCode: routed.reasonCode,
    ruleId: routed.ruleId,
  };
}
