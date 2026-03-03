import { spawn } from "node:child_process";
import readline from "node:readline";

import { CodexExecutionResult } from "../types";

export interface CodexExecutorOptions {
  bin: string;
  model: string | null;
  workdir: string;
  dangerousBypass: boolean;
  timeoutMs: number;
  sandboxMode: string | null;
  approvalPolicy: string | null;
  extraArgs: string[];
  extraEnv: Record<string, string>;
}

export interface CodexExecutionStartOptions {
  passThroughRawEvents?: boolean;
  imagePaths?: string[];
  workdir?: string;
}

export interface CodexProgressEvent {
  stage:
    | "thread_started"
    | "turn_started"
    | "reasoning"
    | "turn_completed"
    | "item_completed"
    | "stderr"
    | "raw_event";
  message?: string;
  eventType?: string;
  raw?: Record<string, unknown>;
}

export type CodexProgressHandler = (event: CodexProgressEvent) => void;

export interface CodexExecutionHandle {
  result: Promise<CodexExecutionResult>;
  cancel: () => void;
}

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
  };
  [key: string]: unknown;
}

export class CodexExecutionCancelledError extends Error {
  constructor(message = "codex execution cancelled") {
    super(message);
    this.name = "CodexExecutionCancelledError";
  }
}

export class CodexExecutor {
  private readonly options: CodexExecutorOptions;

  constructor(options: CodexExecutorOptions) {
    this.options = options;
  }

  async execute(
    prompt: string,
    sessionId: string | null,
    onProgress?: CodexProgressHandler,
    startOptions?: CodexExecutionStartOptions,
  ): Promise<CodexExecutionResult> {
    return this.startExecution(prompt, sessionId, onProgress, startOptions).result;
  }

  startExecution(
    prompt: string,
    sessionId: string | null,
    onProgress?: CodexProgressHandler,
    startOptions?: CodexExecutionStartOptions,
  ): CodexExecutionHandle {
    const args = buildCodexArgs(prompt, sessionId, this.options, startOptions);
    const child = spawn(this.options.bin, args, {
      cwd: startOptions?.workdir ?? this.options.workdir,
      env: {
        ...process.env,
        ...this.options.extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let resolvedThreadId: string | null = sessionId;
    let latestMessage = "";
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | null = null;
    let completed = false;
    const passThroughRawEvents = startOptions?.passThroughRawEvents ?? false;

    const lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on("line", (line) => {
      const event = parseCodexJsonLine(line);
      if (!event) {
        return;
      }

      if (passThroughRawEvents) {
        onProgress?.({
          stage: "raw_event",
          eventType: typeof event.type === "string" ? event.type : "unknown",
          raw: event,
          message: summarizeRawEvent(event),
        });
      }

      if (event.type === "thread.started" && event.thread_id) {
        resolvedThreadId = event.thread_id;
        onProgress?.({ stage: "thread_started", message: event.thread_id, eventType: event.type, raw: event });
      }
      if (event.type === "turn.started") {
        onProgress?.({ stage: "turn_started", eventType: event.type, raw: event });
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        latestMessage = event.item.text.trim();
      }
      if (event.type === "item.completed" && event.item?.type === "reasoning" && event.item.text) {
        onProgress?.({
          stage: "reasoning",
          message: event.item.text.trim(),
          eventType: event.type,
          raw: event,
        });
      }
      if (
        event.type === "item.completed" &&
        event.item?.type &&
        event.item?.type !== "agent_message" &&
        event.item?.type !== "reasoning"
      ) {
        onProgress?.({
          stage: "item_completed",
          message: event.item.type,
          eventType: event.type,
          raw: event,
        });
      }
      if (event.type === "turn.completed") {
        onProgress?.({ stage: "turn_completed", eventType: event.type, raw: event });
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const chunkText = chunk.toString("utf8");
      stderr += chunkText;
      const normalized = chunkText.replace(/\s+/g, " ").trim();
      if (normalized) {
        onProgress?.({
          stage: "stderr",
          message: normalized,
        });
      }
    });

    const terminateProcess = (mode: "cancel" | "timeout"): void => {
      if (completed) {
        return;
      }
      if (mode === "timeout") {
        timedOut = true;
      } else {
        cancelled = true;
      }
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000);
        killTimer.unref?.();
      }
    };

    const timeoutTimer =
      this.options.timeoutMs > 0
        ? setTimeout(() => {
            terminateProcess("timeout");
          }, this.options.timeoutMs)
        : null;
    timeoutTimer?.unref?.();

    const result = (async (): Promise<CodexExecutionResult> => {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 1));
      });

      if (timedOut) {
        throw new Error(`codex execution timed out after ${this.options.timeoutMs}ms`);
      }
      if (cancelled) {
        throw new CodexExecutionCancelledError();
      }
      if (exitCode !== 0) {
        throw new Error(`codex exited with code ${exitCode}: ${stderr.trim() || "<no stderr output>"}`);
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
    })().finally(() => {
      completed = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      lineReader.close();
    });

    return {
      result,
      cancel: () => {
        terminateProcess("cancel");
      },
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

function buildCodexArgs(
  prompt: string,
  sessionId: string | null,
  options: CodexExecutorOptions,
  startOptions?: CodexExecutionStartOptions,
): string[] {
  const args: string[] = [];
  if (sessionId) {
    args.push("exec", "resume", "--json", "--skip-git-repo-check", sessionId, prompt);
  } else {
    args.push("exec", "--json", "--skip-git-repo-check", prompt);
  }

  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.sandboxMode) {
    args.push("--sandbox", options.sandboxMode);
  }
  if (options.approvalPolicy) {
    args.push("--ask-for-approval", options.approvalPolicy);
  }

  for (const imagePath of startOptions?.imagePaths ?? []) {
    if (imagePath.trim()) {
      args.push("--image", imagePath);
    }
  }

  if (options.extraArgs.length > 0) {
    args.push(...options.extraArgs);
  }

  if (options.dangerousBypass) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  return args;
}

function summarizeRawEvent(event: CodexJsonEvent): string {
  const type = typeof event.type === "string" ? event.type : "unknown";
  const itemType = event.item?.type ? ` item=${event.item.type}` : "";
  return `event=${type}${itemType}`;
}
