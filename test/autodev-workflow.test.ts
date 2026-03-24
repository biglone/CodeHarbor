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
    expect(parseAutoDevCommand("///autodev status")).toEqual({ kind: "status" });
    expect(parseAutoDevCommand("/autodev stop")).toEqual({ kind: "stop" });
    expect(parseAutoDevCommand("//autodev stop")).toEqual({ kind: "stop" });
    expect(parseAutoDevCommand("///autodev stop")).toEqual({ kind: "stop" });
    expect(parseAutoDevCommand("/autodev workdir")).toEqual({ kind: "workdir", mode: "status", path: null });
    expect(parseAutoDevCommand("/autodev wd")).toEqual({ kind: "workdir", mode: "status", path: null });
    expect(parseAutoDevCommand("/autodev workdir status")).toEqual({ kind: "workdir", mode: "status", path: null });
    expect(parseAutoDevCommand("/autodev wd status")).toEqual({ kind: "workdir", mode: "status", path: null });
    expect(parseAutoDevCommand("/autodev workdir clear")).toEqual({ kind: "workdir", mode: "clear", path: null });
    expect(parseAutoDevCommand("/autodev wd clear")).toEqual({ kind: "workdir", mode: "clear", path: null });
    expect(parseAutoDevCommand("/autodev workdir ~/workspace/StrawBerry")).toEqual({
      kind: "workdir",
      mode: "set",
      path: "~/workspace/StrawBerry",
    });
    expect(parseAutoDevCommand("/autodev init")).toEqual({
      kind: "init",
      path: null,
      from: null,
      dryRun: false,
      force: false,
    });
    expect(parseAutoDevCommand("/autodev i")).toEqual({
      kind: "init",
      path: null,
      from: null,
      dryRun: false,
      force: false,
    });
    expect(parseAutoDevCommand("/autodev init ~/workspace/StrawBerry")).toEqual({
      kind: "init",
      path: "~/workspace/StrawBerry",
      from: null,
      dryRun: false,
      force: false,
    });
    expect(parseAutoDevCommand("/autodev i StrawBerry")).toEqual({
      kind: "init",
      path: "StrawBerry",
      from: null,
      dryRun: false,
      force: false,
    });
    expect(parseAutoDevCommand("/autodev init --from docs/技术方案.md")).toEqual({
      kind: "init",
      path: null,
      from: "docs/技术方案.md",
      dryRun: false,
      force: false,
    });
    expect(parseAutoDevCommand("/autodev init ~/workspace/StrawBerry --skill requirements-doc")).toEqual({
      kind: "init",
      path: "~/workspace/StrawBerry",
      from: null,
      dryRun: false,
      force: false,
    });
    expect(parseAutoDevCommand("/autodev init StrawBerry --from docs/design.md --skill requirements-doc")).toEqual({
      kind: "init",
      path: "StrawBerry",
      from: "docs/design.md",
      dryRun: false,
      force: false,
    });
    expect(parseAutoDevCommand("/autodev init StrawBerry --dry-run")).toEqual({
      kind: "init",
      path: "StrawBerry",
      from: null,
      dryRun: true,
      force: false,
    });
    expect(parseAutoDevCommand("/autodev init StrawBerry --force")).toEqual({
      kind: "init",
      path: "StrawBerry",
      from: null,
      dryRun: false,
      force: true,
    });
    expect(parseAutoDevCommand("/autodev init StrawBerry --dry-run --force --from docs/spec.md")).toEqual({
      kind: "init",
      path: "StrawBerry",
      from: "docs/spec.md",
      dryRun: true,
      force: true,
    });
    expect(parseAutoDevCommand("/autodev progress")).toEqual({ kind: "progress", mode: "status" });
    expect(parseAutoDevCommand("/autodev progress status")).toEqual({ kind: "progress", mode: "status" });
    expect(parseAutoDevCommand("/autodev progress on")).toEqual({ kind: "progress", mode: "on" });
    expect(parseAutoDevCommand("//autodev progress off")).toEqual({ kind: "progress", mode: "off" });
    expect(parseAutoDevCommand("/autodev progress maybe")).toBeNull();
    expect(parseAutoDevCommand("/autodev skills")).toEqual({ kind: "skills", mode: "status" });
    expect(parseAutoDevCommand("//autodev skills status")).toEqual({ kind: "skills", mode: "status" });
    expect(parseAutoDevCommand("/autodev skills on")).toEqual({ kind: "skills", mode: "on" });
    expect(parseAutoDevCommand("/autodev skills off")).toEqual({ kind: "skills", mode: "off" });
    expect(parseAutoDevCommand("/autodev skills progressive")).toEqual({ kind: "skills", mode: "progressive" });
    expect(parseAutoDevCommand("/autodev skills full")).toEqual({ kind: "skills", mode: "full" });
    expect(parseAutoDevCommand("/autodev skills summary")).toEqual({ kind: "skills", mode: "summary" });
    expect(parseAutoDevCommand("/autodev skills maybe")).toBeNull();
    expect(parseAutoDevCommand("/autodev run")).toEqual({ kind: "run", taskId: null });
    expect(parseAutoDevCommand("/autodev run T3.2")).toEqual({ kind: "run", taskId: "T3.2" });
    expect(parseAutoDevCommand("//autodev run T3.3")).toEqual({ kind: "run", taskId: "T3.3" });
    expect(parseAutoDevCommand("///autodev run T3.4")).toEqual({ kind: "run", taskId: "T3.4" });
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

  it("ignores release mapping rows and duplicate task ids when loading tasks", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-autodev-release-map-"));
    const requirementsPath = path.join(tempRoot, "REQUIREMENTS.md");
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(requirementsPath, "# Req\n", "utf8");
    await fs.writeFile(
      taskListPath,
      [
        "### 阶段 8：社区路线图投票落地（进行中）",
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T8.7 | 正式任务 | ✅ |",
        "| T8.8 | 正式任务 | ⬜ |",
        "",
        "## 大功能 -> 发布映射（执行约定）",
        "| 大功能任务 | 完成后目标版本 | 发布状态 |",
        "|------------|----------------|----------|",
        "| T8.7 | v0.1.58 | ⬜ 待发布 |",
        "| T8.8 | v0.1.59 | ⬜ 待发布 |",
      ].join("\n"),
      "utf8",
    );

    try {
      const context = await loadAutoDevContext(tempRoot);
      expect(context.tasks).toHaveLength(2);
      expect(context.tasks.map((task) => `${task.id}:${task.status}`)).toEqual(["T8.7:completed", "T8.8:pending"]);

      const next = selectAutoDevTask(context.tasks);
      expect(next?.id).toBe("T8.8");
      expect(next?.description).toContain("正式任务");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
