import http from "node:http";

import { Logger } from "./logger";
import { ApiTaskIdempotencyConflictError, type ApiTaskSubmitInput, type ApiTaskSubmitResult } from "./orchestrator";

const API_MAX_JSON_BODY_BYTES = 1_048_576;
const IDEMPOTENCY_KEY_MAX_CHARS = 256;

interface ApiServerOptions {
  host: string;
  port: number;
  apiToken: string;
}

interface AddressInfo {
  host: string;
  port: number;
}

export interface TaskSubmissionService {
  submitApiTask(input: ApiTaskSubmitInput): ApiTaskSubmitResult;
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
  private server: http.Server | null = null;
  private address: AddressInfo | null = null;

  constructor(logger: Logger, taskService: TaskSubmissionService, options: ApiServerOptions) {
    this.logger = logger;
    this.taskService = taskService;
    this.host = options.host;
    this.port = options.port;
    this.apiToken = options.apiToken;
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
      this.setSecurityHeaders(res);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

      if (url.pathname !== "/api/tasks") {
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

      if (!this.isAuthorized(req)) {
        this.sendJson(res, 401, {
          ok: false,
          error: "Unauthorized. Provide Authorization: Bearer <API_TOKEN>.",
        });
        return;
      }

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
