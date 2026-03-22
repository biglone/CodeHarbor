import type { CodexExecutor } from "../executor/codex-executor";
import type { Logger } from "../logger";
import {
  DEFAULT_WORKFLOW_ROLE_SKILLS_ENABLED,
  DEFAULT_WORKFLOW_ROLE_SKILLS_MODE,
} from "./orchestrator-constants";
import type { OrchestratorOptions } from "./orchestrator-config-types";
import {
  parseEnvBoolean,
  parseEnvOptionalPositiveInt,
  parseOptionalCsvValues,
  parseRoleSkillAssignments,
  parseRoleSkillDisclosureMode,
} from "./helpers";
import type { WorkflowRoleSkillPolicyOverride } from "../workflow/role-skills";
import { WorkflowRoleSkillCatalog } from "../workflow/role-skills";
import { MultiAgentWorkflowRunner } from "../workflow/multi-agent-workflow";

export interface WorkflowRuntimeConfig {
  workflowRoleSkillCatalog: WorkflowRoleSkillCatalog;
  workflowRoleSkillDefaultPolicy: WorkflowRoleSkillPolicyOverride;
  workflowPlanContextMaxChars: number | null;
  workflowOutputContextMaxChars: number | null;
  workflowFeedbackContextMaxChars: number | null;
  workflowRunner: MultiAgentWorkflowRunner;
}

export function resolveWorkflowRuntimeConfig(input: {
  options: OrchestratorOptions | undefined;
  executor: CodexExecutor;
  logger: Logger;
}): WorkflowRuntimeConfig {
  const workflowPlanContextMaxChars =
    input.options?.multiAgentWorkflow?.planContextMaxChars ??
    parseEnvOptionalPositiveInt(process.env.AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS);
  const workflowOutputContextMaxChars =
    input.options?.multiAgentWorkflow?.outputContextMaxChars ??
    parseEnvOptionalPositiveInt(process.env.AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS);
  const workflowFeedbackContextMaxChars =
    input.options?.multiAgentWorkflow?.feedbackContextMaxChars ??
    parseEnvOptionalPositiveInt(process.env.AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS);
  const workflowRoleSkillsEnabled =
    input.options?.multiAgentWorkflow?.roleSkills?.enabled ??
    parseEnvBoolean(process.env.AGENT_WORKFLOW_ROLE_SKILLS_ENABLED, DEFAULT_WORKFLOW_ROLE_SKILLS_ENABLED);
  const workflowRoleSkillsMode = parseRoleSkillDisclosureMode(
    input.options?.multiAgentWorkflow?.roleSkills?.mode ?? process.env.AGENT_WORKFLOW_ROLE_SKILLS_MODE,
    DEFAULT_WORKFLOW_ROLE_SKILLS_MODE,
  );
  const workflowRoleSkillsMaxChars =
    input.options?.multiAgentWorkflow?.roleSkills?.maxChars ??
    parseEnvOptionalPositiveInt(process.env.AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS) ??
    undefined;
  const workflowRoleSkillsRoots = input.options?.multiAgentWorkflow?.roleSkills?.roots ?? parseOptionalCsvValues(
    process.env.AGENT_WORKFLOW_ROLE_SKILLS_ROOTS,
  );
  const workflowRoleSkillAssignments =
    input.options?.multiAgentWorkflow?.roleSkills?.roleAssignments ??
    parseRoleSkillAssignments(process.env.AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON);

  const workflowRoleSkillCatalog = new WorkflowRoleSkillCatalog({
    enabled: workflowRoleSkillsEnabled,
    mode: workflowRoleSkillsMode,
    maxChars: workflowRoleSkillsMaxChars,
    roots: workflowRoleSkillsRoots,
    roleAssignments: workflowRoleSkillAssignments,
  });
  const workflowRoleSkillDefaultPolicy: WorkflowRoleSkillPolicyOverride = {
    enabled: workflowRoleSkillsEnabled,
    mode: workflowRoleSkillsMode,
  };
  const workflowRunner = new MultiAgentWorkflowRunner(input.executor, input.logger, {
    enabled: input.options?.multiAgentWorkflow?.enabled ?? false,
    autoRepairMaxRounds: input.options?.multiAgentWorkflow?.autoRepairMaxRounds ?? 1,
    outputLanguage: input.options?.outputLanguage,
    executionTimeoutMs: input.options?.multiAgentWorkflow?.executionTimeoutMs,
    planContextMaxChars: workflowPlanContextMaxChars,
    outputContextMaxChars: workflowOutputContextMaxChars,
    feedbackContextMaxChars: workflowFeedbackContextMaxChars,
    roleSkillCatalog: workflowRoleSkillCatalog,
  });

  return {
    workflowRoleSkillCatalog,
    workflowRoleSkillDefaultPolicy,
    workflowPlanContextMaxChars,
    workflowOutputContextMaxChars,
    workflowFeedbackContextMaxChars,
    workflowRunner,
  };
}
