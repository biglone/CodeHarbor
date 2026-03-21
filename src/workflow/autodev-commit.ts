import type { AutoDevTask } from "./autodev";

interface AutoDevCommitMessage {
  subject: string;
  body: string;
}

export type AutoDevCommitLanguage = "en" | "zh";

interface AutoDevCommitMessageOptions {
  workflowReview?: string | null;
  preferredLanguage?: AutoDevCommitLanguage;
}

type AutoDevCommitType = "feat" | "fix" | "docs" | "test" | "chore";

export function buildAutoDevCommitMessage(
  task: AutoDevTask,
  changedFiles: string[],
  options: AutoDevCommitMessageOptions = {},
): AutoDevCommitMessage {
  const preferredLanguage = options.preferredLanguage ?? "en";
  const detail = task.description.trim();
  const normalizedFiles = normalizeAutoDevCommitFiles(changedFiles);
  const type = inferAutoDevCommitType(detail, normalizedFiles);
  const scope = inferAutoDevCommitScope(detail, normalizedFiles, type);
  const changedFilesSummary = summarizeAutoDevCommitFiles(normalizedFiles);
  const skillIntent = extractSkillCommitIntentFromReview(options.workflowReview ?? null, 58, preferredLanguage);
  const inferredIntent = inferAutoDevCommitIntent(detail, normalizedFiles, scope, type, preferredLanguage);
  const subject = `${type}(${scope}): ${buildAutoDevCommitHeadline(task.id, skillIntent ?? inferredIntent, 58, preferredLanguage)}`;
  const bodyLines = buildAutoDevCommitBodyLines(task.id, changedFilesSummary, preferredLanguage);

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
  intent: string,
  maxLen: number,
  language: AutoDevCommitLanguage,
): string {
  const normalizedTaskId = normalizeTaskIdFragment(taskId);
  const base = `${intent} (${normalizedTaskId})`;
  if (base.length <= maxLen) {
    return base;
  }
  const minimumRoomForIntent = 12;
  const suffix = ` (${normalizedTaskId})`;
  const available = maxLen - suffix.length;
  if (available <= minimumRoomForIntent) {
    return language === "zh" ? `更新任务 ${suffix.trim()}` : `update task ${suffix.trim()}`;
  }
  const sliced = trimCommitIntentSuffix(intent.slice(0, available).trim(), language);
  return `${sliced}${suffix}`;
}

function extractSkillCommitIntentFromReview(
  review: string | null,
  maxLen: number,
  language: AutoDevCommitLanguage,
): string | null {
  if (typeof review !== "string" || !review.trim()) {
    return null;
  }
  const lines = review
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const summaryLine = lines.find((line) => /^summary\s*:/i.test(line));
  if (!summaryLine) {
    return null;
  }
  const rawSummary = summaryLine.replace(/^summary\s*:/i, "").trim();
  return normalizeSkillCommitIntent(rawSummary, maxLen, language);
}

function normalizeSkillCommitIntent(raw: string, maxLen: number, language: AutoDevCommitLanguage): string | null {
  let candidate = raw
    .replace(/\s+/g, " ")
    .replace(/^[-*]\s+/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\bT\d+(?:\.\d+)?\b/gi, "")
    .replace(/[.,;:!?\- ]+$/g, "")
    .trim();
  if (!candidate) {
    return null;
  }
  if (language === "en") {
    if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(candidate)) {
      return null;
    }
    if (!/^[\x20-\x7E]+$/.test(candidate)) {
      return null;
    }
    if (!/[a-z]/i.test(candidate)) {
      return null;
    }
    candidate = candidate.toLowerCase();
    if (candidate.length < 8 || candidate === "ok" || candidate === "passed" || candidate === "approved") {
      return null;
    }
    if (
      !/^(add|align|build|deliver|enable|enhance|ensure|expand|extend|fix|harden|implement|improve|optimize|prevent|reduce|refactor|simplify|stabilize|standardize|streamline|support|update)\b/.test(
        candidate,
      )
    ) {
      candidate = `improve ${candidate}`;
    }
    if (candidate.length <= maxLen) {
      return candidate;
    }
    const sliced = trimCommitIntentSuffix(candidate.slice(0, maxLen).trim(), language);
    return sliced.length >= 8 ? sliced : null;
  }

  if (!/[\u3400-\u9fff\uf900-\ufaff]/.test(candidate)) {
    return null;
  }
  if (candidate.length < 4 || candidate === "通过" || candidate === "已通过" || candidate === "批准") {
    return null;
  }
  if (candidate.length <= maxLen) {
    return candidate;
  }
  const sliced = trimCommitIntentSuffix(candidate.slice(0, maxLen).trim(), language);
  return sliced.length >= 4 ? sliced : null;
}

function inferAutoDevCommitIntent(
  description: string,
  changedFiles: string[],
  scope: string,
  type: AutoDevCommitType,
  language: AutoDevCommitLanguage,
): string {
  if (language === "zh") {
    return inferAutoDevCommitIntentZh(description, changedFiles, scope, type);
  }
  return inferAutoDevCommitIntentEn(description, changedFiles, scope, type);
}

function inferAutoDevCommitIntentEn(
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

  const target = normalizeCommitIntentTarget(scope, "en");
  if (type === "fix") {
    return `fix ${target}`;
  }
  if (type === "chore") {
    return `maintain ${target}`;
  }
  return `enhance ${target}`;
}

function inferAutoDevCommitIntentZh(
  description: string,
  changedFiles: string[],
  scope: string,
  type: AutoDevCommitType,
): string {
  const text = description.toLowerCase();
  if (includesAnyKeyword(text, ["upgrade", "install", "restart", "恢复", "升级", "安装"])) {
    return "优化安装与升级流程";
  }
  if (includesAnyKeyword(text, ["backend", "route", "routing", "model", "桥接", "会话", "context", "bridge"])) {
    return "优化后端路由与上下文桥接";
  }
  if (includesAnyKeyword(text, ["history", "retention", "export", "历史", "导出"])) {
    return "增强历史导出与保留策略";
  }
  if (includesAnyKeyword(text, ["release", "publish", "版本", "发布", "changelog"])) {
    return "完善发布自动化流程";
  }
  if (type === "docs" || changedFiles.every((file) => isAutoDevDocFile(file))) {
    return "更新文档说明";
  }
  if (type === "test" || changedFiles.every((file) => isAutoDevTestFile(file))) {
    return "补充回归测试覆盖";
  }

  const target = normalizeCommitIntentTarget(scope, "zh");
  if (type === "fix") {
    return `修复${target}`;
  }
  if (type === "chore") {
    return `维护${target}`;
  }
  return `优化${target}`;
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

function normalizeCommitIntentTarget(scope: string, language: AutoDevCommitLanguage): string {
  const normalizedScope = normalizeCommitScopeFragment(scope);
  if (language === "zh") {
    if (!normalizedScope || normalizedScope === "core") {
      return "核心流程";
    }
    return `${normalizedScope.replace(/-/g, " ")}流程`;
  }
  if (!normalizedScope || normalizedScope === "core") {
    return "core workflow";
  }
  return `${normalizedScope.replace(/-/g, " ")} workflow`;
}

function buildAutoDevCommitBodyLines(taskId: string, changedFilesSummary: string, language: AutoDevCommitLanguage): string[] {
  if (language === "zh") {
    return [`任务ID: ${taskId}`, `变更文件: ${changedFilesSummary}`, "生成方式: CodeHarbor AutoDev"];
  }
  return [`Task-ID: ${taskId}`, `Changed-files: ${changedFilesSummary}`, "Generated-by: CodeHarbor AutoDev"];
}

function trimCommitIntentSuffix(value: string, language: AutoDevCommitLanguage): string {
  if (language === "zh") {
    return value.replace(/[，。；：！？、\s-]+$/g, "");
  }
  return value.replace(/[^\w)\]]+$/g, "");
}
