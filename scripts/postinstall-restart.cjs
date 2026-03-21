#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");

const LOG_PREFIX = "[codeharbor postinstall]";
const MAIN_SERVICE = "codeharbor.service";
const ADMIN_SERVICE = "codeharbor-admin.service";
const DEFAULT_LAUNCHD_MAIN_LABEL = "com.codeharbor.main";
const DEFAULT_LAUNCHD_ADMIN_LABEL = "com.codeharbor.admin";
const SAFE_LAUNCHD_LABEL_PATTERN = /^[A-Za-z0-9_.-]+$/;

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

function commandExists(file, args = ["--version"]) {
  try {
    execFileSync(file, args, { stdio: "ignore" });
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

function sanitizeLaunchdLabel(value, fallback) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return fallback;
  }
  if (!SAFE_LAUNCHD_LABEL_PATTERN.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function resolveLaunchdDomains() {
  const domains = [];
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    domains.push(`gui/${uid}`, `user/${uid}`);
  }
  domains.push("system");
  return domains;
}

function tryResolveLaunchdTarget(label) {
  for (const domain of resolveLaunchdDomains()) {
    const target = `${domain}/${label}`;
    try {
      execFileSync("launchctl", ["print", target], {
        stdio: "ignore",
      });
      return target;
    } catch {
      continue;
    }
  }
  return null;
}

function restartLaunchdTarget(target) {
  runCommand("launchctl", ["kickstart", "-k", target], {});
}

function runLinuxRestart() {
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

function runMacosRestart() {
  if (!commandExists("launchctl", ["help"])) {
    return;
  }

  const mainLabel = sanitizeLaunchdLabel(process.env.CODEHARBOR_LAUNCHD_MAIN_LABEL, DEFAULT_LAUNCHD_MAIN_LABEL);
  const adminLabel = sanitizeLaunchdLabel(process.env.CODEHARBOR_LAUNCHD_ADMIN_LABEL, DEFAULT_LAUNCHD_ADMIN_LABEL);
  const labels = [mainLabel, adminLabel];
  const restarted = [];
  const failed = [];

  for (const label of labels) {
    const target = tryResolveLaunchdTarget(label);
    if (!target) {
      continue;
    }
    try {
      restartLaunchdTarget(target);
      restarted.push(target);
    } catch (error) {
      failed.push({ label, error });
    }
  }

  if (restarted.length > 0) {
    console.log(`${LOG_PREFIX} restarted launchd jobs: ${restarted.join(", ")}`);
  }
  if (failed.length > 0) {
    for (const failure of failed) {
      const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
      console.warn(`${LOG_PREFIX} failed to restart ${failure.label}: ${message}`);
    }
  }

  if (restarted.length === 0 || failed.length > 0) {
    console.warn(`${LOG_PREFIX} manual launchctl restart commands if needed:`);
    console.warn(`${LOG_PREFIX}   launchctl kickstart -k gui/$(id -u)/${mainLabel}`);
    console.warn(`${LOG_PREFIX}   launchctl kickstart -k gui/$(id -u)/${adminLabel}`);
  }
}

function printWindowsManualRestartHint() {
  console.warn(`${LOG_PREFIX} windows detected; auto restart is disabled for safety.`);
  console.warn(`${LOG_PREFIX} manual restart commands if needed:`);
  console.warn(`${LOG_PREFIX}   powershell -NoProfile -Command "Restart-Service -Name codeharbor"`);
  console.warn(`${LOG_PREFIX}   powershell -NoProfile -Command "Restart-Service -Name codeharbor-admin"`);
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

  if (process.platform === "linux") {
    runLinuxRestart();
    return;
  }
  if (process.platform === "darwin") {
    runMacosRestart();
    return;
  }
  if (process.platform === "win32") {
    printWindowsManualRestartHint();
    return;
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`${LOG_PREFIX} unexpected error: ${message}`);
}
