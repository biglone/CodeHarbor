import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { StateStore } from "../src/store/state-store";

describe("StateStore", () => {
  it("stores and reads codex session id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-"));
    const file = path.join(dir, "state.json");
    const store = new StateStore(file, 5);

    expect(store.getCodexSessionId("s1")).toBeNull();
    store.setCodexSessionId("s1", "thread-1");
    expect(store.getCodexSessionId("s1")).toBe("thread-1");
  });

  it("deduplicates events and trims history", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-"));
    const file = path.join(dir, "state.json");
    const store = new StateStore(file, 2);

    expect(store.markEventIfNew("s1", "e1")).toBe(true);
    expect(store.markEventIfNew("s1", "e1")).toBe(false);
    expect(store.markEventIfNew("s1", "e2")).toBe(true);
    expect(store.markEventIfNew("s1", "e3")).toBe(true);

    // e1 should be trimmed; a fresh insert should now pass
    expect(store.markEventIfNew("s1", "e1")).toBe(true);
  });
});
