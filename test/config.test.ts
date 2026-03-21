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

describe("loadConfig AI_CLI_PROVIDER", () => {
  it("uses codex by default", () => {
    const config = loadConfig(createBaseEnv());
    expect(config.aiCliProvider).toBe("codex");
  });

  it("supports claude provider", () => {
    const config = loadConfig(
      createBaseEnv({
        AI_CLI_PROVIDER: "claude",
      }),
    );
    expect(config.aiCliProvider).toBe("claude");
    expect(config.codexBin).toBe("claude");
  });
});

describe("loadConfig BACKEND_MODEL_ROUTING_RULES_JSON", () => {
  it("parses backend/model routing rules", () => {
    const config = loadConfig(
      createBaseEnv({
        BACKEND_MODEL_ROUTING_RULES_JSON: JSON.stringify([
          {
            id: "prefer-claude-autodev",
            priority: 200,
            when: {
              taskTypes: ["autodev_run"],
              directMessage: true,
            },
            target: {
              provider: "claude",
              model: "claude-sonnet-4-5",
            },
          },
          {
            when: {
              textIncludes: ["fast"],
            },
            target: {
              model: "gpt-5-mini",
            },
          },
        ]),
      }),
    );

    expect(config.backendModelRoutingRules).toHaveLength(2);
    expect(config.backendModelRoutingRules[0]).toMatchObject({
      id: "prefer-claude-autodev",
      enabled: true,
      priority: 200,
      when: {
        taskTypes: ["autodev_run"],
        directMessage: true,
      },
      target: {
        provider: "claude",
        model: "claude-sonnet-4-5",
      },
    });
    expect(config.backendModelRoutingRules[1]).toMatchObject({
      id: "rule-2",
      enabled: true,
      priority: 0,
      when: {
        textIncludes: ["fast"],
      },
      target: {
        model: "gpt-5-mini",
      },
    });
  });

  it("rejects invalid routing rule payload", () => {
    expect(() =>
      loadConfig(
        createBaseEnv({
          BACKEND_MODEL_ROUTING_RULES_JSON: JSON.stringify([
            {
              id: "bad-task-type",
              when: {
                taskTypes: ["unknown_task_type"],
              },
              target: {
                provider: "codex",
              },
            },
          ]),
        }),
      ),
    ).toThrow(/unsupported task type/i);

    expect(() =>
      loadConfig(
        createBaseEnv({
          BACKEND_MODEL_ROUTING_RULES_JSON: JSON.stringify([
            {
              id: "missing-target",
              when: {
                textIncludes: ["x"],
              },
              target: {},
            },
          ]),
        }),
      ),
    ).toThrow(/must include provider and\/or model override/i);
  });
});

describe("loadConfig CONTEXT_BRIDGE settings", () => {
  it("uses default bridge limits", () => {
    const config = loadConfig(createBaseEnv());
    expect(config.contextBridgeHistoryLimit).toBe(16);
    expect(config.contextBridgeMaxChars).toBe(8000);
  });

  it("parses custom bridge limits", () => {
    const config = loadConfig(
      createBaseEnv({
        CONTEXT_BRIDGE_HISTORY_LIMIT: "24",
        CONTEXT_BRIDGE_MAX_CHARS: "12000",
      }),
    );
    expect(config.contextBridgeHistoryLimit).toBe(24);
    expect(config.contextBridgeMaxChars).toBe(12000);
  });

  it("rejects invalid bridge limits", () => {
    expect(() =>
      loadConfig(
        createBaseEnv({
          CONTEXT_BRIDGE_HISTORY_LIMIT: "0",
        }),
      ),
    ).toThrow(/CONTEXT_BRIDGE_HISTORY_LIMIT/i);

    expect(() =>
      loadConfig(
        createBaseEnv({
          CONTEXT_BRIDGE_MAX_CHARS: "120",
        }),
      ),
    ).toThrow(/CONTEXT_BRIDGE_MAX_CHARS/i);
  });
});

describe("loadConfig CLI_COMPAT_TRANSCRIBE_AUDIO", () => {
  it("uses safe defaults", () => {
    const config = loadConfig(createBaseEnv());

    expect(config.cliCompat.imageMaxBytes).toBe(10485760);
    expect(config.cliCompat.imageMaxCount).toBe(4);
    expect(config.cliCompat.imageAllowedMimeTypes).toEqual(["image/png", "image/jpeg", "image/webp", "image/gif"]);
    expect(config.cliCompat.transcribeAudio).toBe(false);
    expect(config.cliCompat.audioTranscribeModel).toBe("gpt-4o-mini-transcribe");
    expect(config.cliCompat.audioTranscribeTimeoutMs).toBe(120000);
    expect(config.cliCompat.audioTranscribeMaxChars).toBe(6000);
    expect(config.cliCompat.audioTranscribeMaxRetries).toBe(1);
    expect(config.cliCompat.audioTranscribeRetryDelayMs).toBe(800);
    expect(config.cliCompat.audioTranscribeMaxBytes).toBe(26214400);
    expect(config.cliCompat.audioLocalWhisperCommand).toBeNull();
    expect(config.cliCompat.audioLocalWhisperTimeoutMs).toBe(180000);
  });

  it("parses custom transcription settings", () => {
    const config = loadConfig(
      createBaseEnv({
        CLI_COMPAT_IMAGE_MAX_BYTES: "7340032",
        CLI_COMPAT_IMAGE_MAX_COUNT: "2",
        CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES: "image/png, image/jpeg,image/png, image/webp",
        CLI_COMPAT_TRANSCRIBE_AUDIO: "true",
        CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL: "gpt-4o-transcribe",
        CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS: "45000",
        CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS: "3200",
        CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES: "3",
        CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS: "1200",
        CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES: "1234567",
        CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND: "python3 /opt/whisper/transcribe.py --input {input}",
        CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS: "90000",
      }),
    );

    expect(config.cliCompat.imageMaxBytes).toBe(7340032);
    expect(config.cliCompat.imageMaxCount).toBe(2);
    expect(config.cliCompat.imageAllowedMimeTypes).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(config.cliCompat.transcribeAudio).toBe(true);
    expect(config.cliCompat.audioTranscribeModel).toBe("gpt-4o-transcribe");
    expect(config.cliCompat.audioTranscribeTimeoutMs).toBe(45000);
    expect(config.cliCompat.audioTranscribeMaxChars).toBe(3200);
    expect(config.cliCompat.audioTranscribeMaxRetries).toBe(3);
    expect(config.cliCompat.audioTranscribeRetryDelayMs).toBe(1200);
    expect(config.cliCompat.audioTranscribeMaxBytes).toBe(1234567);
    expect(config.cliCompat.audioLocalWhisperCommand).toBe(
      "python3 /opt/whisper/transcribe.py --input {input}",
    );
    expect(config.cliCompat.audioLocalWhisperTimeoutMs).toBe(90000);
  });
});

describe("loadConfig PACKAGE_UPDATE_CHECK", () => {
  it("uses default update-check settings", () => {
    const config = loadConfig(createBaseEnv());

    expect(config.updateCheck.enabled).toBe(true);
    expect(config.updateCheck.timeoutMs).toBe(3000);
    expect(config.updateCheck.ttlMs).toBe(21600000);
  });

  it("parses custom update-check settings", () => {
    const config = loadConfig(
      createBaseEnv({
        PACKAGE_UPDATE_CHECK_ENABLED: "false",
        PACKAGE_UPDATE_CHECK_TIMEOUT_MS: "1500",
        PACKAGE_UPDATE_CHECK_TTL_MS: "600000",
      }),
    );

    expect(config.updateCheck.enabled).toBe(false);
    expect(config.updateCheck.timeoutMs).toBe(1500);
    expect(config.updateCheck.ttlMs).toBe(600000);
  });
});

describe("loadConfig MATRIX upgrade permissions", () => {
  it("parses matrix admin and upgrade allowlist users", () => {
    const config = loadConfig(
      createBaseEnv({
        MATRIX_ADMIN_USERS: "@ops:example.com,@admin:example.com",
        MATRIX_UPGRADE_ALLOWED_USERS: "@upgrade:example.com",
      }),
    );

    expect(config.matrixAdminUsers).toEqual(["@ops:example.com", "@admin:example.com"]);
    expect(config.matrixUpgradeAllowedUsers).toEqual(["@upgrade:example.com"]);
  });
});

describe("loadConfig API task server", () => {
  it("uses disabled API defaults", () => {
    const config = loadConfig(createBaseEnv());
    expect(config.apiEnabled).toBe(false);
    expect(config.apiBindHost).toBe("127.0.0.1");
    expect(config.apiPort).toBe(8788);
    expect(config.apiToken).toBeNull();
    expect(config.apiWebhookSecret).toBeNull();
    expect(config.apiWebhookTimestampToleranceSeconds).toBe(300);
  });

  it("requires API_TOKEN when API_ENABLED=true", () => {
    expect(() =>
      loadConfig(
        createBaseEnv({
          API_ENABLED: "true",
        }),
      ),
    ).toThrow(/API_TOKEN is required/i);
  });

  it("parses webhook settings when provided", () => {
    const config = loadConfig(
      createBaseEnv({
        API_ENABLED: "true",
        API_TOKEN: "secret-token",
        API_WEBHOOK_SECRET: "whsec_test_123",
        API_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: "900",
      }),
    );

    expect(config.apiWebhookSecret).toBe("whsec_test_123");
    expect(config.apiWebhookTimestampToleranceSeconds).toBe(900);
  });

  it("rejects invalid webhook tolerance", () => {
    expect(() =>
      loadConfig(
        createBaseEnv({
          API_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: "-10",
        }),
      ),
    ).toThrow(/API_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS/i);
  });
});
