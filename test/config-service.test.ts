import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigService } from "../src/config-service";
import { TriggerPolicy } from "../src/config";
import { StateStore } from "../src/store/state-store";

function createPaths(prefix = "codeharbor-config-"): { dir: string; db: string; legacy: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    db: path.join(dir, "state.db"),
    legacy: path.join(dir, "state.json"),
  };
}

const fallbackPolicy: TriggerPolicy = {
  allowMention: true,
  allowReply: true,
  allowActiveWindow: true,
  allowPrefix: true,
};

describe("ConfigService", () => {
  it("falls back to default workdir and trigger policy when room settings are absent", () => {
    const { dir, db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);
    const service = new ConfigService(store, dir);

    const resolved = service.resolveRoomConfig("!missing:example.com", fallbackPolicy);

    expect(resolved.source).toBe("default");
    expect(resolved.enabled).toBe(true);
    expect(resolved.triggerPolicy).toEqual(fallbackPolicy);
    expect(resolved.workdir).toBe(dir);
  });

  it("stores room settings and resolves room-level overrides", () => {
    const { dir, db, legacy } = createPaths();
    const projectDir = path.join(dir, "project-b");
    fs.mkdirSync(projectDir, { recursive: true });

    const store = new StateStore(db, legacy, 10, 30, 100);
    const service = new ConfigService(store, dir);

    service.updateRoomSettings({
      roomId: "!room:example.com",
      enabled: true,
      allowMention: false,
      allowReply: true,
      allowActiveWindow: false,
      allowPrefix: true,
      workdir: projectDir,
      actor: "tester",
      summary: "bind room to project-b",
    });

    const resolved = service.resolveRoomConfig("!room:example.com", fallbackPolicy);
    expect(resolved.source).toBe("room");
    expect(resolved.workdir).toBe(projectDir);
    expect(resolved.triggerPolicy).toEqual({
      allowMention: false,
      allowReply: true,
      allowActiveWindow: false,
      allowPrefix: true,
    });

    const revisions = store.listConfigRevisions(10);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.summary).toBe("bind room to project-b");
  });

  it("rejects room settings when workdir does not exist", () => {
    const { dir, db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);
    const service = new ConfigService(store, dir);

    expect(() =>
      service.updateRoomSettings({
        roomId: "!room:example.com",
        enabled: true,
        allowMention: true,
        allowReply: true,
        allowActiveWindow: true,
        allowPrefix: true,
        workdir: path.join(dir, "not-exists"),
      }),
    ).toThrow("workdir does not exist");
  });

  it("deletes room settings and falls back to default config", () => {
    const { dir, db, legacy } = createPaths();
    const projectDir = path.join(dir, "project-c");
    fs.mkdirSync(projectDir, { recursive: true });
    const store = new StateStore(db, legacy, 10, 30, 100);
    const service = new ConfigService(store, dir);

    service.updateRoomSettings({
      roomId: "!room:delete.example.com",
      enabled: false,
      allowMention: false,
      allowReply: false,
      allowActiveWindow: false,
      allowPrefix: true,
      workdir: projectDir,
      actor: "tester",
      summary: "create for delete",
    });

    expect(service.getRoomSettings("!room:delete.example.com")).not.toBeNull();
    service.deleteRoomSettings("!room:delete.example.com", "tester");
    expect(service.getRoomSettings("!room:delete.example.com")).toBeNull();

    const resolved = service.resolveRoomConfig("!room:delete.example.com", fallbackPolicy);
    expect(resolved.source).toBe("default");
    expect(resolved.workdir).toBe(dir);
    expect(resolved.triggerPolicy).toEqual(fallbackPolicy);

    const revisions = store.listConfigRevisions(10);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.summary).toContain("delete room settings");
  });

  it("rejects empty room id for delete operation", () => {
    const { dir, db, legacy } = createPaths();
    const store = new StateStore(db, legacy, 10, 30, 100);
    const service = new ConfigService(store, dir);

    expect(() => service.deleteRoomSettings("   ")).toThrow("roomId is required");
  });
});
