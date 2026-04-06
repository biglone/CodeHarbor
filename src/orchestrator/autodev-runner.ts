import fs from "node:fs/promises";

import type { Logger } from "../logger";
import type { InboundMessage } from "../types";
import type { MultiAgentWorkflowRunResult } from "../workflow/multi-agent-workflow";
import type { OutputLanguage } from "../config";
import {
  type AutoDevTask,
  buildAutoDevObjective,
  formatTaskForDisplay,
  loadAutoDevContext,
  selectAutoDevTask,
  statusToSymbol,
  summarizeAutoDevTasks,
  updateAutoDevTaskStatus,
} from "../workflow/autodev";
import {
  captureAutoDevGitBaseline,
  inspectAutoDevGitPreflight,
  tryAutoDevPreflightAutoStash,
  tryAutoDevGitCommit,
  type AutoDevGitCommitResult,
} from "./autodev-git";
import {
  tryAutoDevTaskRelease,
  type AutoDevReleaseResult,
} from "./autodev-release";
import { type AutoDevRunArchiveRecord, persistAutoDevRunArchive } from "./autodev-run-archive";
import {
  formatAutoDevGitChangedFiles,
  formatAutoDevGitCommitResult,
  formatAutoDevReleaseResult,
} from "./diagnostic-formatters";
import { healAutoDevTaskStatuses } from "./autodev-status-heal";
import { formatError, parseEnvBoolean } from "./helpers";
import { classifyExecutionOutcome } from "./workflow-status";
import { byOutputLanguage } from "./output-language";
import {
  buildAutoDevNestedLoopRunContext,
  evaluateAutoDevLoopBoundary,
  handleAutoDevLoopStopIfRequested,
} from "./autodev-loop-engine";
import { executeAutoDevWorkflowStageWithTaskListGuard } from "./autodev-stage-executor";
import { buildAutoDevSecondaryReviewHandoffNotice } from "./autodev-result-reporter";
import type { WorkflowDiagEventRecord, WorkflowDiagRunRecord } from "./workflow-diag";

export interface AutoDevRunSnapshot {
  state: "idle" | "running" | "succeeded" | "completed_with_gate_failed" | "failed";
  startedAt: string | null;
  endedAt: string | null;
  taskId: string | null;
  taskDescription: string | null;
  approved: boolean | null;
  repairRounds: number;
  error: string | null;
  mode: "idle" | "single" | "loop";
  loopRound: number;
  loopCompletedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAt: string | null;
  lastGitCommitSummary: string | null;
  lastGitCommitAt: string | null;
  lastValidationPassed?: boolean | null;
  lastValidationFailureClass?: AutoDevValidationFailureClass | null;
  lastValidationEvidenceSource?: AutoDevValidationEvidenceSource | null;
  lastValidationAt?: string | null;
  lastReleaseSummary?: string | null;
  lastReleaseAt?: string | null;
}

export interface AutoDevRunContext {
  mode: "single" | "loop";
  loopRound: number;
  loopCompletedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAt: string | null;
}

interface AutoDevFailurePolicyResult {
  blocked: boolean;
  streak: number;
  task: AutoDevTask;
}

type AutoDevCompletionGateReason =
  | "reviewer_not_approved"
  | "validation_not_passed"
  | "task_list_policy_violated"
  | "auto_commit_not_committed";

type AutoDevValidationFailureClass =
  | "strict_missing_structured_evidence"
  | "exit_codes_non_zero_unexpected"
  | "structured_status_fail"
  | "scoped_text_failure"
  | "fallback_text_failure";

type AutoDevValidationEvidenceSource = "structured" | "scoped_text" | "fallback_text" | "none";

interface AutoDevValidationInference {
  passed: boolean;
  failureClass: AutoDevValidationFailureClass | null;
  evidenceSource: AutoDevValidationEvidenceSource;
}

interface AutoDevCompletionGateResult {
  passed: boolean;
  reasons: AutoDevCompletionGateReason[];
}

interface TaskListMutationGuardResult {
  changed: boolean;
  restored: boolean;
  finalClean: boolean;
  error: string | null;
}

interface AutoDevGitPreflightCheckInput {
  sessionKey: string;
  conversationId: string;
  workdir: string;
  task: AutoDevTask | null;
  mode: "single" | "loop";
  startedAtIso: string;
  loopRound: number;
  loopCompletedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAtIso: string | null;
}

async function sendAutoDevNoticeBestEffort(
  deps: Pick<AutoDevRunnerDeps, "channelSendNotice" | "logger">,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    await deps.channelSendNotice(conversationId, text);
  } catch (error) {
    deps.logger.warn("Failed to send AutoDev notice", {
      conversationId,
      error: formatError(error),
    });
  }
}

interface RunWorkflowCommandInput {
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

interface AutoDevRunnerDeps {
  logger: Logger;
  outputLanguage: OutputLanguage;
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevAutoReleaseEnabled: boolean;
  autoDevAutoReleasePush: boolean;
  autoDevRunArchiveEnabled: boolean;
  autoDevRunArchiveDir: string;
  autoDevValidationStrict: boolean;
  autoDevSecondaryReviewEnabled: boolean;
  autoDevSecondaryReviewTarget: string;
  autoDevSecondaryReviewRequireGatePassed: boolean;
  pendingAutoDevLoopStopRequests: Set<string>;
  activeAutoDevLoopSessions: Set<string>;
  consumePendingStopRequest: (sessionKey: string) => boolean;
  consumePendingAutoDevLoopStopRequest: (sessionKey: string) => boolean;
  setAutoDevSnapshot: (sessionKey: string, snapshot: AutoDevRunSnapshot) => void;
  channelSendNotice: (conversationId: string, text: string) => Promise<void>;
  beginWorkflowDiagRun: (input: BeginWorkflowDiagRunInput) => string;
  appendWorkflowDiagEvent: (
    runId: string,
    kind: "autodev",
    stage: string,
    round: number,
    message: string,
  ) => void;
  runWorkflowCommand: (input: RunWorkflowCommandInput) => Promise<MultiAgentWorkflowRunResult | null>;
  listWorkflowDiagRunsBySession: (kind: "autodev", sessionKey: string, limit: number) => WorkflowDiagRunRecord[];
  listWorkflowDiagEvents: (runId: string, limit?: number) => WorkflowDiagEventRecord[];
  recordAutoDevGitCommit: (sessionKey: string, taskId: string, result: AutoDevGitCommitResult) => void;
  resetAutoDevFailureStreak: (workdir: string, taskId: string) => void;
  resetAutoDevValidationFailureStreak: (workdir: string, taskId: string) => void;
  applyAutoDevFailurePolicy: (input: {
    workdir: string;
    task: AutoDevTask;
    taskListPath: string;
  }) => Promise<AutoDevFailurePolicyResult>;
  applyAutoDevValidationFailurePolicy: (input: {
    workdir: string;
    task: AutoDevTask;
    taskListPath: string;
    validationFailureClass: AutoDevValidationFailureClass;
  }) => Promise<AutoDevFailurePolicyResult>;
  autoDevMetrics: {
    recordRunOutcome: (outcome: "succeeded" | "failed" | "cancelled") => void;
    recordLoopStop: (
      reason: "no_task" | "drained" | "max_runs" | "deadline" | "stop_requested" | "no_progress" | "task_incomplete",
    ) => void;
    recordTaskBlocked: () => void;
  };
}

interface RunAutoDevCommandInput {
  taskId: string | null;
  taskLineIndex?: number | null;
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
  workdir: string;
  runContext?: AutoDevRunContext;
}

export async function runAutoDevCommand(
  deps: AutoDevRunnerDeps,
  input: RunAutoDevCommandInput,
): Promise<void> {
  const requestedTaskId = input.taskId?.trim() || null;
  const requestedTaskLineIndex =
    typeof input.taskLineIndex === "number" && Number.isFinite(input.taskLineIndex) ? Math.floor(input.taskLineIndex) : null;
  let context = await loadAutoDevContext(input.workdir);
  const activeContext: AutoDevRunContext = input.runContext ?? {
    mode: requestedTaskId ? "single" : "loop",
    loopRound: requestedTaskId ? 1 : 0,
    loopCompletedRuns: 0,
    loopMaxRuns: requestedTaskId ? 1 : Math.max(0, deps.autoDevLoopMaxRuns),
    loopDeadlineAt:
      requestedTaskId || deps.autoDevLoopMaxMinutes <= 0
        ? null
        : new Date(Date.now() + deps.autoDevLoopMaxMinutes * 60_000).toISOString(),
  };
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  const isNestedLoopTaskRun = Boolean(requestedTaskId && activeContext.mode === "loop");
  if (!isNestedLoopTaskRun) {
    const recentRuns = deps.listWorkflowDiagRunsBySession("autodev", input.sessionKey, 50);
    const healedStatuses = await healAutoDevTaskStatuses({
      taskListPath: context.taskListPath,
      tasks: context.tasks,
      runs: recentRuns,
      targetTaskIds: requestedTaskId ? [requestedTaskId] : null,
    });
    if (healedStatuses.length > 0) {
      context = await loadAutoDevContext(input.workdir);
      const healSummary = healedStatuses
        .map((entry) => `${entry.taskId}:${statusToSymbol(entry.from)}->${statusToSymbol(entry.to)}`)
        .join(", ");
      await sendAutoDevNoticeBestEffort(deps, 
        input.message.conversationId,
        localize(
          `[CodeHarbor] AutoDev 状态自愈：已根据最近运行记录修正任务状态。
- changes: ${healSummary}`,
          `[CodeHarbor] AutoDev status self-heal applied from recent run records.
- changes: ${healSummary}`,
        ),
      );
    }
  }

  if (!context.requirementsContent) {
    await sendAutoDevNoticeBestEffort(deps, 
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 需要 ${context.requirementsPath}，请先准备需求文档。`,
        `[CodeHarbor] AutoDev requires ${context.requirementsPath}. Please prepare the requirements document first.`,
      ),
    );
    return;
  }
  if (!context.taskListContent) {
    await sendAutoDevNoticeBestEffort(deps, 
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 需要 ${context.taskListPath}，请先准备任务清单。`,
        `[CodeHarbor] AutoDev requires ${context.taskListPath}. Please prepare the task list first.`,
      ),
    );
    return;
  }
  if (context.tasks.length === 0) {
    await sendAutoDevNoticeBestEffort(deps, 
      input.message.conversationId,
      localize(
        "[CodeHarbor] 未在 TASK_LIST.md 识别到任务（需包含任务 ID 与状态列）。",
        "[CodeHarbor] No tasks recognized in TASK_LIST.md (requires task ID and status columns).",
      ),
    );
    return;
  }

  if (!requestedTaskId) {
    const loopStartedAt = Date.now();
    const loopDeadlineAtIso = activeContext.loopDeadlineAt;
    let completedRuns = 0;
    let attemptedRuns = 0;
    deps.pendingAutoDevLoopStopRequests.delete(input.sessionKey);
    deps.activeAutoDevLoopSessions.add(input.sessionKey);
    deps.setAutoDevSnapshot(input.sessionKey, {
      state: "running",
      startedAt: new Date(loopStartedAt).toISOString(),
      endedAt: null,
      taskId: null,
      taskDescription: null,
      approved: null,
      repairRounds: 0,
      error: null,
      mode: "loop",
      loopRound: 0,
      loopCompletedRuns: 0,
      loopMaxRuns: activeContext.loopMaxRuns,
      loopDeadlineAt: loopDeadlineAtIso,
      lastGitCommitSummary: null,
      lastGitCommitAt: null,
    });
    try {
      while (true) {
        const shouldStopLoop = await handleAutoDevLoopStopIfRequested(deps, {
          sessionKey: input.sessionKey,
          conversationId: input.message.conversationId,
          loopStartedAt,
          attemptedRuns,
          completedRuns,
          loopMaxRuns: activeContext.loopMaxRuns,
          loopDeadlineAtIso,
        });
        if (shouldStopLoop) {
          return;
        }
        const loopBoundaryDecision = evaluateAutoDevLoopBoundary({
          attemptedRuns,
          loopMaxRuns: activeContext.loopMaxRuns,
          loopDeadlineAtIso,
        });
        if (loopBoundaryDecision.shouldStop) {
          deps.autoDevMetrics.recordLoopStop(loopBoundaryDecision.reason);
          const pausedContext = await loadAutoDevContext(input.workdir);
          const remaining = summarizeAutoDevTasks(pausedContext.tasks);
          const endedAtIso = new Date().toISOString();
          deps.setAutoDevSnapshot(input.sessionKey, {
            state: "succeeded",
            startedAt: new Date(loopStartedAt).toISOString(),
            endedAt: endedAtIso,
            taskId: null,
            taskDescription: null,
            approved: null,
            repairRounds: 0,
            error: null,
            mode: "loop",
            loopRound: attemptedRuns,
            loopCompletedRuns: completedRuns,
            loopMaxRuns: activeContext.loopMaxRuns,
            loopDeadlineAt: loopDeadlineAtIso,
            lastGitCommitSummary: null,
            lastGitCommitAt: null,
          });
          if (loopBoundaryDecision.reason === "max_runs") {
            await sendAutoDevNoticeBestEffort(deps, 
              input.message.conversationId,
              localize(
                `[CodeHarbor] AutoDev 循环执行已达到轮次上限，已暂停。
- attemptedRuns: ${attemptedRuns}
- completedRuns: ${completedRuns}
- loopMaxRuns: ${activeContext.loopMaxRuns}
- remaining: pending=${remaining.pending}, in_progress=${remaining.inProgress}, blocked=${remaining.blocked}, cancelled=${remaining.cancelled}
- 继续执行: /autodev run`,
                `[CodeHarbor] AutoDev loop paused at run limit.
- attemptedRuns: ${attemptedRuns}
- completedRuns: ${completedRuns}
- loopMaxRuns: ${activeContext.loopMaxRuns}
- remaining: pending=${remaining.pending}, in_progress=${remaining.inProgress}, blocked=${remaining.blocked}, cancelled=${remaining.cancelled}
- continue: /autodev run`,
              ),
            );
          } else {
            await sendAutoDevNoticeBestEffort(deps, 
              input.message.conversationId,
              localize(
                `[CodeHarbor] AutoDev 循环执行已达到时间上限，已暂停。
- attemptedRuns: ${attemptedRuns}
- completedRuns: ${completedRuns}
- loopDeadlineAt: ${loopDeadlineAtIso}
- remaining: pending=${remaining.pending}, in_progress=${remaining.inProgress}, blocked=${remaining.blocked}, cancelled=${remaining.cancelled}
- 继续执行: /autodev run`,
                `[CodeHarbor] AutoDev loop paused at time limit.
- attemptedRuns: ${attemptedRuns}
- completedRuns: ${completedRuns}
- loopDeadlineAt: ${loopDeadlineAtIso}
- remaining: pending=${remaining.pending}, in_progress=${remaining.inProgress}, blocked=${remaining.blocked}, cancelled=${remaining.cancelled}
- continue: /autodev run`,
              ),
            );
          }
          return;
        }
        let loopContext = await loadAutoDevContext(input.workdir);
        let loopTask = selectAutoDevTask(loopContext.tasks);
        if (!loopTask) {
          deps.autoDevMetrics.recordLoopStop(completedRuns === 0 ? "no_task" : "drained");
          const endedAtIso = new Date().toISOString();
          deps.setAutoDevSnapshot(input.sessionKey, {
            state: "succeeded",
            startedAt: new Date(loopStartedAt).toISOString(),
            endedAt: endedAtIso,
            taskId: null,
            taskDescription: null,
            approved: null,
            repairRounds: 0,
            error: null,
            mode: "loop",
            loopRound: attemptedRuns,
            loopCompletedRuns: completedRuns,
            loopMaxRuns: activeContext.loopMaxRuns,
            loopDeadlineAt: loopDeadlineAtIso,
            lastGitCommitSummary: null,
            lastGitCommitAt: null,
          });
          if (completedRuns === 0) {
            await sendAutoDevNoticeBestEffort(deps, 
              input.message.conversationId,
              localize(
                "[CodeHarbor] 当前没有可执行任务（pending/in_progress）。",
                "[CodeHarbor] No executable tasks (pending/in_progress).",
              ),
            );
            return;
          }
          const summary = summarizeAutoDevTasks(loopContext.tasks);
          await sendAutoDevNoticeBestEffort(deps, 
            input.message.conversationId,
            localize(
              `[CodeHarbor] AutoDev 循环执行完成
- completedRuns: ${completedRuns}
- remaining: pending=${summary.pending}, in_progress=${summary.inProgress}, blocked=${summary.blocked}, cancelled=${summary.cancelled}`,
              `[CodeHarbor] AutoDev loop completed
- completedRuns: ${completedRuns}
- remaining: pending=${summary.pending}, in_progress=${summary.inProgress}, blocked=${summary.blocked}, cancelled=${summary.cancelled}`,
            ),
          );
          return;
        }

        const shouldStopBeforeNextTask = await handleAutoDevLoopStopIfRequested(deps, {
          sessionKey: input.sessionKey,
          conversationId: input.message.conversationId,
          loopStartedAt,
          attemptedRuns,
          completedRuns,
          loopMaxRuns: activeContext.loopMaxRuns,
          loopDeadlineAtIso,
        });
        if (shouldStopBeforeNextTask) {
          return;
        }

        const preflightFailed = await failAutoDevOnGitPreflightError(deps, {
          sessionKey: input.sessionKey,
          conversationId: input.message.conversationId,
          workdir: input.workdir,
          task: null,
          mode: "loop",
          startedAtIso: new Date(loopStartedAt).toISOString(),
          loopRound: attemptedRuns,
          loopCompletedRuns: completedRuns,
          loopMaxRuns: activeContext.loopMaxRuns,
          loopDeadlineAtIso,
        });
        if (preflightFailed) {
          return;
        }

        loopContext = await loadAutoDevContext(input.workdir);
        const refreshedLoopTask = resolveAutoDevTask(loopContext.tasks, loopTask.id, loopTask.lineIndex);
        if (!refreshedLoopTask) {
          continue;
        }
        loopTask = refreshedLoopTask;

        const taskListBeforeRun = loopContext.taskListContent ?? "";
        attemptedRuns += 1;
        await runAutoDevCommand(deps, {
          ...input,
          taskId: loopTask.id,
          taskLineIndex: loopTask.lineIndex,
          runContext: buildAutoDevNestedLoopRunContext({
            attemptedRuns,
            completedRuns,
            loopMaxRuns: activeContext.loopMaxRuns,
            loopDeadlineAtIso,
          }),
        });

        const refreshed = await loadAutoDevContext(input.workdir);
        const taskListAfterRun = refreshed.taskListContent ?? "";
        if (taskListAfterRun === taskListBeforeRun) {
          deps.autoDevMetrics.recordLoopStop("no_progress");
          const endedAtIso = new Date().toISOString();
          deps.setAutoDevSnapshot(input.sessionKey, {
            state: "failed",
            startedAt: new Date(loopStartedAt).toISOString(),
            endedAt: endedAtIso,
            taskId: loopTask.id,
            taskDescription: loopTask.description,
            approved: null,
            repairRounds: 0,
            error: localize("循环执行未产生任务状态变化", "loop run produced no task state change"),
            mode: "loop",
            loopRound: attemptedRuns,
            loopCompletedRuns: completedRuns,
            loopMaxRuns: activeContext.loopMaxRuns,
            loopDeadlineAt: loopDeadlineAtIso,
            lastGitCommitSummary: null,
            lastGitCommitAt: null,
            lastReleaseSummary: null,
            lastReleaseAt: null,
          });
          await sendAutoDevNoticeBestEffort(deps, 
            input.message.conversationId,
            localize(
              `[CodeHarbor] AutoDev 循环执行已停止：检测到本轮未产生任务状态变化。
- task: ${loopTask.id}
- attemptedRuns: ${attemptedRuns}
- completedRuns: ${completedRuns}
- reason: no task-state change`,
              `[CodeHarbor] AutoDev loop stopped: no task state change detected in this round.
- task: ${loopTask.id}
- attemptedRuns: ${attemptedRuns}
- completedRuns: ${completedRuns}
- reason: no task-state change`,
            ),
          );
          return;
        }
        const refreshedTask = resolveAutoDevTask(refreshed.tasks, loopTask.id, loopTask.lineIndex);
        if (refreshedTask?.status === "completed") {
          completedRuns += 1;
        }
        if (refreshedTask && refreshedTask.status !== "completed") {
          deps.autoDevMetrics.recordLoopStop("task_incomplete");
          await sendAutoDevNoticeBestEffort(deps, 
            input.message.conversationId,
            localize(
              `[CodeHarbor] AutoDev 循环执行暂停：任务 ${refreshedTask.id} 当前状态为 ${statusToSymbol(refreshedTask.status)}。请处理后继续。`,
              `[CodeHarbor] AutoDev loop paused: task ${refreshedTask.id} is ${statusToSymbol(refreshedTask.status)}. Please handle it before continuing.`,
            ),
          );
          return;
        }
      }
    } finally {
      deps.activeAutoDevLoopSessions.delete(input.sessionKey);
      deps.pendingAutoDevLoopStopRequests.delete(input.sessionKey);
    }
  }

  const selectedTask = resolveAutoDevTask(context.tasks, requestedTaskId, requestedTaskLineIndex);
  if (!selectedTask) {
    if (requestedTaskId) {
      await sendAutoDevNoticeBestEffort(deps, 
        input.message.conversationId,
        localize(`[CodeHarbor] 未找到任务 ${requestedTaskId}。`, `[CodeHarbor] Task ${requestedTaskId} was not found.`),
      );
      return;
    }
    await sendAutoDevNoticeBestEffort(deps, 
      input.message.conversationId,
      localize(
        "[CodeHarbor] 当前没有可执行任务（pending/in_progress）。",
        "[CodeHarbor] No executable tasks (pending/in_progress).",
      ),
    );
    return;
  }
  if (selectedTask.status === "completed") {
    await sendAutoDevNoticeBestEffort(deps, 
      input.message.conversationId,
      localize(`[CodeHarbor] 任务 ${selectedTask.id} 已完成（✅）。`, `[CodeHarbor] Task ${selectedTask.id} is already completed (✅).`),
    );
    return;
  }
  if (selectedTask.status === "cancelled") {
    await sendAutoDevNoticeBestEffort(deps, 
      input.message.conversationId,
      localize(`[CodeHarbor] 任务 ${selectedTask.id} 已取消（❌）。`, `[CodeHarbor] Task ${selectedTask.id} is cancelled (❌).`),
    );
    return;
  }

  const effectiveContext: AutoDevRunContext = {
    mode: activeContext.mode,
    loopRound: Math.max(1, activeContext.loopRound),
    loopCompletedRuns: Math.max(0, activeContext.loopCompletedRuns),
    loopMaxRuns:
      activeContext.mode === "loop" ? Math.max(0, activeContext.loopMaxRuns) : Math.max(1, activeContext.loopMaxRuns),
    loopDeadlineAt: activeContext.loopDeadlineAt,
  };
  if (effectiveContext.mode !== "loop") {
    const preflightFailed = await failAutoDevOnGitPreflightError(deps, {
      sessionKey: input.sessionKey,
      conversationId: input.message.conversationId,
      workdir: input.workdir,
      task: selectedTask,
      mode: "single",
      startedAtIso: new Date().toISOString(),
      loopRound: effectiveContext.loopRound,
      loopCompletedRuns: effectiveContext.loopCompletedRuns,
      loopMaxRuns: effectiveContext.loopMaxRuns,
      loopDeadlineAtIso: effectiveContext.loopDeadlineAt,
    });
    if (preflightFailed) {
      return;
    }
  }
  const gitBaseline = await captureAutoDevGitBaseline({
    workdir: input.workdir,
    logger: deps.logger,
  });
  let activeTask = selectedTask;

  const startedAtIso = new Date().toISOString();
  deps.setAutoDevSnapshot(input.sessionKey, {
    state: "running",
    startedAt: startedAtIso,
    endedAt: null,
    taskId: activeTask.id,
    taskDescription: activeTask.description,
    approved: null,
    repairRounds: 0,
    error: null,
    mode: effectiveContext.mode,
    loopRound: effectiveContext.loopRound,
    loopCompletedRuns: effectiveContext.loopCompletedRuns,
    loopMaxRuns: effectiveContext.loopMaxRuns,
    loopDeadlineAt: effectiveContext.loopDeadlineAt,
    lastGitCommitSummary: null,
      lastGitCommitAt: null,
    });
  const objective = buildAutoDevObjective(activeTask);
  const workflowDiagRunId = deps.beginWorkflowDiagRun({
    kind: "autodev",
    sessionKey: input.sessionKey,
    conversationId: input.message.conversationId,
    requestId: input.requestId,
    objective,
    taskId: activeTask.id,
    taskDescription: activeTask.description,
  });
  deps.appendWorkflowDiagEvent(
    workflowDiagRunId,
    "autodev",
    "autodev",
    0,
    localize(
      `AutoDev 启动任务 ${activeTask.id}: ${activeTask.description}`,
      `AutoDev started task ${activeTask.id}: ${activeTask.description}`,
    ),
  );

  await sendAutoDevNoticeBestEffort(deps, 
    input.message.conversationId,
    localize(
      `[CodeHarbor] AutoDev 启动任务 ${activeTask.id}: ${activeTask.description}`,
      `[CodeHarbor] AutoDev started task ${activeTask.id}: ${activeTask.description}`,
    ),
  );

  try {
    const workflowStage = await executeAutoDevWorkflowStageWithTaskListGuard({
      outputLanguage: deps.outputLanguage,
      objective,
      sessionKey: input.sessionKey,
      message: input.message,
      requestId: input.requestId,
      workdir: input.workdir,
      workflowDiagRunId,
      taskListPath: context.taskListPath,
      runWorkflowCommand: (workflowInput) => deps.runWorkflowCommand(workflowInput),
      guardTaskListOwnership: (guardInput) => guardAutoDevTaskListOwnership(guardInput),
      buildReviewerTaskListPolicyContextSummary: (policyInput) =>
        buildReviewerTaskListPolicyContextSummary({
          outputLanguage: policyInput.outputLanguage,
          round: policyInput.round,
          guard: policyInput.guard,
        }),
      appendWorkflowDiagEvent: (runId, kind, stage, round, message) =>
        deps.appendWorkflowDiagEvent(runId, kind, stage, round, message),
      sendNotice: (conversationId, text) => sendAutoDevNoticeBestEffort(deps, conversationId, text),
    });
    if (!workflowStage) {
      return;
    }
    const result = workflowStage.workflowResult;
    const taskListPolicyPassed = workflowStage.taskListPolicyPassed;

    let finalTask = activeTask;
    let gitCommit: AutoDevGitCommitResult = {
      kind: "skipped",
      reason: localize("未触发自动提交", "auto commit not attempted"),
    };
    let releaseResult: AutoDevReleaseResult = {
      kind: "skipped",
      reason: localize("未触发自动发布", "auto release not attempted"),
    };
    const validation = inferAutoDevValidation(result, deps.autoDevValidationStrict);
    const validationPassed = validation.passed;
    const reviewerApprovedForGate = result.approved && taskListPolicyPassed;
    if (!result.approved) {
      gitCommit = {
        kind: "skipped",
        reason: localize("reviewer 未批准，未自动提交", "reviewer not approved; auto commit skipped"),
      };
      releaseResult = {
        kind: "skipped",
        reason: localize("reviewer 未批准，未自动发布", "reviewer not approved; auto release skipped"),
      };
    } else if (!taskListPolicyPassed) {
      gitCommit = {
        kind: "skipped",
        reason: localize("违反 TASK_LIST.md 写入策略，未自动提交", "TASK_LIST.md write policy violated; auto commit skipped"),
      };
      releaseResult = {
        kind: "skipped",
        reason: localize("违反 TASK_LIST.md 写入策略，未自动发布", "TASK_LIST.md write policy violated; auto release skipped"),
      };
    } else if (!validationPassed) {
      gitCommit = {
        kind: "skipped",
        reason: localize("验证未通过，未自动提交", "validation not passed; auto commit skipped"),
      };
    }
    const markCompletedCandidate = reviewerApprovedForGate && validationPassed;
    const firstStatusResult = await reconcileAutoDevTaskFinalStatus({
      workdir: input.workdir,
      taskListPath: context.taskListPath,
      task: activeTask,
      expectedCurrentStatus: activeTask.status,
      nextStatus: markCompletedCandidate ? "completed" : "in_progress",
    });
    finalTask = firstStatusResult.task;
    if (firstStatusResult.statusDriftDetected && firstStatusResult.observedStatus) {
      const driftMessage = localize(
        `[CodeHarbor] AutoDev 状态保护：检测到任务 ${activeTask.id} 状态漂移（observed=${statusToSymbol(
          firstStatusResult.observedStatus,
        )}, expected=${statusToSymbol(activeTask.status)}），已修正为 ${statusToSymbol(finalTask.status)}。`,
        `[CodeHarbor] AutoDev status guard: detected status drift on task ${activeTask.id} (observed=${statusToSymbol(
          firstStatusResult.observedStatus,
        )}, expected=${statusToSymbol(activeTask.status)}); corrected to ${statusToSymbol(finalTask.status)}.`,
      );
      deps.appendWorkflowDiagEvent(workflowDiagRunId, "autodev", "status_guard", 0, driftMessage);
      await sendAutoDevNoticeBestEffort(deps, input.message.conversationId, driftMessage);
    }
    if (markCompletedCandidate) {
      gitCommit = await tryAutoDevGitCommit({
        workdir: input.workdir,
        task: finalTask,
        baseline: gitBaseline,
        workflowResult: result,
        autoCommit: deps.autoDevAutoCommit,
        logger: deps.logger,
      });
    }
    const completionGate = evaluateAutoDevCompletionGate({
      reviewerApproved: result.approved,
      validationPassed,
      taskListPolicyPassed,
      commitRequired: deps.autoDevAutoCommit && gitBaseline.available && gitBaseline.cleanBeforeRun,
      gitCommit,
    });
    if (!completionGate.passed && finalTask.status !== "in_progress") {
      const fallbackStatusResult = await reconcileAutoDevTaskFinalStatus({
        workdir: input.workdir,
        taskListPath: context.taskListPath,
        task: finalTask,
        expectedCurrentStatus: finalTask.status,
        nextStatus: "in_progress",
      });
      finalTask = fallbackStatusResult.task;
    }
    let validationFailurePolicy: AutoDevFailurePolicyResult | null = null;
    if (completionGate.passed) {
      deps.resetAutoDevValidationFailureStreak(input.workdir, finalTask.id);
    } else if (validation.failureClass) {
      validationFailurePolicy = await deps.applyAutoDevValidationFailurePolicy({
        workdir: input.workdir,
        task: finalTask,
        taskListPath: context.taskListPath,
        validationFailureClass: validation.failureClass,
      });
      if (validationFailurePolicy.blocked) {
        finalTask = validationFailurePolicy.task;
        deps.autoDevMetrics.recordTaskBlocked();
        const fuseMessage = localize(
          `[CodeHarbor] AutoDev 验证熔断：任务 ${finalTask.id} 连续 ${validationFailurePolicy.streak} 次命中同类验证失败（${validation.failureClass}），已自动停机并标记为阻塞（🚫）。
- nextAction: 修复失败原因后，将任务状态改回 ⬜/🔄 再执行 \`/autodev run ${finalTask.id}\`
- hint: 通过 \`/autodev status\` 查看 runValidationFailureClass 与 runValidationEvidenceSource`,
          `[CodeHarbor] AutoDev validation fuse: task ${finalTask.id} hit the same validation failure class (${validation.failureClass}) ${validationFailurePolicy.streak} times in a row. AutoDev stopped and marked it blocked (🚫).
- nextAction: fix the root cause, move task status back to ⬜/🔄, then run \`/autodev run ${finalTask.id}\`
- hint: use \`/autodev status\` to inspect runValidationFailureClass and runValidationEvidenceSource`,
        );
        deps.appendWorkflowDiagEvent(workflowDiagRunId, "autodev", "validation_fuse", 0, fuseMessage);
        await sendAutoDevNoticeBestEffort(deps, input.message.conversationId, fuseMessage);
      }
    } else {
      deps.resetAutoDevValidationFailureStreak(input.workdir, finalTask.id);
    }

    if (completionGate.passed) {
      releaseResult = await tryAutoDevTaskRelease({
        workdir: input.workdir,
        task: finalTask,
        taskListPath: context.taskListPath,
        gitCommit,
        settings: {
          enabled: deps.autoDevAutoReleaseEnabled,
          autoPush: deps.autoDevAutoReleasePush,
        },
        logger: deps.logger,
      });
    } else {
      const gateReason = formatAutoDevCompletionGateReasons(completionGate.reasons, deps.outputLanguage);
      releaseResult = {
        kind: "skipped",
        reason: localize(
          `completion gate 未通过，已跳过自动发布（${gateReason}）`,
          `completion gate not satisfied; auto release skipped (${gateReason})`,
        ),
      };
    }
    deps.recordAutoDevGitCommit(input.sessionKey, finalTask.id, gitCommit);
    deps.appendWorkflowDiagEvent(
      workflowDiagRunId,
      "autodev",
      "git_commit",
      0,
      `task=${finalTask.id} result=${formatAutoDevGitCommitResult(gitCommit)} files=${formatAutoDevGitChangedFiles(gitCommit)}`,
    );
    deps.appendWorkflowDiagEvent(
      workflowDiagRunId,
      "autodev",
      "release",
      0,
      `task=${finalTask.id} result=${formatAutoDevReleaseResult(releaseResult)}`,
    );
    deps.resetAutoDevFailureStreak(input.workdir, finalTask.id);
    const endedAtIso = new Date().toISOString();
    deps.setAutoDevSnapshot(input.sessionKey, {
      state: completionGate.passed ? "succeeded" : "completed_with_gate_failed",
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      taskId: finalTask.id,
      taskDescription: finalTask.description,
      approved: result.approved,
      repairRounds: result.repairRounds,
      error: null,
      mode: effectiveContext.mode,
      loopRound: effectiveContext.loopRound,
      loopCompletedRuns: effectiveContext.loopCompletedRuns + (finalTask.status === "completed" ? 1 : 0),
      loopMaxRuns: effectiveContext.loopMaxRuns,
      loopDeadlineAt: effectiveContext.loopDeadlineAt,
      lastGitCommitSummary: formatAutoDevGitCommitResult(gitCommit),
      lastGitCommitAt: new Date().toISOString(),
      lastValidationPassed: validation.passed,
      lastValidationFailureClass: validation.failureClass,
      lastValidationEvidenceSource: validation.evidenceSource,
      lastValidationAt: endedAtIso,
      lastReleaseSummary: formatAutoDevReleaseResult(releaseResult),
      lastReleaseAt: releaseResult.kind === "released" ? new Date().toISOString() : null,
    });
    deps.autoDevMetrics.recordRunOutcome("succeeded");

    const secondaryReviewHandoff = buildAutoDevSecondaryReviewHandoffNotice({
      outputLanguage: deps.outputLanguage,
      enabled: deps.autoDevSecondaryReviewEnabled,
      target: deps.autoDevSecondaryReviewTarget,
      requireGatePassed: deps.autoDevSecondaryReviewRequireGatePassed,
      completionGatePassed: completionGate.passed,
      task: finalTask,
      reviewerApproved: result.approved,
      validationFailureClass: validation.failureClass,
      validationEvidenceSource: validation.evidenceSource,
      validationAt: endedAtIso,
      gitCommitSummary: formatAutoDevGitCommitResult(gitCommit),
      gitChangedFiles: formatAutoDevGitChangedFiles(gitCommit),
      releaseSummary: formatAutoDevReleaseResult(releaseResult),
      requestId: input.requestId,
      workflowDiagRunId,
    });
    if (secondaryReviewHandoff) {
      deps.appendWorkflowDiagEvent(
        workflowDiagRunId,
        "autodev",
        "secondary_review_handoff",
        0,
        secondaryReviewHandoff.diagMessage,
      );
      await sendAutoDevNoticeBestEffort(deps, input.message.conversationId, secondaryReviewHandoff.notice);
    }

    const refreshed = await loadAutoDevContext(input.workdir);
    const nextTask = selectAutoDevTask(refreshed.tasks);
    await sendAutoDevNoticeBestEffort(deps, 
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 任务结果
- task: ${finalTask.id}
- reviewer approved: ${result.approved ? "yes" : "no"}
- completionGate: ${completionGate.passed ? "passed" : "failed"}
- completionGateReasons: ${
          completionGate.passed ? "N/A" : formatAutoDevCompletionGateReasons(completionGate.reasons, deps.outputLanguage)
        }
- validationFailureClass: ${validation.failureClass ?? "none"}
- validationEvidenceSource: ${validation.evidenceSource}
- validationAt: ${endedAtIso}
- task status: ${statusToSymbol(finalTask.status)}
- git commit: ${formatAutoDevGitCommitResult(gitCommit)}
- git changed files: ${formatAutoDevGitChangedFiles(gitCommit)}
- release: ${formatAutoDevReleaseResult(releaseResult)}
- nextTask: ${nextTask ? formatTaskForDisplay(nextTask) : "N/A"}`,
        `[CodeHarbor] AutoDev task result
- task: ${finalTask.id}
- reviewer approved: ${result.approved ? "yes" : "no"}
- completionGate: ${completionGate.passed ? "passed" : "failed"}
- completionGateReasons: ${
          completionGate.passed ? "N/A" : formatAutoDevCompletionGateReasons(completionGate.reasons, deps.outputLanguage)
        }
- validationFailureClass: ${validation.failureClass ?? "none"}
- validationEvidenceSource: ${validation.evidenceSource}
- validationAt: ${endedAtIso}
- task status: ${statusToSymbol(finalTask.status)}
- git commit: ${formatAutoDevGitCommitResult(gitCommit)}
- git changed files: ${formatAutoDevGitChangedFiles(gitCommit)}
- release: ${formatAutoDevReleaseResult(releaseResult)}
- nextTask: ${nextTask ? formatTaskForDisplay(nextTask) : "N/A"}`,
      ),
    );
    deps.appendWorkflowDiagEvent(
      workflowDiagRunId,
      "autodev",
      "autodev",
      0,
      localize(
        `AutoDev 任务结果: task=${finalTask.id}, reviewerApproved=${result.approved ? "yes" : "no"}, completionGate=${
          completionGate.passed ? "passed" : "failed"
        }, completionGateReasonCodes=${
          completionGate.reasons.length === 0 ? "none" : completionGate.reasons.join("|")
        }, validationFailureClass=${validation.failureClass ?? "none"}, validationEvidenceSource=${
          validation.evidenceSource
        }, validationAt=${endedAtIso}, taskStatus=${statusToSymbol(finalTask.status)}, gitCommit=${formatAutoDevGitCommitResult(gitCommit)}, release=${formatAutoDevReleaseResult(releaseResult)}`,
        `AutoDev task result: task=${finalTask.id}, reviewerApproved=${result.approved ? "yes" : "no"}, completionGate=${
          completionGate.passed ? "passed" : "failed"
        }, completionGateReasonCodes=${
          completionGate.reasons.length === 0 ? "none" : completionGate.reasons.join("|")
        }, validationFailureClass=${validation.failureClass ?? "none"}, validationEvidenceSource=${
          validation.evidenceSource
        }, validationAt=${endedAtIso}, taskStatus=${statusToSymbol(finalTask.status)}, gitCommit=${formatAutoDevGitCommitResult(gitCommit)}, release=${formatAutoDevReleaseResult(releaseResult)}`,
      ),
    );
    await persistAutoDevRunArchiveBestEffort(deps, {
      workdir: input.workdir,
      sessionKey: input.sessionKey,
      conversationId: input.message.conversationId,
      requestId: input.requestId,
      workflowDiagRunId,
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      status: "succeeded",
      mode: effectiveContext.mode,
      loopRound: effectiveContext.loopRound,
      loopCompletedRuns: effectiveContext.loopCompletedRuns + (finalTask.status === "completed" ? 1 : 0),
      loopMaxRuns: effectiveContext.loopMaxRuns,
      loopDeadlineAt: effectiveContext.loopDeadlineAt,
      taskId: finalTask.id,
      taskDescription: finalTask.description,
      taskLineIndex: finalTask.lineIndex,
      taskFinalStatus: finalTask.status,
      reviewerApproved: result.approved,
      validationPassed,
      taskListPolicyPassed,
      completionPassed: completionGate.passed,
      completionReasons: completionGate.reasons,
      gitCommitSummary: formatAutoDevGitCommitResult(gitCommit),
      gitChangedFiles: formatAutoDevGitChangedFiles(gitCommit),
      releaseSummary: formatAutoDevReleaseResult(releaseResult),
      failureStreak: null,
      blocked: false,
      error: null,
      workflowResult: result,
    });
  } catch (error) {
    deps.resetAutoDevValidationFailureStreak(input.workdir, activeTask.id);
    const failurePolicy = await deps.applyAutoDevFailurePolicy({
      workdir: input.workdir,
      task: activeTask,
      taskListPath: context.taskListPath,
    });
    activeTask = failurePolicy.task;
    const status = classifyExecutionOutcome(error);
    const endedAtIso = new Date().toISOString();
    deps.setAutoDevSnapshot(input.sessionKey, {
      state: status === "cancelled" ? "idle" : "failed",
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      taskId: activeTask.id,
      taskDescription: activeTask.description,
      approved: null,
      repairRounds: 0,
      error: formatError(error),
      mode: effectiveContext.mode,
      loopRound: effectiveContext.loopRound,
      loopCompletedRuns: effectiveContext.loopCompletedRuns,
      loopMaxRuns: effectiveContext.loopMaxRuns,
      loopDeadlineAt: effectiveContext.loopDeadlineAt,
      lastGitCommitSummary: null,
      lastGitCommitAt: null,
    });
    deps.appendWorkflowDiagEvent(
      workflowDiagRunId,
      "autodev",
      "autodev",
      0,
      localize(
        `AutoDev 失败: ${formatError(error)}, streak=${failurePolicy.streak}, blocked=${
          failurePolicy.blocked ? "yes" : "no"
        }`,
        `AutoDev failed: ${formatError(error)}, streak=${failurePolicy.streak}, blocked=${
          failurePolicy.blocked ? "yes" : "no"
        }`,
      ),
    );
    if (failurePolicy.blocked) {
      deps.autoDevMetrics.recordTaskBlocked();
      await sendAutoDevNoticeBestEffort(deps, 
        input.message.conversationId,
        localize(
          `[CodeHarbor] AutoDev 任务 ${activeTask.id} 连续失败 ${failurePolicy.streak} 次，已标记为阻塞（🚫）。`,
          `[CodeHarbor] AutoDev task ${activeTask.id} failed ${failurePolicy.streak} times consecutively and is marked blocked (🚫).`,
        ),
      );
    }
    deps.autoDevMetrics.recordRunOutcome(status === "cancelled" ? "cancelled" : "failed");
    if (failurePolicy.blocked && effectiveContext.mode === "loop") {
      await persistAutoDevRunArchiveBestEffort(deps, {
        workdir: input.workdir,
        sessionKey: input.sessionKey,
        conversationId: input.message.conversationId,
        requestId: input.requestId,
        workflowDiagRunId,
        startedAt: startedAtIso,
        endedAt: endedAtIso,
        status: status === "cancelled" ? "cancelled" : "failed",
        mode: effectiveContext.mode,
        loopRound: effectiveContext.loopRound,
        loopCompletedRuns: effectiveContext.loopCompletedRuns,
        loopMaxRuns: effectiveContext.loopMaxRuns,
        loopDeadlineAt: effectiveContext.loopDeadlineAt,
        taskId: activeTask.id,
        taskDescription: activeTask.description,
        taskLineIndex: activeTask.lineIndex,
        taskFinalStatus: activeTask.status,
        reviewerApproved: null,
        validationPassed: null,
        taskListPolicyPassed: null,
        completionPassed: null,
        completionReasons: [],
        gitCommitSummary: null,
        gitChangedFiles: null,
        releaseSummary: null,
        failureStreak: failurePolicy.streak,
        blocked: failurePolicy.blocked,
        error: formatError(error),
        workflowResult: null,
      });
      return;
    }
    await persistAutoDevRunArchiveBestEffort(deps, {
      workdir: input.workdir,
      sessionKey: input.sessionKey,
      conversationId: input.message.conversationId,
      requestId: input.requestId,
      workflowDiagRunId,
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      status: status === "cancelled" ? "cancelled" : "failed",
      mode: effectiveContext.mode,
      loopRound: effectiveContext.loopRound,
      loopCompletedRuns: effectiveContext.loopCompletedRuns,
      loopMaxRuns: effectiveContext.loopMaxRuns,
      loopDeadlineAt: effectiveContext.loopDeadlineAt,
      taskId: activeTask.id,
      taskDescription: activeTask.description,
      taskLineIndex: activeTask.lineIndex,
      taskFinalStatus: activeTask.status,
      reviewerApproved: null,
      validationPassed: null,
      taskListPolicyPassed: null,
      completionPassed: null,
      completionReasons: [],
      gitCommitSummary: null,
      gitChangedFiles: null,
      releaseSummary: null,
      failureStreak: failurePolicy.streak,
      blocked: failurePolicy.blocked,
      error: formatError(error),
      workflowResult: null,
    });
    throw error;
  }
}

interface PersistAutoDevRunArchiveBestEffortInput {
  workdir: string;
  sessionKey: string;
  conversationId: string;
  requestId: string;
  workflowDiagRunId: string;
  startedAt: string;
  endedAt: string;
  status: "succeeded" | "failed" | "cancelled";
  mode: "single" | "loop";
  loopRound: number;
  loopCompletedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAt: string | null;
  taskId: string;
  taskDescription: string;
  taskLineIndex: number;
  taskFinalStatus: string | null;
  reviewerApproved: boolean | null;
  validationPassed: boolean | null;
  taskListPolicyPassed: boolean | null;
  completionPassed: boolean | null;
  completionReasons: string[];
  gitCommitSummary: string | null;
  gitChangedFiles: string | null;
  releaseSummary: string | null;
  failureStreak: number | null;
  blocked: boolean | null;
  error: string | null;
  workflowResult: MultiAgentWorkflowRunResult | null;
}

async function persistAutoDevRunArchiveBestEffort(
  deps: AutoDevRunnerDeps,
  input: PersistAutoDevRunArchiveBestEffortInput,
): Promise<void> {
  const events = deps.listWorkflowDiagEvents(input.workflowDiagRunId, 2_000);
  const record: AutoDevRunArchiveRecord = {
    version: 1,
    archivedAt: new Date().toISOString(),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    status: input.status,
    workdir: input.workdir,
    sessionKey: input.sessionKey,
    conversationId: input.conversationId,
    requestId: input.requestId,
    workflowDiagRunId: input.workflowDiagRunId,
    mode: input.mode,
    loop: {
      round: input.loopRound,
      completedRuns: input.loopCompletedRuns,
      maxRuns: input.loopMaxRuns,
      deadlineAt: input.loopDeadlineAt,
    },
    task: {
      id: input.taskId,
      description: input.taskDescription,
      lineIndex: input.taskLineIndex,
      finalStatus: input.taskFinalStatus,
    },
    gate: {
      reviewerApproved: input.reviewerApproved,
      validationPassed: input.validationPassed,
      taskListPolicyPassed: input.taskListPolicyPassed,
      completionPassed: input.completionPassed,
      completionReasons: [...input.completionReasons],
    },
    git: {
      commitSummary: input.gitCommitSummary,
      changedFiles: input.gitChangedFiles,
      releaseSummary: input.releaseSummary,
    },
    failure: {
      streak: input.failureStreak,
      blocked: input.blocked,
      error: input.error,
    },
    workflowResult: input.workflowResult,
    events,
  };
  const archiveResult = await persistAutoDevRunArchive({
    enabled: deps.autoDevRunArchiveEnabled,
    archiveDir: deps.autoDevRunArchiveDir,
    workdir: input.workdir,
    logger: deps.logger,
    record,
  });
  if (archiveResult.written && archiveResult.filePath) {
    deps.logger.info("Persisted AutoDev run archive", {
      workflowDiagRunId: input.workflowDiagRunId,
      filePath: archiveResult.filePath,
      taskId: input.taskId,
      status: input.status,
    });
  }
}

async function reconcileAutoDevTaskFinalStatus(input: {
  workdir: string;
  taskListPath: string;
  task: AutoDevTask;
  expectedCurrentStatus: AutoDevTask["status"] | null;
  nextStatus: AutoDevTask["status"];
}): Promise<{ task: AutoDevTask; statusDriftDetected: boolean; observedStatus: AutoDevTask["status"] | null }> {
  const refreshed = await loadAutoDevContext(input.workdir);
  const latestTask = resolveAutoDevTask(refreshed.tasks, input.task.id, input.task.lineIndex) ?? input.task;
  const statusDriftDetected =
    input.expectedCurrentStatus !== null &&
    latestTask.status !== input.expectedCurrentStatus;
  if (latestTask.status === input.nextStatus) {
    return {
      task: latestTask,
      statusDriftDetected,
      observedStatus: latestTask.status,
    };
  }
  const reconciledTask = await updateAutoDevTaskStatus(input.taskListPath, latestTask, input.nextStatus);
  return {
    task: reconciledTask,
    statusDriftDetected,
    observedStatus: latestTask.status,
  };
}

async function guardAutoDevTaskListOwnership(input: {
  taskListPath: string;
  baselineContent: string;
}): Promise<TaskListMutationGuardResult> {
  try {
    const currentContent = await fs.readFile(input.taskListPath, "utf8");
    if (currentContent === input.baselineContent) {
      return {
        changed: false,
        restored: true,
        finalClean: true,
        error: null,
      };
    }

    await fs.writeFile(input.taskListPath, input.baselineContent, "utf8");
    const restoredContent = await fs.readFile(input.taskListPath, "utf8");
    const finalClean = restoredContent === input.baselineContent;
    return {
      changed: true,
      restored: finalClean,
      finalClean,
      error: null,
    };
  } catch (error) {
    return {
      changed: true,
      restored: false,
      finalClean: false,
      error: formatError(error),
    };
  }
}

function buildReviewerTaskListPolicyContextSummary(input: {
  outputLanguage: OutputLanguage;
  round: number;
  guard: TaskListMutationGuardResult;
}): string {
  const changed = input.guard.changed ? "yes" : "no";
  const restored = input.guard.restored ? "yes" : "no";
  const finalClean = input.guard.finalClean ? "yes" : "no";
  const error = input.guard.error ?? "none";
  if (input.outputLanguage === "en") {
    return [
      `round=${input.round}`,
      `changedSinceBaseline=${changed}`,
      `restoredBySystem=${restored}`,
      `finalClean=${finalClean}`,
      `error=${error}`,
      "policy: use this system block as the source of truth for TASK_LIST.md; do not reject by command-text hints alone.",
    ].join("\n");
  }
  return [
    `round=${input.round}`,
    `changedSinceBaseline=${changed}`,
    `restoredBySystem=${restored}`,
    `finalClean=${finalClean}`,
    `error=${error}`,
    "策略：TASK_LIST.md 判定以该系统块为准；不得仅凭命令文本痕迹拒绝。",
  ].join("\n");
}

function evaluateAutoDevCompletionGate(input: {
  reviewerApproved: boolean;
  validationPassed: boolean;
  taskListPolicyPassed: boolean;
  commitRequired: boolean;
  gitCommit: AutoDevGitCommitResult;
}): AutoDevCompletionGateResult {
  const reasons: AutoDevCompletionGateReason[] = [];
  if (!input.reviewerApproved) {
    reasons.push("reviewer_not_approved");
  }
  if (!input.validationPassed) {
    reasons.push("validation_not_passed");
  }
  if (!input.taskListPolicyPassed) {
    reasons.push("task_list_policy_violated");
  }
  if (input.commitRequired && input.gitCommit.kind !== "committed") {
    reasons.push("auto_commit_not_committed");
  }
  return {
    passed: reasons.length === 0,
    reasons,
  };
}

function inferAutoDevValidation(result: MultiAgentWorkflowRunResult, strictMode: boolean): AutoDevValidationInference {
  const combined = `${result.output}\n${result.review}`;
  const structuredValidationStatus = parseStructuredValidationStatus(combined);
  const exitCodes = parseAutoDevExitCodes(combined);
  if (exitCodes.length > 0) {
    const nonZeroCodes = exitCodes.filter((code) => Number.isFinite(code) && code !== 0);
    if (nonZeroCodes.length === 0) {
      return {
        passed: true,
        failureClass: null,
        evidenceSource: "structured",
      };
    }
    if (structuredValidationStatus === true && hasExpectedNonZeroExitEvidence(combined, nonZeroCodes)) {
      return {
        passed: true,
        failureClass: null,
        evidenceSource: "structured",
      };
    }
    return {
      passed: false,
      failureClass: "exit_codes_non_zero_unexpected",
      evidenceSource: "structured",
    };
  }

  if (structuredValidationStatus !== null) {
    return {
      passed: structuredValidationStatus,
      failureClass: structuredValidationStatus ? null : "structured_status_fail",
      evidenceSource: "structured",
    };
  }

  if (strictMode) {
    return {
      passed: false,
      failureClass: "strict_missing_structured_evidence",
      evidenceSource: "none",
    };
  }

  const scopedValidationText = resolveValidationScopeText(result.output, result.review);
  const scopedVerdict = inferValidationVerdictByText(scopedValidationText);
  if (scopedVerdict !== null) {
    return {
      passed: scopedVerdict,
      failureClass: scopedVerdict ? null : "scoped_text_failure",
      evidenceSource: "scoped_text",
    };
  }

  const fallbackVerdict = inferValidationVerdictByText(combined);
  if (fallbackVerdict !== null) {
    return {
      passed: fallbackVerdict,
      failureClass: fallbackVerdict ? null : "fallback_text_failure",
      evidenceSource: "fallback_text",
    };
  }
  return {
    passed: true,
    failureClass: null,
    evidenceSource: "none",
  };
}

function resolveValidationScopeText(output: string, review: string): string {
  const sections = [extractValidationSection(output), extractValidationSection(review)].filter(
    (section) => section.length > 0,
  );
  if (sections.length === 0) {
    return `${output}\n${review}`;
  }
  return sections.join("\n");
}

function extractValidationSection(text: string): string {
  if (!text.trim()) {
    return "";
  }

  const lines = text.split(/\r?\n/);
  const startPattern = /^\s*(?:#+\s*)?(?:VALIDATION|Validation(?:\s+Results?)?|验证结果|验证命令|验证)\s*[:：]?\s*(.*)$/i;
  const stopPattern =
    /^\s*(?:#+\s*)?(?:RISKS?|风险(?:与后续|说明)?|NEXT_STEPS|STATUS|ISSUES|SUGGESTIONS|BLOCKERS?|SUMMARY|改动文件|落盘文件|任务|最终可执行结果)\s*[:：]?\s*$/i;

  const collected: string[] = [];
  let capturing = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const startMatch = line.match(startPattern);
    if (startMatch) {
      capturing = true;
      const inline = startMatch[1].trim();
      if (inline) {
        collected.push(inline);
      }
      continue;
    }

    if (!capturing) {
      continue;
    }
    if (stopPattern.test(line)) {
      capturing = false;
      continue;
    }
    collected.push(line);
  }

  return collected.join("\n").trim();
}

function inferValidationVerdictByText(text: string): boolean | null {
  if (!text.trim()) {
    return null;
  }

  const failedCountMatches = [...text.matchAll(/\b([1-9]\d*)\s+failed\b/gi)];
  if (failedCountMatches.length > 0) {
    return false;
  }

  const chineseFailedCountMatches = [...text.matchAll(/([1-9]\d*)\s*(?:项|个|例|次)?\s*失败/gi)];
  if (chineseFailedCountMatches.length > 0) {
    return false;
  }

  const normalized = text
    .replace(/\b0+\s+failed\b/gi, "")
    .replace(/0+\s*(?:项|个|例|次)?\s*失败/gi, "");
  const hasExplicitFailure =
    /(?:\b(?:tests?\s+failed|test\s+run\s+failed|command\s+failed|validation\s+failed|build\s+failed|lint\s+failed|typecheck\s+failed|failed\s+with|not\s+passed)\b|(?:测试|验证|命令|构建|编译|lint|typecheck)(?:未通过|失败)|未通过|❌|\[FAIL\])/i.test(
      normalized,
    );
  if (hasExplicitFailure) {
    return false;
  }

  const hasExplicitSuccess =
    /(?:\b0+\s+failed\b|\b\d+\s+passed\b|\ball\s+pass(?:ed)?\b|✅|\[PASS\]|验证通过|测试通过|全部通过|全部\s*\[PASS\]|通过)/i.test(
      text,
    );
  if (hasExplicitSuccess) {
    return true;
  }

  return null;
}

function parseStructuredValidationStatus(text: string): boolean | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!/^(?:validation[\s_-]*status|验证状态)\s*[:：]/i.test(line)) {
      continue;
    }
    const value = line.replace(/^(?:validation[\s_-]*status|验证状态)\s*[:：]/i, "").trim().toLowerCase();
    if (!value) {
      continue;
    }
    if (/\b(?:fail|failed|error|not[\s_-]*pass(?:ed)?)\b/.test(value) || /(失败|未通过)/.test(value)) {
      return false;
    }
    if (/\b(?:pass|passed|ok|success)\b/.test(value) || /(通过|成功)/.test(value)) {
      return true;
    }
  }
  return null;
}

function parseAutoDevExitCodes(text: string): number[] {
  const codes: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const markerMatch = line.match(/__EXIT_CODES__\s*[:：]?\s*(.*)$/i);
    if (!markerMatch) {
      continue;
    }
    const payload = markerMatch[1];
    if (!payload) {
      continue;
    }
    for (const match of payload.matchAll(/(?:^|\s)[A-Za-z0-9_.:/-]+\s*=\s*(-?\d+)/g)) {
      const code = Number.parseInt(match[1], 10);
      if (Number.isFinite(code)) {
        codes.push(code);
      }
    }
  }
  return codes;
}

function hasExpectedNonZeroExitEvidence(text: string, nonZeroCodes: number[]): boolean {
  const explicitExpectedCodes = new Set<number>();
  let hasGenericExpectedNonZero = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!/(?:按预期|预期|as expected|expected(?:ly)?)/i.test(line)) {
      continue;
    }
    const lineMentionsNonZeroExpectation = /(?:non[-\s]?zero|非零|reject|拒绝|fail(?:ed)?|失败|exit|退出码|返回码)/i.test(line);
    if (lineMentionsNonZeroExpectation) {
      hasGenericExpectedNonZero = true;
    }
    for (const match of line.matchAll(/(?:exit|退出码|返回码)\s*[:=]?\s*(-?\d+)/gi)) {
      const code = Number.parseInt(match[1], 10);
      if (Number.isFinite(code) && code !== 0) {
        explicitExpectedCodes.add(code);
      }
    }
  }

  if (nonZeroCodes.every((code) => explicitExpectedCodes.has(code))) {
    return true;
  }
  if (!hasGenericExpectedNonZero) {
    return false;
  }
  return new Set(nonZeroCodes).size === 1;
}

function formatAutoDevCompletionGateReasons(
  reasons: AutoDevCompletionGateReason[],
  outputLanguage: OutputLanguage,
): string {
  if (reasons.length === 0) {
    return "N/A";
  }
  const labels = reasons.map((reason) => {
    if (reason === "reviewer_not_approved") {
      return outputLanguage === "en" ? "reviewer-not-approved" : "reviewer未批准";
    }
    if (reason === "validation_not_passed") {
      return outputLanguage === "en" ? "validation-not-passed" : "验证未通过";
    }
    if (reason === "task_list_policy_violated") {
      return outputLanguage === "en" ? "task-list-policy-violated" : "TASK_LIST写入策略违反";
    }
    return outputLanguage === "en" ? "auto-commit-not-committed" : "自动提交未成功";
  });
  return labels.join(", ");
}

function resolveAutoDevTask(
  tasks: AutoDevTask[],
  taskId: string | null,
  lineIndex: number | null,
): AutoDevTask | null {
  if (taskId && typeof lineIndex === "number" && Number.isFinite(lineIndex)) {
    const normalizedTaskId = taskId.trim().toLowerCase();
    const matchedByLine = tasks.find((task) => task.id.toLowerCase() === normalizedTaskId && task.lineIndex === lineIndex);
    if (matchedByLine) {
      return matchedByLine;
    }
  }
  return selectAutoDevTask(tasks, taskId);
}

async function failAutoDevOnGitPreflightError(
  deps: AutoDevRunnerDeps,
  input: AutoDevGitPreflightCheckInput,
): Promise<boolean> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  if (!deps.autoDevAutoCommit) {
    return false;
  }

  const preflight = await inspectAutoDevGitPreflight(input.workdir);
  if (preflight.state !== "dirty") {
    return false;
  }
  const autoStashEnabled = parseEnvBoolean(process.env.AUTODEV_PREFLIGHT_AUTO_STASH, false);
  if (autoStashEnabled) {
    const stashResult = await tryAutoDevPreflightAutoStash(input.workdir);
    if (stashResult.kind === "stashed") {
      await sendAutoDevNoticeBestEffort(deps, 
        input.conversationId,
        localize(
          `[CodeHarbor] AutoDev Git preflight：检测到脏工作区，已自动暂存后继续执行。
- stashRef: ${stashResult.stashRef}
- stashMessage: ${stashResult.stashMessage}
- tip: \`git stash list\` / \`git stash pop ${stashResult.stashRef}\``,
          `[CodeHarbor] AutoDev Git preflight: dirty worktree auto-stashed; continuing run.
- stashRef: ${stashResult.stashRef}
- stashMessage: ${stashResult.stashMessage}
- tip: \`git stash list\` / \`git stash pop ${stashResult.stashRef}\``,
        ),
      );
      return false;
    }
    if (stashResult.kind === "failed") {
      deps.logger.warn("AutoDev preflight auto-stash failed", {
        workdir: input.workdir,
        error: stashResult.error,
      });
    }
  }

  const endedAtIso = new Date().toISOString();
  const reason = preflight.reason ?? localize("运行前存在未提交改动", "working tree is dirty before run");
  const taskLabel = input.task ? `${input.task.id} ${input.task.description}`.trim() : "N/A";
  const changedPreview = preflight.dirtyFiles.slice(0, 5);
  const changedPreviewLine =
    changedPreview.length > 0
      ? `\n- dirtyFiles: ${changedPreview.join(", ")}${
          preflight.dirtyFiles.length > changedPreview.length
            ? ` ... (+${preflight.dirtyFiles.length - changedPreview.length})`
            : ""
        }`
      : "";

  deps.setAutoDevSnapshot(input.sessionKey, {
    state: "failed",
    startedAt: input.startedAtIso,
    endedAt: endedAtIso,
    taskId: input.task?.id ?? null,
    taskDescription: input.task?.description ?? null,
    approved: null,
    repairRounds: 0,
    error: `git preflight failed: ${reason}`,
    mode: input.mode,
    loopRound: input.loopRound,
    loopCompletedRuns: input.loopCompletedRuns,
    loopMaxRuns: input.loopMaxRuns,
    loopDeadlineAt: input.loopDeadlineAtIso,
    lastGitCommitSummary: null,
    lastGitCommitAt: null,
    lastReleaseSummary: null,
    lastReleaseAt: null,
  });
  deps.autoDevMetrics.recordRunOutcome("failed");

  await sendAutoDevNoticeBestEffort(deps, 
    input.conversationId,
    localize(
      `[CodeHarbor] AutoDev 已停止（Git preflight 未通过）。
- reason: ${reason}
- mode: ${input.mode}
- task: ${taskLabel}
- gitPreflight: dirty${changedPreviewLine}
- fix: \`git status\`
- fix: \`git add -A && git commit -m "chore: checkpoint before autodev run"\`
- fix: \`git stash --include-untracked\`（如需暂存）`,
      `[CodeHarbor] AutoDev stopped (Git preflight failed).
- reason: ${reason}
- mode: ${input.mode}
- task: ${taskLabel}
- gitPreflight: dirty${changedPreviewLine}
- fix: \`git status\`
- fix: \`git add -A && git commit -m "chore: checkpoint before autodev run"\`
- fix: \`git stash --include-untracked\` (if you need to stash changes)`,
    ),
  );
  return true;
}
