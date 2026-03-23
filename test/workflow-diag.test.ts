import { describe, expect, it } from "vitest";

import {
  formatAutoDevStatusRunSummaries,
  localizeWorkflowDiagMessageForDisplay,
  type WorkflowDiagRunRecord,
} from "../src/orchestrator/workflow-diag";

describe("workflow-diag localization", () => {
  it("localizes historical zh workflow message for english display", () => {
    const localized = localizeWorkflowDiagMessageForDisplay(
      "AutoDev 启动任务 T8.8: 文档与验收：更新 README/手册/诊断命令说明并补齐回归用例",
      "en",
    );
    expect(localized).toContain("AutoDev started task T8.8");
    expect(localized).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("omits task description in english recent run summaries", () => {
    const run: WorkflowDiagRunRecord = {
      runId: "run-1",
      kind: "autodev",
      sessionKey: "s1",
      conversationId: "c1",
      requestId: "r1",
      objective: "obj",
      taskId: "T8.8",
      taskDescription: "文档与验收：更新 README",
      status: "succeeded",
      startedAt: "2026-03-22T10:00:00.000Z",
      endedAt: "2026-03-22T10:10:00.000Z",
      durationMs: 600_000,
      approved: true,
      repairRounds: 0,
      error: null,
      lastStage: "autodev",
      lastMessage: "AutoDev 任务结果: task=T8.8",
      updatedAt: "2026-03-22T10:10:00.000Z",
    };

    const text = formatAutoDevStatusRunSummaries([run], "en");
    expect(text).toContain("task=T8.8");
    expect(text).not.toContain("文档与验收");
    expect(text).toContain("AutoDev task result");
  });
});

