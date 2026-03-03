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
});
