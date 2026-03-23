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
    const fetchImpl = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/latest")) {
        return new Response(JSON.stringify({ version: "0.1.25" }), { status: 200 });
      }
      return new Response(JSON.stringify({ latest: "0.1.25" }), { status: 200 });
    });
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
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]).toMatchObject({
        cache: "no-store",
      });
    }
  });

  it("uses cached result inside ttl window", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/latest")) {
        return new Response(JSON.stringify({ version: "0.1.24" }), { status: 200 });
      }
      return new Response(JSON.stringify({ latest: "0.1.24" }), { status: 200 });
    });
    const checker = new NpmRegistryUpdateChecker({
      packageName: "codeharbor",
      currentVersion: "0.1.24",
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ttlMs: 60_000,
    });

    const first = await checker.getStatus();
    const second = await checker.getStatus();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });

  it("bypasses cache when forceRefresh is true", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const latestVersion = url.includes("cache_bust") && fetchImpl.mock.calls.length > 2 ? "0.1.25" : "0.1.24";
      if (url.includes("/latest")) {
        return new Response(JSON.stringify({ version: latestVersion }), { status: 200 });
      }
      return new Response(JSON.stringify({ latest: latestVersion }), { status: 200 });
    });
    const checker = new NpmRegistryUpdateChecker({
      packageName: "codeharbor",
      currentVersion: "0.1.24",
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ttlMs: 60_000,
    });

    const first = await checker.getStatus();
    const second = await checker.getStatus({ forceRefresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(first.latestVersion).toBe("0.1.24");
    expect(second.latestVersion).toBe("0.1.25");
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

  it("prefers the higher version between latest and dist-tags responses", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/latest")) {
        return new Response(JSON.stringify({ version: "0.1.29" }), { status: 200 });
      }
      return new Response(JSON.stringify({ latest: "0.1.30" }), { status: 200 });
    });
    const checker = new NpmRegistryUpdateChecker({
      packageName: "codeharbor",
      currentVersion: "0.1.28",
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ttlMs: 60_000,
    });

    const status = await checker.getStatus({ forceRefresh: true });
    expect(status.latestVersion).toBe("0.1.30");
    expect(status.state).toBe("update_available");
  });

  it("falls back to dist-tags when latest endpoint is stale or unavailable", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/latest")) {
        return new Response("bad gateway", { status: 502 });
      }
      return new Response(JSON.stringify({ latest: "0.1.30" }), { status: 200 });
    });
    const checker = new NpmRegistryUpdateChecker({
      packageName: "codeharbor",
      currentVersion: "0.1.29",
      enabled: true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ttlMs: 60_000,
    });

    const status = await checker.getStatus({ forceRefresh: true });
    expect(status.latestVersion).toBe("0.1.30");
    expect(status.state).toBe("update_available");
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

  it("formats english hint when output language is en", () => {
    expect(
      formatPackageUpdateHint(
        {
          ...base,
          state: "up_to_date",
          latestVersion: "0.1.24",
          error: null,
        },
        "en",
      ),
    ).toContain("already up to date");
  });
});
