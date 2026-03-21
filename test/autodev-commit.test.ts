import { describe, expect, it } from "vitest";

import type { AutoDevTask } from "../src/workflow/autodev";
import { buildAutoDevCommitMessage } from "../src/workflow/autodev-commit";

function createTask(description: string): AutoDevTask {
  return {
    id: "T8.3",
    description,
    status: "completed",
    lineIndex: 1,
  };
}

describe("buildAutoDevCommitMessage", () => {
  it("uses reviewer summary as commit intent when summary is valid english", () => {
    const message = buildAutoDevCommitMessage(
      createTask("后端工具生态：扩展 backend 工具接入与会话切换体验"),
      ["src/orchestrator/backend-command.ts", "src/orchestrator/conversation-bridge.ts"],
      {
        workflowReview: [
          "VERDICT: APPROVED",
          "SUMMARY: improve backend routing and context bridge behavior",
          "ISSUES:",
          "- none",
        ].join("\n"),
      },
    );

    expect(message.subject).toBe(
      "feat(routing): improve backend routing and context bridge behavior (T8.3)",
    );
  });

  it("falls back to template intent when reviewer summary is not english", () => {
    const message = buildAutoDevCommitMessage(
      createTask("后端工具生态：扩展 backend 工具接入与会话切换体验"),
      ["src/orchestrator/backend-command.ts", "src/orchestrator/conversation-bridge.ts"],
      {
        workflowReview: [
          "VERDICT: APPROVED",
          "SUMMARY: 通过",
          "ISSUES:",
          "- none",
        ].join("\n"),
      },
    );

    expect(message.subject).toBe("feat(routing): improve backend routing and context bridge (T8.3)");
    expect(message.subject).not.toMatch(/[\u4e00-\u9fff]/u);
  });

  it("does not fallback to autodev scope for generic tasks", () => {
    const message = buildAutoDevCommitMessage(createTask("自动开发任务"), ["src/app.ts"]);
    expect(message.subject).toMatch(/^(feat|fix|docs|test|chore)\((?!autodev\))/);
  });

  it("uses chinese reviewer summary when preferred language is zh", () => {
    const message = buildAutoDevCommitMessage(
      createTask("后端工具生态：扩展 backend 工具接入与会话切换体验"),
      ["src/orchestrator/backend-command.ts", "src/orchestrator/conversation-bridge.ts"],
      {
        preferredLanguage: "zh",
        workflowReview: [
          "VERDICT: APPROVED",
          "SUMMARY: 优化后端路由与上下文桥接体验",
          "ISSUES:",
          "- 无",
        ].join("\n"),
      },
    );

    expect(message.subject).toBe("feat(routing): 优化后端路由与上下文桥接体验 (T8.3)");
    expect(message.body).toContain("任务ID: T8.3");
    expect(message.body).toContain("变更文件:");
  });

  it("falls back to chinese template when preferred language is zh and summary is english", () => {
    const message = buildAutoDevCommitMessage(
      createTask("后端工具生态：扩展 backend 工具接入与会话切换体验"),
      ["src/orchestrator/backend-command.ts", "src/orchestrator/conversation-bridge.ts"],
      {
        preferredLanguage: "zh",
        workflowReview: [
          "VERDICT: APPROVED",
          "SUMMARY: improve backend routing and context bridge behavior",
          "ISSUES:",
          "- none",
        ].join("\n"),
      },
    );

    expect(message.subject).toBe("feat(routing): 优化后端路由与上下文桥接 (T8.3)");
  });
});
