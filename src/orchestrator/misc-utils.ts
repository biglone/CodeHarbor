import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import {
  classifyRetryDecision,
  classifyRetryableError,
  type RetryClassification,
  type RetryDecision,
  type RetryPolicy,
} from "../reliability/retry-policy";
import type { TaskQueueRecord } from "../store/state-store";
import type { InboundMessage } from "../types";
import { summarizeSingleLine } from "./helpers";

export function buildApiTaskEventId(idempotencyKey: string): string {
  const normalized = idempotencyKey.trim();
  if (!normalized) {
    throw new Error("Idempotency-Key is required.");
  }
  const digest = createHash("sha256").update(normalized).digest("hex");
  return `$api-${digest}`;
}

export function buildSessionKey(message: InboundMessage): string {
  return `${message.channel}:${message.conversationId}:${message.senderId}`;
}

export function mapApiTaskStage(task: TaskQueueRecord): "queued" | "retrying" | "executing" | "completed" | "failed" {
  if (task.status === "pending") {
    return task.nextRetryAt === null ? "queued" : "retrying";
  }
  if (task.status === "running") {
    return "executing";
  }
  if (task.status === "succeeded") {
    return "completed";
  }
  return "failed";
}

export function buildApiTaskErrorSummary(task: TaskQueueRecord): string | null {
  const source =
    task.status === "failed"
      ? task.error ?? task.lastError
      : task.status === "pending" && task.nextRetryAt !== null
        ? task.lastError
        : null;
  if (!source) {
    return null;
  }
  return summarizeSingleLine(source, 240);
}

export async function cleanupAttachmentFiles(attachmentPaths: string[]): Promise<void> {
  await Promise.all(
    attachmentPaths.map(async (attachmentPath) => {
      try {
        await fs.unlink(attachmentPath);
      } catch {
        // Ignore cleanup failure: temp files are best-effort.
      }
    }),
  );
}

export function stripLeadingBotMention(text: string, matrixUserId: string): string {
  if (!matrixUserId) {
    return text;
  }

  const mentionPatterns = [new RegExp(`^\\s*(?:<)?${escapeRegex(matrixUserId)}(?:>)?[\\s,:，：-]*`, "i")];
  const localpart = parseMatrixUserLocalpart(matrixUserId);
  if (localpart) {
    mentionPatterns.push(new RegExp(`^\\s*@${escapeRegex(localpart)}[\\s,:，：-]*`, "i"));
  }

  const trimmed = text.trim();
  for (const pattern of mentionPatterns) {
    const next = trimmed.replace(pattern, "").trim();
    if (next !== trimmed) {
      return next;
    }
  }
  return trimmed;
}

export function hasLeadingMentionForOtherUser(text: string, matrixUserId: string): boolean {
  if (!matrixUserId) {
    return false;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const leadingMention = extractLeadingMatrixMention(trimmed);
  if (!leadingMention) {
    return false;
  }

  const normalizedMention = leadingMention.toLowerCase();
  const normalizedSelfUserId = matrixUserId.toLowerCase();
  if (normalizedMention === normalizedSelfUserId) {
    return false;
  }

  const localpart = parseMatrixUserLocalpart(matrixUserId);
  if (localpart && normalizedMention === `@${localpart.toLowerCase()}`) {
    return false;
  }

  return true;
}

export function formatByteSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes}B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)}KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function classifyQueueTaskRetry(policy: RetryPolicy, attempt: number, error: unknown): RetryDecision {
  return classifyRetryDecision({
    policy,
    attempt,
    error,
    classify: classifyQueueTaskError,
  });
}

function classifyQueueTaskError(error: unknown): RetryClassification {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("exhausted your daily quota") || message.includes("quota exceeded for metric")) {
    return {
      retryable: false,
      reason: "quota_exceeded",
      retryAfterMs: null,
    };
  }
  return classifyRetryableError(error);
}

function parseMatrixUserLocalpart(userId: string): string | null {
  if (!userId.startsWith("@")) {
    return null;
  }
  const colonIndex = userId.indexOf(":");
  if (colonIndex <= 1) {
    return null;
  }
  return userId.slice(1, colonIndex);
}

function extractLeadingMatrixMention(text: string): string | null {
  const match = text.match(/^(?:<)?(@[A-Za-z0-9._=/-]+(?::[A-Za-z0-9._=:/-]+)?)(?:>)?(?=$|[\s,.:;!?，。：；])/);
  if (!match) {
    return null;
  }
  return match[1] ?? null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
