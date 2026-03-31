import os from "node:os";

import { describe, expect, it } from "vitest";

import {
  buildAdminServiceUnit,
  buildMainServiceUnit,
  buildRestartSudoersPolicy,
  resolveDefaultRunUser,
  resolveRuntimeHomeForUser,
  resolveSystemdServiceUnitNames,
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
      instanceName: null,
      mainServiceName: "codeharbor.service",
      adminServiceName: "codeharbor-admin.service",
    });

    expect(unit).toContain("Description=CodeHarbor main service");
    expect(unit).toContain("User=appuser");
    expect(unit).toContain("Environment=CODEHARBOR_HOME=/home/appuser/.codeharbor");
    expect(unit).toContain("Environment=CODEHARBOR_SYSTEMD_INSTANCE=default");
    expect(unit).toContain("Environment=CODEHARBOR_SYSTEMD_MAIN_UNIT=codeharbor.service");
    expect(unit).toContain("Environment=CODEHARBOR_SYSTEMD_ADMIN_UNIT=codeharbor-admin.service");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/codeharbor/dist/cli.js start");
    expect(unit).toContain("ProtectHome=false");
  });

  it("builds admin service unit with expected command", () => {
    const unit = buildAdminServiceUnit({
      runUser: "appuser",
      runtimeHome: "/home/appuser/.codeharbor",
      nodeBinPath: "/usr/bin/node",
      cliScriptPath: "/usr/lib/node_modules/codeharbor/dist/cli.js",
      instanceName: null,
      mainServiceName: "codeharbor.service",
      adminServiceName: "codeharbor-admin.service",
    });

    expect(unit).toContain("Description=CodeHarbor admin service");
    expect(unit).toContain("Environment=CODEHARBOR_SYSTEMD_INSTANCE=default");
    expect(unit).toContain("Environment=CODEHARBOR_SYSTEMD_MAIN_UNIT=codeharbor.service");
    expect(unit).toContain("Environment=CODEHARBOR_SYSTEMD_ADMIN_UNIT=codeharbor-admin.service");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/codeharbor/dist/cli.js admin serve");
    expect(unit).toContain("NoNewPrivileges=false");
    expect(unit).toContain("ProtectHome=false");
  });

  it("builds restart sudoers policy with non-interactive systemctl rules", () => {
    const policy = buildRestartSudoersPolicy({
      runUser: "appuser",
      systemctlPath: "/usr/bin/systemctl",
    });

    expect(policy).toContain("Defaults:appuser !requiretty");
    expect(policy).toContain(
      "appuser ALL=(root) NOPASSWD: /usr/bin/systemctl restart codeharbor.service, /usr/bin/systemctl restart codeharbor-admin.service",
    );
  });

  it("resolves instance service names with dedicated units", () => {
    const names = resolveSystemdServiceUnitNames("bot-a");
    expect(names.instanceName).toBe("bot-a");
    expect(names.mainServiceName).toBe("codeharbor-bot-a.service");
    expect(names.adminServiceName).toBe("codeharbor-admin-bot-a.service");
    expect(names.restartSudoersFile).toBe("codeharbor-restart-bot-a");
  });

  it("rejects invalid instance names", () => {
    expect(() => resolveSystemdServiceUnitNames("-bad")).toThrow(/instanceName/);
  });

  it("builds instance sudoers policy with instance unit names", () => {
    const policy = buildRestartSudoersPolicy({
      runUser: "appuser",
      systemctlPath: "/usr/bin/systemctl",
      mainServiceName: "codeharbor-bot-a.service",
      adminServiceName: "codeharbor-admin-bot-a.service",
    });

    expect(policy).toContain(
      "appuser ALL=(root) NOPASSWD: /usr/bin/systemctl restart codeharbor-bot-a.service, /usr/bin/systemctl restart codeharbor-admin-bot-a.service",
    );
  });
});
