import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseFileSendIntent, resolveRequestedFile } from "../src/orchestrator/file-send-intent";

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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-file-intent-"));
  tempDirs.push(directory);
  return directory;
}

describe("parseFileSendIntent", () => {
  it("extracts requested file name from Chinese command text", () => {
    const intent = parseFileSendIntent("把生成的 result.mp4 文件发送给我");
    expect(intent).toEqual({
      requestedName: "result.mp4",
    });
  });

  it("recognizes generic file send request without explicit file name", () => {
    const intent = parseFileSendIntent("把生成的文件发送给我");
    expect(intent).toEqual({
      requestedName: null,
    });
  });

  it("ignores non-delivery messages", () => {
    const intent = parseFileSendIntent("这个功能怎么实现文件发送？");
    expect(intent).toBeNull();
  });
});

describe("resolveRequestedFile", () => {
  it("resolves direct relative file path inside workdir", async () => {
    const workdir = await createTempProject();
    const target = path.join(workdir, "out", "video.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "ok");

    const result = await resolveRequestedFile({
      workdir,
      requestedName: "out/video.mp4",
    });

    expect(result.status).toBe("ok");
    expect(result.file).toMatchObject({
      relativePath: "out/video.mp4",
      sizeBytes: 2,
    });
  });

  it("picks most recent file when no name is provided", async () => {
    const workdir = await createTempProject();
    const older = path.join(workdir, "build", "old.txt");
    const latest = path.join(workdir, "build", "latest.txt");
    await fs.mkdir(path.dirname(older), { recursive: true });
    await fs.writeFile(older, "old");
    await new Promise((resolve) => setTimeout(resolve, 12));
    await fs.writeFile(latest, "latest");

    const result = await resolveRequestedFile({
      workdir,
      requestedName: null,
    });

    expect(result.status).toBe("ok");
    expect(result.file?.relativePath).toBe("build/latest.txt");
  });

  it("reports too_large when only matched file exceeds size limit", async () => {
    const workdir = await createTempProject();
    const target = path.join(workdir, "dist", "artifact.zip");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.alloc(2048));

    const result = await resolveRequestedFile({
      workdir,
      requestedName: "artifact.zip",
      maxBytes: 1024,
    });

    expect(result.status).toBe("too_large");
    expect(result.file?.relativePath).toBe("dist/artifact.zip");
    expect(result.maxBytes).toBe(1024);
  });
});
