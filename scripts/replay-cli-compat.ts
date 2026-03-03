import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { CodexExecutor } from "../src/executor/codex-executor";
import { CliCompatRecordEntry } from "../src/compat/cli-compat-recorder";

type ReplayStatus = "success" | "failed";

interface ReplayResult {
  index: number;
  requestId: string;
  sessionKey: string;
  status: ReplayStatus;
  durationMs: number;
  replyPreview: string | null;
  replyHash: string | null;
  error: string | null;
  codexSessionId: string | null;
}

interface ReplayReport {
  inputPath: string;
  generatedAt: string;
  total: number;
  success: number;
  failed: number;
  averageDurationMs: number;
  model: string | null;
  workdir: string;
  results: ReplayResult[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const outPath = args.out ? path.resolve(args.out) : null;
  const maxCount = args.max;

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const entries = loadRecords(inputPath, maxCount);
  if (entries.length === 0) {
    throw new Error(`No records found in ${inputPath}`);
  }

  const executor = new CodexExecutor({
    bin: process.env.CODEX_BIN || "codex",
    model: args.model,
    workdir: path.resolve(args.workdir),
    dangerousBypass: args.dangerousBypass,
    timeoutMs: args.timeoutMs,
    sandboxMode: args.sandboxMode,
    approvalPolicy: args.approvalPolicy,
    extraArgs: args.extraArgs,
    extraEnv: parseExtraEnv(process.env.CODEX_EXTRA_ENV_JSON || ""),
  });

  const sessionMap = new Map<string, string>();
  const results: ReplayResult[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const previousSessionId = sessionMap.get(entry.sessionKey) ?? null;
    const startedAt = Date.now();

    try {
      const result = await executor.execute(entry.prompt, previousSessionId, undefined, {
        passThroughRawEvents: false,
      });
      const durationMs = Date.now() - startedAt;
      sessionMap.set(entry.sessionKey, result.sessionId);
      results.push({
        index,
        requestId: entry.requestId,
        sessionKey: entry.sessionKey,
        status: "success",
        durationMs,
        replyPreview: trimPreview(result.reply),
        replyHash: digest(result.reply),
        error: null,
        codexSessionId: result.sessionId,
      });
      process.stdout.write(
        `[replay] #${index} request=${entry.requestId} status=success duration=${durationMs}ms hash=${digest(result.reply)}\n`,
      );
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        index,
        requestId: entry.requestId,
        sessionKey: entry.sessionKey,
        status: "failed",
        durationMs,
        replyPreview: null,
        replyHash: null,
        error: message,
        codexSessionId: previousSessionId,
      });
      process.stderr.write(
        `[replay] #${index} request=${entry.requestId} status=failed duration=${durationMs}ms error=${message}\n`,
      );
    }
  }

  const success = results.filter((item) => item.status === "success").length;
  const failed = results.length - success;
  const totalDuration = results.reduce((acc, item) => acc + item.durationMs, 0);
  const report: ReplayReport = {
    inputPath,
    generatedAt: new Date().toISOString(),
    total: results.length,
    success,
    failed,
    averageDurationMs: results.length > 0 ? Math.round(totalDuration / results.length) : 0,
    model: args.model,
    workdir: path.resolve(args.workdir),
    results,
  };

  const summary = `Replay finished: total=${report.total}, success=${report.success}, failed=${report.failed}, avg=${report.averageDurationMs}ms`;
  process.stdout.write(`${summary}\n`);

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    process.stdout.write(`Report saved to ${outPath}\n`);
  }
}

function loadRecords(filePath: string, maxCount: number): CliCompatRecordEntry[] {
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const entries: CliCompatRecordEntry[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as CliCompatRecordEntry;
    entries.push(parsed);
    if (entries.length >= maxCount) {
      break;
    }
  }

  return entries;
}

function parseArgs(argv: string[]): {
  input: string;
  out: string | null;
  model: string | null;
  workdir: string;
  max: number;
  timeoutMs: number;
  sandboxMode: string | null;
  approvalPolicy: string | null;
  dangerousBypass: boolean;
  extraArgs: string[];
} {
  const args = {
    input: "data/cli-compat-record.jsonl",
    out: null as string | null,
    model: (process.env.CODEX_MODEL || "").trim() || null,
    workdir: process.env.CODEX_WORKDIR || process.cwd(),
    max: Number.parseInt(process.env.REPLAY_MAX || "50", 10),
    timeoutMs: Number.parseInt(process.env.CODEX_EXEC_TIMEOUT_MS || "600000", 10),
    sandboxMode: (process.env.CODEX_SANDBOX_MODE || "").trim() || null,
    approvalPolicy: (process.env.CODEX_APPROVAL_POLICY || "").trim() || null,
    dangerousBypass: String(process.env.CODEX_DANGEROUS_BYPASS || "false").toLowerCase() === "true",
    extraArgs: parseExtraArgs(process.env.CODEX_EXTRA_ARGS || ""),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if ((token === "--input" || token === "-i") && next) {
      args.input = next;
      i += 1;
      continue;
    }
    if ((token === "--out" || token === "-o") && next) {
      args.out = next;
      i += 1;
      continue;
    }
    if ((token === "--model" || token === "-m") && next) {
      args.model = next;
      i += 1;
      continue;
    }
    if ((token === "--workdir" || token === "-C") && next) {
      args.workdir = next;
      i += 1;
      continue;
    }
    if (token === "--max" && next) {
      args.max = Number.parseInt(next, 10);
      i += 1;
      continue;
    }
    if (token === "--timeout-ms" && next) {
      args.timeoutMs = Number.parseInt(next, 10);
      i += 1;
      continue;
    }
    if (token === "--sandbox" && next) {
      args.sandboxMode = next;
      i += 1;
      continue;
    }
    if (token === "--approval" && next) {
      args.approvalPolicy = next;
      i += 1;
      continue;
    }
    if (token === "--dangerous") {
      args.dangerousBypass = true;
      continue;
    }
  }

  if (!Number.isFinite(args.max) || args.max <= 0) {
    throw new Error(`Invalid --max value: ${args.max}`);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms value: ${args.timeoutMs}`);
  }

  return args;
}

function parseExtraArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseExtraEnv(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const parsed = JSON.parse(trimmed) as Record<string, string>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CODEX_EXTRA_ENV_JSON must be a JSON object");
  }
  return parsed;
}

function trimPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const maxLen = 180;
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen)}...` : normalized;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[replay] fatal: ${message}\n`);
  process.exit(1);
});
