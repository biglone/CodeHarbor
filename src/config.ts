import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

export interface TriggerPolicy {
  allowMention: boolean;
  allowReply: boolean;
  allowActiveWindow: boolean;
  allowPrefix: boolean;
}

export type RoomTriggerPolicyOverrides = Record<string, Partial<TriggerPolicy>>;

export interface CliCompatConfig {
  enabled: boolean;
  passThroughEvents: boolean;
  preserveWhitespace: boolean;
  disableReplyChunkSplit: boolean;
  progressThrottleMs: number;
  fetchMedia: boolean;
  recordPath: string | null;
}

const configSchema = z
  .object({
    MATRIX_HOMESERVER: z.string().url(),
    MATRIX_USER_ID: z.string().min(1),
    MATRIX_ACCESS_TOKEN: z.string().min(1),
    MATRIX_COMMAND_PREFIX: z.string().default("!code"),
    CODEX_BIN: z.string().default("codex"),
    CODEX_MODEL: z.string().optional(),
    CODEX_WORKDIR: z.string().default(process.cwd()),
    CODEX_DANGEROUS_BYPASS: z
      .string()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
    CODEX_EXEC_TIMEOUT_MS: z
      .string()
      .default("600000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    CODEX_SANDBOX_MODE: z.string().optional(),
    CODEX_APPROVAL_POLICY: z.string().optional(),
    CODEX_EXTRA_ARGS: z.string().default(""),
    CODEX_EXTRA_ENV_JSON: z.string().default(""),
    STATE_DB_PATH: z.string().default("data/state.db"),
    STATE_PATH: z.string().default("data/state.json"),
    MAX_PROCESSED_EVENTS_PER_SESSION: z
      .string()
      .default("200")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    MAX_SESSION_AGE_DAYS: z
      .string()
      .default("30")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    MAX_SESSIONS: z
      .string()
      .default("5000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    REPLY_CHUNK_SIZE: z
      .string()
      .default("3500")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    MATRIX_PROGRESS_UPDATES: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
    MATRIX_PROGRESS_MIN_INTERVAL_MS: z
      .string()
      .default("2500")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    MATRIX_TYPING_TIMEOUT_MS: z
      .string()
      .default("10000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    SESSION_ACTIVE_WINDOW_MINUTES: z
      .string()
      .default("20")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    GROUP_TRIGGER_ALLOW_MENTION: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
    GROUP_TRIGGER_ALLOW_REPLY: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
    GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
    GROUP_TRIGGER_ALLOW_PREFIX: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
    ROOM_TRIGGER_POLICY_JSON: z.string().default(""),
    RATE_LIMIT_WINDOW_SECONDS: z
      .string()
      .default("60")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    RATE_LIMIT_MAX_REQUESTS_PER_USER: z
      .string()
      .default("20")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().nonnegative()),
    RATE_LIMIT_MAX_REQUESTS_PER_ROOM: z
      .string()
      .default("120")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().nonnegative()),
    RATE_LIMIT_MAX_CONCURRENT_GLOBAL: z
      .string()
      .default("8")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().nonnegative()),
    RATE_LIMIT_MAX_CONCURRENT_PER_USER: z
      .string()
      .default("1")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().nonnegative()),
    RATE_LIMIT_MAX_CONCURRENT_PER_ROOM: z
      .string()
      .default("4")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().nonnegative()),
    CLI_COMPAT_MODE: z
      .string()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
    CLI_COMPAT_PASSTHROUGH_EVENTS: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
    CLI_COMPAT_PRESERVE_WHITESPACE: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
    CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT: z
      .string()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
    CLI_COMPAT_PROGRESS_THROTTLE_MS: z
      .string()
      .default("300")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().nonnegative()),
    CLI_COMPAT_FETCH_MEDIA: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
    CLI_COMPAT_RECORD_PATH: z.string().default(""),
    DOCTOR_HTTP_TIMEOUT_MS: z
      .string()
      .default("10000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    ADMIN_BIND_HOST: z.string().default("127.0.0.1"),
    ADMIN_PORT: z
      .string()
      .default("8787")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().min(1).max(65535)),
    ADMIN_TOKEN: z.string().default(""),
    ADMIN_IP_ALLOWLIST: z.string().default(""),
    ADMIN_ALLOWED_ORIGINS: z.string().default(""),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .transform((v) => ({
    matrixHomeserver: v.MATRIX_HOMESERVER,
    matrixUserId: v.MATRIX_USER_ID,
    matrixAccessToken: v.MATRIX_ACCESS_TOKEN,
    matrixCommandPrefix: v.MATRIX_COMMAND_PREFIX,
    codexBin: v.CODEX_BIN,
    codexModel: v.CODEX_MODEL?.trim() || null,
    codexWorkdir: path.resolve(v.CODEX_WORKDIR),
    codexDangerousBypass: v.CODEX_DANGEROUS_BYPASS,
    codexExecTimeoutMs: v.CODEX_EXEC_TIMEOUT_MS,
    codexSandboxMode: v.CODEX_SANDBOX_MODE?.trim() || null,
    codexApprovalPolicy: v.CODEX_APPROVAL_POLICY?.trim() || null,
    codexExtraArgs: parseExtraArgs(v.CODEX_EXTRA_ARGS),
    codexExtraEnv: parseExtraEnv(v.CODEX_EXTRA_ENV_JSON),
    stateDbPath: path.resolve(v.STATE_DB_PATH),
    legacyStateJsonPath: v.STATE_PATH.trim() ? path.resolve(v.STATE_PATH) : null,
    maxProcessedEventsPerSession: v.MAX_PROCESSED_EVENTS_PER_SESSION,
    maxSessionAgeDays: v.MAX_SESSION_AGE_DAYS,
    maxSessions: v.MAX_SESSIONS,
    replyChunkSize: v.REPLY_CHUNK_SIZE,
    matrixProgressUpdates: v.MATRIX_PROGRESS_UPDATES,
    matrixProgressMinIntervalMs: v.MATRIX_PROGRESS_MIN_INTERVAL_MS,
    matrixTypingTimeoutMs: v.MATRIX_TYPING_TIMEOUT_MS,
    sessionActiveWindowMinutes: v.SESSION_ACTIVE_WINDOW_MINUTES,
    defaultGroupTriggerPolicy: {
      allowMention: v.GROUP_TRIGGER_ALLOW_MENTION,
      allowReply: v.GROUP_TRIGGER_ALLOW_REPLY,
      allowActiveWindow: v.GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW,
      allowPrefix: v.GROUP_TRIGGER_ALLOW_PREFIX,
    },
    roomTriggerPolicies: parseRoomTriggerPolicyOverrides(v.ROOM_TRIGGER_POLICY_JSON),
    rateLimiter: {
      windowMs: v.RATE_LIMIT_WINDOW_SECONDS * 1000,
      maxRequestsPerUser: v.RATE_LIMIT_MAX_REQUESTS_PER_USER,
      maxRequestsPerRoom: v.RATE_LIMIT_MAX_REQUESTS_PER_ROOM,
      maxConcurrentGlobal: v.RATE_LIMIT_MAX_CONCURRENT_GLOBAL,
      maxConcurrentPerUser: v.RATE_LIMIT_MAX_CONCURRENT_PER_USER,
      maxConcurrentPerRoom: v.RATE_LIMIT_MAX_CONCURRENT_PER_ROOM,
    },
    cliCompat: {
      enabled: v.CLI_COMPAT_MODE,
      passThroughEvents: v.CLI_COMPAT_PASSTHROUGH_EVENTS,
      preserveWhitespace: v.CLI_COMPAT_PRESERVE_WHITESPACE,
      disableReplyChunkSplit: v.CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT,
      progressThrottleMs: v.CLI_COMPAT_PROGRESS_THROTTLE_MS,
      fetchMedia: v.CLI_COMPAT_FETCH_MEDIA,
      recordPath: v.CLI_COMPAT_RECORD_PATH.trim() ? path.resolve(v.CLI_COMPAT_RECORD_PATH) : null,
    },
    doctorHttpTimeoutMs: v.DOCTOR_HTTP_TIMEOUT_MS,
    adminBindHost: v.ADMIN_BIND_HOST.trim() || "127.0.0.1",
    adminPort: v.ADMIN_PORT,
    adminToken: v.ADMIN_TOKEN.trim() || null,
    adminIpAllowlist: parseCsvList(v.ADMIN_IP_ALLOWLIST),
    adminAllowedOrigins: parseCsvList(v.ADMIN_ALLOWED_ORIGINS),
    logLevel: v.LOG_LEVEL,
  }));

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${message}`);
  }

  fs.mkdirSync(path.dirname(parsed.data.stateDbPath), { recursive: true });
  if (parsed.data.legacyStateJsonPath) {
    fs.mkdirSync(path.dirname(parsed.data.legacyStateJsonPath), { recursive: true });
  }

  return parsed.data;
}

function parseRoomTriggerPolicyOverrides(raw: string): RoomTriggerPolicyOverrides {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("ROOM_TRIGGER_POLICY_JSON must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ROOM_TRIGGER_POLICY_JSON must be an object keyed by room id.");
  }

  const output: RoomTriggerPolicyOverrides = {};
  for (const [roomId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`ROOM_TRIGGER_POLICY_JSON[${roomId}] must be an object.`);
    }

    const item = value as Record<string, unknown>;
    const override: Partial<TriggerPolicy> = {};

    for (const key of ["allowMention", "allowReply", "allowActiveWindow", "allowPrefix"] as const) {
      if (item[key] === undefined) {
        continue;
      }
      if (typeof item[key] !== "boolean") {
        throw new Error(`ROOM_TRIGGER_POLICY_JSON[${roomId}].${key} must be boolean.`);
      }
      override[key] = item[key] as boolean;
    }

    output[roomId] = override;
  }

  return output;
}

function parseExtraArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseExtraEnv(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("CODEX_EXTRA_ENV_JSON must be valid JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CODEX_EXTRA_ENV_JSON must be a key/value object.");
  }
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`CODEX_EXTRA_ENV_JSON[${key}] must be string.`);
    }
    output[key] = value;
  }
  return output;
}

function parseCsvList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
