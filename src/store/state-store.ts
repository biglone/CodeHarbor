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

export interface RuntimeMetricsSnapshotRecord {
  key: string;
  payloadJson: string;
  updatedAt: number;
}

export interface RuntimeConfigSnapshotRecord {
  key: string;
  version: number;
  payloadJson: string;
  updatedAt: number;
}

export type TaskQueueStatus = "pending" | "running" | "succeeded" | "failed";

export interface TaskQueueRecord {
  id: number;
  sessionKey: string;
  eventId: string;
  requestId: string;
  payloadJson: string;
  status: TaskQueueStatus;
  attempt: number;
  enqueuedAt: number;
  nextRetryAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  lastError: string | null;
}

export interface TaskQueueEnqueueInput {
  sessionKey: string;
  eventId: string;
  requestId: string;
  payloadJson: string;
}

export interface TaskQueueEnqueueResult {
  created: boolean;
  task: TaskQueueRecord;
}

export interface TaskQueueRecoveryResult {
  requeuedRunning: number;
  pendingTotal: number;
  readyTotal: number;
  hasMorePending: boolean;
  tasks: TaskQueueRecord[];
}

export interface TaskQueuePruneResult {
  deletedSucceeded: number;
  deletedFailed: number;
}

export interface TaskQueuePendingSessionRecord {
  sessionKey: string;
  firstTaskId: number;
}

export interface TaskQueueStatusCounts {
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
}

export interface TaskQueueScheduleRetryInput {
  nextRetryAt: number;
  error: string;
}

export interface TaskFailureArchiveInput {
  error: string;
  retryReason: string;
  archiveReason: string;
  retryAfterMs: number | null;
}

export interface TaskFailureArchiveRecord {
  id: number;
  taskId: number;
  sessionKey: string;
  eventId: string;
  requestId: string;
  payloadJson: string;
  attempt: number;
  error: string;
  lastError: string | null;
  retryReason: string;
  archiveReason: string;
  retryAfterMs: number | null;
  enqueuedAt: number;
  failedAt: number;
}

export interface TaskQueueCancelResult {
  cancelledPending: number;
}

const MAX_CONVERSATION_MESSAGES_PER_SESSION = 200;
const MAX_TASK_FAILURE_ARCHIVE_ROWS = 1_000;

export class StateStore {
  private readonly dbPath: string;
  private readonly legacyJsonPath: string | null;
  private readonly maxProcessedEventsPerSession: number;
  private readonly maxSessionAgeMs: number;
  private readonly maxSessions: number;
  private readonly maxTaskFailureArchiveRows: number;
  private readonly db: DatabaseSyncInstance;
  private lastPruneAt = 0;

  constructor(
    dbPath: string,
    legacyJsonPath: string | null,
    maxProcessedEventsPerSession: number,
    maxSessionAgeDays: number,
    maxSessions: number,
    maxTaskFailureArchiveRows = MAX_TASK_FAILURE_ARCHIVE_ROWS,
  ) {
    this.dbPath = dbPath;
    this.legacyJsonPath = legacyJsonPath;
    this.maxProcessedEventsPerSession = maxProcessedEventsPerSession;
    this.maxSessionAgeMs = maxSessionAgeDays * ONE_DAY_MS;
    this.maxSessions = maxSessions;
    this.maxTaskFailureArchiveRows = Math.max(0, Math.floor(maxTaskFailureArchiveRows));

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.initializeSchema();
    this.migrateTaskQueueSchema();
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

  upsertRuntimeMetricsSnapshot(key: string, payloadJson: string): void {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error("runtime metrics key is required.");
    }
    this.db
      .prepare(
        `INSERT INTO runtime_metrics_snapshots (key, payload_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(normalizedKey, payloadJson, Date.now());
  }

  getRuntimeMetricsSnapshot(key: string): RuntimeMetricsSnapshotRecord | null {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return null;
    }
    const row = this.db
      .prepare("SELECT key, payload_json, updated_at FROM runtime_metrics_snapshots WHERE key = ?1")
      .get(normalizedKey) as
      | {
          key: string;
          payload_json: string;
          updated_at: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      key: row.key,
      payloadJson: row.payload_json,
      updatedAt: row.updated_at,
    };
  }

  upsertRuntimeConfigSnapshot(key: string, payloadJson: string): RuntimeConfigSnapshotRecord {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new Error("runtime config key is required.");
    }
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT version FROM runtime_config_snapshots WHERE key = ?1")
        .get(normalizedKey) as { version: number } | undefined;
      const version = (existing?.version ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO runtime_config_snapshots (key, version, payload_json, updated_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(key) DO UPDATE SET
             version = excluded.version,
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at`,
        )
        .run(normalizedKey, version, payloadJson, now);
      this.db.exec("COMMIT");
      return {
        key: normalizedKey,
        version,
        payloadJson,
        updatedAt: now,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRuntimeConfigSnapshot(key: string): RuntimeConfigSnapshotRecord | null {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return null;
    }
    const row = this.db
      .prepare("SELECT key, version, payload_json, updated_at FROM runtime_config_snapshots WHERE key = ?1")
      .get(normalizedKey) as
      | {
          key: string;
          version: number;
          payload_json: string;
          updated_at: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      key: row.key,
      version: row.version,
      payloadJson: row.payload_json,
      updatedAt: row.updated_at,
    };
  }

  enqueueTask(input: TaskQueueEnqueueInput): TaskQueueEnqueueResult {
    this.ensureSession(input.sessionKey);
    const result = this.db
      .prepare(
        `INSERT INTO task_queue
          (session_key, event_id, request_id, payload_json, status, attempt, enqueued_at, next_retry_at, started_at, finished_at, error, last_error)
         VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, NULL, NULL, NULL, NULL, NULL)
         ON CONFLICT(session_key, event_id) DO NOTHING`,
      )
      .run(input.sessionKey, input.eventId, input.requestId, input.payloadJson, Date.now()) as { changes?: number };
    const task = this.getTaskBySessionEvent(input.sessionKey, input.eventId);
    if (!task) {
      throw new Error("Failed to load queued task after enqueue.");
    }
    return {
      created: (result.changes ?? 0) > 0,
      task,
    };
  }

  claimReadyTask(sessionKey: string, now = Date.now()): TaskQueueRecord | null {
    const safeNow = Math.max(0, Math.floor(now));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT id, session_key, event_id, request_id, payload_json, status, attempt, enqueued_at, next_retry_at, started_at, finished_at, error, last_error
           FROM task_queue
           WHERE session_key = ?1
             AND status = 'pending'
             AND (next_retry_at IS NULL OR next_retry_at <= ?2)
           ORDER BY id ASC
           LIMIT 1`,
        )
        .get(sessionKey, safeNow) as TaskQueueRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }

      const startedAt = Date.now();
      const update = this.db
        .prepare(
          "UPDATE task_queue SET status = 'running', attempt = attempt + 1, next_retry_at = NULL, started_at = ?2, finished_at = NULL, error = NULL WHERE id = ?1 AND status = 'pending'",
        )
        .run(row.id, startedAt) as { changes?: number };
      if ((update.changes ?? 0) === 0) {
        this.db.exec("COMMIT");
        return null;
      }

      row.status = "running";
      row.attempt += 1;
      row.next_retry_at = null;
      row.started_at = startedAt;
      row.finished_at = null;
      row.error = null;
      this.db.exec("COMMIT");
      return mapTaskQueueRow(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimNextTask(sessionKey: string): TaskQueueRecord | null {
    return this.claimReadyTask(sessionKey);
  }

  finishTask(taskId: number): void {
    this.db
      .prepare(
        "UPDATE task_queue SET status = 'succeeded', next_retry_at = NULL, finished_at = ?2, error = NULL, last_error = NULL WHERE id = ?1",
      )
      .run(taskId, Date.now());
  }

  failTask(taskId: number, error: string): void {
    const normalized = error.trim() || "unknown error";
    this.db
      .prepare(
        "UPDATE task_queue SET status = 'failed', next_retry_at = NULL, finished_at = ?2, error = ?3, last_error = ?3 WHERE id = ?1",
      )
      .run(taskId, Date.now(), normalized.slice(0, 2_000));
  }

  scheduleRetry(taskId: number, input: TaskQueueScheduleRetryInput): void {
    const normalized = input.error.trim() || "unknown error";
    const nextRetryAt = Math.max(Date.now(), Math.floor(input.nextRetryAt));
    this.db
      .prepare(
        "UPDATE task_queue SET status = 'pending', next_retry_at = ?2, started_at = NULL, finished_at = NULL, error = NULL, last_error = ?3 WHERE id = ?1",
      )
      .run(taskId, nextRetryAt, normalized.slice(0, 2_000));
  }

  failAndArchive(taskId: number, input: TaskFailureArchiveInput | string): void {
    const archiveInput = normalizeTaskFailureArchiveInput(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare(
          `SELECT id, session_key, event_id, request_id, payload_json, status, attempt, enqueued_at, next_retry_at, started_at, finished_at, error, last_error
           FROM task_queue
           WHERE id = ?1
           LIMIT 1`,
        )
        .get(taskId) as TaskQueueRow | undefined;
      if (!existing) {
        this.db.exec("COMMIT");
        return;
      }

      const failedAt = Date.now();
      const archivedError = archiveInput.error.slice(0, 2_000);
      const lastError = existing.last_error ? existing.last_error.slice(0, 2_000) : null;
      const retryReason = archiveInput.retryReason.slice(0, 120);
      const archiveReason = archiveInput.archiveReason.slice(0, 120);
      const retryAfterMs = archiveInput.retryAfterMs;

      this.db
        .prepare(
          "UPDATE task_queue SET status = 'failed', next_retry_at = NULL, finished_at = ?2, error = ?3, last_error = ?3 WHERE id = ?1",
        )
        .run(taskId, failedAt, archivedError);

      this.db
        .prepare(
          `INSERT INTO task_failure_archive
            (task_id, session_key, event_id, request_id, payload_json, attempt, error, last_error, retry_reason, archive_reason, retry_after_ms, enqueued_at, failed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .run(
          existing.id,
          existing.session_key,
          existing.event_id,
          existing.request_id,
          existing.payload_json,
          existing.attempt,
          archivedError,
          lastError,
          retryReason,
          archiveReason,
          retryAfterMs,
          existing.enqueued_at,
          failedAt,
        );
      this.pruneTaskFailureArchiveUnsafe();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recoverTasks(limit = 100, now = Date.now()): TaskQueueRecoveryResult {
    const safeLimit = Math.max(1, Math.floor(limit));
    const safeNow = Math.max(0, Math.floor(now));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const requeued = this.db
        .prepare(
          "UPDATE task_queue SET status = 'pending', next_retry_at = NULL, started_at = NULL, finished_at = NULL, error = NULL WHERE status = 'running'",
        )
        .run() as { changes?: number };
      const pendingRow = this.db
        .prepare("SELECT COUNT(*) AS count FROM task_queue WHERE status = 'pending'")
        .get() as { count: number } | undefined;
      const pendingTotal = Number(pendingRow?.count ?? 0);
      const readyRow = this.db
        .prepare("SELECT COUNT(*) AS count FROM task_queue WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?1)")
        .get(safeNow) as { count: number } | undefined;
      const readyTotal = Number(readyRow?.count ?? 0);
      const rows = this.db
        .prepare(
          `SELECT id, session_key, event_id, request_id, payload_json, status, attempt, enqueued_at, next_retry_at, started_at, finished_at, error, last_error
           FROM task_queue
           WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?2)
           ORDER BY id ASC
           LIMIT ?1`,
        )
        .all(safeLimit, safeNow) as TaskQueueRow[];
      this.db.exec("COMMIT");
      return {
        requeuedRunning: Number(requeued.changes ?? 0),
        pendingTotal,
        readyTotal,
        hasMorePending: pendingTotal > rows.length,
        tasks: rows.map((row) => mapTaskQueueRow(row)),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getTaskById(taskId: number): TaskQueueRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, session_key, event_id, request_id, payload_json, status, attempt, enqueued_at, next_retry_at, started_at, finished_at, error, last_error
         FROM task_queue
         WHERE id = ?1
         LIMIT 1`,
      )
      .get(taskId) as TaskQueueRow | undefined;
    if (!row) {
      return null;
    }
    return mapTaskQueueRow(row);
  }

  hasPendingTask(sessionKey: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM task_queue WHERE session_key = ?1 AND status = 'pending' LIMIT 1")
      .get(sessionKey) as { 1: 1 } | undefined;
    return Boolean(row);
  }

  hasReadyTask(sessionKey: string, now = Date.now()): boolean {
    const safeNow = Math.max(0, Math.floor(now));
    const row = this.db
      .prepare(
        "SELECT 1 FROM task_queue WHERE session_key = ?1 AND status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?2) LIMIT 1",
      )
      .get(sessionKey, safeNow) as { 1: 1 } | undefined;
    return Boolean(row);
  }

  getNextPendingRetryAt(sessionKey: string, now = Date.now()): number | null {
    const safeNow = Math.max(0, Math.floor(now));
    const row = this.db
      .prepare(
        "SELECT MIN(next_retry_at) AS next_retry_at FROM task_queue WHERE session_key = ?1 AND status = 'pending' AND next_retry_at > ?2",
      )
      .get(sessionKey, safeNow) as { next_retry_at: number | null } | undefined;
    if (!row || row.next_retry_at === null) {
      return null;
    }
    return row.next_retry_at;
  }

  clearPendingTasks(sessionKey: string, error = "cancelled by stop command"): TaskQueueCancelResult {
    const normalized = error.trim() || "cancelled";
    const result = this.db
      .prepare(
        "UPDATE task_queue SET status = 'failed', next_retry_at = NULL, finished_at = ?2, error = ?3, last_error = ?3 WHERE session_key = ?1 AND status = 'pending'",
      )
      .run(sessionKey, Date.now(), normalized.slice(0, 2_000)) as { changes?: number };
    return {
      cancelledPending: Number(result.changes ?? 0),
    };
  }

  listPendingTaskSessions(limit = 200, afterTaskId = 0): TaskQueuePendingSessionRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const safeAfterTaskId = Math.max(0, Math.floor(afterTaskId));
    const rows = this.db
      .prepare(
        `SELECT session_key, MIN(id) AS first_task_id
         FROM task_queue
         WHERE status = 'pending' AND id > ?1
         GROUP BY session_key
         ORDER BY first_task_id ASC
         LIMIT ?2`,
      )
      .all(safeAfterTaskId, safeLimit) as Array<{ session_key: string; first_task_id: number }>;
    return rows.map((row) => ({
      sessionKey: row.session_key,
      firstTaskId: row.first_task_id,
    }));
  }

  listTasks(limit = 100, status?: TaskQueueStatus): TaskQueueRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = status
      ? (this.db
          .prepare(
            `SELECT id, session_key, event_id, request_id, payload_json, status, attempt, enqueued_at, next_retry_at, started_at, finished_at, error, last_error
             FROM task_queue
             WHERE status = ?1
             ORDER BY id ASC
             LIMIT ?2`,
          )
          .all(status, safeLimit) as TaskQueueRow[])
      : (this.db
          .prepare(
            `SELECT id, session_key, event_id, request_id, payload_json, status, attempt, enqueued_at, next_retry_at, started_at, finished_at, error, last_error
             FROM task_queue
             ORDER BY id ASC
             LIMIT ?1`,
          )
          .all(safeLimit) as TaskQueueRow[]);
    return rows.map((row) => mapTaskQueueRow(row));
  }

  getTaskQueueStatusCounts(): TaskQueueStatusCounts {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM task_queue`,
      )
      .get() as
      | {
          pending: number | null;
          running: number | null;
          succeeded: number | null;
          failed: number | null;
        }
      | undefined;
    return {
      pending: Number(row?.pending ?? 0),
      running: Number(row?.running ?? 0),
      succeeded: Number(row?.succeeded ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }

  pruneTaskQueue(keepSucceeded = 1_000, keepFailed = 1_000): TaskQueuePruneResult {
    const safeKeepSucceeded = Math.max(0, Math.floor(keepSucceeded));
    const safeKeepFailed = Math.max(0, Math.floor(keepFailed));
    const succeeded = this.db
      .prepare(
        `DELETE FROM task_queue
         WHERE id IN (
           SELECT id
           FROM task_queue
           WHERE status = 'succeeded'
           ORDER BY id DESC
           LIMIT -1 OFFSET ?1
         )`,
      )
      .run(safeKeepSucceeded) as { changes?: number };
    const failed = this.db
      .prepare(
        `DELETE FROM task_queue
         WHERE id IN (
           SELECT id
           FROM task_queue
           WHERE status = 'failed'
           ORDER BY id DESC
           LIMIT -1 OFFSET ?1
         )`,
      )
      .run(safeKeepFailed) as { changes?: number };
    return {
      deletedSucceeded: Number(succeeded.changes ?? 0),
      deletedFailed: Number(failed.changes ?? 0),
    };
  }

  listTaskFailureArchive(limit = 100): TaskFailureArchiveRecord[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.db
      .prepare(
        `SELECT id, task_id, session_key, event_id, request_id, payload_json, attempt, error, last_error, retry_reason, archive_reason, retry_after_ms, enqueued_at, failed_at
         FROM task_failure_archive
         ORDER BY id DESC
         LIMIT ?1`,
      )
      .all(safeLimit) as Array<{
      id: number;
      task_id: number;
      session_key: string;
      event_id: string;
      request_id: string;
      payload_json: string;
      attempt: number;
      error: string;
      last_error: string | null;
      retry_reason: string;
      archive_reason: string;
      retry_after_ms: number | null;
      enqueued_at: number;
      failed_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      sessionKey: row.session_key,
      eventId: row.event_id,
      requestId: row.request_id,
      payloadJson: row.payload_json,
      attempt: row.attempt,
      error: row.error,
      lastError: row.last_error,
      retryReason: row.retry_reason,
      archiveReason: row.archive_reason,
      retryAfterMs: row.retry_after_ms,
      enqueuedAt: row.enqueued_at,
      failedAt: row.failed_at,
    }));
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

  private pruneTaskFailureArchiveUnsafe(): void {
    if (this.maxTaskFailureArchiveRows < 0) {
      return;
    }
    this.db
      .prepare(
        `DELETE FROM task_failure_archive
         WHERE id IN (
           SELECT id
           FROM task_failure_archive
           ORDER BY id DESC
           LIMIT -1 OFFSET ?1
         )`,
      )
      .run(this.maxTaskFailureArchiveRows);
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

  private getTaskBySessionEvent(sessionKey: string, eventId: string): TaskQueueRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, session_key, event_id, request_id, payload_json, status, attempt, enqueued_at, next_retry_at, started_at, finished_at, error, last_error
         FROM task_queue
         WHERE session_key = ?1 AND event_id = ?2
         LIMIT 1`,
      )
      .get(sessionKey, eventId) as TaskQueueRow | undefined;
    if (!row) {
      return null;
    }
    return mapTaskQueueRow(row);
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

      CREATE TABLE IF NOT EXISTS task_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
        attempt INTEGER NOT NULL DEFAULT 0,
        enqueued_at INTEGER NOT NULL,
        next_retry_at INTEGER,
        started_at INTEGER,
        finished_at INTEGER,
        error TEXT,
        last_error TEXT,
        UNIQUE(session_key, event_id),
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_task_queue_status_id ON task_queue(status, id);
      CREATE INDEX IF NOT EXISTS idx_task_queue_session_status_id ON task_queue(session_key, status, id);
      CREATE INDEX IF NOT EXISTS idx_task_queue_status_retry_id ON task_queue(status, next_retry_at, id);
      CREATE INDEX IF NOT EXISTS idx_task_queue_session_status_retry_id ON task_queue(session_key, status, next_retry_at, id);

      CREATE TABLE IF NOT EXISTS task_failure_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        session_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        error TEXT NOT NULL,
        last_error TEXT,
        retry_reason TEXT NOT NULL DEFAULT 'unknown_error',
        archive_reason TEXT NOT NULL DEFAULT 'non_retryable_error',
        retry_after_ms INTEGER,
        enqueued_at INTEGER NOT NULL,
        failed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_failure_archive_failed_at ON task_failure_archive(failed_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_task_failure_archive_task_id ON task_failure_archive(task_id);

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

      CREATE TABLE IF NOT EXISTS runtime_metrics_snapshots (
        key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_config_snapshots (
        key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private migrateTaskQueueSchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(task_queue)").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!columnNames.has("attempt")) {
        this.db.exec("ALTER TABLE task_queue ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
      }
      if (!columnNames.has("next_retry_at")) {
        this.db.exec("ALTER TABLE task_queue ADD COLUMN next_retry_at INTEGER");
      }
      if (!columnNames.has("last_error")) {
        this.db.exec("ALTER TABLE task_queue ADD COLUMN last_error TEXT");
      }

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_task_queue_status_retry_id ON task_queue(status, next_retry_at, id);
        CREATE INDEX IF NOT EXISTS idx_task_queue_session_status_retry_id ON task_queue(session_key, status, next_retry_at, id);

        CREATE TABLE IF NOT EXISTS task_failure_archive (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          session_key TEXT NOT NULL,
          event_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          error TEXT NOT NULL,
          last_error TEXT,
          retry_reason TEXT NOT NULL DEFAULT 'unknown_error',
          archive_reason TEXT NOT NULL DEFAULT 'non_retryable_error',
          retry_after_ms INTEGER,
          enqueued_at INTEGER NOT NULL,
          failed_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_task_failure_archive_failed_at ON task_failure_archive(failed_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_task_failure_archive_task_id ON task_failure_archive(task_id);
      `);
      const archiveColumns = this.db.prepare("PRAGMA table_info(task_failure_archive)").all() as Array<{ name: string }>;
      const archiveColumnNames = new Set(archiveColumns.map((column) => column.name));
      if (!archiveColumnNames.has("retry_reason")) {
        this.db.exec("ALTER TABLE task_failure_archive ADD COLUMN retry_reason TEXT NOT NULL DEFAULT 'unknown_error'");
      }
      if (!archiveColumnNames.has("archive_reason")) {
        this.db.exec(
          "ALTER TABLE task_failure_archive ADD COLUMN archive_reason TEXT NOT NULL DEFAULT 'non_retryable_error'",
        );
      }
      if (!archiveColumnNames.has("retry_after_ms")) {
        this.db.exec("ALTER TABLE task_failure_archive ADD COLUMN retry_after_ms INTEGER");
      }

      this.db.exec(`
        UPDATE task_queue
        SET attempt = 1
        WHERE status != 'pending' AND attempt < 1;
      `);
      this.db.exec(`
        UPDATE task_queue
        SET attempt = 0
        WHERE status = 'pending' AND attempt < 0;
      `);
      this.db.exec(`
        UPDATE task_queue
        SET last_error = error
        WHERE last_error IS NULL AND error IS NOT NULL;
      `);
      this.db.exec(`
        UPDATE task_failure_archive
        SET retry_reason = 'unknown_error'
        WHERE retry_reason IS NULL OR trim(retry_reason) = '';
      `);
      this.db.exec(`
        UPDATE task_failure_archive
        SET archive_reason = 'non_retryable_error'
        WHERE archive_reason IS NULL OR trim(archive_reason) = '';
      `);
      this.pruneTaskFailureArchiveUnsafe();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

function normalizeTaskFailureArchiveInput(input: TaskFailureArchiveInput | string): {
  error: string;
  retryReason: string;
  archiveReason: string;
  retryAfterMs: number | null;
} {
  if (typeof input === "string") {
    const error = input.trim() || "unknown error";
    return {
      error,
      retryReason: "unknown_error",
      archiveReason: "non_retryable_error",
      retryAfterMs: null,
    };
  }

  const error = input.error.trim() || "unknown error";
  const retryReason = input.retryReason.trim() || "unknown_error";
  const archiveReason = input.archiveReason.trim() || "non_retryable_error";
  const retryAfterMs =
    typeof input.retryAfterMs === "number" && Number.isFinite(input.retryAfterMs)
      ? Math.max(0, Math.floor(input.retryAfterMs))
      : null;
  return {
    error,
    retryReason,
    archiveReason,
    retryAfterMs,
  };
}

type TaskQueueRow = {
  id: number;
  session_key: string;
  event_id: string;
  request_id: string;
  payload_json: string;
  status: TaskQueueStatus;
  attempt: number;
  enqueued_at: number;
  next_retry_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  last_error: string | null;
};

function mapTaskQueueRow(row: TaskQueueRow): TaskQueueRecord {
  return {
    id: row.id,
    sessionKey: row.session_key,
    eventId: row.event_id,
    requestId: row.request_id,
    payloadJson: row.payload_json,
    status: row.status,
    attempt: row.attempt,
    enqueuedAt: row.enqueued_at,
    nextRetryAt: row.next_retry_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    lastError: row.last_error,
  };
}
