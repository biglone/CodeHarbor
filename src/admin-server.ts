import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import { ConfigService } from "./config-service";
import { AppConfig } from "./config";
import { applyEnvOverrides } from "./init";
import { Logger } from "./logger";
import { ConfigRevisionRecord, StateStore } from "./store/state-store";

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
  adminIpAllowlist?: string[];
  adminAllowedOrigins?: string[];
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
  private readonly adminIpAllowlist: string[];
  private readonly adminAllowedOrigins: string[];
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
    this.adminIpAllowlist = normalizeAllowlist(options.adminIpAllowlist ?? []);
    this.adminAllowedOrigins = normalizeOriginAllowlist(options.adminAllowedOrigins ?? []);
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
      this.setSecurityHeaders(res);
      const corsDecision = this.resolveCors(req);
      this.setCorsHeaders(res, corsDecision);

      if (!this.isClientAllowed(req)) {
        this.sendJson(res, 403, {
          ok: false,
          error: "Forbidden by ADMIN_IP_ALLOWLIST.",
        });
        return;
      }

      if (url.pathname.startsWith("/api/admin/") && corsDecision.origin && !corsDecision.allowed) {
        this.sendJson(res, 403, {
          ok: false,
          error: "Forbidden by ADMIN_ALLOWED_ORIGINS.",
        });
        return;
      }

      if (req.method === "OPTIONS") {
        if (corsDecision.origin && !corsDecision.allowed) {
          this.sendJson(res, 403, {
            ok: false,
            error: "Forbidden by ADMIN_ALLOWED_ORIGINS.",
          });
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && isUiPath(url.pathname)) {
        this.sendHtml(res, renderAdminConsoleHtml());
        return;
      }

      if (url.pathname.startsWith("/api/admin/") && !this.isAuthorized(req)) {
        this.sendJson(res, 401, {
          ok: false,
          error: "Unauthorized. Provide Authorization: Bearer <ADMIN_TOKEN>.",
        });
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
          data: this.stateStore.listConfigRevisions(limit).map((entry) => formatAuditEntry(entry)),
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

  private isClientAllowed(req: http.IncomingMessage): boolean {
    if (this.adminIpAllowlist.length === 0) {
      return true;
    }
    const normalizedRemote = normalizeRemoteAddress(req.socket.remoteAddress);
    if (!normalizedRemote) {
      return false;
    }
    return this.adminIpAllowlist.includes(normalizedRemote);
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

  private resolveCors(req: http.IncomingMessage): { origin: string | null; allowed: boolean } {
    const origin = normalizeOriginHeader(req.headers.origin);
    if (!origin) {
      return { origin: null, allowed: true };
    }
    if (isSameOriginRequest(req, origin)) {
      return { origin, allowed: true };
    }
    if (this.adminAllowedOrigins.includes("*")) {
      return { origin, allowed: true };
    }
    if (this.adminAllowedOrigins.length === 0) {
      return { origin, allowed: false };
    }
    return {
      origin,
      allowed: this.adminAllowedOrigins.includes(origin),
    };
  }

  private setCorsHeaders(
    res: http.ServerResponse,
    corsDecision: { origin: string | null; allowed: boolean },
  ): void {
    if (!corsDecision.origin || !corsDecision.allowed) {
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", corsDecision.origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Token, X-Admin-Actor");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, DELETE, OPTIONS");
    appendVaryHeader(res, "Origin");
  }

  private setSecurityHeaders(res: http.ServerResponse): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
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

function formatAuditEntry(entry: ConfigRevisionRecord): {
  id: number;
  actor: string | null;
  summary: string;
  payloadJson: string;
  payload: unknown;
  createdAt: number;
  createdAtIso: string;
} {
  return {
    id: entry.id,
    actor: entry.actor,
    summary: entry.summary,
    payloadJson: entry.payloadJson,
    payload: parseJsonLoose(entry.payloadJson),
    createdAt: entry.createdAt,
    createdAtIso: new Date(entry.createdAt).toISOString(),
  };
}

function parseJsonLoose(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isUiPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/settings/global" ||
    pathname === "/settings/rooms" ||
    pathname === "/health" ||
    pathname === "/audit"
  );
}

function normalizeAllowlist(entries: string[]): string[] {
  const output = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeRemoteAddress(entry);
    if (normalized) {
      output.add(normalized);
    }
  }
  return [...output];
}

function normalizeOriginAllowlist(entries: string[]): string[] {
  const output = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeOrigin(entry);
    if (normalized) {
      output.add(normalized);
    }
  }
  return [...output];
}

function normalizeRemoteAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const withoutZone = trimmed.includes("%") ? trimmed.slice(0, trimmed.indexOf("%")) : trimmed;
  if (withoutZone === "::1" || withoutZone === "0:0:0:0:0:0:0:1") {
    return "127.0.0.1";
  }
  if (withoutZone.startsWith("::ffff:")) {
    return withoutZone.slice("::ffff:".length);
  }
  return withoutZone;
}

function normalizeOriginHeader(value: string | string[] | undefined): string | null {
  if (!value) {
    return null;
  }
  const raw = Array.isArray(value) ? value[0] ?? "" : value;
  return normalizeOrigin(raw);
}

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function isSameOriginRequest(req: http.IncomingMessage, origin: string): boolean {
  const host = normalizeHeaderValue(req.headers.host);
  if (!host) {
    return false;
  }
  const forwardedProto = normalizeHeaderValue(req.headers["x-forwarded-proto"]);
  const protocol = forwardedProto || "http";
  return origin === `${protocol}://${host}`.toLowerCase();
}

function appendVaryHeader(res: http.ServerResponse, headerName: string): void {
  const current = res.getHeader("Vary");
  const existing = typeof current === "string" ? current.split(",").map((v) => v.trim()).filter(Boolean) : [];
  if (!existing.includes(headerName)) {
    existing.push(headerName);
  }
  res.setHeader("Vary", existing.join(", "));
}

function renderAdminConsoleHtml(): string {
  return ADMIN_CONSOLE_HTML;
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

const ADMIN_CONSOLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeHarbor Admin Console</title>
    <style>
      :root {
        --bg-start: #0f172a;
        --bg-end: #1e293b;
        --panel: #0b1224cc;
        --panel-border: #334155;
        --text: #e2e8f0;
        --muted: #94a3b8;
        --accent: #22d3ee;
        --accent-strong: #06b6d4;
        --danger: #f43f5e;
        --ok: #10b981;
        --warn: #f59e0b;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", "Helvetica Neue", sans-serif;
        color: var(--text);
        background: radial-gradient(1200px 600px at 20% -10%, #1d4ed8 0%, transparent 55%),
          radial-gradient(1000px 500px at 100% 0%, #0f766e 0%, transparent 55%),
          linear-gradient(135deg, var(--bg-start), var(--bg-end));
        min-height: 100vh;
      }
      .shell {
        max-width: 1100px;
        margin: 0 auto;
        padding: 20px 16px 40px;
      }
      .header {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 16px;
        padding: 16px;
        backdrop-filter: blur(8px);
      }
      .title {
        margin: 0 0 8px;
        font-size: 24px;
        letter-spacing: 0.2px;
      }
      .subtitle {
        margin: 0 0 14px;
        color: var(--muted);
        font-size: 14px;
      }
      .tabs {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .tab {
        color: var(--text);
        text-decoration: none;
        border: 1px solid var(--panel-border);
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 13px;
      }
      .tab.active {
        border-color: var(--accent);
        background: #155e7555;
      }
      .auth-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(220px, 1fr)) auto auto;
        gap: 8px;
        align-items: end;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field-label {
        font-size: 12px;
        color: var(--muted);
      }
      input,
      button,
      textarea {
        font: inherit;
      }
      input[type="text"],
      input[type="password"],
      input[type="number"] {
        border: 1px solid var(--panel-border);
        background: #0f172acc;
        color: var(--text);
        border-radius: 10px;
        padding: 8px 10px;
      }
      button {
        border: 1px solid var(--accent);
        background: #164e63;
        color: #ecfeff;
        border-radius: 10px;
        padding: 8px 12px;
        cursor: pointer;
      }
      button.secondary {
        border-color: var(--panel-border);
        background: #1e293b;
        color: var(--text);
      }
      button.danger {
        border-color: var(--danger);
        background: #881337;
      }
      .notice {
        margin: 12px 0 0;
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 13px;
        border: 1px solid #334155;
        color: var(--muted);
      }
      .notice.ok {
        border-color: #065f46;
        color: #d1fae5;
        background: #064e3b88;
      }
      .notice.error {
        border-color: #881337;
        color: #ffe4e6;
        background: #4c051988;
      }
      .notice.warn {
        border-color: #92400e;
        color: #fef3c7;
        background: #78350f88;
      }
      .panel {
        margin-top: 14px;
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 16px;
        padding: 16px;
      }
      .panel[hidden] {
        display: none;
      }
      .panel-title {
        margin: 0 0 12px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .full {
        grid-column: 1 / -1;
      }
      .checkbox {
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: 14px;
      }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid #334155;
        border-radius: 12px;
        margin-top: 12px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 720px;
      }
      th,
      td {
        border-bottom: 1px solid #334155;
        text-align: left;
        padding: 8px;
        font-size: 12px;
        vertical-align: top;
      }
      th {
        color: var(--muted);
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 11px;
        color: #cbd5e1;
      }
      .muted {
        color: var(--muted);
        font-size: 12px;
      }
      @media (max-width: 900px) {
        .auth-row {
          grid-template-columns: 1fr;
        }
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="header">
        <h1 class="title">CodeHarbor Admin Console</h1>
        <p class="subtitle">Manage global settings, room policies, health checks, and config audit records.</p>
        <nav class="tabs">
          <a class="tab" data-page="settings-global" href="#/settings/global">Global</a>
          <a class="tab" data-page="settings-rooms" href="#/settings/rooms">Rooms</a>
          <a class="tab" data-page="health" href="#/health">Health</a>
          <a class="tab" data-page="audit" href="#/audit">Audit</a>
        </nav>
        <div class="auth-row">
          <label class="field">
            <span class="field-label">Admin Token (optional)</span>
            <input id="auth-token" type="password" placeholder="ADMIN_TOKEN" />
          </label>
          <label class="field">
            <span class="field-label">Actor (for audit logs)</span>
            <input id="auth-actor" type="text" placeholder="your-name" />
          </label>
          <button id="auth-save-btn" type="button" class="secondary">Save Auth</button>
          <button id="auth-clear-btn" type="button" class="secondary">Clear Auth</button>
        </div>
        <div id="notice" class="notice">Ready.</div>
      </section>

      <section class="panel" data-view="settings-global">
        <h2 class="panel-title">Global Config</h2>
        <div class="grid">
          <label class="field">
            <span class="field-label">Command Prefix</span>
            <input id="global-matrix-prefix" type="text" />
          </label>
          <label class="field">
            <span class="field-label">Default Workdir</span>
            <input id="global-workdir" type="text" />
          </label>
          <label class="field">
            <span class="field-label">Progress Interval (ms)</span>
            <input id="global-progress-interval" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label">Typing Timeout (ms)</span>
            <input id="global-typing-timeout" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label">Session Active Window (minutes)</span>
            <input id="global-active-window" type="number" min="1" />
          </label>
          <label class="checkbox">
            <input id="global-progress-enabled" type="checkbox" />
            <span>Enable progress updates</span>
          </label>

          <label class="field">
            <span class="field-label">Rate Window (ms)</span>
            <input id="global-rate-window" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label">Rate Max Requests / User</span>
            <input id="global-rate-user" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label">Rate Max Requests / Room</span>
            <input id="global-rate-room" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label">Max Concurrent Global</span>
            <input id="global-concurrency-global" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label">Max Concurrent / User</span>
            <input id="global-concurrency-user" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label">Max Concurrent / Room</span>
            <input id="global-concurrency-room" type="number" min="0" />
          </label>

          <label class="checkbox"><input id="global-trigger-mention" type="checkbox" /><span>Trigger: mention</span></label>
          <label class="checkbox"><input id="global-trigger-reply" type="checkbox" /><span>Trigger: reply</span></label>
          <label class="checkbox"><input id="global-trigger-window" type="checkbox" /><span>Trigger: active window</span></label>
          <label class="checkbox"><input id="global-trigger-prefix" type="checkbox" /><span>Trigger: prefix</span></label>

          <label class="checkbox"><input id="global-cli-enabled" type="checkbox" /><span>CLI compat mode</span></label>
          <label class="checkbox"><input id="global-cli-pass" type="checkbox" /><span>CLI passthrough events</span></label>
          <label class="checkbox"><input id="global-cli-whitespace" type="checkbox" /><span>Preserve whitespace</span></label>
          <label class="checkbox"><input id="global-cli-disable-split" type="checkbox" /><span>Disable reply split</span></label>
          <label class="field">
            <span class="field-label">CLI progress throttle (ms)</span>
            <input id="global-cli-throttle" type="number" min="0" />
          </label>
          <label class="checkbox"><input id="global-cli-fetch-media" type="checkbox" /><span>Fetch media attachments</span></label>
        </div>
        <div class="actions">
          <button id="global-save-btn" type="button">Save Global Config</button>
          <button id="global-reload-btn" type="button" class="secondary">Reload</button>
        </div>
        <p class="muted">Saving global config updates .env and requires restart to fully take effect.</p>
      </section>

      <section class="panel" data-view="settings-rooms" hidden>
        <h2 class="panel-title">Room Config</h2>
        <div class="grid">
          <label class="field">
            <span class="field-label">Room ID</span>
            <input id="room-id" type="text" placeholder="!room:example.com" />
          </label>
          <label class="field">
            <span class="field-label">Audit Summary (optional)</span>
            <input id="room-summary" type="text" placeholder="bind room to project A" />
          </label>
          <label class="field full">
            <span class="field-label">Workdir</span>
            <input id="room-workdir" type="text" />
          </label>
          <label class="checkbox"><input id="room-enabled" type="checkbox" /><span>Enabled</span></label>
          <label class="checkbox"><input id="room-mention" type="checkbox" /><span>Allow mention trigger</span></label>
          <label class="checkbox"><input id="room-reply" type="checkbox" /><span>Allow reply trigger</span></label>
          <label class="checkbox"><input id="room-window" type="checkbox" /><span>Allow active-window trigger</span></label>
          <label class="checkbox"><input id="room-prefix" type="checkbox" /><span>Allow prefix trigger</span></label>
        </div>
        <div class="actions">
          <button id="room-load-btn" type="button" class="secondary">Load Room</button>
          <button id="room-save-btn" type="button">Save Room</button>
          <button id="room-delete-btn" type="button" class="danger">Delete Room</button>
          <button id="room-refresh-btn" type="button" class="secondary">Refresh List</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Room ID</th>
                <th>Enabled</th>
                <th>Workdir</th>
                <th>Updated At</th>
              </tr>
            </thead>
            <tbody id="room-list-body"></tbody>
          </table>
        </div>
      </section>

      <section class="panel" data-view="health" hidden>
        <h2 class="panel-title">Health Check</h2>
        <div class="actions">
          <button id="health-refresh-btn" type="button">Run Health Check</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Component</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody id="health-body"></tbody>
          </table>
        </div>
      </section>

      <section class="panel" data-view="audit" hidden>
        <h2 class="panel-title">Config Audit</h2>
        <div class="actions">
          <label class="field" style="max-width: 120px;">
            <span class="field-label">Limit</span>
            <input id="audit-limit" type="number" min="1" max="200" value="30" />
          </label>
          <button id="audit-refresh-btn" type="button">Refresh Audit</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Time</th>
                <th>Actor</th>
                <th>Summary</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody id="audit-body"></tbody>
          </table>
        </div>
      </section>
    </main>

    <script>
      (function () {
        "use strict";

        var routeToView = {
          "#/settings/global": "settings-global",
          "#/settings/rooms": "settings-rooms",
          "#/health": "health",
          "#/audit": "audit"
        };
        var pathToRoute = {
          "/settings/global": "#/settings/global",
          "/settings/rooms": "#/settings/rooms",
          "/health": "#/health",
          "/audit": "#/audit"
        };
        var storageTokenKey = "codeharbor.admin.token";
        var storageActorKey = "codeharbor.admin.actor";
        var loaded = {
          "settings-global": false,
          "settings-rooms": false,
          health: false,
          audit: false
        };

        var tokenInput = document.getElementById("auth-token");
        var actorInput = document.getElementById("auth-actor");
        var noticeNode = document.getElementById("notice");
        var roomListBody = document.getElementById("room-list-body");
        var healthBody = document.getElementById("health-body");
        var auditBody = document.getElementById("audit-body");

        tokenInput.value = localStorage.getItem(storageTokenKey) || "";
        actorInput.value = localStorage.getItem(storageActorKey) || "";

        document.getElementById("auth-save-btn").addEventListener("click", function () {
          localStorage.setItem(storageTokenKey, tokenInput.value.trim());
          localStorage.setItem(storageActorKey, actorInput.value.trim());
          showNotice("ok", "Auth settings saved to localStorage.");
        });

        document.getElementById("auth-clear-btn").addEventListener("click", function () {
          tokenInput.value = "";
          actorInput.value = "";
          localStorage.removeItem(storageTokenKey);
          localStorage.removeItem(storageActorKey);
          showNotice("warn", "Auth settings cleared.");
        });

        document.getElementById("global-save-btn").addEventListener("click", saveGlobal);
        document.getElementById("global-reload-btn").addEventListener("click", loadGlobal);
        document.getElementById("room-load-btn").addEventListener("click", loadRoom);
        document.getElementById("room-save-btn").addEventListener("click", saveRoom);
        document.getElementById("room-delete-btn").addEventListener("click", deleteRoom);
        document.getElementById("room-refresh-btn").addEventListener("click", refreshRoomList);
        document.getElementById("health-refresh-btn").addEventListener("click", loadHealth);
        document.getElementById("audit-refresh-btn").addEventListener("click", loadAudit);

        window.addEventListener("hashchange", handleRoute);

        if (!window.location.hash) {
          window.location.hash = pathToRoute[window.location.pathname] || "#/settings/global";
        } else {
          handleRoute();
        }

        function getCurrentView() {
          return routeToView[window.location.hash] || "settings-global";
        }

        function handleRoute() {
          var view = getCurrentView();
          var panels = document.querySelectorAll("[data-view]");
          for (var i = 0; i < panels.length; i += 1) {
            var panel = panels[i];
            panel.hidden = panel.getAttribute("data-view") !== view;
          }
          var tabs = document.querySelectorAll(".tab");
          for (var j = 0; j < tabs.length; j += 1) {
            var tab = tabs[j];
            if (tab.getAttribute("data-page") === view) {
              tab.classList.add("active");
            } else {
              tab.classList.remove("active");
            }
          }
          ensureLoaded(view);
        }

        function ensureLoaded(view) {
          if (loaded[view]) {
            return;
          }
          if (view === "settings-global") {
            loadGlobal();
          } else if (view === "settings-rooms") {
            refreshRoomList();
          } else if (view === "health") {
            loadHealth();
          } else if (view === "audit") {
            loadAudit();
          }
          loaded[view] = true;
        }

        async function apiRequest(path, method, body) {
          var headers = {};
          var token = tokenInput.value.trim();
          var actor = actorInput.value.trim();
          if (token) {
            headers.authorization = "Bearer " + token;
          }
          if (actor) {
            headers["x-admin-actor"] = actor;
          }
          if (body !== undefined) {
            headers["content-type"] = "application/json";
          }
          var response = await fetch(path, {
            method: method || "GET",
            headers: headers,
            body: body === undefined ? undefined : JSON.stringify(body)
          });
          var text = await response.text();
          var payload;
          try {
            payload = text ? JSON.parse(text) : {};
          } catch (error) {
            payload = { raw: text };
          }
          if (!response.ok) {
            var message = payload && payload.error ? payload.error : response.status + " " + response.statusText;
            throw new Error(message);
          }
          return payload;
        }

        function asNumber(inputId, fallback) {
          var value = Number.parseInt(document.getElementById(inputId).value, 10);
          return Number.isFinite(value) ? value : fallback;
        }

        function asBool(inputId) {
          return Boolean(document.getElementById(inputId).checked);
        }

        function asText(inputId) {
          return document.getElementById(inputId).value.trim();
        }

        function showNotice(type, message) {
          noticeNode.className = "notice " + type;
          noticeNode.textContent = message;
        }

        function renderEmptyRow(body, columns, text) {
          body.innerHTML = "";
          var row = document.createElement("tr");
          var cell = document.createElement("td");
          cell.colSpan = columns;
          cell.textContent = text;
          row.appendChild(cell);
          body.appendChild(row);
        }

        async function loadGlobal() {
          try {
            var response = await apiRequest("/api/admin/config/global", "GET");
            var data = response.data || {};
            var rateLimiter = data.rateLimiter || {};
            var trigger = data.defaultGroupTriggerPolicy || {};
            var cliCompat = data.cliCompat || {};

            document.getElementById("global-matrix-prefix").value = data.matrixCommandPrefix || "";
            document.getElementById("global-workdir").value = data.codexWorkdir || "";
            document.getElementById("global-progress-enabled").checked = Boolean(data.matrixProgressUpdates);
            document.getElementById("global-progress-interval").value = String(data.matrixProgressMinIntervalMs || 2500);
            document.getElementById("global-typing-timeout").value = String(data.matrixTypingTimeoutMs || 10000);
            document.getElementById("global-active-window").value = String(data.sessionActiveWindowMinutes || 20);
            document.getElementById("global-rate-window").value = String(rateLimiter.windowMs || 60000);
            document.getElementById("global-rate-user").value = String(rateLimiter.maxRequestsPerUser || 0);
            document.getElementById("global-rate-room").value = String(rateLimiter.maxRequestsPerRoom || 0);
            document.getElementById("global-concurrency-global").value = String(rateLimiter.maxConcurrentGlobal || 0);
            document.getElementById("global-concurrency-user").value = String(rateLimiter.maxConcurrentPerUser || 0);
            document.getElementById("global-concurrency-room").value = String(rateLimiter.maxConcurrentPerRoom || 0);

            document.getElementById("global-trigger-mention").checked = Boolean(trigger.allowMention);
            document.getElementById("global-trigger-reply").checked = Boolean(trigger.allowReply);
            document.getElementById("global-trigger-window").checked = Boolean(trigger.allowActiveWindow);
            document.getElementById("global-trigger-prefix").checked = Boolean(trigger.allowPrefix);

            document.getElementById("global-cli-enabled").checked = Boolean(cliCompat.enabled);
            document.getElementById("global-cli-pass").checked = Boolean(cliCompat.passThroughEvents);
            document.getElementById("global-cli-whitespace").checked = Boolean(cliCompat.preserveWhitespace);
            document.getElementById("global-cli-disable-split").checked = Boolean(cliCompat.disableReplyChunkSplit);
            document.getElementById("global-cli-throttle").value = String(cliCompat.progressThrottleMs || 0);
            document.getElementById("global-cli-fetch-media").checked = Boolean(cliCompat.fetchMedia);

            showNotice("ok", "Global config loaded.");
          } catch (error) {
            showNotice("error", "Failed to load global config: " + error.message);
          }
        }

        async function saveGlobal() {
          try {
            var body = {
              matrixCommandPrefix: asText("global-matrix-prefix"),
              codexWorkdir: asText("global-workdir"),
              matrixProgressUpdates: asBool("global-progress-enabled"),
              matrixProgressMinIntervalMs: asNumber("global-progress-interval", 2500),
              matrixTypingTimeoutMs: asNumber("global-typing-timeout", 10000),
              sessionActiveWindowMinutes: asNumber("global-active-window", 20),
              rateLimiter: {
                windowMs: asNumber("global-rate-window", 60000),
                maxRequestsPerUser: asNumber("global-rate-user", 20),
                maxRequestsPerRoom: asNumber("global-rate-room", 120),
                maxConcurrentGlobal: asNumber("global-concurrency-global", 8),
                maxConcurrentPerUser: asNumber("global-concurrency-user", 1),
                maxConcurrentPerRoom: asNumber("global-concurrency-room", 4)
              },
              defaultGroupTriggerPolicy: {
                allowMention: asBool("global-trigger-mention"),
                allowReply: asBool("global-trigger-reply"),
                allowActiveWindow: asBool("global-trigger-window"),
                allowPrefix: asBool("global-trigger-prefix")
              },
              cliCompat: {
                enabled: asBool("global-cli-enabled"),
                passThroughEvents: asBool("global-cli-pass"),
                preserveWhitespace: asBool("global-cli-whitespace"),
                disableReplyChunkSplit: asBool("global-cli-disable-split"),
                progressThrottleMs: asNumber("global-cli-throttle", 300),
                fetchMedia: asBool("global-cli-fetch-media")
              }
            };
            var response = await apiRequest("/api/admin/config/global", "PUT", body);
            var keys = Array.isArray(response.updatedKeys) ? response.updatedKeys.join(", ") : "global config";
            showNotice("warn", "Saved: " + keys + ". Restart is required.");
            await loadAudit();
          } catch (error) {
            showNotice("error", "Failed to save global config: " + error.message);
          }
        }

        async function refreshRoomList() {
          try {
            var response = await apiRequest("/api/admin/config/rooms", "GET");
            var items = Array.isArray(response.data) ? response.data : [];
            roomListBody.innerHTML = "";
            if (items.length === 0) {
              renderEmptyRow(roomListBody, 4, "No room settings.");
              return;
            }
            for (var i = 0; i < items.length; i += 1) {
              var item = items[i];
              var row = document.createElement("tr");
              appendCell(row, item.roomId || "");
              appendCell(row, String(Boolean(item.enabled)));
              appendCell(row, item.workdir || "");
              appendCell(row, item.updatedAt ? new Date(item.updatedAt).toISOString() : "-");
              roomListBody.appendChild(row);
            }
            showNotice("ok", "Loaded " + items.length + " room setting(s).");
          } catch (error) {
            showNotice("error", "Failed to load room list: " + error.message);
            renderEmptyRow(roomListBody, 4, "Failed to load room settings.");
          }
        }

        function appendCell(row, text) {
          var cell = document.createElement("td");
          cell.textContent = text;
          row.appendChild(cell);
        }

        async function loadRoom() {
          var roomId = asText("room-id");
          if (!roomId) {
            showNotice("warn", "Room ID is required.");
            return;
          }
          try {
            var response = await apiRequest("/api/admin/config/rooms/" + encodeURIComponent(roomId), "GET");
            fillRoomForm(response.data || {});
            showNotice("ok", "Room config loaded for " + roomId + ".");
          } catch (error) {
            showNotice("error", "Failed to load room config: " + error.message);
          }
        }

        function fillRoomForm(data) {
          document.getElementById("room-enabled").checked = Boolean(data.enabled);
          document.getElementById("room-mention").checked = Boolean(data.allowMention);
          document.getElementById("room-reply").checked = Boolean(data.allowReply);
          document.getElementById("room-window").checked = Boolean(data.allowActiveWindow);
          document.getElementById("room-prefix").checked = Boolean(data.allowPrefix);
          document.getElementById("room-workdir").value = data.workdir || "";
        }

        async function saveRoom() {
          var roomId = asText("room-id");
          if (!roomId) {
            showNotice("warn", "Room ID is required.");
            return;
          }
          try {
            var body = {
              enabled: asBool("room-enabled"),
              allowMention: asBool("room-mention"),
              allowReply: asBool("room-reply"),
              allowActiveWindow: asBool("room-window"),
              allowPrefix: asBool("room-prefix"),
              workdir: asText("room-workdir"),
              summary: asText("room-summary")
            };
            await apiRequest("/api/admin/config/rooms/" + encodeURIComponent(roomId), "PUT", body);
            showNotice("ok", "Room config saved for " + roomId + ".");
            await refreshRoomList();
            await loadAudit();
          } catch (error) {
            showNotice("error", "Failed to save room config: " + error.message);
          }
        }

        async function deleteRoom() {
          var roomId = asText("room-id");
          if (!roomId) {
            showNotice("warn", "Room ID is required.");
            return;
          }
          if (!window.confirm("Delete room config for " + roomId + "?")) {
            return;
          }
          try {
            await apiRequest("/api/admin/config/rooms/" + encodeURIComponent(roomId), "DELETE");
            showNotice("ok", "Room config deleted for " + roomId + ".");
            await refreshRoomList();
            await loadAudit();
          } catch (error) {
            showNotice("error", "Failed to delete room config: " + error.message);
          }
        }

        async function loadHealth() {
          try {
            var response = await apiRequest("/api/admin/health", "GET");
            healthBody.innerHTML = "";

            var codex = response.codex || {};
            var matrix = response.matrix || {};

            appendHealthRow("Codex", Boolean(codex.ok), codex.ok ? (codex.version || "ok") : (codex.error || "failed"));
            appendHealthRow(
              "Matrix",
              Boolean(matrix.ok),
              matrix.ok ? "HTTP " + matrix.status + " " + JSON.stringify(matrix.versions || []) : (matrix.error || "failed")
            );
            appendHealthRow("Overall", Boolean(response.ok), response.timestamp || "");
            showNotice("ok", "Health check completed.");
          } catch (error) {
            showNotice("error", "Health check failed: " + error.message);
            renderEmptyRow(healthBody, 3, "Failed to run health check.");
          }
        }

        function appendHealthRow(component, ok, detail) {
          var row = document.createElement("tr");
          appendCell(row, component);
          appendCell(row, ok ? "OK" : "FAIL");
          appendCell(row, detail);
          healthBody.appendChild(row);
        }

        async function loadAudit() {
          var limit = asNumber("audit-limit", 30);
          if (limit < 1) {
            limit = 1;
          }
          if (limit > 200) {
            limit = 200;
          }
          try {
            var response = await apiRequest("/api/admin/audit?limit=" + limit, "GET");
            var items = Array.isArray(response.data) ? response.data : [];
            auditBody.innerHTML = "";
            if (items.length === 0) {
              renderEmptyRow(auditBody, 5, "No audit records.");
              return;
            }
            for (var i = 0; i < items.length; i += 1) {
              var item = items[i];
              var row = document.createElement("tr");
              appendCell(row, String(item.id || ""));
              appendCell(row, item.createdAtIso || "");
              appendCell(row, item.actor || "-");
              appendCell(row, item.summary || "");
              var payloadCell = document.createElement("td");
              var payloadNode = document.createElement("pre");
              payloadNode.textContent = formatPayload(item);
              payloadCell.appendChild(payloadNode);
              row.appendChild(payloadCell);
              auditBody.appendChild(row);
            }
            showNotice("ok", "Audit loaded: " + items.length + " record(s).");
          } catch (error) {
            showNotice("error", "Failed to load audit: " + error.message);
            renderEmptyRow(auditBody, 5, "Failed to load audit records.");
          }
        }

        function formatPayload(item) {
          if (item.payload && typeof item.payload === "object") {
            return JSON.stringify(item.payload, null, 2);
          }
          if (typeof item.payloadJson === "string" && item.payloadJson) {
            return item.payloadJson;
          }
          return "";
        }
      })();
    </script>
  </body>
</html>
`;

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
