import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import { ConfigService } from "./config-service";
import { AppConfig } from "./config";
import { applyEnvOverrides } from "./init";
import { Logger } from "./logger";
import { StateStore } from "./store/state-store";

const execFileAsync = promisify(execFile);

interface CodexHealthResult {
  ok: boolean;
  version: string | null;
  error: string | null;
}

interface MatrixHealthResult {
  ok: boolean;
  status: number | null;
  versions: string[];
  error: string | null;
}

interface AdminServerOptions {
  host: string;
  port: number;
  adminToken: string | null;
  cwd?: string;
  checkCodex?: (bin: string) => Promise<CodexHealthResult>;
  checkMatrix?: (homeserver: string, timeoutMs: number) => Promise<MatrixHealthResult>;
}

interface AddressInfo {
  host: string;
  port: number;
}

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class AdminServer {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly stateStore: StateStore;
  private readonly configService: ConfigService;
  private readonly host: string;
  private readonly port: number;
  private readonly adminToken: string | null;
  private readonly cwd: string;
  private readonly checkCodex: (bin: string) => Promise<CodexHealthResult>;
  private readonly checkMatrix: (homeserver: string, timeoutMs: number) => Promise<MatrixHealthResult>;
  private server: http.Server | null = null;
  private address: AddressInfo | null = null;

  constructor(
    config: AppConfig,
    logger: Logger,
    stateStore: StateStore,
    configService: ConfigService,
    options: AdminServerOptions,
  ) {
    this.config = config;
    this.logger = logger;
    this.stateStore = stateStore;
    this.configService = configService;
    this.host = options.host;
    this.port = options.port;
    this.adminToken = options.adminToken;
    this.cwd = options.cwd ?? process.cwd();
    this.checkCodex = options.checkCodex ?? defaultCheckCodex;
    this.checkMatrix = options.checkMatrix ?? defaultCheckMatrix;
  }

  getAddress(): AddressInfo | null {
    return this.address;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        reject(new Error("admin server is not initialized"));
        return;
      }
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server?.removeListener("error", reject);
        const address = this.server?.address();
        if (!address || typeof address === "string") {
          reject(new Error("failed to resolve admin server address"));
          return;
        }
        this.address = {
          host: address.address,
          port: address.port,
        };
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    this.address = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      this.setCorsHeaders(res);

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (!this.isAuthorized(req)) {
        this.sendJson(res, 401, {
          ok: false,
          error: "Unauthorized. Provide Authorization: Bearer <ADMIN_TOKEN>.",
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        this.sendHtml(
          res,
          `<html><body><h1>CodeHarbor Admin API</h1><p>Use /api/admin/* endpoints.</p></body></html>`,
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/config/global") {
        this.sendJson(res, 200, {
          ok: true,
          data: buildGlobalConfigSnapshot(this.config),
          effective: "next_start_for_env_changes",
        });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/admin/config/global") {
        const body = await readJsonBody(req);
        const actor = readActor(req);
        const result = this.updateGlobalConfig(body, actor);
        this.sendJson(res, 200, {
          ok: true,
          ...result,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/config/rooms") {
        this.sendJson(res, 200, {
          ok: true,
          data: this.configService.listRoomSettings(),
        });
        return;
      }

      const roomMatch = /^\/api\/admin\/config\/rooms\/(.+)$/.exec(url.pathname);
      if (roomMatch) {
        const roomId = decodeURIComponent(roomMatch[1]);

        if (req.method === "GET") {
          const room = this.configService.getRoomSettings(roomId);
          if (!room) {
            throw new HttpError(404, `room settings not found for ${roomId}`);
          }
          this.sendJson(res, 200, { ok: true, data: room });
          return;
        }

        if (req.method === "PUT") {
          const body = await readJsonBody(req);
          const actor = readActor(req);
          const room = this.updateRoomConfig(roomId, body, actor);
          this.sendJson(res, 200, { ok: true, data: room });
          return;
        }

        if (req.method === "DELETE") {
          const actor = readActor(req);
          this.configService.deleteRoomSettings(roomId, actor);
          this.sendJson(res, 200, { ok: true, roomId });
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/admin/audit") {
        const limit = normalizePositiveInt(url.searchParams.get("limit"), 20, 1, 200);
        this.sendJson(res, 200, {
          ok: true,
          data: this.stateStore.listConfigRevisions(limit),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/health") {
        const [codex, matrix] = await Promise.all([
          this.checkCodex(this.config.codexBin),
          this.checkMatrix(this.config.matrixHomeserver, this.config.doctorHttpTimeoutMs),
        ]);
        this.sendJson(res, 200, {
          ok: codex.ok && matrix.ok,
          codex,
          matrix,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      this.sendJson(res, 404, {
        ok: false,
        error: `Not found: ${req.method ?? "GET"} ${url.pathname}`,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        this.sendJson(res, error.statusCode, {
          ok: false,
          error: error.message,
        });
        return;
      }

      this.logger.error("Admin API request failed", error);
      this.sendJson(res, 500, {
        ok: false,
        error: formatError(error),
      });
    }
  }

  private updateGlobalConfig(rawBody: unknown, actor: string | null): {
    data: ReturnType<typeof buildGlobalConfigSnapshot>;
    updatedKeys: string[];
    restartRequired: boolean;
  } {
    const body = asObject(rawBody, "global config payload");
    const envUpdates: Record<string, string> = {};
    const updatedKeys: string[] = [];

    if ("matrixCommandPrefix" in body) {
      const value = String(body.matrixCommandPrefix ?? "");
      this.config.matrixCommandPrefix = value;
      envUpdates.MATRIX_COMMAND_PREFIX = value;
      updatedKeys.push("matrixCommandPrefix");
    }

    if ("codexWorkdir" in body) {
      const workdir = path.resolve(String(body.codexWorkdir ?? "").trim());
      ensureDirectory(workdir, "codexWorkdir");
      this.config.codexWorkdir = workdir;
      envUpdates.CODEX_WORKDIR = workdir;
      updatedKeys.push("codexWorkdir");
    }

    if ("rateLimiter" in body) {
      const limiter = asObject(body.rateLimiter, "rateLimiter");
      if ("windowMs" in limiter) {
        const value = normalizePositiveInt(limiter.windowMs, this.config.rateLimiter.windowMs, 1, Number.MAX_SAFE_INTEGER);
        this.config.rateLimiter.windowMs = value;
        envUpdates.RATE_LIMIT_WINDOW_SECONDS = String(Math.max(1, Math.round(value / 1000)));
        updatedKeys.push("rateLimiter.windowMs");
      }
      if ("maxRequestsPerUser" in limiter) {
        const value = normalizeNonNegativeInt(limiter.maxRequestsPerUser, this.config.rateLimiter.maxRequestsPerUser);
        this.config.rateLimiter.maxRequestsPerUser = value;
        envUpdates.RATE_LIMIT_MAX_REQUESTS_PER_USER = String(value);
        updatedKeys.push("rateLimiter.maxRequestsPerUser");
      }
      if ("maxRequestsPerRoom" in limiter) {
        const value = normalizeNonNegativeInt(limiter.maxRequestsPerRoom, this.config.rateLimiter.maxRequestsPerRoom);
        this.config.rateLimiter.maxRequestsPerRoom = value;
        envUpdates.RATE_LIMIT_MAX_REQUESTS_PER_ROOM = String(value);
        updatedKeys.push("rateLimiter.maxRequestsPerRoom");
      }
      if ("maxConcurrentGlobal" in limiter) {
        const value = normalizeNonNegativeInt(limiter.maxConcurrentGlobal, this.config.rateLimiter.maxConcurrentGlobal);
        this.config.rateLimiter.maxConcurrentGlobal = value;
        envUpdates.RATE_LIMIT_MAX_CONCURRENT_GLOBAL = String(value);
        updatedKeys.push("rateLimiter.maxConcurrentGlobal");
      }
      if ("maxConcurrentPerUser" in limiter) {
        const value = normalizeNonNegativeInt(limiter.maxConcurrentPerUser, this.config.rateLimiter.maxConcurrentPerUser);
        this.config.rateLimiter.maxConcurrentPerUser = value;
        envUpdates.RATE_LIMIT_MAX_CONCURRENT_PER_USER = String(value);
        updatedKeys.push("rateLimiter.maxConcurrentPerUser");
      }
      if ("maxConcurrentPerRoom" in limiter) {
        const value = normalizeNonNegativeInt(limiter.maxConcurrentPerRoom, this.config.rateLimiter.maxConcurrentPerRoom);
        this.config.rateLimiter.maxConcurrentPerRoom = value;
        envUpdates.RATE_LIMIT_MAX_CONCURRENT_PER_ROOM = String(value);
        updatedKeys.push("rateLimiter.maxConcurrentPerRoom");
      }
    }

    if ("defaultGroupTriggerPolicy" in body) {
      const policy = asObject(body.defaultGroupTriggerPolicy, "defaultGroupTriggerPolicy");
      if ("allowMention" in policy) {
        const value = normalizeBoolean(policy.allowMention, this.config.defaultGroupTriggerPolicy.allowMention);
        this.config.defaultGroupTriggerPolicy.allowMention = value;
        envUpdates.GROUP_TRIGGER_ALLOW_MENTION = String(value);
        updatedKeys.push("defaultGroupTriggerPolicy.allowMention");
      }
      if ("allowReply" in policy) {
        const value = normalizeBoolean(policy.allowReply, this.config.defaultGroupTriggerPolicy.allowReply);
        this.config.defaultGroupTriggerPolicy.allowReply = value;
        envUpdates.GROUP_TRIGGER_ALLOW_REPLY = String(value);
        updatedKeys.push("defaultGroupTriggerPolicy.allowReply");
      }
      if ("allowActiveWindow" in policy) {
        const value = normalizeBoolean(policy.allowActiveWindow, this.config.defaultGroupTriggerPolicy.allowActiveWindow);
        this.config.defaultGroupTriggerPolicy.allowActiveWindow = value;
        envUpdates.GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW = String(value);
        updatedKeys.push("defaultGroupTriggerPolicy.allowActiveWindow");
      }
      if ("allowPrefix" in policy) {
        const value = normalizeBoolean(policy.allowPrefix, this.config.defaultGroupTriggerPolicy.allowPrefix);
        this.config.defaultGroupTriggerPolicy.allowPrefix = value;
        envUpdates.GROUP_TRIGGER_ALLOW_PREFIX = String(value);
        updatedKeys.push("defaultGroupTriggerPolicy.allowPrefix");
      }
    }

    if ("matrixProgressUpdates" in body) {
      const value = normalizeBoolean(body.matrixProgressUpdates, this.config.matrixProgressUpdates);
      this.config.matrixProgressUpdates = value;
      envUpdates.MATRIX_PROGRESS_UPDATES = String(value);
      updatedKeys.push("matrixProgressUpdates");
    }

    if ("matrixProgressMinIntervalMs" in body) {
      const value = normalizePositiveInt(
        body.matrixProgressMinIntervalMs,
        this.config.matrixProgressMinIntervalMs,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      this.config.matrixProgressMinIntervalMs = value;
      envUpdates.MATRIX_PROGRESS_MIN_INTERVAL_MS = String(value);
      updatedKeys.push("matrixProgressMinIntervalMs");
    }

    if ("matrixTypingTimeoutMs" in body) {
      const value = normalizePositiveInt(
        body.matrixTypingTimeoutMs,
        this.config.matrixTypingTimeoutMs,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      this.config.matrixTypingTimeoutMs = value;
      envUpdates.MATRIX_TYPING_TIMEOUT_MS = String(value);
      updatedKeys.push("matrixTypingTimeoutMs");
    }

    if ("sessionActiveWindowMinutes" in body) {
      const value = normalizePositiveInt(
        body.sessionActiveWindowMinutes,
        this.config.sessionActiveWindowMinutes,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      this.config.sessionActiveWindowMinutes = value;
      envUpdates.SESSION_ACTIVE_WINDOW_MINUTES = String(value);
      updatedKeys.push("sessionActiveWindowMinutes");
    }

    if ("cliCompat" in body) {
      const compat = asObject(body.cliCompat, "cliCompat");
      if ("enabled" in compat) {
        const value = normalizeBoolean(compat.enabled, this.config.cliCompat.enabled);
        this.config.cliCompat.enabled = value;
        envUpdates.CLI_COMPAT_MODE = String(value);
        updatedKeys.push("cliCompat.enabled");
      }
      if ("passThroughEvents" in compat) {
        const value = normalizeBoolean(compat.passThroughEvents, this.config.cliCompat.passThroughEvents);
        this.config.cliCompat.passThroughEvents = value;
        envUpdates.CLI_COMPAT_PASSTHROUGH_EVENTS = String(value);
        updatedKeys.push("cliCompat.passThroughEvents");
      }
      if ("preserveWhitespace" in compat) {
        const value = normalizeBoolean(compat.preserveWhitespace, this.config.cliCompat.preserveWhitespace);
        this.config.cliCompat.preserveWhitespace = value;
        envUpdates.CLI_COMPAT_PRESERVE_WHITESPACE = String(value);
        updatedKeys.push("cliCompat.preserveWhitespace");
      }
      if ("disableReplyChunkSplit" in compat) {
        const value = normalizeBoolean(compat.disableReplyChunkSplit, this.config.cliCompat.disableReplyChunkSplit);
        this.config.cliCompat.disableReplyChunkSplit = value;
        envUpdates.CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT = String(value);
        updatedKeys.push("cliCompat.disableReplyChunkSplit");
      }
      if ("progressThrottleMs" in compat) {
        const value = normalizeNonNegativeInt(compat.progressThrottleMs, this.config.cliCompat.progressThrottleMs);
        this.config.cliCompat.progressThrottleMs = value;
        envUpdates.CLI_COMPAT_PROGRESS_THROTTLE_MS = String(value);
        updatedKeys.push("cliCompat.progressThrottleMs");
      }
      if ("fetchMedia" in compat) {
        const value = normalizeBoolean(compat.fetchMedia, this.config.cliCompat.fetchMedia);
        this.config.cliCompat.fetchMedia = value;
        envUpdates.CLI_COMPAT_FETCH_MEDIA = String(value);
        updatedKeys.push("cliCompat.fetchMedia");
      }
    }

    if (updatedKeys.length === 0) {
      throw new HttpError(400, "No supported global config fields provided.");
    }

    this.persistEnvUpdates(envUpdates);
    this.stateStore.appendConfigRevision(
      actor,
      `update global config: ${updatedKeys.join(", ")}`,
      JSON.stringify({
        type: "global_config_update",
        updates: envUpdates,
      }),
    );

    return {
      data: buildGlobalConfigSnapshot(this.config),
      updatedKeys,
      restartRequired: true,
    };
  }

  private updateRoomConfig(roomId: string, rawBody: unknown, actor: string | null) {
    const body = asObject(rawBody, "room config payload");
    const current = this.configService.getRoomSettings(roomId);

    return this.configService.updateRoomSettings({
      roomId,
      enabled: normalizeBoolean(body.enabled, current?.enabled ?? true),
      allowMention: normalizeBoolean(body.allowMention, current?.allowMention ?? true),
      allowReply: normalizeBoolean(body.allowReply, current?.allowReply ?? true),
      allowActiveWindow: normalizeBoolean(body.allowActiveWindow, current?.allowActiveWindow ?? true),
      allowPrefix: normalizeBoolean(body.allowPrefix, current?.allowPrefix ?? true),
      workdir: normalizeString(body.workdir, current?.workdir ?? this.config.codexWorkdir, "workdir"),
      actor,
      summary: normalizeOptionalString(body.summary),
    });
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    if (!this.adminToken) {
      return true;
    }
    const authorization = req.headers.authorization ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    const fromHeader = normalizeHeaderValue(req.headers["x-admin-token"]);
    return bearer === this.adminToken || fromHeader === this.adminToken;
  }

  private persistEnvUpdates(updates: Record<string, string>): void {
    const envPath = path.resolve(this.cwd, ".env");
    const examplePath = path.resolve(this.cwd, ".env.example");
    const template = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, "utf8")
      : fs.existsSync(examplePath)
        ? fs.readFileSync(examplePath, "utf8")
        : "";
    const next = applyEnvOverrides(template, updates);
    fs.writeFileSync(envPath, next, "utf8");
  }

  private setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token, X-Admin-Actor");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
  }

  private sendHtml(res: http.ServerResponse, html: string): void {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  }
}

function buildGlobalConfigSnapshot(config: AppConfig): {
  matrixCommandPrefix: string;
  codexWorkdir: string;
  rateLimiter: AppConfig["rateLimiter"];
  defaultGroupTriggerPolicy: AppConfig["defaultGroupTriggerPolicy"];
  matrixProgressUpdates: boolean;
  matrixProgressMinIntervalMs: number;
  matrixTypingTimeoutMs: number;
  sessionActiveWindowMinutes: number;
  cliCompat: AppConfig["cliCompat"];
} {
  return {
    matrixCommandPrefix: config.matrixCommandPrefix,
    codexWorkdir: config.codexWorkdir,
    rateLimiter: { ...config.rateLimiter },
    defaultGroupTriggerPolicy: { ...config.defaultGroupTriggerPolicy },
    matrixProgressUpdates: config.matrixProgressUpdates,
    matrixProgressMinIntervalMs: config.matrixProgressMinIntervalMs,
    matrixTypingTimeoutMs: config.matrixTypingTimeoutMs,
    sessionActiveWindowMinutes: config.sessionActiveWindowMinutes,
    cliCompat: { ...config.cliCompat },
  };
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "Expected boolean value.");
  }
  return value;
}

function normalizeString(value: unknown, fallback: string, fieldName: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, `Expected string value for ${fieldName}.`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "Expected string value.");
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `Expected integer in range [${min}, ${max}].`);
  }
  return parsed;
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  return normalizePositiveInt(value, fallback, 0, Number.MAX_SAFE_INTEGER);
}

function ensureDirectory(targetPath: string, fieldName: string): void {
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    throw new HttpError(400, `${fieldName} must be an existing directory: ${targetPath}`);
  }
}

function normalizeHeaderValue(value: string | string[] | undefined): string {
  if (!value) {
    return "";
  }
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? "";
  }
  return value.trim();
}

function readActor(req: http.IncomingMessage): string | null {
  const actor = normalizeHeaderValue(req.headers["x-admin-actor"]);
  return actor || null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function defaultCheckCodex(bin: string): Promise<CodexHealthResult> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"]);
    return {
      ok: true,
      version: stdout.trim() || null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      version: null,
      error: formatError(error),
    };
  }
}

async function defaultCheckMatrix(homeserver: string, timeoutMs: number): Promise<MatrixHealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(`${homeserver}/_matrix/client/versions`, {
      signal: controller.signal,
    });
    const versions = response.ok
      ? (((await response.json()) as { versions?: string[] }).versions ?? [])
      : [];
    return {
      ok: response.ok,
      status: response.status,
      versions,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      versions: [],
      error: formatError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
