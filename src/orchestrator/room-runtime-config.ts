import type { ConfigService } from "../config-service";
import { TriggerPolicy, type RoomTriggerPolicyOverrides } from "../config";
import type { RoomRuntimeConfig } from "./orchestrator-types";

export function resolveGroupPolicy(
  conversationId: string,
  roomTriggerPolicies: RoomTriggerPolicyOverrides,
  defaultGroupTriggerPolicy: TriggerPolicy,
): TriggerPolicy {
  const override = roomTriggerPolicies[conversationId] ?? {};
  return {
    allowMention: override.allowMention ?? defaultGroupTriggerPolicy.allowMention,
    allowReply: override.allowReply ?? defaultGroupTriggerPolicy.allowReply,
    allowActiveWindow: override.allowActiveWindow ?? defaultGroupTriggerPolicy.allowActiveWindow,
    allowPrefix: override.allowPrefix ?? defaultGroupTriggerPolicy.allowPrefix,
  };
}

export function resolveRoomRuntimeConfig(input: {
  conversationId: string;
  configService: ConfigService | null;
  roomTriggerPolicies: RoomTriggerPolicyOverrides;
  defaultGroupTriggerPolicy: TriggerPolicy;
  defaultCodexWorkdir: string;
}): RoomRuntimeConfig {
  const fallbackPolicy = resolveGroupPolicy(
    input.conversationId,
    input.roomTriggerPolicies,
    input.defaultGroupTriggerPolicy,
  );
  if (!input.configService) {
    return {
      source: "default",
      enabled: true,
      triggerPolicy: fallbackPolicy,
      workdir: input.defaultCodexWorkdir,
    };
  }

  return input.configService.resolveRoomConfig(input.conversationId, fallbackPolicy);
}
