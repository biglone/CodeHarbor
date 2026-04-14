import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(__dirname, "..", "scripts", "check-release-notes-index.mjs");

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

function createFixture(
  readme: string,
  releaseFiles: string[] = [
    "v0.1.1-release-notes.md",
    "v0.1.1-announcement-bilingual.md",
    "v0.1.2-release-notes.md",
    "v0.1.2-announcement-bilingual.md",
  ],
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-release-index-check-"));
  const releasesDir = path.join(root, "docs", "releases");
  fs.mkdirSync(releasesDir, { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), readme, "utf8");
  for (const fileName of releaseFiles) {
    fs.writeFileSync(path.join(releasesDir, fileName), `# ${fileName}\n`, "utf8");
  }
  return root;
}

function cleanupFixture(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("release notes index policy script", () => {
  it("passes when release index and latest links are in sync", () => {
    const fixture = createFixture(`
# Demo
- Latest release notes: [docs/releases/v0.1.2-release-notes.md](docs/releases/v0.1.2-release-notes.md)
- Latest bilingual announcement: [docs/releases/v0.1.2-announcement-bilingual.md](docs/releases/v0.1.2-announcement-bilingual.md)

## Release Notes Index
- v0.1.2 notes: [docs/releases/v0.1.2-release-notes.md](docs/releases/v0.1.2-release-notes.md)
- v0.1.2 announcement: [docs/releases/v0.1.2-announcement-bilingual.md](docs/releases/v0.1.2-announcement-bilingual.md)
- v0.1.1 notes: [docs/releases/v0.1.1-release-notes.md](docs/releases/v0.1.1-release-notes.md)
- v0.1.1 announcement: [docs/releases/v0.1.1-announcement-bilingual.md](docs/releases/v0.1.1-announcement-bilingual.md)

## Next Section
`);
    try {
      const result = runScript(fixture);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Release notes index check passed.");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fails when README misses the Release Notes Index section", () => {
    const fixture = createFixture(`
# Demo
- Latest release notes: [docs/releases/v0.1.2-release-notes.md](docs/releases/v0.1.2-release-notes.md)
- Latest bilingual announcement: [docs/releases/v0.1.2-announcement-bilingual.md](docs/releases/v0.1.2-announcement-bilingual.md)
`);
    try {
      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('missing section heading "## Release Notes Index"');
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fails when a release doc link is missing from the index", () => {
    const fixture = createFixture(`
# Demo
- Latest release notes: [docs/releases/v0.1.2-release-notes.md](docs/releases/v0.1.2-release-notes.md)
- Latest bilingual announcement: [docs/releases/v0.1.2-announcement-bilingual.md](docs/releases/v0.1.2-announcement-bilingual.md)

## Release Notes Index
- v0.1.2 notes: [docs/releases/v0.1.2-release-notes.md](docs/releases/v0.1.2-release-notes.md)
- v0.1.2 announcement: [docs/releases/v0.1.2-announcement-bilingual.md](docs/releases/v0.1.2-announcement-bilingual.md)
- v0.1.1 notes: [docs/releases/v0.1.1-release-notes.md](docs/releases/v0.1.1-release-notes.md)

## Next Section
`);
    try {
      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing release notes index path in README");
      expect(result.stderr).toContain("docs/releases/v0.1.1-announcement-bilingual.md");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("fails when latest links are not updated to the highest version", () => {
    const fixture = createFixture(`
# Demo
- Latest release notes: [docs/releases/v0.1.1-release-notes.md](docs/releases/v0.1.1-release-notes.md)
- Latest bilingual announcement: [docs/releases/v0.1.1-announcement-bilingual.md](docs/releases/v0.1.1-announcement-bilingual.md)

## Release Notes Index
- v0.1.2 notes: [docs/releases/v0.1.2-release-notes.md](docs/releases/v0.1.2-release-notes.md)
- v0.1.2 announcement: [docs/releases/v0.1.2-announcement-bilingual.md](docs/releases/v0.1.2-announcement-bilingual.md)
- v0.1.1 notes: [docs/releases/v0.1.1-release-notes.md](docs/releases/v0.1.1-release-notes.md)
- v0.1.1 announcement: [docs/releases/v0.1.1-announcement-bilingual.md](docs/releases/v0.1.1-announcement-bilingual.md)

## Next Section
`);
    try {
      const result = runScript(fixture);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("latest release notes link is outdated");
      expect(result.stderr).toContain("expected: docs/releases/v0.1.2-release-notes.md");
      expect(result.stderr).toContain("actual: docs/releases/v0.1.1-release-notes.md");
    } finally {
      cleanupFixture(fixture);
    }
  });
});
