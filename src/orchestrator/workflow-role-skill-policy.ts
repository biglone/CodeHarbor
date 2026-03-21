import { formatWorkflowRoleSkillLoaded } from "./helpers";
import type {
  WorkflowRoleSkillCatalog,
  WorkflowRoleSkillDisclosureMode,
  WorkflowRoleSkillPolicyOverride,
} from "../workflow/role-skills";

export interface WorkflowRoleSkillStatusSummary {
  enabled: boolean;
  mode: WorkflowRoleSkillDisclosureMode;
  maxChars: number;
  roots: string;
  loaded: string;
  override: string;
}

export function resolveWorkflowRoleSkillPolicy(input: {
  sessionKey: string;
  workflowRoleSkillPolicyOverrides: Map<string, WorkflowRoleSkillPolicyOverride>;
  workflowRoleSkillDefaultPolicy: WorkflowRoleSkillPolicyOverride;
  defaultEnabled: boolean;
  defaultMode: WorkflowRoleSkillDisclosureMode;
}): { enabled: boolean; mode: WorkflowRoleSkillDisclosureMode } {
  const override = input.workflowRoleSkillPolicyOverrides.get(input.sessionKey);
  return {
    enabled: override?.enabled ?? input.workflowRoleSkillDefaultPolicy.enabled ?? input.defaultEnabled,
    mode: override?.mode ?? input.workflowRoleSkillDefaultPolicy.mode ?? input.defaultMode,
  };
}

export function setWorkflowRoleSkillPolicyOverride(input: {
  sessionKey: string;
  next: WorkflowRoleSkillPolicyOverride;
  workflowRoleSkillPolicyOverrides: Map<string, WorkflowRoleSkillPolicyOverride>;
  workflowRoleSkillDefaultPolicy: WorkflowRoleSkillPolicyOverride;
  defaultEnabled: boolean;
  defaultMode: WorkflowRoleSkillDisclosureMode;
}): void {
  const current = input.workflowRoleSkillPolicyOverrides.get(input.sessionKey) ?? {};
  const mergedEnabled = input.next.enabled ?? current.enabled ?? input.workflowRoleSkillDefaultPolicy.enabled;
  const mergedMode = input.next.mode ?? current.mode ?? input.workflowRoleSkillDefaultPolicy.mode;
  const enabled = mergedEnabled ?? input.defaultEnabled;
  const mode = mergedMode ?? input.defaultMode;
  const sameAsDefault =
    enabled === (input.workflowRoleSkillDefaultPolicy.enabled ?? input.defaultEnabled) &&
    mode === (input.workflowRoleSkillDefaultPolicy.mode ?? input.defaultMode);
  if (sameAsDefault) {
    input.workflowRoleSkillPolicyOverrides.delete(input.sessionKey);
    return;
  }
  input.workflowRoleSkillPolicyOverrides.set(input.sessionKey, {
    enabled,
    mode,
  });
}

export function buildWorkflowRoleSkillStatus(input: {
  sessionKey: string;
  workflowRoleSkillCatalog: WorkflowRoleSkillCatalog;
  workflowRoleSkillPolicyOverrides: Map<string, WorkflowRoleSkillPolicyOverride>;
  workflowRoleSkillPolicy: { enabled: boolean; mode: WorkflowRoleSkillDisclosureMode };
}): WorkflowRoleSkillStatusSummary {
  const snapshot = input.workflowRoleSkillCatalog.getStatusSnapshot();
  const override = input.workflowRoleSkillPolicyOverrides.get(input.sessionKey);
  return {
    enabled: input.workflowRoleSkillPolicy.enabled,
    mode: input.workflowRoleSkillPolicy.mode,
    maxChars: snapshot.maxChars,
    roots: snapshot.roots.length > 0 ? snapshot.roots.join(", ") : "(default)",
    loaded: formatWorkflowRoleSkillLoaded(snapshot),
    override: override ? `enabled=${override.enabled ? "on" : "off"}, mode=${override.mode}` : "none",
  };
}
