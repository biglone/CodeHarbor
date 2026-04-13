import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildArtifactBatchFromSnapshots,
  captureWorkspaceArtifactSnapshot,
  listRecentSessionArtifactBatches,
  recordSessionArtifactBatch,
} from "../src/orchestrator/session-artifact-registry";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }),
  );
  tempDirs.length = 0;
});

async function createTempProject(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-artifact-registry-"));
  tempDirs.push(directory);
  return directory;
}

describe("session artifact registry", () => {
  it("captures changed files as a recent artifact batch", async () => {
    const workdir = await createTempProject();
    const registry = new Map();
    const before = await captureWorkspaceArtifactSnapshot(workdir);
    const files = [
      path.join(workdir, "video", "episode-7.mp4"),
      path.join(workdir, "video", "episode-8.mp4"),
    ];
    await fs.mkdir(path.dirname(files[0]!), { recursive: true });
    for (const file of files) {
      await fs.writeFile(file, path.basename(file));
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    const after = await captureWorkspaceArtifactSnapshot(workdir);

    const batch = buildArtifactBatchFromSnapshots({
      requestId: "req-1",
      workdir,
      before,
      after,
      replyText: "已生成 `video/episode-7.mp4` 和 `video/episode-8.mp4`",
    });
    recordSessionArtifactBatch(registry, "session-1", batch);

    const batches = listRecentSessionArtifactBatches(registry, "session-1", workdir);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.files.map((file) => file.relativePath)).toEqual([
      "video/episode-8.mp4",
      "video/episode-7.mp4",
    ]);
  });
});
