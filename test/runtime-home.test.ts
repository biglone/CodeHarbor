import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_RUNTIME_HOME, resolveRuntimeHome } from "../src/runtime-home";

describe("resolveRuntimeHome", () => {
  it("uses default runtime home when CODEHARBOR_HOME is absent", () => {
    expect(resolveRuntimeHome({})).toBe(DEFAULT_RUNTIME_HOME);
  });

  it("resolves absolute path from CODEHARBOR_HOME", () => {
    expect(resolveRuntimeHome({ CODEHARBOR_HOME: "/srv/codeharbor" })).toBe("/srv/codeharbor");
  });

  it("resolves relative CODEHARBOR_HOME against current working directory", () => {
    const cwd = process.cwd();
    expect(resolveRuntimeHome({ CODEHARBOR_HOME: "runtime-home" })).toBe(path.resolve(cwd, "runtime-home"));
  });
});
