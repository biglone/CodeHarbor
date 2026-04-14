import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";
import {
  isValidTokenScopePattern,
  normalizeTokenScopes,
  type TokenScopePattern,
} from "./auth/scope-matrix";
import type { SharedRateLimiterOptions } from "./rate-limiter";
import type { BackendModelRouteRule, BackendModelRouteTaskType } from "./routing/backend-model-router";
import type { WorkflowRole } from "./workflow/role-skills";

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
  imageMaxBytes: number;
  imageMaxCount: number;
  imageAllowedMimeTypes: string[];
  transcribeAudio: boolean;
  audioTranscribeModel: string;
  audioTranscribeTimeoutMs: number;
  audioTranscribeMaxChars: number;
  audioTranscribeMaxRetries: number;
  audioTranscribeRetryDelayMs: number;
  audioTranscribeMaxBytes: number;
  audioLocalWhisperCommand: string | null;
  audioLocalWhisperTimeoutMs: number;
  recordPath: string | null;
}

export interface UpdateCheckConfig {
  enabled: boolean;
  timeoutMs: number;
  ttlMs: number;
}

export type OutputLanguage = "zh" | "en";

export interface ExternalTaskIntegrationConfig {
  enabled: boolean;
  notifyWebhookUrl: string | null;
  ticketWebhookUrl: string | null;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  authToken: string | null;
}

export type AiCliProvider = "codex" | "claude" | "gemini";

export type AdminTokenRole = "admin" | "viewer";

export interface AdminTokenConfig {
  token: string;
  role: AdminTokenRole;
  actor: string | null;
  scopes?: TokenScopePattern[];
}

const configSchema = z
  .object({
    MATRIX_HOMESERVER: z.string().url(),
    MATRIX_USER_ID: z.string().min(1),
    MATRIX_ACCESS_TOKEN: z.string().min(1),
    MATRIX_COMMAND_PREFIX: z.string().default("!code"),
    OUTPUT_LANGUAGE: z.enum(["zh", "en"]).default("zh"),
    MATRIX_ADMIN_USERS: z.string().default(""),
    MATRIX_UPGRADE_ALLOWED_USERS: z.string().default(""),
    AI_CLI_PROVIDER: z.enum(["codex", "claude", "gemini"]).default("codex"),
    CODEX_BIN: z.string().default(""),
    CODEX_MODEL: z.string().optional(),
    CODEX_WORKDIR: z.string().default("."),
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
    AGENT_WORKFLOW_ENABLED: z
      .string()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
    AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS: z
      .string()
      .default("1")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().min(0).max(10)),
    AGENT_WORKFLOW_ROLE_SKILLS_ENABLED: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
    AGENT_WORKFLOW_ROLE_SKILLS_MODE: z.enum(["summary", "progressive", "full"]).default("progressive"),
    AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS: z.string().default(""),
    AGENT_WORKFLOW_ROLE_SKILLS_ROOTS: z.string().default(""),
    AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON: z.string().default(""),
    BOT_PROFILES_AUTO_RETIRE_DEFAULT_SINGLE_INSTANCE: z
      .string()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
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
    MATRIX_PROGRESS_DELIVERY_MODE: z.enum(["upsert", "timeline"]).default("upsert"),
    MATRIX_TYPING_TIMEOUT_MS: z
      .string()
      .default("10000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    MATRIX_NOTICE_BADGE_ENABLED: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
    SESSION_ACTIVE_WINDOW_MINUTES: z
      .string()
      .default("20")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    GROUP_DIRECT_MODE_ENABLED: z
      .string()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
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
    BACKEND_MODEL_ROUTING_RULES_JSON: z.string().default(""),
    CONTEXT_BRIDGE_HISTORY_LIMIT: z
      .string()
      .default("16")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().min(1).max(100)),
    CONTEXT_BRIDGE_MAX_CHARS: z
      .string()
      .default("8000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().min(200).max(40_000)),
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
    RATE_LIMIT_SHARED_MODE: z.enum(["local", "redis"]).default("local"),
    RATE_LIMIT_SHARED_REDIS_URL: z.string().default(""),
    RATE_LIMIT_SHARED_REDIS_KEY_PREFIX: z.string().default("codeharbor:rate-limit:v1"),
    RATE_LIMIT_SHARED_REDIS_COMMAND_TIMEOUT_MS: z
      .string()
      .default("150")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    RATE_LIMIT_SHARED_REDIS_CONCURRENCY_TTL_MS: z
      .string()
      .default("1800000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    RATE_LIMIT_SHARED_FALLBACK_TO_LOCAL: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
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
    CLI_COMPAT_IMAGE_MAX_BYTES: z
      .string()
      .default("10485760")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    CLI_COMPAT_IMAGE_MAX_COUNT: z
      .string()
      .default("4")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES: z.string().default("image/png,image/jpeg,image/webp,image/gif"),
    CLI_COMPAT_TRANSCRIBE_AUDIO: z
      .string()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),
    CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS: z
      .string()
      .default("120000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS: z
      .string()
      .default("6000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES: z
      .string()
      .default("1")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().min(0).max(10)),
    CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS: z
      .string()
      .default("800")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().nonnegative()),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES: z
      .string()
      .default("26214400")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND: z.string().default(""),
    CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS: z
      .string()
      .default("180000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    CLI_COMPAT_RECORD_PATH: z.string().default(""),
    PACKAGE_UPDATE_CHECK_ENABLED: z
      .string()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),
    PACKAGE_UPDATE_CHECK_TIMEOUT_MS: z
      .string()
      .default("3000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    PACKAGE_UPDATE_CHECK_TTL_MS: z
      .string()
      .default("21600000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    DOCTOR_HTTP_TIMEOUT_MS: z
      .string()
      .default("10000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    API_ENABLED: z
      .string()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
    API_BIND_HOST: z.string().default("127.0.0.1"),
    API_PORT: z
      .string()
      .default("8788")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().min(1).max(65535)),
    API_TOKEN: z.string().default(""),
    API_TOKEN_SCOPES_JSON: z.string().default(""),
    API_WEBHOOK_SECRET: z.string().default(""),
    API_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: z
      .string()
      .default("300")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().min(0).max(86_400)),
    EXTERNAL_INTEGRATION_ENABLED: z
      .string()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
    EXTERNAL_NOTIFY_WEBHOOK_URL: z.string().default(""),
    EXTERNAL_TICKET_WEBHOOK_URL: z.string().default(""),
    EXTERNAL_INTEGRATION_TIMEOUT_MS: z
      .string()
      .default("3000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
    EXTERNAL_INTEGRATION_MAX_RETRIES: z
      .string()
      .default("1")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().min(0).max(10)),
    EXTERNAL_INTEGRATION_RETRY_DELAY_MS: z
      .string()
      .default("500")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().nonnegative()),
    EXTERNAL_INTEGRATION_AUTH_TOKEN: z.string().default(""),
    ADMIN_BIND_HOST: z.string().default("127.0.0.1"),
    ADMIN_PORT: z
      .string()
      .default("8787")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().min(1).max(65535)),
    ADMIN_TOKEN: z.string().default(""),
    ADMIN_TOKENS_JSON: z.string().default(""),
    ADMIN_IP_ALLOWLIST: z.string().default(""),
    ADMIN_ALLOWED_ORIGINS: z.string().default(""),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .transform((v) => ({
    matrixHomeserver: v.MATRIX_HOMESERVER,
    matrixUserId: v.MATRIX_USER_ID,
    matrixAccessToken: v.MATRIX_ACCESS_TOKEN,
    matrixCommandPrefix: v.MATRIX_COMMAND_PREFIX,
    outputLanguage: v.OUTPUT_LANGUAGE,
    matrixAdminUsers: parseCsvList(v.MATRIX_ADMIN_USERS),
    matrixUpgradeAllowedUsers: parseCsvList(v.MATRIX_UPGRADE_ALLOWED_USERS),
    aiCliProvider: v.AI_CLI_PROVIDER,
    codexBin: v.CODEX_BIN.trim() || defaultCliCommandForProvider(v.AI_CLI_PROVIDER),
    codexModel: v.CODEX_MODEL?.trim() || null,
    codexWorkdir: path.resolve(v.CODEX_WORKDIR),
    codexDangerousBypass: v.CODEX_DANGEROUS_BYPASS,
    codexExecTimeoutMs: v.CODEX_EXEC_TIMEOUT_MS,
    codexSandboxMode: v.CODEX_SANDBOX_MODE?.trim() || null,
    codexApprovalPolicy: v.CODEX_APPROVAL_POLICY?.trim() || null,
    codexExtraArgs: parseExtraArgs(v.CODEX_EXTRA_ARGS),
    codexExtraEnv: parseExtraEnv(v.CODEX_EXTRA_ENV_JSON),
    agentWorkflow: {
      enabled: v.AGENT_WORKFLOW_ENABLED,
      autoRepairMaxRounds: v.AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS,
      roleSkills: {
        enabled: v.AGENT_WORKFLOW_ROLE_SKILLS_ENABLED,
        mode: v.AGENT_WORKFLOW_ROLE_SKILLS_MODE,
        maxChars: parseOptionalPositiveInt(
          v.AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS,
          "AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS",
        ),
        roots: parseCsvList(v.AGENT_WORKFLOW_ROLE_SKILLS_ROOTS),
        roleAssignments: parseRoleSkillAssignments(v.AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON),
      },
    },
    botProfilesAutoRetireDefaultSingleInstance: v.BOT_PROFILES_AUTO_RETIRE_DEFAULT_SINGLE_INSTANCE,
    stateDbPath: path.resolve(v.STATE_DB_PATH),
    legacyStateJsonPath: v.STATE_PATH.trim() ? path.resolve(v.STATE_PATH) : null,
    maxProcessedEventsPerSession: v.MAX_PROCESSED_EVENTS_PER_SESSION,
    maxSessionAgeDays: v.MAX_SESSION_AGE_DAYS,
    maxSessions: v.MAX_SESSIONS,
    replyChunkSize: v.REPLY_CHUNK_SIZE,
    matrixProgressUpdates: v.MATRIX_PROGRESS_UPDATES,
    matrixProgressMinIntervalMs: v.MATRIX_PROGRESS_MIN_INTERVAL_MS,
    matrixProgressDeliveryMode: v.MATRIX_PROGRESS_DELIVERY_MODE,
    matrixTypingTimeoutMs: v.MATRIX_TYPING_TIMEOUT_MS,
    matrixNoticeBadgeEnabled: v.MATRIX_NOTICE_BADGE_ENABLED,
    sessionActiveWindowMinutes: v.SESSION_ACTIVE_WINDOW_MINUTES,
    groupDirectModeEnabled: v.GROUP_DIRECT_MODE_ENABLED,
    defaultGroupTriggerPolicy: {
      allowMention: v.GROUP_TRIGGER_ALLOW_MENTION,
      allowReply: v.GROUP_TRIGGER_ALLOW_REPLY,
      allowActiveWindow: v.GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW,
      allowPrefix: v.GROUP_TRIGGER_ALLOW_PREFIX,
    },
    roomTriggerPolicies: parseRoomTriggerPolicyOverrides(v.ROOM_TRIGGER_POLICY_JSON),
    backendModelRoutingRules: parseBackendModelRoutingRules(v.BACKEND_MODEL_ROUTING_RULES_JSON),
    contextBridgeHistoryLimit: v.CONTEXT_BRIDGE_HISTORY_LIMIT,
    contextBridgeMaxChars: v.CONTEXT_BRIDGE_MAX_CHARS,
    rateLimiter: {
      windowMs: v.RATE_LIMIT_WINDOW_SECONDS * 1000,
      maxRequestsPerUser: v.RATE_LIMIT_MAX_REQUESTS_PER_USER,
      maxRequestsPerRoom: v.RATE_LIMIT_MAX_REQUESTS_PER_ROOM,
      maxConcurrentGlobal: v.RATE_LIMIT_MAX_CONCURRENT_GLOBAL,
      maxConcurrentPerUser: v.RATE_LIMIT_MAX_CONCURRENT_PER_USER,
      maxConcurrentPerRoom: v.RATE_LIMIT_MAX_CONCURRENT_PER_ROOM,
    },
    sharedRateLimiter: {
      mode: v.RATE_LIMIT_SHARED_MODE,
      redisUrl: parseOptionalRedisUrl(v.RATE_LIMIT_SHARED_REDIS_URL, "RATE_LIMIT_SHARED_REDIS_URL"),
      redisKeyPrefix: v.RATE_LIMIT_SHARED_REDIS_KEY_PREFIX.trim() || "codeharbor:rate-limit:v1",
      redisCommandTimeoutMs: v.RATE_LIMIT_SHARED_REDIS_COMMAND_TIMEOUT_MS,
      redisConcurrencyTtlMs: v.RATE_LIMIT_SHARED_REDIS_CONCURRENCY_TTL_MS,
      fallbackToLocal: v.RATE_LIMIT_SHARED_FALLBACK_TO_LOCAL,
    } satisfies SharedRateLimiterOptions,
    cliCompat: {
      enabled: v.CLI_COMPAT_MODE,
      passThroughEvents: v.CLI_COMPAT_PASSTHROUGH_EVENTS,
      preserveWhitespace: v.CLI_COMPAT_PRESERVE_WHITESPACE,
      disableReplyChunkSplit: v.CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT,
      progressThrottleMs: v.CLI_COMPAT_PROGRESS_THROTTLE_MS,
      fetchMedia: v.CLI_COMPAT_FETCH_MEDIA,
      imageMaxBytes: v.CLI_COMPAT_IMAGE_MAX_BYTES,
      imageMaxCount: v.CLI_COMPAT_IMAGE_MAX_COUNT,
      imageAllowedMimeTypes: parseMimeTypeCsvList(
        v.CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES,
        ["image/png", "image/jpeg", "image/webp", "image/gif"],
      ),
      transcribeAudio: v.CLI_COMPAT_TRANSCRIBE_AUDIO,
      audioTranscribeModel: v.CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL.trim() || "gpt-4o-mini-transcribe",
      audioTranscribeTimeoutMs: v.CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS,
      audioTranscribeMaxChars: v.CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS,
      audioTranscribeMaxRetries: v.CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES,
      audioTranscribeRetryDelayMs: v.CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS,
      audioTranscribeMaxBytes: v.CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES,
      audioLocalWhisperCommand: v.CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND.trim()
        ? v.CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND.trim()
        : null,
      audioLocalWhisperTimeoutMs: v.CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS,
      recordPath: v.CLI_COMPAT_RECORD_PATH.trim() ? path.resolve(v.CLI_COMPAT_RECORD_PATH) : null,
    },
    updateCheck: {
      enabled: v.PACKAGE_UPDATE_CHECK_ENABLED,
      timeoutMs: v.PACKAGE_UPDATE_CHECK_TIMEOUT_MS,
      ttlMs: v.PACKAGE_UPDATE_CHECK_TTL_MS,
    },
    doctorHttpTimeoutMs: v.DOCTOR_HTTP_TIMEOUT_MS,
    apiEnabled: v.API_ENABLED,
    apiBindHost: v.API_BIND_HOST.trim() || "127.0.0.1",
    apiPort: v.API_PORT,
    apiToken: v.API_TOKEN.trim() || null,
    apiTokenScopes: parseApiTokenScopes(v.API_TOKEN_SCOPES_JSON),
    apiWebhookSecret: v.API_WEBHOOK_SECRET.trim() || null,
    apiWebhookTimestampToleranceSeconds: v.API_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    externalTaskIntegration: {
      enabled: v.EXTERNAL_INTEGRATION_ENABLED,
      notifyWebhookUrl: parseOptionalUrl(v.EXTERNAL_NOTIFY_WEBHOOK_URL, "EXTERNAL_NOTIFY_WEBHOOK_URL"),
      ticketWebhookUrl: parseOptionalUrl(v.EXTERNAL_TICKET_WEBHOOK_URL, "EXTERNAL_TICKET_WEBHOOK_URL"),
      timeoutMs: v.EXTERNAL_INTEGRATION_TIMEOUT_MS,
      maxRetries: v.EXTERNAL_INTEGRATION_MAX_RETRIES,
      retryDelayMs: v.EXTERNAL_INTEGRATION_RETRY_DELAY_MS,
      authToken: v.EXTERNAL_INTEGRATION_AUTH_TOKEN.trim() || null,
    },
    adminBindHost: v.ADMIN_BIND_HOST.trim() || "127.0.0.1",
    adminPort: v.ADMIN_PORT,
    adminToken: v.ADMIN_TOKEN.trim() || null,
    adminTokens: parseAdminTokens(v.ADMIN_TOKENS_JSON),
    adminIpAllowlist: parseCsvList(v.ADMIN_IP_ALLOWLIST),
    adminAllowedOrigins: parseCsvList(v.ADMIN_ALLOWED_ORIGINS),
    logLevel: v.LOG_LEVEL,
  }));

export type AppConfig = z.infer<typeof configSchema>;

export function loadEnvFromFile(filePath = path.resolve(process.cwd(), ".env"), env: NodeJS.ProcessEnv = process.env): void {
  dotenv.config({
    path: filePath,
    processEnv: env,
    quiet: true,
  });
}

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
  if (parsed.data.apiEnabled && !parsed.data.apiToken) {
    throw new Error("Invalid configuration: API_TOKEN is required when API_ENABLED=true.");
  }
  if (parsed.data.sharedRateLimiter.mode === "redis" && !parsed.data.sharedRateLimiter.redisUrl) {
    throw new Error("Invalid configuration: RATE_LIMIT_SHARED_REDIS_URL is required when RATE_LIMIT_SHARED_MODE=redis.");
  }
  if (
    parsed.data.externalTaskIntegration.enabled &&
    !parsed.data.externalTaskIntegration.notifyWebhookUrl &&
    !parsed.data.externalTaskIntegration.ticketWebhookUrl
  ) {
    throw new Error(
      "Invalid configuration: EXTERNAL_NOTIFY_WEBHOOK_URL or EXTERNAL_TICKET_WEBHOOK_URL is required when EXTERNAL_INTEGRATION_ENABLED=true.",
    );
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

const BACKEND_MODEL_ROUTE_TASK_TYPES: ReadonlySet<BackendModelRouteTaskType> = new Set([
  "chat",
  "workflow_run",
  "workflow_status",
  "autodev_run",
  "autodev_status",
  "autodev_stop",
  "control_command",
]);

function parseBackendModelRoutingRules(raw: string): BackendModelRouteRule[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("BACKEND_MODEL_ROUTING_RULES_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("BACKEND_MODEL_ROUTING_RULES_JSON must be a JSON array.");
  }

  return parsed.map((entry, index) => normalizeBackendModelRoutingRule(entry, index));
}

function normalizeBackendModelRoutingRule(entry: unknown, index: number): BackendModelRouteRule {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`BACKEND_MODEL_ROUTING_RULES_JSON[${index}] must be an object.`);
  }

  const payload = entry as Record<string, unknown>;
  const rawId = typeof payload.id === "string" ? payload.id.trim() : "";
  const id = rawId || `rule-${index + 1}`;
  const enabled = parseOptionalBoolean(payload.enabled, true, `BACKEND_MODEL_ROUTING_RULES_JSON[${index}].enabled`) ?? true;
  const priority = parseOptionalInteger(payload.priority, 0, `BACKEND_MODEL_ROUTING_RULES_JSON[${index}].priority`);

  const whenRaw = payload.when;
  if (whenRaw !== undefined && (!whenRaw || typeof whenRaw !== "object" || Array.isArray(whenRaw))) {
    throw new Error(`BACKEND_MODEL_ROUTING_RULES_JSON[${index}].when must be an object.`);
  }
  const whenPayload = (whenRaw ?? {}) as Record<string, unknown>;
  const roomIds = parseOptionalStringList(whenPayload.roomIds, `BACKEND_MODEL_ROUTING_RULES_JSON[${index}].when.roomIds`);
  const senderIds = parseOptionalStringList(
    whenPayload.senderIds,
    `BACKEND_MODEL_ROUTING_RULES_JSON[${index}].when.senderIds`,
  );
  const taskTypes = parseOptionalTaskTypeList(
    whenPayload.taskTypes,
    `BACKEND_MODEL_ROUTING_RULES_JSON[${index}].when.taskTypes`,
  );
  const textIncludes = parseOptionalStringList(
    whenPayload.textIncludes,
    `BACKEND_MODEL_ROUTING_RULES_JSON[${index}].when.textIncludes`,
  );
  const textRegex = parseOptionalString(whenPayload.textRegex, `BACKEND_MODEL_ROUTING_RULES_JSON[${index}].when.textRegex`);
  const directMessage = parseOptionalBoolean(
    whenPayload.directMessage,
    undefined,
    `BACKEND_MODEL_ROUTING_RULES_JSON[${index}].when.directMessage`,
  );

  if (!payload.target || typeof payload.target !== "object" || Array.isArray(payload.target)) {
    throw new Error(`BACKEND_MODEL_ROUTING_RULES_JSON[${index}].target must be an object.`);
  }
  const targetPayload = payload.target as Record<string, unknown>;
  const providerRaw = targetPayload.provider;
  let provider: "codex" | "claude" | "gemini" | undefined;
  if (providerRaw !== undefined) {
    if (providerRaw !== "codex" && providerRaw !== "claude" && providerRaw !== "gemini") {
      throw new Error(
        `BACKEND_MODEL_ROUTING_RULES_JSON[${index}].target.provider must be "codex", "claude", or "gemini".`,
      );
    }
    provider = providerRaw;
  }

  const modelRaw = targetPayload.model;
  let model: string | null | undefined;
  if (modelRaw !== undefined) {
    if (modelRaw !== null && typeof modelRaw !== "string") {
      throw new Error(`BACKEND_MODEL_ROUTING_RULES_JSON[${index}].target.model must be string or null.`);
    }
    const normalized = typeof modelRaw === "string" ? modelRaw.trim() : "";
    model = normalized || null;
  }

  if (provider === undefined && model === undefined) {
    throw new Error(
      `BACKEND_MODEL_ROUTING_RULES_JSON[${index}].target must include provider and/or model override.`,
    );
  }

  return {
    id,
    enabled,
    priority,
    when: {
      roomIds,
      senderIds,
      taskTypes,
      directMessage,
      textIncludes,
      textRegex,
    },
    target: {
      provider,
      model,
    },
  };
}

function parseOptionalBoolean(
  value: unknown,
  fallback: boolean | undefined,
  field: string,
): boolean | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be boolean.`);
  }
  return value;
}

function defaultCliCommandForProvider(provider: AiCliProvider): string {
  if (provider === "claude") {
    return "claude";
  }
  if (provider === "gemini") {
    return "gemini";
  }
  return "codex";
}

function parseOptionalInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }
  return value;
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be string.`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseOptionalUrl(raw: string, field: string): string | null {
  const normalized = raw.trim();
  if (!normalized) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    if (!parsed.protocol || !parsed.hostname) {
      throw new Error("invalid url");
    }
    return normalized;
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
}

function parseOptionalRedisUrl(raw: string, field: string): string | null {
  const normalized = parseOptionalUrl(raw, field);
  if (!normalized) {
    return null;
  }
  const protocol = new URL(normalized).protocol.toLowerCase();
  if (protocol !== "redis:" && protocol !== "rediss:") {
    throw new Error(`${field} must use redis:// or rediss://.`);
  }
  return normalized;
}

function parseOptionalStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a string array.`);
  }
  const output: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== "string") {
      throw new Error(`${field}[${i}] must be string.`);
    }
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    output.push(normalized);
  }
  return output.length > 0 ? output : undefined;
}

function parseOptionalTaskTypeList(value: unknown, field: string): BackendModelRouteTaskType[] | undefined {
  const list = parseOptionalStringList(value, field);
  if (!list) {
    return undefined;
  }
  const output: BackendModelRouteTaskType[] = [];
  for (const entry of list) {
    if (!BACKEND_MODEL_ROUTE_TASK_TYPES.has(entry as BackendModelRouteTaskType)) {
      throw new Error(`${field} includes unsupported task type "${entry}".`);
    }
    output.push(entry as BackendModelRouteTaskType);
  }
  return output.length > 0 ? output : undefined;
}

function parseExtraArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const args: string[] = [];
  let current = "";
  let quoteMode: "'" | '"' | null = null;
  let escaping = false;

  const pushCurrent = (): void => {
    if (!current) {
      return;
    }
    args.push(current);
    current = "";
  };

  for (const char of trimmed) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quoteMode === null) {
      if (/\s/.test(char)) {
        pushCurrent();
        continue;
      }
      if (char === "'" || char === '"') {
        quoteMode = char;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      current += char;
      continue;
    }

    if (char === quoteMode) {
      quoteMode = null;
      continue;
    }
    if (quoteMode === '"' && char === "\\") {
      escaping = true;
      continue;
    }
    current += char;
  }

  if (escaping || quoteMode !== null) {
    throw new Error("CODEX_EXTRA_ARGS contains unmatched quote or trailing escape.");
  }

  pushCurrent();
  return args;
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

function parseOptionalPositiveInt(raw: string, fieldName: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function parseRoleSkillAssignments(raw: string): Partial<Record<WorkflowRole, string[]>> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON must be a JSON object.");
  }

  const payload = parsed as Record<string, unknown>;
  const output: Partial<Record<WorkflowRole, string[]>> = {};
  for (const role of ["planner", "executor", "reviewer"] as WorkflowRole[]) {
    const value = payload[role];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new Error(`AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON.${role} must be a string array.`);
    }
    output[role] = dedupeStringList(
      value.map((entry, index) => {
        if (typeof entry !== "string") {
          throw new Error(`AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON.${role}[${index}] must be a string.`);
        }
        return entry;
      }),
    );
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function dedupeStringList(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(trimmed);
  }
  return output;
}

function parseMimeTypeCsvList(raw: string, fallback: string[]): string[] {
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .filter((entry) => /^[-\w.+]+\/[-\w.+]+$/.test(entry));

  if (parsed.length === 0) {
    return [...fallback];
  }

  return [...new Set(parsed)];
}

function parseApiTokenScopes(raw: string): TokenScopePattern[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("API_TOKEN_SCOPES_JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("API_TOKEN_SCOPES_JSON must be a JSON array.");
  }

  const rawScopes = parsed.map((scope, scopeIndex) => {
    if (typeof scope !== "string") {
      throw new Error(`API_TOKEN_SCOPES_JSON[${scopeIndex}] must be a string.`);
    }
    return scope;
  });

  const normalizedScopes = normalizeTokenScopes(rawScopes);
  if (normalizedScopes.length === 0) {
    throw new Error("API_TOKEN_SCOPES_JSON must include at least one non-empty scope.");
  }

  for (const scope of normalizedScopes) {
    if (!isValidTokenScopePattern(scope)) {
      throw new Error(`API_TOKEN_SCOPES_JSON contains invalid scope pattern: ${scope}.`);
    }
  }

  return normalizedScopes;
}

function parseAdminTokens(raw: string): AdminTokenConfig[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("ADMIN_TOKENS_JSON must be valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("ADMIN_TOKENS_JSON must be a JSON array.");
  }

  const seenTokens = new Set<string>();
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`ADMIN_TOKENS_JSON[${index}] must be an object.`);
    }

    const payload = entry as Record<string, unknown>;
    const tokenValue = payload.token;
    if (typeof tokenValue !== "string" || !tokenValue.trim()) {
      throw new Error(`ADMIN_TOKENS_JSON[${index}].token must be a non-empty string.`);
    }

    const token = tokenValue.trim();
    if (seenTokens.has(token)) {
      throw new Error(`ADMIN_TOKENS_JSON contains duplicated token at index ${index}.`);
    }
    seenTokens.add(token);

    let role: AdminTokenRole = "admin";
    if (payload.role !== undefined) {
      if (payload.role !== "admin" && payload.role !== "viewer") {
        throw new Error(`ADMIN_TOKENS_JSON[${index}].role must be "admin" or "viewer".`);
      }
      role = payload.role;
    }

    if (payload.actor !== undefined && payload.actor !== null && typeof payload.actor !== "string") {
      throw new Error(`ADMIN_TOKENS_JSON[${index}].actor must be a string when provided.`);
    }
    const actor = typeof payload.actor === "string" ? payload.actor.trim() || null : null;
    const scopes = parseAdminTokenScopes(payload.scopes, index);

    return {
      token,
      role,
      actor,
      ...(scopes.length > 0 ? { scopes } : {}),
    };
  });
}

function parseAdminTokenScopes(value: unknown, tokenIndex: number): TokenScopePattern[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`ADMIN_TOKENS_JSON[${tokenIndex}].scopes must be an array of strings when provided.`);
  }

  const rawScopes = value.map((scope, scopeIndex) => {
    if (typeof scope !== "string") {
      throw new Error(`ADMIN_TOKENS_JSON[${tokenIndex}].scopes[${scopeIndex}] must be a string.`);
    }
    return scope;
  });
  const normalizedScopes = normalizeTokenScopes(rawScopes);

  if (normalizedScopes.length === 0) {
    throw new Error(`ADMIN_TOKENS_JSON[${tokenIndex}].scopes must include at least one non-empty scope.`);
  }
  for (const scope of normalizedScopes) {
    if (!isValidTokenScopePattern(scope)) {
      throw new Error(
        `ADMIN_TOKENS_JSON[${tokenIndex}].scopes contains invalid scope pattern: ${scope}.`,
      );
    }
  }

  return normalizedScopes;
}
