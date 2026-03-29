import { summarizeSingleLine } from "./helpers";

export type RequestTraceKind = "chat" | "workflow" | "autodev";
export type RequestTraceStatus = "running" | "succeeded" | "failed" | "cancelled" | "timeout";

export interface RequestTraceProgressItem {
  at: string;
  stage: string;
  message: string;
}

export interface RequestTraceRecord {
  requestId: string;
  sessionKey: string;
  conversationId: string;
  kind: RequestTraceKind;
  provider: "codex" | "claude" | null;
  model: string | null;
  prompt: string;
  executionPrompt: string;
  startedAt: string;
  endedAt: string | null;
  status: RequestTraceStatus;
  error: string | null;
  reply: string | null;
  sessionId: string | null;
  progress: RequestTraceProgressItem[];
}

interface BeginRequestTraceInput {
  requestId: string;
  sessionKey: string;
  conversationId: string;
  kind: RequestTraceKind;
  provider: "codex" | "claude" | null;
  model: string | null;
  prompt: string;
  executionPrompt: string;
}

interface AppendRequestTraceProgressInput {
  requestId: string;
  stage: string;
  message: string;
}

interface FinishRequestTraceInput {
  requestId: string;
  status: RequestTraceStatus;
  error: string | null;
  reply: string | null;
  sessionId: string | null;
}

const MAX_PROMPT_CHARS = 10_000;
const MAX_PROGRESS_ITEMS = 60;

export function beginRequestTrace(
  traces: Map<string, RequestTraceRecord>,
  order: string[],
  maxEntries: number,
  input: BeginRequestTraceInput,
): void {
  const requestId = input.requestId.trim();
  if (!requestId) {
    return;
  }
  const existingIndex = order.indexOf(requestId);
  if (existingIndex >= 0) {
    order.splice(existingIndex, 1);
  }
  order.push(requestId);
  traces.set(requestId, {
    requestId,
    sessionKey: input.sessionKey,
    conversationId: input.conversationId,
    kind: input.kind,
    provider: input.provider,
    model: input.model?.trim() || null,
    prompt: truncateForTrace(input.prompt, MAX_PROMPT_CHARS),
    executionPrompt: truncateForTrace(input.executionPrompt, MAX_PROMPT_CHARS),
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "running",
    error: null,
    reply: null,
    sessionId: null,
    progress: [],
  });
  pruneRequestTraces(traces, order, maxEntries);
}

export function appendRequestTraceProgress(
  traces: Map<string, RequestTraceRecord>,
  input: AppendRequestTraceProgressInput,
): void {
  const trace = traces.get(input.requestId.trim());
  if (!trace) {
    return;
  }
  const stage = input.stage.trim();
  const message = truncateForTrace(input.message, 300);
  if (!stage || !message) {
    return;
  }
  const latest = trace.progress[trace.progress.length - 1];
  if (latest && latest.stage === stage && latest.message === message) {
    return;
  }
  trace.progress.push({
    at: new Date().toISOString(),
    stage,
    message,
  });
  if (trace.progress.length > MAX_PROGRESS_ITEMS) {
    trace.progress.splice(0, trace.progress.length - MAX_PROGRESS_ITEMS);
  }
}

export function finishRequestTrace(
  traces: Map<string, RequestTraceRecord>,
  input: FinishRequestTraceInput,
): void {
  const trace = traces.get(input.requestId.trim());
  if (!trace) {
    return;
  }
  trace.status = input.status;
  trace.error = input.error;
  trace.reply = input.reply === null ? null : truncateForTrace(input.reply, MAX_PROMPT_CHARS);
  trace.sessionId = input.sessionId?.trim() || null;
  trace.endedAt = new Date().toISOString();
}

export function getRequestTraceById(
  traces: Map<string, RequestTraceRecord>,
  requestId: string,
): RequestTraceRecord | null {
  const normalized = requestId.trim();
  if (!normalized) {
    return null;
  }
  return traces.get(normalized) ?? null;
}

export function truncateForTrace(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}\n...[truncated]`;
}

export function summarizeProgressEvent(stage: string, message: string | null): string {
  const normalizedStage = stage.trim().toLowerCase();
  if (!message?.trim()) {
    return normalizedStage || "progress";
  }
  return summarizeSingleLine(`${normalizedStage}: ${message.trim()}`, 300);
}

function pruneRequestTraces(
  traces: Map<string, RequestTraceRecord>,
  order: string[],
  maxEntries: number,
): void {
  const safeMax = Math.max(20, Math.floor(maxEntries));
  while (order.length > safeMax) {
    const removed = order.shift();
    if (!removed) {
      break;
    }
    traces.delete(removed);
  }
}
