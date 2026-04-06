import { describe, expect, it } from "vitest";

import {
  evaluateAutoDevCompletionGate,
  formatAutoDevCompletionGateReasons,
} from "../src/orchestrator/autodev-completion-gate-policy";

describe("autodev completion gate policy", () => {
  it("passes when reviewer, validation, policy, and required commit all pass", () => {
    const result = evaluateAutoDevCompletionGate({
      reviewerApproved: true,
      validationPassed: true,
      taskListPolicyPassed: true,
      commitRequired: true,
      gitCommit: {
        kind: "committed",
        commitHash: "abc1234",
        commitSubject: "feat: test",
        changedFiles: ["TASK_LIST.md"],
      },
    });

    expect(result).toEqual({
      passed: true,
      reasons: [],
    });
  });

  it("collects all failure reasons in deterministic order", () => {
    const result = evaluateAutoDevCompletionGate({
      reviewerApproved: false,
      validationPassed: false,
      taskListPolicyPassed: false,
      commitRequired: true,
      gitCommit: {
        kind: "skipped",
        reason: "not attempted",
      },
    });

    expect(result).toEqual({
      passed: false,
      reasons: [
        "reviewer_not_approved",
        "validation_not_passed",
        "task_list_policy_violated",
        "auto_commit_not_committed",
      ],
    });
  });

  it("does not require commit when commitRequired is off", () => {
    const result = evaluateAutoDevCompletionGate({
      reviewerApproved: true,
      validationPassed: true,
      taskListPolicyPassed: true,
      commitRequired: false,
      gitCommit: {
        kind: "skipped",
        reason: "auto commit disabled",
      },
    });

    expect(result).toEqual({
      passed: true,
      reasons: [],
    });
  });

  it("formats gate reasons in en/zh and supports empty reasons", () => {
    const reasons = [
      "reviewer_not_approved",
      "validation_not_passed",
      "task_list_policy_violated",
      "auto_commit_not_committed",
    ] as const;

    expect(formatAutoDevCompletionGateReasons([], "en")).toBe("N/A");
    expect(formatAutoDevCompletionGateReasons([], "zh")).toBe("N/A");
    expect(formatAutoDevCompletionGateReasons([...reasons], "en")).toBe(
      "reviewer-not-approved, validation-not-passed, task-list-policy-violated, auto-commit-not-committed",
    );
    expect(formatAutoDevCompletionGateReasons([...reasons], "zh")).toBe(
      "reviewer未批准, 验证未通过, TASK_LIST写入策略违反, 自动提交未成功",
    );
  });
});
