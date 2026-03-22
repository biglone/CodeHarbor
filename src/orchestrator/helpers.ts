import {
  type WorkflowRole,
  type WorkflowRoleSkillDisclosureMode,
  type WorkflowRoleSkillStatusSnapshot,
} from "../workflow/role-skills";
import type { OutputLanguage } from "../config";
import type { MultiAgentWorkflowProgressEvent } from "../workflow/multi-agent-workflow";

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function summarizeSingleLine(text: string, maxLen: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "unknown";
  }
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen)}...`;
}

export function formatDurationMs(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = ((durationMs % 60_000) / 1_000).toFixed(1);
  return `${minutes}m${seconds}s`;
}

export function formatRunWindowDuration(startedAt: string | null, endedAt: string | null, nowMs = Date.now()): string {
  if (!startedAt) {
    return "N/A";
  }
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) {
    return "N/A";
  }
  const endMs = endedAt ? Date.parse(endedAt) : nowMs;
  if (!Number.isFinite(endMs)) {
    return "N/A";
  }
  return formatDurationMs(Math.max(0, endMs - startMs));
}

export function formatWorkflowDiagRunDuration(
  run: { durationMs: number | null; startedAt: string; endedAt: string | null },
  nowMs = Date.now(),
): string {
  if (typeof run.durationMs === "number" && Number.isFinite(run.durationMs)) {
    return formatDurationMs(Math.max(0, run.durationMs));
  }
  return formatRunWindowDuration(run.startedAt, run.endedAt, nowMs);
}

export function formatCacheTtl(ttlMs: number): string {
  if (ttlMs < 0) {
    return "disabled";
  }
  if (ttlMs < 1_000) {
    return `${ttlMs}ms`;
  }
  if (ttlMs < 60_000) {
    return `${Math.round(ttlMs / 1_000)}s`;
  }
  if (ttlMs < 60 * 60_000) {
    return `${Math.round(ttlMs / 60_000)}m`;
  }
  return `${(ttlMs / (60 * 60_000)).toFixed(1)}h`;
}

export function formatWorkflowContextBudget(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return "unlimited";
  }
  return String(Math.floor(value));
}

export function formatWorkflowRoleSkillLoaded(snapshot: WorkflowRoleSkillStatusSnapshot): string {
  return [
    `planner=${formatWorkflowRoleSkillList(snapshot.loadedSkills.planner)}`,
    `executor=${formatWorkflowRoleSkillList(snapshot.loadedSkills.executor)}`,
    `reviewer=${formatWorkflowRoleSkillList(snapshot.loadedSkills.reviewer)}`,
  ].join("; ");
}

function formatWorkflowRoleSkillList(items: string[]): string {
  if (items.length === 0) {
    return "(none)";
  }
  if (items.length <= 6) {
    return items.join(", ");
  }
  return `${items.slice(0, 6).join(", ")}, ... (+${items.length - 6})`;
}

export function formatWorkflowProgressNotice(
  event: MultiAgentWorkflowProgressEvent,
  detailed: boolean,
  outputLanguage: OutputLanguage,
): string {
  const stageLabel = resolveWorkflowStageLabel(event.stage, outputLanguage);
  const agent = resolveWorkflowStageAgent(event.stage);
  const round = event.stage === "repair" ? Math.max(1, event.round) : event.round + 1;
  if (detailed) {
    if (outputLanguage === "en") {
      return `[${stageLabel}] agent=${agent}, round=${round} ${event.message}`;
    }
    return `[${stageLabel}] 代理=${agent}，轮次=${round} ${event.message}`;
  }
  if (outputLanguage === "en") {
    return `[${stageLabel}] round=${round} ${compactWorkflowProgressMessage(event.message, outputLanguage)}`;
  }
  return `[${stageLabel}] 轮次=${round} ${compactWorkflowProgressMessage(event.message, outputLanguage)}`;
}

function compactWorkflowProgressMessage(message: string, outputLanguage: OutputLanguage): string {
  const stripped = message.replace(/（[^（）]*）/g, "").replace(/\s+/g, " ").trim();
  if (!stripped) {
    return outputLanguage === "en" ? "processing" : "阶段处理中";
  }
  return stripped;
}

function resolveWorkflowStageLabel(stage: MultiAgentWorkflowProgressEvent["stage"], outputLanguage: OutputLanguage): string {
  if (outputLanguage === "en" || outputLanguage === "zh") {
    return stage.toUpperCase();
  }
  return stage.toUpperCase();
}

function resolveWorkflowStageAgent(stage: MultiAgentWorkflowProgressEvent["stage"]): string {
  if (stage === "planner") {
    return "planner";
  }
  if (stage === "reviewer") {
    return "reviewer";
  }
  return "executor";
}

export function parseCsvValues(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseOptionalCsvValues(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return parseCsvValues(raw);
}

export function parseRoleSkillDisclosureMode(
  raw: string | WorkflowRoleSkillDisclosureMode | undefined,
  fallback: WorkflowRoleSkillDisclosureMode,
): WorkflowRoleSkillDisclosureMode {
  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "summary" || normalized === "progressive" || normalized === "full") {
    return normalized;
  }
  return fallback;
}

export function parseRoleSkillAssignments(raw: string | undefined): Partial<Record<WorkflowRole, string[]>> | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const payload = parsed as Record<string, unknown>;
  const output: Partial<Record<WorkflowRole, string[]>> = {};
  for (const role of ["planner", "executor", "reviewer"] as WorkflowRole[]) {
    const value = payload[role];
    if (!Array.isArray(value)) {
      continue;
    }
    output[role] = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function parseEnvPositiveInt(raw: string | undefined, fallback: number): number {
  const normalized = raw?.trim();
  if (!normalized) {
    return fallback;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

export function parseEnvOptionalPositiveInt(raw: string | undefined): number | null {
  const normalized = raw?.trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

export function parseEnvBoolean(raw: string | undefined, fallback: boolean): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}
