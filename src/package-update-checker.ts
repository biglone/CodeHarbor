import fs from "node:fs";
import path from "node:path";

type PackageUpdateState = "up_to_date" | "update_available" | "unknown";

export interface PackageUpdateStatus {
  packageName: string;
  currentVersion: string;
  latestVersion: string | null;
  state: PackageUpdateState;
  checkedAt: string;
  error: string | null;
  upgradeCommand: string;
}

export interface PackageUpdateChecker {
  getStatus(): Promise<PackageUpdateStatus>;
}

interface NpmRegistryUpdateCheckerOptions {
  packageName?: string;
  currentVersion?: string;
  ttlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  enabled?: boolean;
}

interface NpmVersionPayload {
  version?: unknown;
}

export class NpmRegistryUpdateChecker implements PackageUpdateChecker {
  private readonly packageName: string;
  private readonly currentVersion: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly enabled: boolean;
  private readonly upgradeCommand: string;
  private cachedStatus: PackageUpdateStatus | null = null;
  private cacheExpiresAt = 0;

  constructor(options?: NpmRegistryUpdateCheckerOptions) {
    this.packageName = options?.packageName?.trim() || "codeharbor";
    this.currentVersion = options?.currentVersion?.trim() || resolvePackageVersion();
    this.ttlMs = options?.ttlMs ?? 6 * 60 * 60 * 1000;
    this.timeoutMs = options?.timeoutMs ?? 3000;
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.enabled = options?.enabled ?? process.env.NODE_ENV !== "test";
    this.upgradeCommand = `npm install -g ${this.packageName}@latest`;
  }

  async getStatus(): Promise<PackageUpdateStatus> {
    const now = Date.now();
    if (this.cachedStatus && now < this.cacheExpiresAt) {
      return this.cachedStatus;
    }

    let nextStatus: PackageUpdateStatus;
    if (!this.enabled) {
      nextStatus = this.buildStatus({
        latestVersion: null,
        state: "unknown",
        error: "update check disabled",
      });
    } else {
      nextStatus = await this.fetchLatestStatus();
    }

    this.cachedStatus = nextStatus;
    this.cacheExpiresAt = now + this.ttlMs;
    return nextStatus;
  }

  private async fetchLatestStatus(): Promise<PackageUpdateStatus> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`https://registry.npmjs.org/${this.packageName}/latest`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        return this.buildStatus({
          latestVersion: null,
          state: "unknown",
          error: `HTTP ${response.status}`,
        });
      }

      const payload = (await response.json()) as NpmVersionPayload;
      const latest = typeof payload.version === "string" ? payload.version.trim() : "";
      if (!latest) {
        return this.buildStatus({
          latestVersion: null,
          state: "unknown",
          error: "invalid npm response",
        });
      }

      const comparison = compareSemver(this.currentVersion, latest);
      if (comparison === null) {
        return this.buildStatus({
          latestVersion: latest,
          state: "unknown",
          error: "version compare unavailable",
        });
      }

      return this.buildStatus({
        latestVersion: latest,
        state: comparison < 0 ? "update_available" : "up_to_date",
        error: null,
      });
    } catch (error) {
      return this.buildStatus({
        latestVersion: null,
        state: "unknown",
        error: normalizeError(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private buildStatus(input: {
    latestVersion: string | null;
    state: PackageUpdateState;
    error: string | null;
  }): PackageUpdateStatus {
    return {
      packageName: this.packageName,
      currentVersion: this.currentVersion,
      latestVersion: input.latestVersion,
      state: input.state,
      checkedAt: new Date().toISOString(),
      error: input.error,
      upgradeCommand: this.upgradeCommand,
    };
  }
}

export function formatPackageUpdateHint(status: PackageUpdateStatus): string {
  if (status.state === "update_available" && status.latestVersion) {
    return `发现新版本 ${status.latestVersion}，建议执行：${status.upgradeCommand}`;
  }
  if (status.state === "up_to_date") {
    return `已是最新版本${status.latestVersion ? `（${status.latestVersion}）` : ""}`;
  }
  return `暂时无法检查更新${status.error ? `（${status.error}）` : ""}`;
}

export function resolvePackageVersion(packagePath?: string): string {
  const resolvedPath = packagePath ?? path.resolve(__dirname, "..", "package.json");
  try {
    const raw = fs.readFileSync(resolvedPath, "utf8");
    const payload = JSON.parse(raw) as { version?: unknown };
    if (typeof payload.version === "string" && payload.version.trim()) {
      return payload.version.trim();
    }
  } catch {
    // ignore read/parse errors
  }
  return "0.0.0";
}

export function compareSemver(current: string, latest: string): -1 | 0 | 1 | null {
  const currentParts = parseSemver(current);
  const latestParts = parseSemver(latest);
  if (!currentParts || !latestParts) {
    return null;
  }

  for (let i = 0; i < 3; i += 1) {
    if (currentParts[i] < latestParts[i]) {
      return -1;
    }
    if (currentParts[i] > latestParts[i]) {
      return 1;
    }
  }
  return 0;
}

function parseSemver(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return [major, minor, patch];
}

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}
