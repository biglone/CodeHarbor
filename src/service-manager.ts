import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RUNTIME_HOME_ENV_KEY, USER_RUNTIME_HOME_DIR } from "./runtime-home";

const SYSTEMD_DIR = "/etc/systemd/system";
const MAIN_SERVICE_BASENAME = "codeharbor";
const ADMIN_SERVICE_BASENAME = "codeharbor-admin";
const SUDOERS_DIR = "/etc/sudoers.d";
const RESTART_SUDOERS_BASENAME = "codeharbor-restart";
const SERVICE_SUFFIX = ".service";
const SYSTEMD_INSTANCE_ENV_KEY = "CODEHARBOR_SYSTEMD_INSTANCE";
const SYSTEMD_MAIN_UNIT_ENV_KEY = "CODEHARBOR_SYSTEMD_MAIN_UNIT";
const SYSTEMD_ADMIN_UNIT_ENV_KEY = "CODEHARBOR_SYSTEMD_ADMIN_UNIT";
const INSTANCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface UnitBuildOptions {
  runUser: string;
  runtimeHome: string;
  nodeBinPath: string;
  cliScriptPath: string;
  instanceName: string | null;
  mainServiceName: string;
  adminServiceName: string;
}

interface RestartSudoersPolicyOptions {
  runUser: string;
  systemctlPath: string;
  mainServiceName?: string;
  adminServiceName?: string;
}

interface RestartAdminSystemdServiceOptions {
  output?: NodeJS.WritableStream;
  allowSudoFallback?: boolean;
  instanceName?: string;
}

interface QueueAdminSystemdRestartOptions {
  output?: NodeJS.WritableStream;
  allowSudoFallback?: boolean;
  delayMs?: number;
  instanceName?: string;
}

export interface InstallSystemdServicesOptions {
  runUser: string;
  runtimeHome: string;
  nodeBinPath: string;
  cliScriptPath: string;
  installAdmin: boolean;
  startNow: boolean;
  instanceName?: string;
  output?: NodeJS.WritableStream;
}

export interface UninstallSystemdServicesOptions {
  removeAdmin: boolean;
  instanceName?: string;
  output?: NodeJS.WritableStream;
}

export interface RestartSystemdServicesOptions {
  restartAdmin: boolean;
  output?: NodeJS.WritableStream;
  allowSudoFallback?: boolean;
  instanceName?: string;
}

export interface SystemdServiceUnitNames {
  instanceName: string | null;
  mainServiceName: string;
  adminServiceName: string;
  restartSudoersFile: string;
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

export function resolveSystemdServiceUnitNames(instanceName?: string | null): SystemdServiceUnitNames {
  const normalizedInstance = normalizeInstanceName(instanceName);
  if (!normalizedInstance) {
    return {
      instanceName: null,
      mainServiceName: `${MAIN_SERVICE_BASENAME}${SERVICE_SUFFIX}`,
      adminServiceName: `${ADMIN_SERVICE_BASENAME}${SERVICE_SUFFIX}`,
      restartSudoersFile: RESTART_SUDOERS_BASENAME,
    };
  }

  return {
    instanceName: normalizedInstance,
    mainServiceName: `${MAIN_SERVICE_BASENAME}-${normalizedInstance}${SERVICE_SUFFIX}`,
    adminServiceName: `${ADMIN_SERVICE_BASENAME}-${normalizedInstance}${SERVICE_SUFFIX}`,
    restartSudoersFile: `${RESTART_SUDOERS_BASENAME}-${normalizedInstance}`,
  };
}

export function resolveRuntimeSystemdServiceUnitNames(env: NodeJS.ProcessEnv = process.env): SystemdServiceUnitNames {
  const runtimeMainUnit = env[SYSTEMD_MAIN_UNIT_ENV_KEY]?.trim() ?? "";
  const runtimeAdminUnit = env[SYSTEMD_ADMIN_UNIT_ENV_KEY]?.trim() ?? "";
  const runtimeInstance = normalizeInstanceNameSafe(env[SYSTEMD_INSTANCE_ENV_KEY]);

  if (isValidSystemdUnitName(runtimeMainUnit) && isValidSystemdUnitName(runtimeAdminUnit)) {
    return {
      instanceName: runtimeInstance,
      mainServiceName: runtimeMainUnit,
      adminServiceName: runtimeAdminUnit,
      restartSudoersFile: runtimeInstance
        ? `${RESTART_SUDOERS_BASENAME}-${runtimeInstance}`
        : RESTART_SUDOERS_BASENAME,
    };
  }

  return resolveSystemdServiceUnitNames(runtimeInstance);
}

export function buildMainServiceUnit(options: UnitBuildOptions): string {
  validateUnitOptions(options);
  const runtimeHome = path.resolve(options.runtimeHome);
  const instanceLabel = options.instanceName ? ` (${options.instanceName})` : "";
  const instanceEnvValue = options.instanceName ?? "default";

  return [
    "[Unit]",
    `Description=CodeHarbor main service${instanceLabel}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${options.runUser}`,
    `WorkingDirectory=${runtimeHome}`,
    `Environment=CODEHARBOR_HOME=${runtimeHome}`,
    `Environment=${SYSTEMD_INSTANCE_ENV_KEY}=${instanceEnvValue}`,
    `Environment=${SYSTEMD_MAIN_UNIT_ENV_KEY}=${options.mainServiceName}`,
    `Environment=${SYSTEMD_ADMIN_UNIT_ENV_KEY}=${options.adminServiceName}`,
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
  const instanceLabel = options.instanceName ? ` (${options.instanceName})` : "";
  const instanceEnvValue = options.instanceName ?? "default";

  return [
    "[Unit]",
    `Description=CodeHarbor admin service${instanceLabel}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${options.runUser}`,
    `WorkingDirectory=${runtimeHome}`,
    `Environment=CODEHARBOR_HOME=${runtimeHome}`,
    `Environment=${SYSTEMD_INSTANCE_ENV_KEY}=${instanceEnvValue}`,
    `Environment=${SYSTEMD_MAIN_UNIT_ENV_KEY}=${options.mainServiceName}`,
    `Environment=${SYSTEMD_ADMIN_UNIT_ENV_KEY}=${options.adminServiceName}`,
    `ExecStart=${path.resolve(options.nodeBinPath)} ${path.resolve(options.cliScriptPath)} admin serve`,
    "Restart=always",
    "RestartSec=3",
    "NoNewPrivileges=false",
    "PrivateTmp=true",
    "ProtectSystem=full",
    "ProtectHome=false",
    `ReadWritePaths=${runtimeHome}`,
    "ReadWritePaths=/etc/systemd/system",
    "ReadWritePaths=/etc/sudoers.d",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function buildRestartSudoersPolicy(options: RestartSudoersPolicyOptions): string {
  const runUser = options.runUser.trim();
  const systemctlPath = options.systemctlPath.trim();
  const serviceNames = resolveSystemdServiceUnitNamesFromInput({
    instanceName: null,
    explicitMainServiceName: options.mainServiceName,
    explicitAdminServiceName: options.adminServiceName,
  });

  validateSimpleValue(runUser, "runUser");
  validateSimpleValue(systemctlPath, "systemctlPath");
  if (!path.isAbsolute(systemctlPath)) {
    throw new Error("systemctlPath must be an absolute path.");
  }

  return [
    "# Managed by CodeHarbor service install; do not edit manually.",
    `Defaults:${runUser} !requiretty`,
    `${runUser} ALL=(root) NOPASSWD: ${systemctlPath} restart ${serviceNames.mainServiceName}, ${systemctlPath} restart ${serviceNames.adminServiceName}`,
    "",
  ].join("\n");
}

export function installSystemdServices(options: InstallSystemdServicesOptions): void {
  assertLinuxWithSystemd();
  assertRootPrivileges();

  const output = options.output ?? process.stdout;
  const runUser = options.runUser.trim();
  const runtimeHome = path.resolve(options.runtimeHome);
  const serviceNames = resolveSystemdServiceUnitNames(options.instanceName ?? null);

  validateSimpleValue(runUser, "runUser");
  validateSimpleValue(runtimeHome, "runtimeHome");
  validateSimpleValue(options.nodeBinPath, "nodeBinPath");
  validateSimpleValue(options.cliScriptPath, "cliScriptPath");

  ensureUserExists(runUser);
  const runGroup = resolveUserGroup(runUser);

  fs.mkdirSync(runtimeHome, { recursive: true });
  runCommand("chown", ["-R", `${runUser}:${runGroup}`, runtimeHome]);

  const mainPath = path.join(SYSTEMD_DIR, serviceNames.mainServiceName);
  const adminPath = path.join(SYSTEMD_DIR, serviceNames.adminServiceName);
  const restartSudoersPath = path.join(SUDOERS_DIR, serviceNames.restartSudoersFile);

  const unitOptions: UnitBuildOptions = {
    runUser,
    runtimeHome,
    nodeBinPath: options.nodeBinPath,
    cliScriptPath: options.cliScriptPath,
    instanceName: serviceNames.instanceName,
    mainServiceName: serviceNames.mainServiceName,
    adminServiceName: serviceNames.adminServiceName,
  };

  fs.writeFileSync(mainPath, buildMainServiceUnit(unitOptions), "utf8");

  if (options.installAdmin) {
    fs.writeFileSync(adminPath, buildAdminServiceUnit(unitOptions), "utf8");
    if (runUser !== "root") {
      const policy = buildRestartSudoersPolicy({
        runUser,
        systemctlPath: resolveSystemctlPath(),
        mainServiceName: serviceNames.mainServiceName,
        adminServiceName: serviceNames.adminServiceName,
      });
      fs.mkdirSync(SUDOERS_DIR, { recursive: true });
      fs.writeFileSync(restartSudoersPath, policy, "utf8");
      fs.chmodSync(restartSudoersPath, 0o440);
    }
  }

  runSystemctl(["daemon-reload"]);

  if (options.startNow) {
    runSystemctl(["enable", "--now", serviceNames.mainServiceName]);
    if (options.installAdmin) {
      runSystemctl(["enable", "--now", serviceNames.adminServiceName]);
    }
  } else {
    runSystemctl(["enable", serviceNames.mainServiceName]);
    if (options.installAdmin) {
      runSystemctl(["enable", serviceNames.adminServiceName]);
    }
  }

  output.write(`Installed systemd unit: ${mainPath}\n`);
  if (options.installAdmin) {
    output.write(`Installed systemd unit: ${adminPath}\n`);
    if (runUser !== "root") {
      output.write(`Installed sudoers policy: ${restartSudoersPath}\n`);
    }
  }
  output.write(`Done. Check status with: systemctl status ${serviceNames.mainServiceName} --no-pager\n`);
}

export function uninstallSystemdServices(options: UninstallSystemdServicesOptions): void {
  assertLinuxWithSystemd();
  assertRootPrivileges();

  const output = options.output ?? process.stdout;
  const serviceNames = resolveSystemdServiceUnitNames(options.instanceName ?? null);
  const mainPath = path.join(SYSTEMD_DIR, serviceNames.mainServiceName);
  const adminPath = path.join(SYSTEMD_DIR, serviceNames.adminServiceName);
  const restartSudoersPath = path.join(SUDOERS_DIR, serviceNames.restartSudoersFile);

  stopAndDisableIfPresent(serviceNames.mainServiceName);
  if (fs.existsSync(mainPath)) {
    fs.unlinkSync(mainPath);
  }

  if (options.removeAdmin) {
    stopAndDisableIfPresent(serviceNames.adminServiceName);
    if (fs.existsSync(adminPath)) {
      fs.unlinkSync(adminPath);
    }
    if (fs.existsSync(restartSudoersPath)) {
      fs.unlinkSync(restartSudoersPath);
    }
  }

  runSystemctl(["daemon-reload"]);
  runSystemctlIgnoreFailure(["reset-failed"]);

  output.write(`Removed systemd unit: ${mainPath}\n`);
  if (options.removeAdmin) {
    output.write(`Removed systemd unit: ${adminPath}\n`);
    output.write(`Removed sudoers policy: ${restartSudoersPath}\n`);
  }
  output.write("Done.\n");
}

export function restartSystemdServices(options: RestartSystemdServicesOptions): void {
  assertLinuxWithSystemd();

  const output = options.output ?? process.stdout;
  const runWithSudoFallback = options.allowSudoFallback ?? true;
  const serviceNames =
    options.instanceName === undefined
      ? resolveRuntimeSystemdServiceUnitNames()
      : resolveSystemdServiceUnitNames(options.instanceName);
  const systemctlRunner =
    hasRootPrivileges() || !runWithSudoFallback ? runSystemctl : runSystemctlWithNonInteractiveSudo;

  systemctlRunner(["restart", serviceNames.mainServiceName]);
  output.write(`Restarted service: ${serviceNames.mainServiceName}\n`);

  if (options.restartAdmin) {
    systemctlRunner(["restart", serviceNames.adminServiceName]);
    output.write(`Restarted service: ${serviceNames.adminServiceName}\n`);
  }

  output.write("Done.\n");
}

export function restartAdminSystemdService(options: RestartAdminSystemdServiceOptions = {}): void {
  assertLinuxWithSystemd();

  const output = options.output ?? process.stdout;
  const runWithSudoFallback = options.allowSudoFallback ?? true;
  const serviceNames =
    options.instanceName === undefined
      ? resolveRuntimeSystemdServiceUnitNames()
      : resolveSystemdServiceUnitNames(options.instanceName);
  const systemctlRunner =
    hasRootPrivileges() || !runWithSudoFallback ? runSystemctl : runSystemctlWithNonInteractiveSudo;

  systemctlRunner(["restart", serviceNames.adminServiceName]);
  output.write(`Restarted service: ${serviceNames.adminServiceName}\n`);
  output.write("Done.\n");
}

export function queueAdminSystemdRestart(options: QueueAdminSystemdRestartOptions = {}): void {
  assertLinuxWithSystemd();

  const output = options.output ?? process.stdout;
  const runWithSudoFallback = options.allowSudoFallback ?? true;
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 800));
  const serviceNames =
    options.instanceName === undefined
      ? resolveRuntimeSystemdServiceUnitNames()
      : resolveSystemdServiceUnitNames(options.instanceName);
  const systemctlPath = resolveSystemctlPath();
  const restartCommand =
    hasRootPrivileges() || !runWithSudoFallback
      ? `${shellEscape(systemctlPath)} restart ${shellEscape(serviceNames.adminServiceName)}`
      : `sudo -n ${shellEscape(systemctlPath)} restart ${shellEscape(serviceNames.adminServiceName)}`;
  const command = delayMs > 0 ? `sleep ${formatSleepSeconds(delayMs)}; ${restartCommand}` : restartCommand;

  try {
    const child = spawn("/bin/sh", ["-lc", command], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (error) {
    throw new Error(`Failed to queue admin service restart command: ${extractErrorMessage(error)}`, {
      cause: error,
    });
  }

  output.write(`Queued restart for service: ${serviceNames.adminServiceName}\n`);
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
  validateSimpleValue(options.mainServiceName, "mainServiceName");
  validateSimpleValue(options.adminServiceName, "adminServiceName");
  if (options.instanceName !== null) {
    validateSimpleValue(options.instanceName, "instanceName");
  }
}

function validateSimpleValue(value: string, key: string): void {
  if (!value.trim()) {
    throw new Error(`${key} cannot be empty.`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`${key} contains invalid newline characters.`);
  }
}

function resolveSystemdServiceUnitNamesFromInput(input: {
  instanceName?: string | null;
  explicitMainServiceName?: string;
  explicitAdminServiceName?: string;
}): SystemdServiceUnitNames {
  const explicitMain = input.explicitMainServiceName?.trim() ?? "";
  const explicitAdmin = input.explicitAdminServiceName?.trim() ?? "";
  if (explicitMain || explicitAdmin) {
    if (!isValidSystemdUnitName(explicitMain) || !isValidSystemdUnitName(explicitAdmin)) {
      throw new Error("mainServiceName/adminServiceName must be valid systemd unit names.");
    }
    const instanceName = normalizeInstanceNameSafe(input.instanceName);
    return {
      instanceName,
      mainServiceName: explicitMain,
      adminServiceName: explicitAdmin,
      restartSudoersFile: instanceName
        ? `${RESTART_SUDOERS_BASENAME}-${instanceName}`
        : RESTART_SUDOERS_BASENAME,
    };
  }
  return resolveSystemdServiceUnitNames(input.instanceName ?? null);
}

function normalizeInstanceName(instanceName?: string | null): string | null {
  const value = instanceName?.trim() ?? "";
  if (!value) {
    return null;
  }
  if (!INSTANCE_NAME_PATTERN.test(value)) {
    throw new Error(
      "instanceName must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (letters/numbers plus . _ -, and cannot start with punctuation).",
    );
  }
  return value;
}

function normalizeInstanceNameSafe(instanceName?: string | null): string | null {
  try {
    return normalizeInstanceName(instanceName);
  } catch {
    return null;
  }
}

function isValidSystemdUnitName(unitName: string): boolean {
  return /^[A-Za-z0-9_.@:-]+\.service$/.test(unitName);
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
  if (!hasRootPrivileges()) {
    throw new Error("Root privileges are required. Run with sudo.");
  }
}

function hasRootPrivileges(): boolean {
  if (typeof process.getuid !== "function") {
    return true;
  }
  return process.getuid() === 0;
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

function runSystemctlWithNonInteractiveSudo(args: string[]): void {
  const systemctlPath = resolveSystemctlPath();
  try {
    runCommand("sudo", ["-n", systemctlPath, ...args]);
  } catch (error) {
    const message = extractErrorMessage(error).toLowerCase();
    if (isSudoPermissionError(message)) {
      throw new Error(
        "Root privileges are required. Configure passwordless sudo for the CodeHarbor service user or run the CLI command manually with sudo.",
        { cause: error },
      );
    }
    throw new Error(`Failed to restart service via sudo: ${extractErrorMessage(error)}`, { cause: error });
  }
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

function resolveSystemctlPath(): string {
  const candidates: string[] = [];
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    candidates.push(path.join(entry, "systemctl"));
  }
  candidates.push("/usr/bin/systemctl", "/bin/systemctl", "/usr/local/bin/systemctl");

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to resolve absolute systemctl path.");
}

function isSudoPermissionError(message: string): boolean {
  return (
    message.includes("a password is required") ||
    message.includes("a terminal is required") ||
    message.includes("is not in the sudoers file") ||
    message.includes("may not run sudo") ||
    message.includes("not allowed to execute")
  );
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_/:.-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatSleepSeconds(delayMs: number): string {
  const seconds = Math.max(0, delayMs) / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(3);
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
