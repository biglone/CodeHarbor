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
