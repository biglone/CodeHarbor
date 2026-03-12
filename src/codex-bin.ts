import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CodexBinaryChecker = (bin: string) => Promise<void>;

export interface FindWorkingCodexBinOptions {
  env?: NodeJS.ProcessEnv;
  checkBinary?: CodexBinaryChecker;
}

export function buildCodexBinCandidates(configuredBin: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const normalized = configuredBin.trim() || "codex";
  const home = env.HOME?.trim() || os.homedir();
  const npmGlobalBin = home ? path.resolve(home, ".npm-global/bin/codex") : "";

  const candidates = [
    normalized,
    "codex",
    npmGlobalBin,
    "/usr/bin/codex",
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
  ];

  const seen = new Set<string>();
  const output: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

export async function findWorkingCodexBin(
  configuredBin: string,
  options: FindWorkingCodexBinOptions = {},
): Promise<string | null> {
  const checkBinary = options.checkBinary ?? defaultCheckBinary;
  const candidates = buildCodexBinCandidates(configuredBin, options.env);

  for (const candidate of candidates) {
    try {
      await checkBinary(candidate);
      return candidate;
    } catch {
      // Continue probing next candidate.
    }
  }

  return null;
}

async function defaultCheckBinary(bin: string): Promise<void> {
  await execFileAsync(bin, ["--version"]);
}
