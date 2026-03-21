import type { AutoDevTask } from "./autodev";

interface AutoDevCommitMessage {
  subject: string;
  body: string;
}

type AutoDevCommitType = "feat" | "fix" | "docs" | "test" | "chore";

export function buildAutoDevCommitMessage(task: AutoDevTask, changedFiles: string[]): AutoDevCommitMessage {
  const detail = task.description.trim();
  const normalizedFiles = normalizeAutoDevCommitFiles(changedFiles);
  const type = inferAutoDevCommitType(detail, normalizedFiles);
  const scope = inferAutoDevCommitScope(detail, normalizedFiles, type);
  const subject = `${type}(${scope}): ${buildAutoDevCommitHeadline(task.id, detail, normalizedFiles, scope, type, 58)}`;
  const bodyLines = [
    `Task-ID: ${task.id}`,
    `Changed-files: ${summarizeAutoDevCommitFiles(normalizedFiles)}`,
    "Generated-by: CodeHarbor AutoDev",
  ];

  return {
    subject,
    body: bodyLines.join("\n"),
  };
}

function inferAutoDevCommitType(description: string, changedFiles: string[]): AutoDevCommitType {
  const text = description.toLowerCase();
  if (includesAnyKeyword(text, ["bug", "修复", "fix", "错误", "异常"])) {
    return "fix";
  }
  if (changedFiles.every((file) => isAutoDevDocFile(file)) || includesAnyKeyword(text, ["文档", "readme", "docs"])) {
    return "docs";
  }
  if (changedFiles.every((file) => isAutoDevTestFile(file)) || includesAnyKeyword(text, ["测试", "test", "spec"])) {
    return "test";
  }
  if (changedFiles.every((file) => isAutoDevChoreFile(file)) || includesAnyKeyword(text, ["依赖", "构建", "lint", "ci", "chore"])) {
    return "chore";
  }
  return "feat";
}

function inferAutoDevCommitScope(description: string, changedFiles: string[], type: AutoDevCommitType): string {
  const text = description.toLowerCase();
  if (includesAnyKeyword(text, ["upgrade", "install", "restart", "升级", "安装", "恢复"])) {
    return "upgrade";
  }
  if (includesAnyKeyword(text, ["路由", "backend", "model"])) {
    return "routing";
  }
  if (includesAnyKeyword(text, ["context", "bridge", "会话", "上下文"])) {
    return "context";
  }
  if (includesAnyKeyword(text, ["历史", "history", "导出", "retention"])) {
    return "history";
  }
  if (includesAnyKeyword(text, ["权限", "token", "rbac", "scope"])) {
    return "auth";
  }
  if (includesAnyKeyword(text, ["队列", "retry", "重试", "归档"])) {
    return "queue";
  }

  const firstFile = changedFiles[0] ?? "";
  if (firstFile) {
    const parts = firstFile.replace(/\\/g, "/").split("/").filter(Boolean);
    const firstPart = parts[0] ?? "";
    if (firstPart === "src" && parts.length > 1) {
      const candidate = parts[1] === "orchestrator" && parts.length > 2 ? parts[2] : parts[1];
      return normalizeCommitScopeFragment(candidate ?? "core");
    }
    if (firstPart && firstPart !== ".") {
      return normalizeCommitScopeFragment(firstPart);
    }
  }

  return type === "docs" ? "docs" : "core";
}

function normalizeAutoDevCommitFiles(files: string[]): string[] {
  const unique = new Set<string>();
  for (const file of files) {
    const normalized = file.trim();
    if (!normalized) {
      continue;
    }
    unique.add(normalized);
  }
  return [...unique].sort();
}

function summarizeAutoDevCommitFiles(files: string[]): string {
  if (files.length === 0) {
    return "(none)";
  }
  if (files.length <= 8) {
    return files.join(", ");
  }
  const preview = files.slice(0, 8).join(", ");
  return `${preview}, ... (+${files.length - 8})`;
}

function buildAutoDevCommitHeadline(
  taskId: string,
  description: string,
  changedFiles: string[],
  scope: string,
  type: AutoDevCommitType,
  maxLen: number,
): string {
  const normalizedTaskId = normalizeTaskIdFragment(taskId);
  const intent = inferAutoDevCommitIntent(description, changedFiles, scope, type);
  const base = `${intent} (${normalizedTaskId})`;
  if (base.length <= maxLen) {
    return base;
  }
  const minimumRoomForIntent = 12;
  const suffix = ` (${normalizedTaskId})`;
  const available = maxLen - suffix.length;
  if (available <= minimumRoomForIntent) {
    return `update task ${suffix.trim()}`;
  }
  const sliced = intent.slice(0, available).trim().replace(/[^\w)\]]+$/g, "");
  return `${sliced}${suffix}`;
}

function inferAutoDevCommitIntent(
  description: string,
  changedFiles: string[],
  scope: string,
  type: AutoDevCommitType,
): string {
  const text = description.toLowerCase();
  if (includesAnyKeyword(text, ["upgrade", "install", "restart", "恢复", "升级", "安装"])) {
    return "improve install and upgrade flow";
  }
  if (includesAnyKeyword(text, ["backend", "route", "routing", "model", "桥接", "会话", "context", "bridge"])) {
    return "improve backend routing and context bridge";
  }
  if (includesAnyKeyword(text, ["history", "retention", "export", "历史", "导出"])) {
    return "add history export and retention controls";
  }
  if (includesAnyKeyword(text, ["release", "publish", "版本", "发布", "changelog"])) {
    return "harden release automation pipeline";
  }
  if (type === "docs" || changedFiles.every((file) => isAutoDevDocFile(file))) {
    return "update documentation";
  }
  if (type === "test" || changedFiles.every((file) => isAutoDevTestFile(file))) {
    return "expand regression coverage";
  }

  const target = normalizeCommitIntentTarget(scope);
  if (type === "fix") {
    return `fix ${target}`;
  }
  if (type === "chore") {
    return `maintain ${target}`;
  }
  return `enhance ${target}`;
}

function includesAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function isAutoDevDocFile(file: string): boolean {
  return /(^|\/)docs?\//i.test(file) || /README|CHANGELOG|\.md$/i.test(file);
}

function isAutoDevTestFile(file: string): boolean {
  return /(^|\/)test\//i.test(file) || /\.test\.(t|j)sx?$/i.test(file);
}

function isAutoDevChoreFile(file: string): boolean {
  return /package(-lock)?\.json$/i.test(file) || /(^|\/)scripts\//i.test(file);
}

function normalizeCommitScopeFragment(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs|md)$/i, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || "core";
}

function normalizeTaskIdFragment(raw: string): string {
  const normalized = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]+/g, "");
  return normalized || "TASK";
}

function normalizeCommitIntentTarget(scope: string): string {
  const normalizedScope = normalizeCommitScopeFragment(scope);
  if (!normalizedScope || normalizedScope === "core") {
    return "core workflow";
  }
  return `${normalizedScope.replace(/-/g, " ")} workflow`;
}
