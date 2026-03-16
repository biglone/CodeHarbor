import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdminServer } from "../src/admin-server";
import { ConfigService } from "../src/config-service";
import { AppConfig } from "../src/config";
import { Logger } from "../src/logger";
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
    },
    doctorHttpTimeoutMs: 10_000,
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
        "RATE_LIMIT_MAX_CONCURRENT_GLOBAL=8",
        "CODEX_WORKDIR=/tmp/old",
        "AGENT_WORKFLOW_ENABLED=false",
        "AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS=1",
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
        codexWorkdir: dir,
        rateLimiter: {
          maxConcurrentGlobal: 12,
        },
        agentWorkflow: {
          enabled: true,
          autoRepairMaxRounds: 2,
        },
        updateCheck: {
          enabled: false,
          timeoutMs: 2000,
        },
      }),
    });
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.body)).toContain("restartRequired");

    const envRaw = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(envRaw).toContain('MATRIX_COMMAND_PREFIX="!ai"');
    expect(envRaw).toContain(`CODEX_WORKDIR=${dir}`);
    expect(envRaw).toContain("RATE_LIMIT_MAX_CONCURRENT_GLOBAL=12");
    expect(envRaw).toContain("AGENT_WORKFLOW_ENABLED=true");
    expect(envRaw).toContain("AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS=2");
    expect(envRaw).toContain("PACKAGE_UPDATE_CHECK_ENABLED=false");
    expect(envRaw).toContain("PACKAGE_UPDATE_CHECK_TIMEOUT_MS=2000");
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
