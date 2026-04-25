import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(__dirname, "..", "scripts", "check-doc-consistency.mjs");

function runScript(cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function createFixture(input?: {
  packageJson?: Record<string, unknown>;
  readme?: string;
  requirements?: string;
  taskList?: string;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-doc-consistency-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      input?.packageJson ?? {
        name: "codeharbor",
        version: "0.1.104",
        engines: {
          node: ">=22",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(root, "README.md"), input?.readme ?? "# Demo\n- Node.js 22+\n", "utf8");
  fs.writeFileSync(path.join(root, "REQUIREMENTS.md"), input?.requirements ?? "兼容性要求：Linux/macOS 运行；Node.js >= 22。\n", "utf8");
  fs.writeFileSync(
    path.join(root, "TASK_LIST.md"),
    input?.taskList ?? "## 大功能 -> 发布映射（执行约定，当前版本：v0.1.104）\n",
    "utf8",
  );
  return root;
}

function cleanupFixture(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("docs consistency policy script", () => {
  it("passes when package, README, REQUIREMENTS, and TASK_LIST are aligned", () => {
    const fixture = createFixture();
    try {
      const result = runScript(fixture);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Docs consistency check passed.");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fails when README Node.js prerequisite is outdated", () => {
    const fixture = createFixture({
      readme: "# Demo\n- Node.js 20+\n",
    });
    try {
      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("README Node.js prerequisite is out of sync");
      expect(result.stderr).toContain("Node.js 22+");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fails when TASK_LIST current version does not match package.json", () => {
    const fixture = createFixture({
      taskList: "## 大功能 -> 发布映射（执行约定，当前版本：v0.1.103）\n",
    });
    try {
      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("TASK_LIST current version is out of sync");
      expect(result.stderr).toContain("expected: v0.1.104");
      expect(result.stderr).toContain("actual: v0.1.103");
    } finally {
      cleanupFixture(fixture);
    }
  });
});
