import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { Logger } from "../logger";
import type { MultiAgentWorkflowRunResult } from "../workflow/multi-agent-workflow";
import type { AutoDevTask } from "../workflow/autodev";
import { buildAutoDevCommitMessage } from "../workflow/autodev-commit";
import { formatError } from "./helpers";

const AUTODEV_GIT_ARTIFACT_BASENAME_REGEX = /^(autodev|workflow|planner|executor|reviewer)#\d+$/i;
const execFileAsync = promisify(execFile);

export interface AutoDevGitBaseline {
  available: boolean;
  cleanBeforeRun: boolean;
}

export type AutoDevGitCommitResult =
  | { kind: "committed"; commitHash: string; commitSubject: string; changedFiles: string[] }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: string };

export async function captureAutoDevGitBaseline(input: {
  workdir: string;
  logger: Logger;
}): Promise<AutoDevGitBaseline> {
  const insideRepo = await isGitRepository(input.workdir);
  if (!insideRepo) {
    return {
      available: false,
      cleanBeforeRun: false,
    };
  }
  try {
    const status = await runGitCommand(input.workdir, ["status", "--porcelain"]);
    return {
      available: true,
      cleanBeforeRun: status.trim().length === 0,
    };
  } catch (error) {
    input.logger.warn("Failed to capture AutoDev git baseline", {
      workdir: input.workdir,
      error: formatError(error),
    });
    return {
      available: false,
      cleanBeforeRun: false,
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
