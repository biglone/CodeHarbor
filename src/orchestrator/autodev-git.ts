import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Logger } from "../logger";
import type { MultiAgentWorkflowRunResult } from "../workflow/multi-agent-workflow";
import type { AutoDevTask } from "../workflow/autodev";
import { buildAutoDevCommitMessage, type AutoDevCommitLanguage } from "../workflow/autodev-commit";
import { formatError } from "./helpers";

const AUTODEV_GIT_ARTIFACT_BASENAME_REGEX = /^(autodev|workflow|planner|executor|reviewer)#\d+$/i;
const execFileAsync = promisify(execFile);

export interface AutoDevGitBaseline {
  available: boolean;
  cleanBeforeRun: boolean;
}

export type AutoDevGitPreflightState = "clean" | "dirty" | "no_repo";

export interface AutoDevGitPreflight {
  state: AutoDevGitPreflightState;
  available: boolean;
  cleanBeforeRun: boolean;
  dirtyFiles: string[];
  reason: string | null;
}

export type AutoDevGitPreflightAutoStashResult =
  | { kind: "stashed"; stashRef: string; stashMessage: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string };

export type AutoDevGitCommitResult =
  | { kind: "committed"; commitHash: string; commitSubject: string; changedFiles: string[] }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string };

export async function inspectAutoDevGitPreflight(workdir: string): Promise<AutoDevGitPreflight> {
  const insideRepo = await isGitRepository(workdir);
  if (!insideRepo) {
    return {
      state: "no_repo",
      available: false,
      cleanBeforeRun: false,
      dirtyFiles: [],
      reason: "未检测到 git 仓库",
    };
  }

  try {
    const status = await runGitCommand(workdir, ["status", "--porcelain"]);
    const dirtyFiles = parseGitDirtyFiles(status);
    const cleanBeforeRun = dirtyFiles.length === 0;
    return {
      state: cleanBeforeRun ? "clean" : "dirty",
      available: true,
      cleanBeforeRun,
      dirtyFiles,
      reason: cleanBeforeRun ? null : `检测到 ${dirtyFiles.length} 项未提交改动`,
    };
  } catch (error) {
    return {
      state: "dirty",
      available: true,
      cleanBeforeRun: false,
      dirtyFiles: [],
      reason: `git status 读取失败: ${formatError(error)}`,
    };
  }
}

export async function captureAutoDevGitBaseline(input: {
  workdir: string;
  logger: Logger;
}): Promise<AutoDevGitBaseline> {
  const preflight = await inspectAutoDevGitPreflight(input.workdir);
  if (preflight.state === "dirty" && preflight.reason?.startsWith("git status 读取失败")) {
    input.logger.warn("Failed to capture AutoDev git baseline", {
      workdir: input.workdir,
      error: preflight.reason,
    });
  }
  return {
    available: preflight.available,
    cleanBeforeRun: preflight.cleanBeforeRun,
  };
}

export async function tryAutoDevPreflightAutoStash(workdir: string): Promise<AutoDevGitPreflightAutoStashResult> {
  const insideRepo = await isGitRepository(workdir);
  if (!insideRepo) {
    return {
      kind: "skipped",
      reason: "未检测到 git 仓库",
    };
  }

  const before = await inspectAutoDevGitPreflight(workdir);
  if (before.state !== "dirty") {
    return {
      kind: "skipped",
      reason: "工作区已干净，无需暂存",
    };
  }

  const stamp = new Date().toISOString().replace(/[:]/g, "-");
  const stashMessage = `codeharbor autodev preflight auto-stash ${stamp}`;
  try {
    await runGitCommand(workdir, ["stash", "push", "--include-untracked", "-m", stashMessage]);
    const after = await inspectAutoDevGitPreflight(workdir);
    if (after.state === "dirty") {
      return {
        kind: "failed",
        error: after.reason ?? "auto stash 后工作区仍非干净状态",
      };
    }

    const top = (await runGitCommand(workdir, ["stash", "list", "-n", "1"])).split(/\r?\n/)[0]?.trim() ?? "";
    const stashRef = top.split(":")[0]?.trim() || "stash@{0}";
    return {
      kind: "stashed",
      stashRef,
      stashMessage,
    };
  } catch (error) {
    return {
      kind: "failed",
      error: formatError(error),
    };
  }
}

export async function tryAutoDevGitCommit(input: {
  workdir: string;
  task: AutoDevTask;
  baseline: AutoDevGitBaseline;
  workflowResult?: MultiAgentWorkflowRunResult | null;
  autoCommit: boolean;
  logger: Logger;
}): Promise<AutoDevGitCommitResult> {
  if (!input.autoCommit) {
    return {
      kind: "skipped",
      reason: "AUTODEV_AUTO_COMMIT=false",
    };
  }
  if (!input.baseline.available) {
    return {
      kind: "skipped",
      reason: "未检测到 git 仓库",
    };
  }
  if (!input.baseline.cleanBeforeRun) {
    return {
      kind: "skipped",
      reason: "运行前存在未提交改动，已跳过自动提交",
    };
  }

  try {
    const removedArtifacts = await cleanupAutoDevGitArtifacts(input.workdir, input.logger);
    if (removedArtifacts.length > 0) {
      input.logger.warn("Removed AutoDev shell artifact files before git commit", {
        workdir: input.workdir,
        taskId: input.task.id,
        files: removedArtifacts,
      });
    }

    const preAddStatus = await runGitCommand(input.workdir, ["status", "--porcelain"]);
    if (!preAddStatus.trim()) {
      return {
        kind: "skipped",
        reason: "无文件改动可提交",
      };
    }

    await runGitCommand(input.workdir, ["add", "-A"]);
    const stagedFiles = await listGitStagedFiles(input.workdir);
    if (stagedFiles.length === 0) {
      return {
        kind: "skipped",
        reason: "无文件改动可提交",
      };
    }

    const commitMessage = buildAutoDevCommitMessage(input.task, stagedFiles, {
      workflowReview: input.workflowResult?.review ?? null,
      preferredLanguage: await inferAutoDevCommitLanguage(input.workdir),
    });
    await runGitCommand(input.workdir, [
      "-c",
      "user.name=CodeHarbor AutoDev",
      "-c",
      "user.email=autodev@codeharbor.local",
      "commit",
      "-m",
      commitMessage.subject,
      "-m",
      commitMessage.body,
    ]);
    const hash = (await runGitCommand(input.workdir, ["rev-parse", "--short", "HEAD"])).trim();
    const changedFiles = await listGitCommitChangedFiles(input.workdir);
    return {
      kind: "committed",
      commitHash: hash || "unknown",
      commitSubject: commitMessage.subject,
      changedFiles,
    };
  } catch (error) {
    const message = formatError(error);
    if (/nothing to commit|no changes added to commit/i.test(message)) {
      return {
        kind: "skipped",
        reason: "无文件改动可提交",
      };
    }
    input.logger.warn("AutoDev git auto-commit failed", {
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

export async function inferAutoDevCommitLanguage(workdir: string): Promise<AutoDevCommitLanguage> {
  try {
    const raw = await runGitCommand(workdir, ["log", "--pretty=%s", "-n", "20"]);
    const subjects = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (subjects.length === 0) {
      return "en";
    }

    const classified = subjects
      .map((subject) => classifyCommitSubjectLanguage(subject))
      .filter((value): value is AutoDevCommitLanguage => Boolean(value));
    if (classified.length === 0) {
      return "en";
    }

    const zhCount = classified.filter((value) => value === "zh").length;
    const enCount = classified.length - zhCount;
    if (zhCount / classified.length >= 0.6) {
      return "zh";
    }
    if (enCount / classified.length >= 0.6) {
      return "en";
    }

    const recentWindow = classified.slice(0, 5);
    const recentZh = recentWindow.filter((value) => value === "zh").length;
    const recentEn = recentWindow.length - recentZh;
    if (recentZh > recentEn) {
      return "zh";
    }
    if (recentEn > recentZh) {
      return "en";
    }
    return recentWindow[0] ?? "en";
  } catch {
    return "en";
  }
}

function classifyCommitSubjectLanguage(subject: string): AutoDevCommitLanguage | null {
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(subject)) {
    return "zh";
  }
  if (/[A-Za-z]/.test(subject)) {
    return "en";
  }
  return null;
}

async function listGitCommitChangedFiles(workdir: string): Promise<string[]> {
  const raw = await runGitCommand(workdir, ["show", "--name-only", "--pretty=format:", "--no-renames", "HEAD"]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function listGitStagedFiles(workdir: string): Promise<string[]> {
  const raw = await runGitCommand(workdir, ["diff", "--cached", "--name-only", "--no-renames"]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function cleanupAutoDevGitArtifacts(workdir: string, logger: Logger): Promise<string[]> {
  const untracked = await listUntrackedGitFiles(workdir);
  const targets = untracked.filter((relativePath) => {
    const basename = path.basename(relativePath);
    return AUTODEV_GIT_ARTIFACT_BASENAME_REGEX.test(basename);
  });
  if (targets.length === 0) {
    return [];
  }

  const removed: string[] = [];
  for (const relativePath of targets) {
    const absolutePath = path.join(workdir, relativePath);
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size !== 0) {
        continue;
      }
      await fs.unlink(absolutePath);
      removed.push(relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      logger.debug("Failed to remove AutoDev shell artifact file", {
        workdir,
        file: relativePath,
        error: formatError(error),
      });
    }
  }
  return removed;
}

async function listUntrackedGitFiles(workdir: string): Promise<string[]> {
  const raw = await runGitCommand(workdir, ["ls-files", "--others", "--exclude-standard"]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseGitDirtyFiles(statusOutput: string): string[] {
  return statusOutput
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const payload = line.length >= 3 ? line.slice(3).trim() : line.trim();
      const renamedParts = payload.split("->");
      const pathLike = renamedParts[renamedParts.length - 1] ?? payload;
      return pathLike.trim().replace(/^"|"$/g, "");
    })
    .filter((value) => value.length > 0);
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
