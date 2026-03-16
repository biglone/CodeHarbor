import fs from "node:fs";
import path from "node:path";

import { StateData } from "../types";

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

export interface RoomSettingsRecord {
  roomId: string;
  enabled: boolean;
  allowMention: boolean;
  allowReply: boolean;
  allowActiveWindow: boolean;
  allowPrefix: boolean;
  workdir: string;
  updatedAt: number;
}

export interface RoomSettingsUpsertInput {
  roomId: string;
  enabled: boolean;
  allowMention: boolean;
  allowReply: boolean;
  allowActiveWindow: boolean;
  allowPrefix: boolean;
  workdir: string;
}

export interface ConfigRevisionRecord {
  id: number;
  actor: string | null;
  summary: string;
  payloadJson: string;
  createdAt: number;
}

export interface SessionMessageRecord {
  id: number;
  sessionKey: string;
  role: "user" | "assistant";
  provider: "codex" | "claude";
  content: string;
  createdAt: number;
}

export interface UpgradeRunRecord {
  id: number;
  requestedBy: string | null;
  targetVersion: string | null;
  status: "running" | "succeeded" | "failed";
  installedVersion: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface UpgradeExecutionLockRecord {
  owner: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface UpgradeRunStats {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  avgDurationMs: number;
}

const MAX_CONVERSATION_MESSAGES_PER_SESSION = 200;

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

  getRoomSettings(roomId: string): RoomSettingsRecord | null {
    const row = this.db
      .prepare(
        "SELECT room_id, enabled, allow_mention, allow_reply, allow_active_window, allow_prefix, workdir, updated_at FROM room_settings WHERE room_id = ?1",
      )
      .get(roomId) as
      | {
          room_id: string;
          enabled: number;
          allow_mention: number;
          allow_reply: number;
          allow_active_window: number;
          allow_prefix: number;
          workdir: string;
          updated_at: number;
        }
      | undefined;
    if (!row) {
      return null;
    }

    return {
      roomId: row.room_id,
      enabled: row.enabled === 1,
      allowMention: row.allow_mention === 1,
      allowReply: row.allow_reply === 1,
      allowActiveWindow: row.allow_active_window === 1,
      allowPrefix: row.allow_prefix === 1,
      workdir: row.workdir,
      updatedAt: row.updated_at,
    };
  }

  listRoomSettings(): RoomSettingsRecord[] {
    const rows = this.db
      .prepare(
        "SELECT room_id, enabled, allow_mention, allow_reply, allow_active_window, allow_prefix, workdir, updated_at FROM room_settings ORDER BY room_id ASC",
      )
      .all() as Array<{
      room_id: string;
      enabled: number;
      allow_mention: number;
      allow_reply: number;
      allow_active_window: number;
      allow_prefix: number;
      workdir: string;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      roomId: row.room_id,
      enabled: row.enabled === 1,
      allowMention: row.allow_mention === 1,
      allowReply: row.allow_reply === 1,
      allowActiveWindow: row.allow_active_window === 1,
      allowPrefix: row.allow_prefix === 1,
      workdir: row.workdir,
      updatedAt: row.updated_at,
    }));
  }

  upsertRoomSettings(input: RoomSettingsUpsertInput): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO room_settings
          (room_id, enabled, allow_mention, allow_reply, allow_active_window, allow_prefix, workdir, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(room_id) DO UPDATE SET
          enabled = excluded.enabled,
          allow_mention = excluded.allow_mention,
          allow_reply = excluded.allow_reply,
          allow_active_window = excluded.allow_active_window,
          allow_prefix = excluded.allow_prefix,
          workdir = excluded.workdir,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.roomId,
        boolToInt(input.enabled),
        boolToInt(input.allowMention),
        boolToInt(input.allowReply),
        boolToInt(input.allowActiveWindow),
        boolToInt(input.allowPrefix),
        input.workdir,
        now,
      );
  }

  deleteRoomSettings(roomId: string): void {
    this.db.prepare("DELETE FROM room_settings WHERE room_id = ?1").run(roomId);
  }

  appendConfigRevision(actor: string | null, summary: string, payloadJson: string): void {
    this.db
      .prepare("INSERT INTO config_revisions (actor, summary, payload_json, created_at) VALUES (?1, ?2, ?3, ?4)")
      .run(actor, summary, payloadJson, Date.now());
  }

  listConfigRevisions(limit = 20): ConfigRevisionRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.db
      .prepare(
        "SELECT id, actor, summary, payload_json, created_at FROM config_revisions ORDER BY id DESC LIMIT ?1",
      )
      .all(safeLimit) as Array<{
      id: number;
      actor: string | null;
      summary: string;
      payload_json: string;
      created_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      summary: row.summary,
      payloadJson: row.payload_json,
      createdAt: row.created_at,
    }));
  }

  createUpgradeRun(input: { requestedBy: string | null; targetVersion: string | null }): number {
    const row = this.db
      .prepare(
        `INSERT INTO upgrade_runs (requested_by, target_version, status, installed_version, error, started_at, finished_at)
         VALUES (?1, ?2, 'running', NULL, NULL, ?3, NULL)
         RETURNING id`,
      )
      .get(input.requestedBy, input.targetVersion, Date.now()) as { id: number } | undefined;
    if (!row || typeof row.id !== "number") {
      throw new Error("Failed to create upgrade run record.");
    }
    return row.id;
  }

  finishUpgradeRun(
    id: number,
    input: { status: "succeeded" | "failed"; installedVersion: string | null; error: string | null },
  ): void {
    this.db
      .prepare(
        "UPDATE upgrade_runs SET status = ?2, installed_version = ?3, error = ?4, finished_at = ?5 WHERE id = ?1",
      )
      .run(id, input.status, input.installedVersion, input.error, Date.now());
  }

  getLatestUpgradeRun(): UpgradeRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, requested_by, target_version, status, installed_version, error, started_at, finished_at
         FROM upgrade_runs
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get() as
      | {
          id: number;
          requested_by: string | null;
          target_version: string | null;
          status: "running" | "succeeded" | "failed";
          installed_version: string | null;
          error: string | null;
          started_at: number;
          finished_at: number | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      requestedBy: row.requested_by,
      targetVersion: row.target_version,
      status: row.status,
      installedVersion: row.installed_version,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  listRecentUpgradeRuns(limit = 5): UpgradeRunRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.db
      .prepare(
        `SELECT id, requested_by, target_version, status, installed_version, error, started_at, finished_at
         FROM upgrade_runs
         ORDER BY id DESC
         LIMIT ?1`,
      )
      .all(safeLimit) as Array<{
      id: number;
      requested_by: string | null;
      target_version: string | null;
      status: "running" | "succeeded" | "failed";
      installed_version: string | null;
      error: string | null;
      started_at: number;
      finished_at: number | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      requestedBy: row.requested_by,
      targetVersion: row.target_version,
      status: row.status,
      installedVersion: row.installed_version,
      error: row.error,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
  }

  acquireUpgradeExecutionLock(input: {
    owner: string;
    ttlMs: number;
  }): { acquired: boolean; owner: string | null; expiresAt: number | null } {
    const owner = input.owner.trim();
    if (!owner) {
      throw new Error("upgrade lock owner is required.");
    }
    const now = Date.now();
    const ttlMs = Math.max(1_000, Math.floor(input.ttlMs));
    const expiresAt = now + ttlMs;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT owner, expires_at FROM upgrade_locks WHERE name = 'global_upgrade'")
        .get() as { owner: string; expires_at: number } | undefined;
      if (!existing || existing.expires_at <= now) {
        this.db
          .prepare(
            `INSERT INTO upgrade_locks (name, owner, acquired_at, expires_at)
             VALUES ('global_upgrade', ?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
          )
          .run(owner, now, expiresAt);
        this.db.exec("COMMIT");
        return {
          acquired: true,
          owner,
          expiresAt,
        };
      }
      this.db.exec("COMMIT");
      return {
        acquired: false,
        owner: existing.owner,
        expiresAt: existing.expires_at,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  releaseUpgradeExecutionLock(owner: string): void {
    const normalized = owner.trim();
    if (!normalized) {
      return;
    }
    this.db
      .prepare("DELETE FROM upgrade_locks WHERE name = 'global_upgrade' AND owner = ?1")
      .run(normalized);
  }

  getUpgradeExecutionLock(now = Date.now()): UpgradeExecutionLockRecord | null {
    const row = this.db
      .prepare("SELECT owner, acquired_at, expires_at FROM upgrade_locks WHERE name = 'global_upgrade'")
      .get() as { owner: string; acquired_at: number; expires_at: number } | undefined;
    if (!row) {
      return null;
    }
    if (row.expires_at <= now) {
      this.db
        .prepare("DELETE FROM upgrade_locks WHERE name = 'global_upgrade' AND expires_at <= ?1")
        .run(now);
      return null;
    }
    return {
      owner: row.owner,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
    };
  }

  getUpgradeRunStats(): UpgradeRunStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           AVG(CASE WHEN finished_at IS NOT NULL THEN finished_at - started_at END) AS avg_duration_ms
         FROM upgrade_runs`,
      )
      .get() as
      | {
          total: number;
          succeeded: number | null;
          failed: number | null;
          running: number | null;
          avg_duration_ms: number | null;
        }
      | undefined;
    if (!row) {
      return {
        total: 0,
        succeeded: 0,
        failed: 0,
        running: 0,
        avgDurationMs: 0,
      };
    }
    return {
      total: Number(row.total ?? 0),
      succeeded: Number(row.succeeded ?? 0),
      failed: Number(row.failed ?? 0),
      running: Number(row.running ?? 0),
      avgDurationMs: Math.round(Number(row.avg_duration_ms ?? 0)),
    };
  }

  appendConversationMessage(
    sessionKey: string,
    role: "user" | "assistant",
    provider: "codex" | "claude",
    content: string,
  ): void {
    const normalized = content.trim();
    if (!normalized) {
      return;
    }
    const now = Date.now();
    this.ensureSession(sessionKey);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO session_messages (session_key, role, provider, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .run(sessionKey, role, provider, normalized, now);
      this.db.prepare("UPDATE sessions SET updated_at = ?2 WHERE session_key = ?1").run(sessionKey, now);
      this.db
        .prepare(
          `DELETE FROM session_messages
           WHERE id IN (
             SELECT id
             FROM session_messages
             WHERE session_key = ?1
             ORDER BY id DESC
             LIMIT -1 OFFSET ?2
           )`,
        )
        .run(sessionKey, MAX_CONVERSATION_MESSAGES_PER_SESSION);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listRecentConversationMessages(sessionKey: string, limit = 20): SessionMessageRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.db
      .prepare(
        `SELECT id, session_key, role, provider, content, created_at
         FROM session_messages
         WHERE session_key = ?1
         ORDER BY id DESC
         LIMIT ?2`,
      )
      .all(sessionKey, safeLimit) as Array<{
      id: number;
      session_key: string;
      role: "user" | "assistant";
      provider: "codex" | "claude";
      content: string;
      created_at: number;
    }>;
    rows.reverse();
    return rows.map((row) => ({
      id: row.id,
      sessionKey: row.session_key,
      role: row.role,
      provider: row.provider,
      content: row.content,
      createdAt: row.created_at,
    }));
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

      CREATE TABLE IF NOT EXISTS room_settings (
        room_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        allow_mention INTEGER NOT NULL DEFAULT 1,
        allow_reply INTEGER NOT NULL DEFAULT 1,
        allow_active_window INTEGER NOT NULL DEFAULT 1,
        allow_prefix INTEGER NOT NULL DEFAULT 1,
        workdir TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_config_revisions_created_at ON config_revisions(created_at);

      CREATE TABLE IF NOT EXISTS upgrade_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requested_by TEXT,
        target_version TEXT,
        status TEXT NOT NULL,
        installed_version TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_upgrade_runs_started_at ON upgrade_runs(started_at);

      CREATE TABLE IF NOT EXISTS upgrade_locks (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_key, id);
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

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}
