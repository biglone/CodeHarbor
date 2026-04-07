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

  it("stores lock file under runtime home by default", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-task-lock-root-"));
    try {
      const previous = process.env.AUTODEV_TASK_LOCK_ROOT_DIR;
      delete process.env.AUTODEV_TASK_LOCK_ROOT_DIR;
      try {
        const acquired = await acquireAutoDevTaskLock({
          workdir,
          taskId: "T9.3",
          sessionKey: "sess-root-default",
          requestId: "req-root-default",
          conversationId: "!room:example.com",
        });
        expect(acquired.acquired).toBe(true);
        if (acquired.acquired) {
          const expectedRoot = path.resolve(os.homedir(), ".codeharbor/autodev-task-locks");
          expect(acquired.lockFilePath.startsWith(`${expectedRoot}${path.sep}`)).toBe(true);
          await releaseAutoDevTaskLock(acquired.lock);
        }
      } finally {
        if (typeof previous === "string") {
          process.env.AUTODEV_TASK_LOCK_ROOT_DIR = previous;
        } else {
          delete process.env.AUTODEV_TASK_LOCK_ROOT_DIR;
        }
      }
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });

  it("supports AUTODEV_TASK_LOCK_ROOT_DIR override", async () => {
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-task-lock-env-"));
    const customRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-task-lock-custom-root-"));
    try {
      const previous = process.env.AUTODEV_TASK_LOCK_ROOT_DIR;
      process.env.AUTODEV_TASK_LOCK_ROOT_DIR = customRoot;
      try {
        const acquired = await acquireAutoDevTaskLock({
          workdir,
          taskId: "T9.4",
          sessionKey: "sess-root-env",
          requestId: "req-root-env",
          conversationId: "!room:example.com",
        });
        expect(acquired.acquired).toBe(true);
        if (acquired.acquired) {
          expect(acquired.lockFilePath.startsWith(`${customRoot}${path.sep}`)).toBe(true);
          await releaseAutoDevTaskLock(acquired.lock);
        }
      } finally {
        if (typeof previous === "string") {
          process.env.AUTODEV_TASK_LOCK_ROOT_DIR = previous;
        } else {
          delete process.env.AUTODEV_TASK_LOCK_ROOT_DIR;
        }
      }
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
      await fs.rm(customRoot, { recursive: true, force: true });
    }
  });

  it("uses canonical workdir path so symlink aliases share same lock", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-task-lock-realpath-"));
    const realWorkdir = path.join(tempRoot, "workspace-real");
    const aliasWorkdir = path.join(tempRoot, "workspace-alias");
    await fs.mkdir(realWorkdir, { recursive: true });
    await fs.symlink(realWorkdir, aliasWorkdir, "dir");

    try {
      const first = await acquireAutoDevTaskLock({
        workdir: realWorkdir,
        taskId: "T9.5",
        sessionKey: "sess-real",
        requestId: "req-real",
        conversationId: "!room:example.com",
      });
      expect(first.acquired).toBe(true);

      const second = await acquireAutoDevTaskLock({
        workdir: aliasWorkdir,
        taskId: "T9.5",
        sessionKey: "sess-alias",
        requestId: "req-alias",
        conversationId: "!room:example.com",
      });
      expect(second.acquired).toBe(false);
      expect(second.holderSummary).toContain("session=sess-real");

      if (first.acquired) {
        await releaseAutoDevTaskLock(first.lock);
      }

      const third = await acquireAutoDevTaskLock({
        workdir: aliasWorkdir,
        taskId: "T9.5",
        sessionKey: "sess-alias-after-release",
        requestId: "req-alias-after-release",
        conversationId: "!room:example.com",
      });
      expect(third.acquired).toBe(true);
      if (third.acquired) {
        await releaseAutoDevTaskLock(third.lock);
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

});
