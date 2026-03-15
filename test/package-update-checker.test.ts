import { describe, expect, it, vi } from "vitest";

import {
  compareSemver,
  formatPackageUpdateHint,
  NpmRegistryUpdateChecker,
  type PackageUpdateStatus,
} from "../src/package-update-checker";

describe("compareSemver", () => {
  it("detects newer latest version", () => {
    expect(compareSemver("0.1.24", "0.1.25")).toBe(-1);
    expect(compareSemver("0.1.25", "0.1.24")).toBe(1);
    expect(compareSemver("0.1.25", "0.1.25")).toBe(0);
  });

  it("supports prefixed and prerelease versions", () => {
    expect(compareSemver("v0.1.24", "0.1.25-beta.1")).toBe(-1);
  });

  it("returns null for invalid version string", () => {
    expect(compareSemver("main", "0.1.25")).toBeNull();
  });
});

describe("NpmRegistryUpdateChecker", () => {
  it("returns update_available when npm latest is newer", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: "0.1.25" }), { status: 200 }));
    const checker = new NpmRegistryUpdateChecker({
      packageName: "codeharbor",
      currentVersion: "0.1.24",
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ttlMs: 60_000,
    });

    const status = await checker.getStatus();
    expect(status.state).toBe("update_available");
    expect(status.latestVersion).toBe("0.1.25");
    expect(status.currentVersion).toBe("0.1.24");
    expect(status.upgradeCommand).toBe("npm install -g codeharbor@latest");
  });

  it("uses cached result inside ttl window", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: "0.1.24" }), { status: 200 }));
    const checker = new NpmRegistryUpdateChecker({
      packageName: "codeharbor",
      currentVersion: "0.1.24",
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ttlMs: 60_000,
    });

    const first = await checker.getStatus();
    const second = await checker.getStatus();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("returns unknown status when fetch fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const checker = new NpmRegistryUpdateChecker({
      packageName: "codeharbor",
      currentVersion: "0.1.24",
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ttlMs: 60_000,
    });

    const status = await checker.getStatus();
    expect(status.state).toBe("unknown");
    expect(status.error).toContain("network down");
  });
});

describe("formatPackageUpdateHint", () => {
  const base: Omit<PackageUpdateStatus, "state" | "latestVersion" | "error"> = {
    packageName: "codeharbor",
    currentVersion: "0.1.24",
    checkedAt: "2026-03-15T00:00:00.000Z",
    upgradeCommand: "npm install -g codeharbor@latest",
  };

  it("formats update available hint", () => {
    expect(
      formatPackageUpdateHint({
        ...base,
        state: "update_available",
        latestVersion: "0.1.25",
        error: null,
      }),
    ).toContain("发现新版本 0.1.25");
  });

  it("formats up to date hint", () => {
    expect(
      formatPackageUpdateHint({
        ...base,
        state: "up_to_date",
        latestVersion: "0.1.24",
        error: null,
      }),
    ).toContain("已是最新版本");
  });

  it("formats unknown hint", () => {
    expect(
      formatPackageUpdateHint({
        ...base,
        state: "unknown",
        latestVersion: null,
        error: "network down",
      }),
    ).toContain("暂时无法检查更新");
  });
});
