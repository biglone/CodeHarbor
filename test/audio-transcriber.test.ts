import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioTranscriber } from "../src/audio-transcriber";

async function createAudioFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-audio-transcriber-"));
  const filePath = path.join(dir, "voice.ogg");
  await fs.writeFile(filePath, "fixture", "utf8");
  return filePath;
}

async function cleanupFixture(filePath: string): Promise<void> {
  await fs.rm(path.dirname(filePath), { recursive: true, force: true });
}

describe("AudioTranscriber", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses local whisper command output when configured", async () => {
    const filePath = await createAudioFixture();
    try {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const transcriber = new AudioTranscriber({
        enabled: true,
        apiKey: null,
        model: "gpt-4o-mini-transcribe",
        timeoutMs: 120000,
        maxChars: 6000,
        maxRetries: 1,
        retryDelayMs: 10,
        localWhisperCommand: "printf 'local transcript'",
        localWhisperTimeoutMs: 180000,
      });

      const transcripts = await transcriber.transcribeMany([
        {
          name: "voice.ogg",
          mimeType: "audio/ogg",
          localPath: filePath,
        },
      ]);

      expect(transcripts).toEqual([{ name: "voice.ogg", text: "local transcript" }]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await cleanupFixture(filePath);
    }
  });

  it("falls back to OpenAI when local whisper command fails", async () => {
    const filePath = await createAudioFixture();
    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ text: "remote transcript" }),
      } as Response);
      vi.stubGlobal("fetch", fetchMock);

      const transcriber = new AudioTranscriber({
        enabled: true,
        apiKey: "test-key",
        model: "gpt-4o-mini-transcribe",
        timeoutMs: 120000,
        maxChars: 6000,
        maxRetries: 1,
        retryDelayMs: 10,
        localWhisperCommand: "false",
        localWhisperTimeoutMs: 180000,
      });

      const transcripts = await transcriber.transcribeMany([
        {
          name: "voice.ogg",
          mimeType: "audio/ogg",
          localPath: filePath,
        },
      ]);

      expect(transcripts).toEqual([{ name: "voice.ogg", text: "remote transcript" }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await cleanupFixture(filePath);
    }
  });

  it("retries transient OpenAI failures", async () => {
    const filePath = await createAudioFixture();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
          json: async () => ({ error: { message: "temporary" } }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ text: "retried transcript" }),
        } as Response);
      vi.stubGlobal("fetch", fetchMock);

      const transcriber = new AudioTranscriber({
        enabled: true,
        apiKey: "test-key",
        model: "gpt-4o-mini-transcribe",
        timeoutMs: 120000,
        maxChars: 6000,
        maxRetries: 1,
        retryDelayMs: 10,
        localWhisperCommand: null,
        localWhisperTimeoutMs: 180000,
      });

      const transcripts = await transcriber.transcribeMany([
        {
          name: "voice.ogg",
          mimeType: "audio/ogg",
          localPath: filePath,
        },
      ]);

      expect(transcripts).toEqual([{ name: "voice.ogg", text: "retried transcript" }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await cleanupFixture(filePath);
    }
  });

  it("throws when no transcription backend is configured", async () => {
    const filePath = await createAudioFixture();
    try {
      const transcriber = new AudioTranscriber({
        enabled: true,
        apiKey: null,
        model: "gpt-4o-mini-transcribe",
        timeoutMs: 120000,
        maxChars: 6000,
        maxRetries: 1,
        retryDelayMs: 10,
        localWhisperCommand: null,
        localWhisperTimeoutMs: 180000,
      });

      await expect(
        transcriber.transcribeMany([
          {
            name: "voice.ogg",
            mimeType: "audio/ogg",
            localPath: filePath,
          },
        ]),
      ).rejects.toThrow(/no backend is configured/i);
    } finally {
      await cleanupFixture(filePath);
    }
  });
});
