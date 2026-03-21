interface SessionLockEntryLike {
  lastUsedAt: number;
  mutex: { isLocked: () => boolean };
}

export function pruneSessionLocks(
  sessionLocks: Map<string, SessionLockEntryLike>,
  now: number,
  lockTtlMs: number,
): void {
  const expireBefore = now - lockTtlMs;
  for (const [sessionKey, entry] of sessionLocks.entries()) {
    if (entry.lastUsedAt >= expireBefore) {
      continue;
    }
    if (entry.mutex.isLocked()) {
      continue;
    }
    sessionLocks.delete(sessionKey);
  }
}
