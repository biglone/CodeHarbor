import type { ConfigService } from "../config-service";
import type { RoomTriggerPolicyOverrides, TriggerPolicy } from "../config";
import { createRedisSharedRateLimiterBackend } from "../rate-limiter-shared-redis";
import { RateLimiter, type RateLimiterLike, type SharedRateLimiterOptions } from "../rate-limiter";
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
  rateLimiter: RateLimiterLike;
}

export function resolveSessionRuntimeConfig(options?: OrchestratorOptions): SessionRuntimeConfig {
  const sessionActiveWindowMinutes = options?.sessionActiveWindowMinutes ?? 20;
  const sharedRateLimiterOptions = normalizeSharedRateLimiterOptions(options?.sharedRateLimiterOptions);
  const sharedBackend = createRedisSharedRateLimiterBackend(sharedRateLimiterOptions);
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
      {
        sharedBackend,
        fallbackToLocal: sharedRateLimiterOptions.fallbackToLocal,
        sharedMode: sharedRateLimiterOptions.mode,
      },
    ),
  };
}

function normalizeSharedRateLimiterOptions(input: SharedRateLimiterOptions | undefined): SharedRateLimiterOptions {
  const mode = input?.mode === "redis" ? "redis" : "local";
  return {
    mode,
    redisUrl: input?.redisUrl?.trim() || null,
    redisKeyPrefix: input?.redisKeyPrefix?.trim() || "codeharbor:rate-limit:v1",
    redisCommandTimeoutMs:
      typeof input?.redisCommandTimeoutMs === "number" && Number.isFinite(input.redisCommandTimeoutMs)
        ? Math.max(50, Math.floor(input.redisCommandTimeoutMs))
        : 150,
    redisConcurrencyTtlMs:
      typeof input?.redisConcurrencyTtlMs === "number" && Number.isFinite(input.redisConcurrencyTtlMs)
        ? Math.max(1_000, Math.floor(input.redisConcurrencyTtlMs))
        : 30 * 60 * 1_000,
    fallbackToLocal: input?.fallbackToLocal ?? true,
  };
}
