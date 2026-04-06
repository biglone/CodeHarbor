import type { OutputLanguage } from "../config";
import type { AutoDevTask } from "../workflow/autodev";

import { byOutputLanguage } from "./output-language";

export interface AutoDevTaskResultNoticeInput {
  outputLanguage: OutputLanguage;
  task: AutoDevTask;
  reviewerApproved: boolean;
  completionGatePassed: boolean;
  completionGateReasonsText: string;
  completionGateReasonCodes: string;
  validationFailureClass: string | null;
  validationEvidenceSource: string;
  validationAt: string;
  taskStatusSymbol: string;
  gitCommitSummary: string;
  gitChangedFiles: string;
  releaseSummary: string;
  nextTaskDisplay: string;
}

export interface AutoDevTaskResultDiagInput {
  outputLanguage: OutputLanguage;
  taskId: string;
  reviewerApproved: boolean;
  completionGatePassed: boolean;
  completionGateReasonCodes: string;
  validationFailureClass: string | null;
  validationEvidenceSource: string;
  validationAt: string;
  taskStatusSymbol: string;
  gitCommitSummary: string;
  releaseSummary: string;
}

export interface AutoDevSecondaryReviewHandoffInput {
  outputLanguage: OutputLanguage;
  enabled: boolean;
  target: string;
  requireGatePassed: boolean;
  completionGatePassed: boolean;
  task: AutoDevTask;
  reviewerApproved: boolean;
  validationFailureClass: string | null;
  validationEvidenceSource: string;
  validationAt: string;
  gitCommitSummary: string;
  gitChangedFiles: string;
  releaseSummary: string;
  requestId: string;
  workflowDiagRunId: string;
}

export interface AutoDevSecondaryReviewHandoffResult {
  notice: string;
  diagMessage: string;
}

export function buildAutoDevTaskResultNotice(input: AutoDevTaskResultNoticeInput): string {
  return byOutputLanguage(
    input.outputLanguage,
    `[CodeHarbor] AutoDev 任务结果
- task: ${input.task.id}
- reviewer approved: ${input.reviewerApproved ? "yes" : "no"}
- completionGate: ${input.completionGatePassed ? "passed" : "failed"}
- completionGateReasons: ${input.completionGatePassed ? "N/A" : input.completionGateReasonsText}
- validationFailureClass: ${input.validationFailureClass ?? "none"}
- validationEvidenceSource: ${input.validationEvidenceSource}
- validationAt: ${input.validationAt}
- task status: ${input.taskStatusSymbol}
- git commit: ${input.gitCommitSummary}
- git changed files: ${input.gitChangedFiles}
- release: ${input.releaseSummary}
- nextTask: ${input.nextTaskDisplay}`,
    `[CodeHarbor] AutoDev task result
- task: ${input.task.id}
- reviewer approved: ${input.reviewerApproved ? "yes" : "no"}
- completionGate: ${input.completionGatePassed ? "passed" : "failed"}
- completionGateReasons: ${input.completionGatePassed ? "N/A" : input.completionGateReasonsText}
- validationFailureClass: ${input.validationFailureClass ?? "none"}
- validationEvidenceSource: ${input.validationEvidenceSource}
- validationAt: ${input.validationAt}
- task status: ${input.taskStatusSymbol}
- git commit: ${input.gitCommitSummary}
- git changed files: ${input.gitChangedFiles}
- release: ${input.releaseSummary}
- nextTask: ${input.nextTaskDisplay}`,
  );
}

export function buildAutoDevTaskResultDiagMessage(input: AutoDevTaskResultDiagInput): string {
  return byOutputLanguage(
    input.outputLanguage,
    `AutoDev 任务结果: task=${input.taskId}, reviewerApproved=${input.reviewerApproved ? "yes" : "no"}, completionGate=${
      input.completionGatePassed ? "passed" : "failed"
    }, completionGateReasonCodes=${input.completionGateReasonCodes}, validationFailureClass=${
      input.validationFailureClass ?? "none"
    }, validationEvidenceSource=${input.validationEvidenceSource}, validationAt=${input.validationAt}, taskStatus=${
      input.taskStatusSymbol
    }, gitCommit=${input.gitCommitSummary}, release=${input.releaseSummary}`,
    `AutoDev task result: task=${input.taskId}, reviewerApproved=${input.reviewerApproved ? "yes" : "no"}, completionGate=${
      input.completionGatePassed ? "passed" : "failed"
    }, completionGateReasonCodes=${input.completionGateReasonCodes}, validationFailureClass=${
      input.validationFailureClass ?? "none"
    }, validationEvidenceSource=${input.validationEvidenceSource}, validationAt=${input.validationAt}, taskStatus=${
      input.taskStatusSymbol
    }, gitCommit=${input.gitCommitSummary}, release=${input.releaseSummary}`,
  );
}

export function buildAutoDevSecondaryReviewHandoffNotice(
  input: AutoDevSecondaryReviewHandoffInput,
): AutoDevSecondaryReviewHandoffResult | null {
  const target = input.target.trim();
  if (!input.enabled || !target) {
    return null;
  }
  if (input.requireGatePassed && !input.completionGatePassed) {
    return null;
  }

  const notice = byOutputLanguage(
    input.outputLanguage,
    `[CodeHarbor] AutoDev 二次评审交接
- target: ${target}
- task: ${input.task.id}
- reviewer approved: ${input.reviewerApproved ? "yes" : "no"}
- completionGate: ${input.completionGatePassed ? "passed" : "failed"}
- validationFailureClass: ${input.validationFailureClass ?? "none"}
- validationEvidenceSource: ${input.validationEvidenceSource}
- validationAt: ${input.validationAt}
- git commit: ${input.gitCommitSummary}
- git changed files: ${input.gitChangedFiles}
- release: ${input.releaseSummary}
- requestId: ${input.requestId}
- workflowDiagRunId: ${input.workflowDiagRunId}
${target} 请执行二次评审：重点检查回归风险、安全风险、测试覆盖缺口；若发现问题，请输出可执行修复建议。`,
    `[CodeHarbor] AutoDev secondary review handoff
- target: ${target}
- task: ${input.task.id}
- reviewer approved: ${input.reviewerApproved ? "yes" : "no"}
- completionGate: ${input.completionGatePassed ? "passed" : "failed"}
- validationFailureClass: ${input.validationFailureClass ?? "none"}
- validationEvidenceSource: ${input.validationEvidenceSource}
- validationAt: ${input.validationAt}
- git commit: ${input.gitCommitSummary}
- git changed files: ${input.gitChangedFiles}
- release: ${input.releaseSummary}
- requestId: ${input.requestId}
- workflowDiagRunId: ${input.workflowDiagRunId}
${target} please run a second-pass review focused on regression risk, security risk, and test gaps. If you find issues, provide actionable fixes.`,
  );

  return {
    notice,
    diagMessage: `secondaryReview target=${target} task=${input.task.id} completionGate=${
      input.completionGatePassed ? "passed" : "failed"
    } requestId=${input.requestId} runId=${input.workflowDiagRunId}`,
  };
}
