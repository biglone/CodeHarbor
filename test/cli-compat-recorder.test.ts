import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CliCompatRecorder } from "../src/compat/cli-compat-recorder";

describe("CliCompatRecorder", () => {
  it("appends jsonl records in order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-compat-recorder-"));
    const file = path.join(dir, "records.jsonl");
    const recorder = new CliCompatRecorder(file);

    await recorder.append({
      timestamp: "2026-03-03T00:00:00.000Z",
      requestId: "r1",
      sessionKey: "matrix:room:user",
      conversationId: "!room:example.com",
      senderId: "@alice:example.com",
      prompt: "hello",
      imageCount: 0,
    });
    await recorder.append({
      timestamp: "2026-03-03T00:00:01.000Z",
      requestId: "r2",
      sessionKey: "matrix:room:user",
      conversationId: "!room:example.com",
      senderId: "@alice:example.com",
      prompt: "follow-up",
      imageCount: 1,
    });

    const lines = fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ requestId: "r1", prompt: "hello" });
    expect(JSON.parse(lines[1])).toMatchObject({ requestId: "r2", imageCount: 1 });
  });
});
