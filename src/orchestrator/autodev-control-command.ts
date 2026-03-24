import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

import type { InboundMessage } from "../types";
import type { OutputLanguage } from "../config";
import { loadAutoDevContext, summarizeAutoDevTasks } from "../workflow/autodev";
import { formatError } from "./helpers";
import { byOutputLanguage } from "./output-language";

interface RoleSkillStatusLike {
  enabled: boolean;
  mode: string;
  maxChars: number;
  roots: string;
  override: string;
  loaded: string;
}

export interface AutoDevControlCommandDeps {
  autoDevDetailedProgressDefaultEnabled: boolean;
  outputLanguage: OutputLanguage;
  pendingAutoDevLoopStopRequests: Set<string>;
  activeAutoDevLoopSessions: Set<string>;
  isAutoDevDetailedProgressEnabled: (sessionKey: string) => boolean;
  setAutoDevDetailedProgressEnabled: (sessionKey: string, enabled: boolean) => void;
  setWorkflowRoleSkillPolicyOverride: (
    sessionKey: string,
    next: { enabled?: boolean; mode?: "summary" | "progressive" | "full" },
  ) => void;
  buildWorkflowRoleSkillStatus: (sessionKey: string) => RoleSkillStatusLike;
  getAutoDevWorkdirOverride: (sessionKey: string) => string | null;
  setAutoDevWorkdirOverride: (sessionKey: string, workdir: string) => void;
  clearAutoDevWorkdirOverride: (sessionKey: string) => void;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

interface AutoDevControlCommandInput {
  sessionKey: string;
  message: InboundMessage;
}

interface AutoDevWorkdirCommandInput extends AutoDevControlCommandInput {
  mode: "status" | "set" | "clear";
  path: string | null;
  roomWorkdir: string;
}

interface AutoDevInitCommandInput extends AutoDevControlCommandInput {
  path: string | null;
  skill: string | null;
  roomWorkdir: string;
}

export async function handleAutoDevProgressCommand(
  deps: AutoDevControlCommandDeps,
  input: AutoDevControlCommandInput & { mode: "status" | "on" | "off" },
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  const current = deps.isAutoDevDetailedProgressEnabled(input.sessionKey) ? "on" : "off";
  const defaultMode = deps.autoDevDetailedProgressDefaultEnabled ? "on" : "off";
  if (input.mode === "status") {
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 过程回显设置
- detailedProgress: ${current}
- default: ${defaultMode}
- usage: /autodev progress on|off|status`,
        `[CodeHarbor] AutoDev progress echo settings
- detailedProgress: ${current}
- default: ${defaultMode}
- usage: /autodev progress on|off|status`,
      ),
    );
    return;
  }

  const enabled = input.mode === "on";
  deps.setAutoDevDetailedProgressEnabled(input.sessionKey, enabled);
  await deps.sendNotice(
    input.message.conversationId,
    localize(
      `[CodeHarbor] AutoDev 过程回显已更新
- detailedProgress: ${enabled ? "on" : "off"}
- default: ${defaultMode}
- session: ${input.sessionKey}`,
      `[CodeHarbor] AutoDev progress echo updated
- detailedProgress: ${enabled ? "on" : "off"}
- default: ${defaultMode}
- session: ${input.sessionKey}`,
    ),
  );
}

export async function handleAutoDevSkillsCommand(
  deps: AutoDevControlCommandDeps,
  input: AutoDevControlCommandInput & { mode: "status" | "on" | "off" | "summary" | "progressive" | "full" },
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  if (input.mode !== "status") {
    if (input.mode === "on") {
      deps.setWorkflowRoleSkillPolicyOverride(input.sessionKey, {
        enabled: true,
      });
    } else if (input.mode === "off") {
      deps.setWorkflowRoleSkillPolicyOverride(input.sessionKey, {
        enabled: false,
      });
    } else {
      deps.setWorkflowRoleSkillPolicyOverride(input.sessionKey, {
        enabled: true,
        mode: input.mode,
      });
    }
  }

  const roleSkillStatus = deps.buildWorkflowRoleSkillStatus(input.sessionKey);
  await deps.sendNotice(
    input.message.conversationId,
    localize(
      `[CodeHarbor] AutoDev 角色技能设置
- enabled: ${roleSkillStatus.enabled ? "on" : "off"}
- mode: ${roleSkillStatus.mode}
- maxChars: ${roleSkillStatus.maxChars}
- roots: ${roleSkillStatus.roots}
- override: ${roleSkillStatus.override}
- loaded: ${roleSkillStatus.loaded}
- usage: /autodev skills on|off|summary|progressive|full|status`,
      `[CodeHarbor] AutoDev role skill settings
- enabled: ${roleSkillStatus.enabled ? "on" : "off"}
- mode: ${roleSkillStatus.mode}
- maxChars: ${roleSkillStatus.maxChars}
- roots: ${roleSkillStatus.roots}
- override: ${roleSkillStatus.override}
- loaded: ${roleSkillStatus.loaded}
- usage: /autodev skills on|off|summary|progressive|full|status`,
    ),
  );
}

export async function handleAutoDevLoopStopCommand(
  deps: AutoDevControlCommandDeps,
  input: AutoDevControlCommandInput,
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  if (!deps.activeAutoDevLoopSessions.has(input.sessionKey)) {
    await deps.sendNotice(
      input.message.conversationId,
      localize("[CodeHarbor] 当前没有运行中的 AutoDev 循环任务。", "[CodeHarbor] No running AutoDev loop task."),
    );
    return;
  }
  if (deps.pendingAutoDevLoopStopRequests.has(input.sessionKey)) {
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        "[CodeHarbor] 已收到停止请求：当前任务完成后会停止循环，不会启动下一任务。",
        "[CodeHarbor] Stop request already received: loop will stop after current task and will not start next task.",
      ),
    );
    return;
  }

  deps.pendingAutoDevLoopStopRequests.add(input.sessionKey);
  await deps.sendNotice(
    input.message.conversationId,
    localize(
      "[CodeHarbor] 已收到停止请求：将等待当前任务执行完成后停止 AutoDev 循环。",
      "[CodeHarbor] Stop request received: AutoDev loop will stop after current task completes.",
    ),
  );
}

export async function handleAutoDevWorkdirCommand(
  deps: AutoDevControlCommandDeps,
  input: AutoDevWorkdirCommandInput,
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  const noneText = localize("无", "none");
  const currentOverride = deps.getAutoDevWorkdirOverride(input.sessionKey);
  const effectiveWorkdir = currentOverride ?? input.roomWorkdir;
  if (input.mode === "status") {
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 工作目录
- effectiveWorkdir: ${effectiveWorkdir}
- roomWorkdir: ${input.roomWorkdir}
- override: ${currentOverride ?? noneText}
- usage: /autodev workdir [path]|status|clear`,
        `[CodeHarbor] AutoDev workdir
- effectiveWorkdir: ${effectiveWorkdir}
- roomWorkdir: ${input.roomWorkdir}
- override: ${currentOverride ?? noneText}
- usage: /autodev workdir [path]|status|clear`,
      ),
    );
    return;
  }

  if (input.mode === "clear") {
    deps.clearAutoDevWorkdirOverride(input.sessionKey);
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] 已清除 AutoDev 工作目录覆盖，恢复为房间默认目录。
- effectiveWorkdir: ${input.roomWorkdir}`,
        `[CodeHarbor] Cleared AutoDev workdir override. Reverted to room default.
- effectiveWorkdir: ${input.roomWorkdir}`,
      ),
    );
    return;
  }

  const resolved = resolveTargetPath(input.path, input.roomWorkdir);
  try {
    await assertDirectoryExists(resolved);
  } catch (error) {
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 工作目录设置失败：${formatError(error)}`,
        `[CodeHarbor] Failed to set AutoDev workdir: ${formatError(error)}`,
      ),
    );
    return;
  }

  deps.setAutoDevWorkdirOverride(input.sessionKey, resolved);
  await deps.sendNotice(
    input.message.conversationId,
    localize(
      `[CodeHarbor] AutoDev 工作目录已更新
- effectiveWorkdir: ${resolved}
- next: 先执行 /autodev status，再执行 /autodev run`,
      `[CodeHarbor] AutoDev workdir updated
- effectiveWorkdir: ${resolved}
- next: run /autodev status, then /autodev run`,
    ),
  );
}

export async function handleAutoDevInitCommand(
  deps: AutoDevControlCommandDeps,
  input: AutoDevInitCommandInput,
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  const noneText = localize("无", "none");
  const baseWorkdir = deps.getAutoDevWorkdirOverride(input.sessionKey) ?? input.roomWorkdir;
  const targetWorkdir = resolveTargetPath(input.path, baseWorkdir);
  try {
    await assertDirectoryExists(targetWorkdir);
    deps.setAutoDevWorkdirOverride(input.sessionKey, targetWorkdir);

    const createdFiles = await scaffoldAutoDevCompassFiles(targetWorkdir);
    const context = await loadAutoDevContext(targetWorkdir);
    const summary = summarizeAutoDevTasks(context.tasks);
    const createdText = createdFiles.length > 0 ? createdFiles.join(", ") : noneText;

    await deps.sendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 任务罗盘已就绪
- targetWorkdir: ${targetWorkdir}
- createdFiles: ${createdText}
- REQUIREMENTS.md: ${context.requirementsContent ? "found" : "missing"}
- TASK_LIST.md: ${context.taskListContent ? "found" : "missing"}
- tasks: total=${summary.total}, pending=${summary.pending}, in_progress=${summary.inProgress}, completed=${summary.completed}, blocked=${summary.blocked}, cancelled=${summary.cancelled}
- next: 执行 /autodev run（或 /autodev run T0.1）`,
        `[CodeHarbor] AutoDev task compass is ready
- targetWorkdir: ${targetWorkdir}
- createdFiles: ${createdText}
- REQUIREMENTS.md: ${context.requirementsContent ? "found" : "missing"}
- TASK_LIST.md: ${context.taskListContent ? "found" : "missing"}
- tasks: total=${summary.total}, pending=${summary.pending}, in_progress=${summary.inProgress}, completed=${summary.completed}, blocked=${summary.blocked}, cancelled=${summary.cancelled}
- next: run /autodev run (or /autodev run T0.1)`,
      ),
    );
  } catch (error) {
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 任务罗盘初始化失败：${formatError(error)}`,
        `[CodeHarbor] Failed to initialize AutoDev task compass: ${formatError(error)}`,
      ),
    );
  }
}

async function assertDirectoryExists(targetPath: string): Promise<void> {
  const stats = await fs.stat(targetPath);
  if (!stats.isDirectory()) {
    throw new Error(`target is not a directory: ${targetPath}`);
  }
}

function resolveTargetPath(rawPath: string | null, baseWorkdir: string): string {
  const normalized = (rawPath ?? "").trim();
  if (!normalized) {
    return path.resolve(baseWorkdir);
  }
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  const resolvedInBase = path.resolve(baseWorkdir, normalized);
  if (looksLikeProjectName(normalized)) {
    const resolvedSibling = path.resolve(baseWorkdir, "..", normalized);
    if (!existsSync(resolvedInBase) && existsSync(resolvedSibling)) {
      return resolvedSibling;
    }
  }
  return resolvedInBase;
}

function looksLikeProjectName(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\");
}

async function scaffoldAutoDevCompassFiles(targetWorkdir: string): Promise<string[]> {
  const created: string[] = [];
  const requirementsPath = path.join(targetWorkdir, "REQUIREMENTS.md");
  const taskListPath = path.join(targetWorkdir, "TASK_LIST.md");
  const docsDir = path.join(targetWorkdir, "docs");
  const compassPath = path.join(docsDir, "AUTODEV_TASK_COMPASS.md");

  if (!(await fileExists(requirementsPath))) {
    await fs.writeFile(requirementsPath, buildRequirementsTemplate(), "utf8");
    created.push("REQUIREMENTS.md");
  }
  if (!(await fileExists(taskListPath))) {
    await fs.writeFile(taskListPath, buildTaskListTemplate(), "utf8");
    created.push("TASK_LIST.md");
  }
  if (!(await fileExists(compassPath))) {
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(compassPath, buildCompassTemplate(), "utf8");
    created.push("docs/AUTODEV_TASK_COMPASS.md");
  }

  return created;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function buildRequirementsTemplate(): string {
  return [
    "# REQUIREMENTS",
    "",
    "## Objective",
    "- Define the product goal and the expected user value.",
    "",
    "## Scope",
    "- In scope:",
    "- Out of scope:",
    "",
    "## Constraints",
    "- Tech stack constraints:",
    "- Performance/security constraints:",
    "- Delivery constraints:",
    "",
    "## Acceptance Criteria",
    "- [ ] Core flow can be demonstrated end-to-end.",
    "- [ ] Key regressions have tests.",
    "- [ ] README/ops docs updated.",
    "",
    "## Validation Commands",
    "- npm run typecheck",
    "- npm run lint",
    "- npm test",
    "",
  ].join("\n");
}

function buildTaskListTemplate(): string {
  return [
    "# TASK_LIST",
    "",
    "### Stage 0: Discovery & Baseline (pending)",
    "| Task ID | Task Description | Est | Priority | Dependency | Status |",
    "|--------|----------|----------|--------|------|------|",
    "| T0.1 | Requirement baseline: consolidate scope, constraints, acceptance criteria | 1h | P0 | - | ⬜ |",
    "| T0.2 | Project scan: map modules, build/test entrypoints, and risk hotspots | 1h | P0 | T0.1 | ⬜ |",
    "| T0.3 | Architecture notes: define execution plan and rollback strategy | 1h | P0 | T0.2 | ⬜ |",
    "| T0.4 | Delivery checklist: define verification matrix and release gates | 1h | P1 | T0.3 | ⬜ |",
    "",
    "### Stage 1: Core Implementation (pending)",
    "| Task ID | Task Description | Est | Priority | Dependency | Status |",
    "|--------|----------|----------|--------|------|------|",
    "| T1.1 | Implement core domain model and data contracts | 2h | P0 | T0.4 | ⬜ |",
    "| T1.2 | Implement service/use-case layer with error semantics | 3h | P0 | T1.1 | ⬜ |",
    "| T1.3 | Implement API/command adapters and request validation | 3h | P0 | T1.2 | ⬜ |",
    "| T1.4 | Add observability hooks (logs/diag metrics) for critical flows | 2h | P1 | T1.3 | ⬜ |",
    "",
    "### Stage 2: Quality Hardening (pending)",
    "| Task ID | Task Description | Est | Priority | Dependency | Status |",
    "|--------|----------|----------|--------|------|------|",
    "| T2.1 | Add unit tests for happy path and boundary conditions | 2h | P0 | T1.4 | ⬜ |",
    "| T2.2 | Add failure-path tests and regression fixtures | 2h | P0 | T2.1 | ⬜ |",
    "| T2.3 | Add integration/e2e coverage for end-to-end flow | 3h | P1 | T2.2 | ⬜ |",
    "| T2.4 | Resolve flaky checks and enforce deterministic test behavior | 2h | P1 | T2.3 | ⬜ |",
    "",
    "### Stage 3: UX & Ops Readiness (pending)",
    "| Task ID | Task Description | Est | Priority | Dependency | Status |",
    "|--------|----------|----------|--------|------|------|",
    "| T3.1 | Improve command/help UX and error/action guidance | 2h | P1 | T2.4 | ⬜ |",
    "| T3.2 | Finalize config defaults and environment compatibility | 2h | P1 | T3.1 | ⬜ |",
    "| T3.3 | Update docs: quickstart, runbook, troubleshooting | 2h | P1 | T3.2 | ⬜ |",
    "| T3.4 | Release readiness review and changelog alignment | 1h | P1 | T3.3 | ⬜ |",
    "",
    "### Stage 4: Optional Enhancements (pending)",
    "| Task ID | Task Description | Est | Priority | Dependency | Status |",
    "|--------|----------|----------|--------|------|------|",
    "| T4.1 | Add extension points for plugin/skill integration | 2h | P2 | T3.4 | ⬜ |",
    "| T4.2 | Add performance profiling and bottleneck fixes | 2h | P2 | T4.1 | ⬜ |",
    "| T4.3 | Add security hardening pass and threat notes | 2h | P2 | T4.2 | ⬜ |",
    "| T4.4 | Prepare release notes and post-release verification plan | 1h | P2 | T4.3 | ⬜ |",
    "",
  ].join("\n");
}

function buildCompassTemplate(): string {
  return [
    "# AutoDev Task Compass",
    "",
    "This file is generated to help `/autodev run` execute predictable milestones.",
    "",
    "## Execution Rules",
    "- Read `REQUIREMENTS.md` and `TASK_LIST.md` first.",
    "- Keep changes scoped to the current task and run impacted tests.",
    "- If blocked, return concrete blocker + next action.",
    "",
    "## Milestone Acceptance",
    "- Stage 0 complete: scope + architecture + validation path are explicit.",
    "- Stage 1 complete: core implementation done and runnable.",
    "- Stage 2 complete: tests are in place and stable.",
    "- Stage 3 complete: docs/config/ops are aligned.",
    "",
    "## Suggested Commands",
    "- /autodev status",
    "- /autodev run T0.1",
    "- /autodev run",
    "",
  ].join("\n");
}
