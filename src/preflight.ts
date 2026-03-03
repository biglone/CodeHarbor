import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REQUIRED_ENV_KEYS = ["MATRIX_HOMESERVER", "MATRIX_USER_ID", "MATRIX_ACCESS_TOKEN"] as const;

type PreflightIssueCode =
  | "missing_dotenv"
  | "missing_env"
  | "invalid_matrix_homeserver"
  | "invalid_matrix_user_id"
  | "missing_codex_bin"
  | "invalid_codex_workdir";

export interface PreflightIssue {
  level: "warn" | "error";
  code: PreflightIssueCode;
  check: string;
  message: string;
  fix: string;
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
}

export interface PreflightOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  checkCodexBinary?: (bin: string) => Promise<void>;
  fileExists?: (targetPath: string) => boolean;
  isDirectory?: (targetPath: string) => boolean;
}

export async function runStartupPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const checkCodexBinary = options.checkCodexBinary ?? defaultCheckCodexBinary;
  const fileExists = options.fileExists ?? fs.existsSync;
  const isDirectory = options.isDirectory ?? defaultIsDirectory;

  const issues: PreflightIssue[] = [];
  const envPath = path.resolve(cwd, ".env");

  if (!fileExists(envPath)) {
    issues.push({
      level: "warn",
      code: "missing_dotenv",
      check: ".env",
      message: `No .env file found at ${envPath}.`,
      fix: "cp .env.example .env && codeharbor init",
    });
  }

  for (const key of REQUIRED_ENV_KEYS) {
    if (!readEnv(env, key)) {
      issues.push({
        level: "error",
        code: "missing_env",
        check: key,
        message: `${key} is required.`,
        fix: `Run "codeharbor init" or set ${key} in .env.`,
      });
    }
  }

  const matrixHomeserver = readEnv(env, "MATRIX_HOMESERVER");
  if (matrixHomeserver) {
    try {
      new URL(matrixHomeserver);
    } catch {
      issues.push({
        level: "error",
        code: "invalid_matrix_homeserver",
        check: "MATRIX_HOMESERVER",
        message: `Invalid URL: "${matrixHomeserver}".`,
        fix: "Set MATRIX_HOMESERVER to a full URL, for example https://matrix.example.com.",
      });
    }
  }

  const matrixUserId = readEnv(env, "MATRIX_USER_ID");
  if (matrixUserId && !/^@[^:\s]+:.+/.test(matrixUserId)) {
    issues.push({
      level: "error",
      code: "invalid_matrix_user_id",
      check: "MATRIX_USER_ID",
      message: `Unexpected Matrix user id format: "${matrixUserId}".`,
      fix: "Set MATRIX_USER_ID like @bot:example.com.",
    });
  }

  const codexBin = readEnv(env, "CODEX_BIN") || "codex";
  try {
    await checkCodexBinary(codexBin);
  } catch (error) {
    const reason = error instanceof Error && error.message ? ` (${error.message})` : "";
    issues.push({
      level: "error",
      code: "missing_codex_bin",
      check: "CODEX_BIN",
      message: `Unable to execute "${codexBin}"${reason}.`,
      fix: `Install Codex CLI and ensure "${codexBin}" is in PATH, or set CODEX_BIN=/absolute/path/to/codex.`,
    });
  }

  const configuredWorkdir = readEnv(env, "CODEX_WORKDIR");
  const workdir = path.resolve(cwd, configuredWorkdir || cwd);
  if (!fileExists(workdir) || !isDirectory(workdir)) {
    issues.push({
      level: "error",
      code: "invalid_codex_workdir",
      check: "CODEX_WORKDIR",
      message: `Working directory does not exist or is not a directory: ${workdir}.`,
      fix: `Set CODEX_WORKDIR to an existing directory, for example CODEX_WORKDIR=${cwd}.`,
    });
  }

  return {
    ok: issues.every((issue) => issue.level !== "error"),
    issues,
  };
}

export function formatPreflightReport(result: PreflightResult, commandName: string): string {
  const lines: string[] = [];
  const errors = result.issues.filter((issue) => issue.level === "error").length;
  const warnings = result.issues.filter((issue) => issue.level === "warn").length;

  if (result.ok) {
    lines.push(`Preflight check passed for "codeharbor ${commandName}" with ${warnings} warning(s).`);
  } else {
    lines.push(
      `Preflight check failed for "codeharbor ${commandName}" with ${errors} error(s) and ${warnings} warning(s).`,
    );
  }

  for (const issue of result.issues) {
    const level = issue.level.toUpperCase();
    lines.push(`- [${level}] ${issue.check}: ${issue.message}`);
    lines.push(`  fix: ${issue.fix}`);
  }

  return `${lines.join("\n")}\n`;
}

async function defaultCheckCodexBinary(bin: string): Promise<void> {
  await execFileAsync(bin, ["--version"]);
}

function defaultIsDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? "";
}
