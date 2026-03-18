import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadAutoDevContext,
  parseAutoDevCommand,
  selectAutoDevTask,
  summarizeAutoDevTasks,
  updateAutoDevTaskStatus,
} from "../src/workflow/autodev";

describe("AutoDev workflow helpers", () => {
  it("parses /autodev commands", () => {
    expect(parseAutoDevCommand("/autodev")).toEqual({ kind: "status" });
    expect(parseAutoDevCommand(" /autodev status ")).toEqual({ kind: "status" });
    expect(parseAutoDevCommand("//autodev status")).toEqual({ kind: "status" });
    expect(parseAutoDevCommand("/autodev stop")).toEqual({ kind: "stop" });
    expect(parseAutoDevCommand("//autodev stop")).toEqual({ kind: "stop" });
    expect(parseAutoDevCommand("/autodev run")).toEqual({ kind: "run", taskId: null });
    expect(parseAutoDevCommand("/autodev run T3.2")).toEqual({ kind: "run", taskId: "T3.2" });
    expect(parseAutoDevCommand("//autodev run T3.3")).toEqual({ kind: "run", taskId: "T3.3" });
    expect(parseAutoDevCommand("/autodev unknown")).toBeNull();
    expect(parseAutoDevCommand("/autodevrun")).toBeNull();
  });

  it("loads context and selects next task from TASK_LIST.md", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-"));
    const requirementsPath = path.join(tempRoot, "REQUIREMENTS.md");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(requirementsPath, "# Req\n", "utf8");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T1.1 | first | ⬜ |",
        "| T1.2 | second | 🔄 |",
        "| T1.3 | third | ✅ |",
      ].join("\n"),
      "utf8",
    );

    try {
      const context = await loadAutoDevContext(tempRoot);
      expect(context.requirementsContent).toContain("Req");
      expect(context.tasks).toHaveLength(3);

      const summary = summarizeAutoDevTasks(context.tasks);
      expect(summary).toMatchObject({
        total: 3,
        pending: 1,
        inProgress: 1,
        completed: 1,
      });

      const next = selectAutoDevTask(context.tasks);
      expect(next?.id).toBe("T1.2");
      expect(selectAutoDevTask(context.tasks, "T1.1")?.id).toBe("T1.1");
      expect(selectAutoDevTask(context.tasks, "T9.9")).toBeNull();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("updates task status in markdown table rows", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-update-"));
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T2.1 | build endpoint | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    try {
      const context = await loadAutoDevContext(tempRoot);
      const task = context.tasks[0];
      if (!task) {
        throw new Error("expected first task");
      }
      await updateAutoDevTaskStatus(taskListPath, task, "completed");

      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T2.1 | build endpoint | ✅ |");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
