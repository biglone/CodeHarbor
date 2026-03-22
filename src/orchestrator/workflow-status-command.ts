import type { InboundMessage } from "../types";
import type { OutputLanguage } from "../config";
import { createIdleWorkflowSnapshot, type WorkflowRunSnapshot } from "../workflow/multi-agent-workflow";
import { byOutputLanguage } from "./output-language";

interface RoleSkillStatusLike {
  enabled: boolean;
  mode: string;
  maxChars: number;
  override: string;
  loaded: string;
}

interface WorkflowStatusCommandDeps {
  outputLanguage: OutputLanguage;
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
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  await deps.sendNotice(
    input.message.conversationId,
    localize(
      `[CodeHarbor] 多智能体流程状态
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
      `[CodeHarbor] Multi-Agent workflow status
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
    ),
  );
}
