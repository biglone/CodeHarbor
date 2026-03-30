import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ConfigService } from "./config-service";
import { buildConfigSnapshot, CONFIG_SNAPSHOT_ENV_KEYS, runConfigImportCommand } from "./config-snapshot";
import { ADMIN_CONSOLE_HTML } from "./admin-console-html";
import { AdminTokenConfig, AppConfig, loadConfig, type OutputLanguage } from "./config";
import { HistoryService } from "./history-service";
import { applyEnvOverrides } from "./init";
import { Logger } from "./logger";
import {
  hasAnyAdminWriteScope,
  hasRequiredScopes,
  listMissingScopes,
  normalizeTokenScopes,
  resolveAdminScopeRequirement,
  scopesForAdminRole,
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
import { queueAdminSystemdRestart, restartSystemdServices } from "./service-manager";
import {
  ConfigRevisionRecord,
  HistoryCleanupRunRecord,
  HistoryRetentionPolicyRecord,
  OperationAuditOutcome,
  OperationAuditRecord,
  SessionHistoryRecord,
  SessionMessageRecord,
  StateStore,
} from "./store/state-store";

const execFileAsync = promisify(execFile);
const ADMIN_MAX_JSON_BODY_BYTES = 1_048_576;
const ADMIN_DEFAULT_SESSION_QUERY_LIMIT = 50;
const ADMIN_MAX_SESSION_QUERY_LIMIT = 200;
const ADMIN_DEFAULT_SESSION_MESSAGES_LIMIT = 100;
const ADMIN_MAX_SESSION_MESSAGES_LIMIT = 500;
const ADMIN_DEFAULT_EXPORT_MESSAGE_LIMIT = 200;
const ADMIN_MAX_EXPORT_MESSAGE_LIMIT = 500;
const ADMIN_DEFAULT_HISTORY_CLEANUP_RUN_LIMIT = 20;
const ADMIN_MAX_HISTORY_CLEANUP_RUN_LIMIT = 200;
const ROLE_SKILL_DISCLOSURE_MODES = new Set(["summary", "progressive", "full"]);
const ROLE_SKILL_ROLES = ["planner", "executor", "reviewer"] as const;
const ALLOWED_ENV_OVERRIDE_KEYS = new Set<string>(CONFIG_SNAPSHOT_ENV_KEYS);
const BOOLEAN_ENV_OVERRIDE_KEYS = new Set<string>([
  "AUTODEV_AUTO_COMMIT",
  "AUTODEV_AUTO_RELEASE_ENABLED",
  "AUTODEV_AUTO_RELEASE_PUSH",
  "AUTODEV_RUN_ARCHIVE_ENABLED",
  "AUTODEV_VALIDATION_STRICT",
  "AUTODEV_STAGE_OUTPUT_ECHO_ENABLED",
  "AUTODEV_PREFLIGHT_AUTO_STASH",
  "AUTODEV_INIT_ENHANCEMENT_ENABLED",
]);
const OPTIONAL_POSITIVE_INT_ENV_OVERRIDE_KEYS = new Set<string>([
  "AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS",
  "AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS",
  "AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS",
]);
const POSITIVE_INT_ENV_OVERRIDE_KEYS = new Set<string>([
  "AUTODEV_LOOP_MAX_RUNS",
  "AUTODEV_LOOP_MAX_MINUTES",
  "AUTODEV_MAX_CONSECUTIVE_FAILURES",
  "AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS",
  "AUTODEV_INIT_ENHANCEMENT_MAX_CHARS",
]);
const LAUNCHD_LABEL_ENV_OVERRIDE_KEYS = new Set<string>([
  "CODEHARBOR_LAUNCHD_MAIN_LABEL",
  "CODEHARBOR_LAUNCHD_ADMIN_LABEL",
]);
const SAFE_LAUNCHD_LABEL_PATTERN = /^[A-Za-z0-9_.-]+$/;

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

interface ConfigImportResult {
  dryRun: boolean;
  outputLines: string[];
  roomCount: number;
  restartRequired: boolean;
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
  historyService?: HistoryService;
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
  private readonly historyService: HistoryService;
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
    this.historyService =
      options.historyService ??
      new HistoryService(stateStore, logger, {
        cleanupOwner: `admin-api:${process.pid}`,
      });
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
    let operationAuditEnabled = false;
    let operationAuditResolved = false;
    let appendResolvedOperationAudit = (
      _outcome: OperationAuditOutcome,
      _statusCode: number,
      _reason: string | null = null,
      _metadata: Record<string, unknown> = {},
    ): void => {};

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

      const requestMethod = (req.method ?? "GET").toUpperCase();
      const scopeRequirement = resolveAdminScopeRequirement(requestMethod, url.pathname);
      const authIdentity = scopeRequirement ? this.resolveAdminIdentity(req) : null;
      const requestId = normalizeHeaderValue(req.headers["x-request-id"]);
      operationAuditEnabled =
        Boolean(scopeRequirement) &&
        Boolean(authIdentity) &&
        shouldLogSuccessfulAuthEvent(url.pathname, requestMethod);
      const operationAuditActor = authIdentity ? resolveAuditActor(req, authIdentity) : null;
      appendResolvedOperationAudit = (
        outcome: OperationAuditOutcome,
        statusCode: number,
        reason: string | null = null,
        metadata: Record<string, unknown> = {},
      ): void => {
        if (!scopeRequirement || !authIdentity || !operationAuditEnabled || operationAuditResolved) {
          return;
        }
        operationAuditResolved = true;
        this.appendOperationAuditLog({
          actor: operationAuditActor,
          source: authIdentity.source,
          surface: "admin",
          action: scopeRequirement.action,
          resource: url.pathname,
          method: requestMethod,
          path: url.pathname,
          outcome,
          reason,
          requiredScopes: scopeRequirement.requiredScopes,
          grantedScopes: authIdentity.scopes,
          metadata: {
            statusCode,
            role: authIdentity.role,
            ...(requestId ? { requestId } : {}),
            ...metadata,
          },
        });
      };
      if (scopeRequirement && !authIdentity) {
        operationAuditResolved = true;
        this.appendOperationAuditLog({
          actor: resolveAuditActor(req, null),
          source: "none",
          surface: "admin",
          action: scopeRequirement.action,
          resource: url.pathname,
          method: requestMethod,
          path: url.pathname,
          outcome: "denied",
          reason: "unauthorized",
          requiredScopes: scopeRequirement.requiredScopes,
          grantedScopes: [],
          metadata: {
            statusCode: 401,
            ...(requestId ? { requestId } : {}),
          },
        });
        this.sendJson(res, 401, {
          ok: false,
          error: "Unauthorized. Provide Authorization: Bearer <ADMIN_TOKEN> (or token from ADMIN_TOKENS_JSON).",
        });
        return;
      }
      if (scopeRequirement && authIdentity && !hasRequiredScopes(authIdentity.scopes, scopeRequirement.requiredScopes)) {
        const missingScopes = listMissingScopes(authIdentity.scopes, scopeRequirement.requiredScopes);
        operationAuditResolved = true;
        this.appendOperationAuditLog({
          actor: resolveAuditActor(req, authIdentity),
          source: authIdentity.source,
          surface: "admin",
          action: scopeRequirement.action,
          resource: url.pathname,
          method: requestMethod,
          path: url.pathname,
          outcome: "denied",
          reason: `missing_scope:${missingScopes.join(",")}`,
          requiredScopes: scopeRequirement.requiredScopes,
          grantedScopes: authIdentity.scopes,
          metadata: {
            statusCode: 403,
            missingScopes,
            ...(requestId ? { requestId } : {}),
          },
        });
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
            canWrite: authIdentity ? hasAnyAdminWriteScope(authIdentity.scopes) : false,
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
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "config_read_global",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/config/validate") {
        const body = asObject(await readJsonBody(req, ADMIN_MAX_JSON_BODY_BYTES), "config validate payload");
        const actor = resolveAuditActor(req, authIdentity);
        const kind = normalizeString(body.kind, "", "kind").toLowerCase();
        const data = "data" in body ? body.data : body;

        if (kind === "global") {
          const result = this.validateGlobalConfigPayload(data);
          this.stateStore.appendConfigRevision(
            actor,
            `validate global config: ${result.checkedKeys.join(", ")}`,
            JSON.stringify({
              type: "config_validate_global",
              checkedKeys: result.checkedKeys,
              hotAppliedKeys: result.hotAppliedKeys,
              restartRequiredKeys: result.restartRequiredKeys,
            }),
          );
          this.sendJson(res, 200, {
            ok: true,
            data: {
              kind: "global",
              valid: true,
              checkedKeys: result.checkedKeys,
              hotAppliedKeys: result.hotAppliedKeys,
              restartRequiredKeys: result.restartRequiredKeys,
              restartRequired: result.restartRequiredKeys.length > 0,
            },
          });
          appendResolvedOperationAudit("allowed", 200, null, {
            kind: "global",
          });
          return;
        }

        if (kind === "room") {
          const result = this.validateRoomConfigPayload(data);
          this.stateStore.appendConfigRevision(
            actor,
            `validate room config: ${result.roomId}`,
            JSON.stringify({
              type: "config_validate_room",
              roomId: result.roomId,
              workdir: result.workdir,
            }),
          );
          this.sendJson(res, 200, {
            ok: true,
            data: {
              kind: "room",
              valid: true,
              ...result,
            },
          });
          appendResolvedOperationAudit("allowed", 200, null, {
            kind: "room",
            roomId: result.roomId,
          });
          return;
        }

        if (kind === "snapshot") {
          if (!("snapshot" in body)) {
            throw new HttpError(400, "snapshot is required when kind=snapshot.");
          }
          const result = await this.runConfigImportFromSnapshot(body.snapshot, true, actor);
          this.stateStore.appendConfigRevision(
            actor,
            "validate config snapshot (dry-run)",
            JSON.stringify({
              type: "config_validate_snapshot",
              roomCount: result.roomCount,
              outputLines: result.outputLines,
            }),
          );
          this.sendJson(res, 200, {
            ok: true,
            data: {
              kind: "snapshot",
              valid: true,
              ...result,
            },
          });
          appendResolvedOperationAudit("allowed", 200, null, {
            kind: "snapshot",
          });
          return;
        }

        throw new HttpError(400, 'kind must be one of "global", "room", "snapshot".');
      }

      if (req.method === "GET" && url.pathname === "/api/admin/config/export") {
        const actor = resolveAuditActor(req, authIdentity);
        const snapshot = buildConfigSnapshot(this.config, this.configService.listRoomSettings(), new Date());
        this.stateStore.appendConfigRevision(
          actor,
          "export config snapshot",
          JSON.stringify({
            type: "config_snapshot_export",
            schemaVersion: snapshot.schemaVersion,
            roomCount: snapshot.rooms.length,
          }),
        );
        this.sendJson(res, 200, {
          ok: true,
          data: snapshot,
        });
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "config_export",
          roomCount: snapshot.rooms.length,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/config/import") {
        const body = asObject(await readJsonBody(req, ADMIN_MAX_JSON_BODY_BYTES), "config import payload");
        if (!("snapshot" in body)) {
          throw new HttpError(400, "snapshot is required.");
        }
        const actor = resolveAuditActor(req, authIdentity);
        const dryRun = "dryRun" in body ? normalizeBoolean(body.dryRun, false) : false;
        const result = await this.runConfigImportFromSnapshot(body.snapshot, dryRun, actor);
        if (dryRun) {
          this.stateStore.appendConfigRevision(
            actor,
            "validate config snapshot (dry-run)",
            JSON.stringify({
              type: "config_snapshot_import_dry_run",
              roomCount: result.roomCount,
              outputLines: result.outputLines,
            }),
          );
        }
        this.sendJson(res, 200, {
          ok: true,
          data: result,
        });
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "config_import",
          dryRun,
          roomCount: result.roomCount,
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
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "config_update_global",
          updatedKeys: result.updatedKeys,
          restartRequired: result.restartRequired,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/config/rooms") {
        this.sendJson(res, 200, {
          ok: true,
          data: this.configService.listRoomSettings(),
        });
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "config_read_rooms",
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
          appendResolvedOperationAudit("allowed", 200, null, {
            type: "config_read_room",
            roomId,
          });
          return;
        }

        if (req.method === "PUT") {
          const body = await readJsonBody(req, ADMIN_MAX_JSON_BODY_BYTES);
          const actor = resolveAuditActor(req, authIdentity);
          const room = this.updateRoomConfig(roomId, body, actor);
          this.sendJson(res, 200, { ok: true, data: room });
          appendResolvedOperationAudit("allowed", 200, null, {
            type: "config_update_room",
            roomId,
          });
          return;
        }

        if (req.method === "DELETE") {
          const actor = resolveAuditActor(req, authIdentity);
          this.configService.deleteRoomSettings(roomId, actor);
          this.sendJson(res, 200, { ok: true, roomId });
          appendResolvedOperationAudit("allowed", 200, null, {
            type: "config_delete_room",
            roomId,
          });
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/admin/audit") {
        const limit = normalizePositiveInt(url.searchParams.get("limit"), 20, 1, 200);
        const kind = normalizeAuditKind(url.searchParams.get("kind"));
        const surface = normalizeOptionalAuditSurface(url.searchParams.get("surface"));
        const outcome = normalizeOptionalAuditOutcome(url.searchParams.get("outcome"));
        const actor = normalizeOptionalAuditFilterValue(url.searchParams.get("actor"));
        const source = normalizeOptionalAuditFilterValue(url.searchParams.get("source"));
        const action = normalizeOptionalAuditFilterValue(url.searchParams.get("action"));
        const method = normalizeOptionalAuditMethod(url.searchParams.get("method"));
        const pathPrefix = normalizeOptionalAuditFilterValue(url.searchParams.get("pathPrefix"));
        const reasonContains = normalizeOptionalAuditFilterValue(url.searchParams.get("reasonContains"));
        const createdFrom = parseOptionalTimestampQuery(url.searchParams.get("createdFrom"), "createdFrom");
        const createdTo = parseOptionalTimestampQuery(url.searchParams.get("createdTo"), "createdTo");
        if (createdFrom !== null && createdTo !== null && createdFrom > createdTo) {
          throw new HttpError(400, "createdFrom must be less than or equal to createdTo.");
        }
        const operationQuery = {
          limit,
          surface,
          outcome,
          actor,
          source,
          action,
          method,
          pathPrefix,
          reasonContains,
          ...(createdFrom !== null ? { createdFrom } : {}),
          ...(createdTo !== null ? { createdTo } : {}),
        };

        if (kind === "config") {
          this.sendJson(res, 200, {
            ok: true,
            data: this.stateStore.listConfigRevisions(limit).map((entry) => formatConfigAuditEntry(entry)),
          });
          appendResolvedOperationAudit("allowed", 200, null, {
            kind: "config",
            limit,
          });
          return;
        }

        if (kind === "operations") {
          this.sendJson(res, 200, {
            ok: true,
            data: this.stateStore.listOperationAuditLogs(operationQuery).map((entry) => formatOperationAuditEntry(entry)),
          });
          appendResolvedOperationAudit("allowed", 200, null, {
            kind: "operations",
            limit,
            ...(surface ? { surface } : {}),
            ...(outcome ? { outcome } : {}),
            ...(actor ? { actor } : {}),
            ...(source ? { source } : {}),
            ...(action ? { action } : {}),
            ...(method ? { method } : {}),
            ...(pathPrefix ? { pathPrefix } : {}),
            ...(reasonContains ? { reasonContains } : {}),
            ...(createdFrom !== null ? { createdFrom } : {}),
            ...(createdTo !== null ? { createdTo } : {}),
          });
          return;
        }

        const configEntries = this.stateStore.listConfigRevisions(limit).map((entry) => formatConfigAuditEntry(entry));
        const operationEntries = this.stateStore
          .listOperationAuditLogs(operationQuery)
          .map((entry) => formatOperationAuditEntry(entry));
        const merged = [...configEntries, ...operationEntries]
          .sort((left, right) => right.createdAt - left.createdAt)
          .slice(0, limit);

        this.sendJson(res, 200, {
          ok: true,
          data: merged,
        });
        appendResolvedOperationAudit("allowed", 200, null, {
          kind: "all",
          limit,
          ...(surface ? { surface } : {}),
          ...(outcome ? { outcome } : {}),
          ...(actor ? { actor } : {}),
          ...(source ? { source } : {}),
          ...(action ? { action } : {}),
          ...(method ? { method } : {}),
          ...(pathPrefix ? { pathPrefix } : {}),
          ...(reasonContains ? { reasonContains } : {}),
          ...(createdFrom !== null ? { createdFrom } : {}),
          ...(createdTo !== null ? { createdTo } : {}),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/sessions/export") {
        const roomId = normalizeOptionalString(url.searchParams.get("roomId"));
        const userId = normalizeOptionalString(url.searchParams.get("userId"));
        const from = parseOptionalTimestampQuery(url.searchParams.get("from"), "from");
        const to = parseOptionalTimestampQuery(url.searchParams.get("to"), "to");
        if (from !== null && to !== null && from > to) {
          throw new HttpError(400, "from must be less than or equal to to.");
        }
        const limit = normalizePositiveInt(
          url.searchParams.get("limit"),
          ADMIN_DEFAULT_SESSION_QUERY_LIMIT,
          1,
          ADMIN_MAX_SESSION_QUERY_LIMIT,
        );
        const offset = normalizeNonNegativeInt(url.searchParams.get("offset"), 0);
        const includeMessages = normalizeBooleanQuery(url.searchParams.get("includeMessages"), true);
        const messageLimitPerSession = normalizePositiveInt(
          url.searchParams.get("messageLimitPerSession"),
          ADMIN_DEFAULT_EXPORT_MESSAGE_LIMIT,
          1,
          ADMIN_MAX_EXPORT_MESSAGE_LIMIT,
        );

        const exported = this.historyService.exportSessionHistory({
          roomId,
          userId,
          from,
          to,
          limit,
          offset,
          includeMessages,
          messageLimitPerSession,
        });
        this.sendJson(res, 200, {
          ok: true,
          data: {
            exportedAt: exported.exportedAt,
            exportedAtIso: new Date(exported.exportedAt).toISOString(),
            total: exported.total,
            sessions: exported.items.map((entry) => formatSessionExportEntry(entry)),
          },
          paging: {
            total: exported.total,
            limit,
            offset,
            hasMore: offset + exported.items.length < exported.total,
          },
        });
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "sessions_export",
          limit,
          offset,
          includeMessages,
          messageLimitPerSession,
          ...(roomId ? { roomId } : {}),
          ...(userId ? { userId } : {}),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/sessions") {
        const roomId = normalizeOptionalString(url.searchParams.get("roomId"));
        const userId = normalizeOptionalString(url.searchParams.get("userId"));
        const from = parseOptionalTimestampQuery(url.searchParams.get("from"), "from");
        const to = parseOptionalTimestampQuery(url.searchParams.get("to"), "to");
        if (from !== null && to !== null && from > to) {
          throw new HttpError(400, "from must be less than or equal to to.");
        }
        const limit = normalizePositiveInt(
          url.searchParams.get("limit"),
          ADMIN_DEFAULT_SESSION_QUERY_LIMIT,
          1,
          ADMIN_MAX_SESSION_QUERY_LIMIT,
        );
        const offset = normalizeNonNegativeInt(url.searchParams.get("offset"), 0);
        const result = this.stateStore.listSessionHistory({
          roomId,
          userId,
          from,
          to,
          limit,
          offset,
        });
        this.sendJson(res, 200, {
          ok: true,
          data: result.items.map((entry) => formatSessionHistoryEntry(entry)),
          paging: {
            total: result.total,
            limit,
            offset,
            hasMore: offset + result.items.length < result.total,
          },
        });
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "sessions_list",
          limit,
          offset,
          ...(roomId ? { roomId } : {}),
          ...(userId ? { userId } : {}),
        });
        return;
      }

      const sessionMessageMatch = /^\/api\/admin\/sessions\/(.+)\/messages$/.exec(url.pathname);
      if (sessionMessageMatch) {
        if (req.method !== "GET") {
          res.setHeader("Allow", "GET, OPTIONS");
          this.sendJson(res, 405, {
            ok: false,
            error: `Method not allowed: ${req.method ?? "GET"}.`,
          });
          appendResolvedOperationAudit("denied", 405, "method_not_allowed");
          return;
        }
        const sessionKey = decodePathParam(sessionMessageMatch[1], "sessionKey");
        const limit = normalizePositiveInt(
          url.searchParams.get("limit"),
          ADMIN_DEFAULT_SESSION_MESSAGES_LIMIT,
          1,
          ADMIN_MAX_SESSION_MESSAGES_LIMIT,
        );
        this.sendJson(res, 200, {
          ok: true,
          data: this.stateStore.listRecentConversationMessages(sessionKey, limit).map((entry) => formatSessionMessageEntry(entry)),
        });
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "session_messages",
          sessionKey,
          limit,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/history/retention") {
        this.sendJson(res, 200, {
          ok: true,
          data: formatHistoryRetentionPolicyEntry(this.historyService.getRetentionPolicy()),
        });
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "history_retention_read",
        });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/admin/history/retention") {
        const body = asObject(await readJsonBody(req, ADMIN_MAX_JSON_BODY_BYTES), "history retention payload");
        const current = this.historyService.getRetentionPolicy();
        const next = {
          enabled: "enabled" in body ? normalizeBoolean(body.enabled, current.enabled) : current.enabled,
          retentionDays:
            "retentionDays" in body ? normalizePositiveInt(body.retentionDays, current.retentionDays, 1, 3_650) : current.retentionDays,
          cleanupIntervalMinutes:
            "cleanupIntervalMinutes" in body
              ? normalizePositiveInt(body.cleanupIntervalMinutes, current.cleanupIntervalMinutes, 5, 10_080)
              : current.cleanupIntervalMinutes,
          maxDeleteSessions:
            "maxDeleteSessions" in body
              ? normalizePositiveInt(body.maxDeleteSessions, current.maxDeleteSessions, 1, 10_000)
              : current.maxDeleteSessions,
        };
        const actor = resolveAuditActor(req, authIdentity);
        const updated = this.historyService.updateRetentionPolicy(next, actor);
        this.sendJson(res, 200, {
          ok: true,
          data: formatHistoryRetentionPolicyEntry(updated),
        });
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "history_retention_update",
          enabled: updated.enabled,
          retentionDays: updated.retentionDays,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/history/cleanup/runs") {
        const limit = normalizePositiveInt(
          url.searchParams.get("limit"),
          ADMIN_DEFAULT_HISTORY_CLEANUP_RUN_LIMIT,
          1,
          ADMIN_MAX_HISTORY_CLEANUP_RUN_LIMIT,
        );
        this.sendJson(res, 200, {
          ok: true,
          data: this.historyService.listCleanupRuns(limit).map((entry) => formatHistoryCleanupRunEntry(entry)),
        });
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "history_cleanup_runs",
          limit,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/history/cleanup") {
        const body = asObject(await readJsonBody(req, ADMIN_MAX_JSON_BODY_BYTES), "history cleanup payload");
        const actor = resolveAuditActor(req, authIdentity);
        const run = this.historyService.runCleanup({
          trigger: "manual",
          requestedBy: actor,
          dryRun: "dryRun" in body ? normalizeBoolean(body.dryRun, false) : false,
          retentionDays:
            "retentionDays" in body ? normalizePositiveInt(body.retentionDays, 30, 1, 3_650) : undefined,
          maxDeleteSessions:
            "maxDeleteSessions" in body ? normalizePositiveInt(body.maxDeleteSessions, 500, 1, 10_000) : undefined,
        });
        const cleanupStatusCode = run.status === "failed" ? 500 : 200;
        this.sendJson(res, cleanupStatusCode, {
          ok: run.status !== "failed",
          data: formatHistoryCleanupRunEntry(run),
        });
        appendResolvedOperationAudit(run.status === "failed" ? "error" : "allowed", cleanupStatusCode, null, {
          type: "history_cleanup",
          runId: run.id,
          dryRun: run.dryRun,
          cleanupStatus: run.status,
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
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "health_check",
          codexOk: codex.ok,
          matrixOk: matrix.ok,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/diagnostics") {
        const diagnostics = await this.buildDiagnosticsSnapshot();
        this.sendJson(res, 200, {
          ok: diagnostics.ok,
          data: diagnostics,
        });
        appendResolvedOperationAudit("allowed", 200, null, {
          type: "diagnostics_read",
          diagnosticsOk: diagnostics.ok,
          warnings: diagnostics.warnings.length,
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
          appendResolvedOperationAudit("allowed", 200, null, {
            type: "service_restart",
            restartAdmin,
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
      appendResolvedOperationAudit("denied", 404, "not_found");
    } catch (error) {
      if (operationAuditEnabled) {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        appendResolvedOperationAudit(statusCode >= 500 ? "error" : "denied", statusCode, formatError(error));
      }
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
    let updateCheckChanged = false;
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

    if ("outputLanguage" in body) {
      const value = normalizeOutputLanguage(body.outputLanguage, this.config.outputLanguage);
      this.config.outputLanguage = value;
      envUpdates.OUTPUT_LANGUAGE = value;
      markUpdatedKey("outputLanguage");
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
      let nextWindowMs = this.config.rateLimiter.windowMs;
      let nextMaxRequestsPerUser = this.config.rateLimiter.maxRequestsPerUser;
      let nextMaxRequestsPerRoom = this.config.rateLimiter.maxRequestsPerRoom;
      let nextMaxConcurrentGlobal = this.config.rateLimiter.maxConcurrentGlobal;
      let nextMaxConcurrentPerUser = this.config.rateLimiter.maxConcurrentPerUser;
      let nextMaxConcurrentPerRoom = this.config.rateLimiter.maxConcurrentPerRoom;
      if ("windowMs" in limiter) {
        nextWindowMs = normalizePositiveInt(limiter.windowMs, this.config.rateLimiter.windowMs, 1, Number.MAX_SAFE_INTEGER);
        markUpdatedKey("rateLimiter.windowMs");
      }
      if ("maxRequestsPerUser" in limiter) {
        nextMaxRequestsPerUser = normalizeNonNegativeInt(
          limiter.maxRequestsPerUser,
          this.config.rateLimiter.maxRequestsPerUser,
        );
        markUpdatedKey("rateLimiter.maxRequestsPerUser");
      }
      if ("maxRequestsPerRoom" in limiter) {
        nextMaxRequestsPerRoom = normalizeNonNegativeInt(
          limiter.maxRequestsPerRoom,
          this.config.rateLimiter.maxRequestsPerRoom,
        );
        markUpdatedKey("rateLimiter.maxRequestsPerRoom");
      }
      if ("maxConcurrentGlobal" in limiter) {
        nextMaxConcurrentGlobal = normalizeNonNegativeInt(
          limiter.maxConcurrentGlobal,
          this.config.rateLimiter.maxConcurrentGlobal,
        );
        markUpdatedKey("rateLimiter.maxConcurrentGlobal");
      }
      if ("maxConcurrentPerUser" in limiter) {
        nextMaxConcurrentPerUser = normalizeNonNegativeInt(
          limiter.maxConcurrentPerUser,
          this.config.rateLimiter.maxConcurrentPerUser,
        );
        markUpdatedKey("rateLimiter.maxConcurrentPerUser");
      }
      if ("maxConcurrentPerRoom" in limiter) {
        nextMaxConcurrentPerRoom = normalizeNonNegativeInt(
          limiter.maxConcurrentPerRoom,
          this.config.rateLimiter.maxConcurrentPerRoom,
        );
        markUpdatedKey("rateLimiter.maxConcurrentPerRoom");
      }

      if (nextMaxConcurrentGlobal > 0 && nextMaxConcurrentPerUser > nextMaxConcurrentGlobal) {
        throw new HttpError(400, "rateLimiter.maxConcurrentGlobal must be greater than or equal to maxConcurrentPerUser.");
      }
      if (nextMaxConcurrentGlobal > 0 && nextMaxConcurrentPerRoom > nextMaxConcurrentGlobal) {
        throw new HttpError(400, "rateLimiter.maxConcurrentGlobal must be greater than or equal to maxConcurrentPerRoom.");
      }

      this.config.rateLimiter.windowMs = nextWindowMs;
      this.config.rateLimiter.maxRequestsPerUser = nextMaxRequestsPerUser;
      this.config.rateLimiter.maxRequestsPerRoom = nextMaxRequestsPerRoom;
      this.config.rateLimiter.maxConcurrentGlobal = nextMaxConcurrentGlobal;
      this.config.rateLimiter.maxConcurrentPerUser = nextMaxConcurrentPerUser;
      this.config.rateLimiter.maxConcurrentPerRoom = nextMaxConcurrentPerRoom;
      envUpdates.RATE_LIMIT_WINDOW_SECONDS = String(Math.max(1, Math.round(nextWindowMs / 1000)));
      envUpdates.RATE_LIMIT_MAX_REQUESTS_PER_USER = String(nextMaxRequestsPerUser);
      envUpdates.RATE_LIMIT_MAX_REQUESTS_PER_ROOM = String(nextMaxRequestsPerRoom);
      envUpdates.RATE_LIMIT_MAX_CONCURRENT_GLOBAL = String(nextMaxConcurrentGlobal);
      envUpdates.RATE_LIMIT_MAX_CONCURRENT_PER_USER = String(nextMaxConcurrentPerUser);
      envUpdates.RATE_LIMIT_MAX_CONCURRENT_PER_ROOM = String(nextMaxConcurrentPerRoom);
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

    if ("matrixProgressDeliveryMode" in body) {
      const value = normalizeProgressDeliveryMode(body.matrixProgressDeliveryMode, this.config.matrixProgressDeliveryMode);
      this.config.matrixProgressDeliveryMode = value;
      envUpdates.MATRIX_PROGRESS_DELIVERY_MODE = value;
      markUpdatedKey("matrixProgressDeliveryMode");
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

    if ("matrixNoticeBadgeEnabled" in body) {
      const value = normalizeBoolean(body.matrixNoticeBadgeEnabled, this.config.matrixNoticeBadgeEnabled);
      this.config.matrixNoticeBadgeEnabled = value;
      envUpdates.MATRIX_NOTICE_BADGE_ENABLED = String(value);
      markUpdatedKey("matrixNoticeBadgeEnabled");
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
    }

    if ("autoDev" in body) {
      const autoDev = asObject(body.autoDev, "autoDev");
      if ("loopMaxRuns" in autoDev) {
        const value = normalizePositiveInt(autoDev.loopMaxRuns, 20, 0, Number.MAX_SAFE_INTEGER);
        envUpdates.AUTODEV_LOOP_MAX_RUNS = String(value);
        markUpdatedKey("autoDev.loopMaxRuns");
      }
      if ("loopMaxMinutes" in autoDev) {
        const value = normalizePositiveInt(autoDev.loopMaxMinutes, 120, 0, Number.MAX_SAFE_INTEGER);
        envUpdates.AUTODEV_LOOP_MAX_MINUTES = String(value);
        markUpdatedKey("autoDev.loopMaxMinutes");
      }
      if ("autoCommit" in autoDev) {
        const value = normalizeBoolean(autoDev.autoCommit, true);
        envUpdates.AUTODEV_AUTO_COMMIT = String(value);
        markUpdatedKey("autoDev.autoCommit");
      }
      if ("gitAuthorName" in autoDev) {
        const value = normalizeString(autoDev.gitAuthorName, "CodeHarbor AutoDev", "autoDev.gitAuthorName");
        envUpdates.AUTODEV_GIT_AUTHOR_NAME = value || "CodeHarbor AutoDev";
        markUpdatedKey("autoDev.gitAuthorName");
      }
      if ("gitAuthorEmail" in autoDev) {
        const value = normalizeString(autoDev.gitAuthorEmail, "autodev@codeharbor.local", "autoDev.gitAuthorEmail");
        envUpdates.AUTODEV_GIT_AUTHOR_EMAIL = value || "autodev@codeharbor.local";
        markUpdatedKey("autoDev.gitAuthorEmail");
      }
      if ("autoReleaseEnabled" in autoDev) {
        const value = normalizeBoolean(autoDev.autoReleaseEnabled, true);
        envUpdates.AUTODEV_AUTO_RELEASE_ENABLED = String(value);
        markUpdatedKey("autoDev.autoReleaseEnabled");
      }
      if ("autoReleasePush" in autoDev) {
        const value = normalizeBoolean(autoDev.autoReleasePush, false);
        envUpdates.AUTODEV_AUTO_RELEASE_PUSH = String(value);
        markUpdatedKey("autoDev.autoReleasePush");
      }
      if ("runArchiveEnabled" in autoDev) {
        const value = normalizeBoolean(autoDev.runArchiveEnabled, true);
        envUpdates.AUTODEV_RUN_ARCHIVE_ENABLED = String(value);
        markUpdatedKey("autoDev.runArchiveEnabled");
      }
      if ("runArchiveDir" in autoDev) {
        const value = String(autoDev.runArchiveDir ?? "").trim();
        if (!value) {
          throw new HttpError(400, "autoDev.runArchiveDir cannot be empty.");
        }
        envUpdates.AUTODEV_RUN_ARCHIVE_DIR = value;
        markUpdatedKey("autoDev.runArchiveDir");
      }
      if ("validationStrict" in autoDev) {
        const value = normalizeBoolean(autoDev.validationStrict, false);
        envUpdates.AUTODEV_VALIDATION_STRICT = String(value);
        markUpdatedKey("autoDev.validationStrict");
      }
      if ("stageOutputEchoEnabled" in autoDev) {
        const value = normalizeBoolean(autoDev.stageOutputEchoEnabled, true);
        envUpdates.AUTODEV_STAGE_OUTPUT_ECHO_ENABLED = String(value);
        markUpdatedKey("autoDev.stageOutputEchoEnabled");
      }
      if ("maxConsecutiveFailures" in autoDev) {
        const value = normalizePositiveInt(autoDev.maxConsecutiveFailures, 3, 1, Number.MAX_SAFE_INTEGER);
        envUpdates.AUTODEV_MAX_CONSECUTIVE_FAILURES = String(value);
        markUpdatedKey("autoDev.maxConsecutiveFailures");
      }
      if ("initEnhancementEnabled" in autoDev) {
        const value = normalizeBoolean(autoDev.initEnhancementEnabled, true);
        envUpdates.AUTODEV_INIT_ENHANCEMENT_ENABLED = String(value);
        markUpdatedKey("autoDev.initEnhancementEnabled");
      }
      if ("initEnhancementTimeoutMs" in autoDev) {
        const value = normalizePositiveInt(autoDev.initEnhancementTimeoutMs, 480_000, 1, Number.MAX_SAFE_INTEGER);
        envUpdates.AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS = String(value);
        markUpdatedKey("autoDev.initEnhancementTimeoutMs");
      }
      if ("initEnhancementMaxChars" in autoDev) {
        const value = normalizePositiveInt(autoDev.initEnhancementMaxChars, 4_000, 1, Number.MAX_SAFE_INTEGER);
        envUpdates.AUTODEV_INIT_ENHANCEMENT_MAX_CHARS = String(value);
        markUpdatedKey("autoDev.initEnhancementMaxChars");
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
      if ("imageMaxBytes" in compat) {
        const value = normalizePositiveInt(
          compat.imageMaxBytes,
          this.config.cliCompat.imageMaxBytes,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        this.config.cliCompat.imageMaxBytes = value;
        envUpdates.CLI_COMPAT_IMAGE_MAX_BYTES = String(value);
        markUpdatedKey("cliCompat.imageMaxBytes");
      }
      if ("imageMaxCount" in compat) {
        const value = normalizePositiveInt(
          compat.imageMaxCount,
          this.config.cliCompat.imageMaxCount,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        this.config.cliCompat.imageMaxCount = value;
        envUpdates.CLI_COMPAT_IMAGE_MAX_COUNT = String(value);
        markUpdatedKey("cliCompat.imageMaxCount");
      }
      if ("imageAllowedMimeTypes" in compat) {
        const value = normalizeMimeTypeCsv(compat.imageAllowedMimeTypes, this.config.cliCompat.imageAllowedMimeTypes);
        this.config.cliCompat.imageAllowedMimeTypes = value;
        envUpdates.CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES = value.join(",");
        markUpdatedKey("cliCompat.imageAllowedMimeTypes");
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
      if ("recordPath" in compat) {
        const value = normalizeString(compat.recordPath, this.config.cliCompat.recordPath ?? "", "cliCompat.recordPath");
        this.config.cliCompat.recordPath = value ? path.resolve(value) : null;
        envUpdates.CLI_COMPAT_RECORD_PATH = this.config.cliCompat.recordPath ?? "";
        markUpdatedKey("cliCompat.recordPath");
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
      if ("roleSkills" in workflow) {
        const roleSkills = asObject(workflow.roleSkills, "agentWorkflow.roleSkills");
        const currentRoleSkills = ensureAgentWorkflowRoleSkillsConfig(currentAgentWorkflow);
        if ("enabled" in roleSkills) {
          const value = normalizeBoolean(roleSkills.enabled, currentRoleSkills.enabled);
          currentRoleSkills.enabled = value;
          envUpdates.AGENT_WORKFLOW_ROLE_SKILLS_ENABLED = String(value);
          markUpdatedKey("agentWorkflow.roleSkills.enabled");
        }
        if ("mode" in roleSkills) {
          const value = normalizeRoleSkillDisclosureMode(roleSkills.mode, currentRoleSkills.mode);
          currentRoleSkills.mode = value;
          envUpdates.AGENT_WORKFLOW_ROLE_SKILLS_MODE = value;
          markUpdatedKey("agentWorkflow.roleSkills.mode");
        }
        if ("maxChars" in roleSkills) {
          const value = normalizeOptionalPositiveInt(roleSkills.maxChars, currentRoleSkills.maxChars);
          currentRoleSkills.maxChars = value;
          envUpdates.AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS = value === null ? "" : String(value);
          markUpdatedKey("agentWorkflow.roleSkills.maxChars");
        }
        if ("roots" in roleSkills) {
          const value = normalizeRoleSkillRoots(roleSkills.roots, currentRoleSkills.roots);
          currentRoleSkills.roots = value;
          envUpdates.AGENT_WORKFLOW_ROLE_SKILLS_ROOTS = value.join(",");
          markUpdatedKey("agentWorkflow.roleSkills.roots");
        }
        if ("roleAssignments" in roleSkills) {
          const value = normalizeRoleSkillAssignments(roleSkills.roleAssignments, currentRoleSkills.roleAssignments);
          currentRoleSkills.roleAssignments = value;
          envUpdates.AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON = serializeRoleSkillAssignments(value);
          markUpdatedKey("agentWorkflow.roleSkills.roleAssignments");
        }
      }
    }

    if ("envOverrides" in body) {
      const overrides = normalizeEnvOverrides(body.envOverrides);
      for (const [key, value] of Object.entries(overrides)) {
        envUpdates[key] = value;
        markUpdatedKey(`envOverrides.${key}`);
      }
    }

    if (updatedKeys.length === 0) {
      throw new HttpError(400, "No supported global config fields provided.");
    }

    if ("envOverrides" in body) {
      const nextConfig = resolveNextConfigFromEnvUpdates(this.config, this.stateStore, envUpdates);
      Object.assign(this.config, nextConfig);
    }
    if (
      !this.hasCustomPackageUpdateChecker &&
      (updateCheckChanged ||
        "PACKAGE_UPDATE_CHECK_ENABLED" in envUpdates ||
        "PACKAGE_UPDATE_CHECK_TIMEOUT_MS" in envUpdates ||
        "PACKAGE_UPDATE_CHECK_TTL_MS" in envUpdates)
    ) {
      this.packageUpdateChecker = this.createPackageUpdateChecker();
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

  private validateGlobalConfigPayload(rawBody: unknown): {
    checkedKeys: string[];
    hotAppliedKeys: string[];
    restartRequiredKeys: string[];
  } {
    const body = asObject(rawBody, "global config payload");
    const checkedKeys: string[] = [];
    const hotAppliedKeys: string[] = [];
    const restartRequiredKeys: string[] = [];
    const markCheckedKey = (key: string): void => {
      checkedKeys.push(key);
      if (isHotGlobalConfigKey(key)) {
        hotAppliedKeys.push(key);
        return;
      }
      restartRequiredKeys.push(key);
    };

    let nextMaxConcurrentGlobal = this.config.rateLimiter.maxConcurrentGlobal;
    let nextMaxConcurrentPerUser = this.config.rateLimiter.maxConcurrentPerUser;
    let nextMaxConcurrentPerRoom = this.config.rateLimiter.maxConcurrentPerRoom;

    if ("matrixCommandPrefix" in body) {
      normalizeString(body.matrixCommandPrefix, this.config.matrixCommandPrefix, "matrixCommandPrefix");
      markCheckedKey("matrixCommandPrefix");
    }

    if ("outputLanguage" in body) {
      normalizeOutputLanguage(body.outputLanguage, this.config.outputLanguage);
      markCheckedKey("outputLanguage");
    }

    if ("codexWorkdir" in body) {
      const workdir = path.resolve(normalizeString(body.codexWorkdir, this.config.codexWorkdir, "codexWorkdir"));
      ensureDirectory(workdir, "codexWorkdir");
      markCheckedKey("codexWorkdir");
    }

    if ("rateLimiter" in body) {
      const limiter = asObject(body.rateLimiter, "rateLimiter");
      if ("windowMs" in limiter) {
        normalizePositiveInt(limiter.windowMs, this.config.rateLimiter.windowMs, 1, Number.MAX_SAFE_INTEGER);
        markCheckedKey("rateLimiter.windowMs");
      }
      if ("maxRequestsPerUser" in limiter) {
        normalizeNonNegativeInt(limiter.maxRequestsPerUser, this.config.rateLimiter.maxRequestsPerUser);
        markCheckedKey("rateLimiter.maxRequestsPerUser");
      }
      if ("maxRequestsPerRoom" in limiter) {
        normalizeNonNegativeInt(limiter.maxRequestsPerRoom, this.config.rateLimiter.maxRequestsPerRoom);
        markCheckedKey("rateLimiter.maxRequestsPerRoom");
      }
      if ("maxConcurrentGlobal" in limiter) {
        nextMaxConcurrentGlobal = normalizeNonNegativeInt(limiter.maxConcurrentGlobal, this.config.rateLimiter.maxConcurrentGlobal);
        markCheckedKey("rateLimiter.maxConcurrentGlobal");
      }
      if ("maxConcurrentPerUser" in limiter) {
        nextMaxConcurrentPerUser = normalizeNonNegativeInt(limiter.maxConcurrentPerUser, this.config.rateLimiter.maxConcurrentPerUser);
        markCheckedKey("rateLimiter.maxConcurrentPerUser");
      }
      if ("maxConcurrentPerRoom" in limiter) {
        nextMaxConcurrentPerRoom = normalizeNonNegativeInt(limiter.maxConcurrentPerRoom, this.config.rateLimiter.maxConcurrentPerRoom);
        markCheckedKey("rateLimiter.maxConcurrentPerRoom");
      }
    }

    if (nextMaxConcurrentGlobal > 0 && nextMaxConcurrentPerUser > nextMaxConcurrentGlobal) {
      throw new HttpError(400, "rateLimiter.maxConcurrentGlobal must be greater than or equal to maxConcurrentPerUser.");
    }
    if (nextMaxConcurrentGlobal > 0 && nextMaxConcurrentPerRoom > nextMaxConcurrentGlobal) {
      throw new HttpError(400, "rateLimiter.maxConcurrentGlobal must be greater than or equal to maxConcurrentPerRoom.");
    }

    if ("defaultGroupTriggerPolicy" in body) {
      const policy = asObject(body.defaultGroupTriggerPolicy, "defaultGroupTriggerPolicy");
      if ("allowMention" in policy) {
        normalizeBoolean(policy.allowMention, this.config.defaultGroupTriggerPolicy.allowMention);
        markCheckedKey("defaultGroupTriggerPolicy.allowMention");
      }
      if ("allowReply" in policy) {
        normalizeBoolean(policy.allowReply, this.config.defaultGroupTriggerPolicy.allowReply);
        markCheckedKey("defaultGroupTriggerPolicy.allowReply");
      }
      if ("allowActiveWindow" in policy) {
        normalizeBoolean(policy.allowActiveWindow, this.config.defaultGroupTriggerPolicy.allowActiveWindow);
        markCheckedKey("defaultGroupTriggerPolicy.allowActiveWindow");
      }
      if ("allowPrefix" in policy) {
        normalizeBoolean(policy.allowPrefix, this.config.defaultGroupTriggerPolicy.allowPrefix);
        markCheckedKey("defaultGroupTriggerPolicy.allowPrefix");
      }
    }

    if ("matrixProgressUpdates" in body) {
      normalizeBoolean(body.matrixProgressUpdates, this.config.matrixProgressUpdates);
      markCheckedKey("matrixProgressUpdates");
    }

    if ("matrixProgressMinIntervalMs" in body) {
      normalizePositiveInt(body.matrixProgressMinIntervalMs, this.config.matrixProgressMinIntervalMs, 1, Number.MAX_SAFE_INTEGER);
      markCheckedKey("matrixProgressMinIntervalMs");
    }

    if ("matrixProgressDeliveryMode" in body) {
      normalizeProgressDeliveryMode(body.matrixProgressDeliveryMode, this.config.matrixProgressDeliveryMode);
      markCheckedKey("matrixProgressDeliveryMode");
    }

    if ("matrixTypingTimeoutMs" in body) {
      normalizePositiveInt(body.matrixTypingTimeoutMs, this.config.matrixTypingTimeoutMs, 1, Number.MAX_SAFE_INTEGER);
      markCheckedKey("matrixTypingTimeoutMs");
    }

    if ("matrixNoticeBadgeEnabled" in body) {
      normalizeBoolean(body.matrixNoticeBadgeEnabled, this.config.matrixNoticeBadgeEnabled);
      markCheckedKey("matrixNoticeBadgeEnabled");
    }

    if ("sessionActiveWindowMinutes" in body) {
      normalizePositiveInt(
        body.sessionActiveWindowMinutes,
        this.config.sessionActiveWindowMinutes,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      markCheckedKey("sessionActiveWindowMinutes");
    }

    if ("groupDirectModeEnabled" in body) {
      normalizeBoolean(body.groupDirectModeEnabled, this.config.groupDirectModeEnabled);
      markCheckedKey("groupDirectModeEnabled");
    }

    if ("updateCheck" in body) {
      const updateCheck = asObject(body.updateCheck, "updateCheck");
      if ("enabled" in updateCheck) {
        normalizeBoolean(updateCheck.enabled, this.config.updateCheck.enabled);
        markCheckedKey("updateCheck.enabled");
      }
      if ("timeoutMs" in updateCheck) {
        normalizePositiveInt(updateCheck.timeoutMs, this.config.updateCheck.timeoutMs, 1, Number.MAX_SAFE_INTEGER);
        markCheckedKey("updateCheck.timeoutMs");
      }
      if ("ttlMs" in updateCheck) {
        normalizePositiveInt(updateCheck.ttlMs, this.config.updateCheck.ttlMs, 1, Number.MAX_SAFE_INTEGER);
        markCheckedKey("updateCheck.ttlMs");
      }
    }

    if ("autoDev" in body) {
      const autoDev = asObject(body.autoDev, "autoDev");
      if ("loopMaxRuns" in autoDev) {
        normalizePositiveInt(autoDev.loopMaxRuns, 20, 0, Number.MAX_SAFE_INTEGER);
        markCheckedKey("autoDev.loopMaxRuns");
      }
      if ("loopMaxMinutes" in autoDev) {
        normalizePositiveInt(autoDev.loopMaxMinutes, 120, 0, Number.MAX_SAFE_INTEGER);
        markCheckedKey("autoDev.loopMaxMinutes");
      }
      if ("autoCommit" in autoDev) {
        normalizeBoolean(autoDev.autoCommit, true);
        markCheckedKey("autoDev.autoCommit");
      }
      if ("gitAuthorName" in autoDev) {
        normalizeString(autoDev.gitAuthorName, "CodeHarbor AutoDev", "autoDev.gitAuthorName");
        markCheckedKey("autoDev.gitAuthorName");
      }
      if ("gitAuthorEmail" in autoDev) {
        normalizeString(autoDev.gitAuthorEmail, "autodev@codeharbor.local", "autoDev.gitAuthorEmail");
        markCheckedKey("autoDev.gitAuthorEmail");
      }
      if ("autoReleaseEnabled" in autoDev) {
        normalizeBoolean(autoDev.autoReleaseEnabled, true);
        markCheckedKey("autoDev.autoReleaseEnabled");
      }
      if ("autoReleasePush" in autoDev) {
        normalizeBoolean(autoDev.autoReleasePush, false);
        markCheckedKey("autoDev.autoReleasePush");
      }
      if ("runArchiveEnabled" in autoDev) {
        normalizeBoolean(autoDev.runArchiveEnabled, true);
        markCheckedKey("autoDev.runArchiveEnabled");
      }
      if ("runArchiveDir" in autoDev) {
        const value = String(autoDev.runArchiveDir ?? "").trim();
        if (!value) {
          throw new HttpError(400, "autoDev.runArchiveDir cannot be empty.");
        }
        markCheckedKey("autoDev.runArchiveDir");
      }
      if ("validationStrict" in autoDev) {
        normalizeBoolean(autoDev.validationStrict, false);
        markCheckedKey("autoDev.validationStrict");
      }
      if ("stageOutputEchoEnabled" in autoDev) {
        normalizeBoolean(autoDev.stageOutputEchoEnabled, true);
        markCheckedKey("autoDev.stageOutputEchoEnabled");
      }
      if ("maxConsecutiveFailures" in autoDev) {
        normalizePositiveInt(autoDev.maxConsecutiveFailures, 3, 1, Number.MAX_SAFE_INTEGER);
        markCheckedKey("autoDev.maxConsecutiveFailures");
      }
      if ("initEnhancementEnabled" in autoDev) {
        normalizeBoolean(autoDev.initEnhancementEnabled, true);
        markCheckedKey("autoDev.initEnhancementEnabled");
      }
      if ("initEnhancementTimeoutMs" in autoDev) {
        normalizePositiveInt(autoDev.initEnhancementTimeoutMs, 480_000, 1, Number.MAX_SAFE_INTEGER);
        markCheckedKey("autoDev.initEnhancementTimeoutMs");
      }
      if ("initEnhancementMaxChars" in autoDev) {
        normalizePositiveInt(autoDev.initEnhancementMaxChars, 4_000, 1, Number.MAX_SAFE_INTEGER);
        markCheckedKey("autoDev.initEnhancementMaxChars");
      }
    }

    if ("cliCompat" in body) {
      const compat = asObject(body.cliCompat, "cliCompat");
      if ("enabled" in compat) {
        normalizeBoolean(compat.enabled, this.config.cliCompat.enabled);
        markCheckedKey("cliCompat.enabled");
      }
      if ("passThroughEvents" in compat) {
        normalizeBoolean(compat.passThroughEvents, this.config.cliCompat.passThroughEvents);
        markCheckedKey("cliCompat.passThroughEvents");
      }
      if ("preserveWhitespace" in compat) {
        normalizeBoolean(compat.preserveWhitespace, this.config.cliCompat.preserveWhitespace);
        markCheckedKey("cliCompat.preserveWhitespace");
      }
      if ("disableReplyChunkSplit" in compat) {
        normalizeBoolean(compat.disableReplyChunkSplit, this.config.cliCompat.disableReplyChunkSplit);
        markCheckedKey("cliCompat.disableReplyChunkSplit");
      }
      if ("progressThrottleMs" in compat) {
        normalizeNonNegativeInt(compat.progressThrottleMs, this.config.cliCompat.progressThrottleMs);
        markCheckedKey("cliCompat.progressThrottleMs");
      }
      if ("fetchMedia" in compat) {
        normalizeBoolean(compat.fetchMedia, this.config.cliCompat.fetchMedia);
        markCheckedKey("cliCompat.fetchMedia");
      }
      if ("imageMaxBytes" in compat) {
        normalizePositiveInt(compat.imageMaxBytes, this.config.cliCompat.imageMaxBytes, 1, Number.MAX_SAFE_INTEGER);
        markCheckedKey("cliCompat.imageMaxBytes");
      }
      if ("imageMaxCount" in compat) {
        normalizePositiveInt(compat.imageMaxCount, this.config.cliCompat.imageMaxCount, 1, Number.MAX_SAFE_INTEGER);
        markCheckedKey("cliCompat.imageMaxCount");
      }
      if ("imageAllowedMimeTypes" in compat) {
        normalizeMimeTypeCsv(compat.imageAllowedMimeTypes, this.config.cliCompat.imageAllowedMimeTypes);
        markCheckedKey("cliCompat.imageAllowedMimeTypes");
      }
      if ("transcribeAudio" in compat) {
        normalizeBoolean(compat.transcribeAudio, this.config.cliCompat.transcribeAudio);
        markCheckedKey("cliCompat.transcribeAudio");
      }
      if ("audioTranscribeModel" in compat) {
        normalizeString(compat.audioTranscribeModel, this.config.cliCompat.audioTranscribeModel, "cliCompat.audioTranscribeModel");
        markCheckedKey("cliCompat.audioTranscribeModel");
      }
      if ("audioTranscribeTimeoutMs" in compat) {
        normalizePositiveInt(
          compat.audioTranscribeTimeoutMs,
          this.config.cliCompat.audioTranscribeTimeoutMs,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        markCheckedKey("cliCompat.audioTranscribeTimeoutMs");
      }
      if ("audioTranscribeMaxChars" in compat) {
        normalizePositiveInt(
          compat.audioTranscribeMaxChars,
          this.config.cliCompat.audioTranscribeMaxChars,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        markCheckedKey("cliCompat.audioTranscribeMaxChars");
      }
      if ("audioTranscribeMaxRetries" in compat) {
        normalizePositiveInt(compat.audioTranscribeMaxRetries, this.config.cliCompat.audioTranscribeMaxRetries, 0, 10);
        markCheckedKey("cliCompat.audioTranscribeMaxRetries");
      }
      if ("audioTranscribeRetryDelayMs" in compat) {
        normalizeNonNegativeInt(compat.audioTranscribeRetryDelayMs, this.config.cliCompat.audioTranscribeRetryDelayMs);
        markCheckedKey("cliCompat.audioTranscribeRetryDelayMs");
      }
      if ("audioTranscribeMaxBytes" in compat) {
        normalizePositiveInt(
          compat.audioTranscribeMaxBytes,
          this.config.cliCompat.audioTranscribeMaxBytes,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        markCheckedKey("cliCompat.audioTranscribeMaxBytes");
      }
      if ("audioLocalWhisperCommand" in compat) {
        normalizeString(
          compat.audioLocalWhisperCommand,
          this.config.cliCompat.audioLocalWhisperCommand ?? "",
          "cliCompat.audioLocalWhisperCommand",
        );
        markCheckedKey("cliCompat.audioLocalWhisperCommand");
      }
      if ("audioLocalWhisperTimeoutMs" in compat) {
        normalizePositiveInt(
          compat.audioLocalWhisperTimeoutMs,
          this.config.cliCompat.audioLocalWhisperTimeoutMs,
          1,
          Number.MAX_SAFE_INTEGER,
        );
        markCheckedKey("cliCompat.audioLocalWhisperTimeoutMs");
      }
      if ("recordPath" in compat) {
        normalizeString(compat.recordPath, this.config.cliCompat.recordPath ?? "", "cliCompat.recordPath");
        markCheckedKey("cliCompat.recordPath");
      }
    }

    if ("agentWorkflow" in body) {
      const workflow = asObject(body.agentWorkflow, "agentWorkflow");
      const currentAgentWorkflow = ensureAgentWorkflowConfig(this.config);
      if ("enabled" in workflow) {
        normalizeBoolean(workflow.enabled, currentAgentWorkflow.enabled);
        markCheckedKey("agentWorkflow.enabled");
      }
      if ("autoRepairMaxRounds" in workflow) {
        normalizePositiveInt(workflow.autoRepairMaxRounds, currentAgentWorkflow.autoRepairMaxRounds, 0, 10);
        markCheckedKey("agentWorkflow.autoRepairMaxRounds");
      }
      if ("roleSkills" in workflow) {
        const roleSkills = asObject(workflow.roleSkills, "agentWorkflow.roleSkills");
        const currentRoleSkills = ensureAgentWorkflowRoleSkillsConfig(currentAgentWorkflow);
        if ("enabled" in roleSkills) {
          normalizeBoolean(roleSkills.enabled, currentRoleSkills.enabled);
          markCheckedKey("agentWorkflow.roleSkills.enabled");
        }
        if ("mode" in roleSkills) {
          normalizeRoleSkillDisclosureMode(roleSkills.mode, currentRoleSkills.mode);
          markCheckedKey("agentWorkflow.roleSkills.mode");
        }
        if ("maxChars" in roleSkills) {
          normalizeOptionalPositiveInt(roleSkills.maxChars, currentRoleSkills.maxChars);
          markCheckedKey("agentWorkflow.roleSkills.maxChars");
        }
        if ("roots" in roleSkills) {
          normalizeRoleSkillRoots(roleSkills.roots, currentRoleSkills.roots);
          markCheckedKey("agentWorkflow.roleSkills.roots");
        }
        if ("roleAssignments" in roleSkills) {
          normalizeRoleSkillAssignments(roleSkills.roleAssignments, currentRoleSkills.roleAssignments);
          markCheckedKey("agentWorkflow.roleSkills.roleAssignments");
        }
      }
    }

    if ("envOverrides" in body) {
      const overrides = normalizeEnvOverrides(body.envOverrides);
      for (const key of Object.keys(overrides)) {
        markCheckedKey(`envOverrides.${key}`);
      }
      resolveNextConfigFromEnvUpdates(this.config, this.stateStore, overrides);
    }

    if (checkedKeys.length === 0) {
      throw new HttpError(400, "No supported global config fields provided.");
    }

    return {
      checkedKeys,
      hotAppliedKeys,
      restartRequiredKeys,
    };
  }

  private validateRoomConfigPayload(rawBody: unknown): {
    roomId: string;
    enabled: boolean;
    allowMention: boolean;
    allowReply: boolean;
    allowActiveWindow: boolean;
    allowPrefix: boolean;
    workdir: string;
  } {
    const body = asObject(rawBody, "room config payload");
    const roomId = normalizeString(body.roomId, "", "roomId");
    if (!roomId) {
      throw new HttpError(400, "roomId is required.");
    }
    const current = this.configService.getRoomSettings(roomId);
    const workdir = normalizeString(body.workdir, current?.workdir ?? this.config.codexWorkdir, "workdir");
    const normalizedWorkdir = path.resolve(workdir);
    ensureDirectory(normalizedWorkdir, "workdir");
    return {
      roomId,
      enabled: normalizeBoolean(body.enabled, current?.enabled ?? true),
      allowMention: normalizeBoolean(body.allowMention, current?.allowMention ?? true),
      allowReply: normalizeBoolean(body.allowReply, current?.allowReply ?? true),
      allowActiveWindow: normalizeBoolean(body.allowActiveWindow, current?.allowActiveWindow ?? true),
      allowPrefix: normalizeBoolean(body.allowPrefix, current?.allowPrefix ?? true),
      workdir: normalizedWorkdir,
    };
  }

  private async runConfigImportFromSnapshot(snapshot: unknown, dryRun: boolean, actor: string | null): Promise<ConfigImportResult> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-admin-config-"));
    const snapshotPath = path.join(tempDir, "snapshot.json");
    const outputChunks: string[] = [];
    const output = {
      write: (chunk: string | Uint8Array): boolean => {
        outputChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    try {
      fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await runConfigImportCommand({
        cwd: this.cwd,
        filePath: snapshotPath,
        dryRun,
        output,
        actor: actor ?? "admin-api:config-import",
      });
    } catch (error) {
      throw new HttpError(400, formatError(error));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const roomCount =
      snapshot && typeof snapshot === "object" && Array.isArray((snapshot as { rooms?: unknown }).rooms)
        ? ((snapshot as { rooms: unknown[] }).rooms.length ?? 0)
        : 0;
    const outputLines = outputChunks
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return {
      dryRun,
      outputLines,
      roomCount,
      restartRequired: !dryRun,
    };
  }

  private async buildDiagnosticsSnapshot(): Promise<{
    ok: boolean;
    timestamp: string;
    cliProvider: AppConfig["aiCliProvider"];
    health: {
      codex: CodexHealthResult;
      matrix: MatrixHealthResult;
      app: Awaited<ReturnType<PackageUpdateChecker["getStatus"]>>;
    };
    runtime: {
      metricsSnapshotAvailable: boolean;
      metricsUpdatedAtIso: string | null;
      requestTotal: number;
      activeExecutions: number;
      outcomes: RuntimeMetricsSnapshot["request"]["outcomes"] | null;
      limiter: RuntimeMetricsSnapshot["limiter"] | null;
      autodev: RuntimeMetricsSnapshot["autodev"] | null;
      upgradeStats: ReturnType<StateStore["getUpgradeRunStats"]>;
      latestUpgradeRun: {
        id: number;
        status: "running" | "succeeded" | "failed";
        targetVersion: string | null;
        installedVersion: string | null;
        error: string | null;
        startedAtIso: string;
        finishedAtIso: string | null;
      } | null;
    };
    config: {
      roomSettingsCount: number;
      runtimeHotConfigVersion: number | null;
      retentionPolicy: ReturnType<typeof formatHistoryRetentionPolicyEntry>;
      latestRevision: {
        id: number;
        actor: string | null;
        summary: string;
        createdAtIso: string;
      } | null;
    };
    warnings: string[];
  }> {
    const [codex, matrix, app] = await Promise.all([
      this.checkCodex(this.config.codexBin),
      this.checkMatrix(this.config.matrixHomeserver, this.config.doctorHttpTimeoutMs),
      this.packageUpdateChecker.getStatus(),
    ]);

    const metricsRecord = this.stateStore.getRuntimeMetricsSnapshot("orchestrator");
    const metricsSnapshot = metricsRecord ? parseRuntimeMetricsSnapshot(metricsRecord.payloadJson) : null;
    const runtimeHotSnapshot = this.stateStore.getRuntimeConfigSnapshot(GLOBAL_RUNTIME_HOT_CONFIG_KEY);
    const latestRevision = this.stateStore.listConfigRevisions(1)[0] ?? null;
    const latestUpgradeRun = this.stateStore.getLatestUpgradeRun();
    const warnings: string[] = [];

    if (!codex.ok) {
      warnings.push(`Codex health check failed: ${codex.error ?? "unknown error"}`);
    }
    if (!matrix.ok) {
      warnings.push(`Matrix health check failed: ${matrix.error ?? "unknown error"}`);
    }
    if (!metricsSnapshot) {
      warnings.push("Runtime metrics snapshot is unavailable.");
    }
    if (app.state === "unknown" && app.error && app.error.toLowerCase() !== "update check disabled") {
      warnings.push(`Package update checker warning: ${app.error}`);
    }

    return {
      ok: codex.ok && matrix.ok,
      timestamp: new Date().toISOString(),
      cliProvider: this.config.aiCliProvider,
      health: {
        codex,
        matrix,
        app,
      },
      runtime: {
        metricsSnapshotAvailable: Boolean(metricsSnapshot),
        metricsUpdatedAtIso: metricsRecord ? new Date(metricsRecord.updatedAt).toISOString() : null,
        requestTotal: metricsSnapshot?.request.total ?? 0,
        activeExecutions: metricsSnapshot?.activeExecutions ?? 0,
        outcomes: metricsSnapshot?.request.outcomes ?? null,
        limiter: metricsSnapshot?.limiter ?? null,
        autodev: metricsSnapshot?.autodev ?? null,
        upgradeStats: this.stateStore.getUpgradeRunStats(),
        latestUpgradeRun: latestUpgradeRun
          ? {
              id: latestUpgradeRun.id,
              status: latestUpgradeRun.status,
              targetVersion: latestUpgradeRun.targetVersion,
              installedVersion: latestUpgradeRun.installedVersion,
              error: latestUpgradeRun.error,
              startedAtIso: new Date(latestUpgradeRun.startedAt).toISOString(),
              finishedAtIso: latestUpgradeRun.finishedAt ? new Date(latestUpgradeRun.finishedAt).toISOString() : null,
            }
          : null,
      },
      config: {
        roomSettingsCount: this.configService.listRoomSettings().length,
        runtimeHotConfigVersion: runtimeHotSnapshot?.version ?? null,
        retentionPolicy: formatHistoryRetentionPolicyEntry(this.historyService.getRetentionPolicy()),
        latestRevision: latestRevision
          ? {
              id: latestRevision.id,
              actor: latestRevision.actor,
              summary: latestRevision.summary,
              createdAtIso: new Date(latestRevision.createdAt).toISOString(),
            }
          : null,
      },
      warnings,
    };
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

  private appendOperationAuditLog(input: {
    actor: string | null;
    source: string;
    surface: "admin";
    action: string;
    resource: string;
    method: string;
    path: string;
    outcome: OperationAuditOutcome;
    reason?: string | null;
    requiredScopes: readonly string[];
    grantedScopes: readonly string[];
    metadata?: Record<string, unknown>;
  }): void {
    this.stateStore.appendOperationAuditLog({
      actor: input.actor,
      source: input.source,
      surface: input.surface,
      action: input.action,
      resource: input.resource,
      method: input.method,
      path: input.path,
      outcome: input.outcome,
      reason: input.reason ?? null,
      requiredScopes: input.requiredScopes,
      grantedScopes: input.grantedScopes,
      metadata: input.metadata ?? null,
    });
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
  outputLanguage: OutputLanguage;
  codexWorkdir: string;
  rateLimiter: AppConfig["rateLimiter"];
  groupDirectModeEnabled: boolean;
  defaultGroupTriggerPolicy: AppConfig["defaultGroupTriggerPolicy"];
  matrixProgressUpdates: boolean;
  matrixProgressMinIntervalMs: number;
  matrixProgressDeliveryMode: "upsert" | "timeline";
  matrixTypingTimeoutMs: number;
  matrixNoticeBadgeEnabled: boolean;
  sessionActiveWindowMinutes: number;
  updateCheck: AppConfig["updateCheck"];
  cliCompat: AppConfig["cliCompat"];
  autoDev: {
    loopMaxRuns: number;
    loopMaxMinutes: number;
    autoCommit: boolean;
    gitAuthorName: string;
    gitAuthorEmail: string;
    autoReleaseEnabled: boolean;
    autoReleasePush: boolean;
    maxConsecutiveFailures: number;
    runArchiveEnabled: boolean;
    runArchiveDir: string;
    validationStrict: boolean;
    stageOutputEchoEnabled: boolean;
    initEnhancementEnabled: boolean;
    initEnhancementTimeoutMs: number;
    initEnhancementMaxChars: number;
  };
  agentWorkflow: AppConfig["agentWorkflow"];
} {
  const agentWorkflow = ensureAgentWorkflowConfig(config);
  const roleSkills = ensureAgentWorkflowRoleSkillsConfig(agentWorkflow);
  return {
    matrixCommandPrefix: config.matrixCommandPrefix,
    outputLanguage: config.outputLanguage,
    codexWorkdir: config.codexWorkdir,
    rateLimiter: { ...config.rateLimiter },
    groupDirectModeEnabled: config.groupDirectModeEnabled,
    defaultGroupTriggerPolicy: { ...config.defaultGroupTriggerPolicy },
    matrixProgressUpdates: config.matrixProgressUpdates,
    matrixProgressMinIntervalMs: config.matrixProgressMinIntervalMs,
    matrixProgressDeliveryMode: config.matrixProgressDeliveryMode,
    matrixTypingTimeoutMs: config.matrixTypingTimeoutMs,
    matrixNoticeBadgeEnabled: config.matrixNoticeBadgeEnabled,
    sessionActiveWindowMinutes: config.sessionActiveWindowMinutes,
    updateCheck: { ...config.updateCheck },
    cliCompat: { ...config.cliCompat },
    autoDev: {
      loopMaxRuns: normalizePositiveInt(process.env.AUTODEV_LOOP_MAX_RUNS, 20, 0, Number.MAX_SAFE_INTEGER),
      loopMaxMinutes: normalizePositiveInt(process.env.AUTODEV_LOOP_MAX_MINUTES, 120, 0, Number.MAX_SAFE_INTEGER),
      autoCommit: normalizeBooleanEnv(process.env.AUTODEV_AUTO_COMMIT, true, "AUTODEV_AUTO_COMMIT"),
      gitAuthorName: process.env.AUTODEV_GIT_AUTHOR_NAME?.trim() || "CodeHarbor AutoDev",
      gitAuthorEmail: process.env.AUTODEV_GIT_AUTHOR_EMAIL?.trim() || "autodev@codeharbor.local",
      autoReleaseEnabled: normalizeBooleanEnv(
        process.env.AUTODEV_AUTO_RELEASE_ENABLED,
        true,
        "AUTODEV_AUTO_RELEASE_ENABLED",
      ),
      autoReleasePush: normalizeBooleanEnv(process.env.AUTODEV_AUTO_RELEASE_PUSH, false, "AUTODEV_AUTO_RELEASE_PUSH"),
      runArchiveEnabled: normalizeBooleanEnv(
        process.env.AUTODEV_RUN_ARCHIVE_ENABLED,
        true,
        "AUTODEV_RUN_ARCHIVE_ENABLED",
      ),
      runArchiveDir: process.env.AUTODEV_RUN_ARCHIVE_DIR?.trim() || ".codeharbor/autodev-runs",
      validationStrict: normalizeBooleanEnv(process.env.AUTODEV_VALIDATION_STRICT, false, "AUTODEV_VALIDATION_STRICT"),
      stageOutputEchoEnabled: normalizeBooleanEnv(
        process.env.AUTODEV_STAGE_OUTPUT_ECHO_ENABLED,
        true,
        "AUTODEV_STAGE_OUTPUT_ECHO_ENABLED",
      ),
      maxConsecutiveFailures: normalizePositiveInt(
        process.env.AUTODEV_MAX_CONSECUTIVE_FAILURES,
        3,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      initEnhancementEnabled: normalizeBooleanEnv(
        process.env.AUTODEV_INIT_ENHANCEMENT_ENABLED,
        true,
        "AUTODEV_INIT_ENHANCEMENT_ENABLED",
      ),
      initEnhancementTimeoutMs: normalizePositiveInt(
        process.env.AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS,
        480_000,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      initEnhancementMaxChars: normalizePositiveInt(
        process.env.AUTODEV_INIT_ENHANCEMENT_MAX_CHARS,
        4_000,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
    },
    agentWorkflow: {
      enabled: agentWorkflow.enabled,
      autoRepairMaxRounds: agentWorkflow.autoRepairMaxRounds,
      roleSkills: {
        enabled: roleSkills.enabled,
        mode: roleSkills.mode,
        maxChars: roleSkills.maxChars,
        roots: [...roleSkills.roots],
        roleAssignments: normalizeRoleSkillAssignments(roleSkills.roleAssignments, undefined),
      },
    },
  };
}

function ensureAgentWorkflowConfig(config: AppConfig): AppConfig["agentWorkflow"] {
  const mutable = config as AppConfig & { agentWorkflow?: AppConfig["agentWorkflow"] };
  const existing = mutable.agentWorkflow;
  if (existing && typeof existing.enabled === "boolean" && Number.isFinite(existing.autoRepairMaxRounds)) {
    ensureAgentWorkflowRoleSkillsConfig(existing);
    return existing;
  }

  const fallback: AppConfig["agentWorkflow"] = {
    enabled: false,
    autoRepairMaxRounds: 1,
    roleSkills: {
      enabled: true,
      mode: "progressive",
      maxChars: null,
      roots: [],
      roleAssignments: undefined,
    },
  };
  mutable.agentWorkflow = fallback;
  return fallback;
}

function ensureAgentWorkflowRoleSkillsConfig(agentWorkflow: AppConfig["agentWorkflow"]): AppConfig["agentWorkflow"]["roleSkills"] {
  const existing = agentWorkflow.roleSkills;
  if (
    existing &&
    typeof existing.enabled === "boolean" &&
    (existing.mode === "summary" || existing.mode === "progressive" || existing.mode === "full")
  ) {
    let normalizedMaxChars: number | null = null;
    if (existing.maxChars !== null && existing.maxChars !== undefined) {
      const parsed = Number.parseInt(String(existing.maxChars), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        normalizedMaxChars = parsed;
      }
    }
    const normalizedRoots = normalizeRoleSkillRoots(existing.roots, []);
    const normalizedRoleAssignments = normalizeRoleSkillAssignments(existing.roleAssignments, undefined);
    existing.maxChars = normalizedMaxChars;
    existing.roots = normalizedRoots;
    existing.roleAssignments = normalizedRoleAssignments;
    return existing;
  }

  const fallback: AppConfig["agentWorkflow"]["roleSkills"] = {
    enabled: true,
    mode: "progressive",
    maxChars: null,
    roots: [],
    roleAssignments: undefined,
  };
  agentWorkflow.roleSkills = fallback;
  return fallback;
}

function formatConfigAuditEntry(entry: ConfigRevisionRecord): {
  kind: "config";
  id: number;
  actor: string | null;
  summary: string;
  payloadJson: string;
  payload: unknown;
  createdAt: number;
  createdAtIso: string;
} {
  return {
    kind: "config",
    id: entry.id,
    actor: entry.actor,
    summary: entry.summary,
    payloadJson: entry.payloadJson,
    payload: parseJsonLoose(entry.payloadJson),
    createdAt: entry.createdAt,
    createdAtIso: new Date(entry.createdAt).toISOString(),
  };
}

function formatOperationAuditEntry(entry: OperationAuditRecord): {
  kind: "operation";
  id: number;
  actor: string | null;
  source: string | null;
  summary: string;
  action: string;
  resource: string;
  method: string;
  path: string;
  outcome: OperationAuditOutcome;
  reason: string | null;
  requiredScopes: string[];
  grantedScopes: string[];
  metadataJson: string | null;
  metadata: unknown;
  createdAt: number;
  createdAtIso: string;
} {
  const summaryParts = [entry.surface.toUpperCase(), entry.method, entry.path, entry.outcome.toUpperCase()];
  return {
    kind: "operation",
    id: entry.id,
    actor: entry.actor,
    source: entry.source,
    summary: summaryParts.join(" "),
    action: entry.action,
    resource: entry.resource,
    method: entry.method,
    path: entry.path,
    outcome: entry.outcome,
    reason: entry.reason,
    requiredScopes: entry.requiredScopes,
    grantedScopes: entry.grantedScopes,
    metadataJson: entry.metadataJson,
    metadata: parseJsonLoose(entry.metadataJson),
    createdAt: entry.createdAt,
    createdAtIso: new Date(entry.createdAt).toISOString(),
  };
}

function formatSessionHistoryEntry(entry: SessionHistoryRecord): {
  sessionKey: string;
  channel: string | null;
  roomId: string | null;
  userId: string | null;
  codexSessionId: string | null;
  activeUntil: number | null;
  activeUntilIso: string | null;
  updatedAt: number;
  updatedAtIso: string;
  messageCount: number;
  lastMessageAt: number | null;
  lastMessageAtIso: string | null;
} {
  return {
    sessionKey: entry.sessionKey,
    channel: entry.channel,
    roomId: entry.roomId,
    userId: entry.userId,
    codexSessionId: entry.codexSessionId,
    activeUntil: entry.activeUntil,
    activeUntilIso: entry.activeUntil === null ? null : new Date(entry.activeUntil).toISOString(),
    updatedAt: entry.updatedAt,
    updatedAtIso: new Date(entry.updatedAt).toISOString(),
    messageCount: entry.messageCount,
    lastMessageAt: entry.lastMessageAt,
    lastMessageAtIso: entry.lastMessageAt === null ? null : new Date(entry.lastMessageAt).toISOString(),
  };
}

function formatSessionMessageEntry(entry: SessionMessageRecord): {
  id: number;
  sessionKey: string;
  role: "user" | "assistant";
  provider: "codex" | "claude";
  content: string;
  createdAt: number;
  createdAtIso: string;
} {
  return {
    id: entry.id,
    sessionKey: entry.sessionKey,
    role: entry.role,
    provider: entry.provider,
    content: entry.content,
    createdAt: entry.createdAt,
    createdAtIso: new Date(entry.createdAt).toISOString(),
  };
}

function formatSessionExportEntry(entry: SessionHistoryRecord & { messages?: SessionMessageRecord[] }): {
  sessionKey: string;
  channel: string | null;
  roomId: string | null;
  userId: string | null;
  codexSessionId: string | null;
  activeUntil: number | null;
  activeUntilIso: string | null;
  updatedAt: number;
  updatedAtIso: string;
  messageCount: number;
  lastMessageAt: number | null;
  lastMessageAtIso: string | null;
  messages?: Array<{
    id: number;
    sessionKey: string;
    role: "user" | "assistant";
    provider: "codex" | "claude";
    content: string;
    createdAt: number;
    createdAtIso: string;
  }>;
} {
  const base = formatSessionHistoryEntry(entry);
  if (!entry.messages) {
    return base;
  }
  return {
    ...base,
    messages: entry.messages.map((message) => formatSessionMessageEntry(message)),
  };
}

function formatHistoryRetentionPolicyEntry(entry: HistoryRetentionPolicyRecord): {
  enabled: boolean;
  retentionDays: number;
  cleanupIntervalMinutes: number;
  maxDeleteSessions: number;
  updatedAt: number;
  updatedAtIso: string | null;
} {
  return {
    enabled: entry.enabled,
    retentionDays: entry.retentionDays,
    cleanupIntervalMinutes: entry.cleanupIntervalMinutes,
    maxDeleteSessions: entry.maxDeleteSessions,
    updatedAt: entry.updatedAt,
    updatedAtIso: entry.updatedAt > 0 ? new Date(entry.updatedAt).toISOString() : null,
  };
}

function formatHistoryCleanupRunEntry(entry: HistoryCleanupRunRecord): {
  id: number;
  trigger: "manual" | "scheduled";
  requestedBy: string | null;
  dryRun: boolean;
  status: "succeeded" | "failed" | "skipped";
  retentionDays: number;
  maxDeleteSessions: number;
  cutoffTs: number;
  cutoffTsIso: string;
  scannedSessions: number;
  scannedMessages: number;
  deletedSessions: number;
  deletedMessages: number;
  hasMore: boolean;
  sampledSessionKeys: string[];
  skippedReason: string | null;
  error: string | null;
  startedAt: number;
  startedAtIso: string;
  finishedAt: number;
  finishedAtIso: string;
} {
  return {
    id: entry.id,
    trigger: entry.trigger,
    requestedBy: entry.requestedBy,
    dryRun: entry.dryRun,
    status: entry.status,
    retentionDays: entry.retentionDays,
    maxDeleteSessions: entry.maxDeleteSessions,
    cutoffTs: entry.cutoffTs,
    cutoffTsIso: new Date(entry.cutoffTs).toISOString(),
    scannedSessions: entry.scannedSessions,
    scannedMessages: entry.scannedMessages,
    deletedSessions: entry.deletedSessions,
    deletedMessages: entry.deletedMessages,
    hasMore: entry.hasMore,
    sampledSessionKeys: [...entry.sampledSessionKeys],
    skippedReason: entry.skippedReason,
    error: entry.error,
    startedAt: entry.startedAt,
    startedAtIso: new Date(entry.startedAt).toISOString(),
    finishedAt: entry.finishedAt,
    finishedAtIso: new Date(entry.finishedAt).toISOString(),
  };
}

function parseJsonLoose(raw: string | null): unknown {
  if (raw === null || raw === "") {
    return raw;
  }
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
    restartAdmin: false,
    output,
  });
  if (restartAdmin) {
    queueAdminSystemdRestart({
      output,
    });
  }

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
    pathname === "/diagnostics" ||
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

function normalizeBooleanEnv(value: unknown, fallback: boolean, fieldName: string): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  throw new HttpError(400, `${fieldName} must be a boolean string.`);
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

function normalizeOutputLanguage(value: unknown, fallback: OutputLanguage): OutputLanguage {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, 'outputLanguage must be "zh" or "en".');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "zh" || normalized === "en") {
    return normalized;
  }
  throw new HttpError(400, 'outputLanguage must be "zh" or "en".');
}

function normalizeProgressDeliveryMode(value: unknown, fallback: "upsert" | "timeline"): "upsert" | "timeline" {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, 'matrixProgressDeliveryMode must be "upsert" or "timeline".');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "upsert" || normalized === "timeline") {
    return normalized;
  }
  throw new HttpError(400, 'matrixProgressDeliveryMode must be "upsert" or "timeline".');
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

function normalizeBooleanQuery(value: string | null, fallback: boolean): boolean {
  if (value === null) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  throw new HttpError(400, "Expected boolean query value.");
}

function normalizeAuditKind(value: string | null): "config" | "operations" | "all" {
  if (!value) {
    return "config";
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "config" || normalized === "revision" || normalized === "revisions") {
    return "config";
  }
  if (normalized === "operations" || normalized === "operation" || normalized === "ops") {
    return "operations";
  }
  if (normalized === "all") {
    return "all";
  }
  throw new HttpError(400, 'kind must be one of "config", "operations", or "all".');
}

function normalizeOptionalAuditSurface(value: string | null): "admin" | "api" | "webhook" | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "admin" || normalized === "api" || normalized === "webhook") {
    return normalized;
  }
  throw new HttpError(400, 'surface must be one of "admin", "api", or "webhook".');
}

function normalizeOptionalAuditOutcome(value: string | null): OperationAuditOutcome | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "allowed" || normalized === "denied" || normalized === "error") {
    return normalized;
  }
  throw new HttpError(400, 'outcome must be one of "allowed", "denied", or "error".');
}

function normalizeOptionalAuditFilterValue(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeOptionalAuditMethod(value: string | null): string | undefined {
  const normalized = normalizeOptionalAuditFilterValue(value);
  if (!normalized) {
    return undefined;
  }
  const upper = normalized.toUpperCase();
  if (!/^[A-Z]+$/.test(upper)) {
    throw new HttpError(400, "method must be a valid HTTP method token.");
  }
  return upper;
}

function shouldLogSuccessfulAuthEvent(pathname: string, _method: string): boolean {
  if (pathname === "/metrics" || pathname === "/api/admin/auth/status") {
    return false;
  }
  return true;
}

function decodePathParam(value: string, fieldName: string): string {
  try {
    const decoded = decodeURIComponent(value).trim();
    if (!decoded) {
      throw new HttpError(400, `${fieldName} is required.`);
    }
    return decoded;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, `Invalid URI encoding for ${fieldName}.`);
  }
}

function parseOptionalTimestampQuery(value: string | null, fieldName: string): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      throw new HttpError(400, `${fieldName} must be a valid unix timestamp in milliseconds.`);
    }
    return Math.max(0, parsed);
  }

  const parsedIso = Date.parse(trimmed);
  if (!Number.isFinite(parsedIso)) {
    throw new HttpError(400, `${fieldName} must be an ISO timestamp or unix milliseconds.`);
  }
  return parsedIso;
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

function normalizeOptionalPositiveInt(value: unknown, fallback: number | null): number | null {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string" && !value.trim()) {
    return null;
  }
  return normalizePositiveInt(value, fallback ?? 1, 1, Number.MAX_SAFE_INTEGER);
}

function normalizeMimeTypeCsv(value: unknown, fallback: string[]): string[] {
  if (value === undefined) {
    return [...fallback];
  }
  const source: string[] = [];
  if (typeof value === "string") {
    source.push(...value.split(","));
  } else if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "string") {
        throw new HttpError(400, `cliCompat.imageAllowedMimeTypes[${index}] must be a string.`);
      }
      source.push(entry);
    }
  } else {
    throw new HttpError(400, "cliCompat.imageAllowedMimeTypes must be a CSV string or string array.");
  }

  const normalized = source
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .filter((entry) => /^[-\w.+]+\/[-\w.+]+$/.test(entry));

  if (normalized.length === 0) {
    throw new HttpError(400, "cliCompat.imageAllowedMimeTypes must contain at least one valid MIME type.");
  }
  return [...new Set(normalized)];
}

function normalizeRoleSkillDisclosureMode(
  value: unknown,
  fallback: "summary" | "progressive" | "full",
): "summary" | "progressive" | "full" {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "agentWorkflow.roleSkills.mode must be a string.");
  }
  const normalized = value.trim().toLowerCase();
  if (!ROLE_SKILL_DISCLOSURE_MODES.has(normalized)) {
    throw new HttpError(400, 'agentWorkflow.roleSkills.mode must be one of "summary", "progressive", "full".');
  }
  return normalized as "summary" | "progressive" | "full";
}

function normalizeRoleSkillRoots(value: unknown, fallback: string[]): string[] {
  if (value === undefined) {
    return [...fallback];
  }
  const items: string[] = [];
  if (typeof value === "string") {
    items.push(...value.split(","));
  } else if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "string") {
        throw new HttpError(400, `agentWorkflow.roleSkills.roots[${index}] must be a string.`);
      }
      items.push(entry);
    }
  } else {
    throw new HttpError(400, "agentWorkflow.roleSkills.roots must be a CSV string or string array.");
  }
  return dedupeNormalizedStrings(items);
}

function normalizeRoleSkillAssignments(
  value: unknown,
  fallback: Partial<Record<(typeof ROLE_SKILL_ROLES)[number], string[]>> | undefined,
): Partial<Record<(typeof ROLE_SKILL_ROLES)[number], string[]>> | undefined {
  if (value === undefined) {
    if (!fallback) {
      return undefined;
    }
    const copied: Partial<Record<(typeof ROLE_SKILL_ROLES)[number], string[]>> = {};
    if (Array.isArray(fallback.planner)) {
      copied.planner = [...fallback.planner];
    }
    if (Array.isArray(fallback.executor)) {
      copied.executor = [...fallback.executor];
    }
    if (Array.isArray(fallback.reviewer)) {
      copied.reviewer = [...fallback.reviewer];
    }
    return Object.keys(copied).length > 0 ? copied : undefined;
  }
  if (value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new HttpError(400, "agentWorkflow.roleSkills.roleAssignments must be valid JSON.");
    }
    return normalizeRoleSkillAssignmentsObject(parsed);
  }
  return normalizeRoleSkillAssignmentsObject(value);
}

function normalizeRoleSkillAssignmentsObject(
  value: unknown,
): Partial<Record<(typeof ROLE_SKILL_ROLES)[number], string[]>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "agentWorkflow.roleSkills.roleAssignments must be an object.");
  }
  const payload = value as Record<string, unknown>;
  const output: Partial<Record<(typeof ROLE_SKILL_ROLES)[number], string[]>> = {};
  for (const role of ROLE_SKILL_ROLES) {
    const list = payload[role];
    if (list === undefined) {
      continue;
    }
    if (!Array.isArray(list)) {
      throw new HttpError(400, `agentWorkflow.roleSkills.roleAssignments.${role} must be a string array.`);
    }
    const normalized: string[] = [];
    for (const [index, entry] of list.entries()) {
      if (typeof entry !== "string") {
        throw new HttpError(
          400,
          `agentWorkflow.roleSkills.roleAssignments.${role}[${index}] must be a string.`,
        );
      }
      normalized.push(entry);
    }
    output[role] = dedupeNormalizedStrings(normalized);
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function serializeRoleSkillAssignments(
  value: Partial<Record<(typeof ROLE_SKILL_ROLES)[number], string[]>> | undefined,
): string {
  if (!value) {
    return "";
  }
  const normalized = normalizeRoleSkillAssignmentsObject(value);
  if (!normalized) {
    return "";
  }
  return JSON.stringify(normalized);
}

function dedupeNormalizedStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
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

function normalizeEnvOverrides(value: unknown): Record<string, string> {
  const payload = asObject(value, "envOverrides");
  const output: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(payload)) {
    const key = rawKey.trim();
    if (!key) {
      throw new HttpError(400, "envOverrides key cannot be empty.");
    }
    if (!/^[A-Z0-9_]+$/.test(key)) {
      throw new HttpError(400, `envOverrides.${key} must use uppercase ENV key format.`);
    }
    if (!ALLOWED_ENV_OVERRIDE_KEYS.has(key)) {
      throw new HttpError(400, `envOverrides.${key} is not a supported configuration key.`);
    }
    if (rawValue === null || rawValue === undefined) {
      const normalized = "";
      validateEnvOverrideValue(key, normalized);
      output[key] = normalized;
      continue;
    }
    if (typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean") {
      const normalized = String(rawValue);
      validateEnvOverrideValue(key, normalized);
      output[key] = normalized;
      continue;
    }
    if (Array.isArray(rawValue) || typeof rawValue === "object") {
      const normalized = JSON.stringify(rawValue);
      validateEnvOverrideValue(key, normalized);
      output[key] = normalized;
      continue;
    }
    throw new HttpError(400, `envOverrides.${key} has unsupported value type.`);
  }
  return output;
}

function validateEnvOverrideValue(key: string, value: string): void {
  const trimmed = value.trim();
  if (BOOLEAN_ENV_OVERRIDE_KEYS.has(key)) {
    if (!trimmed) {
      throw new HttpError(400, `envOverrides.${key} cannot be empty.`);
    }
    const normalized = trimmed.toLowerCase();
    if (
      normalized !== "true" &&
      normalized !== "false" &&
      normalized !== "1" &&
      normalized !== "0" &&
      normalized !== "yes" &&
      normalized !== "no" &&
      normalized !== "on" &&
      normalized !== "off"
    ) {
      throw new HttpError(400, `envOverrides.${key} must be a boolean value.`);
    }
    return;
  }

  if (OPTIONAL_POSITIVE_INT_ENV_OVERRIDE_KEYS.has(key)) {
    if (!trimmed) {
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new HttpError(400, `envOverrides.${key} must be empty or a positive integer.`);
    }
    return;
  }

  if (POSITIVE_INT_ENV_OVERRIDE_KEYS.has(key)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new HttpError(400, `envOverrides.${key} must be a positive integer.`);
    }
    return;
  }

  if (LAUNCHD_LABEL_ENV_OVERRIDE_KEYS.has(key)) {
    if (!trimmed) {
      return;
    }
    if (!SAFE_LAUNCHD_LABEL_PATTERN.test(trimmed)) {
      throw new HttpError(400, `envOverrides.${key} must be a safe launchd label.`);
    }
  }
}

function resolveNextConfigFromEnvUpdates(
  config: AppConfig,
  stateStore: StateStore,
  envUpdates: Record<string, string>,
): AppConfig {
  const snapshotEnv = buildConfigSnapshot(config, stateStore.listRoomSettings()).env;
  const mergedEnv: NodeJS.ProcessEnv = { ...snapshotEnv };
  for (const [key, value] of Object.entries(envUpdates)) {
    mergedEnv[key] = value;
  }
  const preserveEphemeralAdminPort = config.adminPort === 0 && !Object.prototype.hasOwnProperty.call(envUpdates, "ADMIN_PORT");
  if (preserveEphemeralAdminPort) {
    mergedEnv.ADMIN_PORT = "8787";
  }
  try {
    const nextConfig = loadConfig(mergedEnv);
    if (preserveEphemeralAdminPort) {
      nextConfig.adminPort = 0;
    }
    return nextConfig;
  } catch (error) {
    throw new HttpError(400, formatError(error));
  }
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
    const scopes =
      token.scopes && token.scopes.length > 0 ? normalizeTokenScopes(token.scopes) : scopesForAdminRole(token.role);
    mapped.set(token.token, {
      role: token.role,
      actor: token.actor,
      scopes,
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
