import type { MultiAgentWorkflowProgressEvent, MultiAgentWorkflowRunResult } from "../workflow/multi-agent-workflow";
import type { WorkflowRoleSkillDisclosureMode } from "../workflow/role-skills";
import type { InboundMessage } from "../types";
import type { OutputLanguage } from "../config";
import { formatDurationMs, formatError, formatWorkflowProgressNotice } from "./helpers";
import { buildFailureProgressSummary, buildWorkflowResultReply, classifyExecutionOutcome } from "./workflow-status";
import type { WorkflowDiagRunKind } from "./workflow-diag";
import { byOutputLanguage } from "./output-language";

interface SendProgressContextLike {
  conversationId: string;
  isDirectMessage: boolean;
  getProgressNoticeEventId: () => string | null;
  setProgressNoticeEventId: (next: string) => void;
}

interface RunningExecutionLike {
  requestId: string;
  startedAt: number;
  cancel: () => void;
}

interface WorkflowRoleSkillPolicyLike {
  enabled: boolean;
  mode: WorkflowRoleSkillDisclosureMode;
}

interface ExecuteWorkflowRunRequestDeps {
  outputLanguage: OutputLanguage;
  setWorkflowSnapshot: (
    sessionKey: string,
    snapshot: {
      state: "idle" | "running" | "succeeded" | "failed";
      startedAt: string | null;
      endedAt: string | null;
      objective: string | null;
      approved: boolean | null;
      repairRounds: number;
      error: string | null;
    },
  ) => void;
  beginWorkflowDiagRun: (input: {
    kind: WorkflowDiagRunKind;
    sessionKey: string;
    conversationId: string;
    requestId: string;
    objective: string;
    taskId?: string | null;
    taskDescription?: string | null;
  }) => string;
  startTypingHeartbeat: (conversationId: string) => () => Promise<void>;
  consumePendingStopRequest: (sessionKey: string) => boolean;
  runningExecutions: Map<string, RunningExecutionLike>;
  persistRuntimeMetricsSnapshot: () => void;
  sendProgressUpdate: (ctx: SendProgressContextLike, text: string) => Promise<void>;
  appendWorkflowDiagEvent: (
    runId: string,
    kind: WorkflowDiagRunKind,
    stage: string,
    round: number,
    message: string,
  ) => void;
  isAutoDevDetailedProgressEnabled: (sessionKey: string) => boolean;
  isAutoDevStageOutputEchoEnabled: (sessionKey: string) => boolean;
  resolveWorkflowRoleSkillPolicy: (sessionKey: string) => WorkflowRoleSkillPolicyLike;
  runWorkflow: (input: {
    objective: string;
    workdir: string;
    roleSkillPolicy: WorkflowRoleSkillPolicyLike;
    onRegisterCancel: (cancel: () => void) => void;
    onProgress: (event: MultiAgentWorkflowProgressEvent) => Promise<void>;
  }) => Promise<MultiAgentWorkflowRunResult>;
  sendMessage: (conversationId: string, text: string) => Promise<void>;
  finishProgress: (ctx: SendProgressContextLike, summary: string) => Promise<void>;
  finishWorkflowDiagRun: (runId: string, input: {
    status: "running" | "succeeded" | "failed" | "cancelled";
    approved: boolean | null;
    repairRounds: number;
    error: string | null;
  }) => void;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

interface ExecuteWorkflowRunRequestInput {
  objective: string;
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
  workdir: string;
  diagRunId?: string | null;
  diagRunKind?: WorkflowDiagRunKind;
}

export async function executeWorkflowRunRequest(
  deps: ExecuteWorkflowRunRequestDeps,
  input: ExecuteWorkflowRunRequestInput,
): Promise<MultiAgentWorkflowRunResult | null> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  const normalizedObjective = input.objective.trim();
  if (!normalizedObjective) {
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        "[CodeHarbor] /agents run 需要提供任务目标。",
        "[CodeHarbor] /agents run requires an objective.",
      ),
    );
    return null;
  }

  const requestStartedAt = Date.now();
  let progressNoticeEventId: string | null = null;
  const progressCtx: SendProgressContextLike = {
    conversationId: input.message.conversationId,
    isDirectMessage: input.message.isDirectMessage,
    getProgressNoticeEventId: () => progressNoticeEventId,
    setProgressNoticeEventId: (next) => {
      progressNoticeEventId = next;
    },
  };

  const startedAtIso = new Date().toISOString();
  deps.setWorkflowSnapshot(input.sessionKey, {
    state: "running",
    startedAt: startedAtIso,
    endedAt: null,
    objective: normalizedObjective,
    approved: null,
    repairRounds: 0,
    error: null,
  });
  const diagRunKind = input.diagRunKind ?? "workflow";
  const workflowDiagRunId =
    input.diagRunId ??
    deps.beginWorkflowDiagRun({
      kind: diagRunKind,
      sessionKey: input.sessionKey,
      conversationId: input.message.conversationId,
      requestId: input.requestId,
      objective: normalizedObjective,
    });

  const stopTyping = deps.startTypingHeartbeat(input.message.conversationId);
  let cancelWorkflow = (): void => {};
  let cancelRequested = deps.consumePendingStopRequest(input.sessionKey);
  deps.runningExecutions.set(input.sessionKey, {
    requestId: input.requestId,
    startedAt: requestStartedAt,
    cancel: () => {
      cancelRequested = true;
      cancelWorkflow();
    },
  });
  deps.persistRuntimeMetricsSnapshot();

  const workflowStartText = localize(
    "多智能体流程启动：规划代理 -> 执行代理 -> 审查代理",
    "Multi-Agent workflow started: Planner -> Executor -> Reviewer",
  );
  await deps.sendProgressUpdate(progressCtx, `[CodeHarbor] ${workflowStartText}`);
  deps.appendWorkflowDiagEvent(
    workflowDiagRunId,
    diagRunKind,
    "workflow",
    0,
    workflowStartText,
  );
  const detailedProgressEnabled = deps.isAutoDevDetailedProgressEnabled(input.sessionKey);
  const stageOutputEchoEnabled =
    input.diagRunKind === "autodev" && deps.isAutoDevStageOutputEchoEnabled(input.sessionKey);
  const roleSkillPolicy = deps.resolveWorkflowRoleSkillPolicy(input.sessionKey);

  try {
    const result = await deps.runWorkflow({
      objective: normalizedObjective,
      workdir: input.workdir,
      roleSkillPolicy,
      onRegisterCancel: (cancel) => {
        cancelWorkflow = cancel;
        if (cancelRequested) {
          cancelWorkflow();
        }
      },
      onProgress: async (event) => {
        deps.appendWorkflowDiagEvent(workflowDiagRunId, diagRunKind, event.stage, event.round, event.message);
        await deps.sendProgressUpdate(
          progressCtx,
          `[CodeHarbor] ${formatWorkflowProgressNotice(event, detailedProgressEnabled, deps.outputLanguage)}`,
        );
        if (stageOutputEchoEnabled && event.stageOutput?.content?.trim()) {
          await sendNoticeBestEffort(
            deps,
            input.message.conversationId,
            buildWorkflowStageOutputNotice(event, deps.outputLanguage),
          );
        }
      },
    });

    const endedAtIso = new Date().toISOString();
    deps.setWorkflowSnapshot(input.sessionKey, {
      state: "succeeded",
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      objective: normalizedObjective,
      approved: result.approved,
      repairRounds: result.repairRounds,
      error: null,
    });

    await deps.sendMessage(input.message.conversationId, buildWorkflowResultReply(result, deps.outputLanguage));
    const workflowSummary = result.approved
      ? localize(
          `多智能体流程完成（审查通过，耗时 ${formatDurationMs(Date.now() - requestStartedAt)}）`,
          `Multi-agent workflow completed (approved, ${formatDurationMs(Date.now() - requestStartedAt)})`,
        )
      : localize(
          `多智能体流程完成（审查未通过，耗时 ${formatDurationMs(Date.now() - requestStartedAt)}）`,
          `Multi-agent workflow completed (reviewer rejected, ${formatDurationMs(Date.now() - requestStartedAt)})`,
        );
    await deps.finishProgress(
      progressCtx,
      workflowSummary,
    );
    deps.finishWorkflowDiagRun(workflowDiagRunId, {
      status: "succeeded",
      approved: result.approved,
      repairRounds: result.repairRounds,
      error: null,
    });
    return result;
  } catch (error) {
    const status = classifyExecutionOutcome(error);
    const endedAtIso = new Date().toISOString();
    deps.setWorkflowSnapshot(input.sessionKey, {
      state: status === "cancelled" ? "idle" : "failed",
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      objective: normalizedObjective,
      approved: null,
      repairRounds: 0,
      error: formatError(error),
    });
    await deps.finishProgress(progressCtx, buildFailureProgressSummary(status, requestStartedAt, error, deps.outputLanguage));
    deps.finishWorkflowDiagRun(workflowDiagRunId, {
      status: status === "cancelled" ? "cancelled" : "failed",
      approved: null,
      repairRounds: 0,
      error: formatError(error),
    });
    throw error;
  } finally {
    const running = deps.runningExecutions.get(input.sessionKey);
    if (running?.requestId === input.requestId) {
      deps.runningExecutions.delete(input.sessionKey);
    }
    deps.persistRuntimeMetricsSnapshot();
    await stopTyping();
  }
}

async function sendNoticeBestEffort(
  deps: Pick<ExecuteWorkflowRunRequestDeps, "sendNotice">,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    await deps.sendNotice(conversationId, text);
  } catch {
    // Best-effort stage output echo should not fail the workflow.
  }
}

function buildWorkflowStageOutputNotice(
  event: MultiAgentWorkflowProgressEvent,
  outputLanguage: OutputLanguage,
): string {
  const stageOutput = event.stageOutput;
  if (!stageOutput) {
    return outputLanguage === "en"
      ? "[CodeHarbor] Workflow stage output unavailable."
      : "[CodeHarbor] Workflow 阶段产出不可用。";
  }
  const round = event.stage === "repair" ? Math.max(1, event.round) : event.round + 1;
  const stageLabel = event.stage.toUpperCase();
  if (outputLanguage === "en") {
    return `[CodeHarbor] ${stageLabel} stage output
- role: ${stageOutput.role}
- source: ${stageOutput.source}
- round: ${round}

[${stageOutput.label}]
${stageOutput.content}
[/${stageOutput.label}]`;
  }
  return `[CodeHarbor] ${stageLabel} 阶段产出
- 角色: ${stageOutput.role}
- 来源: ${stageOutput.source}
- 轮次: ${round}

[${stageOutput.label}]
${stageOutput.content}
[/${stageOutput.label}]`;
}
