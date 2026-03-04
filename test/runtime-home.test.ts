import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RUNTIME_HOME, LEGACY_RUNTIME_HOME, resolveRuntimeHome, resolveUserRuntimeHome } from "../src/runtime-home";

describe("resolveRuntimeHome", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses default runtime home when CODEHARBOR_HOME is absent", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(resolveRuntimeHome({})).toBe(DEFAULT_RUNTIME_HOME);
  });

  it("resolves absolute path from CODEHARBOR_HOME", () => {
    expect(resolveRuntimeHome({ CODEHARBOR_HOME: "/srv/codeharbor" })).toBe("/srv/codeharbor");
  });

  it("resolves relative CODEHARBOR_HOME against current working directory", () => {
    const cwd = process.cwd();
    expect(resolveRuntimeHome({ CODEHARBOR_HOME: "runtime-home" })).toBe(path.resolve(cwd, "runtime-home"));
  });

  it("keeps legacy /opt runtime home when legacy .env exists", () => {
    vi.spyOn(fs, "existsSync").mockImplementation((filePath) => filePath === "/opt/codeharbor/.env");
    expect(resolveRuntimeHome({})).toBe(LEGACY_RUNTIME_HOME);
  });
});

describe("resolveUserRuntimeHome", () => {
  it("resolves from HOME env when provided", () => {
    expect(resolveUserRuntimeHome({ HOME: "/tmp/demo-user" })).toBe("/tmp/demo-user/.codeharbor");
  });

  it("falls back to os.homedir when HOME is absent", () => {
    expect(resolveUserRuntimeHome({})).toBe(path.resolve(os.homedir(), ".codeharbor"));
  });
});
