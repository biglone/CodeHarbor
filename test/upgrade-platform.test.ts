import { describe, expect, it } from "vitest";

import {
  buildManualRestartCommands,
  buildUpgradeRecoveryAdvice,
  resolveLaunchdLabelConfig,
  resolveRollbackVersionCandidate,
  resolveUpgradePlatform,
} from "../src/upgrade-platform";

describe("upgrade platform helpers", () => {
  it("resolves platform family from node platform values", () => {
    expect(resolveUpgradePlatform("linux")).toBe("linux");
    expect(resolveUpgradePlatform("darwin")).toBe("macos");
    expect(resolveUpgradePlatform("win32")).toBe("windows");
    expect(resolveUpgradePlatform("aix")).toBe("other");
  });

  it("builds linux restart command and rollback command from previous version", () => {
    const advice = buildUpgradeRecoveryAdvice({
      platform: "linux",
      includeAdminService: true,
      previousVersion: "0.1.52",
      targetVersion: "0.1.53",
      installedVersion: "0.1.53",
      manualRestartCommands: null,
    });

    expect(advice.rollbackCommand).toBe("codeharbor self-update --version 0.1.52 --skip-restart");
    expect(advice.restartCommands).toEqual(["codeharbor service restart --with-admin"]);
  });

  it("uses observed mismatched version when previous version is unavailable", () => {
    const candidate = resolveRollbackVersionCandidate({
      previousVersion: null,
      targetVersion: "0.1.53",
      installedVersion: "0.1.52",
    });
    expect(candidate).toBe("0.1.52");
  });

  it("builds windows manual restart commands", () => {
    const commands = buildManualRestartCommands({
      platform: "win32",
      includeAdminService: true,
    });

    expect(commands).toEqual([
      'powershell -NoProfile -Command "Restart-Service -Name codeharbor"',
      'powershell -NoProfile -Command "Restart-Service -Name codeharbor-admin"',
    ]);
  });

  it("sanitizes invalid launchd labels", () => {
    const labels = resolveLaunchdLabelConfig({
      CODEHARBOR_LAUNCHD_MAIN_LABEL: "bad label with space",
      CODEHARBOR_LAUNCHD_ADMIN_LABEL: "com.custom.admin",
    });
    expect(labels.main).toBe("com.codeharbor.main");
    expect(labels.admin).toBe("com.custom.admin");
  });
});
