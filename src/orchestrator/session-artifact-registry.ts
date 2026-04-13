import path from "node:path";

import {
  inferRequestedKindFromPath,
  scanWorkspaceFiles,
  type RecentArtifactBatch,
  type WorkspaceFileRecord,
} from "./file-send-intent";

export type { RecentArtifactBatch } from "./file-send-intent";

const MAX_BATCHES_PER_SESSION = 8;
const MAX_ARTIFACTS_PER_BATCH = 24;

export interface WorkspaceArtifactSnapshot {
  workdir: string;
  files: WorkspaceFileRecord[];
  scannedAt: number;
}

export async function captureWorkspaceArtifactSnapshot(workdir: string): Promise<WorkspaceArtifactSnapshot | null> {
  try {
    const files = await scanWorkspaceFiles(workdir);
    return {
      workdir: path.resolve(workdir),
      files,
      scannedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export function buildArtifactBatchFromSnapshots(input: {
  requestId: string;
  workdir: string;
  before: WorkspaceArtifactSnapshot | null;
  after: WorkspaceArtifactSnapshot | null;
  replyText?: string | null;
}): RecentArtifactBatch | null {
  const afterSnapshot = input.after;
  if (!afterSnapshot || afterSnapshot.files.length === 0) {
    return null;
  }

  const beforeMap = new Map<string, WorkspaceFileRecord>();
  for (const file of input.before?.files ?? []) {
    beforeMap.set(file.relativePath, file);
  }

  const replyHints = collectReplyFileHints(input.replyText ?? "");
  const changedFiles = afterSnapshot.files
    .filter((file) => {
      const previous = beforeMap.get(file.relativePath);
      if (!previous) {
        return true;
      }
      return previous.sizeBytes !== file.sizeBytes || previous.mtimeMs !== file.mtimeMs;
    })
    .sort((left, right) => {
      const scoreDelta = scoreArtifactHint(right, replyHints) - scoreArtifactHint(left, replyHints);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      if (right.mtimeMs !== left.mtimeMs) {
        return right.mtimeMs - left.mtimeMs;
      }
      return left.relativePath.localeCompare(right.relativePath);
    })
    .slice(0, MAX_ARTIFACTS_PER_BATCH)
    .map((file) => ({
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
    }));

  if (changedFiles.length === 0) {
    return null;
  }

  return {
    requestId: input.requestId,
    workdir: path.resolve(input.workdir),
    createdAt: Date.now(),
    files: changedFiles,
  };
}

export function recordSessionArtifactBatch(
  registry: Map<string, RecentArtifactBatch[]>,
  sessionKey: string,
  batch: RecentArtifactBatch | null,
): void {
  if (!batch || batch.files.length === 0) {
    return;
  }

  const existing = registry.get(sessionKey) ?? [];
  const next = [batch, ...existing.filter((item) => item.requestId !== batch.requestId)].slice(0, MAX_BATCHES_PER_SESSION);
  registry.set(sessionKey, next);
}

export function listRecentSessionArtifactBatches(
  registry: Map<string, RecentArtifactBatch[]>,
  sessionKey: string,
  workdir: string,
): RecentArtifactBatch[] {
  const resolvedWorkdir = path.resolve(workdir);
  return (registry.get(sessionKey) ?? []).filter((batch) => batch.workdir === resolvedWorkdir);
}

function collectReplyFileHints(text: string): Set<string> {
  const hints = new Set<string>();
  if (!text.trim()) {
    return hints;
  }

  const matches = text.matchAll(/([A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12})/g);
  for (const match of matches) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }
    const normalizedPath = raw.replace(/\\/g, "/").toLowerCase();
    const baseName = path.basename(normalizedPath);
    hints.add(normalizedPath);
    hints.add(baseName);
  }

  return hints;
}

function scoreArtifactHint(file: WorkspaceFileRecord, replyHints: Set<string>): number {
  if (replyHints.size === 0) {
    return 0;
  }
  const relativeLower = file.relativePath.toLowerCase();
  const baseNameLower = path.basename(relativeLower);
  let score = 0;
  if (replyHints.has(relativeLower)) {
    score += 200;
  }
  if (replyHints.has(baseNameLower)) {
    score += 120;
  }
  const requestedKind = inferRequestedKindFromPath(file.relativePath);
  if (requestedKind === "video" || requestedKind === "audio" || requestedKind === "image" || requestedKind === "document") {
    score += 10;
  }
  return score;
}
