import type { ConfigService } from "../config-service";
import type { RoomTriggerPolicyOverrides, TriggerPolicy } from "../config";
import { RateLimiter } from "../rate-limiter";
import type { OrchestratorOptions } from "./orchestrator-config-types";

export interface SessionRuntimeConfig {
  commandPrefix: string;
  matrixUserId: string;
  sessionActiveWindowMs: number;
  groupDirectModeEnabled: boolean;
  defaultGroupTriggerPolicy: TriggerPolicy;
  roomTriggerPolicies: RoomTriggerPolicyOverrides;
  configService: ConfigService | null;
  defaultCodexWorkdir: string;
  rateLimiter: RateLimiter;
}

export function resolveSessionRuntimeConfig(options?: OrchestratorOptions): SessionRuntimeConfig {
  const sessionActiveWindowMinutes = options?.sessionActiveWindowMinutes ?? 20;
  return {
    commandPrefix: (options?.commandPrefix ?? "").trim(),
    matrixUserId: options?.matrixUserId ?? "",
    sessionActiveWindowMs: Math.max(1, sessionActiveWindowMinutes) * 60_000,
    groupDirectModeEnabled: options?.groupDirectModeEnabled ?? false,
    defaultGroupTriggerPolicy: options?.defaultGroupTriggerPolicy ?? {
      allowMention: true,
      allowReply: true,
      allowActiveWindow: true,
      allowPrefix: true,
    },
    roomTriggerPolicies: options?.roomTriggerPolicies ?? {},
    configService: options?.configService ?? null,
    defaultCodexWorkdir: options?.defaultCodexWorkdir ?? process.cwd(),
    rateLimiter: new RateLimiter(
      options?.rateLimiterOptions ?? {
        windowMs: 60_000,
        maxRequestsPerUser: 20,
        maxRequestsPerRoom: 120,
        maxConcurrentGlobal: 8,
        maxConcurrentPerUser: 1,
        maxConcurrentPerRoom: 4,
      },
    ),
  };
}
