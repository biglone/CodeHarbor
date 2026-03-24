import { describe, expect, it } from "vitest";

import {
  classifyBackendTaskType,
  isSameBackendProfile,
  normalizeBackendProfile,
  parseBackendTarget,
  parseControlCommand,
  parseDiagTarget,
  parseUpgradeTarget,
  serializeBackendTarget,
} from "../src/orchestrator/command-routing";

describe("orchestrator command routing helpers", () => {
  it("parses control commands with slash and text aliases", () => {
    expect(parseControlCommand("/status")).toBe("status");
    expect(parseControlCommand("//status")).toBe("status");
    expect(parseControlCommand("help")).toBe("help");
    expect(parseControlCommand("/esc")).toBe("stop");
    expect(parseControlCommand("/cancel")).toBe("stop");
    expect(parseControlCommand("/撤回")).toBe("stop");
    expect(parseControlCommand("撤销")).toBe("stop");
    expect(parseControlCommand("升级 latest")).toBe("upgrade");
    expect(parseControlCommand("/upgrade 0.1.50")).toBe("upgrade");
    expect(parseControlCommand("/unknown")).toBeNull();
  });

  it("parses diag target and bounds limits", () => {
    expect(parseDiagTarget("/diag")).toEqual({ kind: "help" });
    expect(parseDiagTarget("/diag version")).toEqual({ kind: "version" });
    expect(parseDiagTarget("/diag media")).toEqual({ kind: "media", limit: 10 });
    expect(parseDiagTarget("/diag autodev")).toEqual({ kind: "autodev", limit: 10 });
    expect(parseDiagTarget("/diag queue")).toEqual({ kind: "queue", limit: 10 });
    expect(parseDiagTarget("/diag media 51")).toBeNull();
    expect(parseDiagTarget("/diag autodev 51")).toBeNull();
    expect(parseDiagTarget("/diag queue 0")).toBeNull();
    expect(parseDiagTarget("//diag route 3")).toEqual({ kind: "route", limit: 3 });
    expect(parseDiagTarget("//diag queue 3")).toEqual({ kind: "queue", limit: 3 });
  });

  it("parses backend and upgrade targets", () => {
    expect(parseBackendTarget("/backend")).toEqual({ kind: "status" });
    expect(parseBackendTarget("/backend status")).toEqual({ kind: "status" });
    expect(parseBackendTarget("/backend auto")).toEqual({ kind: "auto" });
    expect(parseBackendTarget("/backend codex")).toEqual({
      kind: "manual",
      profile: { provider: "codex", model: null },
    });
    expect(parseBackendTarget("/backend codex gpt-5.4")).toEqual({
      kind: "manual",
      profile: { provider: "codex", model: "gpt-5.4" },
    });
    expect(parseBackendTarget("/backend claude:claude-sonnet-4-5")).toEqual({
      kind: "manual",
      profile: { provider: "claude", model: "claude-sonnet-4-5" },
    });
    expect(parseBackendTarget("//backend claude/claude-sonnet-4-5")).toEqual({
      kind: "manual",
      profile: { provider: "claude", model: "claude-sonnet-4-5" },
    });
    expect(parseBackendTarget("/backend bad")).toBeNull();
    expect(parseBackendTarget("/backend auto extra")).toBeNull();

    expect(parseUpgradeTarget("/upgrade")).toEqual({ ok: true, version: null });
    expect(parseUpgradeTarget("/upgrade v0.1.50")).toEqual({ ok: true, version: "0.1.50" });
    expect(parseUpgradeTarget("/upgrade bad").ok).toBe(false);
  });

  it("classifies backend task type from workflow/autodev command kinds", () => {
    expect(classifyBackendTaskType({ kind: "run", objective: "x" }, null)).toBe("workflow_run");
    expect(classifyBackendTaskType({ kind: "status" }, null)).toBe("workflow_status");
    expect(classifyBackendTaskType(null, { kind: "run", taskId: null })).toBe("autodev_run");
    expect(classifyBackendTaskType(null, { kind: "status" })).toBe("autodev_status");
    expect(classifyBackendTaskType(null, { kind: "progress", mode: "on" })).toBe("autodev_status");
    expect(classifyBackendTaskType(null, { kind: "workdir", mode: "status", path: null })).toBe("autodev_status");
    expect(classifyBackendTaskType(null, { kind: "init", path: null, from: null })).toBe("autodev_status");
    expect(classifyBackendTaskType(null, { kind: "stop" })).toBe("autodev_stop");
    expect(classifyBackendTaskType(null, null)).toBe("chat");
  });

  it("normalizes and compares backend profiles", () => {
    const left = normalizeBackendProfile({ provider: "codex", model: " gpt-5.4 " });
    const right = normalizeBackendProfile({ provider: "codex", model: "gpt-5.4" });
    expect(left).toEqual({ provider: "codex", model: "gpt-5.4" });
    expect(isSameBackendProfile(left, right)).toBe(true);
    expect(isSameBackendProfile(left, { provider: "claude", model: "gpt-5.4" })).toBe(false);
  });

  it("serializes backend target using canonical format", () => {
    expect(serializeBackendTarget({ kind: "status" })).toBe("status");
    expect(serializeBackendTarget({ kind: "auto" })).toBe("auto");
    expect(
      serializeBackendTarget({
        kind: "manual",
        profile: { provider: "claude", model: "claude-sonnet-4-5" },
      }),
    ).toBe("claude:claude-sonnet-4-5");
  });
});
