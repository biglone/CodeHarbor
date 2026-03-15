#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");

const LOG_PREFIX = "[codeharbor postinstall]";
const MAIN_SERVICE = "codeharbor.service";
const ADMIN_SERVICE = "codeharbor-admin.service";

function isTruthy(value) {
  if (!value) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isGlobalInstall() {
  return isTruthy(process.env.npm_config_global);
}

function hasRootPrivileges() {
  if (typeof process.getuid !== "function") {
    return true;
  }
  return process.getuid() === 0;
}

function commandExists(file) {
  try {
    execFileSync(file, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runCommand(file, args, options) {
  return execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function listUnitFiles(unitName) {
  try {
    return runCommand("systemctl", ["list-unit-files", unitName, "--no-legend", "--no-pager"]);
  } catch {
    return "";
  }
}

function isUnitInstalled(unitName) {
  const output = listUnitFiles(unitName).trim();
  if (!output) {
    return false;
  }
  return output.split(/\r?\n/).some((line) => line.trim().startsWith(unitName));
}

function isUnitActive(unitName) {
  try {
    const output = runCommand("systemctl", ["is-active", unitName], {}).trim();
    return output === "active";
  } catch {
    return false;
  }
}

function restartUnit(unitName) {
  if (hasRootPrivileges()) {
    runCommand("systemctl", ["restart", unitName], {});
    return;
  }

  runCommand("sudo", ["-n", "systemctl", "restart", unitName], {});
}

function main() {
  if (isTruthy(process.env.CODEHARBOR_SKIP_POSTINSTALL_RESTART)) {
    console.log(`${LOG_PREFIX} skip restart: CODEHARBOR_SKIP_POSTINSTALL_RESTART is set.`);
    return;
  }

  const forceRestart = isTruthy(process.env.CODEHARBOR_FORCE_POSTINSTALL_RESTART);
  if (!forceRestart && !isGlobalInstall()) {
    return;
  }

  if (process.platform !== "linux") {
    return;
  }

  if (!commandExists("systemctl")) {
    return;
  }

  const candidates = [MAIN_SERVICE, ADMIN_SERVICE].filter((unitName) => isUnitInstalled(unitName));
  const activeUnits = candidates.filter((unitName) => isUnitActive(unitName));
  if (activeUnits.length === 0) {
    return;
  }

  const restarted = [];
  const failed = [];

  for (const unitName of activeUnits) {
    try {
      restartUnit(unitName);
      restarted.push(unitName);
    } catch (error) {
      failed.push({ unitName, error });
    }
  }

  if (restarted.length > 0) {
    console.log(`${LOG_PREFIX} restarted: ${restarted.join(", ")}`);
  }
  if (failed.length > 0) {
    for (const failure of failed) {
      const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
      console.warn(`${LOG_PREFIX} failed to restart ${failure.unitName}: ${message}`);
    }
    console.warn(`${LOG_PREFIX} run "codeharbor service restart --with-admin" manually if needed.`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`${LOG_PREFIX} unexpected error: ${message}`);
}
