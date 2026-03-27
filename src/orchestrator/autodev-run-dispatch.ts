import type { Logger } from "../logger";
import type { InboundMessage } from "../types";
import type { MultiAgentWorkflowRunResult } from "../workflow/multi-agent-workflow";
import { type AutoDevTask, updateAutoDevTaskStatus } from "../workflow/autodev";
import type { OutputLanguage } from "../config";
import type { AutoDevGitCommitResult } from "./autodev-git";
import {
  runAutoDevCommand,
  type AutoDevRunContext,
  type AutoDevRunSnapshot,
} from "./autodev-runner";
import { formatError } from "./helpers";
import type { WorkflowDiagRunRecord } from "./workflow-diag";
import type { WorkflowDiagEventRecord } from "./workflow-diag";

interface AutoDevFailurePolicyResult {
  blocked: boolean;
  streak: number;
  task: AutoDevTask;
}

interface BeginWorkflowDiagRunInput {
  kind: "autodev";
  sessionKey: string;
  conversationId: string;
  requestId: string;
  objective: string;
  taskId: string | null;
  taskDescription: string | null;
}

interface HandleAutoDevRunCommandDeps {
  logger: Logger;
  outputLanguage: OutputLanguage;
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevAutoReleaseEnabled: boolean;
  autoDevAutoReleasePush: boolean;
  autoDevMaxConsecutiveFailures: number;
  autoDevRunArchiveEnabled: boolean;
  autoDevRunArchiveDir: string;
  pendingAutoDevLoopStopRequests: Set<string>;
  activeAutoDevLoopSessions: Set<string>;
  autoDevFailureStreaks: Map<string, number>;
  consumePendingStopRequest: (sessionKey: string) => boolean;
  consumePendingAutoDevLoopStopRequest: (sessionKey: string) => boolean;
  setAutoDevSnapshot: (sessionKey: string, snapshot: AutoDevRunSnapshot) => void;
  channelSendNotice: (conversationId: string, text: string) => Promise<void>;
  beginWorkflowDiagRun: (input: BeginWorkflowDiagRunInput) => string;
  appendWorkflowDiagEvent: (runId: string, kind: "autodev", stage: string, round: number, message: string) => void;
  runWorkflowCommand: (input: {
    objective: string;
    sessionKey: string;
    message: InboundMessage;
    requestId: string;
    workdir: string;
    diagRunId: string;
    resolveReviewerTaskListPolicyContext?: (input: {
      round: number;
      objective: string;
      plan: string;
      output: string;
      workdir: string;
    }) => string | null | Promise<string | null>;
  }) => Promise<MultiAgentWorkflowRunResult | null>;
  listWorkflowDiagRunsBySession: (kind: "autodev", sessionKey: string, limit: number) => WorkflowDiagRunRecord[];
  listWorkflowDiagEvents: (runId: string, limit?: number) => WorkflowDiagEventRecord[];
  recordAutoDevGitCommit: (sessionKey: string, taskId: string, result: AutoDevGitCommitResult) => void;
  autoDevMetrics: {
    recordRunOutcome: (outcome: "succeeded" | "failed" | "cancelled") => void;
    recordLoopStop: (
      reason: "no_task" | "drained" | "max_runs" | "deadline" | "stop_requested" | "no_progress" | "task_incomplete",
    ) => void;
    recordTaskBlocked: () => void;
  };
}

interface HandleAutoDevRunCommandInput {
  taskId: string | null;
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
  workdir: string;
  runContext?: AutoDevRunContext;
}

interface ApplyAutoDevFailurePolicyInput {
  autoDevFailureStreaks: Map<string, number>;
  autoDevMaxConsecutiveFailures: number;
  logger: Logger;
  workdir: string;
  task: AutoDevTask;
  taskListPath: string;
}

export async function handleAutoDevRunCommand(
  deps: HandleAutoDevRunCommandDeps,
  input: HandleAutoDevRunCommandInput,
): Promise<void> {
  await runAutoDevCommand(
    {
      logger: deps.logger,
      outputLanguage: deps.outputLanguage,
      autoDevLoopMaxRuns: deps.autoDevLoopMaxRuns,
      autoDevLoopMaxMinutes: deps.autoDevLoopMaxMinutes,
      autoDevAutoCommit: deps.autoDevAutoCommit,
      autoDevAutoReleaseEnabled: deps.autoDevAutoReleaseEnabled,
      autoDevAutoReleasePush: deps.autoDevAutoReleasePush,
      autoDevRunArchiveEnabled: deps.autoDevRunArchiveEnabled,
      autoDevRunArchiveDir: deps.autoDevRunArchiveDir,
      pendingAutoDevLoopStopRequests: deps.pendingAutoDevLoopStopRequests,
      activeAutoDevLoopSessions: deps.activeAutoDevLoopSessions,
      consumePendingStopRequest: (sessionKey) => deps.consumePendingStopRequest(sessionKey),
      consumePendingAutoDevLoopStopRequest: (sessionKey) => deps.consumePendingAutoDevLoopStopRequest(sessionKey),
      setAutoDevSnapshot: (sessionKey, snapshot) => {
        deps.setAutoDevSnapshot(sessionKey, snapshot);
      },
      channelSendNotice: (conversationId, text) => deps.channelSendNotice(conversationId, text),
      beginWorkflowDiagRun: (diagInput) => deps.beginWorkflowDiagRun(diagInput),
      appendWorkflowDiagEvent: (runId, kind, stage, round, message) =>
        deps.appendWorkflowDiagEvent(runId, kind, stage, round, message),
      runWorkflowCommand: (workflowInput) => deps.runWorkflowCommand(workflowInput),
      listWorkflowDiagRunsBySession: (kind, sessionKey, limit) =>
        deps.listWorkflowDiagRunsBySession(kind, sessionKey, limit),
      listWorkflowDiagEvents: (runId, limit) => deps.listWorkflowDiagEvents(runId, limit),
      recordAutoDevGitCommit: (sessionKey, taskId, result) => deps.recordAutoDevGitCommit(sessionKey, taskId, result),
      resetAutoDevFailureStreak: (workdir, taskId) => resetAutoDevFailureStreak(deps.autoDevFailureStreaks, workdir, taskId),
      applyAutoDevFailurePolicy: (policyInput) =>
        applyAutoDevFailurePolicy({
          autoDevFailureStreaks: deps.autoDevFailureStreaks,
          autoDevMaxConsecutiveFailures: deps.autoDevMaxConsecutiveFailures,
          logger: deps.logger,
          workdir: policyInput.workdir,
          task: policyInput.task,
          taskListPath: policyInput.taskListPath,
        }),
      autoDevMetrics: deps.autoDevMetrics,
    },
    input,
  );
}

export async function applyAutoDevFailurePolicy(input: ApplyAutoDevFailurePolicyInput): Promise<AutoDevFailurePolicyResult> {
  const key = buildAutoDevFailureKey(input.workdir, input.task.id);
  const streak = (input.autoDevFailureStreaks.get(key) ?? 0) + 1;
  input.autoDevFailureStreaks.set(key, streak);
  if (streak < input.autoDevMaxConsecutiveFailures) {
    return {
      blocked: false,
      streak,
      task: input.task,
    };
  }
  try {
    const blockedTask = await updateAutoDevTaskStatus(input.taskListPath, input.task, "blocked");
    return {
      blocked: true,
      streak,
      task: blockedTask,
    };
  } catch (error) {
    input.logger.warn("Failed to mark AutoDev task as blocked after consecutive failures", {
      taskId: input.task.id,
      streak,
      error: formatError(error),
    });
    return {
      blocked: false,
      streak,
      task: input.task,
    };
  }
}

function resetAutoDevFailureStreak(autoDevFailureStreaks: Map<string, number>, workdir: string, taskId: string): void {
  const key = buildAutoDevFailureKey(workdir, taskId);
  autoDevFailureStreaks.delete(key);
}

function buildAutoDevFailureKey(workdir: string, taskId: string): string {
  return `${workdir}::${taskId.trim().toLowerCase()}`;
}
