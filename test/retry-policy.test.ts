import { describe, expect, it } from "vitest";

import {
  buildRetryDecision,
  classifyRetryableError,
  classifyRetryDecision,
  computeRetryDelayMs,
  createRetryPolicy,
  parseRetryAfterMs,
} from "../src/reliability/retry-policy";

describe("retry-policy", () => {
  it("uses Retry-After when it is greater than backoff delay", () => {
    const policy = createRetryPolicy({
      maxAttempts: 4,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      multiplier: 2,
      jitterRatio: 0,
    });

    const delayMs = computeRetryDelayMs({
      policy,
      attempt: 1,
      retryAfterMs: 350,
      random: () => 0.5,
    });

    expect(delayMs).toBe(350);
  });

  it("parses Retry-After seconds and date values", () => {
    expect(parseRetryAfterMs("1.5")).toBe(1_500);
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:27:59 GMT"))).toBe(
      1_000,
    );
  });

  it("classifies transient network errors as retryable", () => {
    const error = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const result = classifyRetryableError(error);
    expect(result.retryable).toBe(true);
    expect(result.reason).toBe("error_code_econnreset");
    expect(result.retryAfterMs).toBeNull();
  });

  it("classifies queued payload validation errors as non-retryable", () => {
    const result = classifyRetryableError(new Error("Invalid queued payload JSON."));
    expect(result).toEqual({
      retryable: false,
      reason: "invalid_payload",
      retryAfterMs: null,
    });
  });

  it("captures retryable http status and retry-after metadata", () => {
    const error = Object.assign(new Error("HTTP 429 Too Many Requests"), {
      status: 429,
      retryAfterMs: 1_200,
    });
    const result = classifyRetryableError(error);
    expect(result).toEqual({
      retryable: true,
      reason: "http_429",
      retryAfterMs: 1_200,
    });
  });

  it("builds retry decision and computes archive reason at max attempts", () => {
    const policy = createRetryPolicy({
      maxAttempts: 2,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      multiplier: 2,
      jitterRatio: 0,
    });
    const decision = buildRetryDecision({
      policy,
      attempt: 2,
      classification: {
        retryable: true,
        reason: "http_503",
        retryAfterMs: 500,
      },
    });

    expect(decision).toEqual({
      retryable: true,
      retryReason: "http_503",
      retryAfterMs: 500,
      shouldRetry: false,
      retryDelayMs: null,
      archiveReason: "max_attempts_reached",
    });
  });

  it("classifies and resolves retry decision in one step", () => {
    const policy = createRetryPolicy({
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      multiplier: 2,
      jitterRatio: 0,
    });
    const decision = classifyRetryDecision({
      policy,
      attempt: 1,
      error: Object.assign(new Error("HTTP 429"), {
        status: 429,
        retryAfterMs: 350,
      }),
      random: () => 0.5,
    });

    expect(decision).toEqual({
      retryable: true,
      retryReason: "http_429",
      retryAfterMs: 350,
      shouldRetry: true,
      retryDelayMs: 350,
      archiveReason: null,
    });
  });
});
