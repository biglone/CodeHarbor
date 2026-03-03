import fs from "node:fs";
import path from "node:path";

import { SessionState, StateData } from "../types";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const SQLITE_MODULE_ID = `node:${"sqlite"}`;

type DatabaseSyncCtor = typeof import("node:sqlite").DatabaseSync;
type DatabaseSyncInstance = import("node:sqlite").DatabaseSync;

function loadDatabaseSync(): DatabaseSyncCtor {
  const sqliteModule = require(SQLITE_MODULE_ID) as { DatabaseSync?: DatabaseSyncCtor };
  if (!sqliteModule.DatabaseSync) {
    throw new Error(`Failed to load ${SQLITE_MODULE_ID} DatabaseSync`);
  }
  return sqliteModule.DatabaseSync;
}

const DatabaseSync = loadDatabaseSync();

export class StateStore {
  private readonly dbPath: string;
  private readonly legacyJsonPath: string | null;
  private readonly maxProcessedEventsPerSession: number;
  private readonly maxSessionAgeMs: number;
  private readonly maxSessions: number;
  private readonly db: DatabaseSyncInstance;
  private lastPruneAt = 0;

  constructor(
    dbPath: string,
    legacyJsonPath: string | null,
    maxProcessedEventsPerSession: number,
    maxSessionAgeDays: number,
    maxSessions: number,
  ) {
    this.dbPath = dbPath;
    this.legacyJsonPath = legacyJsonPath;
    this.maxProcessedEventsPerSession = maxProcessedEventsPerSession;
    this.maxSessionAgeMs = maxSessionAgeDays * ONE_DAY_MS;
    this.maxSessions = maxSessions;

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.initializeSchema();
    this.importLegacyStateIfNeeded();

    if (this.pruneSessions()) {
      this.touchDatabase();
    }
  }

  getCodexSessionId(sessionKey: string): string | null {
    this.maybePruneExpiredSessions();
    const row = this.db
      .prepare("SELECT codex_session_id FROM sessions WHERE session_key = ?1")
      .get(sessionKey) as { codex_session_id: string | null } | undefined;
    return row?.codex_session_id ?? null;
  }

  setCodexSessionId(sessionKey: string, codexSessionId: string): void {
    this.maybePruneExpiredSessions();
    this.ensureSession(sessionKey);
    this.db
      .prepare(
        "UPDATE sessions SET codex_session_id = ?2, updated_at = ?3 WHERE session_key = ?1",
      )
      .run(sessionKey, codexSessionId, Date.now());
  }

  clearCodexSessionId(sessionKey: string): void {
    this.maybePruneExpiredSessions();
    this.ensureSession(sessionKey);
    this.db
      .prepare("UPDATE sessions SET codex_session_id = NULL, updated_at = ?2 WHERE session_key = ?1")
      .run(sessionKey, Date.now());
  }

  isSessionActive(sessionKey: string, now = Date.now()): boolean {
    this.maybePruneExpiredSessions();
    const row = this.db
      .prepare("SELECT active_until FROM sessions WHERE session_key = ?1")
      .get(sessionKey) as { active_until: number | null } | undefined;
    if (!row || row.active_until === null) {
      return false;
    }
    return now <= row.active_until;
  }

  activateSession(sessionKey: string, activeWindowMs: number): void {
    this.maybePruneExpiredSessions();
    this.ensureSession(sessionKey);
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE sessions SET active_until = ?2, updated_at = ?3 WHERE session_key = ?1",
      )
      .run(sessionKey, now + Math.max(0, activeWindowMs), now);
  }

  deactivateSession(sessionKey: string): void {
    this.maybePruneExpiredSessions();
    this.ensureSession(sessionKey);
    this.db
      .prepare("UPDATE sessions SET active_until = NULL, updated_at = ?2 WHERE session_key = ?1")
      .run(sessionKey, Date.now());
  }

  getSessionStatus(sessionKey: string): { hasCodexSession: boolean; activeUntil: string | null; isActive: boolean } {
    this.maybePruneExpiredSessions();
    const row = this.db
      .prepare("SELECT codex_session_id, active_until FROM sessions WHERE session_key = ?1")
      .get(sessionKey) as { codex_session_id: string | null; active_until: number | null } | undefined;
    if (!row) {
      return {
        hasCodexSession: false,
        activeUntil: null,
        isActive: false,
      };
    }

    const activeUntilIso = row.active_until === null ? null : new Date(row.active_until).toISOString();
    return {
      hasCodexSession: Boolean(row.codex_session_id),
      activeUntil: activeUntilIso,
      isActive: row.active_until !== null ? Date.now() <= row.active_until : false,
    };
  }

  hasProcessedEvent(sessionKey: string, eventId: string): boolean {
    this.maybePruneExpiredSessions();
    const row = this.db
      .prepare("SELECT 1 FROM processed_events WHERE session_key = ?1 AND event_id = ?2")
      .get(sessionKey, eventId) as { 1: 1 } | undefined;
    return Boolean(row);
  }

  markEventProcessed(sessionKey: string, eventId: string): void {
    this.maybePruneExpiredSessions();
    this.ensureSession(sessionKey);
    this.insertProcessedEventAndTrim(sessionKey, eventId, Date.now());
  }

  commitExecutionSuccess(sessionKey: string, eventId: string, codexSessionId: string): void {
    this.maybePruneExpiredSessions();
    const now = Date.now();
    this.ensureSession(sessionKey);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE sessions SET codex_session_id = ?2, updated_at = ?3 WHERE session_key = ?1")
        .run(sessionKey, codexSessionId, now);
      this.insertProcessedEventAndTrim(sessionKey, eventId, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  commitExecutionHandled(sessionKey: string, eventId: string): void {
    this.maybePruneExpiredSessions();
    this.ensureSession(sessionKey);
    this.db.exec("BEGIN");
    try {
      this.insertProcessedEventAndTrim(sessionKey, eventId, Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async flush(): Promise<void> {
    this.touchDatabase();
  }

  private insertProcessedEventAndTrim(sessionKey: string, eventId: string, now: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO processed_events (session_key, event_id, created_at) VALUES (?1, ?2, ?3)")
      .run(sessionKey, eventId, now);

    if (this.maxProcessedEventsPerSession > 0) {
      this.db
        .prepare(
          `DELETE FROM processed_events
           WHERE rowid IN (
             SELECT rowid
             FROM processed_events
             WHERE session_key = ?1
             ORDER BY rowid DESC
             LIMIT -1 OFFSET ?2
           )`,
        )
        .run(sessionKey, this.maxProcessedEventsPerSession);
    }

    this.db.prepare("UPDATE sessions SET updated_at = ?2 WHERE session_key = ?1").run(sessionKey, now);
  }

  private ensureSession(sessionKey: string): void {
    this.db
      .prepare(
        "INSERT INTO sessions (session_key, codex_session_id, active_until, updated_at) VALUES (?1, NULL, NULL, ?2) ON CONFLICT(session_key) DO NOTHING",
      )
      .run(sessionKey, Date.now());
  }

  private initializeSchema(): void {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        codex_session_id TEXT,
        active_until INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_events (
        session_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, event_id),
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON processed_events(created_at);
    `);
  }

  private importLegacyStateIfNeeded(): void {
    if (!this.legacyJsonPath || !fs.existsSync(this.legacyJsonPath)) {
      return;
    }

    const countRow = this.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    if ((countRow?.count ?? 0) > 0) {
      return;
    }

    const legacy = loadLegacyState(this.legacyJsonPath);
    if (!legacy) {
      return;
    }

    const insertSession = this.db.prepare(
      "INSERT OR REPLACE INTO sessions (session_key, codex_session_id, active_until, updated_at) VALUES (?1, ?2, ?3, ?4)",
    );
    const insertEvent = this.db.prepare(
      "INSERT OR IGNORE INTO processed_events (session_key, event_id, created_at) VALUES (?1, ?2, ?3)",
    );

    this.db.exec("BEGIN");
    try {
      for (const [sessionKey, session] of Object.entries(legacy.sessions)) {
        const updatedAt = parseUpdatedAt(session.updatedAt);
        const activeUntil = parseOptionalTimestamp(session.activeUntil);
        insertSession.run(sessionKey, session.codexSessionId, activeUntil, updatedAt);

        let eventTs = updatedAt;
        for (const eventId of session.processedEventIds) {
          eventTs += 1;
          insertEvent.run(sessionKey, eventId, eventTs);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private maybePruneExpiredSessions(): void {
    const now = Date.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPruneAt = now;

    if (this.pruneSessions(now)) {
      this.touchDatabase();
    }
  }

  private pruneSessions(now = Date.now()): boolean {
    let changed = false;
    if (this.pruneExpiredSessions(now)) {
      changed = true;
    }
    if (this.pruneExcessSessions()) {
      changed = true;
    }
    return changed;
  }

  private pruneExpiredSessions(now: number): boolean {
    if (this.maxSessionAgeMs <= 0) {
      return false;
    }
    const result = this.db
      .prepare("DELETE FROM sessions WHERE updated_at < ?1")
      .run(now - this.maxSessionAgeMs) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  private pruneExcessSessions(): boolean {
    if (this.maxSessions <= 0) {
      return false;
    }
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number };
    const count = row?.count ?? 0;
    if (count <= this.maxSessions) {
      return false;
    }

    const removeCount = count - this.maxSessions;
    const result = this.db
      .prepare(
        "DELETE FROM sessions WHERE session_key IN (SELECT session_key FROM sessions ORDER BY updated_at ASC LIMIT ?1)",
      )
      .run(removeCount) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  private touchDatabase(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
}

function loadLegacyState(filePath: string): StateData | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as StateData;
    if (!parsed.sessions || typeof parsed.sessions !== "object") {
      return null;
    }
    normalizeLegacyState(parsed);
    return parsed;
  } catch {
    return null;
  }
}

function parseUpdatedAt(updatedAt: string): number {
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function parseOptionalTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function normalizeLegacyState(state: StateData): void {
  for (const session of Object.values(state.sessions)) {
    if (!Array.isArray(session.processedEventIds)) {
      session.processedEventIds = [];
    }
    if (typeof session.codexSessionId !== "string" && session.codexSessionId !== null) {
      session.codexSessionId = null;
    }
    if (typeof session.updatedAt !== "string") {
      session.updatedAt = new Date().toISOString();
    }
    if (typeof session.activeUntil !== "string" && session.activeUntil !== null) {
      session.activeUntil = null;
    }
  }
}
