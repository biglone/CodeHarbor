export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
}

export interface RetryPolicyInput {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier?: number;
  jitterRatio?: number;
}

export interface ComputeRetryDelayInput {
  policy: RetryPolicy;
  attempt: number;
  retryAfterMs?: number | null;
  random?: () => number;
}

export interface RetryClassification {
  retryable: boolean;
  reason: string;
  retryAfterMs: number | null;
}

export interface RetryDecision {
  retryable: boolean;
  retryReason: string;
  retryAfterMs: number | null;
  shouldRetry: boolean;
  retryDelayMs: number | null;
  archiveReason: string | null;
}

export interface RetryDecisionInput {
  policy: RetryPolicy;
  attempt: number;
  classification: RetryClassification;
  random?: () => number;
}

export interface ClassifyRetryDecisionInput {
  policy: RetryPolicy;
  attempt: number;
  error: unknown;
  options?: RetryClassificationOptions;
  classify?: (error: unknown) => RetryClassification;
  random?: () => number;
}

export interface RetryClassificationOptions {
  retryableErrorCodes?: ReadonlySet<string>;
  retryableMessagePatterns?: readonly string[];
  retryableHttpStatuses?: ReadonlySet<number>;
}

export const ARCHIVE_REASON_MAX_ATTEMPTS = "max_attempts_reached";
export const ARCHIVE_REASON_NON_RETRYABLE = "non_retryable_error";
export const DEFAULT_RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
export const DEFAULT_RETRYABLE_ERROR_CODES = new Set([
  "ABORT_ERR",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);
export const DEFAULT_RETRYABLE_MESSAGE_PATTERNS = [
  "timed out",
  "timeout",
  "too many requests",
  "rate limit",
  "temporary",
  "temporarily unavailable",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "connection reset",
  "connection refused",
  "socket hang up",
  "network error",
  "network timeout",
  "fetch failed",
  "429",
  "502",
  "503",
  "504",
];

export function createRetryPolicy(input: RetryPolicyInput): RetryPolicy {
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));
  const initialDelayMs = Math.max(0, Math.floor(input.initialDelayMs));
  const maxDelayMs = Math.max(initialDelayMs, Math.floor(input.maxDelayMs));
  const multiplier = Number.isFinite(input.multiplier) ? Math.max(1, Number(input.multiplier)) : 2;
  const jitterRatio = Number.isFinite(input.jitterRatio) ? clamp(Number(input.jitterRatio), 0, 1) : 0.2;
  return {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    multiplier,
    jitterRatio,
  };
}

export function shouldRetry(policy: RetryPolicy, attempt: number, retryable: boolean): boolean {
  if (!retryable) {
    return false;
  }
  return Math.max(1, Math.floor(attempt)) < policy.maxAttempts;
}

export function buildRetryDecision(input: RetryDecisionInput): RetryDecision {
  const retryable = input.classification.retryable;
  const retryReason = normalizeRetryReason(input.classification.reason);
  const retryAfterMs = normalizeRetryAfterMs(input.classification.retryAfterMs);
  const shouldRetryNow = shouldRetry(input.policy, input.attempt, retryable);
  if (shouldRetryNow) {
    return {
      retryable,
      retryReason,
      retryAfterMs,
      shouldRetry: true,
      retryDelayMs: computeRetryDelayMs({
        policy: input.policy,
        attempt: input.attempt,
        retryAfterMs,
        random: input.random,
      }),
      archiveReason: null,
    };
  }

  return {
    retryable,
    retryReason,
    retryAfterMs,
    shouldRetry: false,
    retryDelayMs: null,
    archiveReason: retryable ? ARCHIVE_REASON_MAX_ATTEMPTS : retryReason,
  };
}

export function classifyRetryDecision(input: ClassifyRetryDecisionInput): RetryDecision {
  const classification = input.classify
    ? input.classify(input.error)
    : classifyRetryableError(input.error, input.options);
  return buildRetryDecision({
    policy: input.policy,
    attempt: input.attempt,
    classification,
    random: input.random,
  });
}

export function computeRetryDelayMs(input: ComputeRetryDelayInput): number {
  const attempt = Math.max(1, Math.floor(input.attempt));
  const baseDelay = computeExponentialDelayMs(input.policy, attempt);
  const jitteredDelay = applyJitter(baseDelay, input.policy.jitterRatio, input.random ?? Math.random);
  const retryAfterMs = Math.max(0, Math.floor(input.retryAfterMs ?? 0));
  return Math.max(0, Math.round(Math.max(jitteredDelay, retryAfterMs)));
}

export function isRetryableHttpStatus(
  status: number,
  retryableStatuses: ReadonlySet<number> = DEFAULT_RETRYABLE_HTTP_STATUSES,
): boolean {
  return retryableStatuses.has(status);
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const asSeconds = Number.parseFloat(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.round(asSeconds * 1_000);
  }

  const asDate = Date.parse(trimmed);
  if (!Number.isFinite(asDate)) {
    return null;
  }
  return Math.max(0, Math.round(asDate - nowMs));
}

export function classifyRetryableError(
  error: unknown,
  options: RetryClassificationOptions = {},
): RetryClassification {
  const retryableErrorCodes = options.retryableErrorCodes ?? DEFAULT_RETRYABLE_ERROR_CODES;
  const retryableMessagePatterns = options.retryableMessagePatterns ?? DEFAULT_RETRYABLE_MESSAGE_PATTERNS;
  const retryableHttpStatuses = options.retryableHttpStatuses ?? DEFAULT_RETRYABLE_HTTP_STATUSES;

  const message = readErrorMessage(error).toLowerCase();
  const code = readErrorCode(error);
  const status = readErrorStatus(error);
  const retryAfterMs = readErrorRetryAfterMs(error);

  if (isCancelledError(error, message)) {
    return {
      retryable: false,
      reason: "cancelled",
      retryAfterMs: null,
    };
  }

  if (isAbortError(error)) {
    return {
      retryable: true,
      reason: "abort_error",
      retryAfterMs,
    };
  }

  if (message.includes("invalid queued payload")) {
    return {
      retryable: false,
      reason: "invalid_payload",
      retryAfterMs: null,
    };
  }

  if (status !== null) {
    const reason = `http_${status}`;
    if (isRetryableHttpStatus(status, retryableHttpStatuses)) {
      return {
        retryable: true,
        reason,
        retryAfterMs,
      };
    }
    return {
      retryable: false,
      reason,
      retryAfterMs: null,
    };
  }

  if (code && retryableErrorCodes.has(code)) {
    return {
      retryable: true,
      reason: `error_code_${code.toLowerCase()}`,
      retryAfterMs,
    };
  }

  if (matchesMessagePattern(message, retryableMessagePatterns)) {
    return {
      retryable: true,
      reason: "transient_error",
      retryAfterMs,
    };
  }

  return {
    retryable: false,
    reason: "non_retryable_error",
    retryAfterMs: null,
  };
}

export async function sleep(delayMs: number): Promise<void> {
  const safeDelayMs = Math.max(0, Math.floor(delayMs));
  if (safeDelayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, safeDelayMs);
    timer.unref?.();
  });
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readErrorCode(error: unknown): string | null {
  if (!isRecord(error)) {
    return null;
  }
  if (typeof error.code !== "string") {
    return null;
  }
  const normalized = error.code.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function readErrorStatus(error: unknown): number | null {
  const direct = readIntegerFromErrorField(error, "status");
  if (direct !== null) {
    return direct;
  }
  const statusCode = readIntegerFromErrorField(error, "statusCode");
  if (statusCode !== null) {
    return statusCode;
  }
  if (!isRecord(error) || !isRecord(error.response)) {
    return null;
  }
  const nestedStatus = readIntegerFromErrorField(error.response, "status");
  if (nestedStatus !== null) {
    return nestedStatus;
  }
  return readIntegerFromErrorField(error.response, "statusCode");
}

function readErrorRetryAfterMs(error: unknown): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const explicitRetryAfterMs = parseNonNegativeNumber(error.retryAfterMs);
  if (explicitRetryAfterMs !== null) {
    return explicitRetryAfterMs;
  }
  if (typeof error.retryAfter === "string") {
    return parseRetryAfterMs(error.retryAfter);
  }
  if (isRecord(error.response)) {
    const nestedRetryAfterMs = parseNonNegativeNumber(error.response.retryAfterMs);
    if (nestedRetryAfterMs !== null) {
      return nestedRetryAfterMs;
    }
    if (typeof error.response.retryAfter === "string") {
      return parseRetryAfterMs(error.response.retryAfter);
    }
  }
  const retryAfterHeader = readRetryAfterHeader(error);
  if (retryAfterHeader !== null) {
    return parseRetryAfterMs(retryAfterHeader);
  }
  return null;
}

function readIntegerFromErrorField(error: unknown, fieldName: string): number | null {
  if (!isRecord(error)) {
    return null;
  }
  const raw = error[fieldName];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.floor(raw);
}

function parseNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeRetryReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) {
    return "unknown_error";
  }
  return normalized;
}

function normalizeRetryAfterMs(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function readRetryAfterHeader(error: unknown): string | null {
  if (!isRecord(error)) {
    return null;
  }
  const direct = extractRetryAfterFromHeaders(error.headers);
  if (direct !== null) {
    return direct;
  }
  if (!isRecord(error.response)) {
    return null;
  }
  return extractRetryAfterFromHeaders(error.response.headers);
}

function extractRetryAfterFromHeaders(headers: unknown): string | null {
  if (!headers || typeof headers !== "object") {
    return null;
  }
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = getter.call(headers, "retry-after");
    return typeof value === "string" ? value : null;
  }
  const record = headers as Record<string, unknown>;
  const direct = record["retry-after"] ?? record.retryAfter ?? record.RetryAfter ?? record["Retry-After"];
  return typeof direct === "string" ? direct : null;
}

function isCancelledError(error: unknown, message: string): boolean {
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    if (name.includes("cancelled") || name.includes("canceled")) {
      return true;
    }
  }
  return message.includes("cancelled") || message.includes("canceled");
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError";
}

function matchesMessagePattern(message: string, patterns: readonly string[]): boolean {
  if (!message) {
    return false;
  }
  return patterns.some((pattern) => {
    const normalized = pattern.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    return message.includes(normalized);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function computeExponentialDelayMs(policy: RetryPolicy, attempt: number): number {
  if (policy.initialDelayMs <= 0) {
    return 0;
  }
  const exponent = Math.max(0, attempt - 1);
  const computed = policy.initialDelayMs * policy.multiplier ** exponent;
  if (!Number.isFinite(computed)) {
    return policy.maxDelayMs;
  }
  return Math.min(policy.maxDelayMs, Math.round(computed));
}

function applyJitter(baseDelayMs: number, jitterRatio: number, random: () => number): number {
  if (baseDelayMs <= 0 || jitterRatio <= 0) {
    return baseDelayMs;
  }
  const normalizedRandom = clamp(random(), 0, 1);
  const jitterWindow = baseDelayMs * jitterRatio;
  const minDelay = Math.max(0, baseDelayMs - jitterWindow);
  const maxDelay = baseDelayMs + jitterWindow;
  return minDelay + (maxDelay - minDelay) * normalizedRandom;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
