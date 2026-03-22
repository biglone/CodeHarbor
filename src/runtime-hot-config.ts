import { AppConfig, TriggerPolicy, type OutputLanguage } from "./config";
import { RateLimiterOptions } from "./rate-limiter";

export const GLOBAL_RUNTIME_HOT_CONFIG_KEY = "global_hot_config";

export const HOT_GLOBAL_CONFIG_KEYS = new Set<string>([
  "rateLimiter.windowMs",
  "rateLimiter.maxRequestsPerUser",
  "rateLimiter.maxRequestsPerRoom",
  "rateLimiter.maxConcurrentGlobal",
  "rateLimiter.maxConcurrentPerUser",
  "rateLimiter.maxConcurrentPerRoom",
  "matrixProgressUpdates",
  "matrixProgressMinIntervalMs",
  "matrixTypingTimeoutMs",
  "sessionActiveWindowMinutes",
  "groupDirectModeEnabled",
  "defaultGroupTriggerPolicy.allowMention",
  "defaultGroupTriggerPolicy.allowReply",
  "defaultGroupTriggerPolicy.allowActiveWindow",
  "defaultGroupTriggerPolicy.allowPrefix",
  "outputLanguage",
]);

export interface RuntimeHotConfigPayload {
  rateLimiter: RateLimiterOptions;
  matrixProgressUpdates: boolean;
  matrixProgressMinIntervalMs: number;
  matrixTypingTimeoutMs: number;
  sessionActiveWindowMinutes: number;
  groupDirectModeEnabled: boolean;
  defaultGroupTriggerPolicy: TriggerPolicy;
  outputLanguage?: OutputLanguage;
}

export function isHotGlobalConfigKey(key: string): boolean {
  return HOT_GLOBAL_CONFIG_KEYS.has(key);
}

export function buildRuntimeHotConfigPayload(config: AppConfig): RuntimeHotConfigPayload {
  return {
    rateLimiter: {
      windowMs: config.rateLimiter.windowMs,
      maxRequestsPerUser: config.rateLimiter.maxRequestsPerUser,
      maxRequestsPerRoom: config.rateLimiter.maxRequestsPerRoom,
      maxConcurrentGlobal: config.rateLimiter.maxConcurrentGlobal,
      maxConcurrentPerUser: config.rateLimiter.maxConcurrentPerUser,
      maxConcurrentPerRoom: config.rateLimiter.maxConcurrentPerRoom,
    },
    matrixProgressUpdates: config.matrixProgressUpdates,
    matrixProgressMinIntervalMs: config.matrixProgressMinIntervalMs,
    matrixTypingTimeoutMs: config.matrixTypingTimeoutMs,
    sessionActiveWindowMinutes: config.sessionActiveWindowMinutes,
    groupDirectModeEnabled: config.groupDirectModeEnabled,
    defaultGroupTriggerPolicy: {
      allowMention: config.defaultGroupTriggerPolicy.allowMention,
      allowReply: config.defaultGroupTriggerPolicy.allowReply,
      allowActiveWindow: config.defaultGroupTriggerPolicy.allowActiveWindow,
      allowPrefix: config.defaultGroupTriggerPolicy.allowPrefix,
    },
    outputLanguage: config.outputLanguage,
  };
}

export function parseRuntimeHotConfigPayload(payloadJson: string): RuntimeHotConfigPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
  try {
    return normalizeRuntimeHotConfigPayload(parsed);
  } catch {
    return null;
  }
}

function normalizeRuntimeHotConfigPayload(value: unknown): RuntimeHotConfigPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const rateLimiter = asRecord(record.rateLimiter);
  const policy = asRecord(record.defaultGroupTriggerPolicy);
  if (!rateLimiter || !policy) {
    return null;
  }

  const normalized: RuntimeHotConfigPayload = {
    rateLimiter: {
      windowMs: asInteger(rateLimiter.windowMs, 1),
      maxRequestsPerUser: asInteger(rateLimiter.maxRequestsPerUser, 0),
      maxRequestsPerRoom: asInteger(rateLimiter.maxRequestsPerRoom, 0),
      maxConcurrentGlobal: asInteger(rateLimiter.maxConcurrentGlobal, 0),
      maxConcurrentPerUser: asInteger(rateLimiter.maxConcurrentPerUser, 0),
      maxConcurrentPerRoom: asInteger(rateLimiter.maxConcurrentPerRoom, 0),
    },
    matrixProgressUpdates: asBoolean(record.matrixProgressUpdates),
    matrixProgressMinIntervalMs: asInteger(record.matrixProgressMinIntervalMs, 1),
    matrixTypingTimeoutMs: asInteger(record.matrixTypingTimeoutMs, 1),
    sessionActiveWindowMinutes: asInteger(record.sessionActiveWindowMinutes, 1),
    groupDirectModeEnabled: asBoolean(record.groupDirectModeEnabled),
    defaultGroupTriggerPolicy: {
      allowMention: asBoolean(policy.allowMention),
      allowReply: asBoolean(policy.allowReply),
      allowActiveWindow: asBoolean(policy.allowActiveWindow),
      allowPrefix: asBoolean(policy.allowPrefix),
    },
    outputLanguage: asOptionalOutputLanguage(record.outputLanguage),
  };

  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Invalid runtime hot config payload.");
  }
  return value;
}

function asInteger(value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error("Invalid runtime hot config payload.");
  }
  return value;
}

function asOptionalOutputLanguage(value: unknown): OutputLanguage | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "zh" || value === "en") {
    return value;
  }
  throw new Error("Invalid runtime hot config payload.");
}
