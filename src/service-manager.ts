import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RUNTIME_HOME_ENV_KEY, USER_RUNTIME_HOME_DIR } from "./runtime-home";

const SYSTEMD_DIR = "/etc/systemd/system";
const MAIN_SERVICE_NAME = "codeharbor.service";
const ADMIN_SERVICE_NAME = "codeharbor-admin.service";

interface UnitBuildOptions {
  runUser: string;
  runtimeHome: string;
  nodeBinPath: string;
  cliScriptPath: string;
}

export interface InstallSystemdServicesOptions {
  runUser: string;
  runtimeHome: string;
  nodeBinPath: string;
  cliScriptPath: string;
  installAdmin: boolean;
  startNow: boolean;
  output?: NodeJS.WritableStream;
}

export interface UninstallSystemdServicesOptions {
  removeAdmin: boolean;
  output?: NodeJS.WritableStream;
}

export interface RestartSystemdServicesOptions {
  restartAdmin: boolean;
  output?: NodeJS.WritableStream;
}

export function resolveDefaultRunUser(env: NodeJS.ProcessEnv = process.env): string {
  const sudoUser = env.SUDO_USER?.trim();
  if (sudoUser) {
    return sudoUser;
  }

  const user = env.USER?.trim();
  if (user) {
    return user;
  }

  try {
    return os.userInfo().username;
  } catch {
    return "root";
  }
}

export function resolveRuntimeHomeForUser(
  runUser: string,
  env: NodeJS.ProcessEnv = process.env,
  explicitRuntimeHome?: string,
): string {
  const configuredRuntimeHome = explicitRuntimeHome?.trim() || env[RUNTIME_HOME_ENV_KEY]?.trim();
  if (configuredRuntimeHome) {
    return path.resolve(configuredRuntimeHome);
  }

  const userHome = resolveUserHome(runUser);
  if (userHome) {
    return path.resolve(userHome, USER_RUNTIME_HOME_DIR);
  }

  return path.resolve(os.homedir(), USER_RUNTIME_HOME_DIR);
}

export function buildMainServiceUnit(options: UnitBuildOptions): string {
  validateUnitOptions(options);
  const runtimeHome = path.resolve(options.runtimeHome);

  return [
    "[Unit]",
    "Description=CodeHarbor main service",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${options.runUser}`,
    `WorkingDirectory=${runtimeHome}`,
    `Environment=CODEHARBOR_HOME=${runtimeHome}`,
    `ExecStart=${path.resolve(options.nodeBinPath)} ${path.resolve(options.cliScriptPath)} start`,
    "Restart=always",
    "RestartSec=3",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=full",
    "ProtectHome=false",
    `ReadWritePaths=${runtimeHome}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function buildAdminServiceUnit(options: UnitBuildOptions): string {
  validateUnitOptions(options);
  const runtimeHome = path.resolve(options.runtimeHome);

  return [
    "[Unit]",
    "Description=CodeHarbor admin service",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${options.runUser}`,
    `WorkingDirectory=${runtimeHome}`,
    `Environment=CODEHARBOR_HOME=${runtimeHome}`,
    `ExecStart=${path.resolve(options.nodeBinPath)} ${path.resolve(options.cliScriptPath)} admin serve`,
    "Restart=always",
    "RestartSec=3",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=full",
    "ProtectHome=false",
    `ReadWritePaths=${runtimeHome}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function installSystemdServices(options: InstallSystemdServicesOptions): void {
  assertLinuxWithSystemd();
  assertRootPrivileges();

  const output = options.output ?? process.stdout;
  const runUser = options.runUser.trim();
  const runtimeHome = path.resolve(options.runtimeHome);

  validateSimpleValue(runUser, "runUser");
  validateSimpleValue(runtimeHome, "runtimeHome");
  validateSimpleValue(options.nodeBinPath, "nodeBinPath");
  validateSimpleValue(options.cliScriptPath, "cliScriptPath");

  ensureUserExists(runUser);
  const runGroup = resolveUserGroup(runUser);

  fs.mkdirSync(runtimeHome, { recursive: true });
  runCommand("chown", ["-R", `${runUser}:${runGroup}`, runtimeHome]);

  const mainPath = path.join(SYSTEMD_DIR, MAIN_SERVICE_NAME);
  const adminPath = path.join(SYSTEMD_DIR, ADMIN_SERVICE_NAME);

  const unitOptions: UnitBuildOptions = {
    runUser,
    runtimeHome,
    nodeBinPath: options.nodeBinPath,
    cliScriptPath: options.cliScriptPath,
  };

  fs.writeFileSync(mainPath, buildMainServiceUnit(unitOptions), "utf8");

  if (options.installAdmin) {
    fs.writeFileSync(adminPath, buildAdminServiceUnit(unitOptions), "utf8");
  }

  runSystemctl(["daemon-reload"]);

  if (options.startNow) {
    runSystemctl(["enable", "--now", MAIN_SERVICE_NAME]);
    if (options.installAdmin) {
      runSystemctl(["enable", "--now", ADMIN_SERVICE_NAME]);
    }
  } else {
    runSystemctl(["enable", MAIN_SERVICE_NAME]);
    if (options.installAdmin) {
      runSystemctl(["enable", ADMIN_SERVICE_NAME]);
    }
  }

  output.write(`Installed systemd unit: ${mainPath}\n`);
  if (options.installAdmin) {
    output.write(`Installed systemd unit: ${adminPath}\n`);
  }
  output.write("Done. Check status with: systemctl status codeharbor --no-pager\n");
}

export function uninstallSystemdServices(options: UninstallSystemdServicesOptions): void {
  assertLinuxWithSystemd();
  assertRootPrivileges();

  const output = options.output ?? process.stdout;
  const mainPath = path.join(SYSTEMD_DIR, MAIN_SERVICE_NAME);
  const adminPath = path.join(SYSTEMD_DIR, ADMIN_SERVICE_NAME);

  stopAndDisableIfPresent(MAIN_SERVICE_NAME);
  if (fs.existsSync(mainPath)) {
    fs.unlinkSync(mainPath);
  }

  if (options.removeAdmin) {
    stopAndDisableIfPresent(ADMIN_SERVICE_NAME);
    if (fs.existsSync(adminPath)) {
      fs.unlinkSync(adminPath);
    }
  }

  runSystemctl(["daemon-reload"]);
  runSystemctlIgnoreFailure(["reset-failed"]);

  output.write(`Removed systemd unit: ${mainPath}\n`);
  if (options.removeAdmin) {
    output.write(`Removed systemd unit: ${adminPath}\n`);
  }
  output.write("Done.\n");
}

export function restartSystemdServices(options: RestartSystemdServicesOptions): void {
  assertLinuxWithSystemd();
  assertRootPrivileges();

  const output = options.output ?? process.stdout;
  runSystemctl(["restart", MAIN_SERVICE_NAME]);
  output.write(`Restarted service: ${MAIN_SERVICE_NAME}\n`);

  if (options.restartAdmin) {
    runSystemctl(["restart", ADMIN_SERVICE_NAME]);
    output.write(`Restarted service: ${ADMIN_SERVICE_NAME}\n`);
  }

  output.write("Done.\n");
}

function resolveUserHome(runUser: string): string | null {
  try {
    const passwdRaw = fs.readFileSync("/etc/passwd", "utf8");
    const line = passwdRaw
      .split(/\r?\n/)
      .find((item) => item.startsWith(`${runUser}:`));
    if (!line) {
      return null;
    }
    const fields = line.split(":");
    return fields[5] ? fields[5].trim() : null;
  } catch {
    return null;
  }
}

function validateUnitOptions(options: UnitBuildOptions): void {
  validateSimpleValue(options.runUser, "runUser");
  validateSimpleValue(options.runtimeHome, "runtimeHome");
  validateSimpleValue(options.nodeBinPath, "nodeBinPath");
  validateSimpleValue(options.cliScriptPath, "cliScriptPath");
}

function validateSimpleValue(value: string, key: string): void {
  if (!value.trim()) {
    throw new Error(`${key} cannot be empty.`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`${key} contains invalid newline characters.`);
  }
}

function assertLinuxWithSystemd(): void {
  if (process.platform !== "linux") {
    throw new Error("Systemd service install only supports Linux.");
  }

  try {
    execFileSync("systemctl", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("systemctl is required but not found.");
  }
}

function assertRootPrivileges(): void {
  if (typeof process.getuid !== "function") {
    return;
  }

  if (process.getuid() !== 0) {
    throw new Error("Root privileges are required. Run with sudo.");
  }
}

function ensureUserExists(runUser: string): void {
  runCommand("id", ["-u", runUser]);
}

function resolveUserGroup(runUser: string): string {
  return runCommand("id", ["-gn", runUser]).trim();
}

function runSystemctl(args: string[]): void {
  runCommand("systemctl", args);
}

function stopAndDisableIfPresent(unitName: string): void {
  runSystemctlIgnoreFailure(["disable", "--now", unitName]);
}

function runSystemctlIgnoreFailure(args: string[]): void {
  try {
    runCommand("systemctl", args);
  } catch {
    // Ignore best-effort cleanup failures.
  }
}

function runCommand(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(formatCommandError(file, args, error), { cause: error });
  }
}

function formatCommandError(file: string, args: string[], error: unknown): string {
  const command = `${file} ${args.join(" ")}`.trim();
  if (error && typeof error === "object") {
    const maybeError = error as {
      message?: string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    const stderr = bufferToTrimmedString(maybeError.stderr);
    const stdout = bufferToTrimmedString(maybeError.stdout);
    const details = stderr || stdout || maybeError.message || "command failed";
    return `Command failed: ${command}. ${details}`;
  }

  return `Command failed: ${command}. ${String(error)}`;
}

function bufferToTrimmedString(value: Buffer | string | undefined): string {
  if (!value) {
    return "";
  }

  const text = typeof value === "string" ? value : value.toString("utf8");
  return text.trim();
}
