#!/usr/bin/env node

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
  resolveDefaultRunUser,
  resolveRuntimeHomeForUser,
  uninstallSystemdServices,
} from "./service-manager";

let runtimeHome: string | null = null;
const cliVersion = resolveCliVersion();

const program = new Command();

program
  .name("codeharbor")
  .description("Instant-messaging bridge for Codex CLI sessions")
  .version(cliVersion);

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
  .description("Check codex and matrix connectivity")
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

    if (!config.adminToken && !allowInsecureNoToken && isNonLoopbackHost(host)) {
      process.stderr.write(
        [
          "Refusing to start admin server on non-loopback host without ADMIN_TOKEN.",
          "Fix: set ADMIN_TOKEN in .env, or explicitly pass --allow-insecure-no-token.",
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
      process.stderr.write("Hint: run with sudo, for example: sudo codeharbor service install\n");
      process.exitCode = 1;
    }
  });

serviceCommand
  .command("uninstall")
  .description("Remove codeharbor systemd service (requires root)")
  .option("--with-admin", "also remove codeharbor-admin.service")
  .action((options: { withAdmin?: boolean }) => {
    try {
      uninstallSystemdServices({
        removeAdmin: options.withAdmin ?? false,
      });
    } catch (error) {
      process.stderr.write(`Service uninstall failed: ${formatError(error)}\n`);
      process.stderr.write("Hint: run with sudo, for example: sudo codeharbor service uninstall\n");
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
  const preflight = await runStartupPreflight({ cwd: runtimeHomePath });
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
    return loadConfig();
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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
