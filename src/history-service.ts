import { Logger } from "./logger";
import {
  HistoryCleanupRunRecord,
  HistoryCleanupTrigger,
  HistoryRetentionPolicyRecord,
  HistoryRetentionPolicyUpsertInput,
  SessionHistoryQueryInput,
  SessionHistoryRecord,
  SessionMessageRecord,
  StateStore,
} from "./store/state-store";

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_EXPORT_MESSAGE_LIMIT = 200;
const MAX_EXPORT_MESSAGE_LIMIT = 500;
const DEFAULT_CLEANUP_SCHEDULER_POLL_MS = 60_000;
const DEFAULT_CLEANUP_LOCK_TTL_MS = 5 * 60 * 1_000;

export interface SessionHistoryExportInput extends SessionHistoryQueryInput {
  includeMessages?: boolean;
  messageLimitPerSession?: number;
}

export interface SessionHistoryExportRecord extends SessionHistoryRecord {
  messages?: SessionMessageRecord[];
}

export interface SessionHistoryExportResult {
  exportedAt: number;
  total: number;
  items: SessionHistoryExportRecord[];
}

export interface HistoryCleanupRunInput {
  trigger: HistoryCleanupTrigger;
  requestedBy?: string | null;
  dryRun?: boolean;
  retentionDays?: number;
  maxDeleteSessions?: number;
}

interface HistoryServiceOptions {
  cleanupSchedulerPollMs?: number;
  cleanupLockTtlMs?: number;
  cleanupOwner?: string;
}

export class HistoryService {
  private readonly stateStore: StateStore;
  private readonly logger: Logger;
  private readonly cleanupSchedulerPollMs: number;
  private readonly cleanupLockTtlMs: number;
  private readonly cleanupOwner: string;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private cleanupTickRunning = false;

  constructor(stateStore: StateStore, logger: Logger, options: HistoryServiceOptions = {}) {
    this.stateStore = stateStore;
    this.logger = logger;
    this.cleanupSchedulerPollMs = Math.max(5_000, Math.floor(options.cleanupSchedulerPollMs ?? DEFAULT_CLEANUP_SCHEDULER_POLL_MS));
    this.cleanupLockTtlMs = Math.max(1_000, Math.floor(options.cleanupLockTtlMs ?? DEFAULT_CLEANUP_LOCK_TTL_MS));
    this.cleanupOwner = options.cleanupOwner?.trim() || `history-cleanup:${process.pid}`;
  }

  getRetentionPolicy(): HistoryRetentionPolicyRecord {
    return this.stateStore.getHistoryRetentionPolicy();
  }

  updateRetentionPolicy(input: HistoryRetentionPolicyUpsertInput, actor?: string | null): HistoryRetentionPolicyRecord {
    const nextPolicy = this.stateStore.upsertHistoryRetentionPolicy(input);
    this.stateStore.appendConfigRevision(
      normalizeOptionalActor(actor),
      "update history retention policy",
      JSON.stringify({
        type: "history_retention_policy_update",
        policy: nextPolicy,
      }),
    );
    return nextPolicy;
  }

  exportSessionHistory(input: SessionHistoryExportInput): SessionHistoryExportResult {
    const includeMessages = input.includeMessages ?? true;
    const messageLimitPerSession = clampInt(
      input.messageLimitPerSession,
      DEFAULT_EXPORT_MESSAGE_LIMIT,
      1,
      MAX_EXPORT_MESSAGE_LIMIT,
    );
    const result = this.stateStore.listSessionHistory({
      roomId: input.roomId,
      userId: input.userId,
      from: input.from,
      to: input.to,
      limit: input.limit,
      offset: input.offset,
    });

    const items: SessionHistoryExportRecord[] = result.items.map((session) => {
      if (!includeMessages) {
        return { ...session };
      }
      return {
        ...session,
        messages: this.stateStore.listRecentConversationMessages(session.sessionKey, messageLimitPerSession),
      };
    });

    return {
      exportedAt: Date.now(),
      total: result.total,
      items,
    };
  }

  runCleanup(input: HistoryCleanupRunInput): HistoryCleanupRunRecord {
    const policy = this.getRetentionPolicy();
    const retentionDays = clampInt(input.retentionDays, policy.retentionDays, 1, 3_650);
    const maxDeleteSessions = clampInt(input.maxDeleteSessions, policy.maxDeleteSessions, 1, 10_000);
    const dryRun = input.dryRun ?? false;
    const startedAt = Date.now();
    const cutoffTs = startedAt - retentionDays * ONE_DAY_MS;
    const requestedBy = normalizeOptionalActor(input.requestedBy);

    const lockResult = this.stateStore.acquireHistoryCleanupLock({
      owner: this.cleanupOwner,
      ttlMs: this.cleanupLockTtlMs,
    });
    if (!lockResult.acquired) {
      return this.stateStore.appendHistoryCleanupRun({
        trigger: input.trigger,
        requestedBy,
        dryRun,
        status: "skipped",
        retentionDays,
        maxDeleteSessions,
        cutoffTs,
        scannedSessions: 0,
        scannedMessages: 0,
        deletedSessions: 0,
        deletedMessages: 0,
        hasMore: false,
        sampledSessionKeys: [],
        skippedReason: `lock_not_acquired:${lockResult.owner ?? "unknown"}`,
        startedAt,
        finishedAt: Date.now(),
      });
    }

    try {
      const executed = this.stateStore.executeHistoryCleanup({
        cutoffTs,
        maxDeleteSessions,
        dryRun,
      });
      const run = this.stateStore.appendHistoryCleanupRun({
        trigger: input.trigger,
        requestedBy,
        dryRun,
        status: "succeeded",
        retentionDays,
        maxDeleteSessions,
        cutoffTs,
        scannedSessions: executed.scannedSessions,
        scannedMessages: executed.scannedMessages,
        deletedSessions: executed.deletedSessions,
        deletedMessages: executed.deletedMessages,
        hasMore: executed.hasMore,
        sampledSessionKeys: executed.sampledSessionKeys,
        startedAt,
        finishedAt: Date.now(),
      });
      if (input.trigger === "manual") {
        this.stateStore.appendConfigRevision(
          requestedBy,
          dryRun ? "manual history cleanup dry-run" : "manual history cleanup",
          JSON.stringify({
            type: "history_cleanup_run",
            run,
          }),
        );
      }
      return run;
    } catch (error) {
      const failed = this.stateStore.appendHistoryCleanupRun({
        trigger: input.trigger,
        requestedBy,
        dryRun,
        status: "failed",
        retentionDays,
        maxDeleteSessions,
        cutoffTs,
        scannedSessions: 0,
        scannedMessages: 0,
        deletedSessions: 0,
        deletedMessages: 0,
        hasMore: false,
        sampledSessionKeys: [],
        error: formatError(error),
        startedAt,
        finishedAt: Date.now(),
      });
      if (input.trigger === "manual") {
        this.stateStore.appendConfigRevision(
          requestedBy,
          "manual history cleanup failed",
          JSON.stringify({
            type: "history_cleanup_run_failed",
            runId: failed.id,
            error: failed.error,
          }),
        );
      }
      return failed;
    } finally {
      this.stateStore.releaseHistoryCleanupLock(this.cleanupOwner);
    }
  }

  listCleanupRuns(limit = 20): HistoryCleanupRunRecord[] {
    return this.stateStore.listHistoryCleanupRuns(limit);
  }

  startCleanupScheduler(): void {
    if (this.cleanupTimer) {
      return;
    }
    this.cleanupTimer = setInterval(() => {
      this.runScheduledCleanupTick();
    }, this.cleanupSchedulerPollMs);
    this.cleanupTimer.unref?.();
    this.runScheduledCleanupTick();
  }

  stopCleanupScheduler(): void {
    if (!this.cleanupTimer) {
      return;
    }
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  private runScheduledCleanupTick(): void {
    if (this.cleanupTickRunning) {
      return;
    }
    this.cleanupTickRunning = true;
    try {
      const policy = this.getRetentionPolicy();
      if (!policy.enabled) {
        return;
      }

      const latestScheduledRun = this.stateStore.getLatestHistoryCleanupRun("scheduled");
      const intervalMs = policy.cleanupIntervalMinutes * 60 * 1_000;
      const now = Date.now();
      if (latestScheduledRun && now - latestScheduledRun.startedAt < intervalMs) {
        return;
      }

      const run = this.runCleanup({
        trigger: "scheduled",
        requestedBy: "scheduler",
        dryRun: false,
        retentionDays: policy.retentionDays,
        maxDeleteSessions: policy.maxDeleteSessions,
      });
      if (run.status === "failed") {
        this.logger.error("Scheduled history cleanup failed", {
          runId: run.id,
          error: run.error,
        });
        return;
      }
      if (run.deletedSessions > 0 || run.deletedMessages > 0) {
        this.logger.info("Scheduled history cleanup completed", {
          runId: run.id,
          deletedSessions: run.deletedSessions,
          deletedMessages: run.deletedMessages,
          hasMore: run.hasMore,
        });
      }
    } catch (error) {
      this.logger.error("Scheduled history cleanup tick failed", error);
    } finally {
      this.cleanupTickRunning = false;
    }
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeOptionalActor(actor: string | null | undefined): string | null {
  if (!actor) {
    return null;
  }
  const trimmed = actor.trim();
  return trimmed || null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
