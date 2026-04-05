import { describe, expect, it } from "vitest";

import {
  classifyQueueTaskRetry,
  hasLeadingMentionForOtherUser,
  stripLeadingBotMention,
} from "../src/orchestrator/misc-utils";
import { createRetryPolicy } from "../src/reliability/retry-policy";

describe("classifyQueueTaskRetry", () => {
  const policy = createRetryPolicy({
    maxAttempts: 4,
    initialDelayMs: 1000,
    maxDelayMs: 10_000,
  });

  it("treats daily quota exhaustion as non-retryable", () => {
    const error = new Error(
      "TerminalQuotaError: You have exhausted your daily quota on this model. Quota exceeded for metric.",
    );

    const decision = classifyQueueTaskRetry(policy, 1, error);

    expect(decision.retryable).toBe(false);
    expect(decision.shouldRetry).toBe(false);
    expect(decision.retryReason).toBe("quota_exceeded");
    expect(decision.archiveReason).toBe("quota_exceeded");
  });

  it("keeps transient 429 style errors retryable", () => {
    const error = new Error("HTTP 429 Too Many Requests");

    const decision = classifyQueueTaskRetry(policy, 1, error);

    expect(decision.retryable).toBe(true);
    expect(decision.shouldRetry).toBe(true);
    expect(decision.retryReason).toBe("transient_error");
  });
});

describe("stripLeadingBotMention", () => {
  it("strips full matrix user id mention", () => {
    const output = stripLeadingBotMention("@dev-main:matrix.example.com /backend status", "@dev-main:matrix.example.com");
    expect(output).toBe("/backend status");
  });

  it("strips localpart mention alias", () => {
    const output = stripLeadingBotMention("@dev-main /backend status", "@dev-main:matrix.example.com");
    expect(output).toBe("/backend status");
  });

  it("keeps text unchanged when no mention prefix", () => {
    const output = stripLeadingBotMention("hello there", "@dev-main:matrix.example.com");
    expect(output).toBe("hello there");
  });
});

describe("hasLeadingMentionForOtherUser", () => {
  it("returns true when leading mention targets peer user", () => {
    const result = hasLeadingMentionForOtherUser("@dev-main 请处理", "@main-hub:matrix.example.com");
    expect(result).toBe(true);
  });

  it("returns false when leading mention targets self localpart", () => {
    const result = hasLeadingMentionForOtherUser("@main-hub 你好", "@main-hub:matrix.example.com");
    expect(result).toBe(false);
  });

  it("returns false when leading mention targets full self mxid", () => {
    const result = hasLeadingMentionForOtherUser("@main-hub:matrix.example.com 你好", "@main-hub:matrix.example.com");
    expect(result).toBe(false);
  });
});
