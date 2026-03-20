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
  const subject = `${type}(${scope}): ${buildAutoDevCommitHeadline(task.id, detail, 72)}`;
  const bodyLines = [
    `Task: ${task.id} ${detail}`.trim(),
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
  if (includesAnyKeyword(text, ["autodev", "自动开发", "任务"])) {
    return "autodev";
  }
  if (includesAnyKeyword(text, ["路由", "backend", "model"])) {
    return "routing";
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
      return normalizeCommitScopeFragment(parts[1]);
    }
    if (firstPart && firstPart !== ".") {
      return normalizeCommitScopeFragment(firstPart);
    }
  }

  return type === "docs" ? "docs" : "autodev";
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

function buildAutoDevCommitHeadline(taskId: string, description: string, maxLen: number): string {
  const normalized = description.replace(/\s+/g, " ").trim() || "complete task";
  const base = `${taskId} ${normalized}`.trim();
  if (base.length <= maxLen) {
    return base;
  }
  if (taskId.length + 4 >= maxLen) {
    return `${taskId} task`;
  }
  const remaining = maxLen - taskId.length - 1;
  return `${taskId} ${normalized.slice(0, Math.max(1, remaining - 3)).trim()}...`;
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
  return normalized || "autodev";
}
