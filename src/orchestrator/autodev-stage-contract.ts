import type { MultiAgentWorkflowRunResult } from "../workflow/multi-agent-workflow";

export interface AutoDevTaskListGuardResult {
  changed: boolean;
  restored: boolean;
  finalClean: boolean;
  error: string | null;
}

export interface AutoDevWorkflowStageResult {
  workflowResult: MultiAgentWorkflowRunResult;
  taskListGuard: AutoDevTaskListGuardResult;
  taskListMutationObservedDuringWorkflow: boolean;
  taskListPolicyPassed: boolean;
}
