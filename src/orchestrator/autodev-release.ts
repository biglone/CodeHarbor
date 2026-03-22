import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Logger } from "../logger";
import type { AutoDevTask } from "../workflow/autodev";
import type { AutoDevGitCommitResult } from "./autodev-git";
import { formatError } from "./helpers";

const execFileAsync = promisify(execFile);
const PACKAGE_FILE = "package.json";
const PACKAGE_LOCK_FILE = "package-lock.json";
const CHANGELOG_FILE = "CHANGELOG.md";

export interface AutoDevReleaseSettings {
  enabled: boolean;
  autoPush: boolean;
}

export type AutoDevReleaseResult =
  | {
      kind: "released";
      version: string;
      commitHash: string;
      commitSubject: string;
      pushed: boolean;
      pushError?: string;
    }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string };

export async function tryAutoDevTaskRelease(input: {
  workdir: string;
  task: AutoDevTask;
  taskListPath: string;
  gitCommit: AutoDevGitCommitResult;
  settings: AutoDevReleaseSettings;
  logger: Logger;
}): Promise<AutoDevReleaseResult> {
  if (!input.settings.enabled) {
    return {
      kind: "skipped",
      reason: "AUTODEV_AUTO_RELEASE_ENABLED=false",
    };
  }
  if (input.task.status !== "completed") {
    return {
      kind: "skipped",
      reason: "任务未完成，跳过自动发布",
    };
  }
  if (input.gitCommit.kind !== "committed") {
    return {
      kind: "skipped",
      reason: "任务代码未自动提交，跳过自动发布",
    };
  }

  let taskReleaseVersionMap: Map<string, string>;
  try {
    taskReleaseVersionMap = await loadTaskReleaseVersionMap(input.taskListPath);
  } catch (error) {
    return {
      kind: "failed",
      error: formatError(error),
    };
  }

  const mappedVersion = taskReleaseVersionMap.get(input.task.id.trim().toLowerCase());
  if (!mappedVersion) {
    return {
      kind: "skipped",
      reason: "任务未配置大功能发布映射",
    };
  }

  try {
    const insideRepo = await isGitRepository(input.workdir);
    if (!insideRepo) {
      return {
        kind: "skipped",
        reason: "未检测到 git 仓库",
      };
    }

    const packagePath = path.join(input.workdir, PACKAGE_FILE);
    const currentVersion = await readPackageVersion(packagePath);
    const compareMappedVersion = compareSemver(mappedVersion, currentVersion);
    if (compareMappedVersion === null) {
      return {
        kind: "failed",
        error: `版本比较失败: current=${currentVersion}, mapped=${mappedVersion}`,
      };
    }

    if (compareMappedVersion <= 0) {
      await runNpmCommand(input.workdir, ["version", "patch", "--no-git-tag-version"]);
    } else {
      await runNpmCommand(input.workdir, ["version", mappedVersion, "--no-git-tag-version"]);
    }

    const releaseVersion = await readPackageVersion(packagePath);
    await upsertChangelogRelease(input.workdir, releaseVersion, input.task);

    const stagedCandidates = await collectExistingReleaseFiles(input.workdir);
    if (stagedCandidates.length === 0) {
      return {
        kind: "failed",
        error: "未找到可发布文件（package.json/package-lock.json/CHANGELOG.md）",
      };
    }
    await runGitCommand(input.workdir, ["add", ...stagedCandidates]);

    const stagedFiles = await listGitStagedFiles(input.workdir);
    if (stagedFiles.length === 0) {
      return {
        kind: "skipped",
        reason: "发布未产生可提交文件",
      };
    }

    const commitSubject = `release: v${releaseVersion} [publish-npm]`;
    const commitBody = [
      `Task-ID: ${input.task.id}`,
      `Task-Commit: ${input.gitCommit.commitHash}`,
      "Generated-by: CodeHarbor AutoDev",
    ].join("\n");
    await runGitCommand(input.workdir, [
      "-c",
      "user.name=CodeHarbor AutoDev",
      "-c",
      "user.email=autodev@codeharbor.local",
      "commit",
      "-m",
      commitSubject,
      "-m",
      commitBody,
    ]);

    const commitHash = (await runGitCommand(input.workdir, ["rev-parse", "--short", "HEAD"])).trim() || "unknown";

    let pushed = false;
    let pushError: string | undefined;
    if (input.settings.autoPush) {
      try {
        await runGitCommand(input.workdir, ["push"]);
        pushed = true;
      } catch (error) {
        pushed = false;
        pushError = formatError(error);
        input.logger.warn("AutoDev release commit push failed", {
          workdir: input.workdir,
          taskId: input.task.id,
          version: releaseVersion,
          error: pushError,
        });
      }
    }

    return {
      kind: "released",
      version: releaseVersion,
      commitHash,
      commitSubject,
      pushed,
      ...(pushError ? { pushError } : {}),
    };
  } catch (error) {
    const message = formatError(error);
    input.logger.warn("AutoDev release failed", {
      workdir: input.workdir,
      taskId: input.task.id,
      error: message,
    });
    return {
      kind: "failed",
      error: message,
    };
  }
}

async function loadTaskReleaseVersionMap(taskListPath: string): Promise<Map<string, string>> {
  const content = await fs.readFile(taskListPath, "utf8");
  const output = new Map<string, string>();
  for (const rawLine of extractReleaseMappingSectionLines(content)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) {
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) {
      continue;
    }
    const taskId = normalizeTaskId(cells[0] ?? "");
    if (!taskId) {
      continue;
    }
    const releaseVersion = normalizeSemver(cells[1] ?? "");
    if (!releaseVersion) {
      continue;
    }
    output.set(taskId, releaseVersion);
  }
  return output;
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function extractReleaseMappingSectionLines(content: string): string[] {
  const lines = splitLines(content);
  const releaseMappingHeadingPattern = /^#{1,6}\s+.*(?:发布映射|release mapping)/i;
  const markdownHeadingPattern = /^#{1,6}\s+/;
  let sectionStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!releaseMappingHeadingPattern.test(line)) {
      continue;
    }
    sectionStart = index;
    break;
  }
  if (sectionStart < 0) {
    return [];
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!markdownHeadingPattern.test(line)) {
      continue;
    }
    sectionEnd = index;
    break;
  }

  return lines.slice(sectionStart + 1, sectionEnd);
}

function normalizeTaskId(raw: string): string | null {
  const normalized = raw.replace(/`/g, "").trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(normalized)) {
    return null;
  }
  return normalized.toLowerCase();
}

function normalizeSemver(raw: string): string | null {
  const normalized = raw.replace(/`/g, "").trim();
  const match = normalized.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

async function readPackageVersion(packagePath: string): Promise<string> {
  const content = await fs.readFile(packagePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("package.json 解析失败");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("package.json 内容无效");
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || !normalizeSemver(version)) {
    throw new Error("package.json 缺少合法 semver 版本号");
  }
  return normalizeSemver(version) as string;
}

async function upsertChangelogRelease(workdir: string, version: string, task: AutoDevTask): Promise<void> {
  const changelogPath = path.join(workdir, CHANGELOG_FILE);
  const today = new Date().toISOString().slice(0, 10);
  const header = `## [${version}] - ${today}`;
  const bullet = `- AutoDev feature delivered: ${task.id}`;
  const content = await readOptionalFile(changelogPath);
  if (!content) {
    const initial = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "- (none yet)",
      "",
      header,
      "",
      bullet,
      "",
    ].join("\n");
    await fs.writeFile(changelogPath, initial, "utf8");
    return;
  }

  if (content.includes(`## [${version}]`)) {
    return;
  }

  const lines = splitLines(content);
  const sectionLines = [header, "", bullet, ""];
  const unreleasedIndex = lines.findIndex((line) => line.trim().toLowerCase() === "## [unreleased]");
  if (unreleasedIndex < 0) {
    if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") {
      lines.push("");
    }
    lines.push(...sectionLines);
    await fs.writeFile(changelogPath, lines.join("\n"), "utf8");
    return;
  }

  let insertIndex = lines.length;
  for (let index = unreleasedIndex + 1; index < lines.length; index += 1) {
    if ((lines[index] ?? "").startsWith("## [")) {
      insertIndex = index;
      break;
    }
  }

  const payload: string[] = [];
  if (insertIndex > 0 && lines[insertIndex - 1]?.trim() !== "") {
    payload.push("");
  }
  payload.push(...sectionLines);
  lines.splice(insertIndex, 0, ...payload);
  await fs.writeFile(changelogPath, lines.join("\n"), "utf8");
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

async function collectExistingReleaseFiles(workdir: string): Promise<string[]> {
  const candidates = [PACKAGE_FILE, PACKAGE_LOCK_FILE, CHANGELOG_FILE];
  const output: string[] = [];
  for (const file of candidates) {
    try {
      await fs.access(path.join(workdir, file));
      output.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return output;
}

function compareSemver(left: string, right: string): number | null {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return null;
  }

  if (parsedLeft[0] !== parsedRight[0]) {
    return parsedLeft[0] > parsedRight[0] ? 1 : -1;
  }
  if (parsedLeft[1] !== parsedRight[1]) {
    return parsedLeft[1] > parsedRight[1] ? 1 : -1;
  }
  if (parsedLeft[2] !== parsedRight[2]) {
    return parsedLeft[2] > parsedRight[2] ? 1 : -1;
  }
  return 0;
}

function parseSemver(raw: string): [number, number, number] | null {
  const normalized = normalizeSemver(raw);
  if (!normalized) {
    return null;
  }
  const [majorRaw, minorRaw, patchRaw] = normalized.split(".");
  const major = Number.parseInt(majorRaw ?? "", 10);
  const minor = Number.parseInt(minorRaw ?? "", 10);
  const patch = Number.parseInt(patchRaw ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return [major, minor, patch];
}

async function listGitStagedFiles(workdir: string): Promise<string[]> {
  const raw = await runGitCommand(workdir, ["diff", "--cached", "--name-only", "--no-renames"]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function isGitRepository(workdir: string): Promise<boolean> {
  try {
    const output = await runGitCommand(workdir, ["rev-parse", "--is-inside-work-tree"]);
    return output.trim() === "true";
  } catch {
    return false;
  }
}

async function runGitCommand(workdir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workdir,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return String(stdout ?? "");
}

async function runNpmCommand(workdir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("npm", args, {
    cwd: workdir,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return String(stdout ?? "");
}
