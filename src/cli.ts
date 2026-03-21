#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Command } from "commander";

import { CodeHarborAdminApp, CodeHarborApp, runDoctor } from "./app";
import { isNonLoopbackHost } from "./utils/admin-host";
import { loadConfig, loadEnvFromFile } from "./config";
import { runConfigExportCommand, runConfigImportCommand } from "./config-snapshot";
import { runInitCommand } from "./init";
import { formatPreflightReport, runStartupPreflight } from "./preflight";
import { resolveRuntimeHome } from "./runtime-home";
import {
  installSystemdServices,
  restartSystemdServices,
  resolveDefaultRunUser,
  resolveRuntimeHomeForUser,
  uninstallSystemdServices,
} from "./service-manager";
import {
  buildManualRestartCommands,
  buildUpgradeRecoveryAdvice,
  resolveLaunchdLabelConfig,
  resolveUpgradePlatform,
} from "./upgrade-platform";

let runtimeHome: string | null = null;
const cliVersion = resolveCliVersion();

const program = new Command();

program
  .name("codeharbor")
  .description("Instant-messaging bridge for Codex/Claude Code CLI sessions")
  .version(cliVersion);

program.addHelpText(
  "after",
  [
    "",
    "Prerequisites:",
    "  - AI CLI installed and authenticated (Codex: codex login; Claude Code: claude login)",
    "  - Matrix bot credentials in .env: MATRIX_HOMESERVER, MATRIX_USER_ID, MATRIX_ACCESS_TOKEN",
    "",
    "Runtime:",
    "  - default CODEHARBOR_HOME: ~/.codeharbor (legacy /opt/codeharbor/.env is auto-detected)",
    "  - running without subcommand defaults to: codeharbor start",
    "",
    "Common CLI commands:",
    "  - codeharbor init",
    "  - codeharbor doctor",
    "  - codeharbor self-update",
    "  - codeharbor config export -o backup.json",
    "  - codeharbor config import backup.json --dry-run",
    "  - codeharbor service install --with-admin",
    "  - codeharbor admin serve --host 127.0.0.1 --port 8787",
    "",
    "Common in-chat commands (send to bot in Matrix):",
    "  - /help",
    "  - /status",
    "  - /version",
    "  - /diag version",
    "  - /diag media [count]",
    "  - /diag upgrade [count]",
    "  - /upgrade [version]",
    "  - /backend codex|claude [model] | /backend auto|status",
    "  - /autodev stop",
    "  - /reset",
    "  - /stop",
  ].join("\n"),
);

program
  .command("init")
  .description("Create or update .env via guided prompts")
  .option("-f, --force", "overwrite existing .env without confirmation")
  .action(async (options: { force?: boolean }) => {
    const home = ensureRuntimeHomeOrExit();
    await runInitCommand({ force: options.force ?? false, cwd: home });
  });

program
  .command("start")
  .description("Start CodeHarbor service")
  .action(async () => {
    const home = ensureRuntimeHomeOrExit();
    const config = await loadConfigWithPreflight("start", home);
    if (!config) {
      process.exitCode = 1;
      return;
    }

    const app = new CodeHarborApp(config);
    await app.start();

    const stop = async (): Promise<void> => {
      await app.stop();
      process.exit(0);
    };

    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
  });

program
  .command("doctor")
  .description("Check AI CLI and matrix connectivity")
  .action(async () => {
    const home = ensureRuntimeHomeOrExit();
    const config = await loadConfigWithPreflight("doctor", home);
    if (!config) {
      process.exitCode = 1;
      return;
    }
    await runDoctor(config);
  });

const admin = program.command("admin").description("Admin utilities");
const configCommand = program.command("config").description("Config snapshot utilities");
const serviceCommand = program.command("service").description("Systemd service management");

admin.addHelpText(
  "after",
  [
    "",
    "Notes:",
    "  - For non-loopback host binding, set ADMIN_TOKEN or ADMIN_TOKENS_JSON.",
    "  - Admin UI routes: /settings/global, /settings/rooms, /health, /audit.",
  ].join("\n"),
);

configCommand.addHelpText(
  "after",
  [
    "",
    "Examples:",
    "  - codeharbor config export -o backup.json",
    "  - codeharbor config import backup.json --dry-run",
  ].join("\n"),
);

serviceCommand.addHelpText(
  "after",
  [
    "",
    "Notes:",
    "  - Service subcommands auto-elevate with sudo when required.",
    "  - Use --with-admin to manage both main and admin services together.",
  ].join("\n"),
);

admin
  .command("serve")
  .description("Start admin config API server")
  .option("--host <host>", "override admin bind host")
  .option("--port <port>", "override admin bind port")
  .option(
    "--allow-insecure-no-token",
    "allow serving admin API without ADMIN_TOKEN on non-loopback host (not recommended)",
  )
  .action(async (options: { host?: string; port?: string; allowInsecureNoToken?: boolean }) => {
    ensureRuntimeHomeOrExit();
    const config = loadConfig();
    const host = options.host?.trim() || config.adminBindHost;
    const port = options.port ? parsePortOption(options.port, config.adminPort) : config.adminPort;
    const allowInsecureNoToken = options.allowInsecureNoToken ?? false;
    const hasAdminAuth = Boolean(config.adminToken) || config.adminTokens.length > 0;

    if (!hasAdminAuth && !allowInsecureNoToken && isNonLoopbackHost(host)) {
      process.stderr.write(
        [
          "Refusing to start admin server on non-loopback host without admin auth token.",
          "Fix: set ADMIN_TOKEN or ADMIN_TOKENS_JSON in .env, or explicitly pass --allow-insecure-no-token.",
          "",
        ].join("\n"),
      );
      process.exitCode = 1;
      return;
    }

    const app = new CodeHarborAdminApp(config, { host, port });
    await app.start();

    const stop = async (): Promise<void> => {
      await app.stop();
      process.exit(0);
    };

    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
  });

configCommand
  .command("export")
  .description("Export config snapshot as JSON")
  .option("-o, --output <path>", "write snapshot to file instead of stdout")
  .action(async (options: { output?: string }) => {
    try {
      const home = ensureRuntimeHomeOrExit();
      await runConfigExportCommand({ outputPath: options.output, cwd: home });
    } catch (error) {
      process.stderr.write(`Config export failed: ${formatError(error)}\n`);
      process.exitCode = 1;
    }
  });

configCommand
  .command("import")
  .description("Import config snapshot from JSON")
  .argument("<file>", "snapshot file path")
  .option("--dry-run", "validate snapshot without writing changes")
  .action(async (file: string, options: { dryRun?: boolean }) => {
    try {
      const home = ensureRuntimeHomeOrExit();
      await runConfigImportCommand({
        filePath: file,
        dryRun: options.dryRun ?? false,
        cwd: home,
      });
    } catch (error) {
      process.stderr.write(`Config import failed: ${formatError(error)}\n`);
      process.exitCode = 1;
    }
  });

serviceCommand
  .command("install")
  .description("Install and enable codeharbor systemd service (requires root)")
  .option("--run-user <user>", "service user (default: sudo user or current user)")
  .option("--runtime-home <path>", "runtime home used as CODEHARBOR_HOME")
  .option("--with-admin", "also install codeharbor-admin.service")
  .option("--no-start", "enable service without starting immediately")
  .action((options: { runUser?: string; runtimeHome?: string; withAdmin?: boolean; start?: boolean }) => {
    try {
      maybeReexecServiceCommandWithSudo();
      const runUser = options.runUser?.trim() || resolveDefaultRunUser();
      const runtimeHomePath = resolveRuntimeHomeForUser(runUser, process.env, options.runtimeHome);
      installSystemdServices({
        runUser,
        runtimeHome: runtimeHomePath,
        nodeBinPath: process.execPath,
        cliScriptPath: resolveCliScriptPath(),
        installAdmin: options.withAdmin ?? false,
        startNow: options.start ?? true,
      });
    } catch (error) {
      process.stderr.write(`Service install failed: ${formatError(error)}\n`);
      process.stderr.write(
        [
          "Hint:",
          "  - Run directly: codeharbor service install --with-admin",
          "  - The command auto-elevates with sudo when needed.",
          `  - Fallback explicit form: ${buildExplicitSudoCommand("service install --with-admin")}`,
          "",
        ].join("\n"),
      );
      process.exitCode = 1;
    }
  });

serviceCommand
  .command("uninstall")
  .description("Remove codeharbor systemd service (requires root)")
  .option("--with-admin", "also remove codeharbor-admin.service")
  .action((options: { withAdmin?: boolean }) => {
    try {
      maybeReexecServiceCommandWithSudo();
      uninstallSystemdServices({
        removeAdmin: options.withAdmin ?? false,
      });
    } catch (error) {
      process.stderr.write(`Service uninstall failed: ${formatError(error)}\n`);
      process.stderr.write(
        [
          "Hint:",
          "  - Run directly: codeharbor service uninstall --with-admin",
          "  - The command auto-elevates with sudo when needed.",
          `  - Fallback explicit form: ${buildExplicitSudoCommand("service uninstall --with-admin")}`,
          "",
        ].join("\n"),
      );
      process.exitCode = 1;
    }
  });

serviceCommand
  .command("restart")
  .description("Restart installed codeharbor systemd service (requires root)")
  .option("--with-admin", "also restart codeharbor-admin.service")
  .action((options: { withAdmin?: boolean }) => {
    try {
      maybeReexecServiceCommandWithSudo();
      restartSystemdServices({
        restartAdmin: options.withAdmin ?? false,
      });
    } catch (error) {
      process.stderr.write(`Service restart failed: ${formatError(error)}\n`);
      process.stderr.write(
        [
          "Hint:",
          "  - Run directly: codeharbor service restart --with-admin",
          "  - The command auto-elevates with sudo when needed.",
          `  - Fallback explicit form: ${buildExplicitSudoCommand("service restart --with-admin")}`,
          "",
        ].join("\n"),
      );
      process.exitCode = 1;
    }
  });

program
  .command("self-update")
  .description("Install latest npm package and restart installed service(s)")
  .option("--version <version>", "install a specific version instead of latest")
  .option("--with-admin", "also restart codeharbor-admin.service when installed")
  .option("--skip-restart", "skip service restart step after install")
  .action((options: { version?: string; withAdmin?: boolean; skipRestart?: boolean }) => {
    const version = options.version?.trim();
    const target = version ? `codeharbor@${version}` : "codeharbor@latest";
    const includeAdminService = options.withAdmin ?? false;
    const previousVersion = resolveInstalledCodeHarborVersion();
    const fallbackRestartCommands = buildManualRestartCommands({
      includeAdminService,
    });
    try {
      process.stdout.write(`[self-update] Installing ${target}...\n`);
      const installResult = spawnSync("npm", ["install", "-g", target], {
        stdio: "inherit",
      });
      if (installResult.error) {
        throw new Error(`npm install failed: ${installResult.error.message}`);
      }
      if ((installResult.status ?? 1) !== 0) {
        throw new Error(`npm install exited with code ${installResult.status ?? 1}`);
      }

      const installedVersion = resolveInstalledCodeHarborVersion();
      const restartResult = runPostUpdateRestart({
        includeAdminService,
        skipRestart: options.skipRestart ?? false,
      });
      const recoveryAdvice = buildUpgradeRecoveryAdvice({
        previousVersion,
        targetVersion: version ?? null,
        installedVersion,
        includeAdminService,
        manualRestartCommands: restartResult.manualCommands,
      });

      process.stdout.write(`[self-update] 结果摘要\n`);
      process.stdout.write(`- status: success\n`);
      process.stdout.write(`- target: ${version ?? "latest"}\n`);
      process.stdout.write(
        `- installedVersion: ${installedVersion ?? "(unknown, run codeharbor --version to verify)"}\n`,
      );
      process.stdout.write(`- restart: ${restartResult.summary}\n`);
      process.stdout.write(`- rollback: ${recoveryAdvice.rollbackCommand}\n`);
      process.stdout.write(`- restartCommands: ${formatCommandSummary(recoveryAdvice.restartCommands)}\n`);
    } catch (error) {
      const errorText = formatError(error);
      const recoveryAdvice = buildUpgradeRecoveryAdvice({
        previousVersion,
        targetVersion: version ?? null,
        installedVersion: null,
        includeAdminService,
        manualRestartCommands: fallbackRestartCommands,
      });
      process.stderr.write(`Self-update failed: ${errorText}\n`);
      process.stderr.write(`[self-update] 结果摘要\n`);
      process.stderr.write(`- status: failed\n`);
      process.stderr.write(`- target: ${version ?? "latest"}\n`);
      process.stderr.write(`- previousVersion: ${previousVersion ?? "(unknown)"}\n`);
      process.stderr.write(`- rollback: ${recoveryAdvice.rollbackCommand}\n`);
      process.stderr.write(`- restartCommands: ${formatCommandSummary(recoveryAdvice.restartCommands)}\n`);
      process.stderr.write(`- error: ${errorText}\n`);
      process.exitCode = 1;
    }
  });

if (process.argv.length <= 2) {
  process.argv.push("start");
}

void program.parseAsync(process.argv);

async function loadConfigWithPreflight(
  commandName: string,
  runtimeHomePath: string,
): Promise<ReturnType<typeof loadConfig> | null> {
  const env = { ...process.env };
  const preflight = await runStartupPreflight({ cwd: runtimeHomePath, env });
  if (preflight.resolvedCodexBin) {
    env.CODEX_BIN = preflight.resolvedCodexBin;
  }
  if (preflight.issues.length > 0) {
    const report = formatPreflightReport(preflight, commandName);
    if (preflight.ok) {
      process.stdout.write(report);
    } else {
      process.stderr.write(report);
      return null;
    }
  }

  try {
    return loadConfig(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Configuration error: ${message}\n`);
    process.stderr.write("Fix: run \"codeharbor init\" and then retry.\n");
    return null;
  }
}

function ensureRuntimeHomeOrExit(): string {
  if (runtimeHome) {
    return runtimeHome;
  }

  const home = resolveRuntimeHome();

  try {
    fs.mkdirSync(home, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Runtime setup failed: cannot create ${home}. ${message}\n`);
    process.exit(1);
  }

  try {
    process.chdir(home);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Runtime setup failed: cannot switch to ${home}. ${message}\n`);
    process.exit(1);
  }

  loadEnvFromFile(path.resolve(home, ".env"));
  runtimeHome = home;
  return runtimeHome;
}

function parsePortOption(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) {
    process.stderr.write(`Invalid --port value: ${raw}; fallback to ${fallback}\n`);
    return fallback;
  }
  return parsed;
}

function resolveCliVersion(): string {
  try {
    const packagePath = path.resolve(__dirname, "..", "package.json");
    const content = fs.readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(content) as { version?: string };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function resolveCliScriptPath(): string {
  const argvPath = process.argv[1];
  if (argvPath && argvPath.trim()) {
    return path.resolve(argvPath);
  }
  return path.resolve(__dirname, "cli.js");
}

function maybeReexecServiceCommandWithSudo(): void {
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    return;
  }

  const serviceArgs = process.argv.slice(2);
  if (serviceArgs.length === 0 || serviceArgs[0] !== "service") {
    return;
  }

  const cliScriptPath = resolveCliScriptPath();
  const child = spawnSync("sudo", [process.execPath, cliScriptPath, ...serviceArgs], {
    stdio: "inherit",
  });
  if (child.error) {
    throw new Error(`failed to auto-elevate with sudo: ${child.error.message}`);
  }

  process.exit(child.status ?? 1);
}

function shellQuote(value: string): string {
  if (!value) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildExplicitSudoCommand(subcommand: string): string {
  return `sudo ${shellQuote(process.execPath)} ${shellQuote(resolveCliScriptPath())} ${subcommand}`;
}

function hasSystemdUnit(unitName: string): boolean {
  const unit = unitName.trim();
  if (!unit || process.platform !== "linux") {
    return false;
  }
  const result = spawnSync("systemctl", ["list-unit-files", unit, "--no-legend"], {
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0 || result.error) {
    return false;
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  return stdout
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith(`${unit} `));
}

interface PostUpdateRestartResult {
  summary: string;
  manualCommands: string[];
}

function runPostUpdateRestart(input: {
  includeAdminService: boolean;
  skipRestart: boolean;
}): PostUpdateRestartResult {
  const platform = resolveUpgradePlatform();
  if (platform === "linux") {
    return runLinuxPostUpdateRestart(input);
  }
  if (platform === "macos") {
    return runMacosPostUpdateRestart(input);
  }
  if (platform === "windows") {
    return {
      summary: input.skipRestart ? "已跳过（--skip-restart）" : "需手工重启（Windows Service）",
      manualCommands: buildManualRestartCommands({
        platform: "win32",
        includeAdminService: input.includeAdminService,
      }),
    };
  }
  return {
    summary: input.skipRestart ? "已跳过（--skip-restart）" : `需手工重启（平台 ${process.platform}）`,
    manualCommands: buildManualRestartCommands({
      platform: process.platform,
      includeAdminService: input.includeAdminService,
    }),
  };
}

function runLinuxPostUpdateRestart(input: {
  includeAdminService: boolean;
  skipRestart: boolean;
}): PostUpdateRestartResult {
  const manualCommands = buildManualRestartCommands({
    platform: "linux",
    includeAdminService: input.includeAdminService,
  });
  if (input.skipRestart) {
    return {
      summary: "已跳过（--skip-restart）",
      manualCommands,
    };
  }

  if (!commandExistsSync("systemctl", ["--version"])) {
    return {
      summary: "需手工重启（未检测到 systemctl）",
      manualCommands,
    };
  }

  const hasMainService = hasSystemdUnit("codeharbor.service");
  if (!hasMainService) {
    return {
      summary: "需手工重启（未检测到 codeharbor.service）",
      manualCommands: ["codeharbor start"],
    };
  }
  const hasAdminService = hasSystemdUnit("codeharbor-admin.service");
  const restartAdmin = input.includeAdminService && hasAdminService;
  try {
    restartSystemdServices({
      restartAdmin,
    });
    return {
      summary: `已自动重启（systemd${restartAdmin ? ", main+admin" : ", main"}）`,
      manualCommands,
    };
  } catch (error) {
    return {
      summary: `自动重启失败（${formatError(error)}）`,
      manualCommands,
    };
  }
}

function runMacosPostUpdateRestart(input: {
  includeAdminService: boolean;
  skipRestart: boolean;
}): PostUpdateRestartResult {
  const launchdLabels = resolveLaunchdLabelConfig();
  const manualCommands = buildManualRestartCommands({
    platform: "darwin",
    includeAdminService: input.includeAdminService,
    launchdLabels,
  });
  if (input.skipRestart) {
    return {
      summary: "已跳过（--skip-restart）",
      manualCommands,
    };
  }

  if (!commandExistsSync("launchctl", ["help"])) {
    return {
      summary: "需手工重启（未检测到 launchctl）",
      manualCommands,
    };
  }

  const labels = [launchdLabels.main];
  if (input.includeAdminService) {
    labels.push(launchdLabels.admin);
  }

  const restartedTargets: string[] = [];
  const errors: string[] = [];
  for (const label of labels) {
    try {
      const restarted = restartLaunchdJob(label);
      if (restarted) {
        restartedTargets.push(restarted);
      }
    } catch (error) {
      errors.push(`${label}: ${formatError(error)}`);
    }
  }

  if (restartedTargets.length > 0) {
    if (errors.length === 0) {
      return {
        summary: `已自动重启（launchd: ${restartedTargets.join(", ")}）`,
        manualCommands,
      };
    }
    return {
      summary: `部分自动重启成功（launchd: ${restartedTargets.join(", ")}；errors=${errors.join(" | ")}）`,
      manualCommands,
    };
  }

  if (errors.length > 0) {
    return {
      summary: `自动重启失败（${errors.join(" | ")}）`,
      manualCommands,
    };
  }

  return {
    summary: "需手工重启（未检测到 launchd job）",
    manualCommands,
  };
}

function restartLaunchdJob(label: string): string | null {
  const safeLabel = label.trim();
  if (!safeLabel) {
    return null;
  }
  const domains = resolveLaunchdDomains();
  for (const domain of domains) {
    const target = `${domain}/${safeLabel}`;
    const probe = spawnSync("launchctl", ["print", target], {
      stdio: "ignore",
    });
    if ((probe.status ?? 1) !== 0 || probe.error) {
      continue;
    }
    const kickstart = spawnSync("launchctl", ["kickstart", "-k", target], {
      encoding: "utf8",
    });
    if (kickstart.error) {
      throw new Error(kickstart.error.message);
    }
    if ((kickstart.status ?? 1) !== 0) {
      const stderr = typeof kickstart.stderr === "string" ? kickstart.stderr.trim() : "";
      throw new Error(stderr || `launchctl kickstart exited with code ${kickstart.status ?? 1}`);
    }
    return target;
  }
  return null;
}

function resolveLaunchdDomains(): string[] {
  const domains: string[] = [];
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    domains.push(`gui/${uid}`, `user/${uid}`);
  }
  domains.push("system");
  return domains;
}

function commandExistsSync(file: string, args: string[]): boolean {
  const result = spawnSync(file, args, {
    stdio: "ignore",
  });
  return !result.error && (result.status ?? 1) === 0;
}

function formatCommandSummary(commands: string[]): string {
  if (commands.length === 0) {
    return "N/A";
  }
  return commands.join(" || ");
}

function resolveInstalledCodeHarborVersion(): string | null {
  const result = spawnSync("codeharbor", ["--version"], {
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0 || result.error) {
    return null;
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const value = stdout.trim();
  return value || null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
