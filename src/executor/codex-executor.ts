import { spawn } from "node:child_process";
import readline from "node:readline";

import { CodexExecutionResult } from "../types";

export interface CodexExecutorOptions {
  bin: string;
  model: string | null;
  workdir: string;
  dangerousBypass: boolean;
}

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
}

export class CodexExecutor {
  private readonly options: CodexExecutorOptions;

  constructor(options: CodexExecutorOptions) {
    this.options = options;
  }

  async execute(prompt: string, sessionId: string | null): Promise<CodexExecutionResult> {
    const args = buildCodexArgs(prompt, sessionId, this.options);
    const child = spawn(this.options.bin, args, {
      cwd: this.options.workdir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let resolvedThreadId: string | null = sessionId;
    let latestMessage = "";

    const lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on("line", (line) => {
      const event = parseCodexJsonLine(line);
      if (!event) {
        return;
      }
      if (event.type === "thread.started" && event.thread_id) {
        resolvedThreadId = event.thread_id;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        latestMessage = event.item.text.trim();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });

    lineReader.close();

    if (exitCode !== 0) {
      throw new Error(`codex exited with code ${exitCode}: ${stderr.trim()}`);
    }
    if (!resolvedThreadId) {
      throw new Error("codex did not return thread_id.");
    }
    if (!latestMessage) {
      throw new Error("codex did not return a final assistant message.");
    }

    return {
      sessionId: resolvedThreadId,
      reply: latestMessage,
    };
  }
}

export function parseCodexJsonLine(line: string): CodexJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as CodexJsonEvent;
  } catch {
    return null;
  }
}

function buildCodexArgs(prompt: string, sessionId: string | null, options: CodexExecutorOptions): string[] {
  const args: string[] = [];
  if (sessionId) {
    args.push("exec", "resume", "--json", "--skip-git-repo-check", sessionId, prompt);
  } else {
    args.push("exec", "--json", "--skip-git-repo-check", prompt);
  }

  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.dangerousBypass) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  return args;
}
