import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { CodexExecutionResult } from "../types";

type AiCliProvider = "codex" | "claude";

export interface CodexExecutorOptions {
  provider?: AiCliProvider;
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

interface ClaudeJsonEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  error?: string;
  message?: string;
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
  private readonly provider: AiCliProvider;

  constructor(options: CodexExecutorOptions) {
    this.options = options;
    this.provider = options.provider ?? "codex";
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
    let claudeStreamInput: string | null = null;
    try {
      claudeStreamInput = buildClaudeStreamInput(prompt, startOptions);
    } catch (error) {
      return {
        result: Promise.reject(error),
        cancel: () => {},
      };
    }
    const args = buildCliArgs(
      prompt,
      sessionId,
      this.options,
      startOptions,
      this.provider,
      Boolean(claudeStreamInput),
    );
    const child = spawn(this.options.bin, args, {
      cwd: startOptions?.workdir ?? this.options.workdir,
      env: {
        ...process.env,
        ...this.options.extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (claudeStreamInput) {
      child.stdin.write(`${claudeStreamInput}\n`);
    }
    child.stdin.end();

    let stderr = "";
    let resolvedThreadId: string | null = sessionId;
    let latestMessage = "";
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | null = null;
    let completed = false;
    let latestProviderError: string | null = null;
    const passThroughRawEvents = startOptions?.passThroughRawEvents ?? false;

    const lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on("line", (line) => {
      if (this.provider === "claude") {
        const event = parseClaudeJsonLine(line);
        if (!event) {
          return;
        }
        latestProviderError = handleClaudeEvent(
          event,
          passThroughRawEvents,
          onProgress,
          (value) => {
            resolvedThreadId = value;
          },
          (value) => {
            latestMessage = value;
          },
          latestProviderError,
        );
        return;
      }
      const event = parseCodexJsonLine(line);
      if (!event) {
        return;
      }
      handleCodexEvent(event, passThroughRawEvents, onProgress, (value) => {
        resolvedThreadId = value;
      }, (value) => {
        latestMessage = value;
      });
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
        throw new Error(`${this.provider} execution timed out after ${this.options.timeoutMs}ms`);
      }
      if (cancelled) {
        throw new CodexExecutionCancelledError();
      }
      if (exitCode !== 0) {
        throw new Error(`${this.provider} exited with code ${exitCode}: ${stderr.trim() || "<no stderr output>"}`);
      }
      if (latestProviderError) {
        throw new Error(`${this.provider} returned error: ${latestProviderError}`);
      }
      if (!resolvedThreadId) {
        throw new Error(
          this.provider === "codex" ? "codex did not return thread_id." : "claude did not return session_id.",
        );
      }
      if (!latestMessage) {
        throw new Error(`${this.provider} did not return a final assistant message.`);
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

export function parseClaudeJsonLine(line: string): ClaudeJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i -= 1) {
        const item = parsed[i];
        if (item && typeof item === "object" && !Array.isArray(item)) {
          return item as ClaudeJsonEvent;
        }
      }
      return null;
    }
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as ClaudeJsonEvent;
  } catch {
    return null;
  }
}

function buildCliArgs(
  prompt: string,
  sessionId: string | null,
  options: CodexExecutorOptions,
  startOptions: CodexExecutionStartOptions | undefined,
  provider: AiCliProvider,
  hasClaudeStreamInput: boolean,
): string[] {
  if (provider === "claude") {
    return buildClaudeArgs(prompt, sessionId, options, hasClaudeStreamInput);
  }
  return buildCodexArgs(prompt, sessionId, options, startOptions);
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

function buildClaudeArgs(
  prompt: string,
  sessionId: string | null,
  options: CodexExecutorOptions,
  hasStreamInput: boolean,
): string[] {
  const args: string[] = hasStreamInput
    ? ["-p", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json"]
    : ["-p", prompt, "--output-format", "json"];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.dangerousBypass) {
    args.push("--permission-mode", "bypassPermissions");
  }
  if (options.extraArgs.length > 0) {
    args.push(...options.extraArgs);
  }
  return args;
}

function handleCodexEvent(
  event: CodexJsonEvent,
  passThroughRawEvents: boolean,
  onProgress: CodexProgressHandler | undefined,
  setSessionId: (value: string) => void,
  setLatestMessage: (value: string) => void,
): void {
  if (passThroughRawEvents) {
    onProgress?.({
      stage: "raw_event",
      eventType: typeof event.type === "string" ? event.type : "unknown",
      raw: event,
      message: summarizeRawEvent(event),
    });
  }

  if (event.type === "thread.started" && event.thread_id) {
    setSessionId(event.thread_id);
    onProgress?.({ stage: "thread_started", message: event.thread_id, eventType: event.type, raw: event });
  }
  if (event.type === "turn.started") {
    onProgress?.({ stage: "turn_started", eventType: event.type, raw: event });
  }
  if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
    setLatestMessage(event.item.text.trim());
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
}

function handleClaudeEvent(
  event: ClaudeJsonEvent,
  passThroughRawEvents: boolean,
  onProgress: CodexProgressHandler | undefined,
  setSessionId: (value: string) => void,
  setLatestMessage: (value: string) => void,
  currentError: string | null,
): string | null {
  if (passThroughRawEvents) {
    onProgress?.({
      stage: "raw_event",
      eventType: typeof event.type === "string" ? event.type : "unknown",
      raw: event,
      message: summarizeClaudeRawEvent(event),
    });
  }

  if (event.type === "result" && typeof event.session_id === "string" && event.session_id.trim()) {
    setSessionId(event.session_id.trim());
    onProgress?.({ stage: "thread_started", message: event.session_id.trim(), eventType: event.type, raw: event });
  }
  if (event.type === "result" && typeof event.result === "string" && event.result.trim()) {
    setLatestMessage(event.result.trim());
    onProgress?.({ stage: "turn_completed", eventType: event.type, raw: event });
  }
  if (event.type === "result" && event.is_error === true) {
    return extractClaudeError(event) ?? currentError;
  }
  return currentError;
}

function summarizeRawEvent(event: CodexJsonEvent): string {
  const type = typeof event.type === "string" ? event.type : "unknown";
  const itemType = event.item?.type ? ` item=${event.item.type}` : "";
  return `event=${type}${itemType}`;
}

function summarizeClaudeRawEvent(event: ClaudeJsonEvent): string {
  const type = typeof event.type === "string" ? event.type : "unknown";
  const subtype = event.subtype ? ` subtype=${event.subtype}` : "";
  return `event=${type}${subtype}`;
}

function extractClaudeError(event: ClaudeJsonEvent): string | null {
  if (typeof event.error === "string" && event.error.trim()) {
    return event.error.trim();
  }
  if (typeof event.message === "string" && event.message.trim()) {
    return event.message.trim();
  }
  if (typeof event.result === "string" && event.result.trim()) {
    return event.result.trim();
  }
  return null;
}

function buildClaudeStreamInput(prompt: string, startOptions?: CodexExecutionStartOptions): string | null {
  const imagePaths = startOptions?.imagePaths ?? [];
  if (imagePaths.length === 0) {
    return null;
  }

  const content: Array<
    | {
        type: "image";
        source: {
          type: "base64";
          media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
          data: string;
        };
      }
    | {
        type: "text";
        text: string;
      }
  > = imagePaths.map((imagePath) => {
    const mimeType = resolveImageMimeType(imagePath);
    const base64Data = readFileSync(imagePath).toString("base64");
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: mimeType,
        data: base64Data,
      },
    };
  });
  content.push({
    type: "text" as const,
    text: prompt,
  });

  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content,
    },
  });
}

function resolveImageMimeType(imagePath: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  throw new Error(`unsupported image extension for claude stream input: ${imagePath}`);
}
