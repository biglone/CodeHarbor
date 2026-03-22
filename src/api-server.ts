import http from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  API_TOKEN_SCOPES,
  hasRequiredScopes,
  listMissingScopes,
  normalizeTokenScopes,
  resolveApiScopeRequirement,
  resolveWebhookScopeRequirement,
  WEBHOOK_SIGNATURE_SCOPES,
  type TokenScopePattern,
} from "./auth/scope-matrix";
import { Logger } from "./logger";
import {
  type ApiTaskExternalContext,
  ApiTaskIdempotencyConflictError,
  type ApiTaskQueryResult,
  type ApiTaskSubmitInput,
  type ApiTaskSubmitResult,
} from "./orchestrator";

const API_MAX_JSON_BODY_BYTES = 1_048_576;
const IDEMPOTENCY_KEY_MAX_CHARS = 256;
const DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

type WebhookSource = "ci" | "ticket";

interface WebhookTimestamp {
  raw: string;
  unixSeconds: number;
}

interface WebhookMapResult {
  taskInput: Omit<ApiTaskSubmitInput, "idempotencyKey">;
  idempotencyHint: string | null;
}

const WEBHOOK_DEFAULT_SENDER_BY_SOURCE: Record<WebhookSource, string> = {
  ci: "@ci:webhook.codeharbor",
  ticket: "@ticket:webhook.codeharbor",
};

interface ApiServerOptions {
  host: string;
  port: number;
  apiToken: string;
  apiTokenScopes?: readonly string[];
  webhookSecret?: string | null;
  webhookTimestampToleranceSeconds?: number;
  auditRecorder?: (event: ApiOperationAuditEvent) => void;
}

interface AddressInfo {
  host: string;
  port: number;
}

interface ApiAuthIdentity {
  actor: string | null;
  source: "legacy" | "webhook-signature";
  scopes: TokenScopePattern[];
}

export interface ApiOperationAuditEvent {
  actor: string | null;
  source: string;
  surface: "api" | "webhook";
  action: string;
  resource: string;
  method: string;
  path: string;
  outcome: "allowed" | "denied" | "error";
  reason?: string | null;
  requiredScopes: readonly string[];
  grantedScopes: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface TaskSubmissionService {
  submitApiTask(input: ApiTaskSubmitInput): ApiTaskSubmitResult;
  getApiTaskById(taskId: number): ApiTaskQueryResult | null;
}

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class ApiServer {
  private readonly logger: Logger;
  private readonly taskService: TaskSubmissionService;
  private readonly host: string;
  private readonly port: number;
  private readonly apiToken: string;
  private readonly apiTokenScopes: TokenScopePattern[];
  private readonly webhookSecret: string | null;
  private readonly webhookTimestampToleranceSeconds: number;
  private readonly auditRecorder: ((event: ApiOperationAuditEvent) => void) | null;
  private server: http.Server | null = null;
  private address: AddressInfo | null = null;

  constructor(logger: Logger, taskService: TaskSubmissionService, options: ApiServerOptions) {
    this.logger = logger;
    this.taskService = taskService;
    this.host = options.host;
    this.port = options.port;
    this.apiToken = options.apiToken;
    this.apiTokenScopes =
      options.apiTokenScopes && options.apiTokenScopes.length > 0
        ? normalizeTokenScopes(options.apiTokenScopes)
        : [...API_TOKEN_SCOPES];
    this.webhookSecret = options.webhookSecret?.trim() || null;
    this.webhookTimestampToleranceSeconds = Math.max(
      0,
      options.webhookTimestampToleranceSeconds ?? DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    );
    this.auditRecorder = options.auditRecorder ?? null;
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
        reject(new Error("api server is not initialized"));
        return;
      }
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server?.removeListener("error", reject);
        const address = this.server?.address();
        if (!address || typeof address === "string") {
          reject(new Error("failed to resolve api server address"));
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
    let auditBase: Omit<ApiOperationAuditEvent, "outcome" | "reason"> | null = null;
    let auditWritten = false;
    const requestId = normalizeHeaderValue(req.headers["x-request-id"]);

    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const requestMethod = (req.method ?? "GET").toUpperCase();
      const taskDetailMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      const isTaskSubmitRoute = url.pathname === "/api/tasks";
      const webhookMatch = /^\/api\/webhooks\/([^/]+)$/.exec(url.pathname);
      const mergeAuditMetadata = (metadata: Record<string, unknown>): Record<string, unknown> => ({
        ...(requestId ? { requestId } : {}),
        ...metadata,
      });
      this.setSecurityHeaders(res);
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Idempotency-Key, X-CodeHarbor-Signature, X-CodeHarbor-Timestamp, X-CodeHarbor-Event-Id",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

      if (!isTaskSubmitRoute && !taskDetailMatch && !webhookMatch) {
        this.sendJson(res, 404, {
          ok: false,
          error: `Not found: ${requestMethod} ${url.pathname}`,
        });
        return;
      }

      if (requestMethod === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (webhookMatch) {
        await this.handleWebhookRequest(req, res, webhookMatch[1]);
        return;
      }

      const scopeRequirement = resolveApiScopeRequirement(url.pathname);
      const authIdentity = scopeRequirement ? this.resolveApiIdentity(req) : null;
      if (scopeRequirement) {
        auditBase = {
          actor: authIdentity?.actor ?? null,
          source: authIdentity?.source ?? "none",
          surface: "api",
          action: scopeRequirement.action,
          resource: url.pathname,
          method: requestMethod,
          path: url.pathname,
          requiredScopes: scopeRequirement.requiredScopes,
          grantedScopes: authIdentity?.scopes ?? [],
        };
      }

      if (scopeRequirement && !authIdentity) {
        if (auditBase) {
          this.appendAuditEvent({
            ...auditBase,
            outcome: "denied",
            reason: "unauthorized",
            grantedScopes: [],
            metadata: mergeAuditMetadata({ statusCode: 401 }),
          });
          auditWritten = true;
        }
        this.sendJson(res, 401, {
          ok: false,
          error: "Unauthorized. Provide Authorization: Bearer <API_TOKEN>.",
        });
        return;
      }
      if (scopeRequirement && authIdentity && !hasRequiredScopes(authIdentity.scopes, scopeRequirement.requiredScopes)) {
        const missingScopes = listMissingScopes(authIdentity.scopes, scopeRequirement.requiredScopes);
        if (auditBase) {
          this.appendAuditEvent({
            ...auditBase,
            actor: authIdentity.actor,
            source: authIdentity.source,
            grantedScopes: authIdentity.scopes,
            outcome: "denied",
            reason: `missing_scope:${missingScopes.join(",")}`,
            metadata: mergeAuditMetadata({
              statusCode: 403,
              missingScopes,
            }),
          });
          auditWritten = true;
        }
        this.sendJson(res, 403, {
          ok: false,
          error: `Forbidden. Missing required scope: ${missingScopes.join(", ")}.`,
        });
        return;
      }

      if (isTaskSubmitRoute) {
        if (requestMethod !== "POST") {
          res.setHeader("Allow", "POST, OPTIONS");
          this.sendJson(res, 405, {
            ok: false,
            error: `Method not allowed: ${requestMethod}.`,
          });
          if (auditBase) {
            this.appendAuditEvent({
              ...auditBase,
              outcome: "denied",
              reason: "method_not_allowed",
              metadata: mergeAuditMetadata({ statusCode: 405 }),
            });
            auditWritten = true;
          }
          return;
        }

        const idempotencyKey = readIdempotencyKey(req);
        const body = await readJsonBody(req, API_MAX_JSON_BODY_BYTES);
        const payload = parseTaskSubmitBody(body);
        const result = this.taskService.submitApiTask({
          ...payload,
          idempotencyKey,
        });
        this.sendJson(res, result.created ? 202 : 200, {
          ok: true,
          data: formatTaskSubmitResponse(result),
        });
        if (auditBase) {
          this.appendAuditEvent({
            ...auditBase,
            actor: authIdentity?.actor ?? null,
            source: authIdentity?.source ?? "none",
            grantedScopes: authIdentity?.scopes ?? [],
            outcome: "allowed",
            metadata: mergeAuditMetadata({
              statusCode: result.created ? 202 : 200,
              created: result.created,
              taskId: result.task.id,
            }),
          });
          auditWritten = true;
        }
        return;
      }

      if (requestMethod !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        this.sendJson(res, 405, {
          ok: false,
          error: `Method not allowed: ${requestMethod}.`,
        });
        if (auditBase) {
          this.appendAuditEvent({
            ...auditBase,
            outcome: "denied",
            reason: "method_not_allowed",
            metadata: mergeAuditMetadata({ statusCode: 405 }),
          });
          auditWritten = true;
        }
        return;
      }

      const taskId = parseTaskId(taskDetailMatch?.[1]);
      const result = this.taskService.getApiTaskById(taskId);
      if (!result) {
        this.sendJson(res, 404, {
          ok: false,
          error: `Task not found: ${taskId}.`,
        });
        if (auditBase) {
          this.appendAuditEvent({
            ...auditBase,
            outcome: "denied",
            reason: "not_found",
            metadata: mergeAuditMetadata({ statusCode: 404, taskId }),
          });
          auditWritten = true;
        }
        return;
      }
      this.sendJson(res, 200, {
        ok: true,
        data: formatTaskQueryResponse(result),
      });
      if (auditBase) {
        this.appendAuditEvent({
          ...auditBase,
          actor: authIdentity?.actor ?? null,
          source: authIdentity?.source ?? "none",
          grantedScopes: authIdentity?.scopes ?? [],
          outcome: "allowed",
          metadata: mergeAuditMetadata({
            statusCode: 200,
            taskId: result.taskId,
            taskStatus: result.status,
          }),
        });
        auditWritten = true;
      }
    } catch (error) {
      if (auditBase && !auditWritten) {
        const statusCode =
          error instanceof HttpError ? error.statusCode : error instanceof ApiTaskIdempotencyConflictError ? 409 : 500;
        const outcome = statusCode >= 500 ? "error" : "denied";
        this.appendAuditEvent({
          ...auditBase,
          outcome,
          reason: formatError(error),
          metadata: {
            ...(requestId ? { requestId } : {}),
            statusCode,
          },
        });
      }
      if (error instanceof HttpError) {
        this.sendJson(res, error.statusCode, {
          ok: false,
          error: error.message,
        });
        return;
      }
      if (error instanceof ApiTaskIdempotencyConflictError) {
        this.sendJson(res, 409, {
          ok: false,
          error: error.message,
          code: "IDEMPOTENCY_CONFLICT",
        });
        return;
      }

      this.logger.error("Task API request failed", error);
      this.sendJson(res, 500, {
        ok: false,
        error: formatError(error),
      });
    }
  }

  private async handleWebhookRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sourceParam: string | undefined,
  ): Promise<void> {
    const requestMethod = (req.method ?? "GET").toUpperCase();
    const requestPath = `/api/webhooks/${sourceParam ?? ""}`;
    const scopeRequirement = resolveWebhookScopeRequirement(requestPath);
    const requestId = normalizeHeaderValue(req.headers["x-request-id"]);
    const mergeAuditMetadata = (metadata: Record<string, unknown>): Record<string, unknown> => ({
      ...(requestId ? { requestId } : {}),
      ...metadata,
    });
    let deniedAuditWritten = false;

    if (requestMethod !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      this.sendJson(res, 405, {
        ok: false,
        error: `Method not allowed: ${requestMethod}.`,
      });
      if (scopeRequirement) {
        this.appendAuditEvent({
          actor: null,
          source: "none",
          surface: "webhook",
          action: scopeRequirement.action,
          resource: requestPath,
          method: requestMethod,
          path: requestPath,
          outcome: "denied",
          reason: "method_not_allowed",
          requiredScopes: scopeRequirement.requiredScopes,
          grantedScopes: [],
          metadata: mergeAuditMetadata({ statusCode: 405 }),
        });
      }
      return;
    }

    if (!this.webhookSecret) {
      if (scopeRequirement) {
        this.appendAuditEvent({
          actor: null,
          source: "none",
          surface: "webhook",
          action: scopeRequirement.action,
          resource: requestPath,
          method: requestMethod,
          path: requestPath,
          outcome: "error",
          reason: "webhook_unavailable",
          requiredScopes: scopeRequirement.requiredScopes,
          grantedScopes: [],
          metadata: mergeAuditMetadata({ statusCode: 503 }),
        });
      }
      throw new HttpError(503, "Webhook is unavailable because API_WEBHOOK_SECRET is not configured.");
    }

    if (!scopeRequirement) {
      throw new HttpError(404, "Webhook route permission is not configured.");
    }

    let source: WebhookSource;
    try {
      source = parseWebhookSource(sourceParam);
    } catch (error) {
      this.appendAuditEvent({
        actor: null,
        source: "none",
        surface: "webhook",
        action: scopeRequirement.action,
        resource: requestPath,
        method: requestMethod,
        path: requestPath,
        outcome: "denied",
        reason: formatError(error),
        requiredScopes: scopeRequirement.requiredScopes,
        grantedScopes: [],
        metadata: mergeAuditMetadata({ statusCode: 400 }),
      });
      throw error;
    }

    const webhookIdentity: ApiAuthIdentity = {
      actor: `webhook:${source}`,
      source: "webhook-signature",
      scopes: [...WEBHOOK_SIGNATURE_SCOPES],
    };

    try {
      const rawBody = await readBodyBuffer(req, API_MAX_JSON_BODY_BYTES);
      const timestamp = readWebhookTimestamp(req);
      verifyWebhookTimestamp(timestamp, this.webhookTimestampToleranceSeconds);
      const signature = readWebhookSignature(req);
      verifyWebhookSignature(rawBody, timestamp.raw, signature, this.webhookSecret);

      if (!hasRequiredScopes(webhookIdentity.scopes, scopeRequirement.requiredScopes)) {
        const missingScopes = listMissingScopes(webhookIdentity.scopes, scopeRequirement.requiredScopes);
        this.appendAuditEvent({
          actor: webhookIdentity.actor,
          source: webhookIdentity.source,
          surface: "webhook",
          action: scopeRequirement.action,
          resource: requestPath,
          method: requestMethod,
          path: requestPath,
          outcome: "denied",
          reason: `missing_scope:${missingScopes.join(",")}`,
          requiredScopes: scopeRequirement.requiredScopes,
          grantedScopes: webhookIdentity.scopes,
          metadata: mergeAuditMetadata({
            statusCode: 403,
            missingScopes,
          }),
        });
        deniedAuditWritten = true;
        throw new HttpError(403, `Webhook is missing required scope: ${missingScopes.join(", ")}.`);
      }

      const body = parseJsonBuffer(rawBody);
      const mapped = mapWebhookPayload(source, body);
      const idempotencyKey = buildWebhookIdempotencyKey(req, source, rawBody, mapped.idempotencyHint);
      const result = this.taskService.submitApiTask({
        ...mapped.taskInput,
        idempotencyKey,
      });

      this.sendJson(res, result.created ? 202 : 200, {
        ok: true,
        data: {
          source,
          ...formatTaskSubmitResponse(result),
        },
      });
      this.appendAuditEvent({
        actor: webhookIdentity.actor,
        source: webhookIdentity.source,
        surface: "webhook",
        action: scopeRequirement.action,
        resource: requestPath,
        method: requestMethod,
        path: requestPath,
        outcome: "allowed",
        requiredScopes: scopeRequirement.requiredScopes,
        grantedScopes: webhookIdentity.scopes,
        metadata: mergeAuditMetadata({
          statusCode: result.created ? 202 : 200,
          source,
          created: result.created,
          taskId: result.task.id,
        }),
      });
    } catch (error) {
      if (!deniedAuditWritten) {
        const statusCode =
          error instanceof HttpError ? error.statusCode : error instanceof ApiTaskIdempotencyConflictError ? 409 : 500;
        const outcome = statusCode >= 500 ? "error" : "denied";
        this.appendAuditEvent({
          actor: webhookIdentity.actor,
          source: webhookIdentity.source,
          surface: "webhook",
          action: scopeRequirement.action,
          resource: requestPath,
          method: requestMethod,
          path: requestPath,
          outcome,
          reason: formatError(error),
          requiredScopes: scopeRequirement.requiredScopes,
          grantedScopes: webhookIdentity.scopes,
          metadata: mergeAuditMetadata({ statusCode }),
        });
      }
      throw error;
    }
  }

  private resolveApiIdentity(req: http.IncomingMessage): ApiAuthIdentity | null {
    const token = readBearerToken(req);
    if (token === null || token !== this.apiToken) {
      return null;
    }
    return {
      actor: null,
      source: "legacy",
      scopes: [...this.apiTokenScopes],
    };
  }

  private appendAuditEvent(event: ApiOperationAuditEvent): void {
    if (!this.auditRecorder) {
      return;
    }
    try {
      this.auditRecorder(event);
    } catch (error) {
      this.logger.warn("API audit recorder failed", {
        error: formatError(error),
      });
    }
  }

  private setSecurityHeaders(res: http.ServerResponse): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  }
}

function formatTaskSubmitResponse(result: ApiTaskSubmitResult): {
  taskId: number;
  sessionKey: string;
  eventId: string;
  requestId: string;
  status: ApiTaskSubmitResult["task"]["status"];
  attempt: number;
  created: boolean;
  deduplicated: boolean;
} {
  return {
    taskId: result.task.id,
    sessionKey: result.sessionKey,
    eventId: result.eventId,
    requestId: result.requestId,
    status: result.task.status,
    attempt: result.task.attempt,
    created: result.created,
    deduplicated: !result.created,
  };
}

function formatTaskQueryResponse(result: ApiTaskQueryResult): {
  taskId: number;
  status: ApiTaskQueryResult["status"];
  stage: ApiTaskQueryResult["stage"];
  errorSummary: string | null;
} {
  return {
    taskId: result.taskId,
    status: result.status,
    stage: result.stage,
    errorSummary: result.errorSummary,
  };
}

function readIdempotencyKey(req: http.IncomingMessage): string {
  const raw = req.headers["idempotency-key"];
  const value = normalizeHeaderValue(raw);
  if (!value) {
    throw new HttpError(400, "Missing required header: Idempotency-Key.");
  }
  if (value.length > IDEMPOTENCY_KEY_MAX_CHARS) {
    throw new HttpError(400, `Idempotency-Key is too long. Max allowed chars: ${IDEMPOTENCY_KEY_MAX_CHARS}.`);
  }
  return value;
}

function parseTaskId(value: string | undefined): number {
  if (!value) {
    throw new HttpError(400, "taskId is required.");
  }
  const decoded = decodePathParam(value, "taskId");
  if (!/^\d+$/.test(decoded)) {
    throw new HttpError(400, "taskId must be a positive integer.");
  }
  const taskId = Number.parseInt(decoded, 10);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    throw new HttpError(400, "taskId must be a positive integer.");
  }
  return taskId;
}

function decodePathParam(value: string, fieldName: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    throw new HttpError(400, `Invalid URI encoding for ${fieldName}.`);
  }
}

function readBearerToken(req: http.IncomingMessage): string | null {
  const rawAuth = normalizeHeaderValue(req.headers.authorization);
  if (!rawAuth) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(rawAuth);
  if (!match) {
    return null;
  }
  const token = match[1]?.trim();
  return token ? token : null;
}

async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const rawBody = await readBodyBuffer(req, maxBytes);
  return parseJsonBuffer(rawBody);
}

async function readBodyBuffer(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
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
    return Buffer.alloc(0);
  }
  return Buffer.concat(chunks);
}

function parseJsonBuffer(buffer: Buffer): unknown {
  const raw = buffer.toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function parseTaskSubmitBody(value: unknown): Omit<ApiTaskSubmitInput, "idempotencyKey"> {
  const body = asObject(value, "task submit payload");
  const conversationId = normalizeRequiredString(body.conversationId, "conversationId");
  const senderId = normalizeRequiredString(body.senderId, "senderId");
  const text = normalizeRequiredString(body.text, "text");
  const externalContext = parseTaskSubmitExternalContext(body.externalContext, {
    conversationId,
    senderId,
  });
  return {
    conversationId,
    senderId,
    text,
    requestId: normalizeOptionalString(body.requestId),
    isDirectMessage: normalizeBoolean(body.isDirectMessage, true),
    mentionsBot: normalizeBoolean(body.mentionsBot, false),
    repliesToBot: normalizeBoolean(body.repliesToBot, false),
    ...(externalContext ? { externalContext } : {}),
  };
}

function parseWebhookSource(value: string | undefined): WebhookSource {
  if (!value) {
    throw new HttpError(400, "webhook source is required.");
  }
  const decoded = decodePathParam(value, "source").toLowerCase();
  if (decoded === "ci" || decoded === "pipeline" || decoded === "build") {
    return "ci";
  }
  if (decoded === "ticket" || decoded === "issue" || decoded === "workitem" || decoded === "work-item") {
    return "ticket";
  }
  throw new HttpError(400, `Unsupported webhook source: ${decoded}.`);
}

function readWebhookTimestamp(req: http.IncomingMessage): WebhookTimestamp {
  const raw = normalizeHeaderValue(req.headers["x-codeharbor-timestamp"]);
  if (!raw) {
    throw new HttpError(401, "Missing required header: X-CodeHarbor-Timestamp.");
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new HttpError(401, "X-CodeHarbor-Timestamp must be an integer UNIX timestamp.");
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(401, "X-CodeHarbor-Timestamp must be an integer UNIX timestamp.");
  }
  const unixSeconds = Math.abs(parsed) >= 1_000_000_000_000 ? Math.floor(parsed / 1000) : parsed;
  return {
    raw,
    unixSeconds,
  };
}

function verifyWebhookTimestamp(timestamp: WebhookTimestamp, toleranceSeconds: number): void {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp.unixSeconds) > toleranceSeconds) {
    throw new HttpError(401, `Webhook timestamp is outside the allowed window (${toleranceSeconds} seconds).`);
  }
}

function readWebhookSignature(req: http.IncomingMessage): Buffer {
  const raw = normalizeHeaderValue(req.headers["x-codeharbor-signature"]);
  if (!raw) {
    throw new HttpError(401, "Missing required header: X-CodeHarbor-Signature.");
  }

  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const candidates = parts.length > 0 ? parts : [raw];

  for (const candidate of candidates) {
    const keyedMatch = /^(?:sha256|v1)=([a-fA-F0-9]{64})$/.exec(candidate);
    if (keyedMatch) {
      return Buffer.from(keyedMatch[1], "hex");
    }
    if (/^[a-fA-F0-9]{64}$/.test(candidate)) {
      return Buffer.from(candidate, "hex");
    }
  }

  throw new HttpError(401, "Invalid webhook signature format. Expected sha256=<hex>.");
}

function verifyWebhookSignature(rawBody: Buffer, timestampRaw: string, signature: Buffer, secret: string): void {
  const expected = createHmac("sha256", secret).update(timestampRaw).update(".").update(rawBody).digest();
  if (expected.length !== signature.length) {
    throw new HttpError(401, "Invalid webhook signature.");
  }
  if (!timingSafeEqual(expected, signature)) {
    throw new HttpError(401, "Invalid webhook signature.");
  }
}

function mapWebhookPayload(source: WebhookSource, value: unknown): WebhookMapResult {
  const body = asObject(value, "webhook payload");
  switch (source) {
    case "ci":
      return mapCiWebhookPayload(body);
    case "ticket":
      return mapTicketWebhookPayload(body);
    default:
      throw new HttpError(400, `Unsupported webhook source: ${source}.`);
  }
}

function mapCiWebhookPayload(body: Record<string, unknown>): WebhookMapResult {
  const conversationId = readWebhookRequiredString(
    body,
    ["conversationId", "roomId", "room", "matrixRoomId"],
    "conversationId",
  );
  const senderId = readWebhookOptionalString(body, ["senderId", "actor", "triggeredBy", "userId", "user"]);
  const resolvedSenderId = senderId ?? WEBHOOK_DEFAULT_SENDER_BY_SOURCE.ci;
  const repository = readWebhookRequiredString(body, ["repository", "repo", "project", "projectKey"], "repository");
  const pipeline = readWebhookOptionalString(body, ["pipeline", "workflow", "job", "build", "stage"]);
  const status = readWebhookOptionalString(body, ["status", "conclusion", "result"]) ?? "unknown";
  const branch = readWebhookOptionalString(body, ["branch", "ref"]);
  const commit = readWebhookOptionalString(body, ["commit", "sha"]);
  const url = readWebhookOptionalString(body, ["url", "pipelineUrl", "buildUrl", "runUrl"]);
  const summary = readWebhookOptionalString(body, ["summary", "message", "detail"]);
  const instruction = readWebhookOptionalString(body, ["instruction", "task", "prompt"]);
  const eventId = readWebhookOptionalString(body, ["eventId", "deliveryId", "runId", "buildId"]);
  const workflowId = readWebhookOptionalString(body, ["workflowId", "workflowRunId", "runId", "buildId", "pipelineId"]);
  const externalRef = readWebhookOptionalString(body, ["externalId", "deliveryId", "eventId", "runId", "buildId"]);

  const lines = ["[CI Webhook]", `Repository: ${repository}`, `Status: ${status}`];
  if (pipeline) {
    lines.push(`Pipeline: ${pipeline}`);
  }
  if (branch) {
    lines.push(`Branch: ${branch}`);
  }
  if (commit) {
    lines.push(`Commit: ${commit}`);
  }
  if (url) {
    lines.push(`URL: ${url}`);
  }
  if (summary) {
    lines.push(`Summary: ${summary}`);
  }
  lines.push(
    `Instruction: ${
      instruction ?? "Analyze this CI event, identify the root cause, and propose actionable next steps."
    }`,
  );

  return {
    taskInput: {
      conversationId,
      senderId: resolvedSenderId,
      text: lines.join("\n"),
      requestId: readWebhookOptionalString(body, ["requestId", "eventId", "deliveryId", "runId", "buildId"]) ?? undefined,
      isDirectMessage: false,
      mentionsBot: true,
      repliesToBot: false,
      externalContext: {
        source: "ci",
        eventId,
        workflowId,
        externalRef,
        matrixConversationId: conversationId,
        matrixSenderId: resolvedSenderId,
        ci: {
          repository,
          pipeline,
          status,
          branch,
          commit,
          url,
        },
        ticket: null,
        metadata: collectWebhookMetadata(body, ["provider", "project", "projectKey", "environment", "region"]),
      },
    },
    idempotencyHint: readWebhookOptionalString(body, [
      "eventId",
      "deliveryId",
      "runId",
      "buildId",
      "pipelineId",
      "externalId",
    ]),
  };
}

function mapTicketWebhookPayload(body: Record<string, unknown>): WebhookMapResult {
  const conversationId = readWebhookRequiredString(
    body,
    ["conversationId", "roomId", "room", "matrixRoomId"],
    "conversationId",
  );
  const senderId = readWebhookOptionalString(body, ["senderId", "actor", "reporter", "assignee", "userId", "user"]);
  const resolvedSenderId = senderId ?? WEBHOOK_DEFAULT_SENDER_BY_SOURCE.ticket;
  const ticketId = readWebhookRequiredString(body, ["ticketId", "issueKey", "key", "id"], "ticketId");
  const title = readWebhookRequiredString(body, ["title", "summary", "subject"], "title");
  const status = readWebhookOptionalString(body, ["status", "state"]);
  const priority = readWebhookOptionalString(body, ["priority", "severity"]);
  const assignee = readWebhookOptionalString(body, ["assignee", "owner"]);
  const url = readWebhookOptionalString(body, ["url", "ticketUrl", "issueUrl"]);
  const description = readWebhookOptionalString(body, ["description", "detail", "content"]);
  const instruction = readWebhookOptionalString(body, ["instruction", "task", "prompt"]);
  const eventId = readWebhookOptionalString(body, ["eventId", "ticketEventId", "externalId"]);
  const workflowId = readWebhookOptionalString(body, ["workflowId", "workflowRunId", "runId"]);
  const externalRef = readWebhookOptionalString(body, ["externalId", "ticketEventId", "eventId"]);

  const lines = ["[Ticket Webhook]", `Ticket: ${ticketId}`, `Title: ${title}`];
  if (status) {
    lines.push(`Status: ${status}`);
  }
  if (priority) {
    lines.push(`Priority: ${priority}`);
  }
  if (assignee) {
    lines.push(`Assignee: ${assignee}`);
  }
  if (url) {
    lines.push(`URL: ${url}`);
  }
  if (description) {
    lines.push(`Description: ${description}`);
  }
  lines.push(
    `Instruction: ${
      instruction ?? "Triage this ticket, propose an implementation plan, and list key risks and test strategy."
    }`,
  );

  return {
    taskInput: {
      conversationId,
      senderId: resolvedSenderId,
      text: lines.join("\n"),
      requestId: readWebhookOptionalString(body, ["requestId", "eventId", "ticketEventId", "externalId"]) ?? undefined,
      isDirectMessage: false,
      mentionsBot: true,
      repliesToBot: false,
      externalContext: {
        source: "ticket",
        eventId,
        workflowId,
        externalRef,
        matrixConversationId: conversationId,
        matrixSenderId: resolvedSenderId,
        ci: null,
        ticket: {
          ticketId,
          title,
          status,
          priority,
          assignee,
          url,
        },
        metadata: collectWebhookMetadata(body, ["project", "projectKey", "board", "team"]),
      },
    },
    idempotencyHint: readWebhookOptionalString(body, [
      "eventId",
      "ticketEventId",
      "externalId",
      "ticketId",
      "issueKey",
      "key",
      "id",
    ]),
  };
}

function readWebhookRequiredString(body: Record<string, unknown>, keys: string[], fieldName: string): string {
  const value = readWebhookOptionalString(body, keys);
  if (!value) {
    throw new HttpError(422, `Webhook payload is missing required field: ${fieldName}.`);
  }
  return value;
}

function readWebhookOptionalString(body: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "string") {
      throw new HttpError(422, `Webhook payload field ${key} must be a string when provided.`);
    }
    const normalized = value.trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function collectWebhookMetadata(body: Record<string, unknown>, keys: string[]): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const key of keys) {
    const value = readWebhookOptionalString(body, [key]);
    if (!value) {
      continue;
    }
    metadata[key] = value;
  }
  return metadata;
}

function buildWebhookIdempotencyKey(
  req: http.IncomingMessage,
  source: WebhookSource,
  rawBody: Buffer,
  hint: string | null,
): string {
  const headerHint =
    normalizeHeaderValue(req.headers["x-codeharbor-event-id"]) ??
    normalizeHeaderValue(req.headers["x-webhook-id"]) ??
    normalizeHeaderValue(req.headers["x-request-id"]) ??
    normalizeHeaderValue(req.headers["x-github-delivery"]) ??
    normalizeHeaderValue(req.headers["x-gitlab-event-uuid"]) ??
    normalizeHeaderValue(req.headers["x-jira-webhook-identifier"]);
  const candidate = sanitizeIdempotencyHint(headerHint ?? hint);
  if (candidate) {
    return normalizeWebhookIdempotencyKey(`webhook:${source}:${candidate}`);
  }
  const digest = createHash("sha256").update(rawBody).digest("hex");
  return normalizeWebhookIdempotencyKey(`webhook:${source}:${digest}`);
}

function sanitizeIdempotencyHint(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.:]+|[-.:]+$/g, "");
  return sanitized || null;
}

function normalizeWebhookIdempotencyKey(value: string): string {
  if (value.length <= IDEMPOTENCY_KEY_MAX_CHARS) {
    return value;
  }
  const digest = createHash("sha256").update(value).digest("hex");
  return `webhook:hash:${digest}`;
}

function asObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${fieldName} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeHeaderValue(value: string | string[] | undefined): string | null {
  if (!value) {
    return null;
  }
  const raw = Array.isArray(value) ? value[0] ?? "" : value;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `Expected string value for ${fieldName}.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new HttpError(400, `${fieldName} is required.`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "Expected string value for requestId.");
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeOptionalNullString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, `Expected string value for ${fieldName}.`);
  }
  const normalized = value.trim();
  return normalized || null;
}

function parseTaskSubmitExternalContext(
  value: unknown,
  fallback: { conversationId: string; senderId: string },
): ApiTaskExternalContext | null {
  if (value === undefined || value === null) {
    return null;
  }
  const payload = asObject(value, "externalContext");
  const sourceRaw = normalizeOptionalNullString(payload.source, "externalContext.source");
  const source = normalizeApiExternalSource(sourceRaw);
  if (!source) {
    throw new HttpError(400, "externalContext.source must be one of: api, ci, ticket.");
  }

  return {
    source,
    eventId: normalizeOptionalNullString(payload.eventId, "externalContext.eventId"),
    workflowId: normalizeOptionalNullString(payload.workflowId, "externalContext.workflowId"),
    externalRef: normalizeOptionalNullString(payload.externalRef, "externalContext.externalRef"),
    matrixConversationId:
      normalizeOptionalNullString(payload.matrixConversationId, "externalContext.matrixConversationId") ??
      fallback.conversationId,
    matrixSenderId:
      normalizeOptionalNullString(payload.matrixSenderId, "externalContext.matrixSenderId") ?? fallback.senderId,
    ci: parseExternalCiContext(payload.ci),
    ticket: parseExternalTicketContext(payload.ticket),
    metadata: parseExternalMetadata(payload.metadata),
  };
}

function normalizeApiExternalSource(value: string | null): ApiTaskExternalContext["source"] | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "api" || normalized === "ci" || normalized === "ticket") {
    return normalized;
  }
  return null;
}

function parseExternalCiContext(value: unknown): ApiTaskExternalContext["ci"] {
  if (value === undefined || value === null) {
    return null;
  }
  const payload = asObject(value, "externalContext.ci");
  return {
    repository: normalizeOptionalNullString(payload.repository, "externalContext.ci.repository"),
    pipeline: normalizeOptionalNullString(payload.pipeline, "externalContext.ci.pipeline"),
    status: normalizeOptionalNullString(payload.status, "externalContext.ci.status"),
    branch: normalizeOptionalNullString(payload.branch, "externalContext.ci.branch"),
    commit: normalizeOptionalNullString(payload.commit, "externalContext.ci.commit"),
    url: normalizeOptionalNullString(payload.url, "externalContext.ci.url"),
  };
}

function parseExternalTicketContext(value: unknown): ApiTaskExternalContext["ticket"] {
  if (value === undefined || value === null) {
    return null;
  }
  const payload = asObject(value, "externalContext.ticket");
  return {
    ticketId: normalizeOptionalNullString(payload.ticketId, "externalContext.ticket.ticketId"),
    title: normalizeOptionalNullString(payload.title, "externalContext.ticket.title"),
    status: normalizeOptionalNullString(payload.status, "externalContext.ticket.status"),
    priority: normalizeOptionalNullString(payload.priority, "externalContext.ticket.priority"),
    assignee: normalizeOptionalNullString(payload.assignee, "externalContext.ticket.assignee"),
    url: normalizeOptionalNullString(payload.url, "externalContext.ticket.url"),
  };
}

function parseExternalMetadata(value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  const payload = asObject(value, "externalContext.metadata");
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(payload)) {
    if (typeof entry !== "string") {
      throw new HttpError(400, `externalContext.metadata.${key} must be a string.`);
    }
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    output[key] = normalized;
  }
  return output;
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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
