import http from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { Logger } from "./logger";
import {
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
  webhookSecret?: string | null;
  webhookTimestampToleranceSeconds?: number;
}

interface AddressInfo {
  host: string;
  port: number;
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
  private readonly webhookSecret: string | null;
  private readonly webhookTimestampToleranceSeconds: number;
  private server: http.Server | null = null;
  private address: AddressInfo | null = null;

  constructor(logger: Logger, taskService: TaskSubmissionService, options: ApiServerOptions) {
    this.logger = logger;
    this.taskService = taskService;
    this.host = options.host;
    this.port = options.port;
    this.apiToken = options.apiToken;
    this.webhookSecret = options.webhookSecret?.trim() || null;
    this.webhookTimestampToleranceSeconds = Math.max(
      0,
      options.webhookTimestampToleranceSeconds ?? DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    );
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
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const taskDetailMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      const isTaskSubmitRoute = url.pathname === "/api/tasks";
      const webhookMatch = /^\/api\/webhooks\/([^/]+)$/.exec(url.pathname);
      this.setSecurityHeaders(res);
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Idempotency-Key, X-CodeHarbor-Signature, X-CodeHarbor-Timestamp, X-CodeHarbor-Event-Id",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

      if (!isTaskSubmitRoute && !taskDetailMatch && !webhookMatch) {
        this.sendJson(res, 404, {
          ok: false,
          error: `Not found: ${req.method ?? "GET"} ${url.pathname}`,
        });
        return;
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (webhookMatch) {
        await this.handleWebhookRequest(req, res, webhookMatch[1]);
        return;
      }

      if (!this.isAuthorized(req)) {
        this.sendJson(res, 401, {
          ok: false,
          error: "Unauthorized. Provide Authorization: Bearer <API_TOKEN>.",
        });
        return;
      }

      if (isTaskSubmitRoute) {
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST, OPTIONS");
          this.sendJson(res, 405, {
            ok: false,
            error: `Method not allowed: ${req.method ?? "GET"}.`,
          });
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
        return;
      }

      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        this.sendJson(res, 405, {
          ok: false,
          error: `Method not allowed: ${req.method ?? "GET"}.`,
        });
        return;
      }

      const taskId = parseTaskId(taskDetailMatch?.[1]);
      const result = this.taskService.getApiTaskById(taskId);
      if (!result) {
        this.sendJson(res, 404, {
          ok: false,
          error: `Task not found: ${taskId}.`,
        });
        return;
      }
      this.sendJson(res, 200, {
        ok: true,
        data: formatTaskQueryResponse(result),
      });
    } catch (error) {
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
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      this.sendJson(res, 405, {
        ok: false,
        error: `Method not allowed: ${req.method ?? "GET"}.`,
      });
      return;
    }

    if (!this.webhookSecret) {
      throw new HttpError(503, "Webhook is unavailable because API_WEBHOOK_SECRET is not configured.");
    }

    const source = parseWebhookSource(sourceParam);
    const rawBody = await readBodyBuffer(req, API_MAX_JSON_BODY_BYTES);
    const timestamp = readWebhookTimestamp(req);
    verifyWebhookTimestamp(timestamp, this.webhookTimestampToleranceSeconds);
    const signature = readWebhookSignature(req);
    verifyWebhookSignature(rawBody, timestamp.raw, signature, this.webhookSecret);
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
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const token = readBearerToken(req);
    return token !== null && token === this.apiToken;
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
  return {
    conversationId,
    senderId,
    text,
    requestId: normalizeOptionalString(body.requestId),
    isDirectMessage: normalizeBoolean(body.isDirectMessage, true),
    mentionsBot: normalizeBoolean(body.mentionsBot, false),
    repliesToBot: normalizeBoolean(body.repliesToBot, false),
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
  const repository = readWebhookRequiredString(body, ["repository", "repo", "project", "projectKey"], "repository");
  const pipeline = readWebhookOptionalString(body, ["pipeline", "workflow", "job", "build", "stage"]);
  const status = readWebhookOptionalString(body, ["status", "conclusion", "result"]) ?? "unknown";
  const branch = readWebhookOptionalString(body, ["branch", "ref"]);
  const commit = readWebhookOptionalString(body, ["commit", "sha"]);
  const url = readWebhookOptionalString(body, ["url", "pipelineUrl", "buildUrl", "runUrl"]);
  const summary = readWebhookOptionalString(body, ["summary", "message", "detail"]);
  const instruction = readWebhookOptionalString(body, ["instruction", "task", "prompt"]);

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
      senderId: senderId ?? WEBHOOK_DEFAULT_SENDER_BY_SOURCE.ci,
      text: lines.join("\n"),
      requestId: readWebhookOptionalString(body, ["requestId", "eventId", "deliveryId", "runId", "buildId"]) ?? undefined,
      isDirectMessage: false,
      mentionsBot: true,
      repliesToBot: false,
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
  const ticketId = readWebhookRequiredString(body, ["ticketId", "issueKey", "key", "id"], "ticketId");
  const title = readWebhookRequiredString(body, ["title", "summary", "subject"], "title");
  const status = readWebhookOptionalString(body, ["status", "state"]);
  const priority = readWebhookOptionalString(body, ["priority", "severity"]);
  const assignee = readWebhookOptionalString(body, ["assignee", "owner"]);
  const url = readWebhookOptionalString(body, ["url", "ticketUrl", "issueUrl"]);
  const description = readWebhookOptionalString(body, ["description", "detail", "content"]);
  const instruction = readWebhookOptionalString(body, ["instruction", "task", "prompt"]);

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
      senderId: senderId ?? WEBHOOK_DEFAULT_SENDER_BY_SOURCE.ticket,
      text: lines.join("\n"),
      requestId: readWebhookOptionalString(body, ["requestId", "eventId", "ticketEventId", "externalId"]) ?? undefined,
      isDirectMessage: false,
      mentionsBot: true,
      repliesToBot: false,
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
