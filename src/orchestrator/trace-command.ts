import type { OutputLanguage } from "../config";
import type { InboundMessage } from "../types";
import type { MediaMetricEvent } from "./runtime-metrics";
import { parseTraceTarget } from "./command-routing";
import { summarizeSingleLine } from "./helpers";
import { byOutputLanguage } from "./output-language";
import type { RequestTraceRecord } from "./request-trace";
import type { WorkflowDiagEventRecord, WorkflowDiagRunRecord } from "./workflow-diag";

interface TraceCommandDeps {
  outputLanguage: OutputLanguage;
  botNoticePrefix: string;
  getRequestTraceById: (requestId: string) => RequestTraceRecord | null;
  listWorkflowDiagRunsByRequestId: (requestId: string, limit: number) => WorkflowDiagRunRecord[];
  listWorkflowDiagEvents: (runId: string, limit?: number) => WorkflowDiagEventRecord[];
  listMediaEventsByRequestId: (requestId: string, limit: number) => MediaMetricEvent[];
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

export async function handleTraceCommand(deps: TraceCommandDeps, message: InboundMessage): Promise<void> {
  const target = parseTraceTarget(message.text);
  if (!target || target.kind === "help") {
    await deps.sendNotice(message.conversationId, buildTraceUsageNotice(deps.outputLanguage));
    return;
  }

  const trace = deps.getRequestTraceById(target.requestId);
  const workflowRuns = deps.listWorkflowDiagRunsByRequestId(target.requestId, 5);
  const mediaEvents = deps.listMediaEventsByRequestId(target.requestId, 8);

  if (!trace && workflowRuns.length === 0 && mediaEvents.length === 0) {
    await deps.sendNotice(
      message.conversationId,
      buildTraceNotFoundNotice(deps.botNoticePrefix, target.requestId, deps.outputLanguage),
    );
    return;
  }

  await deps.sendNotice(
    message.conversationId,
    buildTraceNotice({
      botNoticePrefix: deps.botNoticePrefix,
      requestId: target.requestId,
      trace,
      workflowRuns,
      resolveWorkflowEvents: (runId) => deps.listWorkflowDiagEvents(runId, 4),
      mediaEvents,
      outputLanguage: deps.outputLanguage,
    }),
  );
}

function buildTraceUsageNotice(outputLanguage: OutputLanguage): string {
  if (outputLanguage === "en") {
    return "[CodeHarbor] usage: /trace <requestId> (example: /trace req-123)";
  }
  return "[CodeHarbor] 用法: /trace <requestId>（示例: /trace req-123）";
}

function buildTraceNotFoundNotice(
  botNoticePrefix: string,
  requestId: string,
  outputLanguage: OutputLanguage,
): string {
  if (outputLanguage === "en") {
    return `${botNoticePrefix} Request trace
- requestId: ${requestId}
- status: not found in memory`;
  }
  return `${botNoticePrefix} 请求追踪
- requestId: ${requestId}
- status: 内存中未找到对应记录`;
}

function buildTraceNotice(input: {
  botNoticePrefix: string;
  requestId: string;
  trace: RequestTraceRecord | null;
  workflowRuns: WorkflowDiagRunRecord[];
  resolveWorkflowEvents: (runId: string) => WorkflowDiagEventRecord[];
  mediaEvents: MediaMetricEvent[];
  outputLanguage: OutputLanguage;
}): string {
  const localize = (zh: string, en: string): string => byOutputLanguage(input.outputLanguage, zh, en);
  const lines: string[] = [
    localize(`${input.botNoticePrefix} 请求追踪`, `${input.botNoticePrefix} Request trace`),
    `- requestId: ${input.requestId}`,
  ];

  if (input.trace) {
    lines.push(`- kind: ${input.trace.kind}`);
    lines.push(`- status: ${input.trace.status}`);
    lines.push(`- provider: ${input.trace.provider ?? "N/A"}`);
    lines.push(`- model: ${input.trace.model ?? "N/A"}`);
    lines.push(`- sessionKey: ${input.trace.sessionKey}`);
    lines.push(`- conversationId: ${input.trace.conversationId}`);
    lines.push(`- startedAt: ${input.trace.startedAt}`);
    lines.push(`- endedAt: ${input.trace.endedAt ?? "N/A"}`);
    lines.push(`- sessionId: ${input.trace.sessionId ?? "N/A"}`);
    lines.push(`- prompt: ${summarizeSingleLine(input.trace.prompt, 240) || "N/A"}`);
    lines.push(`- executionPrompt: ${summarizeSingleLine(input.trace.executionPrompt, 240) || "N/A"}`);
    lines.push(`- reply: ${summarizeSingleLine(input.trace.reply ?? "", 240) || "N/A"}`);
    lines.push(`- error: ${summarizeSingleLine(input.trace.error ?? "", 240) || "none"}`);
    lines.push(localize("- progress:", "- progress:"));
    if (input.trace.progress.length === 0) {
      lines.push("- (empty)");
    } else {
      lines.push(...formatTraceProgress(input.trace.progress));
    }
  } else {
    lines.push(localize("- trace: no in-memory chat trace record", "- trace: no in-memory chat trace record"));
  }

  lines.push(localize("- workflowDiag:", "- workflowDiag:"));
  if (input.workflowRuns.length === 0) {
    lines.push("- (empty)");
  } else {
    for (const run of input.workflowRuns) {
      lines.push(
        `- run=${run.runId} kind=${run.kind} status=${run.status} stage=${run.lastStage ?? "N/A"} updatedAt=${run.updatedAt}`,
      );
      const events = input.resolveWorkflowEvents(run.runId);
      if (events.length === 0) {
        lines.push("  events=(empty)");
        continue;
      }
      lines.push(`  events=${events.map((event) => summarizeSingleLine(`${event.stage}#${event.round}:${event.message}`, 120)).join(" -> ")}`);
    }
  }

  lines.push(localize("- mediaEvents:", "- mediaEvents:"));
  if (input.mediaEvents.length === 0) {
    lines.push("- (empty)");
  } else {
    lines.push(...input.mediaEvents.map((event) => `- at=${event.at} type=${event.type} detail=${event.detail}`));
  }

  return lines.join("\n");
}

function formatTraceProgress(progress: RequestTraceRecord["progress"]): string[] {
  return progress.map((item, index) => {
    const message = summarizeSingleLine(item.message, 160);
    return `- #${index + 1} at=${item.at} stage=${item.stage} message=${message}`;
  });
}
