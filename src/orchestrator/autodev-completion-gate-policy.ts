import type { OutputLanguage } from "../config";
import type { AutoDevGitCommitResult } from "./autodev-git";

export type AutoDevCompletionGateReason =
  | "reviewer_not_approved"
  | "validation_not_passed"
  | "task_list_policy_violated"
  | "auto_commit_not_committed";

export interface AutoDevCompletionGateInput {
  reviewerApproved: boolean;
  validationPassed: boolean;
  taskListPolicyPassed: boolean;
  commitRequired: boolean;
  gitCommit: AutoDevGitCommitResult;
}

export interface AutoDevCompletionGateResult {
  passed: boolean;
  reasons: AutoDevCompletionGateReason[];
}

export function evaluateAutoDevCompletionGate(input: AutoDevCompletionGateInput): AutoDevCompletionGateResult {
  const reasons: AutoDevCompletionGateReason[] = [];
  if (!input.reviewerApproved) {
    reasons.push("reviewer_not_approved");
  }
  if (!input.validationPassed) {
    reasons.push("validation_not_passed");
  }
  if (!input.taskListPolicyPassed) {
    reasons.push("task_list_policy_violated");
  }
  if (input.commitRequired && input.gitCommit.kind !== "committed") {
    reasons.push("auto_commit_not_committed");
  }
  return {
    passed: reasons.length === 0,
    reasons,
  };
}

export function formatAutoDevCompletionGateReasons(
  reasons: AutoDevCompletionGateReason[],
  outputLanguage: OutputLanguage,
): string {
  if (reasons.length === 0) {
    return "N/A";
  }

  const labels = reasons.map((reason) => {
    if (reason === "reviewer_not_approved") {
      return outputLanguage === "en" ? "reviewer-not-approved" : "reviewer未批准";
    }
    if (reason === "validation_not_passed") {
      return outputLanguage === "en" ? "validation-not-passed" : "验证未通过";
    }
    if (reason === "task_list_policy_violated") {
      return outputLanguage === "en" ? "task-list-policy-violated" : "TASK_LIST写入策略违反";
    }
    return outputLanguage === "en" ? "auto-commit-not-committed" : "自动提交未成功";
  });

  return labels.join(", ");
}
