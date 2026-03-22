import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateStore } from "../src/store/state-store";

function createPaths(prefix = "codeharbor-"): { dir: string; db: string; legacy: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    db: path.join(dir, "state.db"),
    legacy: path.join(dir, "state.json"),
  };
}

describe("StateStore", () => {
  it("stores and reads codex session id", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 5, 30, 100);

    expect(store.getCodexSessionId("s1")).toBeNull();
    store.setCodexSessionId("s1", "thread-1");
    expect(store.getCodexSessionId("s1")).toBe("thread-1");
  });

  it("tracks processed events and trims history", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 2, 30, 100);

    expect(store.hasProcessedEvent("s1", "e1")).toBe(false);
    store.markEventProcessed("s1", "e1");
    expect(store.hasProcessedEvent("s1", "e1")).toBe(true);
    store.markEventProcessed("s1", "e2");
    store.markEventProcessed("s1", "e3");

    expect(store.hasProcessedEvent("s1", "e1")).toBe(false);
    store.markEventProcessed("s1", "e1");
    expect(store.hasProcessedEvent("s1", "e1")).toBe(true);
  });

  it("imports legacy state.json into sqlite on first boot", () => {
    const { db, legacy } = createPaths();

    fs.writeFileSync(
      legacy,
      JSON.stringify(
        {
          sessions: {
            old: {
              codexSessionId: "thread-legacy",
              processedEventIds: ["e1", "e2"],
              activeUntil: new Date(Date.now() + 60_000).toISOString(),
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      ),
    );

    const store = new StateStore(db, legacy, 100, 3650, 1000);

    expect(store.getCodexSessionId("old")).toBe("thread-legacy");
    expect(store.hasProcessedEvent("old", "e1")).toBe(true);
    expect(store.getSessionStatus("old").activeUntil).not.toBeNull();
  });

  it("prunes expired sessions when ttl is reached", () => {
    const { db, legacy } = createPaths();
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    fs.writeFileSync(
      legacy,
      JSON.stringify({
        sessions: {
          old: {
            codexSessionId: "thread-1",
            processedEventIds: ["e1"],
            activeUntil: null,
            updatedAt: stale,
          },
        },
      }),
    );

    const store = new StateStore(db, legacy, 10, 1, 100);
    expect(store.getCodexSessionId("old")).toBeNull();
  });

  it("prunes least recently updated sessions when over maxSessions", () => {
    const { db, legacy } = createPaths();

    fs.writeFileSync(
      legacy,
      JSON.stringify(
        {
          sessions: {
            old: {
              codexSessionId: "thread-old",
              processedEventIds: [],
              activeUntil: null,
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            newer: {
              codexSessionId: "thread-newer",
              processedEventIds: [],
              activeUntil: null,
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
            newest: {
              codexSessionId: "thread-newest",
              processedEventIds: [],
              activeUntil: null,
              updatedAt: "2026-01-03T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      ),
    );

    const store = new StateStore(db, legacy, 10, 3650, 2);
    expect(store.getCodexSessionId("old")).toBeNull();
    expect(store.getCodexSessionId("newer")).toBe("thread-newer");
    expect(store.getCodexSessionId("newest")).toBe("thread-newest");
  });

  it("tracks session activation window and status", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    expect(store.isSessionActive("s1")).toBe(false);
    store.activateSession("s1", 60_000);
    expect(store.isSessionActive("s1")).toBe(true);

    const status = store.getSessionStatus("s1");
    expect(status.isActive).toBe(true);
    expect(status.activeUntil).not.toBeNull();

    store.deactivateSession("s1");
    expect(store.isSessionActive("s1")).toBe(false);
  });

  it("stores room settings and config revisions", () => {
    const { db, legacy, dir } = createPaths();
    const projectDir = path.join(dir, "project-a");
    fs.mkdirSync(projectDir, { recursive: true });
    const store = new StateStore(db, legacy, 10, 30, 100);

    store.upsertRoomSettings({
      roomId: "!room:example.com",
      enabled: true,
      allowMention: true,
      allowReply: false,
      allowActiveWindow: true,
      allowPrefix: false,
      workdir: projectDir,
    });
    const room = store.getRoomSettings("!room:example.com");
    expect(room).toEqual(
      expect.objectContaining({
        roomId: "!room:example.com",
        workdir: projectDir,
        allowReply: false,
      }),
    );

    store.appendConfigRevision("tester", "update room config", '{"roomId":"!room:example.com"}');
    const revisions = store.listConfigRevisions(5);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toEqual(
      expect.objectContaining({
        actor: "tester",
        summary: "update room config",
      }),
    );
  });

  it("stores operation audit entries with filters", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    store.appendOperationAuditLog({
      actor: "ops-admin",
      source: "scoped",
      surface: "admin",
      action: "admin.write.config",
      resource: "/api/admin/config/global",
      method: "PUT",
      path: "/api/admin/config/global",
      outcome: "allowed",
      requiredScopes: ["admin.write.config"],
      grantedScopes: ["admin.write"],
      metadata: {
        statusCode: 200,
      },
    });
    store.appendOperationAuditLog({
      actor: null,
      source: "none",
      surface: "api",
      action: "tasks.submit.api",
      resource: "/api/tasks",
      method: "POST",
      path: "/api/tasks",
      outcome: "denied",
      reason: "unauthorized",
      requiredScopes: ["tasks.submit.api"],
      grantedScopes: [],
      metadata: {
        statusCode: 401,
      },
    });

    const all = store.listOperationAuditLogs({ limit: 10 });
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(
      expect.objectContaining({
        surface: "api",
        outcome: "denied",
        reason: "unauthorized",
      }),
    );
    expect(all[1]).toEqual(
      expect.objectContaining({
        surface: "admin",
        outcome: "allowed",
      }),
    );
    expect(all[1]?.requiredScopes).toEqual(["admin.write.config"]);
    expect(all[1]?.grantedScopes).toEqual(["admin.write"]);

    const deniedOnly = store.listOperationAuditLogs({
      limit: 10,
      outcome: "denied",
    });
    expect(deniedOnly).toHaveLength(1);
    expect(deniedOnly[0]?.surface).toBe("api");
  });

  it("stores runtime config snapshots with monotonic version", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    const first = store.upsertRuntimeConfigSnapshot("global_hot_config", '{"matrixTypingTimeoutMs":10000}');
    expect(first.version).toBe(1);

    const second = store.upsertRuntimeConfigSnapshot("global_hot_config", '{"matrixTypingTimeoutMs":15000}');
    expect(second.version).toBe(2);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);

    const loaded = store.getRuntimeConfigSnapshot("global_hot_config");
    expect(loaded).toEqual(
      expect.objectContaining({
        key: "global_hot_config",
        version: 2,
        payloadJson: '{"matrixTypingTimeoutMs":15000}',
      }),
    );
  });

  it("stores latest upgrade run status", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    const runId = store.createUpgradeRun({
      requestedBy: "@alice:example.com",
      targetVersion: "0.1.34",
    });
    let latest = store.getLatestUpgradeRun();
    expect(latest).toEqual(
      expect.objectContaining({
        id: runId,
        requestedBy: "@alice:example.com",
        targetVersion: "0.1.34",
        status: "running",
      }),
    );

    store.finishUpgradeRun(runId, {
      status: "succeeded",
      installedVersion: "0.1.34",
      error: null,
    });

    latest = store.getLatestUpgradeRun();
    expect(latest).toEqual(
      expect.objectContaining({
        id: runId,
        status: "succeeded",
        installedVersion: "0.1.34",
        error: null,
      }),
    );
    expect(latest?.finishedAt).not.toBeNull();
  });

  it("lists recent upgrade runs in reverse chronological order", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    const id1 = store.createUpgradeRun({
      requestedBy: "@alice:example.com",
      targetVersion: "0.1.34",
    });
    store.finishUpgradeRun(id1, {
      status: "succeeded",
      installedVersion: "0.1.34",
      error: null,
    });

    const id2 = store.createUpgradeRun({
      requestedBy: "@alice:example.com",
      targetVersion: null,
    });
    store.finishUpgradeRun(id2, {
      status: "failed",
      installedVersion: null,
      error: "network timeout",
    });

    const id3 = store.createUpgradeRun({
      requestedBy: "@alice:example.com",
      targetVersion: "0.1.35",
    });

    const recent = store.listRecentUpgradeRuns(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.id).toBe(id3);
    expect(recent[0]?.status).toBe("running");
    expect(recent[1]?.id).toBe(id2);
    expect(recent[1]?.status).toBe("failed");
  });

  it("enforces cross-instance upgrade lock lease", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    const acquired = store.acquireUpgradeExecutionLock({
      owner: "instance-a",
      ttlMs: 60_000,
    });
    expect(acquired.acquired).toBe(true);
    expect(acquired.owner).toBe("instance-a");

    const blocked = store.acquireUpgradeExecutionLock({
      owner: "instance-b",
      ttlMs: 60_000,
    });
    expect(blocked.acquired).toBe(false);
    expect(blocked.owner).toBe("instance-a");

    const lock = store.getUpgradeExecutionLock();
    expect(lock).toEqual(
      expect.objectContaining({
        owner: "instance-a",
      }),
    );

    store.releaseUpgradeExecutionLock("instance-a");
    expect(store.getUpgradeExecutionLock()).toBeNull();
  });

  it("reports upgrade run metrics for observability", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    const success = store.createUpgradeRun({
      requestedBy: "@alice:example.com",
      targetVersion: "0.1.37",
    });
    store.finishUpgradeRun(success, {
      status: "succeeded",
      installedVersion: "0.1.37",
      error: null,
    });
    const failed = store.createUpgradeRun({
      requestedBy: "@alice:example.com",
      targetVersion: "0.1.38",
    });
    store.finishUpgradeRun(failed, {
      status: "failed",
      installedVersion: "0.1.37",
      error: "post-check failed",
    });
    store.createUpgradeRun({
      requestedBy: "@alice:example.com",
      targetVersion: null,
    });

    const stats = store.getUpgradeRunStats();
    expect(stats.total).toBe(3);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.running).toBe(1);
    expect(stats.avgDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("deduplicates task queue entries by session and event", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);
    const sessionKey = "matrix:!room:example.com:@alice:example.com";

    const first = store.enqueueTask({
      sessionKey,
      eventId: "$evt-1",
      requestId: "req-1",
      payloadJson: '{"message":"first"}',
    });
    const second = store.enqueueTask({
      sessionKey,
      eventId: "$evt-1",
      requestId: "req-2",
      payloadJson: '{"message":"second"}',
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(store.listTasks(10)).toHaveLength(1);
    expect(store.getTaskQueueStatusCounts()).toEqual({
      pending: 1,
      running: 0,
      succeeded: 0,
      failed: 0,
    });
  });

  it("recovers running tasks and keeps pending order by session", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);
    const sessionA = "matrix:!room-a:example.com:@alice:example.com";
    const sessionB = "matrix:!room-b:example.com:@bob:example.com";

    const taskA1 = store.enqueueTask({
      sessionKey: sessionA,
      eventId: "$a1",
      requestId: "req-a1",
      payloadJson: '{"message":"a1"}',
    });
    const taskA2 = store.enqueueTask({
      sessionKey: sessionA,
      eventId: "$a2",
      requestId: "req-a2",
      payloadJson: '{"message":"a2"}',
    });
    const taskB1 = store.enqueueTask({
      sessionKey: sessionB,
      eventId: "$b1",
      requestId: "req-b1",
      payloadJson: '{"message":"b1"}',
    });

    expect(store.claimNextTask(sessionA)?.id).toBe(taskA1.task.id);
    expect(store.claimNextTask(sessionB)?.id).toBe(taskB1.task.id);

    const recovery = store.recoverTasks(10);
    expect(recovery.requeuedRunning).toBe(2);
    expect(recovery.pendingTotal).toBe(3);
    expect(recovery.tasks.map((task) => task.id)).toEqual([taskA1.task.id, taskA2.task.id, taskB1.task.id]);
    expect(store.listPendingTaskSessions(10)).toEqual([
      {
        sessionKey: sessionA,
        firstTaskId: taskA1.task.id,
      },
      {
        sessionKey: sessionB,
        firstTaskId: taskB1.task.id,
      },
    ]);

    expect(store.claimNextTask(sessionA)?.id).toBe(taskA1.task.id);
    expect(store.claimNextTask(sessionA)?.id).toBe(taskA2.task.id);
    expect(store.claimNextTask(sessionA)).toBeNull();
  });

  it("schedules retry and archives failure records with last error context", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);
    const sessionKey = "matrix:!room-retry:example.com:@alice:example.com";

    const queued = store.enqueueTask({
      sessionKey,
      eventId: "$retry-1",
      requestId: "req-retry-1",
      payloadJson: '{"message":"retry"}',
    });

    const runningAttempt1 = store.claimNextTask(sessionKey);
    expect(runningAttempt1?.attempt).toBe(1);

    const requestedRetryAt = Date.now();
    store.scheduleRetry(queued.task.id, {
      nextRetryAt: requestedRetryAt,
      error: "transient network timeout",
    });

    const pending = store.getTaskById(queued.task.id);
    expect(pending?.status).toBe("pending");
    expect((pending?.nextRetryAt ?? 0) >= requestedRetryAt).toBe(true);
    expect(pending?.lastError).toBe("transient network timeout");

    const runningAttempt2 = store.claimNextTask(sessionKey);
    expect(runningAttempt2?.attempt).toBe(2);

    store.failAndArchive(queued.task.id, {
      error: "permanent auth failure",
      retryReason: "http_403",
      archiveReason: "non_retryable_error",
      retryAfterMs: null,
    });

    const failed = store.getTaskById(queued.task.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("permanent auth failure");
    expect(failed?.lastError).toBe("permanent auth failure");

    const archive = store.listTaskFailureArchive(5);
    expect(archive).toHaveLength(1);
    expect(archive[0]).toEqual(
      expect.objectContaining({
        taskId: queued.task.id,
        attempt: 2,
        error: "permanent auth failure",
        lastError: "transient network timeout",
        retryReason: "http_403",
        archiveReason: "non_retryable_error",
        retryAfterMs: null,
      }),
    );
  });

  it("stores and reads runtime metrics snapshots", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);
    const payload = JSON.stringify({
      generatedAt: "2026-03-18T00:00:00.000Z",
      startedAt: "2026-03-18T00:00:00.000Z",
      activeExecutions: 1,
      request: {
        total: 10,
        outcomes: {
          success: 8,
          failed: 1,
          timeout: 1,
          cancelled: 0,
          rate_limited: 0,
          ignored: 0,
          duplicate: 0,
        },
      },
    });

    expect(store.getRuntimeMetricsSnapshot("orchestrator")).toBeNull();

    store.upsertRuntimeMetricsSnapshot("orchestrator", payload);
    const first = store.getRuntimeMetricsSnapshot("orchestrator");
    expect(first).toEqual(
      expect.objectContaining({
        key: "orchestrator",
        payloadJson: payload,
      }),
    );

    store.upsertRuntimeMetricsSnapshot("orchestrator", payload.replace('"activeExecutions":1', '"activeExecutions":0'));
    const second = store.getRuntimeMetricsSnapshot("orchestrator");
    expect(second?.payloadJson).toContain('"activeExecutions":0');
    expect(second?.updatedAt ?? 0).toBeGreaterThan(0);
  });

  it("stores and loads local conversation history", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    store.appendConversationMessage("s1", "user", "codex", "hello");
    store.appendConversationMessage("s1", "assistant", "codex", "hi");
    store.appendConversationMessage("s1", "assistant", "codex", "   ");

    const messages = store.listRecentConversationMessages("s1", 10);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(
      expect.objectContaining({
        sessionKey: "s1",
        role: "user",
        provider: "codex",
        content: "hello",
      }),
    );
    expect(messages[1]).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: "hi",
      }),
    );
  });

  it("trims local conversation history per session", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    for (let i = 0; i < 205; i += 1) {
      store.appendConversationMessage("s1", "user", "codex", `msg-${i}`);
    }

    const messages = store.listRecentConversationMessages("s1", 300);
    expect(messages).toHaveLength(200);
    expect(messages[0]?.content).toBe("msg-5");
    expect(messages[199]?.content).toBe("msg-204");
  });

  it("lists session history with room/user/time filters", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    const sessionA = "matrix:!room-a:example.com:@alice:example.com";
    const sessionB = "matrix:!room-a:example.com:@bob:example.com";
    const sessionC = "matrix:!room-b:example.com:@alice:example.com";

    store.enqueueTask({
      sessionKey: sessionA,
      eventId: "$a1",
      requestId: "req-a1",
      payloadJson: JSON.stringify({
        message: {
          channel: "matrix",
          conversationId: "!room-a:example.com",
          senderId: "@alice:example.com",
        },
      }),
    });
    store.enqueueTask({
      sessionKey: sessionB,
      eventId: "$b1",
      requestId: "req-b1",
      payloadJson: JSON.stringify({
        message: {
          channel: "matrix",
          conversationId: "!room-a:example.com",
          senderId: "@bob:example.com",
        },
      }),
    });

    store.appendConversationMessage(sessionA, "user", "codex", "hello from alice");
    store.appendConversationMessage(sessionC, "assistant", "codex", "hello from room-b");

    const all = store.listSessionHistory({ limit: 10, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(3);

    const byRoom = store.listSessionHistory({
      roomId: "!room-a:example.com",
      limit: 10,
    });
    expect(byRoom.total).toBe(2);
    expect(byRoom.items.every((item) => item.roomId === "!room-a:example.com")).toBe(true);

    const byUser = store.listSessionHistory({
      userId: "@alice:example.com",
      limit: 10,
    });
    expect(byUser.total).toBe(2);
    expect(byUser.items.every((item) => item.userId === "@alice:example.com")).toBe(true);

    const sessionAEntry = all.items.find((item) => item.sessionKey === sessionA);
    expect(sessionAEntry).toEqual(
      expect.objectContaining({
        roomId: "!room-a:example.com",
        userId: "@alice:example.com",
        messageCount: 1,
      }),
    );

    const paged = store.listSessionHistory({ limit: 1, offset: 1 });
    expect(paged.total).toBe(3);
    expect(paged.items).toHaveLength(1);

    const from = all.items[1]?.updatedAt ?? 0;
    const filteredByTime = store.listSessionHistory({
      from,
      to: Number.MAX_SAFE_INTEGER,
      limit: 10,
    });
    expect(filteredByTime.items.every((item) => item.updatedAt >= from)).toBe(true);
  });

  it("stores history retention policy", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    const defaults = store.getHistoryRetentionPolicy();
    expect(defaults).toEqual(
      expect.objectContaining({
        enabled: false,
        retentionDays: 30,
        cleanupIntervalMinutes: 1440,
        maxDeleteSessions: 500,
      }),
    );

    const updated = store.upsertHistoryRetentionPolicy({
      enabled: true,
      retentionDays: 7,
      cleanupIntervalMinutes: 30,
      maxDeleteSessions: 120,
    });
    expect(updated).toEqual(
      expect.objectContaining({
        enabled: true,
        retentionDays: 7,
        cleanupIntervalMinutes: 30,
        maxDeleteSessions: 120,
      }),
    );

    const loaded = store.getHistoryRetentionPolicy();
    expect(loaded).toEqual(
      expect.objectContaining({
        enabled: true,
        retentionDays: 7,
        cleanupIntervalMinutes: 30,
        maxDeleteSessions: 120,
      }),
    );
  });

  it("supports cleanup dry-run and persists cleanup runs", () => {
    const { db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);

    store.appendConversationMessage("session-a", "user", "codex", "hello a");
    store.appendConversationMessage("session-b", "assistant", "codex", "hello b");

    const dryRun = store.executeHistoryCleanup({
      cutoffTs: Date.now() + 1_000,
      maxDeleteSessions: 1,
      dryRun: true,
    });
    expect(dryRun.scannedSessions).toBe(1);
    expect(dryRun.scannedMessages).toBe(1);
    expect(dryRun.deletedSessions).toBe(0);
    expect(dryRun.hasMore).toBe(true);

    const executed = store.executeHistoryCleanup({
      cutoffTs: Date.now() + 1_000,
      maxDeleteSessions: 1,
      dryRun: false,
    });
    expect(executed.scannedSessions).toBe(1);
    expect(executed.deletedSessions).toBe(1);

    const run = store.appendHistoryCleanupRun({
      trigger: "manual",
      requestedBy: "ops",
      dryRun: false,
      status: "succeeded",
      retentionDays: 1,
      maxDeleteSessions: 100,
      cutoffTs: Date.now() + 1_000,
      scannedSessions: executed.scannedSessions,
      scannedMessages: executed.scannedMessages,
      deletedSessions: executed.deletedSessions,
      deletedMessages: executed.deletedMessages,
      hasMore: executed.hasMore,
      sampledSessionKeys: executed.sampledSessionKeys,
      startedAt: Date.now() - 10,
    });
    expect(run).toEqual(
      expect.objectContaining({
        trigger: "manual",
        requestedBy: "ops",
        status: "succeeded",
      }),
    );

    const latest = store.getLatestHistoryCleanupRun();
    expect(latest?.id).toBe(run.id);
    const listed = store.listHistoryCleanupRuns(5);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(run.id);
  });
});
