import type { BackendModelRouteProfile, BackendModelRouteTaskType } from "../routing/backend-model-router";

export type ControlCommand = "status" | "version" | "backend" | "stop" | "reset" | "diag" | "help" | "upgrade";

export type WorkflowCommandLike = { kind: "status" } | { kind: "run"; objective: string } | null;

export type AutoDevCommandLike =
  | { kind: "status" }
  | { kind: "run"; taskId: string | null }
  | { kind: "stop" }
  | { kind: "workdir"; mode: "status" | "set" | "clear"; path: string | null }
  | { kind: "init"; path: string | null; skill: string | null }
  | { kind: "progress"; mode: "status" | "on" | "off" }
  | { kind: "skills"; mode: "status" | "on" | "off" | "summary" | "progressive" | "full" }
  | null;

export type DiagTarget =
  | { kind: "version" }
  | { kind: "media"; limit: number }
  | { kind: "upgrade"; limit: number }
  | { kind: "route"; limit: number }
  | { kind: "autodev"; limit: number }
  | { kind: "queue"; limit: number }
  | { kind: "help" };

export type BackendTarget =
  | { kind: "status" }
  | { kind: "auto" }
  | { kind: "manual"; profile: BackendModelRouteProfile };

export function parseControlCommand(text: string): ControlCommand | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === "help" || normalized === "帮助" || normalized === "菜单") {
    return "help";
  }
  if (
    normalized === "stop" ||
    normalized === "cancel" ||
    normalized === "esc" ||
    normalized === "撤回" ||
    normalized === "撤销"
  ) {
    return "stop";
  }
  if (isPlainUpgradeCommand(normalized)) {
    return "upgrade";
  }

  const command = normalizeSlashCommandToken(text.split(/\s+/, 1)[0] ?? "");
  if (command === "/status") {
    return "status";
  }
  if (command === "/version") {
    return "version";
  }
  if (command === "/backend") {
    return "backend";
  }
  if (command === "/stop") {
    return "stop";
  }
  if (command === "/cancel" || command === "/esc" || command === "/撤回" || command === "/撤销") {
    return "stop";
  }
  if (command === "/reset") {
    return "reset";
  }
  if (command === "/diag") {
    return "diag";
  }
  if (command === "/help") {
    return "help";
  }
  if (command === "/upgrade") {
    return "upgrade";
  }
  return null;
}

export function parseDiagTarget(text: string): DiagTarget | null {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return { kind: "help" };
  }
  const diagTokenIndex = tokens.findIndex((token) => normalizeSlashCommandToken(token) === "/diag");
  if (diagTokenIndex < 0) {
    return { kind: "help" };
  }
  const value = (tokens[diagTokenIndex + 1] ?? "").toLowerCase();
  const limitToken = tokens[diagTokenIndex + 2] ?? "";
  if (!value) {
    return { kind: "help" };
  }
  if (value === "version") {
    return { kind: "version" };
  }
  if (value === "media") {
    return parseDiagTargetWithLimit("media", limitToken, 10, 50);
  }
  if (value === "upgrade") {
    return parseDiagTargetWithLimit("upgrade", limitToken, 5, 20);
  }
  if (value === "route") {
    return parseDiagTargetWithLimit("route", limitToken, 10, 50);
  }
  if (value === "autodev") {
    return parseDiagTargetWithLimit("autodev", limitToken, 10, 50);
  }
  if (value === "queue") {
    return parseDiagTargetWithLimit("queue", limitToken, 10, 50);
  }
  return null;
}

export function parseBackendTarget(text: string): BackendTarget | null {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return { kind: "status" };
  }
  const backendTokenIndex = tokens.findIndex((token) => normalizeSlashCommandToken(token) === "/backend");
  if (backendTokenIndex < 0) {
    return null;
  }
  const args = tokens.slice(backendTokenIndex + 1);
  if (args.length === 0) {
    return { kind: "status" };
  }

  const firstToken = args[0] ?? "";
  const firstLower = firstToken.toLowerCase();
  if (firstLower === "status") {
    return args.length === 1 ? { kind: "status" } : null;
  }
  if (firstLower === "auto") {
    return args.length === 1 ? { kind: "auto" } : null;
  }

  let providerToken = firstLower;
  let modelToken: string | undefined;
  const compositeMatch = firstToken.match(/^([^:/]+)[:/](.+)$/);
  if (compositeMatch) {
    providerToken = compositeMatch[1]?.trim().toLowerCase() ?? "";
    modelToken = compositeMatch[2]?.trim() ?? "";
    if (args.length > 1) {
      return null;
    }
  } else if (args.length >= 2) {
    modelToken = args[1];
    if (args.length > 2) {
      return null;
    }
  }

  const provider = normalizeBackendProviderToken(providerToken);
  if (!provider) {
    return null;
  }
  const model = normalizeBackendModelToken(modelToken);
  return {
    kind: "manual",
    profile: {
      provider,
      model,
    },
  };
}

export function classifyBackendTaskType(
  workflowCommand: WorkflowCommandLike,
  autoDevCommand: AutoDevCommandLike,
): BackendModelRouteTaskType {
  if (workflowCommand?.kind === "run") {
    return "workflow_run";
  }
  if (workflowCommand?.kind === "status") {
    return "workflow_status";
  }
  if (autoDevCommand?.kind === "run") {
    return "autodev_run";
  }
  if (autoDevCommand?.kind === "status") {
    return "autodev_status";
  }
  if (autoDevCommand?.kind === "skills" || autoDevCommand?.kind === "progress") {
    return "autodev_status";
  }
  if (autoDevCommand?.kind === "workdir" || autoDevCommand?.kind === "init") {
    return "autodev_status";
  }
  if (autoDevCommand?.kind === "stop") {
    return "autodev_stop";
  }
  return "chat";
}

export function normalizeBackendProfile(profile: BackendModelRouteProfile): BackendModelRouteProfile {
  return {
    provider: profile.provider,
    model: profile.model?.trim() || null,
  };
}

export function serializeBackendTarget(target: BackendTarget): string {
  if (target.kind !== "manual") {
    return target.kind;
  }
  if (!target.profile.model) {
    return target.profile.provider;
  }
  return `${target.profile.provider}:${target.profile.model}`;
}

export function isSameBackendProfile(left: BackendModelRouteProfile, right: BackendModelRouteProfile): boolean {
  return left.provider === right.provider && (left.model?.trim() || null) === (right.model?.trim() || null);
}

export function parseUpgradeTarget(text: string): { ok: true; version: string | null } | { ok: false; reason: string } {
  const tokens = text
    .trim()
    .split(/\s+/)
    .filter((item) => item.length > 0);
  if (tokens.length <= 1) {
    return { ok: true, version: null };
  }
  if (tokens.length > 2) {
    return {
      ok: false,
      reason: "用法: /upgrade [version]（示例: /upgrade 或 /upgrade 0.1.33）",
    };
  }

  const raw = tokens[1]?.trim() ?? "";
  if (!raw || raw.toLowerCase() === "latest") {
    return { ok: true, version: null };
  }

  const normalized = raw.startsWith("v") ? raw.slice(1) : raw;
  const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
  if (!semverPattern.test(normalized)) {
    return {
      ok: false,
      reason: "版本号格式无效。请使用 x.y.z（例如 0.1.33）或留空表示 latest。",
    };
  }
  return {
    ok: true,
    version: normalized,
  };
}

function normalizeSlashCommandToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (normalized.startsWith("//")) {
    return normalized.slice(1);
  }
  return normalized;
}

function isPlainUpgradeCommand(normalized: string): boolean {
  if (normalized === "upgrade" || normalized === "升级") {
    return true;
  }
  const match = normalized.match(/^(upgrade|升级)\s+(.+)$/);
  if (!match) {
    return false;
  }
  const argument = match[2]?.trim() ?? "";
  if (!argument || argument === "latest") {
    return true;
  }
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(argument);
}

function parseDiagTargetWithLimit<K extends DiagTarget["kind"]>(
  kind: K,
  limitToken: string,
  fallback: number,
  max: number,
): Extract<DiagTarget, { kind: K }> | null {
  if (!limitToken) {
    return { kind, limit: fallback } as Extract<DiagTarget, { kind: K }>;
  }
  const parsed = Number.parseInt(limitToken, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > max) {
    return null;
  }
  return {
    kind,
    limit: parsed,
  } as Extract<DiagTarget, { kind: K }>;
}

function normalizeBackendProviderToken(token: string): BackendModelRouteProfile["provider"] | null {
  if (token === "codex" || token === "claude") {
    return token;
  }
  return null;
}

function normalizeBackendModelToken(token: string | undefined): string | null {
  if (typeof token !== "string") {
    return null;
  }
  const normalized = token.trim();
  return normalized.length > 0 ? normalized : null;
}
