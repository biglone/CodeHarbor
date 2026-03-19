import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type WorkflowRole = "planner" | "executor" | "reviewer";
export type WorkflowRoleSkillDisclosureMode = "summary" | "progressive" | "full";
export type WorkflowRoleSkillDisclosureLevel = "summary" | "full";

export interface WorkflowRoleSkillPolicyOverride {
  enabled?: boolean;
  mode?: WorkflowRoleSkillDisclosureMode;
}

export interface WorkflowRoleSkillCatalogOptions {
  enabled?: boolean;
  mode?: WorkflowRoleSkillDisclosureMode;
  maxChars?: number;
  roots?: string[];
  roleAssignments?: Partial<Record<WorkflowRole, string[]>>;
}

export interface WorkflowRoleSkillPromptInput {
  role: WorkflowRole;
  stage: "planner" | "executor" | "reviewer" | "repair";
  round: number;
  policy?: WorkflowRoleSkillPolicyOverride;
}

export interface WorkflowRoleSkillPromptResult {
  text: string | null;
  enabled: boolean;
  mode: WorkflowRoleSkillDisclosureMode;
  disclosure: WorkflowRoleSkillDisclosureLevel | null;
  usedSkills: string[];
}

export interface WorkflowRoleSkillStatusSnapshot {
  enabled: boolean;
  mode: WorkflowRoleSkillDisclosureMode;
  maxChars: number;
  roots: string[];
  roleAssignments: Record<WorkflowRole, string[]>;
  loadedSkills: Record<WorkflowRole, string[]>;
}

interface WorkflowSkillEntry {
  id: string;
  title: string;
  summary: string;
  content: string;
  source: "builtin" | "local";
}

const DEFAULT_ROLE_SKILL_MAX_CHARS = 2_400;
const DEFAULT_ROLE_SKILL_ROOT = path.join(os.homedir(), ".codex", "skills");

const DEFAULT_ROLE_ASSIGNMENTS: Record<WorkflowRole, string[]> = {
  planner: ["task-planner", "requirements-doc", "builtin-planner-core"],
  executor: ["autonomous-dev", "bug-finder", "test-generator", "builtin-executor-core"],
  reviewer: ["code-reviewer", "security-audit", "builtin-reviewer-core"],
};

const BUILTIN_ROLE_SKILLS: WorkflowSkillEntry[] = [
  {
    id: "builtin-planner-core",
    title: "Planner Core",
    source: "builtin",
    summary: "先对目标做范围划分、依赖识别和风险排序，再给可执行分步计划。",
    content: [
      "你负责规划阶段：",
      "1) 把目标拆成 3-7 个可执行步骤，并标注每步输入/输出。",
      "2) 优先识别阻塞项、未知项和外部依赖。",
      "3) 给出风险和回退路径，避免一次性大改。",
      "4) 明确验证路径（测试、lint、类型检查、手动验证）。",
    ].join("\n"),
  },
  {
    id: "builtin-executor-core",
    title: "Executor Core",
    source: "builtin",
    summary: "优先交付可运行结果，小步修改并持续验证，不做无关重构。",
    content: [
      "你负责执行阶段：",
      "1) 先做最小闭环实现，再增量完善。",
      "2) 按既有代码风格修改，不引入无关改动。",
      "3) 每轮至少给出一个可验证产物。",
      "4) 失败时定位根因并修复，不重复尝试同一路径。",
    ].join("\n"),
  },
  {
    id: "builtin-reviewer-core",
    title: "Reviewer Core",
    source: "builtin",
    summary: "以需求达成为第一标准，关注正确性、稳定性、可维护性与回归风险。",
    content: [
      "你负责审查阶段：",
      "1) 严格比对目标与交付结果，先看是否达成需求。",
      "2) 检查边界条件、失败路径和回归风险。",
      "3) 问题必须可执行：给出最小修复建议。",
      "4) 结论必须输出 VERDICT: APPROVED/REJECTED。",
    ].join("\n"),
  },
];

export class WorkflowRoleSkillCatalog {
  private readonly enabled: boolean;
  private readonly mode: WorkflowRoleSkillDisclosureMode;
  private readonly maxChars: number;
  private readonly roots: string[];
  private readonly roleAssignments: Record<WorkflowRole, string[]>;
  private readonly allSkills = new Map<string, WorkflowSkillEntry>();

  constructor(options?: WorkflowRoleSkillCatalogOptions) {
    this.enabled = options?.enabled ?? true;
    this.mode = options?.mode ?? "progressive";
    this.maxChars = normalizeMaxChars(options?.maxChars);
    this.roots = normalizeRoots(options?.roots);
    this.roleAssignments = normalizeRoleAssignments(options?.roleAssignments);

    this.registerBuiltinSkills();
    this.registerLocalSkills();
  }

  getStatusSnapshot(): WorkflowRoleSkillStatusSnapshot {
    return {
      enabled: this.enabled,
      mode: this.mode,
      maxChars: this.maxChars,
      roots: [...this.roots],
      roleAssignments: cloneRoleAssignments(this.roleAssignments),
      loadedSkills: {
        planner: this.resolveRoleSkills("planner").map((skill) => `${skill.id}(${skill.source})`),
        executor: this.resolveRoleSkills("executor").map((skill) => `${skill.id}(${skill.source})`),
        reviewer: this.resolveRoleSkills("reviewer").map((skill) => `${skill.id}(${skill.source})`),
      },
    };
  }

  buildPrompt(input: WorkflowRoleSkillPromptInput): WorkflowRoleSkillPromptResult {
    const enabled = input.policy?.enabled ?? this.enabled;
    const mode = input.policy?.mode ?? this.mode;
    if (!enabled) {
      return {
        text: null,
        enabled: false,
        mode,
        disclosure: null,
        usedSkills: [],
      };
    }

    const skills = this.resolveRoleSkills(input.role);
    if (skills.length === 0) {
      return {
        text: null,
        enabled: true,
        mode,
        disclosure: null,
        usedSkills: [],
      };
    }

    const disclosure = resolveDisclosureLevel(mode, input.stage, input.round);
    const bodyChunks: string[] = [];
    const usedSkills: string[] = [];

    for (const skill of skills) {
      const blockContent = disclosure === "summary" ? skill.summary : skill.content;
      const normalizedContent = blockContent.trim();
      if (!normalizedContent) {
        continue;
      }
      usedSkills.push(skill.id);
      bodyChunks.push(
        [
          `[skill id="${skill.id}" source="${skill.source}" disclosure="${disclosure}"]`,
          normalizedContent,
          "[/skill]",
        ].join("\n"),
      );
    }

    if (bodyChunks.length === 0) {
      return {
        text: null,
        enabled: true,
        mode,
        disclosure: null,
        usedSkills: [],
      };
    }

    const rawBlock = [
      "[role_skills]",
      `role=${input.role}`,
      `mode=${mode}`,
      `stage=${input.stage}`,
      `round=${input.round}`,
      `disclosure=${disclosure}`,
      ...bodyChunks,
      "[/role_skills]",
    ].join("\n\n");

    return {
      text: trimToMaxChars(rawBlock, this.maxChars),
      enabled: true,
      mode,
      disclosure,
      usedSkills,
    };
  }

  private resolveRoleSkills(role: WorkflowRole): WorkflowSkillEntry[] {
    const selected = this.roleAssignments[role] ?? [];
    const unique = new Map<string, WorkflowSkillEntry>();
    for (const skillId of selected) {
      const skill = this.allSkills.get(skillId.trim().toLowerCase());
      if (!skill) {
        continue;
      }
      unique.set(skill.id, skill);
    }
    return [...unique.values()];
  }

  private registerBuiltinSkills(): void {
    for (const skill of BUILTIN_ROLE_SKILLS) {
      this.registerSkill(skill, [skill.id]);
    }
  }

  private registerLocalSkills(): void {
    for (const root of this.roots) {
      const files = listSkillFiles(root, 4);
      for (const filePath of files) {
        const content = readTextFile(filePath);
        if (!content) {
          continue;
        }
        const dirPath = path.dirname(filePath);
        const relativeDir = path.relative(root, dirPath).replace(/\\/g, "/");
        const baseName = path.basename(dirPath);
        const id = relativeDir && relativeDir !== "." ? relativeDir : baseName;
        const title = extractTitle(content, baseName || id || "skill");
        const summary = extractSummary(content, title);
        const skill: WorkflowSkillEntry = {
          id,
          title,
          summary,
          content: content.trim(),
          source: "local",
        };
        this.registerSkill(skill, [id, baseName, title]);
      }
    }
  }

  private registerSkill(skill: WorkflowSkillEntry, aliases: string[]): void {
    const normalized = {
      ...skill,
      id: skill.id.trim(),
      title: skill.title.trim() || skill.id.trim(),
      summary: skill.summary.trim(),
      content: skill.content.trim(),
    };
    if (!normalized.id || !normalized.content) {
      return;
    }
    for (const alias of aliases) {
      const key = alias.trim().toLowerCase();
      if (!key) {
        continue;
      }
      if (!this.allSkills.has(key)) {
        this.allSkills.set(key, normalized);
      }
    }
    const canonicalKey = normalized.id.toLowerCase();
    this.allSkills.set(canonicalKey, normalized);
  }
}

function resolveDisclosureLevel(
  mode: WorkflowRoleSkillDisclosureMode,
  stage: WorkflowRoleSkillPromptInput["stage"],
  round: number,
): WorkflowRoleSkillDisclosureLevel {
  if (mode === "full") {
    return "full";
  }
  if (mode === "summary") {
    return "summary";
  }
  if (stage === "repair") {
    return "full";
  }
  if (round > 0) {
    return "full";
  }
  return "summary";
}

function normalizeMaxChars(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value < 200) {
    return DEFAULT_ROLE_SKILL_MAX_CHARS;
  }
  return Math.floor(value);
}

function normalizeRoots(roots: string[] | undefined): string[] {
  const source = roots ?? (process.env.NODE_ENV === "test" ? [] : [DEFAULT_ROLE_SKILL_ROOT]);
  const unique = new Set<string>();
  for (const root of source) {
    if (!root.trim()) {
      continue;
    }
    const normalized = path.resolve(root);
    unique.add(normalized);
  }
  return [...unique];
}

function normalizeRoleAssignments(
  roleAssignments: Partial<Record<WorkflowRole, string[]>> | undefined,
): Record<WorkflowRole, string[]> {
  const next: Record<WorkflowRole, string[]> = {
    planner: [...DEFAULT_ROLE_ASSIGNMENTS.planner],
    executor: [...DEFAULT_ROLE_ASSIGNMENTS.executor],
    reviewer: [...DEFAULT_ROLE_ASSIGNMENTS.reviewer],
  };
  if (!roleAssignments) {
    return next;
  }
  for (const role of ["planner", "executor", "reviewer"] as WorkflowRole[]) {
    const list = roleAssignments[role];
    if (!list) {
      continue;
    }
    next[role] = dedupeSkillIds(list);
  }
  return next;
}

function dedupeSkillIds(items: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(trimmed);
  }
  return next;
}

function listSkillFiles(root: string, maxDepth: number): string[] {
  if (maxDepth < 0) {
    return [];
  }
  if (!fs.existsSync(root)) {
    return [];
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const results: string[] = [];
  walkSkillDir(root, 0, maxDepth, results);
  return results;
}

function walkSkillDir(current: string, depth: number, maxDepth: number, results: string[]): void {
  if (depth > maxDepth) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      results.push(fullPath);
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    walkSkillDir(fullPath, depth + 1, maxDepth, results);
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function extractTitle(content: string, fallback: string): string {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("#")) {
      return trimmed.replace(/^#+\s*/, "").trim() || fallback;
    }
  }
  return fallback;
}

function extractSummary(content: string, fallback: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) {
    return fallback;
  }
  return summarizeSingleLine(lines[0], 180);
}

function summarizeSingleLine(value: string, maxLen: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen)}...`;
}

function trimToMaxChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = "\n...[role_skills truncated]...\n";
  const headLen = Math.max(0, maxChars - marker.length);
  return `${value.slice(0, headLen)}${marker}`;
}

function cloneRoleAssignments(assignments: Record<WorkflowRole, string[]>): Record<WorkflowRole, string[]> {
  return {
    planner: [...assignments.planner],
    executor: [...assignments.executor],
    reviewer: [...assignments.reviewer],
  };
}
