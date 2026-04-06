import fs from "node:fs/promises";

import type { InboundMessage } from "../types";
import type { OutputLanguage } from "../config";
import type { MultiAgentWorkflowRunResult } from "../workflow/multi-agent-workflow";

import { byOutputLanguage } from "./output-language";
import type { AutoDevTaskListGuardResult, AutoDevWorkflowStageResult } from "./autodev-stage-contract";

interface RunWorkflowCommandInput {
  objective: string;
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
  workdir: string;
  diagRunId: string;
  resolveReviewerTaskListPolicyContext?: (input: {
    round: number;
    objective: string;
    plan: string;
    output: string;
    workdir: string;
  }) => string | null | Promise<string | null>;
}

export interface ExecuteAutoDevWorkflowStageInput {
  outputLanguage: OutputLanguage;
  objective: string;
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
  workdir: string;
  workflowDiagRunId: string;
  taskListPath: string;
  runWorkflowCommand: (input: RunWorkflowCommandInput) => Promise<MultiAgentWorkflowRunResult | null>;
  guardTaskListOwnership: (input: { taskListPath: string; baselineContent: string }) => Promise<AutoDevTaskListGuardResult>;
  buildReviewerTaskListPolicyContextSummary: (input: {
    outputLanguage: OutputLanguage;
    round: number;
    guard: AutoDevTaskListGuardResult;
  }) => string | null;
  appendWorkflowDiagEvent: (runId: string, kind: "autodev", stage: string, round: number, message: string) => void;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

export async function executeAutoDevWorkflowStageWithTaskListGuard(
  input: ExecuteAutoDevWorkflowStageInput,
): Promise<AutoDevWorkflowStageResult | null> {
  const localize = (zh: string, en: string): string => byOutputLanguage(input.outputLanguage, zh, en);

  const taskListBeforeWorkflow = await fs.readFile(input.taskListPath, "utf8");
  let taskListMutationObservedDuringWorkflow = false;

  const workflowResult = await input.runWorkflowCommand({
    objective: input.objective,
    sessionKey: input.sessionKey,
    message: input.message,
    requestId: input.requestId,
    workdir: input.workdir,
    diagRunId: input.workflowDiagRunId,
    resolveReviewerTaskListPolicyContext: async (policyInput) => {
      const reviewerGuard = await input.guardTaskListOwnership({
        taskListPath: input.taskListPath,
        baselineContent: taskListBeforeWorkflow,
      });
      if (reviewerGuard.changed) {
        taskListMutationObservedDuringWorkflow = true;
      }
      return input.buildReviewerTaskListPolicyContextSummary({
        outputLanguage: input.outputLanguage,
        round: policyInput.round,
        guard: reviewerGuard,
      });
    },
  });

  if (!workflowResult) {
    return null;
  }

  const taskListGuard = await input.guardTaskListOwnership({
    taskListPath: input.taskListPath,
    baselineContent: taskListBeforeWorkflow,
  });
  if (taskListGuard.changed || taskListMutationObservedDuringWorkflow) {
    const taskListGuardMessage = localize(
      `[CodeHarbor] AutoDev 策略保护：检测到 workflow 修改了 TASK_LIST.md，已自动回滚（仅系统可维护任务状态）。`,
      `[CodeHarbor] AutoDev policy guard: workflow modified TASK_LIST.md and was auto-rolled back (task status is system-managed only).`,
    );
    input.appendWorkflowDiagEvent(input.workflowDiagRunId, "autodev", "task_list_guard", 0, taskListGuardMessage);
    await input.sendNotice(input.message.conversationId, taskListGuardMessage);
    if (!taskListGuard.restored) {
      throw new Error(taskListGuard.error ?? "failed to restore TASK_LIST.md after forbidden workflow mutation");
    }
  }

  return {
    workflowResult,
    taskListGuard,
    taskListMutationObservedDuringWorkflow,
    taskListPolicyPassed: taskListGuard.restored && taskListGuard.finalClean,
  };
}
