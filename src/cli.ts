#!/usr/bin/env node

import { Command } from "commander";

import { CodeHarborApp, runDoctor } from "./app";
import { loadConfig } from "./config";

const program = new Command();

program
  .name("codeharbor")
  .description("Instant-messaging bridge for Codex CLI sessions")
  .version("0.1.0");

program
  .command("start")
  .description("Start CodeHarbor service")
  .action(async () => {
    const config = loadConfig();
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
    const config = loadConfig();
    await runDoctor(config);
  });

if (process.argv.length <= 2) {
  process.argv.push("start");
}

void program.parseAsync(process.argv);
