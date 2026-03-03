import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config";
import {
  buildConfigSnapshot,
  parseConfigSnapshot,
  runConfigExportCommand,
  runConfigImportCommand,
} from "../src/config-snapshot";
import { StateStore } from "../src/store/state-store";

interface TempPaths {
  dir: string;
  db: string;
  legacy: string;
  workdir: string;
}

function createPaths(prefix = "codeharbor-snapshot-"): TempPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workdir = path.join(dir, "workdir");
  fs.mkdirSync(workdir, { recursive: true });
  return {
    dir,
    db: path.join(dir, "state.db"),
    legacy: path.join(dir, "state.json"),
    workdir,
  };
}

function createBaseEnv(paths: TempPaths): NodeJS.ProcessEnv {
  return {
    MATRIX_HOMESERVER: "https://matrix.example.com",
    MATRIX_USER_ID: "@bot:example.com",
    MATRIX_ACCESS_TOKEN: "token-123",
    MATRIX_COMMAND_PREFIX: "!code",
    CODEX_BIN: "codex",
    CODEX_WORKDIR: paths.workdir,
    STATE_DB_PATH: paths.db,
    STATE_PATH: paths.legacy,
    ADMIN_TOKEN: "admin-secret",
    LOG_LEVEL: "info",
  };
}

const silentOutput = {
  write: () => true,
} as unknown as NodeJS.WritableStream;

describe("config snapshot commands", () => {
  it("exports and parses a snapshot with room settings", async () => {
    const paths = createPaths();
    const env = createBaseEnv(paths);
    const config = loadConfig(env);

    const store = new StateStore(
      config.stateDbPath,
      config.legacyStateJsonPath,
      config.maxProcessedEventsPerSession,
      config.maxSessionAgeDays,
      config.maxSessions,
    );
    store.upsertRoomSettings({
      roomId: "!room:example.com",
      enabled: true,
      allowMention: true,
      allowReply: false,
      allowActiveWindow: true,
      allowPrefix: false,
      workdir: paths.workdir,
    });
    await store.flush();

    const exportPath = path.join(paths.dir, "snapshot.json");
    await runConfigExportCommand({
      cwd: paths.dir,
      outputPath: exportPath,
      output: silentOutput,
      env,
      now: new Date("2026-03-03T10:00:00.000Z"),
    });

    const parsed = parseConfigSnapshot(JSON.parse(fs.readFileSync(exportPath, "utf8")));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.exportedAt).toBe("2026-03-03T10:00:00.000Z");
    expect(parsed.env.MATRIX_USER_ID).toBe("@bot:example.com");
    expect(parsed.rooms).toHaveLength(1);
    expect(parsed.rooms[0]?.roomId).toBe("!room:example.com");
  });

  it("supports dry-run import validation", async () => {
    const paths = createPaths();
    const env = createBaseEnv(paths);
    const config = loadConfig(env);
    const snapshot = buildConfigSnapshot(config, []);
    const snapshotPath = path.join(paths.dir, "snapshot-dry-run.json");
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

    await expect(
      runConfigImportCommand({
        cwd: paths.dir,
        filePath: snapshotPath,
        dryRun: true,
        output: silentOutput,
      }),
    ).resolves.toBeUndefined();
  });

  it("imports env + room settings and replaces stale room mappings", async () => {
    const paths = createPaths();
    const roomA = path.join(paths.dir, "project-a");
    const roomB = path.join(paths.dir, "project-b");
    fs.mkdirSync(roomA, { recursive: true });
    fs.mkdirSync(roomB, { recursive: true });

    const env = createBaseEnv(paths);
    const config = loadConfig(env);

    const preStore = new StateStore(
      config.stateDbPath,
      config.legacyStateJsonPath,
      config.maxProcessedEventsPerSession,
      config.maxSessionAgeDays,
      config.maxSessions,
    );
    preStore.upsertRoomSettings({
      roomId: "!stale:example.com",
      enabled: true,
      allowMention: true,
      allowReply: true,
      allowActiveWindow: true,
      allowPrefix: true,
      workdir: roomA,
    });
    await preStore.flush();

    const snapshot = buildConfigSnapshot(config, [
      {
        roomId: "!new:example.com",
        enabled: true,
        allowMention: true,
        allowReply: false,
        allowActiveWindow: true,
        allowPrefix: true,
        workdir: roomB,
        updatedAt: Date.now(),
      },
    ]);
    snapshot.env.MATRIX_COMMAND_PREFIX = "!ai";

    const snapshotPath = path.join(paths.dir, "snapshot-import.json");
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

    await runConfigImportCommand({
      cwd: paths.dir,
      filePath: snapshotPath,
      output: silentOutput,
    });

    const envRaw = fs.readFileSync(path.join(paths.dir, ".env"), "utf8");
    expect(envRaw).toContain('MATRIX_COMMAND_PREFIX="!ai"');

    const verifyStore = new StateStore(
      paths.db,
      paths.legacy,
      config.maxProcessedEventsPerSession,
      config.maxSessionAgeDays,
      config.maxSessions,
    );
    const rooms = verifyStore.listRoomSettings();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.roomId).toBe("!new:example.com");
    expect(rooms[0]?.workdir).toBe(roomB);

    const revisions = verifyStore.listConfigRevisions(5);
    expect(revisions[0]?.summary).toContain("import config snapshot");
    await verifyStore.flush();
  });

  it("rejects import when room workdir does not exist", async () => {
    const paths = createPaths();
    const env = createBaseEnv(paths);
    const config = loadConfig(env);

    const snapshot = buildConfigSnapshot(config, []);
    snapshot.rooms.push({
      roomId: "!bad:example.com",
      enabled: true,
      allowMention: true,
      allowReply: true,
      allowActiveWindow: true,
      allowPrefix: true,
      workdir: path.join(paths.dir, "missing-room-workdir"),
    });

    const snapshotPath = path.join(paths.dir, "snapshot-invalid.json");
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

    await expect(
      runConfigImportCommand({
        cwd: paths.dir,
        filePath: snapshotPath,
        output: silentOutput,
      }),
    ).rejects.toThrow("room workdir");
  });
});
