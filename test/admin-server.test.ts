import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdminServer } from "../src/admin-server";
import { ConfigService } from "../src/config-service";
import { AppConfig } from "../src/config";
import { Logger } from "../src/logger";
import { GLOBAL_RUNTIME_HOT_CONFIG_KEY } from "../src/runtime-hot-config";
import { StateStore } from "../src/store/state-store";

function createPaths(prefix = "codeharbor-admin-"): { dir: string; db: string; legacy: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    db: path.join(dir, "state.db"),
    legacy: path.join(dir, "state.json"),
  };
}

function createBaseConfig(cwd: string, dbPath: string, legacyPath: string): AppConfig {
  return {
    matrixHomeserver: "https://matrix.example.com",
    matrixUserId: "@bot:example.com",
    matrixAccessToken: "token",
    matrixCommandPrefix: "!code",
    outputLanguage: "zh",
    matrixAdminUsers: [],
    matrixUpgradeAllowedUsers: [],
    aiCliProvider: "codex",
    codexBin: "codex",
    codexModel: null,
    codexWorkdir: cwd,
    codexDangerousBypass: false,
    codexExecTimeoutMs: 600_000,
    codexSandboxMode: null,
    codexApprovalPolicy: null,
    codexExtraArgs: [],
    codexExtraEnv: {},
    agentWorkflow: {
      enabled: false,
      autoRepairMaxRounds: 1,
      roleSkills: {
        enabled: true,
        mode: "progressive",
        maxChars: null,
        roots: [],
        roleAssignments: undefined,
      },
    },
    stateDbPath: dbPath,
    legacyStateJsonPath: legacyPath,
    maxProcessedEventsPerSession: 200,
    maxSessionAgeDays: 30,
    maxSessions: 5000,
    replyChunkSize: 3500,
    matrixProgressUpdates: true,
    matrixProgressMinIntervalMs: 2500,
    matrixTypingTimeoutMs: 10_000,
    sessionActiveWindowMinutes: 20,
    groupDirectModeEnabled: false,
    defaultGroupTriggerPolicy: {
      allowMention: true,
      allowReply: true,
      allowActiveWindow: true,
      allowPrefix: true,
    },
    roomTriggerPolicies: {},
    backendModelRoutingRules: [],
    contextBridgeHistoryLimit: 16,
    contextBridgeMaxChars: 8000,
    rateLimiter: {
      windowMs: 60_000,
      maxRequestsPerUser: 20,
      maxRequestsPerRoom: 120,
      maxConcurrentGlobal: 8,
      maxConcurrentPerUser: 1,
      maxConcurrentPerRoom: 4,
    },
    cliCompat: {
      enabled: false,
      passThroughEvents: false,
      preserveWhitespace: false,
      disableReplyChunkSplit: false,
      progressThrottleMs: 300,
      fetchMedia: false,
      imageMaxBytes: 10485760,
      imageMaxCount: 4,
      imageAllowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      transcribeAudio: false,
      audioTranscribeModel: "gpt-4o-mini-transcribe",
      audioTranscribeTimeoutMs: 120000,
      audioTranscribeMaxChars: 6000,
      audioTranscribeMaxRetries: 1,
      audioTranscribeRetryDelayMs: 800,
      audioTranscribeMaxBytes: 26214400,
      audioLocalWhisperCommand: null,
      audioLocalWhisperTimeoutMs: 180000,
      recordPath: null,
    },
    updateCheck: {
      enabled: true,
      timeoutMs: 3000,
      ttlMs: 21600000,
    },
    doctorHttpTimeoutMs: 10_000,
    apiEnabled: false,
    apiBindHost: "127.0.0.1",
    apiPort: 8788,
    apiToken: null,
    apiTokenScopes: [],
    apiWebhookSecret: null,
    apiWebhookTimestampToleranceSeconds: 300,
    externalTaskIntegration: {
      enabled: false,
      notifyWebhookUrl: null,
      ticketWebhookUrl: null,
      timeoutMs: 3000,
      maxRetries: 1,
      retryDelayMs: 500,
      authToken: null,
    },
    adminBindHost: "127.0.0.1",
    adminPort: 0,
    adminToken: null,
    adminTokens: [],
    adminIpAllowlist: [],
    adminAllowedOrigins: [],
    logLevel: "info",
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: (await response.json()) as unknown,
  };
}

async function fetchText(url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await response.text(),
  };
}

describe("AdminServer", () => {
  const startedServers: AdminServer[] = [];

  afterEach(async () => {
    while (startedServers.length > 0) {
      const server = startedServers.pop();
      if (!server) {
        continue;
      }
      await server.stop();
    }
  });

  it("serves room config API and audit entries", async () => {
    const { dir, db, legacy } = createPaths();
    const projectDir = path.join(dir, "project-a");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".env.example"), "MATRIX_COMMAND_PREFIX=!code\n", "utf8");

    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    expect(address).not.toBeNull();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const roomId = "!room:example.com";
    const put = await fetchJson(`${baseUrl}/api/admin/config/rooms/${encodeURIComponent(roomId)}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "tester",
      },
      body: JSON.stringify({
        enabled: true,
        allowMention: true,
        allowReply: false,
        allowActiveWindow: true,
        allowPrefix: true,
        workdir: projectDir,
        summary: "bind room",
      }),
    });
    expect(put.status).toBe(200);

    const list = await fetchJson(`${baseUrl}/api/admin/config/rooms`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(roomId);

    const audit = await fetchJson(`${baseUrl}/api/admin/audit?limit=5`);
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).toContain("bind room");
    expect(JSON.stringify(audit.body)).toContain("createdAtIso");
  });

  it("validates global and room config payloads before apply", async () => {
    const { dir, db, legacy } = createPaths();
    const roomWorkdir = path.join(dir, "room-workdir");
    fs.mkdirSync(roomWorkdir, { recursive: true });
    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const invalidGlobal = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "global",
        data: {
          rateLimiter: {
            maxConcurrentGlobal: 1,
            maxConcurrentPerUser: 2,
          },
        },
      }),
    });
    expect(invalidGlobal.status).toBe(400);
    expect(JSON.stringify(invalidGlobal.body)).toContain("maxConcurrentPerUser");

    const validGlobal = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "global",
        data: {
          matrixTypingTimeoutMs: 15000,
        },
      }),
    });
    expect(validGlobal.status).toBe(200);
    expect(JSON.stringify(validGlobal.body)).toContain("matrixTypingTimeoutMs");

    const validAutoDevConfig = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "global",
        data: {
          autoDev: {
            loopMaxRuns: 12,
            loopMaxMinutes: 90,
            autoCommit: true,
            autoReleaseEnabled: true,
            autoReleasePush: true,
            runArchiveEnabled: true,
            runArchiveDir: ".codeharbor/autodev-runs",
            validationStrict: true,
            stageOutputEchoEnabled: true,
            maxConsecutiveFailures: 4,
            initEnhancementEnabled: true,
            initEnhancementTimeoutMs: 120000,
            initEnhancementMaxChars: 2500,
          },
        },
      }),
    });
    expect(validAutoDevConfig.status).toBe(200);
    expect(JSON.stringify(validAutoDevConfig.body)).toContain("autoDev.initEnhancementTimeoutMs");
    expect(JSON.stringify(validAutoDevConfig.body)).toContain("autoDev.validationStrict");

    const invalidRoleSkills = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "global",
        data: {
          agentWorkflow: {
            roleSkills: {
              mode: "invalid-mode",
            },
          },
        },
      }),
    });
    expect(invalidRoleSkills.status).toBe(400);
    expect(JSON.stringify(invalidRoleSkills.body)).toContain("roleSkills.mode");

    const validRoleSkills = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "global",
        data: {
          agentWorkflow: {
            roleSkills: {
              mode: "summary",
              maxChars: null,
              roots: [path.join(dir, "skills")],
              roleAssignments: {
                planner: ["task-planner"],
                reviewer: ["code-reviewer"],
              },
            },
          },
        },
      }),
    });
    expect(validRoleSkills.status).toBe(200);
    expect(JSON.stringify(validRoleSkills.body)).toContain("agentWorkflow.roleSkills.mode");

    const invalidCliMimeTypes = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "global",
        data: {
          cliCompat: {
            imageAllowedMimeTypes: "not-a-mime",
          },
        },
      }),
    });
    expect(invalidCliMimeTypes.status).toBe(400);
    expect(JSON.stringify(invalidCliMimeTypes.body)).toContain("imageAllowedMimeTypes");

    const invalidEnvOverrides = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "global",
        data: {
          envOverrides: {
            UNKNOWN_KEY: "x",
          },
        },
      }),
    });
    expect(invalidEnvOverrides.status).toBe(400);
    expect(JSON.stringify(invalidEnvOverrides.body)).toContain("UNKNOWN_KEY");

    const invalidAutoDevOverride = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "global",
        data: {
          envOverrides: {
            AUTODEV_AUTO_COMMIT: "maybe",
          },
        },
      }),
    });
    expect(invalidAutoDevOverride.status).toBe(400);
    expect(JSON.stringify(invalidAutoDevOverride.body)).toContain("AUTODEV_AUTO_COMMIT");

    const invalidLaunchdOverride = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "global",
        data: {
          envOverrides: {
            CODEHARBOR_LAUNCHD_MAIN_LABEL: "bad label with space",
          },
        },
      }),
    });
    expect(invalidLaunchdOverride.status).toBe(400);
    expect(JSON.stringify(invalidLaunchdOverride.body)).toContain("CODEHARBOR_LAUNCHD_MAIN_LABEL");

    const validEnvOverrides = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "global",
        data: {
          envOverrides: {
            MATRIX_ADMIN_USERS: "@ops:example.com",
            AUTODEV_LOOP_MAX_RUNS: "12",
            AUTODEV_GIT_AUTHOR_NAME: "CI Bot",
            AUTODEV_GIT_AUTHOR_EMAIL: "ci@example.com",
            AUTODEV_VALIDATION_STRICT: "true",
            AUTODEV_PREFLIGHT_AUTO_STASH: "true",
            AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS: "9000",
            CODEHARBOR_LAUNCHD_MAIN_LABEL: "com.custom.main",
          },
        },
      }),
    });
    expect(validEnvOverrides.status).toBe(200);
    expect(JSON.stringify(validEnvOverrides.body)).toContain("envOverrides.MATRIX_ADMIN_USERS");
    expect(JSON.stringify(validEnvOverrides.body)).toContain("envOverrides.AUTODEV_LOOP_MAX_RUNS");
    expect(JSON.stringify(validEnvOverrides.body)).toContain("envOverrides.AUTODEV_GIT_AUTHOR_NAME");
    expect(JSON.stringify(validEnvOverrides.body)).toContain("envOverrides.AUTODEV_GIT_AUTHOR_EMAIL");
    expect(JSON.stringify(validEnvOverrides.body)).toContain("envOverrides.AUTODEV_VALIDATION_STRICT");
    expect(JSON.stringify(validEnvOverrides.body)).toContain("envOverrides.AUTODEV_PREFLIGHT_AUTO_STASH");

    const invalidRoom = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "room",
        data: {
          roomId: "!room-validate:example.com",
          workdir: path.join(dir, "missing"),
        },
      }),
    });
    expect(invalidRoom.status).toBe(400);
    expect(JSON.stringify(invalidRoom.body)).toContain("workdir");

    const validRoom = await fetchJson(`${baseUrl}/api/admin/config/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kind: "room",
        data: {
          roomId: "!room-validate:example.com",
          enabled: true,
          allowMention: true,
          allowReply: true,
          allowActiveWindow: true,
          allowPrefix: true,
          workdir: roomWorkdir,
        },
      }),
    });
    expect(validRoom.status).toBe(200);
    expect(JSON.stringify(validRoom.body)).toContain("roomId");
  });

  it("supports diagnostics plus config export and import", async () => {
    const { dir, db, legacy } = createPaths();
    const roomA = path.join(dir, "project-a");
    const roomB = path.join(dir, "project-b");
    fs.mkdirSync(roomA, { recursive: true });
    fs.mkdirSync(roomB, { recursive: true });

    const config = createBaseConfig(dir, db, legacy);
    config.adminPort = 8787;
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    stateStore.upsertRoomSettings({
      roomId: "!room-a:example.com",
      enabled: true,
      allowMention: true,
      allowReply: false,
      allowActiveWindow: true,
      allowPrefix: true,
      workdir: roomA,
    });
    stateStore.upsertRuntimeMetricsSnapshot(
      "orchestrator",
      JSON.stringify({
        generatedAt: "2026-03-22T00:00:10.000Z",
        startedAt: "2026-03-22T00:00:00.000Z",
        activeExecutions: 2,
        request: {
          total: 5,
          outcomes: {
            success: 4,
            failed: 1,
            timeout: 0,
            cancelled: 0,
            rate_limited: 0,
            ignored: 0,
            duplicate: 0,
          },
          queueDurationMs: {
            buckets: [10, 50],
            counts: [1, 1, 3],
            count: 5,
            sum: 130,
          },
          executionDurationMs: {
            buckets: [100, 500],
            counts: [1, 1, 3],
            count: 5,
            sum: 2100,
          },
          sendDurationMs: {
            buckets: [10, 100],
            counts: [2, 1, 2],
            count: 5,
            sum: 68,
          },
        },
        limiter: {
          activeGlobal: 2,
          activeUsers: 2,
          activeRooms: 1,
        },
        autodev: {
          runs: {
            succeeded: 2,
            failed: 1,
            cancelled: 0,
          },
          loopStops: {
            no_task: 0,
            drained: 1,
            max_runs: 0,
            deadline: 0,
            stop_requested: 0,
            no_progress: 0,
            task_incomplete: 0,
          },
          tasksBlocked: 0,
        },
      }),
    );

    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const diagnostics = await fetchJson(`${baseUrl}/api/admin/diagnostics`);
    expect(diagnostics.status).toBe(200);
    expect(JSON.stringify(diagnostics.body)).toContain('"metricsSnapshotAvailable":true');
    expect(JSON.stringify(diagnostics.body)).toContain('"roomSettingsCount":1');

    const exported = await fetchJson(`${baseUrl}/api/admin/config/export`);
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).toContain('"schemaVersion":1');
    expect(JSON.stringify(exported.body)).toContain("!room-a:example.com");

    const exportedPayload = exported.body as {
      data?: {
        env?: Record<string, string>;
        rooms?: Array<{
          roomId: string;
          enabled: boolean;
          allowMention: boolean;
          allowReply: boolean;
          allowActiveWindow: boolean;
          allowPrefix: boolean;
          workdir: string;
        }>;
      };
    };
    const snapshot = exportedPayload.data;
    expect(snapshot).toBeDefined();
    expect(snapshot?.env).toBeDefined();
    expect(snapshot?.rooms).toBeDefined();
    snapshot!.env!.MATRIX_COMMAND_PREFIX = "!imported";
    snapshot!.rooms = [
      {
        roomId: "!room-b:example.com",
        enabled: true,
        allowMention: true,
        allowReply: true,
        allowActiveWindow: true,
        allowPrefix: true,
        workdir: roomB,
      },
    ];

    const dryRun = await fetchJson(`${baseUrl}/api/admin/config/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "tester-import",
      },
      body: JSON.stringify({
        dryRun: true,
        snapshot,
      }),
    });
    expect(dryRun.status).toBe(200);
    expect(JSON.stringify(dryRun.body)).toContain('"dryRun":true');

    const imported = await fetchJson(`${baseUrl}/api/admin/config/import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "tester-import",
      },
      body: JSON.stringify({
        dryRun: false,
        snapshot,
      }),
    });
    expect(imported.status).toBe(200);
    expect(JSON.stringify(imported.body)).toContain('"restartRequired":true');

    const envRaw = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(envRaw).toContain('MATRIX_COMMAND_PREFIX="!imported"');

    const rooms = await fetchJson(`${baseUrl}/api/admin/config/rooms`);
    expect(rooms.status).toBe(200);
    expect(JSON.stringify(rooms.body)).toContain("!room-b:example.com");

    const audit = await fetchJson(`${baseUrl}/api/admin/audit?limit=20`);
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).toContain("config_snapshot_import");
  });

  it("returns app version info in health response", async () => {
    const { dir, db, legacy } = createPaths();
    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
      packageUpdateChecker: {
        getStatus: async () => ({
          packageName: "codeharbor",
          currentVersion: "0.1.27",
          latestVersion: "0.1.28",
          state: "update_available",
          checkedAt: new Date().toISOString(),
          error: null,
          upgradeCommand: "npm install -g codeharbor@latest",
        }),
      },
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const health = await fetchJson(`${baseUrl}/api/admin/health`);
    expect(health.status).toBe(200);
    expect(JSON.stringify(health.body)).toContain('"currentVersion":"0.1.27"');
    expect(JSON.stringify(health.body)).toContain('"latestVersion":"0.1.28"');
    expect(JSON.stringify(health.body)).toContain('"state":"update_available"');
  });

  it("serves session history index and filtered message history", async () => {
    const { dir, db, legacy } = createPaths();
    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");

    const sessionKey = "matrix:!room-history:example.com:@alice:example.com";
    stateStore.enqueueTask({
      sessionKey,
      eventId: "$history-1",
      requestId: "req-history-1",
      payloadJson: JSON.stringify({
        message: {
          channel: "matrix",
          conversationId: "!room-history:example.com",
          senderId: "@alice:example.com",
        },
      }),
    });
    stateStore.appendConversationMessage(sessionKey, "user", "codex", "hello history");
    stateStore.appendConversationMessage(sessionKey, "assistant", "codex", "history reply");

    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const sessions = await fetchJson(
      `${baseUrl}/api/admin/sessions?roomId=${encodeURIComponent("!room-history:example.com")}&userId=${encodeURIComponent("@alice:example.com")}&limit=10&offset=0`,
    );
    expect(sessions.status).toBe(200);
    expect(JSON.stringify(sessions.body)).toContain(sessionKey);
    expect(JSON.stringify(sessions.body)).toContain('"messageCount":2');
    expect(JSON.stringify(sessions.body)).toContain("updatedAtIso");

    const messages = await fetchJson(`${baseUrl}/api/admin/sessions/${encodeURIComponent(sessionKey)}/messages?limit=2`);
    expect(messages.status).toBe(200);
    expect(JSON.stringify(messages.body)).toContain("hello history");
    expect(JSON.stringify(messages.body)).toContain("history reply");
    expect(JSON.stringify(messages.body)).toContain("createdAtIso");

    const invalidWindow = await fetchJson(`${baseUrl}/api/admin/sessions?from=200&to=100`);
    expect(invalidWindow.status).toBe(400);
    expect(JSON.stringify(invalidWindow.body)).toContain("from must be less than or equal to to");
  });

  it("exports session history and supports retention policy cleanup", async () => {
    const { dir, db, legacy } = createPaths();
    const staleSessionKey = "matrix:!room-stale:example.com:@legacy:example.com";
    fs.writeFileSync(
      legacy,
      JSON.stringify({
        sessions: {
          [staleSessionKey]: {
            codexSessionId: "thread-stale",
            processedEventIds: [],
            activeUntil: null,
            updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString(),
          },
        },
      }),
      "utf8",
    );

    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");

    const exportSessionKey = "matrix:!room-export:example.com:@alice:example.com";
    stateStore.enqueueTask({
      sessionKey: exportSessionKey,
      eventId: "$export-1",
      requestId: "req-export-1",
      payloadJson: JSON.stringify({
        message: {
          channel: "matrix",
          conversationId: "!room-export:example.com",
          senderId: "@alice:example.com",
        },
      }),
    });
    stateStore.appendConversationMessage(exportSessionKey, "user", "codex", "export me");

    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const exported = await fetchJson(
      `${baseUrl}/api/admin/sessions/export?roomId=${encodeURIComponent("!room-export:example.com")}&includeMessages=true&messageLimitPerSession=10`,
    );
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).toContain(exportSessionKey);
    expect(JSON.stringify(exported.body)).toContain("export me");
    expect(JSON.stringify(exported.body)).toContain("exportedAtIso");

    const policy = await fetchJson(`${baseUrl}/api/admin/history/retention`);
    expect(policy.status).toBe(200);
    expect(JSON.stringify(policy.body)).toContain('"retentionDays":30');

    const updatedPolicy = await fetchJson(`${baseUrl}/api/admin/history/retention`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "ops-history",
      },
      body: JSON.stringify({
        enabled: true,
        retentionDays: 1,
        cleanupIntervalMinutes: 60,
        maxDeleteSessions: 50,
      }),
    });
    expect(updatedPolicy.status).toBe(200);
    expect(JSON.stringify(updatedPolicy.body)).toContain('"enabled":true');
    expect(JSON.stringify(updatedPolicy.body)).toContain('"cleanupIntervalMinutes":60');

    const cleanup = await fetchJson(`${baseUrl}/api/admin/history/cleanup`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "ops-history",
      },
      body: JSON.stringify({
        dryRun: false,
        retentionDays: 1,
        maxDeleteSessions: 50,
      }),
    });
    expect(cleanup.status).toBe(200);
    expect(JSON.stringify(cleanup.body)).toContain('"status":"succeeded"');
    expect(JSON.stringify(cleanup.body)).toContain('"deletedSessions":1');

    const staleSessions = await fetchJson(
      `${baseUrl}/api/admin/sessions?roomId=${encodeURIComponent("!room-stale:example.com")}&limit=10`,
    );
    expect(staleSessions.status).toBe(200);
    expect(JSON.stringify(staleSessions.body)).toContain('"total":0');

    const runs = await fetchJson(`${baseUrl}/api/admin/history/cleanup/runs?limit=5`);
    expect(runs.status).toBe(200);
    expect(JSON.stringify(runs.body)).toContain('"trigger":"manual"');
    expect(JSON.stringify(runs.body)).toContain("cutoffTsIso");
  });

  it("serves Prometheus metrics on /metrics", async () => {
    const { dir, db, legacy } = createPaths();
    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    stateStore.createUpgradeRun({ requestedBy: "ops", targetVersion: "0.1.41" });
    const succeededRunId = stateStore.createUpgradeRun({ requestedBy: "ops", targetVersion: "0.1.42" });
    stateStore.finishUpgradeRun(succeededRunId, {
      status: "succeeded",
      installedVersion: "0.1.42",
      error: null,
    });
    const failedRunId = stateStore.createUpgradeRun({ requestedBy: "ops", targetVersion: "0.1.43" });
    stateStore.finishUpgradeRun(failedRunId, {
      status: "failed",
      installedVersion: null,
      error: "network error",
    });
    stateStore.upsertRuntimeMetricsSnapshot(
      "orchestrator",
      JSON.stringify({
        generatedAt: "2026-03-18T00:00:10.000Z",
        startedAt: "2026-03-18T00:00:00.000Z",
        activeExecutions: 1,
        request: {
          total: 3,
          outcomes: {
            success: 2,
            failed: 1,
            timeout: 0,
            cancelled: 0,
            rate_limited: 0,
            ignored: 0,
            duplicate: 0,
          },
          queueDurationMs: {
            buckets: [10, 50],
            counts: [1, 1, 1],
            count: 3,
            sum: 61,
          },
          executionDurationMs: {
            buckets: [100, 500],
            counts: [1, 1, 1],
            count: 3,
            sum: 820,
          },
          sendDurationMs: {
            buckets: [10, 100],
            counts: [2, 0, 1],
            count: 3,
            sum: 35,
          },
        },
        limiter: {
          activeGlobal: 1,
          activeUsers: 1,
          activeRooms: 1,
        },
        autodev: {
          runs: {
            succeeded: 4,
            failed: 2,
            cancelled: 1,
          },
          loopStops: {
            no_task: 1,
            drained: 2,
            max_runs: 3,
            deadline: 1,
            stop_requested: 1,
            no_progress: 0,
            task_incomplete: 2,
          },
          tasksBlocked: 2,
        },
      }),
    );
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const metrics = await fetch(`${baseUrl}/metrics`);
    const text = await metrics.text();
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    expect(text).toContain("codeharbor_up 1");
    expect(text).toContain('codeharbor_requests_total{outcome="success"} 2');
    expect(text).toContain('codeharbor_rate_limiter_active{scope="global"} 1');
    expect(text).toContain("codeharbor_request_execution_duration_ms_bucket");
    expect(text).toContain('codeharbor_upgrade_runs_total{status="running"} 1');
    expect(text).toContain('codeharbor_upgrade_runs_total{status="succeeded"} 1');
    expect(text).toContain('codeharbor_upgrade_runs_total{status="failed"} 1');
    expect(text).toContain('codeharbor_upgrade_last_run_status{status="failed"} 1');
    expect(text).toContain('codeharbor_autodev_runs_total{outcome="succeeded"} 4');
    expect(text).toContain('codeharbor_autodev_loop_stops_total{reason="max_runs"} 3');
    expect(text).toContain("codeharbor_autodev_tasks_blocked_total 2");
  });

  it("requires viewer auth for /metrics when token is configured", async () => {
    const { dir, db, legacy } = createPaths();
    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      adminTokens: [
        { token: "viewer-token", role: "viewer", actor: "ops-viewer" },
        { token: "admin-token", role: "admin", actor: "ops-admin" },
      ],
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const unauthorized = await fetch(`${baseUrl}/metrics`);
    expect(unauthorized.status).toBe(401);

    const viewerAuthorized = await fetch(`${baseUrl}/metrics`, {
      headers: {
        authorization: "Bearer viewer-token",
      },
    });
    expect(viewerAuthorized.status).toBe(200);

    const adminAuthorized = await fetch(`${baseUrl}/metrics`, {
      headers: {
        authorization: "Bearer admin-token",
      },
    });
    expect(adminAuthorized.status).toBe(200);
  });

  it("requires token when ADMIN_TOKEN is configured", async () => {
    const { dir, db, legacy } = createPaths();
    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: "secret-token",
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const unauthorized = await fetchJson(`${baseUrl}/api/admin/config/global`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetchJson(`${baseUrl}/api/admin/config/global`, {
      headers: {
        authorization: "Bearer secret-token",
      },
    });
    expect(authorized.status).toBe(200);

    const ui = await fetchText(`${baseUrl}/`);
    expect(ui.status).toBe(200);
    expect(ui.body).toContain("CodeHarbor Admin Console");
  });

  it("supports scoped admin/viewer tokens with write protection", async () => {
    const { dir, db, legacy } = createPaths();
    fs.writeFileSync(path.join(dir, ".env.example"), "MATRIX_COMMAND_PREFIX=!code\n", "utf8");

    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      adminTokens: [
        { token: "viewer-token", role: "viewer", actor: "ops-viewer" },
        { token: "admin-token", role: "admin", actor: "ops-admin" },
      ],
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const viewerRead = await fetchJson(`${baseUrl}/api/admin/config/global`, {
      headers: {
        authorization: "Bearer viewer-token",
      },
    });
    expect(viewerRead.status).toBe(200);

    const viewerExport = await fetchJson(`${baseUrl}/api/admin/config/export`, {
      headers: {
        authorization: "Bearer viewer-token",
      },
    });
    expect(viewerExport.status).toBe(403);
    expect(JSON.stringify(viewerExport.body)).toContain("admin.write");

    const viewerSessionsRead = await fetchJson(`${baseUrl}/api/admin/sessions`, {
      headers: {
        authorization: "Bearer viewer-token",
      },
    });
    expect(viewerSessionsRead.status).toBe(200);

    const viewerStatus = await fetchJson(`${baseUrl}/api/admin/auth/status`, {
      headers: {
        authorization: "Bearer viewer-token",
      },
    });
    expect(viewerStatus.status).toBe(200);
    expect(JSON.stringify(viewerStatus.body)).toContain('"role":"viewer"');
    expect(JSON.stringify(viewerStatus.body)).toContain('"canWrite":false');

    const viewerWrite = await fetchJson(`${baseUrl}/api/admin/config/global`, {
      method: "PUT",
      headers: {
        authorization: "Bearer viewer-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        matrixCommandPrefix: "!viewer",
      }),
    });
    expect(viewerWrite.status).toBe(403);

    const adminWrite = await fetchJson(`${baseUrl}/api/admin/config/global`, {
      method: "PUT",
      headers: {
        authorization: "Bearer admin-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        matrixCommandPrefix: "!admin",
      }),
    });
    expect(adminWrite.status).toBe(200);

    const adminExport = await fetchJson(`${baseUrl}/api/admin/config/export`, {
      headers: {
        authorization: "Bearer admin-token",
      },
    });
    expect(adminExport.status).toBe(200);
    expect(JSON.stringify(adminExport.body)).toContain('"schemaVersion":1');
  });

  it("supports custom token scopes and exposes operation audit logs", async () => {
    const { dir, db, legacy } = createPaths();
    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      adminTokens: [
        {
          token: "audit-token",
          role: "viewer",
          actor: "ops-audit",
          scopes: ["admin.read.auth", "admin.read.audit"],
        },
      ],
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const deniedRead = await fetchJson(`${baseUrl}/api/admin/config/global`, {
      headers: {
        authorization: "Bearer audit-token",
      },
    });
    expect(deniedRead.status).toBe(403);
    expect(JSON.stringify(deniedRead.body)).toContain("admin.read.config");

    const operations = await fetchJson(`${baseUrl}/api/admin/audit?kind=operations&limit=20`, {
      headers: {
        authorization: "Bearer audit-token",
      },
    });
    expect(operations.status).toBe(200);
    const operationsText = JSON.stringify(operations.body);
    expect(operationsText).toContain('"kind":"operation"');
    expect(operationsText).toContain('"outcome":"denied"');
    expect(operationsText).toContain("/api/admin/config/global");
    expect(operationsText).toContain("missing_scope:admin.read.config");
    expect(operationsText).toContain('"actor":"ops-audit"');
  });

  it("records allowed read operations and supports operation audit filters", async () => {
    const { dir, db, legacy } = createPaths();
    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      adminTokens: [
        {
          token: "read-token",
          role: "viewer",
          actor: "ops-read",
          scopes: ["admin.read.config", "admin.read.audit"],
        },
      ],
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const readGlobal = await fetchJson(`${baseUrl}/api/admin/config/global`, {
      headers: {
        authorization: "Bearer read-token",
        "x-request-id": "req-read-1",
      },
    });
    expect(readGlobal.status).toBe(200);

    const operations = await fetchJson(
      `${baseUrl}/api/admin/audit?kind=operations&limit=20&surface=admin&outcome=allowed&actor=ops-read&action=admin.read.config&method=get&pathPrefix=/api/admin/config&createdFrom=1`,
      {
        headers: {
          authorization: "Bearer read-token",
        },
      },
    );
    expect(operations.status).toBe(200);
    const operationsText = JSON.stringify(operations.body);
    expect(operationsText).toContain('"kind":"operation"');
    expect(operationsText).toContain('"action":"admin.read.config"');
    expect(operationsText).toContain('"/api/admin/config/global"');
    expect(operationsText).toContain('"outcome":"allowed"');
    expect(operationsText).toContain('"requestId":"req-read-1"');
  });

  it("records service restart failures as operation audit errors", async () => {
    const { dir, db, legacy } = createPaths();
    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      adminTokens: [
        {
          token: "service-admin",
          role: "admin",
          actor: "ops-service",
          scopes: ["admin.write.service", "admin.read.audit"],
        },
      ],
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
      restartServices: async () => {
        throw new Error("systemctl permission denied");
      },
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const restart = await fetchJson(`${baseUrl}/api/admin/service/restart`, {
      method: "POST",
      headers: {
        authorization: "Bearer service-admin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        withAdmin: true,
      }),
    });
    expect(restart.status).toBe(500);
    expect(JSON.stringify(restart.body)).toContain("Service restart failed");

    const operations = await fetchJson(`${baseUrl}/api/admin/audit?kind=operations&limit=20&outcome=error`, {
      headers: {
        authorization: "Bearer service-admin",
      },
    });
    expect(operations.status).toBe(200);
    const operationsText = JSON.stringify(operations.body);
    expect(operationsText).toContain('"/api/admin/service/restart"');
    expect(operationsText).toContain('"outcome":"error"');
    expect(operationsText).toContain('"statusCode":500');
    expect(operationsText).toContain("Service restart failed");
    expect(operationsText).not.toContain('"outcome":"allowed"');
  });

  it("rejects oversized JSON request payloads", async () => {
    const { dir, db, legacy } = createPaths();
    fs.writeFileSync(path.join(dir, ".env.example"), "MATRIX_COMMAND_PREFIX=!code\n", "utf8");

    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const oversizedPayload = JSON.stringify({
      matrixCommandPrefix: `!${"x".repeat(1_100_000)}`,
    });
    const response = await fetchJson(`${baseUrl}/api/admin/config/global`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: oversizedPayload,
    });

    expect(response.status).toBe(413);
    expect(JSON.stringify(response.body)).toContain("Request body too large");
  });

  it("derives audit actor from scoped token identity", async () => {
    const { dir, db, legacy } = createPaths();
    fs.writeFileSync(path.join(dir, ".env.example"), "MATRIX_COMMAND_PREFIX=!code\n", "utf8");

    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      adminTokens: [{ token: "admin-token", role: "admin", actor: "ops-admin" }],
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const updated = await fetchJson(`${baseUrl}/api/admin/config/global`, {
      method: "PUT",
      headers: {
        authorization: "Bearer admin-token",
        "content-type": "application/json",
        "x-admin-actor": "spoofed-actor",
      },
      body: JSON.stringify({
        matrixCommandPrefix: "!secure",
      }),
    });
    expect(updated.status).toBe(200);

    const audit = await fetchJson(`${baseUrl}/api/admin/audit?limit=5`, {
      headers: {
        authorization: "Bearer admin-token",
      },
    });
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).toContain('"actor":"ops-admin"');
    expect(JSON.stringify(audit.body)).not.toContain("spoofed-actor");
  });

  it("writes supported global config changes into .env", async () => {
    const { dir, db, legacy } = createPaths();
    fs.writeFileSync(
      path.join(dir, ".env.example"),
      [
        "MATRIX_COMMAND_PREFIX=!code",
        "OUTPUT_LANGUAGE=zh",
        "RATE_LIMIT_MAX_CONCURRENT_GLOBAL=8",
        "CODEX_WORKDIR=/tmp/old",
        "AGENT_WORKFLOW_ENABLED=false",
        "AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS=1",
        "AGENT_WORKFLOW_ROLE_SKILLS_ENABLED=true",
        "AGENT_WORKFLOW_ROLE_SKILLS_MODE=progressive",
        "AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS=",
        "AGENT_WORKFLOW_ROLE_SKILLS_ROOTS=",
        "AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON=",
        "CODEHARBOR_LAUNCHD_MAIN_LABEL=com.codeharbor.main",
        "CODEHARBOR_LAUNCHD_ADMIN_LABEL=com.codeharbor.admin",
        "CLI_COMPAT_IMAGE_MAX_BYTES=10485760",
        "CLI_COMPAT_IMAGE_MAX_COUNT=4",
        "CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES=image/png,image/jpeg,image/webp,image/gif",
        "CLI_COMPAT_RECORD_PATH=",
      ].join("\n"),
      "utf8",
    );

    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const updated = await fetchJson(`${baseUrl}/api/admin/config/global`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        matrixCommandPrefix: "!ai",
        outputLanguage: "en",
        codexWorkdir: dir,
        rateLimiter: {
          maxConcurrentGlobal: 12,
        },
        agentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 2,
          roleSkills: {
            enabled: true,
            mode: "full",
            maxChars: 3200,
            roots: [path.join(dir, "skills-a"), path.join(dir, "skills-b")],
            roleAssignments: {
              planner: ["task-planner", "builtin-planner-core"],
              executor: ["autonomous-dev"],
              reviewer: ["code-reviewer", "builtin-reviewer-core"],
            },
          },
        },
        autoDev: {
          loopMaxRuns: 11,
          loopMaxMinutes: 75,
          autoCommit: true,
          gitAuthorName: "Auto Bot",
          gitAuthorEmail: "autobot@example.com",
          autoReleaseEnabled: true,
          autoReleasePush: false,
          runArchiveEnabled: true,
          runArchiveDir: ".codeharbor/autodev-runs",
          validationStrict: true,
          stageOutputEchoEnabled: true,
          maxConsecutiveFailures: 4,
          initEnhancementEnabled: true,
          initEnhancementTimeoutMs: 240000,
          initEnhancementMaxChars: 3200,
        },
        cliCompat: {
          imageMaxBytes: 2097152,
          imageMaxCount: 6,
          imageAllowedMimeTypes: ["image/png", "image/webp"],
          recordPath: path.join(dir, "logs", "cli-record.ndjson"),
        },
        envOverrides: {
          MATRIX_ADMIN_USERS: "@ops:example.com,@oncall:example.com",
          CONTEXT_BRIDGE_HISTORY_LIMIT: "24",
          AUTODEV_LOOP_MAX_RUNS: "9",
          AUTODEV_LOOP_MAX_MINUTES: "60",
          AUTODEV_AUTO_COMMIT: "false",
          AUTODEV_GIT_AUTHOR_NAME: "CI Bot",
          AUTODEV_GIT_AUTHOR_EMAIL: "ci@example.com",
          AUTODEV_AUTO_RELEASE_ENABLED: "false",
          AUTODEV_AUTO_RELEASE_PUSH: "true",
          AUTODEV_RUN_ARCHIVE_ENABLED: "false",
          AUTODEV_RUN_ARCHIVE_DIR: ".codeharbor/autodev-runs-custom",
          AUTODEV_VALIDATION_STRICT: "false",
          AUTODEV_STAGE_OUTPUT_ECHO_ENABLED: "false",
          AUTODEV_PREFLIGHT_AUTO_STASH: "true",
          AUTODEV_MAX_CONSECUTIVE_FAILURES: "5",
          AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS: "7000",
          AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS: "10000",
          AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS: "",
          CODEHARBOR_LAUNCHD_MAIN_LABEL: "com.custom.main",
          CODEHARBOR_LAUNCHD_ADMIN_LABEL: "com.custom.admin",
        },
        updateCheck: {
          enabled: false,
          timeoutMs: 2000,
          ttlMs: 600000,
        },
      }),
    });
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.body)).toContain("restartRequired");

    const envRaw = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(envRaw).toContain('MATRIX_COMMAND_PREFIX="!ai"');
    expect(envRaw).toContain("OUTPUT_LANGUAGE=en");
    expect(envRaw).toContain(`CODEX_WORKDIR=${dir}`);
    expect(envRaw).toContain("RATE_LIMIT_MAX_CONCURRENT_GLOBAL=12");
    expect(envRaw).toContain("AGENT_WORKFLOW_ENABLED=true");
    expect(envRaw).toContain("AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS=2");
    expect(envRaw).toContain("AGENT_WORKFLOW_ROLE_SKILLS_ENABLED=true");
    expect(envRaw).toContain("AGENT_WORKFLOW_ROLE_SKILLS_MODE=full");
    expect(envRaw).toContain("AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS=3200");
    expect(envRaw).toContain(`AGENT_WORKFLOW_ROLE_SKILLS_ROOTS="${path.join(dir, "skills-a")},${path.join(dir, "skills-b")}"`);
    expect(envRaw).toContain(
      'AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON="{\\"planner\\":[\\"task-planner\\",\\"builtin-planner-core\\"],\\"executor\\":[\\"autonomous-dev\\"],\\"reviewer\\":[\\"code-reviewer\\",\\"builtin-reviewer-core\\"]}"',
    );
    expect(envRaw).toContain("CLI_COMPAT_IMAGE_MAX_BYTES=2097152");
    expect(envRaw).toContain("CLI_COMPAT_IMAGE_MAX_COUNT=6");
    expect(envRaw).toContain('CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES="image/png,image/webp"');
    expect(envRaw).toContain(`CLI_COMPAT_RECORD_PATH=${path.join(dir, "logs", "cli-record.ndjson")}`);
    expect(envRaw).toContain('MATRIX_ADMIN_USERS="@ops:example.com,@oncall:example.com"');
    expect(envRaw).toContain("CONTEXT_BRIDGE_HISTORY_LIMIT=24");
    expect(envRaw).toContain("AUTODEV_LOOP_MAX_RUNS=9");
    expect(envRaw).toContain("AUTODEV_LOOP_MAX_MINUTES=60");
    expect(envRaw).toContain("AUTODEV_AUTO_COMMIT=false");
    expect(envRaw).toContain('AUTODEV_GIT_AUTHOR_NAME="CI Bot"');
    expect(envRaw).toContain("AUTODEV_GIT_AUTHOR_EMAIL=ci@example.com");
    expect(envRaw).toContain("AUTODEV_AUTO_RELEASE_ENABLED=false");
    expect(envRaw).toContain("AUTODEV_AUTO_RELEASE_PUSH=true");
    expect(envRaw).toContain("AUTODEV_RUN_ARCHIVE_ENABLED=false");
    expect(envRaw).toContain("AUTODEV_RUN_ARCHIVE_DIR=.codeharbor/autodev-runs-custom");
    expect(envRaw).toContain("AUTODEV_VALIDATION_STRICT=false");
    expect(envRaw).toContain("AUTODEV_STAGE_OUTPUT_ECHO_ENABLED=false");
    expect(envRaw).toContain("AUTODEV_PREFLIGHT_AUTO_STASH=true");
    expect(envRaw).toContain("AUTODEV_MAX_CONSECUTIVE_FAILURES=5");
    expect(envRaw).toContain("AUTODEV_INIT_ENHANCEMENT_ENABLED=true");
    expect(envRaw).toContain("AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS=240000");
    expect(envRaw).toContain("AUTODEV_INIT_ENHANCEMENT_MAX_CHARS=3200");
    expect(envRaw).toContain("AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS=7000");
    expect(envRaw).toContain("AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS=10000");
    expect(envRaw).toContain("AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS=");
    expect(envRaw).toContain("CODEHARBOR_LAUNCHD_MAIN_LABEL=com.custom.main");
    expect(envRaw).toContain("CODEHARBOR_LAUNCHD_ADMIN_LABEL=com.custom.admin");
    expect(envRaw).toContain("PACKAGE_UPDATE_CHECK_ENABLED=false");
    expect(envRaw).toContain("PACKAGE_UPDATE_CHECK_TIMEOUT_MS=2000");
    expect(envRaw).toContain("PACKAGE_UPDATE_CHECK_TTL_MS=600000");
  });

  it("marks hot-only global updates as runtime-applied without restart", async () => {
    const { dir, db, legacy } = createPaths();
    fs.writeFileSync(path.join(dir, ".env.example"), "MATRIX_TYPING_TIMEOUT_MS=10000\n", "utf8");

    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const updated = await fetchJson(`${baseUrl}/api/admin/config/global`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "ops-hot-only",
      },
      body: JSON.stringify({
        matrixTypingTimeoutMs: 15000,
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = updated.body as {
      restartRequired: boolean;
      hotAppliedKeys: string[];
      restartRequiredKeys: string[];
      runtimeConfigVersion: number | null;
    };
    expect(updatedBody.restartRequired).toBe(false);
    expect(updatedBody.hotAppliedKeys).toEqual(["matrixTypingTimeoutMs"]);
    expect(updatedBody.restartRequiredKeys).toEqual([]);
    expect(updatedBody.runtimeConfigVersion).toBe(1);

    const runtimeSnapshot = stateStore.getRuntimeConfigSnapshot(GLOBAL_RUNTIME_HOT_CONFIG_KEY);
    expect(runtimeSnapshot).not.toBeNull();
    expect(runtimeSnapshot?.version).toBe(1);
    expect(runtimeSnapshot?.payloadJson ?? "").toContain('"matrixTypingTimeoutMs":15000');

    const audit = await fetchJson(`${baseUrl}/api/admin/audit?limit=5`);
    expect(audit.status).toBe(200);
    const auditJson = JSON.stringify(audit.body);
    expect(auditJson).toContain('"mode":"hot"');
    expect(auditJson).toContain('"hotAppliedKeys":["matrixTypingTimeoutMs"]');
    expect(auditJson).toContain('"restartRequiredKeys":[]');
    expect(auditJson).toContain('"actor":"ops-hot-only"');
  });

  it("splits hot-applied keys and restart-required keys with audit metadata", async () => {
    const { dir, db, legacy } = createPaths();
    fs.writeFileSync(path.join(dir, ".env.example"), "MATRIX_COMMAND_PREFIX=!code\n", "utf8");

    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const updated = await fetchJson(`${baseUrl}/api/admin/config/global`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "ops-hot",
      },
      body: JSON.stringify({
        matrixTypingTimeoutMs: 15000,
        matrixCommandPrefix: "!new",
      }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = updated.body as {
      restartRequired: boolean;
      hotAppliedKeys: string[];
      restartRequiredKeys: string[];
      runtimeConfigVersion: number | null;
    };
    expect(updatedBody.restartRequired).toBe(true);
    expect(updatedBody.hotAppliedKeys).toEqual(["matrixTypingTimeoutMs"]);
    expect(updatedBody.restartRequiredKeys).toEqual(["matrixCommandPrefix"]);
    expect(updatedBody.runtimeConfigVersion).toBe(1);

    const runtimeSnapshot = stateStore.getRuntimeConfigSnapshot(GLOBAL_RUNTIME_HOT_CONFIG_KEY);
    expect(runtimeSnapshot).not.toBeNull();
    expect(runtimeSnapshot?.version).toBe(1);
    expect(runtimeSnapshot?.payloadJson ?? "").toContain('"matrixTypingTimeoutMs":15000');

    const audit = await fetchJson(`${baseUrl}/api/admin/audit?limit=5`);
    expect(audit.status).toBe(200);
    const auditJson = JSON.stringify(audit.body);
    expect(auditJson).toContain('"mode":"restart"');
    expect(auditJson).toContain('"hotAppliedKeys":["matrixTypingTimeoutMs"]');
    expect(auditJson).toContain('"restartRequiredKeys":["matrixCommandPrefix"]');
    expect(auditJson).toContain('"actor":"ops-hot"');
  });

  it("restarts managed services via admin API", async () => {
    const { dir, db, legacy } = createPaths();
    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    let restartAdmin = false;
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      cwd: dir,
      restartServices: async (withAdmin) => {
        restartAdmin = withAdmin;
        return {
          restarted: withAdmin ? ["codeharbor", "codeharbor-admin"] : ["codeharbor"],
        };
      },
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const restartResponse = await fetchJson(`${baseUrl}/api/admin/service/restart`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-actor": "tester",
      },
      body: JSON.stringify({
        withAdmin: true,
      }),
    });

    expect(restartResponse.status).toBe(200);
    expect(restartAdmin).toBe(true);
    expect(JSON.stringify(restartResponse.body)).toContain("codeharbor-admin");
  });

  it("rejects requests when client ip is not in ADMIN_IP_ALLOWLIST", async () => {
    const { dir, db, legacy } = createPaths();
    const config = createBaseConfig(dir, db, legacy);
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: null,
      adminIpAllowlist: ["10.10.10.10"],
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const blockedApi = await fetchJson(`${baseUrl}/api/admin/config/global`);
    expect(blockedApi.status).toBe(403);

    const blockedUi = await fetchJson(`${baseUrl}/`);
    expect(blockedUi.status).toBe(403);
  });

  it("applies security headers and enforces ADMIN_ALLOWED_ORIGINS for API", async () => {
    const { dir, db, legacy } = createPaths();
    const config = createBaseConfig(dir, db, legacy);
    config.adminAllowedOrigins = ["https://admin.example.com"];
    const stateStore = new StateStore(db, legacy, 200, 30, 5000);
    const configService = new ConfigService(stateStore, dir);
    const logger = new Logger("info");
    const server = new AdminServer(config, logger, stateStore, configService, {
      host: "127.0.0.1",
      port: 0,
      adminToken: "secret-token",
      adminAllowedOrigins: config.adminAllowedOrigins,
      cwd: dir,
      checkCodex: async () => ({ ok: true, version: "codex 1.0", error: null }),
      checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1"], error: null }),
    });
    startedServers.push(server);
    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${address?.port}`;

    const allowed = await fetch(`${baseUrl}/api/admin/config/global`, {
      headers: {
        authorization: "Bearer secret-token",
        origin: "https://admin.example.com",
      },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://admin.example.com");
    expect(allowed.headers.get("x-frame-options")).toBe("DENY");
    expect(allowed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(allowed.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

    const blocked = await fetch(`${baseUrl}/api/admin/config/global`, {
      headers: {
        authorization: "Bearer secret-token",
        origin: "https://evil.example.com",
      },
    });
    expect(blocked.status).toBe(403);
    const blockedBody = (await blocked.json()) as { error?: string };
    expect(blockedBody.error).toContain("ADMIN_ALLOWED_ORIGINS");
  });
});
