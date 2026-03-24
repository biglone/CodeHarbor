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
  runAutoDevInitEnhancement?: (input: AutoDevInitEnhancementInput) => Promise<AutoDevInitEnhancementResult>;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

export interface AutoDevInitEnhancementInput {
  sessionKey: string;
  message: InboundMessage;
  workdir: string;
  requirementsPath: string;
  taskListPath: string;
  sourceDocs: string[];
}

export interface AutoDevInitEnhancementResult {
  applied: boolean;
  summary?: string | null;
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
  from: string | null;
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

    const scaffoldResult = await scaffoldAutoDevCompassFiles(targetWorkdir, input.from);
    const createdFiles = scaffoldResult.createdFiles;
    const baselineSnapshot = await takeInitCoreSnapshot(targetWorkdir);
    await assertInitCoreArtifactsValid(targetWorkdir);
    const initEnhancement = await runAutoDevInitEnhancementWithFallback(deps, {
      sessionKey: input.sessionKey,
      message: input.message,
      targetWorkdir,
      sourceDocs: scaffoldResult.sourceDocs,
      createdFiles,
      baselineSnapshot,
    });
    const context = await loadAutoDevContext(targetWorkdir);
    const summary = summarizeAutoDevTasks(context.tasks);
    const createdText = createdFiles.length > 0 ? createdFiles.join(", ") : noneText;
    const initEnhancementText = formatInitEnhancementStatus(initEnhancement, deps.outputLanguage);

    await deps.sendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 任务罗盘已就绪
- targetWorkdir: ${targetWorkdir}
- createdFiles: ${createdText}
- REQUIREMENTS.md: ${context.requirementsContent ? "found" : "missing"}
- TASK_LIST.md: ${context.taskListContent ? "found" : "missing"}
- initEnhancement: ${initEnhancementText}
- tasks: total=${summary.total}, pending=${summary.pending}, in_progress=${summary.inProgress}, completed=${summary.completed}, blocked=${summary.blocked}, cancelled=${summary.cancelled}
- next: 执行 /autodev run（或 /autodev run T0.1）`,
        `[CodeHarbor] AutoDev task compass is ready
- targetWorkdir: ${targetWorkdir}
- createdFiles: ${createdText}
- REQUIREMENTS.md: ${context.requirementsContent ? "found" : "missing"}
- TASK_LIST.md: ${context.taskListContent ? "found" : "missing"}
- initEnhancement: ${initEnhancementText}
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

interface InitCoreSnapshot {
  requirementsContent: string;
  taskListContent: string;
}

type InitEnhancementStatus =
  | { kind: "skipped"; detail: string | null }
  | { kind: "applied"; detail: string | null }
  | { kind: "fallback"; detail: string | null };

interface RunInitEnhancementInput {
  sessionKey: string;
  message: InboundMessage;
  targetWorkdir: string;
  sourceDocs: InitSourceDoc[];
  createdFiles: string[];
  baselineSnapshot: InitCoreSnapshot;
}

async function runAutoDevInitEnhancementWithFallback(
  deps: AutoDevControlCommandDeps,
  input: RunInitEnhancementInput,
): Promise<InitEnhancementStatus> {
  if (!deps.runAutoDevInitEnhancement) {
    return {
      kind: "skipped",
      detail: "no enhancement runner",
    };
  }
  const createdFileSet = new Set(input.createdFiles);
  const generatedRequirements = createdFileSet.has("REQUIREMENTS.md");
  const generatedTaskList = createdFileSet.has("TASK_LIST.md");
  if (!generatedRequirements || !generatedTaskList) {
    return {
      kind: "skipped",
      detail: "kept existing REQUIREMENTS.md/TASK_LIST.md",
    };
  }

  const requirementsPath = path.join(input.targetWorkdir, "REQUIREMENTS.md");
  const taskListPath = path.join(input.targetWorkdir, "TASK_LIST.md");

  let enhancementResult: AutoDevInitEnhancementResult;
  try {
    enhancementResult = await deps.runAutoDevInitEnhancement({
      sessionKey: input.sessionKey,
      message: input.message,
      workdir: input.targetWorkdir,
      requirementsPath,
      taskListPath,
      sourceDocs: input.sourceDocs.map((source) => source.relativePath),
    });
  } catch (error) {
    await restoreInitCoreSnapshot(input.targetWorkdir, input.baselineSnapshot);
    return {
      kind: "fallback",
      detail: `enhancement failed: ${compactLine(formatError(error))}`,
    };
  }

  if (!enhancementResult.applied) {
    return {
      kind: "skipped",
      detail: compactNullableText(enhancementResult.summary),
    };
  }

  try {
    await assertInitCoreArtifactsValid(input.targetWorkdir);
  } catch (error) {
    await restoreInitCoreSnapshot(input.targetWorkdir, input.baselineSnapshot);
    return {
      kind: "fallback",
      detail: `validation failed, reverted: ${compactLine(formatError(error))}`,
    };
  }

  return {
    kind: "applied",
    detail: compactNullableText(enhancementResult.summary),
  };
}

function formatInitEnhancementStatus(status: InitEnhancementStatus, outputLanguage: OutputLanguage): string {
  const localize = (zh: string, en: string): string => byOutputLanguage(outputLanguage, zh, en);
  const detail = status.detail ? ` (${status.detail})` : "";
  if (status.kind === "applied") {
    return localize(`已增强${detail}`, `applied${detail}`);
  }
  if (status.kind === "fallback") {
    return localize(`已回退到 Stage A 模板${detail}`, `fallback to stage-A baseline${detail}`);
  }
  return localize(`跳过${detail}`, `skipped${detail}`);
}

async function assertInitCoreArtifactsValid(targetWorkdir: string): Promise<void> {
  const context = await loadAutoDevContext(targetWorkdir);
  const requirements = (context.requirementsContent ?? "").trim();
  const taskList = (context.taskListContent ?? "").trim();
  if (!requirements) {
    throw new Error("REQUIREMENTS.md is empty");
  }
  if (!taskList) {
    throw new Error("TASK_LIST.md is empty");
  }
  const requirementsHeadingCount = (requirements.match(/^#{1,6}\s+/gm) ?? []).length;
  if (requirementsHeadingCount < 2) {
    throw new Error("REQUIREMENTS.md has insufficient section headings");
  }
  if (context.tasks.length < 1) {
    throw new Error("TASK_LIST.md has no executable tasks");
  }
}

async function takeInitCoreSnapshot(targetWorkdir: string): Promise<InitCoreSnapshot> {
  const requirementsPath = path.join(targetWorkdir, "REQUIREMENTS.md");
  const taskListPath = path.join(targetWorkdir, "TASK_LIST.md");
  return {
    requirementsContent: await fs.readFile(requirementsPath, "utf8"),
    taskListContent: await fs.readFile(taskListPath, "utf8"),
  };
}

async function restoreInitCoreSnapshot(targetWorkdir: string, snapshot: InitCoreSnapshot): Promise<void> {
  const requirementsPath = path.join(targetWorkdir, "REQUIREMENTS.md");
  const taskListPath = path.join(targetWorkdir, "TASK_LIST.md");
  await fs.writeFile(requirementsPath, snapshot.requirementsContent, "utf8");
  await fs.writeFile(taskListPath, snapshot.taskListContent, "utf8");
}

function compactNullableText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const compacted = compactLine(value);
  if (!compacted) {
    return null;
  }
  return compacted.length > 180 ? `${compacted.slice(0, 177)}...` : compacted;
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

interface InitSourceDoc {
  relativePath: string;
  title: string;
  headings: string[];
  bullets: string[];
}

const INIT_SOURCE_MAX_DOCS = 4;
const INIT_SOURCE_MAX_DEPTH = 3;
const INIT_SOURCE_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);
const INIT_SOURCE_DIRECTORIES = ["", "docs", "doc", "design", "spec", "specs", "architecture", "arch"];
const INIT_SOURCE_PRIORITY_FILES = [
  "docs/技术方案.md",
  "docs/design.md",
  "docs/architecture.md",
  "docs/spec.md",
  "docs/requirements.md",
  "docs/prd.md",
  "技术方案.md",
  "设计文档.md",
  "architecture.md",
  "design.md",
  "spec.md",
  "requirements.md",
  "prd.md",
];
const INIT_SOURCE_KEYWORDS = [
  "design",
  "spec",
  "architecture",
  "proposal",
  "requirements",
  "prd",
  "技术方案",
  "设计",
  "架构",
  "需求",
  "方案",
  "产品",
];
const CONSTRAINT_KEYWORDS = ["constraint", "限制", "约束", "performance", "security", "compat", "兼容"];
const ACCEPTANCE_KEYWORDS = ["acceptance", "验收", "must", "should", "成功", "完成"];

interface AutoDevCompassScaffoldResult {
  createdFiles: string[];
  sourceDocs: InitSourceDoc[];
}

async function scaffoldAutoDevCompassFiles(
  targetWorkdir: string,
  explicitFrom: string | null,
): Promise<AutoDevCompassScaffoldResult> {
  const sourceDocs = await resolveInitSourceDocs(targetWorkdir, explicitFrom);
  const created: string[] = [];
  const requirementsPath = path.join(targetWorkdir, "REQUIREMENTS.md");
  const taskListPath = path.join(targetWorkdir, "TASK_LIST.md");
  const docsDir = path.join(targetWorkdir, "docs");
  const compassPath = path.join(docsDir, "AUTODEV_TASK_COMPASS.md");

  if (!(await fileExists(requirementsPath))) {
    await fs.writeFile(requirementsPath, buildRequirementsTemplate(sourceDocs), "utf8");
    created.push("REQUIREMENTS.md");
  }
  if (!(await fileExists(taskListPath))) {
    await fs.writeFile(taskListPath, buildTaskListTemplate(sourceDocs), "utf8");
    created.push("TASK_LIST.md");
  }
  if (!(await fileExists(compassPath))) {
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(compassPath, buildCompassTemplate(sourceDocs), "utf8");
    created.push("docs/AUTODEV_TASK_COMPASS.md");
  }

  return {
    createdFiles: created,
    sourceDocs,
  };
}

async function resolveInitSourceDocs(targetWorkdir: string, explicitFrom: string | null): Promise<InitSourceDoc[]> {
  const explicit = (explicitFrom ?? "").trim();
  if (explicit) {
    const absolute = resolveSourcePath(explicit, targetWorkdir);
    const source = await loadInitSourceDoc(targetWorkdir, absolute);
    if (!source) {
      throw new Error(`source design document not found or empty: ${explicit}`);
    }
    return [source];
  }
  return discoverInitSourceDocs(targetWorkdir);
}

async function discoverInitSourceDocs(targetWorkdir: string): Promise<InitSourceDoc[]> {
  const candidates = new Set<string>();
  for (const relativePath of INIT_SOURCE_PRIORITY_FILES) {
    candidates.add(path.resolve(targetWorkdir, relativePath));
  }
  for (const directory of INIT_SOURCE_DIRECTORIES) {
    const absoluteDirectory = path.resolve(targetWorkdir, directory);
    const files = await collectCandidateFiles(absoluteDirectory, 0);
    for (const candidate of files) {
      candidates.add(candidate);
    }
  }

  const scored = Array.from(candidates).map((absolutePath) => ({
    absolutePath,
    score: scoreSourceCandidate(targetWorkdir, absolutePath),
  }));
  scored.sort((left, right) => right.score - left.score || left.absolutePath.localeCompare(right.absolutePath));

  const sources: InitSourceDoc[] = [];
  for (const candidate of scored) {
    if (sources.length >= INIT_SOURCE_MAX_DOCS) {
      break;
    }
    if (candidate.score <= 0) {
      continue;
    }
    const source = await loadInitSourceDoc(targetWorkdir, candidate.absolutePath);
    if (source) {
      sources.push(source);
    }
  }
  return sources;
}

async function collectCandidateFiles(directory: string, depth: number): Promise<string[]> {
  if (depth > INIT_SOURCE_MAX_DEPTH) {
    return [];
  }
  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }> = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectCandidateFiles(absolutePath, depth + 1);
      files.push(...nested);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (!INIT_SOURCE_EXTENSIONS.has(extension)) {
      continue;
    }
    files.push(absolutePath);
  }
  return files;
}

function scoreSourceCandidate(targetWorkdir: string, absolutePath: string): number {
  if (!existsSync(absolutePath)) {
    return 0;
  }
  const relative = normalizePath(path.relative(targetWorkdir, absolutePath));
  const relativeLower = relative.toLowerCase();
  const baseLower = path.basename(relative).toLowerCase();
  if (relativeLower === "task_list.md" || relativeLower === "requirements.md") {
    return 0;
  }
  if (baseLower === "readme.md" || baseLower === "changelog.md") {
    return 1;
  }

  let score = 1;
  if (relativeLower.startsWith("docs/")) {
    score += 12;
  }
  for (const priority of INIT_SOURCE_PRIORITY_FILES) {
    if (relativeLower === priority.toLowerCase()) {
      score += 200;
      break;
    }
  }
  for (const keyword of INIT_SOURCE_KEYWORDS) {
    if (relativeLower.includes(keyword.toLowerCase())) {
      score += 20;
    }
  }
  return score;
}

async function loadInitSourceDoc(targetWorkdir: string, absolutePath: string): Promise<InitSourceDoc | null> {
  let content = "";
  try {
    content = await fs.readFile(absolutePath, "utf8");
  } catch {
    return null;
  }
  const normalizedContent = content.trim();
  if (!normalizedContent) {
    return null;
  }
  const lines = normalizedContent.split(/\r?\n/);
  const title = extractSourceTitle(lines, absolutePath);
  const headings = extractSourceHeadings(lines);
  const bullets = extractSourceBullets(lines);
  return {
    relativePath: normalizePath(path.relative(targetWorkdir, absolutePath)),
    title,
    headings,
    bullets,
  };
}

function resolveSourcePath(rawPath: string, targetWorkdir: string): string {
  const normalized = rawPath.trim();
  if (!normalized) {
    return path.resolve(targetWorkdir);
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
  return path.resolve(targetWorkdir, normalized);
}

function extractSourceTitle(lines: string[], absolutePath: string): string {
  for (const line of lines) {
    const match = line.match(/^#\s+(.+)$/);
    if (match?.[1]) {
      return compactLine(match[1]);
    }
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      return compactLine(trimmed);
    }
  }
  return path.basename(absolutePath);
}

function extractSourceHeadings(lines: string[]): string[] {
  const headings: string[] = [];
  for (const line of lines) {
    const match = line.match(/^#{2,4}\s+(.+)$/);
    if (!match?.[1]) {
      continue;
    }
    headings.push(compactLine(match[1]));
    if (headings.length >= 12) {
      break;
    }
  }
  return dedupeLines(headings);
}

function extractSourceBullets(lines: string[]): string[] {
  const bullets: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:[-*]|\d+[.)、])\s+(.+)$/);
    if (!match?.[1]) {
      continue;
    }
    bullets.push(compactLine(match[1]));
    if (bullets.length >= 24) {
      break;
    }
  }
  return dedupeLines(bullets);
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    const normalized = line.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(line);
  }
  return deduped;
}

function compactLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function normalizePath(input: string): string {
  return input.split(path.sep).join("/");
}

function buildRequirementsTemplate(sourceDocs: InitSourceDoc[]): string {
  const sourceLines = buildSourceDocumentLines(sourceDocs);
  const firstDoc = sourceDocs[0];
  const topHeadings = dedupeLines(sourceDocs.flatMap((doc) => doc.headings)).slice(0, 3);
  const constraintBullets = pickBulletsByKeyword(sourceDocs, CONSTRAINT_KEYWORDS, 3);
  const acceptanceBullets = pickBulletsByKeyword(sourceDocs, ACCEPTANCE_KEYWORDS, 3);

  return [
    "# REQUIREMENTS",
    "",
    "## Objective",
    firstDoc ? `- Deliver the target outcome described in: ${firstDoc.title}.` : "- Define the product goal and the expected user value.",
    "",
    "## Source Documents",
    ...sourceLines,
    "",
    "## Scope",
    ...(topHeadings.length > 0
      ? topHeadings.map((heading) => `- In scope: ${heading}`)
      : ["- In scope:", "- Out of scope:"]),
    ...(topHeadings.length > 0 ? ["- Out of scope: non-essential stretch goals unless explicitly required."] : []),
    "",
    "## Constraints",
    ...(constraintBullets.length > 0
      ? constraintBullets.map((constraint) => `- ${constraint}`)
      : ["- Tech stack constraints:", "- Performance/security constraints:", "- Delivery constraints:"]),
    "",
    "## Acceptance Criteria",
    ...(acceptanceBullets.length > 0
      ? acceptanceBullets.map((criterion) => `- [ ] ${criterion}`)
      : [
          "- [ ] Core flow can be demonstrated end-to-end.",
          "- [ ] Key regressions have tests.",
          "- [ ] README/ops docs updated.",
        ]),
    "",
    "## Validation Commands",
    "- npm run typecheck",
    "- npm run lint",
    "- npm test",
    "",
  ].join("\n");
}

function buildTaskListTemplate(sourceDocs: InitSourceDoc[]): string {
  const derivedHeadings = dedupeLines(sourceDocs.flatMap((doc) => doc.headings)).slice(0, 4);
  const stageOneRows =
    derivedHeadings.length > 0
      ? derivedHeadings.map((heading, index) => {
          const taskId = `T1.${index + 1}`;
          const dependency = index === 0 ? "T0.4" : `T1.${index}`;
          return `| ${taskId} | Implement milestone: ${sanitizeTableCell(heading)} | 2h | P0 | ${dependency} | ⬜ |`;
        })
      : [
          "| T1.1 | Implement core domain model and data contracts | 2h | P0 | T0.4 | ⬜ |",
          "| T1.2 | Implement service/use-case layer with error semantics | 3h | P0 | T1.1 | ⬜ |",
          "| T1.3 | Implement API/command adapters and request validation | 3h | P0 | T1.2 | ⬜ |",
          "| T1.4 | Add observability hooks (logs/diag metrics) for critical flows | 2h | P1 | T1.3 | ⬜ |",
        ];

  return [
    "# TASK_LIST",
    "",
    "### Stage 0: Discovery & Baseline (pending)",
    "| Task ID | Task Description | Est | Priority | Dependency | Status |",
    "|--------|----------|----------|--------|------|------|",
    "| T0.1 | Source-doc baseline: confirm objective, scope, and acceptance criteria | 1h | P0 | - | ⬜ |",
    "| T0.2 | Extract architecture and dependency hotspots from design docs | 1h | P0 | T0.1 | ⬜ |",
    "| T0.3 | Define execution strategy and rollback path | 1h | P0 | T0.2 | ⬜ |",
    "| T0.4 | Confirm validation matrix and delivery gates | 1h | P1 | T0.3 | ⬜ |",
    "",
    "### Stage 1: Core Implementation (pending)",
    "| Task ID | Task Description | Est | Priority | Dependency | Status |",
    "|--------|----------|----------|--------|------|------|",
    ...stageOneRows,
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

function buildCompassTemplate(sourceDocs: InitSourceDoc[]): string {
  return [
    "# AutoDev Task Compass",
    "",
    "This file is generated to help `/autodev run` execute predictable milestones.",
    "",
    "## Source Documents",
    ...buildSourceDocumentLines(sourceDocs),
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

function buildSourceDocumentLines(sourceDocs: InitSourceDoc[]): string[] {
  if (sourceDocs.length === 0) {
    return ["- (auto-discovery found no design documents; defaults were generated)"];
  }
  return sourceDocs.map((doc) => `- ${doc.relativePath} (${doc.title})`);
}

function pickBulletsByKeyword(sourceDocs: InitSourceDoc[], keywords: string[], limit: number): string[] {
  const selected: string[] = [];
  const loweredKeywords = keywords.map((keyword) => keyword.toLowerCase());
  for (const doc of sourceDocs) {
    for (const bullet of doc.bullets) {
      const lowered = bullet.toLowerCase();
      if (!loweredKeywords.some((keyword) => lowered.includes(keyword))) {
        continue;
      }
      selected.push(bullet);
      if (selected.length >= limit) {
        return dedupeLines(selected);
      }
    }
  }
  return dedupeLines(selected);
}

function sanitizeTableCell(value: string): string {
  return value.replace(/\|/g, "/");
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
