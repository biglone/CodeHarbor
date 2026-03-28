import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { healAutoDevTaskStatuses } from "../src/orchestrator/autodev-status-heal";
import type { WorkflowDiagRunRecord } from "../src/orchestrator/workflow-diag";
import { loadAutoDevContext } from "../src/workflow/autodev";

function createRunRecord(input: {
  taskId: string;
  taskDescription: string;
  approved: boolean | null;
  lastMessage: string | null;
}): WorkflowDiagRunRecord {
  const now = new Date().toISOString();
  return {
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    kind: "autodev",
    sessionKey: "sess",
    conversationId: "!room:example.com",
    requestId: "req",
    objective: "objective",
    taskId: input.taskId,
    taskDescription: input.taskDescription,
    status: "succeeded",
    startedAt: now,
    endedAt: now,
    durationMs: 1000,
    approved: input.approved,
    repairRounds: 0,
    error: null,
    lastStage: "autodev",
    lastMessage: input.lastMessage,
    updatedAt: now,
  };
}

describe("AutoDev status heal", () => {
  it("does not mark task completed from reviewer approval alone when gate evidence is missing", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-status-heal-approval-only-"));
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T30.1 | approval only fallback guard | 🔄 |",
      ].join("\n"),
      "utf8",
    );

    try {
      const context = await loadAutoDevContext(tempRoot);
      const changes = await healAutoDevTaskStatuses({
        taskListPath: context.taskListPath,
        tasks: context.tasks,
        runs: [
          createRunRecord({
            taskId: "T30.1",
            taskDescription: "approval only fallback guard",
            approved: true,
            lastMessage: "AutoDev task result: task=T30.1, reviewerApproved=yes",
          }),
        ],
      });

      expect(changes).toHaveLength(0);
      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T30.1 | approval only fallback guard | 🔄 |");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("heals to in_progress when completionGate is explicitly failed", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-status-heal-gate-failed-"));
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T30.2 | gate failed fallback | ✅ |",
      ].join("\n"),
      "utf8",
    );

    try {
      const context = await loadAutoDevContext(tempRoot);
      const changes = await healAutoDevTaskStatuses({
        taskListPath: context.taskListPath,
        tasks: context.tasks,
        runs: [
          createRunRecord({
            taskId: "T30.2",
            taskDescription: "gate failed fallback",
            approved: true,
            lastMessage: "AutoDev task result: task=T30.2, reviewerApproved=yes, completionGate=failed",
          }),
        ],
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        taskId: "T30.2",
        from: "completed",
        to: "in_progress",
      });
      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T30.2 | gate failed fallback | 🔄 |");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("heals to completed when completionGate is explicitly passed", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-status-heal-gate-passed-"));
    const taskListPath = path.join(tempRoot, "TASK_LIST.md");
    await fs.writeFile(
      taskListPath,
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T30.3 | gate passed fallback | 🔄 |",
      ].join("\n"),
      "utf8",
    );

    try {
      const context = await loadAutoDevContext(tempRoot);
      const changes = await healAutoDevTaskStatuses({
        taskListPath: context.taskListPath,
        tasks: context.tasks,
        runs: [
          createRunRecord({
            taskId: "T30.3",
            taskDescription: "gate passed fallback",
            approved: true,
            lastMessage: "AutoDev task result: task=T30.3, reviewerApproved=yes, completionGate=passed",
          }),
        ],
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        taskId: "T30.3",
        from: "in_progress",
        to: "completed",
      });
      const updated = await fs.readFile(taskListPath, "utf8");
      expect(updated).toContain("| T30.3 | gate passed fallback | ✅ |");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
