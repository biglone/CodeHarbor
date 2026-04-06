import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

interface AutoDevTaskLockPayload {
  taskId: string;
  token: string;
  acquiredAt: string;
  acquiredAtMs: number;
  sessionKey: string;
  requestId: string;
  conversationId: string;
  ownerPid: number;
  ownerHostname: string;
}

export interface AutoDevTaskLockHandle {
  filePath: string;
  token: string;
  taskId: string;
}

export interface AcquireAutoDevTaskLockInput {
  workdir: string;
  taskId: string;
  sessionKey: string;
  requestId: string;
  conversationId: string;
  nowMs?: number;
  staleMs?: number;
}

export type AcquireAutoDevTaskLockResult =
  | {
      acquired: true;
      lock: AutoDevTaskLockHandle;
      lockFilePath: string;
      holderSummary: null;
    }
  | {
      acquired: false;
      lockFilePath: string;
      holderSummary: string;
    };

export async function acquireAutoDevTaskLock(
  input: AcquireAutoDevTaskLockInput,
): Promise<AcquireAutoDevTaskLockResult> {
  const lockFilePath = buildAutoDevTaskLockFilePath(input.workdir, input.taskId);
  const nowMs = normalizeNowMs(input.nowMs);
  const staleMs = normalizeStaleMs(input.staleMs);

  await fs.mkdir(path.dirname(lockFilePath), { recursive: true });

  const created = await tryCreateLockFile(lockFilePath, {
    taskId: input.taskId,
    token: randomUUID(),
    acquiredAt: new Date(nowMs).toISOString(),
    acquiredAtMs: nowMs,
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    conversationId: input.conversationId,
    ownerPid: process.pid,
    ownerHostname: os.hostname(),
  });
  if (created.created) {
    return {
      acquired: true,
      lock: {
        filePath: lockFilePath,
        token: created.token,
        taskId: input.taskId,
      },
      lockFilePath,
      holderSummary: null,
    };
  }

  const stale = await isLockFileStale(lockFilePath, nowMs, staleMs);
  if (stale) {
    try {
      await fs.unlink(lockFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const reclaimed = await tryCreateLockFile(lockFilePath, {
      taskId: input.taskId,
      token: randomUUID(),
      acquiredAt: new Date(nowMs).toISOString(),
      acquiredAtMs: nowMs,
      sessionKey: input.sessionKey,
      requestId: input.requestId,
      conversationId: input.conversationId,
      ownerPid: process.pid,
      ownerHostname: os.hostname(),
    });
    if (reclaimed.created) {
      return {
        acquired: true,
        lock: {
          filePath: lockFilePath,
          token: reclaimed.token,
          taskId: input.taskId,
        },
        lockFilePath,
        holderSummary: null,
      };
    }
  }

  const holder = await readLockPayload(lockFilePath);
  return {
    acquired: false,
    lockFilePath,
    holderSummary: formatLockHolderSummary(holder),
  };
}

export async function releaseAutoDevTaskLock(lock: AutoDevTaskLockHandle): Promise<void> {
  const payload = await readLockPayload(lock.filePath);
  if (payload && payload.token !== lock.token) {
    return;
  }
  try {
    await fs.unlink(lock.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function buildAutoDevTaskLockFilePath(workdir: string, taskId: string): string {
  const normalizedId = taskId.trim().toLowerCase();
  const safeFileName = normalizedId.replace(/[^a-z0-9._-]/g, "_") || "task";
  const normalizedWorkdir = path.resolve(workdir).toLowerCase();
  const workdirHash = createHash("sha256").update(normalizedWorkdir).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "codeharbor-autodev-task-locks", workdirHash, `${safeFileName}.lock.json`);
}

async function tryCreateLockFile(
  filePath: string,
  payload: AutoDevTaskLockPayload,
): Promise<{ created: true; token: string } | { created: false }> {
  try {
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { created: true, token: payload.token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { created: false };
    }
    throw error;
  }
}

async function readLockPayload(filePath: string): Promise<AutoDevTaskLockPayload | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AutoDevTaskLockPayload>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (
      typeof parsed.taskId !== "string" ||
      typeof parsed.token !== "string" ||
      typeof parsed.acquiredAt !== "string" ||
      typeof parsed.acquiredAtMs !== "number" ||
      typeof parsed.sessionKey !== "string" ||
      typeof parsed.requestId !== "string" ||
      typeof parsed.conversationId !== "string" ||
      typeof parsed.ownerPid !== "number" ||
      typeof parsed.ownerHostname !== "string"
    ) {
      return null;
    }
    return {
      taskId: parsed.taskId,
      token: parsed.token,
      acquiredAt: parsed.acquiredAt,
      acquiredAtMs: parsed.acquiredAtMs,
      sessionKey: parsed.sessionKey,
      requestId: parsed.requestId,
      conversationId: parsed.conversationId,
      ownerPid: parsed.ownerPid,
      ownerHostname: parsed.ownerHostname,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function isLockFileStale(filePath: string, nowMs: number, staleMs: number): Promise<boolean> {
  const payload = await readLockPayload(filePath);
  if (payload && Number.isFinite(payload.acquiredAtMs)) {
    return nowMs - payload.acquiredAtMs >= staleMs;
  }
  try {
    const stats = await fs.stat(filePath);
    return nowMs - stats.mtimeMs >= staleMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    return false;
  }
}

function formatLockHolderSummary(payload: AutoDevTaskLockPayload | null): string {
  if (!payload) {
    return "unknown holder";
  }
  return [
    `task=${payload.taskId}`,
    `session=${payload.sessionKey}`,
    `requestId=${payload.requestId}`,
    `conversation=${payload.conversationId}`,
    `acquiredAt=${payload.acquiredAt}`,
    `pid=${payload.ownerPid}`,
    `host=${payload.ownerHostname}`,
  ].join(", ");
}

function normalizeNowMs(nowMs?: number): number {
  if (typeof nowMs === "number" && Number.isFinite(nowMs)) {
    return nowMs;
  }
  return Date.now();
}

function normalizeStaleMs(staleMs?: number): number {
  if (typeof staleMs === "number" && Number.isFinite(staleMs) && staleMs > 0) {
    return staleMs;
  }
  return DEFAULT_STALE_MS;
}
