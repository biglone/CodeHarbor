import type { InboundMessage } from "../types";
import { createIdleWorkflowSnapshot, type WorkflowRunSnapshot } from "../workflow/multi-agent-workflow";

interface RoleSkillStatusLike {
  enabled: boolean;
  mode: string;
  maxChars: number;
  override: string;
  loaded: string;
}

interface WorkflowStatusCommandDeps {
  workflowPlanContextMaxChars: number | null;
  workflowOutputContextMaxChars: number | null;
  workflowFeedbackContextMaxChars: number | null;
  getWorkflowSnapshot: (sessionKey: string) => WorkflowRunSnapshot | null;
  buildWorkflowRoleSkillStatus: (sessionKey: string) => RoleSkillStatusLike;
  formatWorkflowContextBudget: (value: number | null) => string;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

interface WorkflowStatusCommandInput {
  sessionKey: string;
  message: InboundMessage;
}

export async function handleWorkflowStatusCommand(
  deps: WorkflowStatusCommandDeps,
  input: WorkflowStatusCommandInput,
): Promise<void> {
  const snapshot = deps.getWorkflowSnapshot(input.sessionKey) ?? createIdleWorkflowSnapshot();
  const roleSkillStatus = deps.buildWorkflowRoleSkillStatus(input.sessionKey);
  await deps.sendNotice(
    input.message.conversationId,
    `[CodeHarbor] Multi-Agent 工作流状态
- state: ${snapshot.state}
- startedAt: ${snapshot.startedAt ?? "N/A"}
- endedAt: ${snapshot.endedAt ?? "N/A"}
- objective: ${snapshot.objective ?? "N/A"}
- approved: ${snapshot.approved === null ? "N/A" : snapshot.approved ? "yes" : "no"}
- repairRounds: ${snapshot.repairRounds}
- contextBudget: plan=${deps.formatWorkflowContextBudget(deps.workflowPlanContextMaxChars)}, output=${deps.formatWorkflowContextBudget(
      deps.workflowOutputContextMaxChars,
    )}, feedback=${deps.formatWorkflowContextBudget(deps.workflowFeedbackContextMaxChars)}
- roleSkills: enabled=${roleSkillStatus.enabled ? "on" : "off"}, mode=${roleSkillStatus.mode}, maxChars=${roleSkillStatus.maxChars}, override=${roleSkillStatus.override}
- roleSkillsLoaded: ${roleSkillStatus.loaded}
- error: ${snapshot.error ?? "N/A"}`,
  );
}
