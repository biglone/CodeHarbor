import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CodexBinaryChecker = (bin: string) => Promise<void>;
export type AiCliProvider = "codex" | "claude" | "gemini";

export interface FindWorkingCodexBinOptions {
  env?: NodeJS.ProcessEnv;
  checkBinary?: CodexBinaryChecker;
}

export interface FindWorkingCliBinOptions {
  env?: NodeJS.ProcessEnv;
  checkBinary?: CodexBinaryChecker;
  provider?: AiCliProvider;
}

export function buildCodexBinCandidates(configuredBin: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return buildCliBinCandidates(configuredBin, "codex", env);
}

export function buildCliBinCandidates(
  configuredBin: string,
  provider: AiCliProvider,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const command = defaultCliCommandForProvider(provider);
  const normalized = configuredBin.trim() || command;
  const home = env.HOME?.trim() || os.homedir();
  const npmGlobalBin = home ? path.resolve(home, `.npm-global/bin/${command}`) : "";

  const candidates = [
    normalized,
    command,
    npmGlobalBin,
    `/usr/bin/${command}`,
    `/usr/local/bin/${command}`,
    `/opt/homebrew/bin/${command}`,
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
  return findWorkingCliBin(configuredBin, {
    ...options,
    provider: "codex",
  });
}

export async function findWorkingCliBin(
  configuredBin: string,
  options: FindWorkingCliBinOptions = {},
): Promise<string | null> {
  const checkBinary = options.checkBinary ?? defaultCheckBinary;
  const provider = options.provider ?? "codex";
  const candidates = buildCliBinCandidates(configuredBin, provider, options.env);

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

function defaultCliCommandForProvider(provider: AiCliProvider): string {
  if (provider === "claude") {
    return "claude";
  }
  if (provider === "gemini") {
    return "gemini";
  }
  return "codex";
}
