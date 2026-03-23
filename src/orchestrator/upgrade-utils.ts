import { execFile, type ExecFileException } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { OutputLanguage } from "../config";
import type { Logger } from "../logger";
import type { UpgradeExecutionLockRecord, UpgradeRunRecord } from "../store/state-store";
import { buildManualRestartCommands, resolveLaunchdLabelConfig, resolveUpgradePlatform } from "../upgrade-platform";
import { formatError } from "./helpers";

const execFileAsync = promisify(execFile);

export interface SelfUpdateResult {
  installedVersion: string | null;
  stdout: string;
  stderr: string;
}

export interface UpgradeVersionProbeResult {
  version: string | null;
  source: string;
  error: string | null;
}

export interface UpgradeRestartPlan {
  summary: string;
  apply: () => Promise<void>;
  manualCommands?: string[];
}

export async function runSelfUpdateCommand(input: { version: string | null; timeoutMs: number }): Promise<SelfUpdateResult> {
  const invocations = resolveSelfUpdateInvocations();
  let lastError: unknown = null;

  for (const invocation of invocations) {
    const args = [...invocation.prefixArgs, "self-update", "--with-admin", "--skip-restart"];
    if (input.version) {
      args.push("--version", input.version);
    }

    try {
      const { stdout, stderr } = await execFileAsync(invocation.file, args, {
        timeout: input.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          CODEHARBOR_SKIP_POSTINSTALL_RESTART: "1",
        },
      });

      const stdoutText = normalizeCommandOutput(stdout);
      const stderrText = normalizeCommandOutput(stderr);
      return {
        installedVersion: parseInstalledVersionFromSelfUpdateOutput(stdoutText + "\n" + stderrText),
        stdout: stdoutText,
        stderr: stderrText,
      };
    } catch (error) {
      if (isCommandNotFound(error)) {
        lastError = error;
        continue;
      }
      throw new Error(`self-update command failed (${invocation.label}): ${formatSelfUpdateError(error)}`, {
        cause: error,
      });
    }
  }

  throw new Error(`unable to run self-update command: ${formatSelfUpdateError(lastError)}`, {
    cause: lastError ?? undefined,
  });
}

export async function buildDefaultUpgradeRestartPlan(input: { logger: Logger }): Promise<UpgradeRestartPlan> {
  const platform = resolveUpgradePlatform();
  if (platform === "linux") {
    return buildLinuxUpgradeRestartPlan(input);
  }
  if (platform === "macos") {
    return buildMacosUpgradeRestartPlan(input);
  }
  if (platform === "windows") {
    return {
      summary: "需手工重启（Windows Service）",
      apply: async () => {},
      manualCommands: buildManualRestartCommands({
        platform: "win32",
        includeAdminService: true,
      }),
    };
  }
  return {
    summary: `需手工重启（平台 ${process.platform}）`,
    apply: async () => {},
    manualCommands: buildManualRestartCommands({
      platform: process.platform,
      includeAdminService: true,
    }),
  };
}

async function buildLinuxUpgradeRestartPlan(input: { logger: Logger }): Promise<UpgradeRestartPlan> {
  const manualCommands = buildManualRestartCommands({
    platform: "linux",
    includeAdminService: true,
  });
  if (!(await isSystemctlCommandAvailable())) {
    return {
      summary: "需手工重启（未检测到 systemctl）",
      apply: async () => {},
      manualCommands,
    };
  }

  const hasMainService = await isSystemdUnitInstalled("codeharbor.service");
  if (!hasMainService) {
    return {
      summary: "需手工重启（未检测到 codeharbor.service）",
      apply: async () => {},
      manualCommands: ["codeharbor start"],
    };
  }
  const hasAdminService = await isSystemdUnitInstalled("codeharbor-admin.service");

  if (!isLikelySystemdServiceProcess()) {
    return {
      summary: "需手工重启（当前非 systemd 服务上下文）",
      apply: async () => {},
      manualCommands,
    };
  }

  return {
    summary: `已触发（systemd signal${hasAdminService ? ", main+admin" : ", main"}）`,
    manualCommands,
    apply: async () => {
      if (hasAdminService) {
        const adminPid = await readSystemdUnitMainPid("codeharbor-admin.service");
        if (adminPid !== null && adminPid > 1 && adminPid !== process.pid) {
          try {
            process.kill(adminPid, "SIGTERM");
          } catch (error) {
            input.logger.warn("Failed to signal codeharbor-admin process for restart", {
              adminPid,
              error,
            });
          }
        }
      }

      const timer = setTimeout(() => {
        try {
          process.kill(process.pid, "SIGTERM");
        } catch (error) {
          input.logger.warn("Failed to signal current process for restart", { error });
        }
      }, 1200);
      timer.unref?.();
    },
  };
}

async function buildMacosUpgradeRestartPlan(input: { logger: Logger }): Promise<UpgradeRestartPlan> {
  const launchdLabels = resolveLaunchdLabelConfig();
  const manualCommands = buildManualRestartCommands({
    platform: "darwin",
    includeAdminService: true,
    launchdLabels,
  });

  if (!(await isLaunchctlCommandAvailable())) {
    return {
      summary: "需手工重启（未检测到 launchctl）",
      apply: async () => {},
      manualCommands,
    };
  }

  if (!isLikelyLaunchdProcess()) {
    return {
      summary: "需手工重启（当前非 launchd 服务上下文）",
      apply: async () => {},
      manualCommands,
    };
  }

  return {
    summary: "已触发（launchd signal, main）",
    manualCommands,
    apply: async () => {
      const timer = setTimeout(() => {
        try {
          process.kill(process.pid, "SIGTERM");
        } catch (error) {
          input.logger.warn("Failed to signal current process for launchd restart", { error });
        }
      }, 1200);
      timer.unref?.();
    },
  };
}

export async function probeInstalledVersion(timeoutMs: number): Promise<UpgradeVersionProbeResult> {
  const invocations = resolveSelfUpdateInvocations();
  let firstError: unknown = null;

  for (const invocation of invocations) {
    const args = [...invocation.prefixArgs, "--version"];
    try {
      const { stdout, stderr } = await execFileAsync(invocation.file, args, {
        timeout: Math.max(1_000, timeoutMs),
        maxBuffer: 256 * 1024,
        env: process.env,
      });
      const output = `${normalizeCommandOutput(stdout)}\n${normalizeCommandOutput(stderr)}`;
      const version = parseSemanticVersion(output);
      if (version) {
        return {
          version,
          source: invocation.label,
          error: null,
        };
      }
    } catch (error) {
      if (!firstError && !isCommandNotFound(error)) {
        firstError = error;
      }
    }
  }

  return {
    version: null,
    source: "unavailable",
    error: firstError ? formatSelfUpdateError(firstError) : null,
  };
}

export function evaluateUpgradePostCheck(input: {
  targetVersion: string | null;
  selfUpdateVersion: string | null;
  versionProbe: UpgradeVersionProbeResult;
  outputLanguage?: OutputLanguage;
}): { ok: boolean; installedVersion: string | null; checkDetail: string } {
  const outputLanguage = input.outputLanguage ?? "zh";
  const isEnglish = outputLanguage === "en";
  const installedVersion = input.versionProbe.version ?? input.selfUpdateVersion;
  const source = input.versionProbe.version ? `version probe (${input.versionProbe.source})` : "self-update output";

  if (!installedVersion) {
    const probeError = input.versionProbe.error ? `; probe=${input.versionProbe.error}` : "";
    return {
      ok: false,
      installedVersion: null,
      checkDetail: isEnglish ? `unable to determine installed version${probeError}` : `无法确认安装版本${probeError}`,
    };
  }

  if (input.targetVersion && installedVersion !== input.targetVersion) {
    return {
      ok: false,
      installedVersion,
      checkDetail: isEnglish
        ? `expected ${input.targetVersion}, got ${installedVersion}`
        : `期望 ${input.targetVersion}，实际 ${installedVersion}`,
    };
  }

  return {
    ok: true,
    installedVersion,
    checkDetail: `installed=${installedVersion}; source=${source}`,
  };
}

export function formatSelfUpdateError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return sanitizeSelfUpdateErrorText(formatError(error)) || "unknown self-update error";
  }
  const maybeError = error as ExecFileException & {
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    message?: string;
  };
  const stderr = sanitizeSelfUpdateErrorText(normalizeOptionalCommandOutput(maybeError.stderr));
  if (stderr) {
    return summarizeCommandOutput(stderr);
  }
  const stdout = sanitizeSelfUpdateErrorText(normalizeOptionalCommandOutput(maybeError.stdout));
  if (stdout) {
    return summarizeCommandOutput(stdout);
  }
  return sanitizeSelfUpdateErrorText(maybeError.message?.trim() || formatError(error)) || "unknown self-update error";
}

export function formatLatestUpgradeSummary(run: UpgradeRunRecord | null, outputLanguage: OutputLanguage = "zh"): string {
  const isEnglish = outputLanguage === "en";
  if (!run) {
    return isEnglish ? "none" : "暂无记录";
  }
  if (run.status === "running") {
    return isEnglish
      ? `#${run.id} running (startedAt=${new Date(run.startedAt).toISOString()})`
      : `#${run.id} 进行中（startedAt=${new Date(run.startedAt).toISOString()}）`;
  }
  if (run.status === "succeeded") {
    return isEnglish
      ? `#${run.id} succeeded (target=${run.targetVersion ?? "latest"}, installed=${run.installedVersion ?? "unknown"}, at=${
          run.finishedAt ? new Date(run.finishedAt).toISOString() : "unknown"
        })`
      : `#${run.id} 成功（target=${run.targetVersion ?? "latest"}, installed=${run.installedVersion ?? "unknown"}, at=${
          run.finishedAt ? new Date(run.finishedAt).toISOString() : "unknown"
        }）`;
  }
  return isEnglish
    ? `#${run.id} failed (target=${run.targetVersion ?? "latest"}, at=${
        run.finishedAt ? new Date(run.finishedAt).toISOString() : "unknown"
      }, error=${run.error ?? "unknown"})`
    : `#${run.id} 失败（target=${run.targetVersion ?? "latest"}, at=${
        run.finishedAt ? new Date(run.finishedAt).toISOString() : "unknown"
      }, error=${run.error ?? "unknown"}）`;
}

export function formatRecentUpgradeRunsSummary(
  runs: UpgradeRunRecord[],
  outputLanguage: OutputLanguage = "zh",
): string {
  const isEnglish = outputLanguage === "en";
  if (runs.length === 0) {
    return isEnglish ? "none" : "暂无记录";
  }
  return runs
    .map((run) => {
      const statusText = run.status === "succeeded" ? "ok" : run.status === "failed" ? "failed" : "running";
      const time = run.finishedAt ?? run.startedAt;
      return `#${run.id}:${statusText}@${new Date(time).toISOString()}`;
    })
    .join(" | ");
}

export function formatUpgradeLockSummary(lock: UpgradeExecutionLockRecord | null): string {
  if (!lock) {
    return "idle";
  }
  return `owner=${lock.owner}, expiresAt=${new Date(lock.expiresAt).toISOString()}`;
}

export function formatUpgradeDiagRecords(runs: UpgradeRunRecord[]): string {
  if (runs.length === 0) {
    return "- (empty)";
  }
  return runs
    .map((run) => {
      const finishedAt = run.finishedAt ? new Date(run.finishedAt).toISOString() : "N/A";
      return [
        `- #${run.id} status=${run.status} target=${run.targetVersion ?? "latest"} installed=${run.installedVersion ?? "unknown"}`,
        `  requestedBy=${run.requestedBy ?? "unknown"} startedAt=${new Date(run.startedAt).toISOString()} finishedAt=${finishedAt}`,
        `  error=${run.error ?? "none"}`,
      ].join("\n");
    })
    .join("\n");
}

async function isSystemctlCommandAvailable(): Promise<boolean> {
  try {
    await execFileAsync("systemctl", ["--version"], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

async function isLaunchctlCommandAvailable(): Promise<boolean> {
  try {
    await execFileAsync("launchctl", ["help"], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      env: process.env,
    });
    return true;
  } catch {
    return false;
  }
}

async function isSystemdUnitInstalled(unitName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["list-unit-files", unitName, "--no-legend"], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      env: process.env,
    });
    const output = normalizeCommandOutput(stdout);
    if (!output) {
      return false;
    }
    return output
      .split(/\r?\n/)
      .some((line) => line.trim().startsWith(`${unitName} `));
  } catch {
    return false;
  }
}

async function readSystemdUnitMainPid(unitName: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["show", unitName, "--property", "MainPID", "--value"], {
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      env: process.env,
    });
    const text = normalizeCommandOutput(stdout);
    if (!text) {
      return null;
    }
    const value = Number.parseInt(text, 10);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function isLikelySystemdServiceProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOCATION_ID || env.SYSTEMD_EXEC_PID || env.JOURNAL_STREAM);
}

function isLikelyLaunchdProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.LAUNCHD_JOB_LABEL || env.__CFBundleIdentifier);
}

function resolveSelfUpdateInvocations(): Array<{ file: string; prefixArgs: string[]; label: string }> {
  const candidates: Array<{ file: string; prefixArgs: string[]; label: string }> = [];

  const cliArgvPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (cliArgvPath && existsSync(cliArgvPath)) {
    candidates.push({
      file: process.execPath,
      prefixArgs: [cliArgvPath],
      label: `node ${cliArgvPath}`,
    });
  }

  const bundledCliPath = path.resolve(__dirname, "cli.js");
  if (existsSync(bundledCliPath)) {
    candidates.push({
      file: process.execPath,
      prefixArgs: [bundledCliPath],
      label: `node ${bundledCliPath}`,
    });
  }

  const uniqueCandidates: Array<{ file: string; prefixArgs: string[]; label: string }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.file}::${candidate.prefixArgs.join(" ")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueCandidates.push(candidate);
  }

  uniqueCandidates.push({
    file: "codeharbor",
    prefixArgs: [],
    label: "codeharbor",
  });
  return uniqueCandidates;
}

export function parseInstalledVersionFromSelfUpdateOutput(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!/installed\s*version\s*:|installedversion\s*:/i.test(line)) {
      continue;
    }
    const parsed = parseSemanticVersion(line);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function parseSemanticVersion(text: string): string | null {
  const match = text.match(/\b([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

function normalizeCommandOutput(value: string | Buffer): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return value.toString("utf8").trim();
}

function isCommandNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeError = error as NodeJS.ErrnoException;
  return maybeError.code === "ENOENT";
}

function sanitizeSelfUpdateErrorText(text: string): string {
  const withoutWarning = text
    .replace(
      /\(\s*node:\d+\)\s*ExperimentalWarning:\s*SQLite is an experimental feature and might change at any time/gi,
      "",
    )
    .replace(/\(Use [`"]?node --trace-warnings[^)]*\)/gi, "");
  const filtered = withoutWarning
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      return true;
    });
  return filtered.join("\n").trim();
}

function normalizeOptionalCommandOutput(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return normalizeCommandOutput(value);
}

function summarizeCommandOutput(text: string, maxLen = 400): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen)}...`;
}
