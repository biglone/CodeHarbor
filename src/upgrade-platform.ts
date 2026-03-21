export type UpgradePlatformFamily = "linux" | "macos" | "windows" | "other";

export interface LaunchdLabelConfig {
  main: string;
  admin: string;
}

export interface UpgradeRecoveryAdvice {
  platform: UpgradePlatformFamily;
  rollbackCommand: string;
  restartCommands: string[];
}

const DEFAULT_LAUNCHD_MAIN_LABEL = "com.codeharbor.main";
const DEFAULT_LAUNCHD_ADMIN_LABEL = "com.codeharbor.admin";
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const SAFE_LAUNCHD_LABEL_PATTERN = /^[A-Za-z0-9_.-]+$/;

export function resolveUpgradePlatform(platform: NodeJS.Platform = process.platform): UpgradePlatformFamily {
  if (platform === "linux") {
    return "linux";
  }
  if (platform === "darwin") {
    return "macos";
  }
  if (platform === "win32") {
    return "windows";
  }
  return "other";
}

export function resolveLaunchdLabelConfig(env: NodeJS.ProcessEnv = process.env): LaunchdLabelConfig {
  return {
    main: sanitizeLaunchdLabel(env.CODEHARBOR_LAUNCHD_MAIN_LABEL, DEFAULT_LAUNCHD_MAIN_LABEL),
    admin: sanitizeLaunchdLabel(env.CODEHARBOR_LAUNCHD_ADMIN_LABEL, DEFAULT_LAUNCHD_ADMIN_LABEL),
  };
}

export function buildManualRestartCommands(input: {
  platform?: NodeJS.Platform;
  includeAdminService?: boolean;
  launchdLabels?: LaunchdLabelConfig;
} = {}): string[] {
  const includeAdminService = input.includeAdminService ?? false;
  const platform = resolveUpgradePlatform(input.platform);
  if (platform === "linux") {
    return [includeAdminService ? "codeharbor service restart --with-admin" : "codeharbor service restart"];
  }
  if (platform === "macos") {
    const launchdLabels = input.launchdLabels ?? resolveLaunchdLabelConfig();
    const commands = [`launchctl kickstart -k gui/$(id -u)/${launchdLabels.main}`];
    if (includeAdminService) {
      commands.push(`launchctl kickstart -k gui/$(id -u)/${launchdLabels.admin}`);
    }
    return commands;
  }
  if (platform === "windows") {
    const commands = ['powershell -NoProfile -Command "Restart-Service -Name codeharbor"'];
    if (includeAdminService) {
      commands.push('powershell -NoProfile -Command "Restart-Service -Name codeharbor-admin"');
    }
    return commands;
  }
  return ["codeharbor start"];
}

export function resolveRollbackVersionCandidate(input: {
  previousVersion: string | null;
  targetVersion: string | null;
  installedVersion: string | null;
}): string | null {
  const previous = normalizeSemanticVersion(input.previousVersion);
  if (previous) {
    return previous;
  }
  const target = normalizeSemanticVersion(input.targetVersion);
  const installed = normalizeSemanticVersion(input.installedVersion);
  if (target && installed && target !== installed) {
    return installed;
  }
  return null;
}

export function buildRollbackCommand(version: string | null): string {
  const normalized = normalizeSemanticVersion(version);
  if (normalized) {
    return `codeharbor self-update --version ${normalized} --skip-restart`;
  }
  return "codeharbor self-update --version <previous-version> --skip-restart";
}

export function buildUpgradeRecoveryAdvice(input: {
  platform?: NodeJS.Platform;
  includeAdminService?: boolean;
  previousVersion: string | null;
  targetVersion: string | null;
  installedVersion: string | null;
  manualRestartCommands?: string[] | null;
  launchdLabels?: LaunchdLabelConfig;
}): UpgradeRecoveryAdvice {
  const platform = resolveUpgradePlatform(input.platform);
  const rollbackVersion = resolveRollbackVersionCandidate({
    previousVersion: input.previousVersion,
    targetVersion: input.targetVersion,
    installedVersion: input.installedVersion,
  });
  const restartCommands = dedupeCommands(
    (input.manualRestartCommands ?? buildManualRestartCommands(input)).map((command) => command.trim()),
  );
  return {
    platform,
    rollbackCommand: buildRollbackCommand(rollbackVersion),
    restartCommands,
  };
}

function sanitizeLaunchdLabel(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }
  if (!SAFE_LAUNCHD_LABEL_PATTERN.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function normalizeSemanticVersion(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().replace(/^v/i, "");
  if (!SEMVER_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function dedupeCommands(commands: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    if (!command || seen.has(command)) {
      continue;
    }
    seen.add(command);
    output.push(command);
  }
  return output;
}
