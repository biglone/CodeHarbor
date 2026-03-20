import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import {
  classifyRetryDecision,
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
  const escapedUserId = escapeRegex(matrixUserId);
  const mentionPattern = new RegExp(`^\\s*(?:<)?${escapedUserId}(?:>)?[\\s,:，：-]*`, "i");
  return text.replace(mentionPattern, "").trim();
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
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
