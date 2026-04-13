import fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_FILES = 4_000;
const DEFAULT_MAX_SEND_BYTES = 100 * 1024 * 1024;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "__pycache__", ".cache", ".codeharbor"]);
const COUNTED_FILE_HINT_PATTERN =
  /(?:^|[\s，。！？!?,、])(?:把|将)?\s*(?!第)(?:这|那|共|总共|一共|共计)?\s*([0-9]+|[零〇一二两三四五六七八九十百千]+)\s*(?:个|份|条|段|部)?\s*(?:文件|附件|视频|音频|图片|文档|files?|attachments?|videos?|audio|images?|documents?)/i;
const SEND_ALL_PATTERN =
  /(?:全部|所有|全都|统统|一并|一起|一次性|都(?=\s*(?:发|发送|给我|发给我|发我|send)))/i;

const SEND_VERB_PATTERN = /(?:发送|发给|发我|send)/i;
const SEND_TARGET_PATTERN = /(?:给我|发我|to me|到(?:当前|这个)?(?:对话|房间|窗口|会话|这里))/i;
const FILE_HINT_PATTERN =
  /(?:文件|附件|视频|音频|图片|文档|file|attachment|video|audio|image|document|[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12})/i;
const FILE_GENERIC_HINT_PATTERN = /(?:文件|附件|file|attachment)/i;
const VIDEO_HINT_PATTERN = /(?:视频|video|\.mp4|\.mov|\.mkv|\.webm|\.avi|\.m4v|\.flv|\.wmv)/i;
const AUDIO_HINT_PATTERN = /(?:音频|语音|audio|\.mp3|\.wav|\.m4a|\.aac|\.flac|\.ogg|\.opus)/i;
const IMAGE_HINT_PATTERN = /(?:图片|图像|截图|照片|image|photo|\.png|\.jpe?g|\.gif|\.webp|\.bmp|\.svg)/i;
const DOCUMENT_HINT_PATTERN = /(?:文档|文稿|报告|document|\.pdf|\.docx?|\.xlsx?|\.pptx?|\.txt|\.md|\.csv|\.log|\.json)/i;

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".wmv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".log",
  ".rtf",
]);

const GENERIC_REQUESTED_NAME_SET = new Set([
  "生成的",
  "生成好的",
  "刚生成的",
  "刚生成好的",
  "刚刚生成的",
  "刚刚生成好的",
  "最新的",
  "最新生成的",
  "最新生成好的",
  "新生成的",
  "最近生成的",
  "当前生成的",
  "输出的",
  "导出的",
  "产出的",
  "这个",
  "那个",
  "这份",
  "那份",
  "对应的",
  "相关的",
  "下一节的",
  "上一节的",
  "本节的",
]);

interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  baseNameLower: string;
  relativeLower: string;
  mtimeMs: number;
  sizeBytes: number;
}

export type RequestedFileKind = "file" | "video" | "audio" | "image" | "document";

export interface FileSendIntent {
  requestedName: string | null;
  requestedKind: RequestedFileKind | null;
  requestedCount: number | null;
  requestAll: boolean;
}

export interface ResolvedFileCandidate {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
}

export interface RecentArtifactFile extends ResolvedFileCandidate {
  mtimeMs: number;
}

export interface RecentArtifactBatch {
  requestId: string;
  workdir: string;
  createdAt: number;
  files: RecentArtifactFile[];
}

export interface WorkspaceFileRecord extends RecentArtifactFile {
  requestedKind: RequestedFileKind | null;
}

export interface ResolveFileRequestResult {
  status: "ok" | "workdir_missing" | "not_found" | "too_large";
  requestedName: string | null;
  requestedKind: RequestedFileKind | null;
  file: ResolvedFileCandidate | null;
  files: ResolvedFileCandidate[];
  skippedTooLarge: ResolvedFileCandidate[];
  maxBytes: number;
  matchedCount: number;
}

export function parseFileSendIntent(text: string): FileSendIntent | null {
  const raw = text.trim();
  if (!raw) {
    return null;
  }
  if (!SEND_VERB_PATTERN.test(raw) || !SEND_TARGET_PATTERN.test(raw) || !FILE_HINT_PATTERN.test(raw)) {
    return null;
  }

  const requestedName = normalizeRequestedName(
    extractQuotedCandidate(raw) ??
    extractByPattern(raw, /(?:把|将)\s*([^，。！？!?\n]{1,180}?)\s*(?:文件|附件|视频|音频|图片|文档)\s*(?:直接|马上|尽快|先)?\s*(?:发送|发)/i) ??
    extractByPattern(raw, /(?:发送|发)\s*([^，。！？!?\n]{1,180}?)\s*(?:文件|附件|视频|音频|图片|文档)/i) ??
    extractLikelyFileToken(raw),
  );
  const requestedKind = detectRequestedKind(raw) ?? inferRequestedKindFromName(requestedName);
  const requestedCount = extractRequestedCount(raw);
  const requestAll = requestedCount === null && detectRequestAll(raw);

  return {
    requestedName,
    requestedKind,
    requestedCount,
    requestAll,
  };
}

export async function resolveRequestedFile(input: {
  workdir: string;
  requestedName: string | null;
  requestedKind?: RequestedFileKind | null;
  requestedCount?: number | null;
  requestAll?: boolean;
  recentArtifactBatches?: RecentArtifactBatch[] | null;
  maxBytes?: number;
}): Promise<ResolveFileRequestResult> {
  const maxBytes = Math.max(1, Math.floor(input.maxBytes ?? DEFAULT_MAX_SEND_BYTES));
  const requestedKind = normalizeRequestedKind(input.requestedKind);
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
      requestedKind,
      file: null,
      files: [],
      skippedTooLarge: [],
      maxBytes,
      matchedCount: 0,
    };
  }

  const normalizedQuery = normalizeRequestedName(input.requestedName);
  const desiredCount = resolveDesiredCount(input.requestedCount, input.requestAll);
  if (normalizedQuery) {
    const direct = await tryResolveDirectFile(root, normalizedQuery);
    if (direct) {
      if (direct.sizeBytes > maxBytes) {
        return {
          status: "too_large",
          requestedName: normalizedQuery,
          requestedKind,
          file: direct,
          files: [],
          skippedTooLarge: [direct],
          maxBytes,
          matchedCount: 1,
        };
      }
      return {
        status: "ok",
        requestedName: normalizedQuery,
        requestedKind,
        file: direct,
        files: [direct],
        skippedTooLarge: [],
        maxBytes,
        matchedCount: 1,
      };
    }
  }

  const recentArtifactResolved = resolveFromRecentArtifactBatches({
    batches: input.recentArtifactBatches ?? [],
    requestedName: normalizedQuery,
    requestedKind,
    desiredCount,
    maxBytes,
  });
  if (recentArtifactResolved) {
    return recentArtifactResolved;
  }

  const files = await scanFiles(root);
  const scopedFiles = filterFilesByRequestedKind(files, requestedKind);
  if (scopedFiles.length === 0) {
    return {
      status: "not_found",
      requestedName: normalizedQuery,
      requestedKind,
      file: null,
      files: [],
      skippedTooLarge: [],
      maxBytes,
      matchedCount: 0,
    };
  }

  const matched = pickBestCandidate(scopedFiles, normalizedQuery);
  if (matched.length === 0) {
    return {
      status: "not_found",
      requestedName: normalizedQuery,
      requestedKind,
      file: null,
      files: [],
      skippedTooLarge: [],
      maxBytes,
      matchedCount: 0,
    };
  }

  return buildResolutionFromMatchedCandidates({
    matched,
    requestedName: normalizedQuery,
    requestedKind,
    desiredCount,
    maxBytes,
  });
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
  normalized = normalized.replace(
    /^(?:生成的|生成好的|刚生成的|刚生成好的|刚刚生成的|刚刚生成好的|最新生成的|最新生成好的|新生成的|最近生成的|当前生成的|输出的|导出的|产出的|最新的|这个|那个|这份|那份|对应的|相关的)\s*/i,
    "",
  );
  normalized = normalized.replace(/^(?:这|那)?(?:[0-9]+|[零〇一二两三四五六七八九十百千]+)(?:个|份|条|段|部)\s*/i, "");
  normalized = normalized.replace(/\s*(?:文件|附件|视频|音频|图片|文档)\s*$/i, "");
  normalized = normalized.trim();
  if (!normalized) {
    return null;
  }
  if (normalized === "文件" || normalized === "附件") {
    return null;
  }
  if (isLikelyDescriptorRequestedName(normalized)) {
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

export async function scanWorkspaceFiles(root: string): Promise<WorkspaceFileRecord[]> {
  const scanned = await scanFiles(path.resolve(root));
  return scanned.map((file) => ({
    absolutePath: file.absolutePath,
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    requestedKind: inferRequestedKindFromPath(file.relativePath),
  }));
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

export function normalizeRelativeFilePath(relativePath: string | null | undefined): string | null {
  if (typeof relativePath !== "string") {
    return null;
  }
  const normalized = normalizeRelativePath(relativePath).trim().replace(/^\.?\//, "");
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    return null;
  }
  if (hasHiddenSegment(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeRequestedKind(value: RequestedFileKind | null | undefined): RequestedFileKind | null {
  if (!value) {
    return null;
  }
  if (value === "file" || value === "video" || value === "audio" || value === "image" || value === "document") {
    return value;
  }
  return null;
}

function detectRequestedKind(text: string): RequestedFileKind | null {
  if (VIDEO_HINT_PATTERN.test(text)) {
    return "video";
  }
  if (AUDIO_HINT_PATTERN.test(text)) {
    return "audio";
  }
  if (IMAGE_HINT_PATTERN.test(text)) {
    return "image";
  }
  if (DOCUMENT_HINT_PATTERN.test(text)) {
    return "document";
  }
  if (FILE_GENERIC_HINT_PATTERN.test(text)) {
    return "file";
  }
  return null;
}

export function inferRequestedKindFromPath(filePath: string): RequestedFileKind | null {
  return inferRequestedKindFromName(path.basename(filePath));
}

function extractRequestedCount(text: string): number | null {
  const match = text.match(COUNTED_FILE_HINT_PATTERN);
  if (!match) {
    return null;
  }
  return parseRequestedCountToken(match[1] ?? null);
}

function detectRequestAll(text: string): boolean {
  return SEND_ALL_PATTERN.test(text);
}

function parseRequestedCountToken(value: string | null | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  if (/^\d+$/.test(normalized)) {
    const count = Number.parseInt(normalized, 10);
    return Number.isFinite(count) && count > 0 ? count : null;
  }
  return parseChineseInteger(normalized);
}

function parseChineseInteger(value: string): number | null {
  const normalized = value.replace(/两/g, "二").replace(/〇/g, "零");
  if (!/^[零一二三四五六七八九十百千]+$/.test(normalized)) {
    return null;
  }

  const digitMap = new Map<string, number>([
    ["零", 0],
    ["一", 1],
    ["二", 2],
    ["三", 3],
    ["四", 4],
    ["五", 5],
    ["六", 6],
    ["七", 7],
    ["八", 8],
    ["九", 9],
  ]);
  const unitMap = new Map<string, number>([
    ["十", 10],
    ["百", 100],
    ["千", 1000],
  ]);

  let total = 0;
  let currentNumber = 0;
  for (const char of normalized) {
    const digit = digitMap.get(char);
    if (digit !== undefined) {
      currentNumber = digit;
      continue;
    }
    const unit = unitMap.get(char);
    if (!unit) {
      return null;
    }
    total += (currentNumber || 1) * unit;
    currentNumber = 0;
  }

  const resolved = total + currentNumber;
  return resolved > 0 ? resolved : null;
}

function inferRequestedKindFromName(name: string | null): RequestedFileKind | null {
  if (!name) {
    return null;
  }
  const ext = path.extname(name).toLowerCase();
  if (!ext) {
    return null;
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    return "document";
  }
  return null;
}

function resolveDesiredCount(requestedCount: number | null | undefined, requestAll: boolean | null | undefined): number {
  if (requestAll) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(requestedCount) || !requestedCount || requestedCount < 1) {
    return 1;
  }
  return Math.floor(requestedCount);
}

function filterFilesByRequestedKind(files: ScannedFile[], requestedKind: RequestedFileKind | null): ScannedFile[] {
  if (!requestedKind || requestedKind === "file") {
    return files;
  }
  return files.filter((file) => matchesRequestedKind(file, requestedKind));
}

function resolveFromRecentArtifactBatches(input: {
  batches: RecentArtifactBatch[];
  requestedName: string | null;
  requestedKind: RequestedFileKind | null;
  desiredCount: number;
  maxBytes: number;
}): ResolveFileRequestResult | null {
  const sortedBatches = [...input.batches]
    .filter((batch) => Array.isArray(batch.files) && batch.files.length > 0)
    .sort((left, right) => right.createdAt - left.createdAt);
  for (const batch of sortedBatches) {
    const scopedFiles = filterFilesByRequestedKind(
      batch.files.map((file) => convertRecentArtifactFileToScannedFile(file)),
      input.requestedKind,
    );
    if (scopedFiles.length === 0) {
      continue;
    }

    const matched = input.requestedName
      ? pickBestCandidate(scopedFiles, input.requestedName)
      : [...scopedFiles].sort((left, right) => right.mtimeMs - left.mtimeMs);
    if (matched.length === 0) {
      continue;
    }

    return buildResolutionFromMatchedCandidates({
      matched,
      requestedName: input.requestedName,
      requestedKind: input.requestedKind,
      desiredCount: input.desiredCount,
      maxBytes: input.maxBytes,
    });
  }

  return null;
}

function convertRecentArtifactFileToScannedFile(file: RecentArtifactFile): ScannedFile {
  const relativePath = normalizeRelativePath(file.relativePath);
  const baseName = path.basename(relativePath);
  return {
    absolutePath: file.absolutePath,
    relativePath,
    baseNameLower: baseName.toLowerCase(),
    relativeLower: relativePath.toLowerCase(),
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes,
  };
}

function buildResolutionFromMatchedCandidates(input: {
  matched: ScannedFile[];
  requestedName: string | null;
  requestedKind: RequestedFileKind | null;
  desiredCount: number;
  maxBytes: number;
}): ResolveFileRequestResult {
  const selectedFiles = input.matched
    .filter((item) => item.sizeBytes <= input.maxBytes)
    .slice(0, input.desiredCount)
    .map((item) => ({
      absolutePath: item.absolutePath,
      relativePath: item.relativePath,
      sizeBytes: item.sizeBytes,
    }));
  const skippedTooLarge = input.matched
    .filter((item) => item.sizeBytes > input.maxBytes)
    .map((item) => ({
      absolutePath: item.absolutePath,
      relativePath: item.relativePath,
      sizeBytes: item.sizeBytes,
    }));

  if (selectedFiles.length === 0) {
    const largestCandidate = skippedTooLarge[0] ?? null;
    return {
      status: "too_large",
      requestedName: input.requestedName,
      requestedKind: input.requestedKind,
      file: largestCandidate,
      files: [],
      skippedTooLarge,
      maxBytes: input.maxBytes,
      matchedCount: input.matched.length,
    };
  }

  return {
    status: "ok",
    requestedName: input.requestedName,
    requestedKind: input.requestedKind,
    file: selectedFiles[0] ?? null,
    files: selectedFiles,
    skippedTooLarge,
    maxBytes: input.maxBytes,
    matchedCount: input.matched.length,
  };
}

function matchesRequestedKind(file: ScannedFile, requestedKind: RequestedFileKind): boolean {
  const extension = path.extname(file.baseNameLower).toLowerCase();
  if (!extension) {
    return false;
  }
  if (requestedKind === "video") {
    return VIDEO_EXTENSIONS.has(extension);
  }
  if (requestedKind === "audio") {
    return AUDIO_EXTENSIONS.has(extension);
  }
  if (requestedKind === "image") {
    return IMAGE_EXTENSIONS.has(extension);
  }
  if (requestedKind === "document") {
    return DOCUMENT_EXTENSIONS.has(extension);
  }
  return true;
}

function isLikelyDescriptorRequestedName(value: string): boolean {
  const compact = value.replace(/\s+/g, "").toLowerCase();
  if (!compact) {
    return true;
  }
  if (GENERIC_REQUESTED_NAME_SET.has(compact)) {
    return true;
  }
  if (/^(?:this|that|latest|newest|generated|output|artifact|file|video|audio|image|document)$/.test(compact)) {
    return true;
  }
  if (/^(?:全部|所有|全都|统统)$/.test(compact)) {
    return true;
  }
  if (/^(?:这|那)?(?:[0-9]+|[零〇一二两三四五六七八九十百千]+)(?:个|份|条|段|部)?$/.test(compact)) {
    return true;
  }
  if (/^(?:第[一二三四五六七八九十0-9]+[章节段部分]?的?)$/.test(compact)) {
    return true;
  }
  if (/^(?:刚|刚刚|最新|最近|当前|本次|这次)?(?:生成|产出|输出|导出)(?:好|完成)?的?$/.test(compact)) {
    return true;
  }
  if (/^[\u4e00-\u9fa5]{1,12}的$/.test(compact)) {
    return /(?:生成|最新|当前|下一|上一|本次|这次|对应|相关|这个|那个)/.test(compact);
  }
  return false;
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
