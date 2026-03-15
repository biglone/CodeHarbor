import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config";

function createBaseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-config-"));
  const workdir = path.join(dir, "workdir");
  fs.mkdirSync(workdir, { recursive: true });

  return {
    MATRIX_HOMESERVER: "https://matrix.example.com",
    MATRIX_USER_ID: "@bot:example.com",
    MATRIX_ACCESS_TOKEN: "token",
    CODEX_WORKDIR: workdir,
    STATE_DB_PATH: path.join(dir, "state.db"),
    STATE_PATH: path.join(dir, "state.json"),
    LOG_LEVEL: "info",
    ...overrides,
  };
}

describe("loadConfig ADMIN_TOKENS_JSON", () => {
  it("parses valid scoped token config", () => {
    const config = loadConfig(
      createBaseEnv({
        ADMIN_TOKENS_JSON: JSON.stringify([
          { token: "viewer-secret", role: "viewer", actor: "ops-view" },
          { token: "admin-secret" },
        ]),
      }),
    );

    expect(config.adminTokens).toEqual([
      { token: "viewer-secret", role: "viewer", actor: "ops-view" },
      { token: "admin-secret", role: "admin", actor: null },
    ]);
  });

  it("rejects invalid JSON payload", () => {
    expect(() =>
      loadConfig(
        createBaseEnv({
          ADMIN_TOKENS_JSON: "{bad-json",
        }),
      ),
    ).toThrow(/ADMIN_TOKENS_JSON/);
  });

  it("rejects duplicate tokens", () => {
    expect(() =>
      loadConfig(
        createBaseEnv({
          ADMIN_TOKENS_JSON: JSON.stringify([
            { token: "dup-secret", role: "viewer" },
            { token: "dup-secret", role: "admin" },
          ]),
        }),
      ),
    ).toThrow(/duplicated token/i);
  });

  it("rejects invalid role and empty token", () => {
    expect(() =>
      loadConfig(
        createBaseEnv({
          ADMIN_TOKENS_JSON: JSON.stringify([{ token: "", role: "admin" }]),
        }),
      ),
    ).toThrow(/non-empty string/i);

    expect(() =>
      loadConfig(
        createBaseEnv({
          ADMIN_TOKENS_JSON: JSON.stringify([{ token: "x", role: "owner" }]),
        }),
      ),
    ).toThrow(/"admin" or "viewer"/);
  });
});

describe("loadConfig CODEX_EXTRA_ARGS", () => {
  it("parses quoted arguments and escaped spaces", () => {
    const config = loadConfig(
      createBaseEnv({
        CODEX_EXTRA_ARGS: '--sandbox workspace-write --note "hello world" --tag \'alpha beta\' --path a\\ b',
      }),
    );

    expect(config.codexExtraArgs).toEqual([
      "--sandbox",
      "workspace-write",
      "--note",
      "hello world",
      "--tag",
      "alpha beta",
      "--path",
      "a b",
    ]);
  });

  it("rejects unmatched quote in CODEX_EXTRA_ARGS", () => {
    expect(() =>
      loadConfig(
        createBaseEnv({
          CODEX_EXTRA_ARGS: '--note "broken',
        }),
      ),
    ).toThrow(/CODEX_EXTRA_ARGS/i);
  });
});

describe("loadConfig CLI_COMPAT_TRANSCRIBE_AUDIO", () => {
  it("uses safe defaults", () => {
    const config = loadConfig(createBaseEnv());

    expect(config.cliCompat.transcribeAudio).toBe(false);
    expect(config.cliCompat.audioTranscribeModel).toBe("gpt-4o-mini-transcribe");
    expect(config.cliCompat.audioTranscribeTimeoutMs).toBe(120000);
    expect(config.cliCompat.audioTranscribeMaxChars).toBe(6000);
    expect(config.cliCompat.audioLocalWhisperCommand).toBeNull();
    expect(config.cliCompat.audioLocalWhisperTimeoutMs).toBe(180000);
  });

  it("parses custom transcription settings", () => {
    const config = loadConfig(
      createBaseEnv({
        CLI_COMPAT_TRANSCRIBE_AUDIO: "true",
        CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL: "gpt-4o-transcribe",
        CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS: "45000",
        CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS: "3200",
        CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND: "python3 /opt/whisper/transcribe.py --input {input}",
        CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS: "90000",
      }),
    );

    expect(config.cliCompat.transcribeAudio).toBe(true);
    expect(config.cliCompat.audioTranscribeModel).toBe("gpt-4o-transcribe");
    expect(config.cliCompat.audioTranscribeTimeoutMs).toBe(45000);
    expect(config.cliCompat.audioTranscribeMaxChars).toBe(3200);
    expect(config.cliCompat.audioLocalWhisperCommand).toBe(
      "python3 /opt/whisper/transcribe.py --input {input}",
    );
    expect(config.cliCompat.audioLocalWhisperTimeoutMs).toBe(90000);
  });
});
