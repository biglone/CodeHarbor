import os from "node:os";

import { describe, expect, it } from "vitest";

import {
  buildAdminServiceUnit,
  buildMainServiceUnit,
  resolveDefaultRunUser,
  resolveRuntimeHomeForUser,
} from "../src/service-manager";

describe("service-manager defaults", () => {
  it("prefers SUDO_USER over USER", () => {
    expect(resolveDefaultRunUser({ SUDO_USER: "deploy", USER: "root" })).toBe("deploy");
  });

  it("falls back to USER when SUDO_USER is absent", () => {
    expect(resolveDefaultRunUser({ USER: "biglone" })).toBe("biglone");
  });

  it("resolves runtime home from explicit option", () => {
    expect(resolveRuntimeHomeForUser("any", {}, "/srv/codeharbor")).toBe("/srv/codeharbor");
  });

  it("resolves runtime home from CODEHARBOR_HOME env", () => {
    expect(resolveRuntimeHomeForUser("any", { CODEHARBOR_HOME: "/opt/ch" })).toBe("/opt/ch");
  });

  it("falls back to current user home when run user cannot be resolved", () => {
    const result = resolveRuntimeHomeForUser("__unlikely_user_123__", {}, undefined);
    expect(result).toBe(`${os.homedir()}/.codeharbor`);
  });
});

describe("service-manager unit templates", () => {
  it("builds main service unit with expected command", () => {
    const unit = buildMainServiceUnit({
      runUser: "appuser",
      runtimeHome: "/home/appuser/.codeharbor",
      nodeBinPath: "/usr/bin/node",
      cliScriptPath: "/usr/lib/node_modules/codeharbor/dist/cli.js",
    });

    expect(unit).toContain("Description=CodeHarbor main service");
    expect(unit).toContain("User=appuser");
    expect(unit).toContain("Environment=CODEHARBOR_HOME=/home/appuser/.codeharbor");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/codeharbor/dist/cli.js start");
    expect(unit).toContain("ProtectHome=read-only");
  });

  it("builds admin service unit with expected command", () => {
    const unit = buildAdminServiceUnit({
      runUser: "appuser",
      runtimeHome: "/home/appuser/.codeharbor",
      nodeBinPath: "/usr/bin/node",
      cliScriptPath: "/usr/lib/node_modules/codeharbor/dist/cli.js",
    });

    expect(unit).toContain("Description=CodeHarbor admin service");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/codeharbor/dist/cli.js admin serve");
    expect(unit).toContain("ProtectHome=read-only");
  });
});
