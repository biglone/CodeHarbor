import path from "node:path";

import { formatByteSize } from "./misc-utils";
import {
  inferRequestedKindFromPath,
  normalizeRelativeFilePath,
  type RecentArtifactBatch,
  type RequestedFileKind,
  type ResolvedFileCandidate,
} from "./file-send-intent";

const ACTION_BLOCK_PATTERN = /\[codeharbor_action\]\s*([\s\S]*?)\s*\[\/codeharbor_action\]/gi;
const MAX_ACTION_FILES = 12;
const DEFAULT_MAX_SEND_BYTES = 100 * 1024 * 1024;

export interface ParsedModelFileDeliveryAction {
  type: "send_files";
  files: string[];
}

export interface ModelFileDeliveryActionParseResult {
  cleanReply: string;
  action: ParsedModelFileDeliveryAction | null;
}

export interface ResolvedModelFileDeliveryAction {
  files: ResolvedFileCandidate[];
  skippedTooLarge: ResolvedFileCandidate[];
  missingFiles: string[];
  maxBytes: number;
}

export function buildRecentArtifactDeliveryContext(batches: RecentArtifactBatch[]): string | null {
  if (batches.length === 0) {
    return null;
  }

  const lines: string[] = [
    "[codeharbor_file_delivery]",
    "如果用户明确要求把最近生成的本地文件直接发回当前对话，你可以在回复末尾追加一个唯一动作块：",
    "[codeharbor_action]",
    '{"type":"send_files","files":["relative/path/file1.ext","relative/path/file2.ext"]}',
    "[/codeharbor_action]",
    "规则：",
    "- 只有在用户明确要求发送/发回/把文件给他时才输出动作块。",
    "- files 只能填写下面 recent_artifacts 里已列出的相对路径，不能杜撰。",
    "- “这四个/那一批/都发给我”优先选择最相关、最新的一批。",
    "- 对用户可见的话术放在动作块外面；如果不确定，就不要输出动作块。",
    "[recent_artifacts]",
  ];

  for (const batch of batches) {
    lines.push(`- batch requestId=${batch.requestId} createdAt=${new Date(batch.createdAt).toISOString()}`);
    for (const file of batch.files) {
      const kind = inferRequestedKindFromPath(file.relativePath) ?? "file";
      lines.push(
        `  - file=${file.relativePath} kind=${kind} size=${formatByteSize(file.sizeBytes)} mtime=${new Date(file.mtimeMs).toISOString()}`,
      );
    }
  }

  lines.push("[/recent_artifacts]");
  lines.push("[/codeharbor_file_delivery]");
  return lines.join("\n");
}

export function parseModelFileDeliveryAction(reply: string): ModelFileDeliveryActionParseResult {
  if (!reply.trim()) {
    return {
      cleanReply: reply,
      action: null,
    };
  }

  const matches = [...reply.matchAll(ACTION_BLOCK_PATTERN)];
  const cleanReply = reply.replace(ACTION_BLOCK_PATTERN, "").trim();
  const lastBlock = matches.at(-1)?.[1]?.trim();
  if (!lastBlock) {
    return {
      cleanReply,
      action: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastBlock);
  } catch {
    return {
      cleanReply,
      action: null,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      cleanReply,
      action: null,
    };
  }

  const type = "type" in parsed ? parsed.type : null;
  const files = "files" in parsed ? parsed.files : null;
  if (type !== "send_files" || !Array.isArray(files)) {
    return {
      cleanReply,
      action: null,
    };
  }

  const normalizedFiles = files
    .map((value) => (typeof value === "string" ? normalizeRelativeFilePath(value) : null))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, MAX_ACTION_FILES);

  if (normalizedFiles.length === 0) {
    return {
      cleanReply,
      action: null,
    };
  }

  return {
    cleanReply,
    action: {
      type: "send_files",
      files: normalizedFiles,
    },
  };
}

export function resolveModelFileDeliveryAction(input: {
  action: ParsedModelFileDeliveryAction;
  recentArtifactBatches: RecentArtifactBatch[];
  maxBytes?: number;
}): ResolvedModelFileDeliveryAction {
  const maxBytes = Math.max(1, Math.floor(input.maxBytes ?? DEFAULT_MAX_SEND_BYTES));
  const allowedFiles = new Map<string, ResolvedFileCandidate>();
  for (const batch of input.recentArtifactBatches) {
    for (const file of batch.files) {
      const normalizedPath = normalizeRelativeFilePath(file.relativePath);
      if (!normalizedPath || allowedFiles.has(normalizedPath)) {
        continue;
      }
      allowedFiles.set(normalizedPath, {
        absolutePath: file.absolutePath,
        relativePath: normalizedPath,
        sizeBytes: file.sizeBytes,
      });
    }
  }

  const files: ResolvedFileCandidate[] = [];
  const skippedTooLarge: ResolvedFileCandidate[] = [];
  const missingFiles: string[] = [];
  for (const relativePath of input.action.files) {
    const matched = allowedFiles.get(relativePath);
    if (!matched) {
      missingFiles.push(relativePath);
      continue;
    }
    if (matched.sizeBytes > maxBytes) {
      skippedTooLarge.push(matched);
      continue;
    }
    files.push(matched);
  }

  return {
    files,
    skippedTooLarge,
    missingFiles,
    maxBytes,
  };
}

export function buildModelFileDeliverySummary(action: ResolvedModelFileDeliveryAction): string {
  if (action.files.length === 0) {
    return "[CodeHarbor] 模型请求发送文件，但未找到可安全发送的匹配产物。";
  }

  const lines = [`[CodeHarbor] 已按模型动作发送 ${action.files.length} 个文件。`];
  for (const file of action.files) {
    lines.push(`- file: ${file.relativePath} (${formatByteSize(file.sizeBytes)})`);
  }
  if (action.missingFiles.length > 0) {
    lines.push(`- missing: ${action.missingFiles.length}`);
  }
  if (action.skippedTooLarge.length > 0) {
    lines.push(`- skippedTooLarge: ${action.skippedTooLarge.length}`);
  }
  return lines.join("\n");
}

export function buildModelFileDeliveryHistoryEntry(input: {
  cleanReply: string;
  sentFiles: ResolvedFileCandidate[];
}): string {
  if (input.cleanReply.trim()) {
    return input.cleanReply;
  }
  if (input.sentFiles.length === 0) {
    return "[CodeHarbor] 未发送任何文件。";
  }
  return `[CodeHarbor] 已发送 ${input.sentFiles.length} 个文件：${input.sentFiles.map((file) => path.basename(file.relativePath)).join(", ")}`;
}

export function classifyArtifactKindSummary(files: ResolvedFileCandidate[]): RequestedFileKind | "mixed" | null {
  if (files.length === 0) {
    return null;
  }
  const kinds = new Set(files.map((file) => inferRequestedKindFromPath(file.relativePath) ?? "file"));
  return kinds.size === 1 ? (kinds.values().next().value as RequestedFileKind) : "mixed";
}
