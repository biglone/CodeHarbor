import fs from "node:fs/promises";
import path from "node:path";

export type AutoDevTaskStatus = "pending" | "in_progress" | "completed" | "cancelled" | "blocked";

export interface AutoDevTask {
  id: string;
  description: string;
  status: AutoDevTaskStatus;
  lineIndex: number;
}

export interface AutoDevTaskSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  blocked: number;
}

export interface AutoDevContext {
  workdir: string;
  requirementsPath: string;
  taskListPath: string;
  requirementsContent: string | null;
  taskListContent: string | null;
  tasks: AutoDevTask[];
}

export type AutoDevCommand =
  | { kind: "status" }
  | { kind: "run"; taskId: string | null }
  | { kind: "stop" }
  | { kind: "reconcile" }
  | { kind: "invalid"; action: string | null; option: string | null }
  | { kind: "workdir"; mode: "status" | "set" | "clear"; path: string | null }
  | { kind: "init"; path: string | null; from: string | null; dryRun: boolean; force: boolean }
  | { kind: "progress"; mode: "status" | "on" | "off" }
  | { kind: "content"; mode: "status" | "on" | "off" }
  | { kind: "skills"; mode: "status" | "on" | "off" | "summary" | "progressive" | "full" };

export function parseAutoDevCommand(text: string): AutoDevCommand | null {
  const normalized = text.trim();
  if (!/^\/+autodev(?:\s|$)/i.test(normalized)) {
    return null;
  }

  const normalizedCommand = normalized.replace(/^\/+/, "/");
  const parts = normalizedCommand.split(/\s+/);
  const action = parts[1]?.toLowerCase() ?? "";
  if (parts.length === 1 || action === "status") {
    return { kind: "status" };
  }
  if (action === "stop") {
    return { kind: "stop" };
  }
  if (action === "reconcile" || action === "sync") {
    return { kind: "reconcile" };
  }
  if (action === "workdir" || action === "wd") {
    const remainder = normalizedCommand.replace(/^\/autodev\s+(?:workdir|wd)\s*/i, "").trim();
    if (!remainder || remainder.toLowerCase() === "status") {
      return { kind: "workdir", mode: "status", path: null };
    }
    if (["clear", "reset", "unset"].includes(remainder.toLowerCase())) {
      return { kind: "workdir", mode: "clear", path: null };
    }
    return {
      kind: "workdir",
      mode: "set",
      path: stripWrappingQuotes(remainder) || null,
    };
  }
  if (action === "init" || action === "i") {
    let remainder = normalizedCommand.replace(/^\/autodev\s+(?:init|i)\s*/i, "").trim();
    const fromInlineMatch = remainder.match(/(?:^|\s)--from(?:=|\s+)("[^"]+"|'[^']+'|\S+)/i);
    const from = fromInlineMatch ? stripWrappingQuotes(fromInlineMatch[1] ?? "") || null : null;
    if (fromInlineMatch) {
      remainder = remainder.replace(fromInlineMatch[0], " ").trim();
    }
    const dryRun = /(?:^|\s)--dry-?run(?=\s|$)/i.test(remainder);
    if (dryRun) {
      remainder = remainder.replace(/(?:^|\s)--dry-?run(?=\s|$)/gi, " ").trim();
    }
    const force = /(?:^|\s)--force(?=\s|$)/i.test(remainder);
    if (force) {
      remainder = remainder.replace(/(?:^|\s)--force(?=\s|$)/gi, " ").trim();
    }
    const legacySkillInlineMatch = remainder.match(/(?:^|\s)--skill(?:=|\s+)[A-Za-z0-9._-]+/i);
    if (legacySkillInlineMatch) {
      remainder = remainder.replace(legacySkillInlineMatch[0], " ").trim();
    }
    return {
      kind: "init",
      path: stripWrappingQuotes(remainder) || null,
      from,
      dryRun,
      force,
    };
  }
  if (action === "progress") {
    const option = (parts[2] ?? "").trim().toLowerCase();
    if (!option || option === "status") {
      return { kind: "progress", mode: "status" };
    }
    if (["on", "enable", "enabled", "true", "1"].includes(option)) {
      return { kind: "progress", mode: "on" };
    }
    if (["off", "disable", "disabled", "false", "0"].includes(option)) {
      return { kind: "progress", mode: "off" };
    }
    return {
      kind: "invalid",
      action: "progress",
      option: option || null,
    };
  }
  if (action === "content") {
    const option = (parts[2] ?? "").trim().toLowerCase();
    if (!option || option === "status") {
      return { kind: "content", mode: "status" };
    }
    if (["on", "enable", "enabled", "true", "1"].includes(option)) {
      return { kind: "content", mode: "on" };
    }
    if (["off", "disable", "disabled", "false", "0"].includes(option)) {
      return { kind: "content", mode: "off" };
    }
    return {
      kind: "invalid",
      action: "content",
      option: option || null,
    };
  }
  if (action === "skills") {
    const option = (parts[2] ?? "").trim().toLowerCase();
    if (!option || option === "status") {
      return { kind: "skills", mode: "status" };
    }
    if (["on", "enable", "enabled", "true", "1"].includes(option)) {
      return { kind: "skills", mode: "on" };
    }
    if (["off", "disable", "disabled", "false", "0"].includes(option)) {
      return { kind: "skills", mode: "off" };
    }
    if (option === "summary" || option === "progressive" || option === "full") {
      return { kind: "skills", mode: option };
    }
    return {
      kind: "invalid",
      action: "skills",
      option: option || null,
    };
  }
  if (action !== "run") {
    return {
      kind: "invalid",
      action: action || null,
      option: null,
    };
  }

  const taskId = normalizedCommand.replace(/^\/autodev\s+run\s*/i, "").trim();
  return {
    kind: "run",
    taskId: taskId || null,
  };
}

function stripWrappingQuotes(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

const MARKDOWN_HEADING_PATTERN = /^#{1,6}\s+/;
const RELEASE_MAPPING_HEADING_PATTERN = /^#{1,6}\s+.*(?:发布映射|release mapping)/i;

export async function loadAutoDevContext(workdir: string): Promise<AutoDevContext> {
  const requirementsPath = path.join(workdir, "REQUIREMENTS.md");
  const taskListPath = path.join(workdir, "TASK_LIST.md");
  const requirementsContent = await readOptionalFile(requirementsPath);
  const taskListContent = await readOptionalFile(taskListPath);

  return {
    workdir,
    requirementsPath,
    taskListPath,
    requirementsContent,
    taskListContent,
    tasks: taskListContent ? parseTasks(taskListContent) : [],
  };
}

export function summarizeAutoDevTasks(tasks: AutoDevTask[]): AutoDevTaskSummary {
  const summary: AutoDevTaskSummary = {
    total: tasks.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    cancelled: 0,
    blocked: 0,
  };

  for (const task of tasks) {
    if (task.status === "pending") {
      summary.pending += 1;
      continue;
    }
    if (task.status === "in_progress") {
      summary.inProgress += 1;
      continue;
    }
    if (task.status === "completed") {
      summary.completed += 1;
      continue;
    }
    if (task.status === "cancelled") {
      summary.cancelled += 1;
      continue;
    }
    summary.blocked += 1;
  }

  return summary;
}

export function selectAutoDevTask(tasks: AutoDevTask[], taskId?: string | null): AutoDevTask | null {
  if (taskId) {
    const normalizedTarget = taskId.trim().toLowerCase();
    return tasks.find((task) => task.id.toLowerCase() === normalizedTarget) ?? null;
  }

  const inProgressTask = tasks.find((task) => task.status === "in_progress");
  if (inProgressTask) {
    return inProgressTask;
  }
  return tasks.find((task) => task.status === "pending") ?? null;
}

export function buildAutoDevObjective(task: AutoDevTask): string {
  return [
    "你正在执行 CodeHarbor AutoDev 任务，请在当前工作目录完成指定开发目标。",
    "",
    `任务ID: ${task.id}`,
    `任务描述: ${task.description}`,
    "",
    "上下文文件：",
    "- REQUIREMENTS.md（需求基线）",
    "- TASK_LIST.md（任务状态）",
    "",
    "执行要求：",
    "1. 先读取 REQUIREMENTS.md 和 TASK_LIST.md，确认边界与约束。",
    "2. 在当前仓库直接完成代码与测试改动。",
    "3. 运行受影响验证命令并汇总结果。",
    "4. 输出改动文件和风险说明。",
    "5. 禁止修改 TASK_LIST.md（含任务状态与正文），任务状态仅由系统在编排阶段维护。",
  ].join("\n");
}

export function formatTaskForDisplay(task: AutoDevTask): string {
  return `${task.id} ${task.description} (${statusToSymbol(task.status)})`;
}

export function statusToSymbol(status: AutoDevTaskStatus): string {
  if (status === "pending") {
    return "⬜";
  }
  if (status === "in_progress") {
    return "🔄";
  }
  if (status === "completed") {
    return "✅";
  }
  if (status === "cancelled") {
    return "❌";
  }
  return "🚫";
}

export async function updateAutoDevTaskStatus(
  taskListPath: string,
  task: AutoDevTask,
  nextStatus: AutoDevTaskStatus,
): Promise<AutoDevTask> {
  const content = await fs.readFile(taskListPath, "utf8");
  const lines = splitLines(content);
  if (task.lineIndex < 0 || task.lineIndex >= lines.length) {
    throw new Error(`task ${task.id} line index out of range`);
  }

  const updatedLine = replaceLineStatus(lines[task.lineIndex] ?? "", task.id, nextStatus);
  if (!updatedLine) {
    throw new Error(`failed to update task status for ${task.id}`);
  }

  lines[task.lineIndex] = updatedLine;
  await fs.writeFile(taskListPath, lines.join("\n"), "utf8");

  return {
    ...task,
    status: nextStatus,
  };
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function parseTasks(content: string): AutoDevTask[] {
  const lines = splitLines(content);
  const tasks: AutoDevTask[] = [];
  const seenTaskIds = new Set<string>();
  let inReleaseMappingSection = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (MARKDOWN_HEADING_PATTERN.test(trimmed)) {
      inReleaseMappingSection = RELEASE_MAPPING_HEADING_PATTERN.test(trimmed);
      continue;
    }
    if (inReleaseMappingSection) {
      continue;
    }
    const tableTask = parseTableTaskLine(line, index);
    if (tableTask) {
      const normalizedTaskId = tableTask.id.toLowerCase();
      if (seenTaskIds.has(normalizedTaskId)) {
        continue;
      }
      seenTaskIds.add(normalizedTaskId);
      tasks.push(tableTask);
      continue;
    }

    const listTask = parseListTaskLine(line, index);
    if (listTask) {
      const normalizedTaskId = listTask.id.toLowerCase();
      if (seenTaskIds.has(normalizedTaskId)) {
        continue;
      }
      seenTaskIds.add(normalizedTaskId);
      tasks.push(listTask);
    }
  }

  return tasks;
}

function parseTableTaskLine(line: string, lineIndex: number): AutoDevTask | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) {
    return null;
  }
  const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 3) {
    return null;
  }

  const taskId = cells[0] ?? "";
  if (!isLikelyTaskId(taskId)) {
    return null;
  }

  const statusCell = cells[cells.length - 1] ?? "";
  const status = parseStatusToken(statusCell);
  if (!status) {
    return null;
  }

  return {
    id: taskId,
    description: cells[1] ?? taskId,
    status,
    lineIndex,
  };
}

function parseListTaskLine(line: string, lineIndex: number): AutoDevTask | null {
  const checkboxMatch = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/);
  if (checkboxMatch) {
    const rawText = checkboxMatch[2]?.trim() ?? "";
    const taskId = extractTaskId(rawText);
    if (!taskId) {
      return null;
    }
    return {
      id: taskId,
      description: stripTaskIdPrefix(rawText, taskId),
      status: checkboxMatch[1]?.toLowerCase() === "x" ? "completed" : "pending",
      lineIndex,
    };
  }

  const symbolMatch = line.match(/^\s*[-*]\s*(⬜|🔄|✅|❌|🚫)\s+(.+)$/);
  if (!symbolMatch) {
    return null;
  }

  const rawText = symbolMatch[2]?.trim() ?? "";
  const taskId = extractTaskId(rawText);
  if (!taskId) {
    return null;
  }

  const status = parseStatusToken(symbolMatch[1] ?? "");
  if (!status) {
    return null;
  }

  return {
    id: taskId,
    description: stripTaskIdPrefix(rawText, taskId),
    status,
    lineIndex,
  };
}

function stripTaskIdPrefix(text: string, taskId: string): string {
  const normalized = text.trim();
  const escapedId = escapeRegex(taskId);
  return normalized.replace(new RegExp(`^${escapedId}[\\s:：\\-]+`, "i"), "").trim() || normalized;
}

function extractTaskId(text: string): string | null {
  const normalized = text.trim();
  const bracketMatch = normalized.match(/\(([A-Za-z][A-Za-z0-9._-]*)\)/);
  if (bracketMatch?.[1] && isLikelyTaskId(bracketMatch[1])) {
    return bracketMatch[1];
  }
  const token = normalized.split(/\s+/)[0]?.replace(/[,:：|]+$/, "") ?? "";
  if (!isLikelyTaskId(token)) {
    return null;
  }
  return token;
}

function isLikelyTaskId(taskId: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(taskId)) {
    return false;
  }
  return /\d/.test(taskId);
}

function parseStatusToken(text: string): AutoDevTaskStatus | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("✅") || normalized.includes("[x]") || normalized.includes("done")) {
    return "completed";
  }
  if (normalized.includes("⬜") || normalized.includes("☐") || normalized.includes("[ ]") || normalized === "todo") {
    return "pending";
  }
  if (normalized.includes("🔄") || normalized.includes("进行中") || normalized.includes("in progress")) {
    return "in_progress";
  }
  if (normalized.includes("❌") || normalized.includes("取消") || normalized.includes("cancel")) {
    return "cancelled";
  }
  if (normalized.includes("🚫") || normalized.includes("阻塞") || normalized.includes("block")) {
    return "blocked";
  }
  return null;
}

function replaceLineStatus(line: string, taskId: string, status: AutoDevTaskStatus): string | null {
  const trimmed = line.trim();
  const symbol = statusToSymbol(status);

  if (trimmed.startsWith("|")) {
    const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length >= 3 && cells[0]?.toLowerCase() === taskId.toLowerCase()) {
      const rawParts = line.split("|");
      if (rawParts.length >= 3) {
        rawParts[rawParts.length - 2] = ` ${symbol} `;
        return rawParts.join("|");
      }
    }
  }

  if (/\[( |x|X)\]/.test(line)) {
    const checkbox = status === "completed" ? "[x]" : "[ ]";
    return line.replace(/\[( |x|X)\]/, checkbox);
  }

  if (/(⬜|🔄|✅|❌|🚫)/.test(line)) {
    return line.replace(/(⬜|🔄|✅|❌|🚫)/, symbol);
  }

  return null;
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
