import fs from "node:fs";
import path from "node:path";

import type { OutputLanguage } from "./config";

type PackageUpdateState = "up_to_date" | "update_available" | "unknown";

export interface PackageUpdateQuery {
  forceRefresh?: boolean;
}

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
  getStatus(query?: PackageUpdateQuery): Promise<PackageUpdateStatus>;
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

interface NpmDistTagsPayload {
  latest?: unknown;
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

  async getStatus(query?: PackageUpdateQuery): Promise<PackageUpdateStatus> {
    const forceRefresh = query?.forceRefresh === true;
    const now = Date.now();
    if (!forceRefresh && this.cachedStatus && now < this.cacheExpiresAt) {
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
      const resolved = await this.resolveLatestVersion(controller.signal);
      if (!resolved.latestVersion) {
        return this.buildStatus({
          latestVersion: null,
          state: "unknown",
          error: resolved.error ?? "invalid npm response",
        });
      }

      const comparison = compareSemver(this.currentVersion, resolved.latestVersion);
      if (comparison === null) {
        return this.buildStatus({
          latestVersion: resolved.latestVersion,
          state: "unknown",
          error: "version compare unavailable",
        });
      }

      return this.buildStatus({
        latestVersion: resolved.latestVersion,
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

  private async resolveLatestVersion(signal: AbortSignal): Promise<{ latestVersion: string | null; error: string | null }> {
    const cacheBust = Date.now().toString(36);
    const latestResponse = await this.fetchVersionFromEndpoint(
      `https://registry.npmjs.org/${this.packageName}/latest?cache_bust=${cacheBust}`,
      signal,
      (payload) => {
        const body = payload as NpmVersionPayload;
        return typeof body.version === "string" ? body.version : null;
      },
    );
    const distTagResponse = await this.fetchVersionFromEndpoint(
      `https://registry.npmjs.org/-/package/${this.packageName}/dist-tags?cache_bust=${cacheBust}`,
      signal,
      (payload) => {
        const body = payload as NpmDistTagsPayload;
        return typeof body.latest === "string" ? body.latest : null;
      },
    );

    const candidates = [latestResponse.version, distTagResponse.version].filter((value): value is string => Boolean(value));
    const latestVersion = pickHighestSemver(candidates);
    if (latestVersion) {
      return { latestVersion, error: null };
    }
    if (candidates.length > 0) {
      return { latestVersion: candidates[0], error: null };
    }

    const errors = [latestResponse.error, distTagResponse.error].filter((value): value is string => Boolean(value));
    return {
      latestVersion: null,
      error: errors.length > 0 ? errors.join("; ") : "invalid npm response",
    };
  }

  private async fetchVersionFromEndpoint(
    url: string,
    signal: AbortSignal,
    extractVersion: (payload: unknown) => string | null,
  ): Promise<{ version: string | null; error: string | null }> {
    try {
      const response = await this.fetchImpl(url, {
        signal,
        cache: "no-store",
        headers: {
          accept: "application/json",
          "cache-control": "no-cache",
          pragma: "no-cache",
        },
      });
      if (!response.ok) {
        return { version: null, error: `HTTP ${response.status}` };
      }

      const payload = await response.json();
      const version = extractVersion(payload)?.trim() ?? "";
      if (!version) {
        return { version: null, error: "invalid npm response" };
      }
      return { version, error: null };
    } catch (error) {
      return { version: null, error: normalizeError(error) };
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

export function formatPackageUpdateHint(status: PackageUpdateStatus, outputLanguage: OutputLanguage = "zh"): string {
  const isEnglish = outputLanguage === "en";
  if (status.state === "update_available" && status.latestVersion) {
    return isEnglish
      ? `new version ${status.latestVersion} is available; recommended command: ${status.upgradeCommand}`
      : `发现新版本 ${status.latestVersion}，建议执行：${status.upgradeCommand}`;
  }
  if (status.state === "up_to_date") {
    return isEnglish
      ? `already up to date${status.latestVersion ? ` (${status.latestVersion})` : ""}`
      : `已是最新版本${status.latestVersion ? `（${status.latestVersion}）` : ""}`;
  }
  return isEnglish
    ? `unable to check updates currently${status.error ? ` (${status.error})` : ""}`
    : `暂时无法检查更新${status.error ? `（${status.error}）` : ""}`;
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

function pickHighestSemver(versions: string[]): string | null {
  const semverVersions = versions.filter((version) => parseSemver(version) !== null);
  if (semverVersions.length === 0) {
    return null;
  }
  let selected = semverVersions[0];
  for (let i = 1; i < semverVersions.length; i += 1) {
    const version = semverVersions[i];
    const comparison = compareSemver(selected, version);
    if (comparison !== null && comparison < 0) {
      selected = version;
    }
  }
  return selected;
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
