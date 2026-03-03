import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { AdminServer } from "../src/admin-server";
import { ConfigService } from "../src/config-service";
import { AppConfig } from "../src/config";
import { Logger } from "../src/logger";
import { StateStore } from "../src/store/state-store";

interface TempPaths {
  dir: string;
  db: string;
  legacy: string;
}

function createPaths(prefix = "codeharbor-admin-e2e-"): TempPaths {
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
    logLevel: "error",
  };
}

let server: AdminServer;
let baseUrl = "";
let paths: TempPaths;
let roomProjectDir = "";

test.beforeAll(async () => {
  paths = createPaths();
  roomProjectDir = path.join(paths.dir, "project-e2e");
  fs.mkdirSync(roomProjectDir, { recursive: true });
  fs.writeFileSync(path.join(paths.dir, ".env.example"), "MATRIX_COMMAND_PREFIX=!code\n", "utf8");

  const config = createBaseConfig(paths.dir, paths.db, paths.legacy);
  const store = new StateStore(paths.db, paths.legacy, 200, 30, 5000);
  const service = new ConfigService(store, paths.dir);
  const logger = new Logger("error");

  server = new AdminServer(config, logger, store, service, {
    host: "127.0.0.1",
    port: 0,
    adminToken: null,
    adminIpAllowlist: [],
    cwd: paths.dir,
    checkCodex: async () => ({ ok: true, version: "codex 1.0.0", error: null }),
    checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1.10"], error: null }),
  });

  await server.start();
  const address = server.getAddress();
  if (!address) {
    throw new Error("admin server address is empty");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server.stop();
});

test("loads global settings page and fetches initial config", async ({ page }) => {
  await page.goto(`${baseUrl}/settings/global`);

  await expect(page).toHaveTitle(/CodeHarbor Admin Console/);
  await expect(page.locator('[data-view="settings-global"]')).toBeVisible();
  await expect(page.locator("#global-matrix-prefix")).toHaveValue("!code");
  await expect(page.locator("#notice")).toContainText("Global config loaded.");
});

test("saves room config and shows in room list", async ({ page }) => {
  await page.goto(`${baseUrl}/settings/rooms`);

  await page.fill("#room-id", "!room-e2e:example.com");
  await page.fill("#room-summary", "bind room for e2e");
  await page.fill("#room-workdir", roomProjectDir);
  await page.check("#room-enabled");
  await page.check("#room-mention");
  await page.check("#room-reply");
  await page.check("#room-window");
  await page.check("#room-prefix");
  await page.click("#room-save-btn");

  await expect(page.locator("#room-list-body")).toContainText("!room-e2e:example.com");
  await expect(page.locator("#room-list-body")).toContainText(roomProjectDir);

  await page.goto(`${baseUrl}/audit`);
  await page.click("#audit-refresh-btn");
  await expect(page.locator("#audit-body")).toContainText("room_settings_upsert");
});

test("runs health check and displays OK for codex and matrix", async ({ page }) => {
  await page.goto(`${baseUrl}/health`);
  await page.click("#health-refresh-btn");

  await expect(page.locator("#notice")).toContainText("Health check completed.");
  await expect(page.locator("#health-body")).toContainText("Codex");
  await expect(page.locator("#health-body")).toContainText("Matrix");
  await expect(page.locator("#health-body")).toContainText("OK");
});

test("renders audit records after config changes", async ({ page }) => {
  await page.goto(`${baseUrl}/settings/global`);
  await page.fill("#global-matrix-prefix", "!ai");
  await page.click("#global-save-btn");

  await page.goto(`${baseUrl}/audit`);
  await page.fill("#audit-limit", "50");
  await page.click("#audit-refresh-btn");

  await expect(page.locator("#audit-body")).toContainText("update global config");
  await expect(page.locator("#audit-body")).toContainText("room_settings_upsert");
});
