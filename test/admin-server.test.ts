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
      recordPath: null,
    },
    doctorHttpTimeoutMs: 10_000,
    adminBindHost: "127.0.0.1",
    adminPort: 0,
    adminToken: null,
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

  it("writes supported global config changes into .env", async () => {
    const { dir, db, legacy } = createPaths();
    fs.writeFileSync(
      path.join(dir, ".env.example"),
      [
        "MATRIX_COMMAND_PREFIX=!code",
        "RATE_LIMIT_MAX_CONCURRENT_GLOBAL=8",
        "CODEX_WORKDIR=/tmp/old",
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
      }),
    });
    expect(updated.status).toBe(200);
    expect(JSON.stringify(updated.body)).toContain("restartRequired");

    const envRaw = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(envRaw).toContain('MATRIX_COMMAND_PREFIX="!ai"');
    expect(envRaw).toContain(`CODEX_WORKDIR=${dir}`);
    expect(envRaw).toContain("RATE_LIMIT_MAX_CONCURRENT_GLOBAL=12");
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
