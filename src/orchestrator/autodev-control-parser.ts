import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

export type AutoDevLoopStopPermission = "allowed" | "no_active_loop" | "already_requested";

export function evaluateAutoDevLoopStopPermission(input: {
  activeAutoDevLoopSessions: Set<string>;
  pendingAutoDevLoopStopRequests: Set<string>;
  sessionKey: string;
}): AutoDevLoopStopPermission {
  if (!input.activeAutoDevLoopSessions.has(input.sessionKey)) {
    return "no_active_loop";
  }
  if (input.pendingAutoDevLoopStopRequests.has(input.sessionKey)) {
    return "already_requested";
  }
  return "allowed";
}

export async function assertAutoDevTargetDirectory(targetPath: string): Promise<void> {
  const stats = await fs.stat(targetPath);
  if (!stats.isDirectory()) {
    throw new Error(`target is not a directory: ${targetPath}`);
  }
}

export function resolveAutoDevTargetPath(rawPath: string | null, baseWorkdir: string): string {
  const normalized = (rawPath ?? "").trim();
  if (!normalized) {
    return path.resolve(baseWorkdir);
  }
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  const resolvedInBase = path.resolve(baseWorkdir, normalized);
  if (looksLikeProjectName(normalized)) {
    const resolvedSibling = path.resolve(baseWorkdir, "..", normalized);
    if (!existsSync(resolvedInBase) && existsSync(resolvedSibling)) {
      return resolvedSibling;
    }
  }
  return resolvedInBase;
}

function looksLikeProjectName(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\");
}
