import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import { ConfigService } from "./config-service";
import { ADMIN_CONSOLE_HTML } from "./admin-console-html";
import { AdminTokenConfig, AppConfig } from "./config";
import { applyEnvOverrides } from "./init";
import { Logger } from "./logger";
import {
  hasRequiredScopes,
  listMissingScopes,
  resolveAdminScopeRequirement,
  scopesForAdminRole,
  TOKEN_SCOPES,
  type TokenScopePattern,
} from "./auth/scope-matrix";
import { parseRuntimeMetricsSnapshot, renderPrometheusMetrics, type RuntimeMetricsSnapshot } from "./metrics";
import {
  NpmRegistryUpdateChecker,
  type PackageUpdateChecker,
  resolvePackageVersion,
} from "./package-update-checker";
import {
  buildRuntimeHotConfigPayload,
  GLOBAL_RUNTIME_HOT_CONFIG_KEY,
  isHotGlobalConfigKey,
} from "./runtime-hot-config";
import { restartSystemdServices } from "./service-manager";
import { ConfigRevisionRecord, StateStore } from "./store/state-store";

const execFileAsync = promisify(execFile);
const ADMIN_MAX_JSON_BODY_BYTES = 1_048_576;

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

interface RestartServicesResult {
  restarted: string[];
}

type AdminAccessRole = "admin" | "viewer";
type AdminAuthSource = "open" | "legacy" | "scoped";

interface AdminAuthIdentity {
  role: AdminAccessRole;
  actor: string | null;
  source: AdminAuthSource;
  scopes: TokenScopePattern[];
}

interface AdminServerOptions {
  host: string;
  port: number;
  adminToken: string | null;
  adminTokens?: AdminTokenConfig[];
  adminIpAllowlist?: string[];
  adminAllowedOrigins?: string[];
  cwd?: string;
  checkCodex?: (bin: string) => Promise<CodexHealthResult>;
  checkMatrix?: (homeserver: string, timeoutMs: number) => Promise<MatrixHealthResult>;
  packageUpdateChecker?: PackageUpdateChecker;
  restartServices?: (restartAdmin: boolean) => Promise<RestartServicesResult>;
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
  private readonly adminTokens: Map<string, Omit<AdminAuthIdentity, "source">>;
  private readonly adminIpAllowlist: string[];
  private readonly adminAllowedOrigins: string[];
  private readonly cwd: string;
  private readonly checkCodex: (bin: string) => Promise<CodexHealthResult>;
  private readonly checkMatrix: (homeserver: string, timeoutMs: number) => Promise<MatrixHealthResult>;
  private readonly hasCustomPackageUpdateChecker: boolean;
  private packageUpdateChecker: PackageUpdateChecker;
  private readonly restartServices: (restartAdmin: boolean) => Promise<RestartServicesResult>;
  private readonly appVersion: string;
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
    this.adminTokens = buildAdminTokenMap(options.adminTokens ?? []);
    this.adminIpAllowlist = normalizeAllowlist(options.adminIpAllowlist ?? []);
    this.adminAllowedOrigins = normalizeOriginAllowlist(options.adminAllowedOrigins ?? []);
    this.cwd = options.cwd ?? process.cwd();
    this.checkCodex = options.checkCodex ?? defaultCheckCodex;
    this.checkMatrix = options.checkMatrix ?? defaultCheckMatrix;
    this.hasCustomPackageUpdateChecker = Boolean(options.packageUpdateChecker);
    this.packageUpdateChecker = options.packageUpdateChecker ?? this.createPackageUpdateChecker();
    this.restartServices = options.restartServices ?? defaultRestartServices;
    this.appVersion = resolvePackageVersion();
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

      const scopeRequirement = resolveAdminScopeRequirement(req.method, url.pathname);
      const authIdentity = scopeRequirement ? this.resolveAdminIdentity(req) : null;
      if (scopeRequirement && !authIdentity) {
        this.sendJson(res, 401, {
          ok: false,
          error: "Unauthorized. Provide Authorization: Bearer <ADMIN_TOKEN> (or token from ADMIN_TOKENS_JSON).",
        });
        return;
      }
      if (scopeRequirement && authIdentity && !hasRequiredScopes(authIdentity.scopes, scopeRequirement.requiredScopes)) {
        const missingScopes = listMissingScopes(authIdentity.scopes, scopeRequirement.requiredScopes);
        this.sendJson(res, 403, {
          ok: false,
          error: `Forbidden. Missing required scope: ${missingScopes.join(", ")}.`,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        const metricsText = this.buildMetricsText();
        this.sendMetrics(res, metricsText);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/auth/status") {
        this.sendJson(res, 200, {
          ok: true,
          data: {
            authenticated: Boolean(authIdentity),
            role: authIdentity?.role ?? null,
            source: authIdentity?.source ?? "none",
            actor: resolveIdentityActor(authIdentity),
            scopes: authIdentity ? [...authIdentity.scopes] : [],
            canWrite: authIdentity ? hasRequiredScopes(authIdentity.scopes, [TOKEN_SCOPES.ADMIN_WRITE]) : false,
          },
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/config/global") {
        this.sendJson(res, 200, {
          ok: true,
          data: buildGlobalConfigSnapshot(this.config),
          effective: "hot_for_whitelist_else_restart",
        });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/admin/config/global") {
        const body = await readJsonBody(req, ADMIN_MAX_JSON_BODY_BYTES);
        const actor = resolveAuditActor(req, authIdentity);
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
          const body = await readJsonBody(req, ADMIN_MAX_JSON_BODY_BYTES);
          const actor = resolveAuditActor(req, authIdentity);
          const room = this.updateRoomConfig(roomId, body, actor);
          this.sendJson(res, 200, { ok: true, data: room });
          return;
        }

        if (req.method === "DELETE") {
          const actor = resolveAuditActor(req, authIdentity);
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
        const [codex, matrix, app] = await Promise.all([
          this.checkCodex(this.config.codexBin),
          this.checkMatrix(this.config.matrixHomeserver, this.config.doctorHttpTimeoutMs),
          this.packageUpdateChecker.getStatus(),
        ]);
        this.sendJson(res, 200, {
          ok: codex.ok && matrix.ok,
          cliProvider: this.config.aiCliProvider,
          codex,
          matrix,
          app,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/service/restart") {
        const body = asObject(await readJsonBody(req, ADMIN_MAX_JSON_BODY_BYTES), "service restart payload");
        const restartAdmin = normalizeBoolean(body.withAdmin, false);
        const actor = resolveAuditActor(req, authIdentity);
        try {
          const result = await this.restartServices(restartAdmin);
          this.stateStore.appendConfigRevision(
            actor,
            restartAdmin ? "restart services (main + admin)" : "restart service (main)",
            JSON.stringify({
              type: "service_restart",
              restartAdmin,
              restarted: result.restarted,
            }),
          );
          this.sendJson(res, 200, {
            ok: true,
            restarted: result.restarted,
          });
          return;
        } catch (error) {
          throw new HttpError(
            500,
            `Service restart failed: ${formatError(error)}. Install services via "codeharbor service install --with-admin" to auto-configure restart permissions, or run CLI command manually with sudo.`,
          );
        }
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
    hotAppliedKeys: string[];
    restartRequiredKeys: string[];
    restartRequired: boolean;
    runtimeConfigVersion: number | null;
  } {
    const body = asObject(rawBody, "global config payload");
    const envUpdates: Record<string, string> = {};
    const updatedKeys: string[] = [];
    const hotAppliedKeys: string[] = [];
    const restartRequiredKeys: string[] = [];
    const markUpdatedKey = (key: string): void => {
      updatedKeys.push(key);
      if (isHotGlobalConfigKey(key)) {
        hotAppliedKeys.push(key);
        return;
      }
      restartRequiredKeys.push(key);
    };

    if ("matrixCommandPrefix" in body) {
      const value = String(body.matrixCommandPrefix ?? "");
      this.config.matrixCommandPrefix = value;
      envUpdates.MATRIX_COMMAND_PREFIX = value;
      markUpdatedKey("matrixCommandPrefix");
    }

    if ("codexWorkdir" in body) {
      const workdir = path.resolve(String(body.codexWorkdir ?? "").trim());
      ensureDirectory(workdir, "codexWorkdir");
      this.config.codexWorkdir = workdir;
      envUpdates.CODEX_WORKDIR = workdir;
      markUpdatedKey("codexWorkdir");
    }

    if ("rateLimiter" in body) {
      const limiter = asObject(body.rateLimiter, "rateLimiter");
      if ("windowMs" in limiter) {
        const value = normalizePositiveInt(limiter.windowMs, this.config.rateLimiter.windowMs, 1, Number.MAX_SAFE_INTEGER);
        this.config.rateLimiter.windowMs = value;
        envUpdates.RATE_LIMIT_WINDOW_SECONDS = String(Math.max(1, Math.round(value / 1000)));
        markUpdatedKey("rateLimiter.windowMs");
      }
      if ("maxRequestsPerUser" in limiter) {
        const value = normalizeNonNegativeInt(limiter.maxRequestsPerUser, this.config.rateLimiter.maxRequestsPerUser);
        this.config.rateLimiter.maxRequestsPerUser = value;
        envUpdates.RATE_LIMIT_MAX_REQUESTS_PER_USER = String(value);
        markUpdatedKey("rateLimiter.maxRequestsPerUser");
      }
      if ("maxRequestsPerRoom" in limiter) {
        const value = normalizeNonNegativeInt(limiter.maxRequestsPerRoom, this.config.rateLimiter.maxRequestsPerRoom);
        this.config.rateLimiter.maxRequestsPerRoom = value;
        envUpdates.RATE_LIMIT_MAX_REQUESTS_PER_ROOM = String(value);
        markUpdatedKey("rateLimiter.maxRequestsPerRoom");
      }
      if ("maxConcurrentGlobal" in limiter) {
        const value = normalizeNonNegativeInt(limiter.maxConcurrentGlobal, this.config.rateLimiter.maxConcurrentGlobal);
        this.config.rateLimiter.maxConcurrentGlobal = value;
        envUpdates.RATE_LIMIT_MAX_CONCURRENT_GLOBAL = String(value);
        markUpdatedKey("rateLimiter.maxConcurrentGlobal");
      }
      if ("maxConcurrentPerUser" in limiter) {
        const value = normalizeNonNegativeInt(limiter.maxConcurrentPerUser, this.config.rateLimiter.maxConcurrentPerUser);
        this.config.rateLimiter.maxConcurrentPerUser = value;
        envUpdates.RATE_LIMIT_MAX_CONCURRENT_PER_USER = String(value);
        markUpdatedKey("rateLimiter.maxConcurrentPerUser");
      }
      if ("maxConcurrentPerRoom" in limiter) {
        const value = normalizeNonNegativeInt(limiter.maxConcurrentPerRoom, this.config.rateLimiter.maxConcurrentPerRoom);
        this.config.rateLimiter.maxConcurrentPerRoom = value;
        envUpdates.RATE_LIMIT_MAX_CONCURRENT_PER_ROOM = String(value);
        markUpdatedKey("rateLimiter.maxConcurrentPerRoom");
      }
    }

    if ("defaultGroupTriggerPolicy" in body) {
      const policy = asObject(body.defaultGroupTriggerPolicy, "defaultGroupTriggerPolicy");
      if ("allowMention" in policy) {
        const value = normalizeBoolean(policy.allowMention, this.config.defaultGroupTriggerPolicy.allowMention);
        this.config.defaultGroupTriggerPolicy.allowMention = value;
        envUpdates.GROUP_TRIGGER_ALLOW_MENTION = String(value);
        markUpdatedKey("defaultGroupTriggerPolicy.allowMention");
      }
      if ("allowReply" in policy) {
        const value = normalizeBoolean(policy.allowReply, this.config.defaultGroupTriggerPolicy.allowReply);
        this.config.defaultGroupTriggerPolicy.allowReply = value;
        envUpdates.GROUP_TRIGGER_ALLOW_REPLY = String(value);
        markUpdatedKey("defaultGroupTriggerPolicy.allowReply");
      }
      if ("allowActiveWindow" in policy) {
        const value = normalizeBoolean(policy.allowActiveWindow, this.config.defaultGroupTriggerPolicy.allowActiveWindow);
        this.config.defaultGroupTriggerPolicy.allowActiveWindow = value;
        envUpdates.GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW = String(value);
        markUpdatedKey("defaultGroupTriggerPolicy.allowActiveWindow");
      }
      if ("allowPrefix" in policy) {
        const value = normalizeBoolean(policy.allowPrefix, this.config.defaultGroupTriggerPolicy.allowPrefix);
        this.config.defaultGroupTriggerPolicy.allowPrefix = value;
        envUpdates.GROUP_TRIGGER_ALLOW_PREFIX = String(value);
        markUpdatedKey("defaultGroupTriggerPolicy.allowPrefix");
      }
    }

    if ("matrixProgressUpdates" in body) {
      const value = normalizeBoolean(body.matrixProgressUpdates, this.config.matrixProgressUpdates);
      this.config.matrixProgressUpdates = value;
      envUpdates.MATRIX_PROGRESS_UPDATES = String(value);
      markUpdatedKey("matrixProgressUpdates");
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
      markUpdatedKey("matrixProgressMinIntervalMs");
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
      markUpdatedKey("matrixTypingTimeoutMs");
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
      markUpdatedKey("sessionActiveWindowMinutes");
    }

    if ("groupDirectModeEnabled" in body) {
      const value = normalizeBoolean(body.groupDirectModeEnabled, this.config.groupDirectModeEnabled);
      this.config.groupDirectModeEnabled = value;
      envUpdates.GROUP_DIRECT_MODE_ENABLED = String(value);
      markUpdatedKey("groupDirectModeEnabled");
    }

    if ("updateCheck" in body) {
      const updateCheck = asObject(body.updateCheck, "updateCheck");
      let updateCheckChanged = false;
      if ("enabled" in updateCheck) {
        const value = normalizeBoolean(updateCheck.enabled, this.config.updateCheck.enabled);
        this.config.updateCheck.enabled = value;
        envUpdates.PACKAGE_UPDATE_CHECK_ENABLED = String(value);
        markUpdatedKey("updateCheck.enabled");
        updateCheckChanged = true;
      }
      if ("timeoutMs" in updateCheck) {
        const value = normalizePositiveInt(
          updateCheck.timeoutMs,
          this.config.updateCheck.timeoutMs,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        this.config.updateCheck.timeoutMs = value;
        envUpdates.PACKAGE_UPDATE_CHECK_TIMEOUT_MS = String(value);
        markUpdatedKey("updateCheck.timeoutMs");
        updateCheckChanged = true;
      }
      if ("ttlMs" in updateCheck) {
        const value = normalizePositiveInt(updateCheck.ttlMs, this.config.updateCheck.ttlMs, 1, Number.MAX_SAFE_INTEGER);
        this.config.updateCheck.ttlMs = value;
        envUpdates.PACKAGE_UPDATE_CHECK_TTL_MS = String(value);
        markUpdatedKey("updateCheck.ttlMs");
        updateCheckChanged = true;
      }
      if (updateCheckChanged && !this.hasCustomPackageUpdateChecker) {
        this.packageUpdateChecker = this.createPackageUpdateChecker();
      }
    }

    if ("cliCompat" in body) {
      const compat = asObject(body.cliCompat, "cliCompat");
      if ("enabled" in compat) {
        const value = normalizeBoolean(compat.enabled, this.config.cliCompat.enabled);
        this.config.cliCompat.enabled = value;
        envUpdates.CLI_COMPAT_MODE = String(value);
        markUpdatedKey("cliCompat.enabled");
      }
      if ("passThroughEvents" in compat) {
        const value = normalizeBoolean(compat.passThroughEvents, this.config.cliCompat.passThroughEvents);
        this.config.cliCompat.passThroughEvents = value;
        envUpdates.CLI_COMPAT_PASSTHROUGH_EVENTS = String(value);
        markUpdatedKey("cliCompat.passThroughEvents");
      }
      if ("preserveWhitespace" in compat) {
        const value = normalizeBoolean(compat.preserveWhitespace, this.config.cliCompat.preserveWhitespace);
        this.config.cliCompat.preserveWhitespace = value;
        envUpdates.CLI_COMPAT_PRESERVE_WHITESPACE = String(value);
        markUpdatedKey("cliCompat.preserveWhitespace");
      }
      if ("disableReplyChunkSplit" in compat) {
        const value = normalizeBoolean(compat.disableReplyChunkSplit, this.config.cliCompat.disableReplyChunkSplit);
        this.config.cliCompat.disableReplyChunkSplit = value;
        envUpdates.CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT = String(value);
        markUpdatedKey("cliCompat.disableReplyChunkSplit");
      }
      if ("progressThrottleMs" in compat) {
        const value = normalizeNonNegativeInt(compat.progressThrottleMs, this.config.cliCompat.progressThrottleMs);
        this.config.cliCompat.progressThrottleMs = value;
        envUpdates.CLI_COMPAT_PROGRESS_THROTTLE_MS = String(value);
        markUpdatedKey("cliCompat.progressThrottleMs");
      }
      if ("fetchMedia" in compat) {
        const value = normalizeBoolean(compat.fetchMedia, this.config.cliCompat.fetchMedia);
        this.config.cliCompat.fetchMedia = value;
        envUpdates.CLI_COMPAT_FETCH_MEDIA = String(value);
        markUpdatedKey("cliCompat.fetchMedia");
      }
      if ("transcribeAudio" in compat) {
        const value = normalizeBoolean(compat.transcribeAudio, this.config.cliCompat.transcribeAudio);
        this.config.cliCompat.transcribeAudio = value;
        envUpdates.CLI_COMPAT_TRANSCRIBE_AUDIO = String(value);
        markUpdatedKey("cliCompat.transcribeAudio");
      }
      if ("audioTranscribeModel" in compat) {
        const value = normalizeString(
          compat.audioTranscribeModel,
          this.config.cliCompat.audioTranscribeModel,
          "cliCompat.audioTranscribeModel",
        );
        this.config.cliCompat.audioTranscribeModel = value || "gpt-4o-mini-transcribe";
        envUpdates.CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL = this.config.cliCompat.audioTranscribeModel;
        markUpdatedKey("cliCompat.audioTranscribeModel");
      }
      if ("audioTranscribeTimeoutMs" in compat) {
        const value = normalizePositiveInt(
          compat.audioTranscribeTimeoutMs,
          this.config.cliCompat.audioTranscribeTimeoutMs,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        this.config.cliCompat.audioTranscribeTimeoutMs = value;
        envUpdates.CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS = String(value);
        markUpdatedKey("cliCompat.audioTranscribeTimeoutMs");
      }
      if ("audioTranscribeMaxChars" in compat) {
        const value = normalizePositiveInt(
          compat.audioTranscribeMaxChars,
          this.config.cliCompat.audioTranscribeMaxChars,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        this.config.cliCompat.audioTranscribeMaxChars = value;
        envUpdates.CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS = String(value);
        markUpdatedKey("cliCompat.audioTranscribeMaxChars");
      }
      if ("audioTranscribeMaxRetries" in compat) {
        const value = normalizePositiveInt(
          compat.audioTranscribeMaxRetries,
          this.config.cliCompat.audioTranscribeMaxRetries,
          0,
          10,
        );
        this.config.cliCompat.audioTranscribeMaxRetries = value;
        envUpdates.CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES = String(value);
        markUpdatedKey("cliCompat.audioTranscribeMaxRetries");
      }
      if ("audioTranscribeRetryDelayMs" in compat) {
        const value = normalizeNonNegativeInt(
          compat.audioTranscribeRetryDelayMs,
          this.config.cliCompat.audioTranscribeRetryDelayMs,
        );
        this.config.cliCompat.audioTranscribeRetryDelayMs = value;
        envUpdates.CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS = String(value);
        markUpdatedKey("cliCompat.audioTranscribeRetryDelayMs");
      }
      if ("audioTranscribeMaxBytes" in compat) {
        const value = normalizePositiveInt(
          compat.audioTranscribeMaxBytes,
          this.config.cliCompat.audioTranscribeMaxBytes,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        this.config.cliCompat.audioTranscribeMaxBytes = value;
        envUpdates.CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES = String(value);
        markUpdatedKey("cliCompat.audioTranscribeMaxBytes");
      }
      if ("audioLocalWhisperCommand" in compat) {
        const value = normalizeString(
          compat.audioLocalWhisperCommand,
          this.config.cliCompat.audioLocalWhisperCommand ?? "",
          "cliCompat.audioLocalWhisperCommand",
        );
        this.config.cliCompat.audioLocalWhisperCommand = value || null;
        envUpdates.CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND = this.config.cliCompat.audioLocalWhisperCommand ?? "";
        markUpdatedKey("cliCompat.audioLocalWhisperCommand");
      }
      if ("audioLocalWhisperTimeoutMs" in compat) {
        const value = normalizePositiveInt(
          compat.audioLocalWhisperTimeoutMs,
          this.config.cliCompat.audioLocalWhisperTimeoutMs,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        this.config.cliCompat.audioLocalWhisperTimeoutMs = value;
        envUpdates.CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS = String(value);
        markUpdatedKey("cliCompat.audioLocalWhisperTimeoutMs");
      }
    }

    if ("agentWorkflow" in body) {
      const workflow = asObject(body.agentWorkflow, "agentWorkflow");
      const currentAgentWorkflow = ensureAgentWorkflowConfig(this.config);
      if ("enabled" in workflow) {
        const value = normalizeBoolean(workflow.enabled, currentAgentWorkflow.enabled);
        currentAgentWorkflow.enabled = value;
        envUpdates.AGENT_WORKFLOW_ENABLED = String(value);
        markUpdatedKey("agentWorkflow.enabled");
      }
      if ("autoRepairMaxRounds" in workflow) {
        const value = normalizePositiveInt(
          workflow.autoRepairMaxRounds,
          currentAgentWorkflow.autoRepairMaxRounds,
          0,
          10,
        );
        currentAgentWorkflow.autoRepairMaxRounds = value;
        envUpdates.AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS = String(value);
        markUpdatedKey("agentWorkflow.autoRepairMaxRounds");
      }
    }

    if (updatedKeys.length === 0) {
      throw new HttpError(400, "No supported global config fields provided.");
    }

    this.persistEnvUpdates(envUpdates);
    let runtimeConfigVersion: number | null = null;
    if (hotAppliedKeys.length > 0) {
      const runtimeSnapshot = this.stateStore.upsertRuntimeConfigSnapshot(
        GLOBAL_RUNTIME_HOT_CONFIG_KEY,
        JSON.stringify(buildRuntimeHotConfigPayload(this.config)),
      );
      runtimeConfigVersion = runtimeSnapshot.version;
    }
    const mode = restartRequiredKeys.length > 0 ? "restart" : "hot";
    this.stateStore.appendConfigRevision(
      actor,
      `update global config: ${updatedKeys.join(", ")}`,
      JSON.stringify({
        type: "global_config_update",
        actor,
        mode,
        updatedKeys,
        hotAppliedKeys,
        restartRequiredKeys,
        runtimeConfigVersion,
        updates: envUpdates,
      }),
    );

    return {
      data: buildGlobalConfigSnapshot(this.config),
      updatedKeys,
      hotAppliedKeys,
      restartRequiredKeys,
      restartRequired: restartRequiredKeys.length > 0,
      runtimeConfigVersion,
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

  private resolveAdminIdentity(req: http.IncomingMessage): AdminAuthIdentity | null {
    if (!this.adminToken && this.adminTokens.size === 0) {
      return {
        role: "admin",
        actor: null,
        source: "open",
        scopes: scopesForAdminRole("admin"),
      };
    }

    const token = readAdminToken(req);
    if (!token) {
      return null;
    }

    if (this.adminToken && token === this.adminToken) {
      return {
        role: "admin",
        actor: null,
        source: "legacy",
        scopes: scopesForAdminRole("admin"),
      };
    }

    const mappedIdentity = this.adminTokens.get(token);
    if (!mappedIdentity) {
      return null;
    }

    return {
      role: mappedIdentity.role,
      actor: mappedIdentity.actor,
      source: "scoped",
      scopes: [...mappedIdentity.scopes],
    };
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
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
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

  private sendMetrics(res: http.ServerResponse, text: string): void {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.end(text);
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  }

  private buildMetricsText(): string {
    let snapshot: RuntimeMetricsSnapshot | null = null;
    const record = this.stateStore.getRuntimeMetricsSnapshot("orchestrator");
    if (record) {
      snapshot = parseRuntimeMetricsSnapshot(record.payloadJson);
    }
    const upgradeStats = this.stateStore.getUpgradeRunStats();
    const latestUpgradeRun = this.stateStore.getLatestUpgradeRun();
    return renderPrometheusMetrics({
      snapshot,
      upgradeStats,
      latestUpgradeRun,
      appVersion: this.appVersion,
    });
  }

  private createPackageUpdateChecker(): PackageUpdateChecker {
    return new NpmRegistryUpdateChecker({
      packageName: "codeharbor",
      currentVersion: resolvePackageVersion(),
      enabled: this.config.updateCheck.enabled,
      timeoutMs: this.config.updateCheck.timeoutMs,
      ttlMs: this.config.updateCheck.ttlMs,
    });
  }
}

function buildGlobalConfigSnapshot(config: AppConfig): {
  matrixCommandPrefix: string;
  codexWorkdir: string;
  rateLimiter: AppConfig["rateLimiter"];
  groupDirectModeEnabled: boolean;
  defaultGroupTriggerPolicy: AppConfig["defaultGroupTriggerPolicy"];
  matrixProgressUpdates: boolean;
  matrixProgressMinIntervalMs: number;
  matrixTypingTimeoutMs: number;
  sessionActiveWindowMinutes: number;
  updateCheck: AppConfig["updateCheck"];
  cliCompat: AppConfig["cliCompat"];
  agentWorkflow: AppConfig["agentWorkflow"];
} {
  return {
    matrixCommandPrefix: config.matrixCommandPrefix,
    codexWorkdir: config.codexWorkdir,
    rateLimiter: { ...config.rateLimiter },
    groupDirectModeEnabled: config.groupDirectModeEnabled,
    defaultGroupTriggerPolicy: { ...config.defaultGroupTriggerPolicy },
    matrixProgressUpdates: config.matrixProgressUpdates,
    matrixProgressMinIntervalMs: config.matrixProgressMinIntervalMs,
    matrixTypingTimeoutMs: config.matrixTypingTimeoutMs,
    sessionActiveWindowMinutes: config.sessionActiveWindowMinutes,
    updateCheck: { ...config.updateCheck },
    cliCompat: { ...config.cliCompat },
    agentWorkflow: { ...ensureAgentWorkflowConfig(config) },
  };
}

function ensureAgentWorkflowConfig(config: AppConfig): AppConfig["agentWorkflow"] {
  const mutable = config as AppConfig & { agentWorkflow?: AppConfig["agentWorkflow"] };
  const existing = mutable.agentWorkflow;
  if (existing && typeof existing.enabled === "boolean" && Number.isFinite(existing.autoRepairMaxRounds)) {
    return existing;
  }

  const fallback: AppConfig["agentWorkflow"] = {
    enabled: false,
    autoRepairMaxRounds: 1,
  };
  mutable.agentWorkflow = fallback;
  return fallback;
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

async function defaultRestartServices(restartAdmin: boolean): Promise<RestartServicesResult> {
  const outputChunks: string[] = [];
  const output = {
    write: (chunk: string | Uint8Array): boolean => {
      outputChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  restartSystemdServices({
    restartAdmin,
    output,
  });

  return {
    restarted: restartAdmin ? ["codeharbor", "codeharbor-admin"] : ["codeharbor"],
  };
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

async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentLengthHeader = req.headers["content-length"];
  if (typeof contentLengthHeader === "string" && contentLengthHeader.trim()) {
    const declaredLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new HttpError(413, `Request body too large. Max allowed bytes: ${maxBytes}.`);
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, `Request body too large. Max allowed bytes: ${maxBytes}.`);
    }
    chunks.push(buffer);
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

function readAdminToken(req: http.IncomingMessage): string | null {
  const authorization = normalizeHeaderValue(req.headers.authorization);
  if (authorization) {
    const match = /^bearer\s+(.+)$/i.exec(authorization);
    const token = match?.[1]?.trim() ?? "";
    if (token) {
      return token;
    }
  }

  const fromHeader = normalizeHeaderValue(req.headers["x-admin-token"]);
  return fromHeader || null;
}

function resolveIdentityActor(identity: AdminAuthIdentity | null): string | null {
  if (!identity || identity.source !== "scoped") {
    return null;
  }
  if (identity.actor) {
    return identity.actor;
  }
  return identity.role === "admin" ? "admin-token" : "viewer-token";
}

function resolveAuditActor(req: http.IncomingMessage, identity: AdminAuthIdentity | null): string | null {
  const scopedActor = resolveIdentityActor(identity);
  if (scopedActor) {
    return scopedActor;
  }

  const actor = normalizeHeaderValue(req.headers["x-admin-actor"]);
  return actor || null;
}

function buildAdminTokenMap(tokens: AdminTokenConfig[]): Map<string, Omit<AdminAuthIdentity, "source">> {
  const mapped = new Map<string, Omit<AdminAuthIdentity, "source">>();
  for (const token of tokens) {
    mapped.set(token.token, {
      role: token.role,
      actor: token.actor,
      scopes: scopesForAdminRole(token.role),
    });
  }
  return mapped;
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
