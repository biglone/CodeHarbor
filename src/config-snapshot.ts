import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { loadConfig, type AdminTokenConfig, type AppConfig } from "./config";
import { applyEnvOverrides } from "./init";
import { RoomSettingsRecord, RoomSettingsUpsertInput, StateStore } from "./store/state-store";
import { resolveLaunchdLabelConfig } from "./upgrade-platform";

export const CONFIG_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const CONFIG_SNAPSHOT_ENV_KEYS = [
  "MATRIX_HOMESERVER",
  "MATRIX_USER_ID",
  "MATRIX_ACCESS_TOKEN",
  "MATRIX_COMMAND_PREFIX",
  "OUTPUT_LANGUAGE",
  "MATRIX_ADMIN_USERS",
  "MATRIX_UPGRADE_ALLOWED_USERS",
  "AI_CLI_PROVIDER",
  "CODEX_BIN",
  "CODEX_MODEL",
  "CODEX_WORKDIR",
  "CODEX_DANGEROUS_BYPASS",
  "CODEX_EXEC_TIMEOUT_MS",
  "CODEX_SANDBOX_MODE",
  "CODEX_APPROVAL_POLICY",
  "CODEX_EXTRA_ARGS",
  "CODEX_EXTRA_ENV_JSON",
  "AUTODEV_LOOP_MAX_RUNS",
  "AUTODEV_LOOP_MAX_MINUTES",
  "AUTODEV_AUTO_COMMIT",
  "AUTODEV_AUTO_RELEASE_ENABLED",
  "AUTODEV_AUTO_RELEASE_PUSH",
  "AUTODEV_MAX_CONSECUTIVE_FAILURES",
  "AUTODEV_INIT_ENHANCEMENT_ENABLED",
  "AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS",
  "AUTODEV_INIT_ENHANCEMENT_MAX_CHARS",
  "AGENT_WORKFLOW_ENABLED",
  "AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS",
  "AGENT_WORKFLOW_ROLE_SKILLS_ENABLED",
  "AGENT_WORKFLOW_ROLE_SKILLS_MODE",
  "AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS",
  "AGENT_WORKFLOW_ROLE_SKILLS_ROOTS",
  "AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON",
  "AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS",
  "AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS",
  "AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS",
  "STATE_DB_PATH",
  "STATE_PATH",
  "MAX_PROCESSED_EVENTS_PER_SESSION",
  "MAX_SESSION_AGE_DAYS",
  "MAX_SESSIONS",
  "REPLY_CHUNK_SIZE",
  "MATRIX_PROGRESS_UPDATES",
  "MATRIX_PROGRESS_MIN_INTERVAL_MS",
  "MATRIX_TYPING_TIMEOUT_MS",
  "SESSION_ACTIVE_WINDOW_MINUTES",
  "GROUP_DIRECT_MODE_ENABLED",
  "GROUP_TRIGGER_ALLOW_MENTION",
  "GROUP_TRIGGER_ALLOW_REPLY",
  "GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW",
  "GROUP_TRIGGER_ALLOW_PREFIX",
  "ROOM_TRIGGER_POLICY_JSON",
  "BACKEND_MODEL_ROUTING_RULES_JSON",
  "CONTEXT_BRIDGE_HISTORY_LIMIT",
  "CONTEXT_BRIDGE_MAX_CHARS",
  "RATE_LIMIT_WINDOW_SECONDS",
  "RATE_LIMIT_MAX_REQUESTS_PER_USER",
  "RATE_LIMIT_MAX_REQUESTS_PER_ROOM",
  "RATE_LIMIT_MAX_CONCURRENT_GLOBAL",
  "RATE_LIMIT_MAX_CONCURRENT_PER_USER",
  "RATE_LIMIT_MAX_CONCURRENT_PER_ROOM",
  "CLI_COMPAT_MODE",
  "CLI_COMPAT_PASSTHROUGH_EVENTS",
  "CLI_COMPAT_PRESERVE_WHITESPACE",
  "CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT",
  "CLI_COMPAT_PROGRESS_THROTTLE_MS",
  "CLI_COMPAT_FETCH_MEDIA",
  "CLI_COMPAT_IMAGE_MAX_BYTES",
  "CLI_COMPAT_IMAGE_MAX_COUNT",
  "CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES",
  "CLI_COMPAT_TRANSCRIBE_AUDIO",
  "CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL",
  "CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS",
  "CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS",
  "CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES",
  "CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS",
  "CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES",
  "CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND",
  "CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS",
  "CLI_COMPAT_RECORD_PATH",
  "PACKAGE_UPDATE_CHECK_ENABLED",
  "PACKAGE_UPDATE_CHECK_TIMEOUT_MS",
  "PACKAGE_UPDATE_CHECK_TTL_MS",
  "DOCTOR_HTTP_TIMEOUT_MS",
  "API_ENABLED",
  "API_BIND_HOST",
  "API_PORT",
  "API_TOKEN",
  "API_TOKEN_SCOPES_JSON",
  "API_WEBHOOK_SECRET",
  "API_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS",
  "EXTERNAL_INTEGRATION_ENABLED",
  "EXTERNAL_NOTIFY_WEBHOOK_URL",
  "EXTERNAL_TICKET_WEBHOOK_URL",
  "EXTERNAL_INTEGRATION_TIMEOUT_MS",
  "EXTERNAL_INTEGRATION_MAX_RETRIES",
  "EXTERNAL_INTEGRATION_RETRY_DELAY_MS",
  "EXTERNAL_INTEGRATION_AUTH_TOKEN",
  "CODEHARBOR_LAUNCHD_MAIN_LABEL",
  "CODEHARBOR_LAUNCHD_ADMIN_LABEL",
  "ADMIN_BIND_HOST",
  "ADMIN_PORT",
  "ADMIN_TOKEN",
  "ADMIN_TOKENS_JSON",
  "ADMIN_IP_ALLOWLIST",
  "ADMIN_ALLOWED_ORIGINS",
  "LOG_LEVEL",
] as const;

type ConfigSnapshotEnvKey = (typeof CONFIG_SNAPSHOT_ENV_KEYS)[number];

export type ConfigSnapshotEnv = Record<ConfigSnapshotEnvKey, string>;

export interface ConfigSnapshotRoom {
  roomId: string;
  enabled: boolean;
  allowMention: boolean;
  allowReply: boolean;
  allowActiveWindow: boolean;
  allowPrefix: boolean;
  workdir: string;
}

export interface ConfigSnapshot {
  schemaVersion: typeof CONFIG_SNAPSHOT_SCHEMA_VERSION;
  exportedAt: string;
  env: ConfigSnapshotEnv;
  rooms: ConfigSnapshotRoom[];
}

export interface ConfigExportCommandOptions {
  cwd?: string;
  outputPath?: string;
  output?: NodeJS.WritableStream;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface ConfigImportCommandOptions {
  filePath: string;
  cwd?: string;
  dryRun?: boolean;
  output?: NodeJS.WritableStream;
  actor?: string;
}

const BOOLEAN_STRING = /^(true|false)$/i;
const INTEGER_STRING = /^-?\d+$/;

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

const roomSnapshotSchema = z
  .object({
    roomId: z.string().min(1),
    enabled: z.boolean(),
    allowMention: z.boolean(),
    allowReply: z.boolean(),
    allowActiveWindow: z.boolean(),
    allowPrefix: z.boolean(),
    workdir: z.string().min(1),
  })
  .strict();

const envSnapshotSchema: z.ZodType<ConfigSnapshotEnv> = z
  .object({
    MATRIX_HOMESERVER: z.string().url(),
    MATRIX_USER_ID: z.string().min(1),
    MATRIX_ACCESS_TOKEN: z.string().min(1),
    MATRIX_COMMAND_PREFIX: z.string(),
    OUTPUT_LANGUAGE: z.enum(["zh", "en"]).default("zh"),
    MATRIX_ADMIN_USERS: z.string().default(""),
    MATRIX_UPGRADE_ALLOWED_USERS: z.string().default(""),
    AI_CLI_PROVIDER: z.enum(["codex", "claude"]).default("codex"),
    CODEX_BIN: z.string().min(1),
    CODEX_MODEL: z.string(),
    CODEX_WORKDIR: z.string().min(1),
    CODEX_DANGEROUS_BYPASS: booleanStringSchema("CODEX_DANGEROUS_BYPASS"),
    CODEX_EXEC_TIMEOUT_MS: integerStringSchema("CODEX_EXEC_TIMEOUT_MS", 1),
    CODEX_SANDBOX_MODE: z.string(),
    CODEX_APPROVAL_POLICY: z.string(),
    CODEX_EXTRA_ARGS: z.string(),
    CODEX_EXTRA_ENV_JSON: jsonObjectStringSchema("CODEX_EXTRA_ENV_JSON", true),
    AUTODEV_LOOP_MAX_RUNS: integerStringSchema("AUTODEV_LOOP_MAX_RUNS", 1).default("20"),
    AUTODEV_LOOP_MAX_MINUTES: integerStringSchema("AUTODEV_LOOP_MAX_MINUTES", 1).default("120"),
    AUTODEV_AUTO_COMMIT: booleanStringSchema("AUTODEV_AUTO_COMMIT").default("true"),
    AUTODEV_AUTO_RELEASE_ENABLED: booleanStringSchema("AUTODEV_AUTO_RELEASE_ENABLED").default("true"),
    AUTODEV_AUTO_RELEASE_PUSH: booleanStringSchema("AUTODEV_AUTO_RELEASE_PUSH").default("false"),
    AUTODEV_MAX_CONSECUTIVE_FAILURES: integerStringSchema("AUTODEV_MAX_CONSECUTIVE_FAILURES", 1).default("3"),
    AUTODEV_INIT_ENHANCEMENT_ENABLED: booleanStringSchema("AUTODEV_INIT_ENHANCEMENT_ENABLED").default("true"),
    AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS: integerStringSchema("AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS", 1).default("480000"),
    AUTODEV_INIT_ENHANCEMENT_MAX_CHARS: integerStringSchema("AUTODEV_INIT_ENHANCEMENT_MAX_CHARS", 1).default("4000"),
    AGENT_WORKFLOW_ENABLED: booleanStringSchema("AGENT_WORKFLOW_ENABLED"),
    AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS: integerStringSchema("AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS", 0, 10),
    AGENT_WORKFLOW_ROLE_SKILLS_ENABLED: booleanStringSchema("AGENT_WORKFLOW_ROLE_SKILLS_ENABLED").default("true"),
    AGENT_WORKFLOW_ROLE_SKILLS_MODE: z.enum(["summary", "progressive", "full"]).default("progressive"),
    AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS: optionalIntegerStringSchema("AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS", 1).default(
      "",
    ),
    AGENT_WORKFLOW_ROLE_SKILLS_ROOTS: z.string().default(""),
    AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON: jsonObjectStringSchema(
      "AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON",
      true,
    ).default(""),
    AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS: optionalIntegerStringSchema("AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS", 1).default(
      "",
    ),
    AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS: optionalIntegerStringSchema(
      "AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS",
      1,
    ).default(""),
    AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS: optionalIntegerStringSchema(
      "AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS",
      1,
    ).default(""),
    STATE_DB_PATH: z.string().min(1),
    STATE_PATH: z.string(),
    MAX_PROCESSED_EVENTS_PER_SESSION: integerStringSchema("MAX_PROCESSED_EVENTS_PER_SESSION", 1),
    MAX_SESSION_AGE_DAYS: integerStringSchema("MAX_SESSION_AGE_DAYS", 1),
    MAX_SESSIONS: integerStringSchema("MAX_SESSIONS", 1),
    REPLY_CHUNK_SIZE: integerStringSchema("REPLY_CHUNK_SIZE", 1),
    MATRIX_PROGRESS_UPDATES: booleanStringSchema("MATRIX_PROGRESS_UPDATES"),
    MATRIX_PROGRESS_MIN_INTERVAL_MS: integerStringSchema("MATRIX_PROGRESS_MIN_INTERVAL_MS", 1),
    MATRIX_TYPING_TIMEOUT_MS: integerStringSchema("MATRIX_TYPING_TIMEOUT_MS", 1),
    SESSION_ACTIVE_WINDOW_MINUTES: integerStringSchema("SESSION_ACTIVE_WINDOW_MINUTES", 1),
    GROUP_DIRECT_MODE_ENABLED: booleanStringSchema("GROUP_DIRECT_MODE_ENABLED").default("false"),
    GROUP_TRIGGER_ALLOW_MENTION: booleanStringSchema("GROUP_TRIGGER_ALLOW_MENTION"),
    GROUP_TRIGGER_ALLOW_REPLY: booleanStringSchema("GROUP_TRIGGER_ALLOW_REPLY"),
    GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW: booleanStringSchema("GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW"),
    GROUP_TRIGGER_ALLOW_PREFIX: booleanStringSchema("GROUP_TRIGGER_ALLOW_PREFIX"),
    ROOM_TRIGGER_POLICY_JSON: jsonObjectStringSchema("ROOM_TRIGGER_POLICY_JSON", true),
    BACKEND_MODEL_ROUTING_RULES_JSON: jsonArrayStringSchema("BACKEND_MODEL_ROUTING_RULES_JSON", true),
    CONTEXT_BRIDGE_HISTORY_LIMIT: integerStringSchema("CONTEXT_BRIDGE_HISTORY_LIMIT", 1, 100).default("16"),
    CONTEXT_BRIDGE_MAX_CHARS: integerStringSchema("CONTEXT_BRIDGE_MAX_CHARS", 200, 40_000).default("8000"),
    RATE_LIMIT_WINDOW_SECONDS: integerStringSchema("RATE_LIMIT_WINDOW_SECONDS", 1),
    RATE_LIMIT_MAX_REQUESTS_PER_USER: integerStringSchema("RATE_LIMIT_MAX_REQUESTS_PER_USER", 0),
    RATE_LIMIT_MAX_REQUESTS_PER_ROOM: integerStringSchema("RATE_LIMIT_MAX_REQUESTS_PER_ROOM", 0),
    RATE_LIMIT_MAX_CONCURRENT_GLOBAL: integerStringSchema("RATE_LIMIT_MAX_CONCURRENT_GLOBAL", 0),
    RATE_LIMIT_MAX_CONCURRENT_PER_USER: integerStringSchema("RATE_LIMIT_MAX_CONCURRENT_PER_USER", 0),
    RATE_LIMIT_MAX_CONCURRENT_PER_ROOM: integerStringSchema("RATE_LIMIT_MAX_CONCURRENT_PER_ROOM", 0),
    CLI_COMPAT_MODE: booleanStringSchema("CLI_COMPAT_MODE"),
    CLI_COMPAT_PASSTHROUGH_EVENTS: booleanStringSchema("CLI_COMPAT_PASSTHROUGH_EVENTS"),
    CLI_COMPAT_PRESERVE_WHITESPACE: booleanStringSchema("CLI_COMPAT_PRESERVE_WHITESPACE"),
    CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT: booleanStringSchema("CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT"),
    CLI_COMPAT_PROGRESS_THROTTLE_MS: integerStringSchema("CLI_COMPAT_PROGRESS_THROTTLE_MS", 0),
    CLI_COMPAT_FETCH_MEDIA: booleanStringSchema("CLI_COMPAT_FETCH_MEDIA"),
    CLI_COMPAT_IMAGE_MAX_BYTES: integerStringSchema("CLI_COMPAT_IMAGE_MAX_BYTES", 1).default("10485760"),
    CLI_COMPAT_IMAGE_MAX_COUNT: integerStringSchema("CLI_COMPAT_IMAGE_MAX_COUNT", 1).default("4"),
    CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES: z.string().default("image/png,image/jpeg,image/webp,image/gif"),
    CLI_COMPAT_TRANSCRIBE_AUDIO: booleanStringSchema("CLI_COMPAT_TRANSCRIBE_AUDIO").default("false"),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),
    CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS: integerStringSchema("CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS", 1).default(
      "120000",
    ),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS: integerStringSchema("CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS", 1).default(
      "6000",
    ),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES: integerStringSchema("CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES", 0, 10).default(
      "1",
    ),
    CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS: integerStringSchema(
      "CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS",
      0,
    ).default("800"),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES: integerStringSchema("CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES", 1).default(
      "26214400",
    ),
    CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND: z.string().default(""),
    CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS: integerStringSchema(
      "CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS",
      1,
    ).default("180000"),
    CLI_COMPAT_RECORD_PATH: z.string(),
    PACKAGE_UPDATE_CHECK_ENABLED: booleanStringSchema("PACKAGE_UPDATE_CHECK_ENABLED").default("true"),
    PACKAGE_UPDATE_CHECK_TIMEOUT_MS: integerStringSchema("PACKAGE_UPDATE_CHECK_TIMEOUT_MS", 1).default("3000"),
    PACKAGE_UPDATE_CHECK_TTL_MS: integerStringSchema("PACKAGE_UPDATE_CHECK_TTL_MS", 1).default("21600000"),
    DOCTOR_HTTP_TIMEOUT_MS: integerStringSchema("DOCTOR_HTTP_TIMEOUT_MS", 1),
    API_ENABLED: booleanStringSchema("API_ENABLED").default("false"),
    API_BIND_HOST: z.string().default("127.0.0.1"),
    API_PORT: integerStringSchema("API_PORT", 1, 65_535).default("8788"),
    API_TOKEN: z.string().default(""),
    API_TOKEN_SCOPES_JSON: jsonArrayStringSchema("API_TOKEN_SCOPES_JSON", true).default(""),
    API_WEBHOOK_SECRET: z.string().default(""),
    API_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: integerStringSchema(
      "API_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS",
      0,
      86_400,
    ).default("300"),
    EXTERNAL_INTEGRATION_ENABLED: booleanStringSchema("EXTERNAL_INTEGRATION_ENABLED").default("false"),
    EXTERNAL_NOTIFY_WEBHOOK_URL: z.string().default(""),
    EXTERNAL_TICKET_WEBHOOK_URL: z.string().default(""),
    EXTERNAL_INTEGRATION_TIMEOUT_MS: integerStringSchema("EXTERNAL_INTEGRATION_TIMEOUT_MS", 1).default("3000"),
    EXTERNAL_INTEGRATION_MAX_RETRIES: integerStringSchema("EXTERNAL_INTEGRATION_MAX_RETRIES", 0, 10).default("1"),
    EXTERNAL_INTEGRATION_RETRY_DELAY_MS: integerStringSchema("EXTERNAL_INTEGRATION_RETRY_DELAY_MS", 0).default("500"),
    EXTERNAL_INTEGRATION_AUTH_TOKEN: z.string().default(""),
    CODEHARBOR_LAUNCHD_MAIN_LABEL: launchdLabelStringSchema("CODEHARBOR_LAUNCHD_MAIN_LABEL").default(
      "com.codeharbor.main",
    ),
    CODEHARBOR_LAUNCHD_ADMIN_LABEL: launchdLabelStringSchema("CODEHARBOR_LAUNCHD_ADMIN_LABEL").default(
      "com.codeharbor.admin",
    ),
    ADMIN_BIND_HOST: z.string(),
    ADMIN_PORT: integerStringSchema("ADMIN_PORT", 1, 65_535),
    ADMIN_TOKEN: z.string(),
    ADMIN_TOKENS_JSON: jsonArrayStringSchema("ADMIN_TOKENS_JSON", true).default(""),
    ADMIN_IP_ALLOWLIST: z.string(),
    ADMIN_ALLOWED_ORIGINS: z.string().default(""),
    LOG_LEVEL: z.enum(LOG_LEVELS),
  })
  .strict();

const configSnapshotSchema: z.ZodType<ConfigSnapshot> = z
  .object({
    schemaVersion: z.literal(CONFIG_SNAPSHOT_SCHEMA_VERSION),
    exportedAt: z.string().datetime({ offset: true }),
    env: envSnapshotSchema,
    rooms: z.array(roomSnapshotSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const room of value.rooms) {
      const roomId = room.roomId.trim();
      if (!roomId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "rooms[].roomId cannot be empty.",
        });
        continue;
      }
      if (seen.has(roomId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate room id in snapshot: ${roomId}`,
        });
      }
      seen.add(roomId);
    }
  });

export function buildConfigSnapshot(config: AppConfig, roomSettings: RoomSettingsRecord[], now = new Date()): ConfigSnapshot {
  return {
    schemaVersion: CONFIG_SNAPSHOT_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    env: buildSnapshotEnv(config),
    rooms: roomSettings.map((room) => ({
      roomId: room.roomId,
      enabled: room.enabled,
      allowMention: room.allowMention,
      allowReply: room.allowReply,
      allowActiveWindow: room.allowActiveWindow,
      allowPrefix: room.allowPrefix,
      workdir: room.workdir,
    })),
  };
}

export function parseConfigSnapshot(raw: unknown): ConfigSnapshot {
  const parsed = configSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "snapshot"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid config snapshot: ${message}`);
  }
  return parsed.data;
}

export function serializeConfigSnapshot(snapshot: ConfigSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export async function runConfigExportCommand(options: ConfigExportCommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const output = options.output ?? process.stdout;
  const config = loadConfig(options.env ?? process.env);
  const stateStore = new StateStore(
    config.stateDbPath,
    config.legacyStateJsonPath,
    config.maxProcessedEventsPerSession,
    config.maxSessionAgeDays,
    config.maxSessions,
  );

  try {
    const snapshot = buildConfigSnapshot(config, stateStore.listRoomSettings(), options.now ?? new Date());
    const serialized = serializeConfigSnapshot(snapshot);

    if (options.outputPath) {
      const targetPath = path.resolve(cwd, options.outputPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, serialized, "utf8");
      output.write(`Exported config snapshot to ${targetPath}\n`);
      return;
    }

    output.write(serialized);
  } finally {
    await stateStore.flush();
  }
}

export async function runConfigImportCommand(options: ConfigImportCommandOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const output = options.output ?? process.stdout;
  const actor = options.actor?.trim() || "cli:config-import";
  const sourcePath = path.resolve(cwd, options.filePath);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Config snapshot file not found: ${sourcePath}`);
  }

  const snapshot = parseConfigSnapshot(parseJsonFile(sourcePath));
  const normalizedEnv = normalizeSnapshotEnv(snapshot.env, cwd);
  ensureDirectory(normalizedEnv.CODEX_WORKDIR, "CODEX_WORKDIR");

  const normalizedRooms = normalizeSnapshotRooms(snapshot.rooms, cwd);

  if (options.dryRun) {
    output.write(
      [
        `Config snapshot is valid: ${sourcePath}`,
        `- schemaVersion: ${snapshot.schemaVersion}`,
        `- rooms: ${normalizedRooms.length}`,
        "- dry-run: no changes were written",
      ].join("\n") + "\n",
    );
    return;
  }

  persistEnvSnapshot(cwd, normalizedEnv);

  const stateStore = new StateStore(
    normalizedEnv.STATE_DB_PATH,
    normalizedEnv.STATE_PATH ? normalizedEnv.STATE_PATH : null,
    parseIntStrict(normalizedEnv.MAX_PROCESSED_EVENTS_PER_SESSION),
    parseIntStrict(normalizedEnv.MAX_SESSION_AGE_DAYS),
    parseIntStrict(normalizedEnv.MAX_SESSIONS),
  );

  try {
    synchronizeRoomSettings(stateStore, normalizedRooms);
    stateStore.appendConfigRevision(
      actor,
      `import config snapshot from ${path.basename(sourcePath)}`,
      JSON.stringify({
        type: "config_snapshot_import",
        sourcePath,
        roomCount: normalizedRooms.length,
        envKeyCount: CONFIG_SNAPSHOT_ENV_KEYS.length,
      }),
    );
  } finally {
    await stateStore.flush();
  }

  output.write(
    [
      `Imported config snapshot from ${sourcePath}`,
      `- updated .env in ${path.resolve(cwd, ".env")}`,
      `- synchronized room settings: ${normalizedRooms.length}`,
      "- restart required: yes (global env settings are restart-scoped)",
    ].join("\n") + "\n",
  );
}

function buildSnapshotEnv(config: AppConfig): ConfigSnapshotEnv {
  const launchdLabels = resolveLaunchdLabelConfig(process.env);
  return {
    MATRIX_HOMESERVER: config.matrixHomeserver,
    MATRIX_USER_ID: config.matrixUserId,
    MATRIX_ACCESS_TOKEN: config.matrixAccessToken,
    MATRIX_COMMAND_PREFIX: config.matrixCommandPrefix,
    OUTPUT_LANGUAGE: config.outputLanguage,
    MATRIX_ADMIN_USERS: config.matrixAdminUsers.join(","),
    MATRIX_UPGRADE_ALLOWED_USERS: config.matrixUpgradeAllowedUsers.join(","),
    AI_CLI_PROVIDER: config.aiCliProvider,
    CODEX_BIN: config.codexBin,
    CODEX_MODEL: config.codexModel ?? "",
    CODEX_WORKDIR: config.codexWorkdir,
    CODEX_DANGEROUS_BYPASS: String(config.codexDangerousBypass),
    CODEX_EXEC_TIMEOUT_MS: String(config.codexExecTimeoutMs),
    CODEX_SANDBOX_MODE: config.codexSandboxMode ?? "",
    CODEX_APPROVAL_POLICY: config.codexApprovalPolicy ?? "",
    CODEX_EXTRA_ARGS: config.codexExtraArgs.join(" "),
    CODEX_EXTRA_ENV_JSON: serializeJsonObject(config.codexExtraEnv),
    AUTODEV_LOOP_MAX_RUNS: normalizePositiveIntegerEnv(process.env.AUTODEV_LOOP_MAX_RUNS, "20"),
    AUTODEV_LOOP_MAX_MINUTES: normalizePositiveIntegerEnv(process.env.AUTODEV_LOOP_MAX_MINUTES, "120"),
    AUTODEV_AUTO_COMMIT: normalizeBooleanEnv(process.env.AUTODEV_AUTO_COMMIT, "true"),
    AUTODEV_AUTO_RELEASE_ENABLED: normalizeBooleanEnv(process.env.AUTODEV_AUTO_RELEASE_ENABLED, "true"),
    AUTODEV_AUTO_RELEASE_PUSH: normalizeBooleanEnv(process.env.AUTODEV_AUTO_RELEASE_PUSH, "false"),
    AUTODEV_MAX_CONSECUTIVE_FAILURES: normalizePositiveIntegerEnv(process.env.AUTODEV_MAX_CONSECUTIVE_FAILURES, "3"),
    AUTODEV_INIT_ENHANCEMENT_ENABLED: normalizeBooleanEnv(process.env.AUTODEV_INIT_ENHANCEMENT_ENABLED, "true"),
    AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS: normalizePositiveIntegerEnv(
      process.env.AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS,
      "480000",
    ),
    AUTODEV_INIT_ENHANCEMENT_MAX_CHARS: normalizePositiveIntegerEnv(
      process.env.AUTODEV_INIT_ENHANCEMENT_MAX_CHARS,
      "4000",
    ),
    AGENT_WORKFLOW_ENABLED: String(config.agentWorkflow.enabled),
    AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS: String(config.agentWorkflow.autoRepairMaxRounds),
    AGENT_WORKFLOW_ROLE_SKILLS_ENABLED: String(config.agentWorkflow.roleSkills.enabled),
    AGENT_WORKFLOW_ROLE_SKILLS_MODE: config.agentWorkflow.roleSkills.mode,
    AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS:
      config.agentWorkflow.roleSkills.maxChars === null ? "" : String(config.agentWorkflow.roleSkills.maxChars),
    AGENT_WORKFLOW_ROLE_SKILLS_ROOTS: config.agentWorkflow.roleSkills.roots.join(","),
    AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON: serializeJsonObject(
      config.agentWorkflow.roleSkills.roleAssignments ?? {},
    ),
    AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS: normalizeOptionalPositiveIntegerEnv(
      process.env.AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS,
    ),
    AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS: normalizeOptionalPositiveIntegerEnv(
      process.env.AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS,
    ),
    AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS: normalizeOptionalPositiveIntegerEnv(
      process.env.AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS,
    ),
    STATE_DB_PATH: config.stateDbPath,
    STATE_PATH: config.legacyStateJsonPath ?? "",
    MAX_PROCESSED_EVENTS_PER_SESSION: String(config.maxProcessedEventsPerSession),
    MAX_SESSION_AGE_DAYS: String(config.maxSessionAgeDays),
    MAX_SESSIONS: String(config.maxSessions),
    REPLY_CHUNK_SIZE: String(config.replyChunkSize),
    MATRIX_PROGRESS_UPDATES: String(config.matrixProgressUpdates),
    MATRIX_PROGRESS_MIN_INTERVAL_MS: String(config.matrixProgressMinIntervalMs),
    MATRIX_TYPING_TIMEOUT_MS: String(config.matrixTypingTimeoutMs),
    SESSION_ACTIVE_WINDOW_MINUTES: String(config.sessionActiveWindowMinutes),
    GROUP_DIRECT_MODE_ENABLED: String(config.groupDirectModeEnabled),
    GROUP_TRIGGER_ALLOW_MENTION: String(config.defaultGroupTriggerPolicy.allowMention),
    GROUP_TRIGGER_ALLOW_REPLY: String(config.defaultGroupTriggerPolicy.allowReply),
    GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW: String(config.defaultGroupTriggerPolicy.allowActiveWindow),
    GROUP_TRIGGER_ALLOW_PREFIX: String(config.defaultGroupTriggerPolicy.allowPrefix),
    ROOM_TRIGGER_POLICY_JSON: serializeJsonObject(config.roomTriggerPolicies),
    BACKEND_MODEL_ROUTING_RULES_JSON: serializeJsonArray(config.backendModelRoutingRules),
    CONTEXT_BRIDGE_HISTORY_LIMIT: String(config.contextBridgeHistoryLimit),
    CONTEXT_BRIDGE_MAX_CHARS: String(config.contextBridgeMaxChars),
    RATE_LIMIT_WINDOW_SECONDS: String(Math.max(1, Math.round(config.rateLimiter.windowMs / 1000))),
    RATE_LIMIT_MAX_REQUESTS_PER_USER: String(config.rateLimiter.maxRequestsPerUser),
    RATE_LIMIT_MAX_REQUESTS_PER_ROOM: String(config.rateLimiter.maxRequestsPerRoom),
    RATE_LIMIT_MAX_CONCURRENT_GLOBAL: String(config.rateLimiter.maxConcurrentGlobal),
    RATE_LIMIT_MAX_CONCURRENT_PER_USER: String(config.rateLimiter.maxConcurrentPerUser),
    RATE_LIMIT_MAX_CONCURRENT_PER_ROOM: String(config.rateLimiter.maxConcurrentPerRoom),
    CLI_COMPAT_MODE: String(config.cliCompat.enabled),
    CLI_COMPAT_PASSTHROUGH_EVENTS: String(config.cliCompat.passThroughEvents),
    CLI_COMPAT_PRESERVE_WHITESPACE: String(config.cliCompat.preserveWhitespace),
    CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT: String(config.cliCompat.disableReplyChunkSplit),
    CLI_COMPAT_PROGRESS_THROTTLE_MS: String(config.cliCompat.progressThrottleMs),
    CLI_COMPAT_FETCH_MEDIA: String(config.cliCompat.fetchMedia),
    CLI_COMPAT_IMAGE_MAX_BYTES: String(config.cliCompat.imageMaxBytes),
    CLI_COMPAT_IMAGE_MAX_COUNT: String(config.cliCompat.imageMaxCount),
    CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES: config.cliCompat.imageAllowedMimeTypes.join(","),
    CLI_COMPAT_TRANSCRIBE_AUDIO: String(config.cliCompat.transcribeAudio),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL: config.cliCompat.audioTranscribeModel,
    CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS: String(config.cliCompat.audioTranscribeTimeoutMs),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS: String(config.cliCompat.audioTranscribeMaxChars),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES: String(config.cliCompat.audioTranscribeMaxRetries),
    CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS: String(config.cliCompat.audioTranscribeRetryDelayMs),
    CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES: String(config.cliCompat.audioTranscribeMaxBytes),
    CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND: config.cliCompat.audioLocalWhisperCommand ?? "",
    CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS: String(config.cliCompat.audioLocalWhisperTimeoutMs),
    CLI_COMPAT_RECORD_PATH: config.cliCompat.recordPath ?? "",
    PACKAGE_UPDATE_CHECK_ENABLED: String(config.updateCheck.enabled),
    PACKAGE_UPDATE_CHECK_TIMEOUT_MS: String(config.updateCheck.timeoutMs),
    PACKAGE_UPDATE_CHECK_TTL_MS: String(config.updateCheck.ttlMs),
    DOCTOR_HTTP_TIMEOUT_MS: String(config.doctorHttpTimeoutMs),
    API_ENABLED: String(config.apiEnabled),
    API_BIND_HOST: config.apiBindHost,
    API_PORT: String(config.apiPort),
    API_TOKEN: config.apiToken ?? "",
    API_TOKEN_SCOPES_JSON: config.apiTokenScopes.length > 0 ? JSON.stringify(config.apiTokenScopes) : "",
    API_WEBHOOK_SECRET: config.apiWebhookSecret ?? "",
    API_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: String(config.apiWebhookTimestampToleranceSeconds),
    EXTERNAL_INTEGRATION_ENABLED: String(config.externalTaskIntegration.enabled),
    EXTERNAL_NOTIFY_WEBHOOK_URL: config.externalTaskIntegration.notifyWebhookUrl ?? "",
    EXTERNAL_TICKET_WEBHOOK_URL: config.externalTaskIntegration.ticketWebhookUrl ?? "",
    EXTERNAL_INTEGRATION_TIMEOUT_MS: String(config.externalTaskIntegration.timeoutMs),
    EXTERNAL_INTEGRATION_MAX_RETRIES: String(config.externalTaskIntegration.maxRetries),
    EXTERNAL_INTEGRATION_RETRY_DELAY_MS: String(config.externalTaskIntegration.retryDelayMs),
    EXTERNAL_INTEGRATION_AUTH_TOKEN: config.externalTaskIntegration.authToken ?? "",
    CODEHARBOR_LAUNCHD_MAIN_LABEL: launchdLabels.main,
    CODEHARBOR_LAUNCHD_ADMIN_LABEL: launchdLabels.admin,
    ADMIN_BIND_HOST: config.adminBindHost,
    ADMIN_PORT: String(config.adminPort),
    ADMIN_TOKEN: config.adminToken ?? "",
    ADMIN_TOKENS_JSON: serializeAdminTokens(config.adminTokens),
    ADMIN_IP_ALLOWLIST: config.adminIpAllowlist.join(","),
    ADMIN_ALLOWED_ORIGINS: config.adminAllowedOrigins.join(","),
    LOG_LEVEL: config.logLevel,
  };
}

function parseJsonFile(filePath: string): unknown {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse snapshot JSON: ${message}`, {
      cause: error,
    });
  }
}

function normalizeSnapshotEnv(env: ConfigSnapshotEnv, cwd: string): ConfigSnapshotEnv {
  return {
    ...env,
    CODEX_WORKDIR: path.resolve(cwd, env.CODEX_WORKDIR),
    STATE_DB_PATH: path.resolve(cwd, env.STATE_DB_PATH),
    STATE_PATH: env.STATE_PATH.trim() ? path.resolve(cwd, env.STATE_PATH) : "",
    CLI_COMPAT_RECORD_PATH: env.CLI_COMPAT_RECORD_PATH.trim() ? path.resolve(cwd, env.CLI_COMPAT_RECORD_PATH) : "",
  };
}

function normalizeSnapshotRooms(rooms: ConfigSnapshotRoom[], cwd: string): RoomSettingsUpsertInput[] {
  const normalized: RoomSettingsUpsertInput[] = [];
  const seen = new Set<string>();

  for (const room of rooms) {
    const roomId = room.roomId.trim();
    if (!roomId) {
      throw new Error("roomId is required for every room in snapshot.");
    }
    if (seen.has(roomId)) {
      throw new Error(`Duplicate roomId in snapshot: ${roomId}`);
    }
    seen.add(roomId);

    const workdir = path.resolve(cwd, room.workdir);
    ensureDirectory(workdir, `room workdir (${roomId})`);

    normalized.push({
      roomId,
      enabled: room.enabled,
      allowMention: room.allowMention,
      allowReply: room.allowReply,
      allowActiveWindow: room.allowActiveWindow,
      allowPrefix: room.allowPrefix,
      workdir,
    });
  }

  return normalized;
}

function synchronizeRoomSettings(stateStore: StateStore, rooms: RoomSettingsUpsertInput[]): void {
  const incoming = new Map(rooms.map((room) => [room.roomId, room]));
  const existing = stateStore.listRoomSettings();

  for (const room of existing) {
    if (!incoming.has(room.roomId)) {
      stateStore.deleteRoomSettings(room.roomId);
    }
  }

  for (const room of rooms) {
    stateStore.upsertRoomSettings(room);
  }
}

function persistEnvSnapshot(cwd: string, env: ConfigSnapshotEnv): void {
  const envPath = path.resolve(cwd, ".env");
  const examplePath = path.resolve(cwd, ".env.example");
  const template = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : fs.existsSync(examplePath)
      ? fs.readFileSync(examplePath, "utf8")
      : "";

  const overrides: Record<string, string> = {};
  for (const key of CONFIG_SNAPSHOT_ENV_KEYS) {
    overrides[key] = env[key];
  }

  const next = applyEnvOverrides(template, overrides);
  fs.writeFileSync(envPath, next, "utf8");
}

function ensureDirectory(dirPath: string, label: string): void {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`${label} does not exist or is not a directory: ${dirPath}`);
  }
}

function parseIntStrict(raw: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid integer value: ${raw}`);
  }
  return value;
}

function serializeJsonObject(value: object): string {
  return Object.keys(value).length > 0 ? JSON.stringify(value) : "";
}

function serializeJsonArray<T>(value: T[]): string {
  return value.length > 0 ? JSON.stringify(value) : "";
}

function serializeAdminTokens(tokens: AdminTokenConfig[]): string {
  return tokens.length > 0 ? JSON.stringify(tokens) : "";
}

function normalizeBooleanEnv(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "false") {
    return trimmed;
  }
  return fallback;
}

function normalizePositiveIntegerEnv(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed || !INTEGER_STRING.test(trimmed)) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return String(parsed);
}

function normalizeOptionalPositiveIntegerEnv(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  if (!INTEGER_STRING.test(trimmed)) {
    return "";
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return "";
  }
  return String(parsed);
}

function booleanStringSchema(key: string): z.ZodString {
  return z.string().refine((value) => BOOLEAN_STRING.test(value), {
    message: `${key} must be a boolean string (true/false).`,
  });
}

function integerStringSchema(key: string, min: number, max = Number.MAX_SAFE_INTEGER): z.ZodString {
  return z.string().refine((value) => {
    const trimmed = value.trim();
    if (!INTEGER_STRING.test(trimmed)) {
      return false;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      return false;
    }
    return parsed >= min && parsed <= max;
  }, {
    message: `${key} must be an integer string in range [${min}, ${max}].`,
  });
}

function optionalIntegerStringSchema(key: string, min: number, max = Number.MAX_SAFE_INTEGER): z.ZodString {
  return z.string().refine((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return true;
    }
    if (!INTEGER_STRING.test(trimmed)) {
      return false;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      return false;
    }
    return parsed >= min && parsed <= max;
  }, {
    message: `${key} must be an empty string or an integer string in range [${min}, ${max}].`,
  });
}

function launchdLabelStringSchema(key: string): z.ZodString {
  return z.string().refine((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return true;
    }
    return /^[A-Za-z0-9_.-]+$/.test(trimmed);
  }, {
    message: `${key} must be empty or a safe launchd label string.`,
  });
}

function jsonObjectStringSchema(key: string, allowEmpty: boolean): z.ZodString {
  return z.string().refine((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return allowEmpty;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return false;
    }

    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
  }, {
    message: `${key} must be an empty string or a JSON object string.`,
  });
}

function jsonArrayStringSchema(key: string, allowEmpty: boolean): z.ZodString {
  return z.string().refine((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return allowEmpty;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return false;
    }

    return Array.isArray(parsed);
  }, {
    message: `${key} must be an empty string or a JSON array string.`,
  });
}
