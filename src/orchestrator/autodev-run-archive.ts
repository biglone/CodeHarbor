import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Logger } from "../logger";
import type { MultiAgentWorkflowRunResult } from "../workflow/multi-agent-workflow";
import { formatError } from "./helpers";
import type { WorkflowDiagEventRecord } from "./workflow-diag";

const execFileAsync = promisify(execFile);

export interface AutoDevRunArchiveRecord {
  version: 1;
  archivedAt: string;
  startedAt: string;
  endedAt: string;
  status: "succeeded" | "failed" | "cancelled";
  workdir: string;
  sessionKey: string;
  conversationId: string;
  requestId: string;
  workflowDiagRunId: string;
  mode: "single" | "loop";
  loop: {
    round: number;
    completedRuns: number;
    maxRuns: number;
    deadlineAt: string | null;
  };
  task: {
    id: string;
    description: string;
    lineIndex: number;
    finalStatus: string | null;
  };
  gate: {
    reviewerApproved: boolean | null;
    validationPassed: boolean | null;
    taskListPolicyPassed: boolean | null;
    completionPassed: boolean | null;
    completionReasons: string[];
  };
  git: {
    commitSummary: string | null;
    changedFiles: string | null;
    releaseSummary: string | null;
  };
  failure: {
    streak: number | null;
    blocked: boolean | null;
    error: string | null;
  };
  workflowResult: MultiAgentWorkflowRunResult | null;
  events: WorkflowDiagEventRecord[];
}

export interface PersistAutoDevRunArchiveInput {
  enabled: boolean;
  archiveDir: string;
  workdir: string;
  logger: Logger;
  record: AutoDevRunArchiveRecord;
}

export interface PersistAutoDevRunArchiveResult {
  written: boolean;
  filePath: string | null;
}

export async function persistAutoDevRunArchive(
  input: PersistAutoDevRunArchiveInput,
): Promise<PersistAutoDevRunArchiveResult> {
  if (!input.enabled) {
    return { written: false, filePath: null };
  }

  const rootDir = resolveArchiveRootDir(input.workdir, input.archiveDir);
  const dateDir = input.record.startedAt.slice(0, 10);
  const destinationDir = path.join(rootDir, dateDir);
  const fileName = buildArchiveFileName(input.record);
  const filePath = path.join(destinationDir, fileName);

  try {
    await fs.mkdir(destinationDir, { recursive: true });
    const payload = `${JSON.stringify(input.record, null, 2)}\n`;
    const tempFilePath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tempFilePath, payload, "utf8");
    await fs.rename(tempFilePath, filePath);
    await ensureArchiveDirGitIgnoredBestEffort({
      workdir: input.workdir,
      archiveRootDir: rootDir,
      logger: input.logger,
    });
    return { written: true, filePath };
  } catch (error) {
    input.logger.warn("Failed to persist AutoDev run archive", {
      filePath,
      error: formatError(error),
    });
    return { written: false, filePath: null };
  }
}

function resolveArchiveRootDir(workdir: string, configuredDir: string): string {
  if (path.isAbsolute(configuredDir)) {
    return configuredDir;
  }
  return path.join(workdir, configuredDir);
}

function buildArchiveFileName(record: Pick<AutoDevRunArchiveRecord, "startedAt" | "workflowDiagRunId" | "task">): string {
  const timestamp = sanitizePathSegment(record.startedAt.replace(/[.:]/g, "-"));
  const taskId = sanitizePathSegment(record.task.id || "task");
  const runHash = createHash("sha1").update(record.workflowDiagRunId).digest("hex").slice(0, 10);
  return `${timestamp}_${taskId}_${runHash}.json`;
}

function sanitizePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized || "unknown";
}

interface EnsureArchiveDirGitIgnoredInput {
  workdir: string;
  archiveRootDir: string;
  logger: Logger;
}

async function ensureArchiveDirGitIgnoredBestEffort(input: EnsureArchiveDirGitIgnoredInput): Promise<void> {
  try {
    const repoRoot = await getGitRepoRoot(input.workdir);
    if (!repoRoot) {
      return;
    }
    const normalizedRepoRoot = path.resolve(repoRoot);
    const normalizedArchiveRoot = path.resolve(input.archiveRootDir);
    const relative = path.relative(normalizedRepoRoot, normalizedArchiveRoot);
    if (!relative || relative === ".") {
      return;
    }
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return;
    }
    const archivePath = normalizeGitIgnorePath(relative);
    if (!archivePath) {
      return;
    }

    const excludePath = path.join(normalizedRepoRoot, ".git", "info", "exclude");
    const baseline = await readOptionalUtf8(excludePath);
    const lines = baseline.split(/\r?\n/);
    const marker = "# CodeHarbor AutoDev run archive";
    const entry = `/${archivePath}/`;
    const hasEntry = lines.some((line) => line.trim() === entry);
    if (hasEntry) {
      return;
    }

    const outputLines = lines.filter((line, index) => index < lines.length - 1 || line.length > 0);
    if (!outputLines.some((line) => line.trim() === marker)) {
      outputLines.push(marker);
    }
    outputLines.push(entry);
    const output = `${outputLines.join("\n")}\n`;
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, output, "utf8");
  } catch (error) {
    input.logger.debug("Failed to add AutoDev run archive path to .git/info/exclude", {
      workdir: input.workdir,
      archiveRootDir: input.archiveRootDir,
      error: formatError(error),
    });
  }
}

async function getGitRepoRoot(workdir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workdir,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const repoRoot = String(stdout ?? "").trim();
    return repoRoot || null;
  } catch {
    return null;
  }
}

function normalizeGitIgnorePath(rawPath: string): string {
  return rawPath
    .split(path.sep)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

async function readOptionalUtf8(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}
