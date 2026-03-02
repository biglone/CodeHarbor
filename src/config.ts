import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

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
    DOCTOR_HTTP_TIMEOUT_MS: z
      .string()
      .default("10000")
      .transform((v) => Number.parseInt(v, 10))
      .pipe(z.number().int().positive()),
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
    statePath: path.resolve(v.STATE_PATH),
    maxProcessedEventsPerSession: v.MAX_PROCESSED_EVENTS_PER_SESSION,
    maxSessionAgeDays: v.MAX_SESSION_AGE_DAYS,
    maxSessions: v.MAX_SESSIONS,
    replyChunkSize: v.REPLY_CHUNK_SIZE,
    matrixProgressUpdates: v.MATRIX_PROGRESS_UPDATES,
    matrixProgressMinIntervalMs: v.MATRIX_PROGRESS_MIN_INTERVAL_MS,
    matrixTypingTimeoutMs: v.MATRIX_TYPING_TIMEOUT_MS,
    doctorHttpTimeoutMs: v.DOCTOR_HTTP_TIMEOUT_MS,
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

  fs.mkdirSync(path.dirname(parsed.data.statePath), { recursive: true });
  return parsed.data;
}
