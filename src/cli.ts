#!/usr/bin/env node

import { Command } from "commander";

import { CodeHarborAdminApp, CodeHarborApp, runDoctor } from "./app";
import { loadConfig } from "./config";
import { runInitCommand } from "./init";
import { formatPreflightReport, runStartupPreflight } from "./preflight";

const program = new Command();

program
  .name("codeharbor")
  .description("Instant-messaging bridge for Codex CLI sessions")
  .version("0.1.0");

program
  .command("init")
  .description("Create or update .env via guided prompts")
  .option("-f, --force", "overwrite existing .env without confirmation")
  .action(async (options: { force?: boolean }) => {
    await runInitCommand({ force: options.force ?? false });
  });

program
  .command("start")
  .description("Start CodeHarbor service")
  .action(async () => {
    const config = await loadConfigWithPreflight("start");
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
    const config = await loadConfigWithPreflight("doctor");
    if (!config) {
      process.exitCode = 1;
      return;
    }
    await runDoctor(config);
  });

const admin = program.command("admin").description("Admin utilities");

admin
  .command("serve")
  .description("Start admin config API server")
  .option("--host <host>", "override admin bind host")
  .option("--port <port>", "override admin bind port")
  .action(async (options: { host?: string; port?: string }) => {
    const config = loadConfig();
    const host = options.host?.trim() || config.adminBindHost;
    const port = options.port ? parsePortOption(options.port, config.adminPort) : config.adminPort;

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

if (process.argv.length <= 2) {
  process.argv.push("start");
}

void program.parseAsync(process.argv);

async function loadConfigWithPreflight(commandName: string): Promise<ReturnType<typeof loadConfig> | null> {
  const preflight = await runStartupPreflight();
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

function parsePortOption(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) {
    process.stderr.write(`Invalid --port value: ${raw}; fallback to ${fallback}\n`);
    return fallback;
  }
  return parsed;
}
