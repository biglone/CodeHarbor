import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { inferAutoDevCommitLanguage } from "../src/orchestrator/autodev-git";

const execFileAsync = promisify(execFile);

describe("inferAutoDevCommitLanguage", () => {
  it("defaults to english for fresh repos without commit history", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-git-lang-empty-"));
    try {
      expect(await inferAutoDevCommitLanguage(tempRoot)).toBe("en");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps english for a new project first commit", async () => {
    const tempRoot = await createRepoWithCommitSubjects(["feat(core): initialize project"]);
    try {
      expect(await inferAutoDevCommitLanguage(tempRoot)).toBe("en");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("follows dominant historical language for existing projects", async () => {
    const tempRoot = await createRepoWithCommitSubjects([
      "feat(core): add parser",
      "fix(core): handle edge case",
      "feat(任务): 支持自动重试",
      "fix(任务): 修复超时流程",
      "docs(文档): 更新使用说明",
    ]);
    try {
      expect(await inferAutoDevCommitLanguage(tempRoot)).toBe("zh");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function createRepoWithCommitSubjects(subjects: string[]): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-git-lang-"));
  await execFileAsync("git", ["init"], { cwd: tempRoot });
  await execFileAsync("git", ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "config", "user.name", "Test Bot"], {
    cwd: tempRoot,
  });
  await execFileAsync("git", ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "config", "user.email", "test@example.com"], {
    cwd: tempRoot,
  });

  for (let index = 0; index < subjects.length; index += 1) {
    const marker = `commit-${index + 1}.txt`;
    await fs.writeFile(path.join(tempRoot, marker), `${subjects[index] ?? ""}\n`, "utf8");
    await execFileAsync("git", ["add", marker], { cwd: tempRoot });
    await execFileAsync(
      "git",
      ["-c", "user.name=Test Bot", "-c", "user.email=test@example.com", "commit", "-m", subjects[index] ?? "chore: update"],
      { cwd: tempRoot },
    );
  }

  return tempRoot;
}
