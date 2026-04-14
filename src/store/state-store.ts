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

export type OperationAuditSurface = "admin" | "api" | "webhook";
export type OperationAuditOutcome = "allowed" | "denied" | "error";

export interface OperationAuditAppendInput {
  actor: string | null;
  source: string | null;
  surface: OperationAuditSurface;
  action: string;
  resource: string;
  method: string;
  path: string;
  outcome: OperationAuditOutcome;
  reason?: string | null;
  requiredScopes?: readonly string[];
  grantedScopes?: readonly string[];
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
}

export interface OperationAuditQueryInput {
  limit?: number;
  surface?: OperationAuditSurface;
  outcome?: OperationAuditOutcome;
  actor?: string;
  source?: string;
  action?: string;
  method?: string;
  pathPrefix?: string;
  reasonContains?: string;
  createdFrom?: number;
  createdTo?: number;
}

export interface OperationAuditRecord {
  id: number;
  actor: string | null;
  source: string | null;
  surface: OperationAuditSurface;
  action: string;
  resource: string;
  method: string;
  path: string;
  outcome: OperationAuditOutcome;
  reason: string | null;
  requiredScopes: string[];
  grantedScopes: string[];
  metadataJson: string | null;
  createdAt: number;
}

export interface SessionMessageRecord {
  id: number;
  sessionKey: string;
  role: "user" | "assistant";
  provider: "codex" | "claude" | "gemini";
  content: string;
  createdAt: number;
}

export interface SessionHistoryQueryInput {
  roomId?: string | null;
  userId?: string | null;
  from?: number | null;
  to?: number | null;
  limit?: number;
  offset?: number;
}

export interface SessionHistoryRecord {
  sessionKey: string;
  channel: string | null;
  roomId: string | null;
  userId: string | null;
  codexSessionId: string | null;
  activeUntil: number | null;
  updatedAt: number;
  messageCount: number;
  lastMessageAt: number | null;
}

export interface SessionHistoryQueryResult {
  total: number;
  items: SessionHistoryRecord[];
}

export interface HistoryRetentionPolicyRecord {
  enabled: boolean;
  retentionDays: number;
  cleanupIntervalMinutes: number;
  maxDeleteSessions: number;
  updatedAt: number;
}

export interface HistoryRetentionPolicyUpsertInput {
  enabled: boolean;
  retentionDays: number;
  cleanupIntervalMinutes: number;
  maxDeleteSessions: number;
}

export type HistoryCleanupTrigger = "manual" | "scheduled";
export type HistoryCleanupStatus = "succeeded" | "failed" | "skipped";

export interface HistoryCleanupRunRecord {
  id: number;
  trigger: HistoryCleanupTrigger;
  requestedBy: string | null;
  dryRun: boolean;
  status: HistoryCleanupStatus;
  retentionDays: number;
  maxDeleteSessions: number;
  cutoffTs: number;
  scannedSessions: number;
  scannedMessages: number;
  deletedSessions: number;
  deletedMessages: number;
  hasMore: boolean;
  sampledSessionKeys: string[];
  skippedReason: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number;
}

export interface HistoryCleanupRunAppendInput {
  trigger: HistoryCleanupTrigger;
  requestedBy: string | null;
  dryRun: boolean;
  status: HistoryCleanupStatus;
  retentionDays: number;
  maxDeleteSessions: number;
  cutoffTs: number;
  scannedSessions: number;
  scannedMessages: number;
  deletedSessions: number;
  deletedMessages: number;
  hasMore: boolean;
  sampledSessionKeys: string[];
  skippedReason?: string | null;
  error?: string | null;
  startedAt: number;
  finishedAt?: number;
}

export interface HistoryCleanupExecutionInput {
  cutoffTs: number;
  maxDeleteSessions: number;
  dryRun: boolean;
}

export interface HistoryCleanupExecutionResult {
  cutoffTs: number;
  scannedSessions: number;
  scannedMessages: number;
  deletedSessions: number;
  deletedMessages: number;
  hasMore: boolean;
  sampledSessionKeys: string[];
}

export interface HistoryCleanupLockRecord {
  owner: string;
  acquiredAt: number;
  expiresAt: number;
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
export type TaskQueueSource = "api" | "ci" | "ticket";

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

export interface TaskQueueListInput {
  status?: TaskQueueStatus | null;
  source?: TaskQueueSource | null;
  roomId?: string | null;
  from?: number | null;
  to?: number | null;
  limit?: number;
  offset?: number;
}

export interface TaskQueueListRecord extends TaskQueueRecord {
  source: TaskQueueSource;
  roomId: string | null;
}

export interface TaskQueueListResult {
  total: number;
  items: TaskQueueListRecord[];
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

export interface TaskQueueMutationResult {
  changed: boolean;
  task: TaskQueueRecord | null;
}

const MAX_CONVERSATION_MESSAGES_PER_SESSION = 200;
const MAX_TASK_FAILURE_ARCHIVE_ROWS = 1_000;
const MAX_TASK_QUEUE_QUERY_LIMIT = 500;
const MAX_SESSION_HISTORY_QUERY_LIMIT = 200;
const DEFAULT_HISTORY_RETENTION_DAYS = 30;
const DEFAULT_HISTORY_CLEANUP_INTERVAL_MINUTES = 1_440;
const DEFAULT_HISTORY_MAX_DELETE_SESSIONS = 500;
const MAX_HISTORY_CLEANUP_RUN_QUERY_LIMIT = 200;
const MAX_OPERATION_AUDIT_QUERY_LIMIT = 500;
const HISTORY_CLEANUP_LOCK_NAME = "global_history_cleanup";

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

  getAutoDevWorkdirOverride(sessionKey: string): string | null {
    this.maybePruneExpiredSessions();
    const row = this.db
      .prepare("SELECT autodev_workdir_override FROM sessions WHERE session_key = ?1")
      .get(sessionKey) as { autodev_workdir_override: string | null } | undefined;
    const value = row?.autodev_workdir_override?.trim() ?? "";
    return value.length > 0 ? value : null;
  }

  setAutoDevWorkdirOverride(sessionKey: string, workdir: string): void {
    this.maybePruneExpiredSessions();
    const normalized = workdir.trim();
    if (!normalized) {
      this.clearAutoDevWorkdirOverride(sessionKey);
      return;
    }
    this.ensureSession(sessionKey);
    this.db
      .prepare(
        "UPDATE sessions SET autodev_workdir_override = ?2, updated_at = ?3 WHERE session_key = ?1",
      )
      .run(sessionKey, normalized, Date.now());
  }

  clearAutoDevWorkdirOverride(sessionKey: string): void {
    this.maybePruneExpiredSessions();
    this.ensureSession(sessionKey);
    this.db
      .prepare("UPDATE sessions SET autodev_workdir_override = NULL, updated_at = ?2 WHERE session_key = ?1")
      .run(sessionKey, Date.now());
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
    const sessionMetadata = parseSessionMetadataFromSessionKey(sessionKey);
    if (sessionMetadata) {
      this.upsertSessionIndex(sessionKey, sessionMetadata, now);
    }
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

  appendOperationAuditLog(input: OperationAuditAppendInput): void {
    const requiredScopes = normalizeJsonArray(input.requiredScopes);
    const grantedScopes = normalizeJsonArray(input.grantedScopes);
    const metadataJson = normalizeJsonObject(input.metadata);
    this.db
      .prepare(
        `INSERT INTO operation_audit_logs
          (actor, source, surface, action, resource, method, path, outcome, reason, required_scopes_json, granted_scopes_json, metadata_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .run(
        input.actor,
        input.source,
        input.surface,
        input.action,
        input.resource,
        input.method,
        input.path,
        input.outcome,
        input.reason ?? null,
        requiredScopes,
        grantedScopes,
        metadataJson,
        input.createdAt ?? Date.now(),
      );
  }

  listOperationAuditLogs(input: OperationAuditQueryInput = {}): OperationAuditRecord[] {
    const safeLimit = Math.max(1, Math.min(MAX_OPERATION_AUDIT_QUERY_LIMIT, Math.floor(input.limit ?? 20)));
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (input.surface) {
      clauses.push("surface = ?");
      params.push(input.surface);
    }
    if (input.outcome) {
      clauses.push("outcome = ?");
      params.push(input.outcome);
    }
    if (input.actor) {
      clauses.push("actor = ?");
      params.push(input.actor);
    }
    if (input.source) {
      clauses.push("source = ?");
      params.push(input.source);
    }
    if (input.action) {
      clauses.push("action = ?");
      params.push(input.action);
    }
    if (input.method) {
      clauses.push("method = ?");
      params.push(input.method.toUpperCase());
    }
    if (input.pathPrefix) {
      clauses.push("path LIKE ? ESCAPE '\\'");
      params.push(`${escapeLikePattern(input.pathPrefix)}%`);
    }
    if (input.reasonContains) {
      clauses.push("COALESCE(reason, '') LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLikePattern(input.reasonContains)}%`);
    }
    if (typeof input.createdFrom === "number" && Number.isFinite(input.createdFrom)) {
      clauses.push("created_at >= ?");
      params.push(Math.max(0, Math.floor(input.createdFrom)));
    }
    if (typeof input.createdTo === "number" && Number.isFinite(input.createdTo)) {
      clauses.push("created_at <= ?");
      params.push(Math.max(0, Math.floor(input.createdTo)));
    }
    params.push(safeLimit);

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, actor, source, surface, action, resource, method, path, outcome, reason, required_scopes_json, granted_scopes_json, metadata_json, created_at
         FROM operation_audit_logs
         ${whereClause}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...params) as Array<{
      id: number;
      actor: string | null;
      source: string | null;
      surface: OperationAuditSurface;
      action: string;
      resource: string;
      method: string;
      path: string;
      outcome: OperationAuditOutcome;
      reason: string | null;
      required_scopes_json: string;
      granted_scopes_json: string;
      metadata_json: string | null;
      created_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      source: row.source,
      surface: row.surface,
      action: row.action,
      resource: row.resource,
      method: row.method,
      path: row.path,
      outcome: row.outcome,
      reason: row.reason,
      requiredScopes: parseStringArrayJson(row.required_scopes_json),
      grantedScopes: parseStringArrayJson(row.granted_scopes_json),
      metadataJson: row.metadata_json,
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
    const now = Date.now();
    const source = parseTaskQueueSourceFromPayload(input.payloadJson);
    this.ensureSession(input.sessionKey);
    const sessionMetadata =
      parseSessionMetadataFromQueuedPayload(input.payloadJson) ?? parseSessionMetadataFromSessionKey(input.sessionKey);
    if (sessionMetadata) {
      this.upsertSessionIndex(input.sessionKey, sessionMetadata, now);
    }
    const result = this.db
      .prepare(
        `INSERT INTO task_queue
          (session_key, event_id, request_id, payload_json, source, status, attempt, enqueued_at, next_retry_at, started_at, finished_at, error, last_error)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, NULL, NULL, NULL, NULL, NULL)
         ON CONFLICT(session_key, event_id) DO NOTHING`,
      )
      .run(input.sessionKey, input.eventId, input.requestId, input.payloadJson, source, now) as { changes?: number };
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

  cancelTaskById(taskId: number, error = "cancelled by api"): TaskQueueMutationResult {
    const normalized = error.trim() || "cancelled";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT id, session_key, event_id, request_id, payload_json, status, attempt, enqueued_at, next_retry_at, started_at, finished_at, error, last_error
           FROM task_queue
           WHERE id = ?1
           LIMIT 1`,
        )
        .get(taskId) as TaskQueueRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return {
          changed: false,
          task: null,
        };
      }
      if (row.status !== "pending") {
        this.db.exec("COMMIT");
        return {
          changed: false,
          task: mapTaskQueueRow(row),
        };
      }

      const finishedAt = Date.now();
      const nextError = normalized.slice(0, 2_000);
      this.db
        .prepare(
          "UPDATE task_queue SET status = 'failed', next_retry_at = NULL, finished_at = ?2, error = ?3, last_error = ?3 WHERE id = ?1",
        )
        .run(taskId, finishedAt, nextError);
      row.status = "failed";
      row.next_retry_at = null;
      row.started_at = null;
      row.finished_at = finishedAt;
      row.error = nextError;
      row.last_error = nextError;
      this.db.exec("COMMIT");
      return {
        changed: true,
        task: mapTaskQueueRow(row),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  retryTaskById(taskId: number): TaskQueueMutationResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT id, session_key, event_id, request_id, payload_json, status, attempt, enqueued_at, next_retry_at, started_at, finished_at, error, last_error
           FROM task_queue
           WHERE id = ?1
           LIMIT 1`,
        )
        .get(taskId) as TaskQueueRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return {
          changed: false,
          task: null,
        };
      }
      if (row.status !== "failed") {
        this.db.exec("COMMIT");
        return {
          changed: false,
          task: mapTaskQueueRow(row),
        };
      }

      this.db
        .prepare(
          "UPDATE task_queue SET status = 'pending', next_retry_at = NULL, started_at = NULL, finished_at = NULL, error = NULL WHERE id = ?1",
        )
        .run(taskId);
      row.status = "pending";
      row.next_retry_at = null;
      row.started_at = null;
      row.finished_at = null;
      row.error = null;
      this.db.exec("COMMIT");
      return {
        changed: true,
        task: mapTaskQueueRow(row),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  listTaskQueue(input: TaskQueueListInput = {}): TaskQueueListResult {
    this.ensureSessionIndexBackfill();

    const safeLimit = clampInt(input.limit, 20, 1, MAX_TASK_QUEUE_QUERY_LIMIT);
    const safeOffset = Math.max(0, Math.floor(input.offset ?? 0));
    const status = normalizeOptionalTaskQueueStatus(input.status);
    const source = normalizeOptionalTaskQueueSource(input.source);
    const roomId = normalizeOptionalFilterValue(input.roomId);
    const from = normalizeOptionalTimestampNumber(input.from);
    const to = normalizeOptionalTimestampNumber(input.to);
    if (from !== null && to !== null && from > to) {
      throw new Error("Invalid task queue filter: from must be <= to.");
    }

    const whereClauses: string[] = [];
    const whereArgs: Array<string | number> = [];
    if (status) {
      whereClauses.push("t.status = ?");
      whereArgs.push(status);
    }
    if (source) {
      whereClauses.push("t.source = ?");
      whereArgs.push(source);
    }
    if (roomId) {
      whereClauses.push("idx.room_id = ?");
      whereArgs.push(roomId);
    }
    if (from !== null) {
      whereClauses.push("t.enqueued_at >= ?");
      whereArgs.push(from);
    }
    if (to !== null) {
      whereClauses.push("t.enqueued_at <= ?");
      whereArgs.push(to);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const baseFromSql = `
      FROM task_queue AS t
      LEFT JOIN session_index AS idx ON idx.session_key = t.session_key
    `;
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS count ${baseFromSql} ${whereSql}`)
      .get(...whereArgs) as { count: number } | undefined;

    const rows = this.db
      .prepare(
        `
          SELECT
            t.id,
            t.session_key,
            t.event_id,
            t.request_id,
            t.payload_json,
            t.status,
            t.attempt,
            t.enqueued_at,
            t.next_retry_at,
            t.started_at,
            t.finished_at,
            t.error,
            t.last_error,
            t.source,
            idx.room_id
          ${baseFromSql}
          ${whereSql}
          ORDER BY t.id DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(...whereArgs, safeLimit, safeOffset) as TaskQueueListRow[];

    return {
      total: Number(countRow?.count ?? 0),
      items: rows.map((row) => ({
        ...mapTaskQueueRow(row),
        source: normalizeTaskQueueSource(row.source),
        roomId: row.room_id,
      })),
    };
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
    provider: "codex" | "claude" | "gemini",
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
      provider: "codex" | "claude" | "gemini";
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

  listSessionHistory(input: SessionHistoryQueryInput = {}): SessionHistoryQueryResult {
    this.ensureSessionIndexBackfill();

    const safeLimit = clampInt(input.limit, 20, 1, MAX_SESSION_HISTORY_QUERY_LIMIT);
    const safeOffset = Math.max(0, Math.floor(input.offset ?? 0));
    const roomId = normalizeOptionalFilterValue(input.roomId);
    const userId = normalizeOptionalFilterValue(input.userId);
    const from = normalizeOptionalTimestampNumber(input.from);
    const to = normalizeOptionalTimestampNumber(input.to);
    if (from !== null && to !== null && from > to) {
      throw new Error("Invalid session history filter: from must be <= to.");
    }

    const whereClauses: string[] = [];
    const whereArgs: Array<string | number> = [];
    if (roomId) {
      whereClauses.push("idx.room_id = ?");
      whereArgs.push(roomId);
    }
    if (userId) {
      whereClauses.push("idx.user_id = ?");
      whereArgs.push(userId);
    }
    if (from !== null) {
      whereClauses.push("s.updated_at >= ?");
      whereArgs.push(from);
    }
    if (to !== null) {
      whereClauses.push("s.updated_at <= ?");
      whereArgs.push(to);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const baseFromSql = `
      FROM sessions AS s
      LEFT JOIN session_index AS idx ON idx.session_key = s.session_key
    `;
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS count ${baseFromSql} ${whereSql}`)
      .get(...whereArgs) as { count: number } | undefined;

    const rows = this.db
      .prepare(
        `
          SELECT
            s.session_key,
            s.codex_session_id,
            s.active_until,
            s.updated_at,
            idx.channel,
            idx.room_id,
            idx.user_id,
            COALESCE(msg.message_count, 0) AS message_count,
            msg.last_message_at
          ${baseFromSql}
          LEFT JOIN (
            SELECT session_key, COUNT(*) AS message_count, MAX(created_at) AS last_message_at
            FROM session_messages
            GROUP BY session_key
          ) AS msg ON msg.session_key = s.session_key
          ${whereSql}
          ORDER BY s.updated_at DESC, s.session_key ASC
          LIMIT ? OFFSET ?
        `,
      )
      .all(...whereArgs, safeLimit, safeOffset) as Array<{
      session_key: string;
      codex_session_id: string | null;
      active_until: number | null;
      updated_at: number;
      channel: string | null;
      room_id: string | null;
      user_id: string | null;
      message_count: number;
      last_message_at: number | null;
    }>;

    return {
      total: countRow?.count ?? 0,
      items: rows.map((row) => ({
        sessionKey: row.session_key,
        channel: row.channel,
        roomId: row.room_id,
        userId: row.user_id,
        codexSessionId: row.codex_session_id,
        activeUntil: row.active_until,
        updatedAt: row.updated_at,
        messageCount: Number(row.message_count ?? 0),
        lastMessageAt: row.last_message_at,
      })),
    };
  }

  getHistoryRetentionPolicy(): HistoryRetentionPolicyRecord {
    const row = this.db
      .prepare(
        `SELECT enabled, retention_days, cleanup_interval_minutes, max_delete_sessions, updated_at
         FROM history_retention_policy
         WHERE id = 1`,
      )
      .get() as
      | {
          enabled: number;
          retention_days: number;
          cleanup_interval_minutes: number;
          max_delete_sessions: number;
          updated_at: number;
        }
      | undefined;
    if (!row) {
      return {
        enabled: false,
        retentionDays: DEFAULT_HISTORY_RETENTION_DAYS,
        cleanupIntervalMinutes: DEFAULT_HISTORY_CLEANUP_INTERVAL_MINUTES,
        maxDeleteSessions: DEFAULT_HISTORY_MAX_DELETE_SESSIONS,
        updatedAt: 0,
      };
    }
    return {
      enabled: row.enabled === 1,
      retentionDays: row.retention_days,
      cleanupIntervalMinutes: row.cleanup_interval_minutes,
      maxDeleteSessions: row.max_delete_sessions,
      updatedAt: row.updated_at,
    };
  }

  upsertHistoryRetentionPolicy(input: HistoryRetentionPolicyUpsertInput): HistoryRetentionPolicyRecord {
    const normalized = normalizeHistoryRetentionPolicyInput(input);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO history_retention_policy
          (id, enabled, retention_days, cleanup_interval_minutes, max_delete_sessions, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
          enabled = excluded.enabled,
          retention_days = excluded.retention_days,
          cleanup_interval_minutes = excluded.cleanup_interval_minutes,
          max_delete_sessions = excluded.max_delete_sessions,
          updated_at = excluded.updated_at`,
      )
      .run(
        boolToInt(normalized.enabled),
        normalized.retentionDays,
        normalized.cleanupIntervalMinutes,
        normalized.maxDeleteSessions,
        now,
      );
    return {
      ...normalized,
      updatedAt: now,
    };
  }

  executeHistoryCleanup(input: HistoryCleanupExecutionInput): HistoryCleanupExecutionResult {
    const cutoffTs = Math.max(0, Math.floor(input.cutoffTs));
    const maxDeleteSessions = Math.max(1, Math.floor(input.maxDeleteSessions));
    if (input.dryRun) {
      const staleTotal = this.countStaleSessions(cutoffTs);
      const sessionKeys = this.listStaleSessionKeys(cutoffTs, maxDeleteSessions);
      const scannedMessages = this.countMessagesForSessionKeys(sessionKeys);
      return {
        cutoffTs,
        scannedSessions: sessionKeys.length,
        scannedMessages,
        deletedSessions: 0,
        deletedMessages: 0,
        hasMore: staleTotal > sessionKeys.length,
        sampledSessionKeys: sessionKeys.slice(0, 20),
      };
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const staleTotal = this.countStaleSessions(cutoffTs);
      const sessionKeys = this.listStaleSessionKeys(cutoffTs, maxDeleteSessions);
      const scannedMessages = this.countMessagesForSessionKeys(sessionKeys);
      const deletedSessions = this.deleteSessionsBySessionKeys(sessionKeys);
      this.db.exec("COMMIT");
      return {
        cutoffTs,
        scannedSessions: sessionKeys.length,
        scannedMessages,
        deletedSessions,
        deletedMessages: deletedSessions > 0 ? scannedMessages : 0,
        hasMore: staleTotal > sessionKeys.length,
        sampledSessionKeys: sessionKeys.slice(0, 20),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendHistoryCleanupRun(input: HistoryCleanupRunAppendInput): HistoryCleanupRunRecord {
    const normalized = normalizeHistoryCleanupRunInput(input);
    const row = this.db
      .prepare(
        `INSERT INTO history_cleanup_runs (
           trigger,
           requested_by,
           dry_run,
           status,
           retention_days,
           max_delete_sessions,
           cutoff_ts,
           scanned_sessions,
           scanned_messages,
           deleted_sessions,
           deleted_messages,
           has_more,
           sampled_session_keys_json,
           skipped_reason,
           error,
           started_at,
           finished_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         RETURNING
           id,
           trigger,
           requested_by,
           dry_run,
           status,
           retention_days,
           max_delete_sessions,
           cutoff_ts,
           scanned_sessions,
           scanned_messages,
           deleted_sessions,
           deleted_messages,
           has_more,
           sampled_session_keys_json,
           skipped_reason,
           error,
           started_at,
           finished_at`,
      )
      .get(
        normalized.trigger,
        normalized.requestedBy,
        boolToInt(normalized.dryRun),
        normalized.status,
        normalized.retentionDays,
        normalized.maxDeleteSessions,
        normalized.cutoffTs,
        normalized.scannedSessions,
        normalized.scannedMessages,
        normalized.deletedSessions,
        normalized.deletedMessages,
        boolToInt(normalized.hasMore),
        JSON.stringify(normalized.sampledSessionKeys),
        normalized.skippedReason,
        normalized.error,
        normalized.startedAt,
        normalized.finishedAt,
      ) as HistoryCleanupRunRow | undefined;
    if (!row) {
      throw new Error("Failed to append history cleanup run.");
    }
    return mapHistoryCleanupRunRow(row);
  }

  listHistoryCleanupRuns(limit = 20): HistoryCleanupRunRecord[] {
    const safeLimit = clampInt(limit, 20, 1, MAX_HISTORY_CLEANUP_RUN_QUERY_LIMIT);
    const rows = this.db
      .prepare(
        `SELECT
           id,
           trigger,
           requested_by,
           dry_run,
           status,
           retention_days,
           max_delete_sessions,
           cutoff_ts,
           scanned_sessions,
           scanned_messages,
           deleted_sessions,
           deleted_messages,
           has_more,
           sampled_session_keys_json,
           skipped_reason,
           error,
           started_at,
           finished_at
         FROM history_cleanup_runs
         ORDER BY id DESC
         LIMIT ?1`,
      )
      .all(safeLimit) as HistoryCleanupRunRow[];
    return rows.map((row) => mapHistoryCleanupRunRow(row));
  }

  getLatestHistoryCleanupRun(trigger?: HistoryCleanupTrigger): HistoryCleanupRunRecord | null {
    const row = (trigger
      ? this.db
          .prepare(
            `SELECT
               id,
               trigger,
               requested_by,
               dry_run,
               status,
               retention_days,
               max_delete_sessions,
               cutoff_ts,
               scanned_sessions,
               scanned_messages,
               deleted_sessions,
               deleted_messages,
               has_more,
               sampled_session_keys_json,
               skipped_reason,
               error,
               started_at,
               finished_at
             FROM history_cleanup_runs
             WHERE trigger = ?1
             ORDER BY id DESC
             LIMIT 1`,
          )
          .get(trigger)
      : this.db
          .prepare(
            `SELECT
               id,
               trigger,
               requested_by,
               dry_run,
               status,
               retention_days,
               max_delete_sessions,
               cutoff_ts,
               scanned_sessions,
               scanned_messages,
               deleted_sessions,
               deleted_messages,
               has_more,
               sampled_session_keys_json,
               skipped_reason,
               error,
               started_at,
               finished_at
             FROM history_cleanup_runs
             ORDER BY id DESC
             LIMIT 1`,
          )
          .get()) as HistoryCleanupRunRow | undefined;
    if (!row) {
      return null;
    }
    return mapHistoryCleanupRunRow(row);
  }

  acquireHistoryCleanupLock(input: {
    owner: string;
    ttlMs: number;
  }): { acquired: boolean; owner: string | null; expiresAt: number | null } {
    const owner = input.owner.trim();
    if (!owner) {
      throw new Error("history cleanup lock owner is required.");
    }
    const now = Date.now();
    const ttlMs = Math.max(1_000, Math.floor(input.ttlMs));
    const expiresAt = now + ttlMs;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT owner, expires_at FROM history_cleanup_locks WHERE name = ?1")
        .get(HISTORY_CLEANUP_LOCK_NAME) as { owner: string; expires_at: number } | undefined;
      if (!existing || existing.expires_at <= now) {
        this.db
          .prepare(
            `INSERT INTO history_cleanup_locks (name, owner, acquired_at, expires_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
          )
          .run(HISTORY_CLEANUP_LOCK_NAME, owner, now, expiresAt);
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

  releaseHistoryCleanupLock(owner: string): void {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) {
      return;
    }
    this.db
      .prepare("DELETE FROM history_cleanup_locks WHERE name = ?1 AND owner = ?2")
      .run(HISTORY_CLEANUP_LOCK_NAME, normalizedOwner);
  }

  getHistoryCleanupLock(now = Date.now()): HistoryCleanupLockRecord | null {
    const row = this.db
      .prepare("SELECT owner, acquired_at, expires_at FROM history_cleanup_locks WHERE name = ?1")
      .get(HISTORY_CLEANUP_LOCK_NAME) as { owner: string; acquired_at: number; expires_at: number } | undefined;
    if (!row) {
      return null;
    }
    if (row.expires_at <= now) {
      this.db
        .prepare("DELETE FROM history_cleanup_locks WHERE name = ?1 AND expires_at <= ?2")
        .run(HISTORY_CLEANUP_LOCK_NAME, now);
      return null;
    }
    return {
      owner: row.owner,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
    };
  }

  private ensureSessionIndexBackfill(limit = 500): void {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.db
      .prepare(
        `SELECT s.session_key, s.updated_at
         FROM sessions AS s
         LEFT JOIN session_index AS idx ON idx.session_key = s.session_key
         WHERE idx.session_key IS NULL
         ORDER BY s.updated_at DESC
         LIMIT ?1`,
      )
      .all(safeLimit) as Array<{ session_key: string; updated_at: number }>;

    for (const row of rows) {
      const metadata = parseSessionMetadataFromSessionKey(row.session_key);
      if (!metadata) {
        continue;
      }
      this.upsertSessionIndex(row.session_key, metadata, row.updated_at);
    }
  }

  private upsertSessionIndex(sessionKey: string, metadata: SessionIndexMetadata, updatedAt: number): void {
    this.db
      .prepare(
        `INSERT INTO session_index (session_key, channel, room_id, user_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(session_key) DO UPDATE SET
           channel = excluded.channel,
           room_id = excluded.room_id,
           user_id = excluded.user_id,
           updated_at = CASE
             WHEN excluded.updated_at > session_index.updated_at THEN excluded.updated_at
             ELSE session_index.updated_at
           END`,
      )
      .run(sessionKey, metadata.channel, metadata.roomId, metadata.userId, updatedAt);
  }

  private countStaleSessions(cutoffTs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE updated_at < ?1")
      .get(cutoffTs) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private listStaleSessionKeys(cutoffTs: number, limit: number): string[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.db
      .prepare(
        `SELECT session_key
         FROM sessions
         WHERE updated_at < ?1
         ORDER BY updated_at ASC, session_key ASC
         LIMIT ?2`,
      )
      .all(cutoffTs, safeLimit) as Array<{ session_key: string }>;
    return rows.map((row) => row.session_key);
  }

  private countMessagesForSessionKeys(sessionKeys: string[]): number {
    if (sessionKeys.length === 0) {
      return 0;
    }
    const placeholders = buildSqlPlaceholders(sessionKeys.length);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM session_messages WHERE session_key IN (${placeholders})`)
      .get(...sessionKeys) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private deleteSessionsBySessionKeys(sessionKeys: string[]): number {
    if (sessionKeys.length === 0) {
      return 0;
    }
    const placeholders = buildSqlPlaceholders(sessionKeys.length);
    const result = this.db
      .prepare(`DELETE FROM sessions WHERE session_key IN (${placeholders})`)
      .run(...sessionKeys) as { changes?: number };
    return Number(result.changes ?? 0);
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
        autodev_workdir_override TEXT,
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

      CREATE TABLE IF NOT EXISTS operation_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT,
        source TEXT,
        surface TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        required_scopes_json TEXT NOT NULL,
        granted_scopes_json TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_created_at ON operation_audit_logs(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_surface_created_at ON operation_audit_logs(surface, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_outcome_created_at ON operation_audit_logs(outcome, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_actor_created_at ON operation_audit_logs(actor, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_action_created_at ON operation_audit_logs(action, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_source_created_at ON operation_audit_logs(source, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_method_created_at ON operation_audit_logs(method, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_path_created_at ON operation_audit_logs(path, created_at DESC, id DESC);

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
        source TEXT NOT NULL DEFAULT 'api',
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
      CREATE INDEX IF NOT EXISTS idx_task_queue_source_status_id ON task_queue(source, status, id);

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

      CREATE TABLE IF NOT EXISTS session_index (
        session_key TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_index_room_updated ON session_index(room_id, updated_at DESC, session_key);
      CREATE INDEX IF NOT EXISTS idx_session_index_user_updated ON session_index(user_id, updated_at DESC, session_key);
      CREATE INDEX IF NOT EXISTS idx_session_index_updated ON session_index(updated_at DESC, session_key);

      CREATE TABLE IF NOT EXISTS history_retention_policy (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        retention_days INTEGER NOT NULL DEFAULT 30,
        cleanup_interval_minutes INTEGER NOT NULL DEFAULT 1440,
        max_delete_sessions INTEGER NOT NULL DEFAULT 500,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS history_cleanup_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
        requested_by TEXT,
        dry_run INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
        retention_days INTEGER NOT NULL,
        max_delete_sessions INTEGER NOT NULL,
        cutoff_ts INTEGER NOT NULL,
        scanned_sessions INTEGER NOT NULL DEFAULT 0,
        scanned_messages INTEGER NOT NULL DEFAULT 0,
        deleted_sessions INTEGER NOT NULL DEFAULT 0,
        deleted_messages INTEGER NOT NULL DEFAULT 0,
        has_more INTEGER NOT NULL DEFAULT 0,
        sampled_session_keys_json TEXT NOT NULL DEFAULT '[]',
        skipped_reason TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_history_cleanup_runs_started ON history_cleanup_runs(started_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_history_cleanup_runs_trigger_started ON history_cleanup_runs(trigger, started_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS history_cleanup_locks (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

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

    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const sessionColumnNames = new Set(sessionColumns.map((column) => column.name));
    if (!sessionColumnNames.has("autodev_workdir_override")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN autodev_workdir_override TEXT");
    }
  }

  private migrateTaskQueueSchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(task_queue)").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const needsSourceBackfill = !columnNames.has("source");
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
      if (needsSourceBackfill) {
        this.db.exec("ALTER TABLE task_queue ADD COLUMN source TEXT NOT NULL DEFAULT 'api'");
      }

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_task_queue_status_retry_id ON task_queue(status, next_retry_at, id);
        CREATE INDEX IF NOT EXISTS idx_task_queue_session_status_retry_id ON task_queue(session_key, status, next_retry_at, id);
        CREATE INDEX IF NOT EXISTS idx_task_queue_source_status_id ON task_queue(source, status, id);

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
      if (needsSourceBackfill) {
        this.backfillTaskQueueSourceUnsafe();
      }
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

  private backfillTaskQueueSourceUnsafe(): void {
    const rows = this.db
      .prepare("SELECT id, payload_json, source FROM task_queue")
      .all() as Array<{ id: number; payload_json: string; source: string | null }>;
    if (rows.length === 0) {
      return;
    }

    const update = this.db.prepare("UPDATE task_queue SET source = ?2 WHERE id = ?1");
    for (const row of rows) {
      const nextSource = parseTaskQueueSourceFromPayload(row.payload_json);
      const currentSource = normalizeTaskQueueSource(row.source);
      if (nextSource === currentSource) {
        continue;
      }
      update.run(row.id, nextSource);
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

function normalizeJsonArray(values: readonly string[] | undefined): string {
  if (!values || values.length === 0) {
    return "[]";
  }
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return JSON.stringify(normalized);
}

function normalizeJsonObject(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  if (entries.length === 0) {
    return null;
  }
  return JSON.stringify(Object.fromEntries(entries));
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

const TASK_QUEUE_STATUS_VALUES = new Set<TaskQueueStatus>(["pending", "running", "succeeded", "failed"]);
const TASK_QUEUE_SOURCE_VALUES = new Set<TaskQueueSource>(["api", "ci", "ticket"]);

function parseTaskQueueSourceFromPayload(payloadJson: string): TaskQueueSource {
  try {
    const parsed = JSON.parse(payloadJson) as {
      externalContext?: {
        source?: unknown;
      };
    };
    return normalizeTaskQueueSource(parsed.externalContext?.source);
  } catch {
    return "api";
  }
}

function normalizeTaskQueueSource(value: unknown): TaskQueueSource {
  const normalized = normalizeOptionalFilterValue(value);
  if (!normalized || !TASK_QUEUE_SOURCE_VALUES.has(normalized as TaskQueueSource)) {
    return "api";
  }
  return normalized as TaskQueueSource;
}

function normalizeOptionalTaskQueueSource(value: unknown): TaskQueueSource | null {
  const normalized = normalizeOptionalFilterValue(value);
  if (!normalized) {
    return null;
  }
  if (!TASK_QUEUE_SOURCE_VALUES.has(normalized as TaskQueueSource)) {
    throw new Error("Invalid task queue filter: source must be one of api|ci|ticket.");
  }
  return normalized as TaskQueueSource;
}

function normalizeOptionalTaskQueueStatus(value: unknown): TaskQueueStatus | null {
  const normalized = normalizeOptionalFilterValue(value);
  if (!normalized) {
    return null;
  }
  if (!TASK_QUEUE_STATUS_VALUES.has(normalized as TaskQueueStatus)) {
    throw new Error("Invalid task queue filter: status must be one of pending|running|succeeded|failed.");
  }
  return normalized as TaskQueueStatus;
}

interface SessionIndexMetadata {
  channel: string;
  roomId: string;
  userId: string;
}

function parseSessionMetadataFromQueuedPayload(payloadJson: string): SessionIndexMetadata | null {
  try {
    const parsed = JSON.parse(payloadJson) as {
      message?: {
        channel?: unknown;
        conversationId?: unknown;
        senderId?: unknown;
      };
    };
    const message = parsed.message;
    if (!message) {
      return null;
    }
    const channel = normalizeOptionalFilterValue(message.channel);
    const roomId = normalizeOptionalFilterValue(message.conversationId);
    const userId = normalizeOptionalFilterValue(message.senderId);
    if (!channel || !roomId || !userId) {
      return null;
    }
    return {
      channel,
      roomId,
      userId,
    };
  } catch {
    return null;
  }
}

function parseSessionMetadataFromSessionKey(sessionKey: string): SessionIndexMetadata | null {
  const firstColon = sessionKey.indexOf(":");
  if (firstColon <= 0 || firstColon >= sessionKey.length - 1) {
    return null;
  }

  const channel = sessionKey.slice(0, firstColon).trim();
  const payload = sessionKey.slice(firstColon + 1);
  if (!channel || !payload) {
    return null;
  }
  if (channel !== "matrix") {
    return null;
  }

  const senderMarkerIndex = payload.lastIndexOf(":@");
  if (senderMarkerIndex <= 0) {
    return null;
  }
  const roomId = payload.slice(0, senderMarkerIndex).trim();
  const userId = payload.slice(senderMarkerIndex + 1).trim();
  if (!roomId || !userId) {
    return null;
  }

  return {
    channel,
    roomId,
    userId,
  };
}

function normalizeOptionalFilterValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeOptionalTimestampNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized =
    typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(normalized)) {
    throw new Error("Invalid timestamp filter.");
  }
  return Math.max(0, Math.floor(normalized));
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeHistoryRetentionPolicyInput(input: HistoryRetentionPolicyUpsertInput): HistoryRetentionPolicyUpsertInput {
  return {
    enabled: input.enabled,
    retentionDays: clampInt(input.retentionDays, DEFAULT_HISTORY_RETENTION_DAYS, 1, 3_650),
    cleanupIntervalMinutes: clampInt(input.cleanupIntervalMinutes, DEFAULT_HISTORY_CLEANUP_INTERVAL_MINUTES, 5, 10_080),
    maxDeleteSessions: clampInt(input.maxDeleteSessions, DEFAULT_HISTORY_MAX_DELETE_SESSIONS, 1, 10_000),
  };
}

function normalizeHistoryCleanupRunInput(input: HistoryCleanupRunAppendInput): HistoryCleanupRunAppendInput & {
  skippedReason: string | null;
  error: string | null;
  finishedAt: number;
} {
  const requestedBy = normalizeOptionalFilterValue(input.requestedBy);
  const skippedReason = normalizeOptionalFilterValue(input.skippedReason);
  const error = normalizeOptionalFilterValue(input.error);
  const startedAt = Math.max(0, Math.floor(input.startedAt));
  const finishedAt = Math.max(startedAt, Math.floor(input.finishedAt ?? Date.now()));
  return {
    trigger: input.trigger,
    requestedBy,
    dryRun: input.dryRun,
    status: input.status,
    retentionDays: clampInt(input.retentionDays, DEFAULT_HISTORY_RETENTION_DAYS, 1, 3_650),
    maxDeleteSessions: clampInt(input.maxDeleteSessions, DEFAULT_HISTORY_MAX_DELETE_SESSIONS, 1, 10_000),
    cutoffTs: Math.max(0, Math.floor(input.cutoffTs)),
    scannedSessions: Math.max(0, Math.floor(input.scannedSessions)),
    scannedMessages: Math.max(0, Math.floor(input.scannedMessages)),
    deletedSessions: Math.max(0, Math.floor(input.deletedSessions)),
    deletedMessages: Math.max(0, Math.floor(input.deletedMessages)),
    hasMore: input.hasMore,
    sampledSessionKeys: input.sampledSessionKeys
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, 100),
    skippedReason,
    error,
    startedAt,
    finishedAt,
  };
}

function parseSessionKeyArrayJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

function parseStringArrayJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/([%_\\])/g, "\\$1");
}

function buildSqlPlaceholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

type HistoryCleanupRunRow = {
  id: number;
  trigger: HistoryCleanupTrigger;
  requested_by: string | null;
  dry_run: number;
  status: HistoryCleanupStatus;
  retention_days: number;
  max_delete_sessions: number;
  cutoff_ts: number;
  scanned_sessions: number;
  scanned_messages: number;
  deleted_sessions: number;
  deleted_messages: number;
  has_more: number;
  sampled_session_keys_json: string;
  skipped_reason: string | null;
  error: string | null;
  started_at: number;
  finished_at: number;
};

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

type TaskQueueListRow = TaskQueueRow & {
  source: string | null;
  room_id: string | null;
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

function mapHistoryCleanupRunRow(row: HistoryCleanupRunRow): HistoryCleanupRunRecord {
  return {
    id: row.id,
    trigger: row.trigger,
    requestedBy: row.requested_by,
    dryRun: row.dry_run === 1,
    status: row.status,
    retentionDays: row.retention_days,
    maxDeleteSessions: row.max_delete_sessions,
    cutoffTs: row.cutoff_ts,
    scannedSessions: row.scanned_sessions,
    scannedMessages: row.scanned_messages,
    deletedSessions: row.deleted_sessions,
    deletedMessages: row.deleted_messages,
    hasMore: row.has_more === 1,
    sampledSessionKeys: parseSessionKeyArrayJson(row.sampled_session_keys_json),
    skippedReason: row.skipped_reason,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
