import fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_FILES = 4_000;
const DEFAULT_MAX_SEND_BYTES = 100 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "__pycache__", ".cache", ".codeharbor"]);

const SEND_VERB_PATTERN = /(?:发送|发给|发我|send)/i;
const SEND_TARGET_PATTERN = /(?:给我|发我|to me|到(?:当前|这个)?(?:对话|房间|窗口|会话|这里))/i;
const FILE_HINT_PATTERN =
  /(?:文件|附件|视频|音频|图片|文档|file|attachment|video|audio|image|document|[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12})/i;

interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  baseNameLower: string;
  relativeLower: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface FileSendIntent {
  requestedName: string | null;
}

export interface ResolvedFileCandidate {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
}

export interface ResolveFileRequestResult {
  status: "ok" | "workdir_missing" | "not_found" | "too_large";
  requestedName: string | null;
  file: ResolvedFileCandidate | null;
  maxBytes: number;
}

export function parseFileSendIntent(text: string): FileSendIntent | null {
  const raw = text.trim();
  if (!raw) {
    return null;
  }
  if (!SEND_VERB_PATTERN.test(raw) || !SEND_TARGET_PATTERN.test(raw) || !FILE_HINT_PATTERN.test(raw)) {
    return null;
  }

  const requestedName =
    extractQuotedCandidate(raw) ??
    extractByPattern(raw, /(?:把|将)\s*([^，。！？!?\n]{1,180}?)\s*(?:文件|附件|视频|音频|图片|文档)\s*(?:发送|发)/i) ??
    extractByPattern(raw, /(?:发送|发)\s*([^，。！？!?\n]{1,180}?)\s*(?:文件|附件|视频|音频|图片|文档)/i) ??
    extractLikelyFileToken(raw);

  return {
    requestedName: normalizeRequestedName(requestedName),
  };
}

export async function resolveRequestedFile(input: {
  workdir: string;
  requestedName: string | null;
  maxBytes?: number;
}): Promise<ResolveFileRequestResult> {
  const maxBytes = Math.max(1, Math.floor(input.maxBytes ?? DEFAULT_MAX_SEND_BYTES));
  const root = path.resolve(input.workdir);
  let rootStats: Stats | null = null;
  try {
    rootStats = await fs.stat(root);
  } catch {
    rootStats = null;
  }
  if (!rootStats || !rootStats.isDirectory()) {
    return {
      status: "workdir_missing",
      requestedName: input.requestedName,
      file: null,
      maxBytes,
    };
  }

  const normalizedQuery = normalizeRequestedName(input.requestedName);
  if (normalizedQuery) {
    const direct = await tryResolveDirectFile(root, normalizedQuery);
    if (direct) {
      if (direct.sizeBytes > maxBytes) {
        return {
          status: "too_large",
          requestedName: normalizedQuery,
          file: direct,
          maxBytes,
        };
      }
      return {
        status: "ok",
        requestedName: normalizedQuery,
        file: direct,
        maxBytes,
      };
    }
  }

  const files = await scanFiles(root);
  if (files.length === 0) {
    return {
      status: "not_found",
      requestedName: normalizedQuery,
      file: null,
      maxBytes,
    };
  }

  const matched = pickBestCandidate(files, normalizedQuery);
  if (matched.length === 0) {
    return {
      status: "not_found",
      requestedName: normalizedQuery,
      file: null,
      maxBytes,
    };
  }

  const sizeAllowed = matched.find((item) => item.sizeBytes <= maxBytes) ?? null;
  if (!sizeAllowed) {
    const largestCandidate = matched[0] ?? null;
    return {
      status: "too_large",
      requestedName: normalizedQuery,
      file: largestCandidate
        ? {
            absolutePath: largestCandidate.absolutePath,
            relativePath: largestCandidate.relativePath,
            sizeBytes: largestCandidate.sizeBytes,
          }
        : null,
      maxBytes,
    };
  }

  return {
    status: "ok",
    requestedName: normalizedQuery,
    file: {
      absolutePath: sizeAllowed.absolutePath,
      relativePath: sizeAllowed.relativePath,
      sizeBytes: sizeAllowed.sizeBytes,
    },
    maxBytes,
  };
}

function extractQuotedCandidate(text: string): string | null {
  const pattern = /[`"'“”‘’【】《》](.+?)[`"'“”‘’【】《》]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = normalizeRequestedName(match[1] ?? null);
    if (!candidate) {
      continue;
    }
    if (candidate.includes("/") || candidate.includes("\\") || /\.[A-Za-z0-9]{1,12}$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractByPattern(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  if (!match) {
    return null;
  }
  return normalizeRequestedName(match[1] ?? null);
}

function extractLikelyFileToken(text: string): string | null {
  const match = text.match(/([A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12})/);
  if (!match) {
    return null;
  }
  return normalizeRequestedName(match[1] ?? null);
}

function normalizeRequestedName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  let normalized = value.trim();
  if (!normalized) {
    return null;
  }

  normalized = normalized.replace(/^[`"'“”‘’【】《》]+/, "");
  normalized = normalized.replace(/[`"'“”‘’【】《》]+$/, "");
  normalized = normalized.replace(/^(?:生成的|刚生成的|最新生成的|最新的|这个|那个|对应的|相关的)\s*/i, "");
  normalized = normalized.replace(/\s*(?:文件|附件|视频|音频|图片|文档)\s*$/i, "");
  normalized = normalized.trim();
  if (!normalized) {
    return null;
  }
  if (normalized === "文件" || normalized === "附件") {
    return null;
  }
  return normalized;
}

async function tryResolveDirectFile(workdir: string, requestedName: string): Promise<ResolvedFileCandidate | null> {
  if (!looksLikePath(requestedName)) {
    return null;
  }

  const resolved = path.isAbsolute(requestedName)
    ? path.resolve(requestedName)
    : path.resolve(workdir, requestedName);
  if (!isPathInside(workdir, resolved)) {
    return null;
  }
  let stats: Stats | null = null;
  try {
    stats = await fs.stat(resolved);
  } catch {
    stats = null;
  }
  if (!stats || !stats.isFile()) {
    return null;
  }
  const relativePath = normalizeRelativePath(path.relative(workdir, resolved));
  return {
    absolutePath: resolved,
    relativePath,
    sizeBytes: stats.size,
  };
}

function looksLikePath(requestedName: string): boolean {
  return requestedName.includes("/") || requestedName.includes("\\") || requestedName.startsWith(".");
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (!relative) {
    return true;
  }
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function scanFiles(root: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];

  while (queue.length > 0 && files.length < MAX_SCAN_FILES) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= MAX_SCAN_DEPTH) {
          continue;
        }
        if (shouldSkipDirectory(entry.name)) {
          continue;
        }
        queue.push({
          directory: absolutePath,
          depth: current.depth + 1,
        });
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }
      const relativePath = normalizeRelativePath(path.relative(root, absolutePath));
      if (!relativePath || relativePath.startsWith("../")) {
        continue;
      }
      if (hasHiddenSegment(relativePath)) {
        continue;
      }
      let stats: Stats | null = null;
      try {
        stats = await fs.stat(absolutePath);
      } catch {
        stats = null;
      }
      if (!stats || !stats.isFile()) {
        continue;
      }
      files.push({
        absolutePath,
        relativePath,
        baseNameLower: entry.name.toLowerCase(),
        relativeLower: relativePath.toLowerCase(),
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.size,
      });
      if (files.length >= MAX_SCAN_FILES) {
        break;
      }
    }
  }

  return files;
}

function shouldSkipDirectory(name: string): boolean {
  if (name.startsWith(".")) {
    return true;
  }
  return SKIPPED_DIRECTORIES.has(name);
}

function hasHiddenSegment(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some((segment) => segment.startsWith("."));
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function pickBestCandidate(files: ScannedFile[], requestedName: string | null): ScannedFile[] {
  const sortedByRecent = [...files].sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!requestedName) {
    return sortedByRecent;
  }

  const query = normalizeRelativePath(requestedName.toLowerCase());
  const queryBaseName = path.basename(query);
  const matched = files
    .map((file) => ({
      file,
      score: scoreCandidate(file, query, queryBaseName),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.file.mtimeMs - left.file.mtimeMs;
    })
    .map((item) => item.file);

  return matched;
}

function scoreCandidate(file: ScannedFile, query: string, queryBaseName: string): number {
  if (file.relativeLower === query) {
    return 600;
  }
  if (file.baseNameLower === query || file.baseNameLower === queryBaseName) {
    return 500;
  }
  if (file.relativeLower.endsWith(`/${query}`)) {
    return 480;
  }
  if (file.baseNameLower.startsWith(queryBaseName) && queryBaseName.length >= 3) {
    return 420;
  }
  if (file.baseNameLower.includes(queryBaseName) && queryBaseName.length >= 2) {
    return 360;
  }
  if (file.relativeLower.includes(query) && query.length >= 2) {
    return 300;
  }
  return 0;
}
