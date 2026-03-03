import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { applyEnvOverrides, resolveInitTemplatePath } from "../src/init";

describe("applyEnvOverrides", () => {
  it("replaces existing key values while preserving comments", () => {
    const template = [
      "MATRIX_HOMESERVER=https://old.example.com",
      "# Keep comment",
      "MATRIX_USER_ID=@old:example.com",
      "MATRIX_ACCESS_TOKEN=",
      "",
    ].join("\n");

    const result = applyEnvOverrides(template, {
      MATRIX_HOMESERVER: "https://matrix.example.com",
      MATRIX_USER_ID: "@bot:example.com",
      MATRIX_ACCESS_TOKEN: "abc123",
    });

    expect(result).toContain("MATRIX_HOMESERVER=https://matrix.example.com");
    expect(result).toContain("MATRIX_USER_ID=@bot:example.com");
    expect(result).toContain("MATRIX_ACCESS_TOKEN=abc123");
    expect(result).toContain("# Keep comment");
  });

  it("quotes special values and appends unknown keys", () => {
    const template = "CODEX_BIN=codex\n";
    const result = applyEnvOverrides(template, {
      CODEX_BIN: "codex",
      MATRIX_ACCESS_TOKEN: "token #with-space",
    });

    expect(result).toContain("CODEX_BIN=codex");
    expect(result).toContain('MATRIX_ACCESS_TOKEN="token #with-space"');
  });

  it("uses packaged .env.example when cwd does not contain template", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codeharbor-init-"));

    try {
      const templatePath = resolveInitTemplatePath(cwd);
      expect(templatePath).not.toBe(path.join(cwd, ".env.example"));
      expect(fs.existsSync(templatePath)).toBe(true);
      expect(path.basename(templatePath)).toBe(".env.example");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
