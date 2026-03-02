import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateStore } from "../src/store/state-store";

describe("StateStore", () => {
  it("stores and reads codex session id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-"));
    const file = path.join(dir, "state.json");
    const store = new StateStore(file, 5, 30, 100);

    expect(store.getCodexSessionId("s1")).toBeNull();
    store.setCodexSessionId("s1", "thread-1");
    expect(store.getCodexSessionId("s1")).toBe("thread-1");
  });

  it("tracks processed events and trims history", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-"));
    const file = path.join(dir, "state.json");
    const store = new StateStore(file, 2, 30, 100);

    expect(store.hasProcessedEvent("s1", "e1")).toBe(false);
    store.markEventProcessed("s1", "e1");
    expect(store.hasProcessedEvent("s1", "e1")).toBe(true);
    store.markEventProcessed("s1", "e2");
    store.markEventProcessed("s1", "e3");

    // e1 should be trimmed; a fresh insert should now pass
    expect(store.hasProcessedEvent("s1", "e1")).toBe(false);
    store.markEventProcessed("s1", "e1");
    expect(store.hasProcessedEvent("s1", "e1")).toBe(true);
  });

  it("prunes expired sessions when ttl is reached", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-"));
    const file = path.join(dir, "state.json");
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      file,
      JSON.stringify({
        sessions: {
          old: {
            codexSessionId: "thread-1",
            processedEventIds: ["e1"],
            updatedAt: stale,
          },
        },
      }),
    );

    const store = new StateStore(file, 2, 1, 100);
    expect(store.getCodexSessionId("old")).toBeNull();
    await store.flush();
  });

  it("prunes least recently updated sessions when over maxSessions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-"));
    const file = path.join(dir, "state.json");
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          sessions: {
            old: {
              codexSessionId: "thread-old",
              processedEventIds: [],
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            newer: {
              codexSessionId: "thread-newer",
              processedEventIds: [],
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
            newest: {
              codexSessionId: "thread-newest",
              processedEventIds: [],
              updatedAt: "2026-01-03T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      ),
    );

    const store = new StateStore(file, 10, 3650, 2);
    expect(store.getCodexSessionId("old")).toBeNull();
    expect(store.getCodexSessionId("newer")).toBe("thread-newer");
    expect(store.getCodexSessionId("newest")).toBe("thread-newest");
    await store.flush();
  });
});
