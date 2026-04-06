import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(__dirname, "..", "scripts", "postinstall-restart.cjs");

type FakeSystemctlMode = "all_active" | "none_active";

function createFakeCommandDir(mode: FakeSystemctlMode): { dir: string; logPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-postinstall-test-"));
  const logPath = path.join(dir, "restart.log");

  const systemctlScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'cmd="${1:-}"',
    "case \"$cmd\" in",
    "  --version)",
    '    echo "systemd 255"',
    "    exit 0",
    "    ;;&",
    "  list-unit-files)",
    '    pattern="${2:-}"',
    "    if [[ \"$pattern\" == \"codeharbor*.service\" ]]; then",
    "      cat <<'OUT'",
    "codeharbor-main-hub.service enabled enabled",
    "codeharbor-review-guard.service enabled enabled",
    "codeharbor-dev-main.service enabled enabled",
    "codeharbor-admin.service enabled enabled",
    "codeharbor-admin-review-guard.service enabled enabled",
    "codeharbor@template.service enabled enabled",
    "random.service enabled enabled",
    "OUT",
    "      exit 0",
    "    fi",
    "    if [[ \"$pattern\" == \"codeharbor.service\" ]]; then",
    "      exit 0",
    "    fi",
    "    if [[ \"$pattern\" == \"codeharbor-admin.service\" ]]; then",
    "      echo \"codeharbor-admin.service enabled enabled\"",
    "      exit 0",
    "    fi",
    "    exit 0",
    "    ;;&",
    "  is-active)",
    '    unit="${2:-}"',
    mode === "all_active"
      ? "    case \"$unit\" in codeharbor-main-hub.service|codeharbor-review-guard.service|codeharbor-dev-main.service|codeharbor-admin.service|codeharbor-admin-review-guard.service) echo \"active\"; exit 0;; *) echo \"inactive\"; exit 3;; esac"
      : '    echo "inactive"; exit 3',
    "    ;;&",
    "  restart)",
    '    unit="${2:-}"',
    '    echo "$unit" >> "${POSTINSTALL_RESTART_LOG:?}"',
    "    exit 0",
    "    ;;&",
    "  *)",
    '    echo "unsupported systemctl args: $*" >&2',
    "    exit 1",
    "    ;;&",
    "esac",
    "",
  ].join("\n");

  const sudoScript = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'if [[ "${1:-}" == "-n" ]]; then',
    "  shift",
    "fi",
    'exec "$@"',
    "",
  ].join("\n");

  const systemctlPath = path.join(dir, "systemctl");
  const sudoPath = path.join(dir, "sudo");
  fs.writeFileSync(systemctlPath, systemctlScript, "utf8");
  fs.writeFileSync(sudoPath, sudoScript, "utf8");
  fs.chmodSync(systemctlPath, 0o755);
  fs.chmodSync(sudoPath, 0o755);

  return { dir, logPath };
}

function runPostinstallWithFakeSystemctl(mode: FakeSystemctlMode): {
  status: number | null;
  stdout: string;
  stderr: string;
  restartedUnits: string[];
} {
  const fake = createFakeCommandDir(mode);
  try {
    const envPath = `${fake.dir}${path.delimiter}${process.env.PATH ?? ""}`;
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: envPath,
        CODEHARBOR_FORCE_POSTINSTALL_RESTART: "1",
        npm_config_global: "1",
        POSTINSTALL_RESTART_LOG: fake.logPath,
      },
    });

    const restartedUnits = fs.existsSync(fake.logPath)
      ? fs
          .readFileSync(fake.logPath, "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      restartedUnits,
    };
  } finally {
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }
}

describe("postinstall restart script", () => {
  it("discovers and restarts active multi-instance systemd units in stable order", () => {
    const result = runPostinstallWithFakeSystemctl("all_active");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("[codeharbor postinstall] restarted:");

    expect(result.restartedUnits).toEqual([
      "codeharbor-dev-main.service",
      "codeharbor-main-hub.service",
      "codeharbor-review-guard.service",
      "codeharbor-admin-review-guard.service",
      "codeharbor-admin.service",
    ]);
    expect(result.restartedUnits).not.toContain("codeharbor@template.service");
  });

  it("does nothing when no codeharbor unit is active", () => {
    const result = runPostinstallWithFakeSystemctl("none_active");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.restartedUnits).toEqual([]);
  });
});
