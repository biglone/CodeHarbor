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
      requestedKind: "video",
    });
  });

  it("recognizes generic file send request without explicit file name", () => {
    const intent = parseFileSendIntent("把生成的文件发送给我");
    expect(intent).toEqual({
      requestedName: null,
      requestedKind: "file",
    });
  });

  it("ignores non-delivery messages", () => {
    const intent = parseFileSendIntent("这个功能怎么实现文件发送？");
    expect(intent).toBeNull();
  });

  it("treats '生成好的视频' as generic media request instead of file name token", () => {
    const intent = parseFileSendIntent("把生成好的视频直接发给我");
    expect(intent).toEqual({
      requestedName: null,
      requestedKind: "video",
    });
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

  it("prefers latest video when request asks for video without explicit file name", async () => {
    const workdir = await createTempProject();
    const video = path.join(workdir, "out", "lesson-5.mp4");
    const log = path.join(workdir, "logs", "latest.log");
    await fs.mkdir(path.dirname(video), { recursive: true });
    await fs.mkdir(path.dirname(log), { recursive: true });
    await fs.writeFile(video, "video");
    await new Promise((resolve) => setTimeout(resolve, 12));
    await fs.writeFile(log, "log");

    const result = await resolveRequestedFile({
      workdir,
      requestedName: null,
      requestedKind: "video",
    });

    expect(result.status).toBe("ok");
    expect(result.file?.relativePath).toBe("out/lesson-5.mp4");
  });
});
