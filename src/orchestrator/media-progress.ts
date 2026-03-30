import path from "node:path";

import type { CodexProgressEvent } from "../executor/codex-executor";
import { CodexExecutionCancelledError } from "../executor/codex-executor";
import type { InboundMessage } from "../types";
import { formatError } from "./helpers";

export interface MediaDiagEventLike {
  at: string;
  type: string;
  requestId: string;
  sessionKey: string;
  detail: string;
}

export function shouldRetryClaudeImageFailure(
  provider: "codex" | "claude" | "gemini",
  imagePaths: string[],
  error: unknown,
): boolean {
  if (provider !== "claude" || imagePaths.length === 0) {
    return false;
  }
  if (error instanceof CodexExecutionCancelledError) {
    return false;
  }

  const message = formatError(error).toLowerCase();
  if (!message) {
    return false;
  }
  if (message.includes("timed out") || message.includes("timeout") || message.includes("cancelled")) {
    return false;
  }
  if (message.includes("unsupported image extension")) {
    return true;
  }

  const imageSignal =
    message.includes("image") ||
    message.includes("media_type") ||
    message.includes("base64") ||
    message.includes("stream-json") ||
    message.includes("input-format");
  const failureSignal =
    message.includes("invalid") ||
    message.includes("unsupported") ||
    message.includes("failed") ||
    message.includes("error") ||
    message.includes("too large") ||
    message.includes("too many");

  return imageSignal && failureSignal;
}

export function normalizeImageMimeType(mimeType: string | null, localPath: string): string | null {
  const normalized = mimeType?.trim().toLowerCase() ?? "";
  if (normalized) {
    return normalized;
  }
  return inferImageMimeTypeFromPath(localPath);
}

export function formatMimeAllowlist(mimeTypes: string[]): string {
  if (mimeTypes.length === 0) {
    return "none";
  }
  return mimeTypes
    .map((value) => {
      const normalized = value.trim().toLowerCase();
      const slashIndex = normalized.indexOf("/");
      if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
        return normalized || value;
      }
      return normalized.slice(slashIndex + 1);
    })
    .join("/");
}

export function formatMediaDiagEvents(events: MediaDiagEventLike[]): string {
  if (events.length === 0) {
    return "- (no media records yet)";
  }
  return events
    .map(
      (event, index) =>
        `- #${index + 1} ${event.at} type=${event.type} requestId=${event.requestId} session=${event.sessionKey} detail=${event.detail}`,
    )
    .join("\n");
}

export function collectLocalAttachmentPaths(message: InboundMessage): string[] {
  const seen = new Set<string>();
  for (const attachment of message.attachments) {
    if (!attachment.localPath) {
      continue;
    }
    seen.add(attachment.localPath);
  }
  return [...seen];
}

export function mapProgressText(progress: CodexProgressEvent, cliCompatMode: boolean): string | null {
  if (progress.stage === "turn_started") {
    return "开始处理请求，正在思考...";
  }
  if (progress.stage === "reasoning" && progress.message) {
    const normalized = progress.message.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return null;
    }
    const maxLen = 180;
    return normalized.length > maxLen ? `思考中: ${normalized.slice(0, maxLen)}...` : `思考中: ${normalized}`;
  }
  if (progress.stage === "item_completed" && progress.message) {
    return `阶段完成: ${progress.message}`;
  }
  if (cliCompatMode && progress.stage === "stderr" && progress.message) {
    const text = progress.message.length > 220 ? `${progress.message.slice(0, 220)}...` : progress.message;
    return `stderr: ${text}`;
  }
  if (cliCompatMode && progress.stage === "raw_event") {
    if (!progress.message) {
      return null;
    }
    return `事件: ${progress.message}`;
  }
  return null;
}

function inferImageMimeTypeFromPath(localPath: string): string | null {
  const extension = path.extname(localPath).trim().toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  return null;
}
