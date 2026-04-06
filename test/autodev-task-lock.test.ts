import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acquireAutoDevTaskLock,
  releaseAutoDevTaskLock,
} from "../src/orchestrator/autodev-task-lock";

describe("autodev task lock", () => {
  it("acquires lock and blocks concurrent acquisition", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-task-lock-"));
    try {
      const first = await acquireAutoDevTaskLock({
        workdir,
        taskId: "T9.1",
        sessionKey: "sess-a",
        requestId: "req-a",
        conversationId: "!room:example.com",
      });
      expect(first.acquired).toBe(true);

      const second = await acquireAutoDevTaskLock({
        workdir,
        taskId: "T9.1",
        sessionKey: "sess-b",
        requestId: "req-b",
        conversationId: "!room:example.com",
      });
      expect(second.acquired).toBe(false);
      expect(second.holderSummary).toContain("session=sess-a");

      if (first.acquired) {
        await releaseAutoDevTaskLock(first.lock);
      }

      const third = await acquireAutoDevTaskLock({
        workdir,
        taskId: "T9.1",
        sessionKey: "sess-c",
        requestId: "req-c",
        conversationId: "!room:example.com",
      });
      expect(third.acquired).toBe(true);
      if (third.acquired) {
        await releaseAutoDevTaskLock(third.lock);
      }
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it("reclaims stale lock file", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-task-lock-stale-"));
    try {
      const staleMs = 10;
      const first = await acquireAutoDevTaskLock({
        workdir,
        taskId: "T9.2",
        sessionKey: "sess-stale-a",
        requestId: "req-stale-a",
        conversationId: "!room:example.com",
        staleMs,
        nowMs: 1_000,
      });
      expect(first.acquired).toBe(true);

      const reclaimed = await acquireAutoDevTaskLock({
        workdir,
        taskId: "T9.2",
        sessionKey: "sess-stale-b",
        requestId: "req-stale-b",
        conversationId: "!room:example.com",
        staleMs,
        nowMs: 1_011,
      });
      expect(reclaimed.acquired).toBe(true);
      if (reclaimed.acquired) {
        await releaseAutoDevTaskLock(reclaimed.lock);
      }
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });
});
