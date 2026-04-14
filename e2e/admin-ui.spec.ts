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
    matrixProgressDeliveryMode: "upsert",
    matrixTypingTimeoutMs: 10_000,
    matrixNoticeBadgeEnabled: true,
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
    sharedRateLimiter: {
      mode: "local",
      redisUrl: null,
      redisKeyPrefix: "codeharbor:rate-limiter",
      redisCommandTimeoutMs: 1000,
      redisConcurrencyTtlMs: 600_000,
      fallbackToLocal: true,
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

  await expect(page).toHaveTitle(/CodeHarbor .*Admin Console/);
  await expect(page.locator('[data-view="settings-global"]')).toBeVisible();
  await page.click('.submenu .tab-sub[data-route="#/settings/global/basic"]');
  await expect(page.locator("#global-matrix-prefix")).toHaveValue("!code");
  await expect(page.locator("#global-update-check-enabled")).toBeChecked();
  await expect(page.locator("#global-update-check-timeout")).toHaveValue("3000");
  await expect(page.locator("#global-update-check-ttl")).toHaveValue("21600000");
  await page.click('.submenu .tab-sub[data-route="#/settings/global/agent"]');
  await expect(page.locator("#global-agent-enabled")).not.toBeChecked();
  await expect(page.locator("#global-agent-repair-rounds")).toHaveValue("1");
  await expect(page.locator("#notice")).toContainText(/(Global config loaded\.|全局配置已加载。)/);
});

test("saves global agent workflow settings and persists to env", async ({ page }) => {
  await page.goto(`${baseUrl}/settings/global`);

  await page.click('.submenu .tab-sub[data-route="#/settings/global/basic"]');
  await page.uncheck("#global-update-check-enabled");
  await page.fill("#global-update-check-timeout", "1800");
  await page.fill("#global-update-check-ttl", "600000");
  await page.click('.submenu .tab-sub[data-route="#/settings/global/agent"]');
  await page.check("#global-agent-enabled");
  await page.fill("#global-agent-repair-rounds", "3");
  await page.click("#global-save-btn");

  await page.click('.submenu .tab-sub[data-route="#/settings/global/basic"]');
  await expect(page.locator("#global-update-check-enabled")).not.toBeChecked();
  await expect(page.locator("#global-update-check-timeout")).toHaveValue("1800");
  await expect(page.locator("#global-update-check-ttl")).toHaveValue("600000");
  await page.click('.submenu .tab-sub[data-route="#/settings/global/agent"]');
  await expect(page.locator("#global-agent-enabled")).toBeChecked();
  await expect(page.locator("#global-agent-repair-rounds")).toHaveValue("3");
  await page.click("#global-reload-btn");
  await page.click('.submenu .tab-sub[data-route="#/settings/global/basic"]');
  await expect(page.locator("#global-update-check-enabled")).not.toBeChecked();
  await expect(page.locator("#global-update-check-timeout")).toHaveValue("1800");
  await expect(page.locator("#global-update-check-ttl")).toHaveValue("600000");
  await page.click('.submenu .tab-sub[data-route="#/settings/global/agent"]');
  await expect(page.locator("#global-agent-enabled")).toBeChecked();
  await expect(page.locator("#global-agent-repair-rounds")).toHaveValue("3");

  const envRaw = fs.readFileSync(path.join(paths.dir, ".env"), "utf8");
  expect(envRaw).toContain("AGENT_WORKFLOW_ENABLED=true");
  expect(envRaw).toContain("AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS=3");
  expect(envRaw).toContain("PACKAGE_UPDATE_CHECK_ENABLED=false");
  expect(envRaw).toContain("PACKAGE_UPDATE_CHECK_TIMEOUT_MS=1800");
  expect(envRaw).toContain("PACKAGE_UPDATE_CHECK_TTL_MS=600000");
});

test("loads skill catalog and rejects unknown role skill assignments", async ({ page }) => {
  await page.goto(`${baseUrl}/settings/global`);
  await page.click('.submenu .tab-sub[data-route="#/settings/global/agent"]');
  await page.click("#global-agent-skills-refresh-btn");

  await expect(page.locator("#global-agent-skills-catalog")).toHaveValue(/autonomous-dev \(builtin\)/);
  await expect(page.locator("#global-agent-skills-missing")).toContainText(/(Missing SKILL: none|缺失 SKILL：无)/);

  await page.fill(
    "#global-agent-skills-assignments",
    '{"planner":["missing-skill-e2e"],"executor":["autonomous-dev"],"reviewer":["code-reviewer"]}',
  );
  await page.click("#global-save-btn");

  await expect(page.locator("#notice")).toContainText(/(unknown skill ids|roleAssignments)/i);
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

  await expect(page.locator("#notice")).toContainText(/(Health check completed\.|健康检查完成。)/);
  await expect(page.locator("#health-body")).toContainText("CodeHarbor");
  await expect(page.locator("#health-body")).toContainText("Codex");
  await expect(page.locator("#health-body")).toContainText("Matrix");
  await expect(page.locator("#health-body")).toContainText("0.1.27");
  await expect(page.locator("#health-body")).toContainText("0.1.28");
  await expect(page.locator("#health-body")).toContainText(/(OK|正常)/);
});

test("renders audit records after config changes", async ({ page }) => {
  await page.goto(`${baseUrl}/settings/global`);
  await page.click('.submenu .tab-sub[data-route="#/settings/global/basic"]');
  await page.fill("#global-matrix-prefix", "!ai");
  await page.click("#global-save-btn");

  await page.goto(`${baseUrl}/audit`);
  await page.fill("#audit-limit", "50");
  await page.click("#audit-refresh-btn");

  await expect(page.locator("#audit-body")).toContainText("update global config");
});

test("viewer token cannot write global config (403)", async ({ page }) => {
  test.setTimeout(60_000);
  const isolated = createPaths("codeharbor-admin-e2e-viewer-");
  fs.writeFileSync(path.join(isolated.dir, ".env.example"), "MATRIX_COMMAND_PREFIX=!code\n", "utf8");
  const config = createBaseConfig(isolated.dir, isolated.db, isolated.legacy);
  config.updateCheck.enabled = false;
  config.adminTokens = [
    { token: "viewer-token", role: "viewer", actor: "ops-viewer" },
    { token: "admin-token", role: "admin", actor: "ops-admin" },
  ];

  const store = new StateStore(isolated.db, isolated.legacy, 200, 30, 5000);
  const service = new ConfigService(store, isolated.dir);
  const logger = new Logger("error");
  const isolatedServer = new AdminServer(config, logger, store, service, {
    host: "127.0.0.1",
    port: 0,
    adminToken: null,
    adminTokens: config.adminTokens,
    cwd: isolated.dir,
    checkCodex: async () => ({ ok: true, version: "codex 1.0.0", error: null }),
    checkMatrix: async () => ({ ok: true, status: 200, versions: ["v1.10"], error: null }),
    packageUpdateChecker: {
      getStatus: async () => ({
        packageName: "codeharbor",
        currentVersion: "0.1.102",
        latestVersion: "0.1.102",
        state: "up_to_date",
        checkedAt: new Date().toISOString(),
        error: null,
        upgradeCommand: "npm install -g codeharbor@latest",
      }),
    },
  });

  await isolatedServer.start();
  const address = isolatedServer.getAddress();
  if (!address) {
    await isolatedServer.stop();
    throw new Error("isolated admin server address is empty");
  }
  const isolatedUrl = `http://127.0.0.1:${address.port}`;

  try {
    await page.goto(`${isolatedUrl}/settings/global`);
    await page.fill("#auth-token", "viewer-token");
    await page.click("#auth-save-btn");
    await expect(page.locator("#auth-role")).toContainText("VIEWER");

    await page.click('.submenu .tab-sub[data-route="#/settings/global/basic"]');
    await page.fill("#global-matrix-prefix", "!viewer");
    await page.click("#global-save-btn");
    await expect(page.locator("#notice")).toContainText(/(admin write permission|admin\.write)/i, { timeout: 15_000 });
  } finally {
    await isolatedServer.stop();
    await store.flush();
  }
});
