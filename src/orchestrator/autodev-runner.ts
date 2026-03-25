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
  tryAutoDevGitCommit,
  type AutoDevGitCommitResult,
} from "./autodev-git";
import {
  tryAutoDevTaskRelease,
  type AutoDevReleaseResult,
} from "./autodev-release";
import {
  formatAutoDevGitChangedFiles,
  formatAutoDevGitCommitResult,
  formatAutoDevReleaseResult,
} from "./diagnostic-formatters";
import { healAutoDevTaskStatuses } from "./autodev-status-heal";
import { formatError } from "./helpers";
import { classifyExecutionOutcome } from "./workflow-status";
import { byOutputLanguage } from "./output-language";
import type { WorkflowDiagRunRecord } from "./workflow-diag";

export interface AutoDevRunSnapshot {
  state: "idle" | "running" | "succeeded" | "failed";
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
  | "auto_commit_not_committed";

interface AutoDevCompletionGateResult {
  passed: boolean;
  reasons: AutoDevCompletionGateReason[];
}

interface AutoDevLoopStopCheckInput {
  sessionKey: string;
  conversationId: string;
  loopStartedAt: number;
  attemptedRuns: number;
  completedRuns: number;
  loopMaxRuns: number;
  loopDeadlineAtIso: string | null;
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

interface RunWorkflowCommandInput {
  objective: string;
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
  workdir: string;
  diagRunId: string;
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
  recordAutoDevGitCommit: (sessionKey: string, taskId: string, result: AutoDevGitCommitResult) => void;
  resetAutoDevFailureStreak: (workdir: string, taskId: string) => void;
  applyAutoDevFailurePolicy: (input: {
    workdir: string;
    task: AutoDevTask;
    taskListPath: string;
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
    await deps.channelSendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 状态自愈：已根据最近运行记录修正任务状态。
- changes: ${healSummary}`,
        `[CodeHarbor] AutoDev status self-heal applied from recent run records.
- changes: ${healSummary}`,
      ),
    );
  }

  if (!context.requirementsContent) {
    await deps.channelSendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 需要 ${context.requirementsPath}，请先准备需求文档。`,
        `[CodeHarbor] AutoDev requires ${context.requirementsPath}. Please prepare the requirements document first.`,
      ),
    );
    return;
  }
  if (!context.taskListContent) {
    await deps.channelSendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 需要 ${context.taskListPath}，请先准备任务清单。`,
        `[CodeHarbor] AutoDev requires ${context.taskListPath}. Please prepare the task list first.`,
      ),
    );
    return;
  }
  if (context.tasks.length === 0) {
    await deps.channelSendNotice(
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
    const loopDeadlineAtMs = loopDeadlineAtIso ? Date.parse(loopDeadlineAtIso) : null;
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
        if (activeContext.loopMaxRuns > 0 && attemptedRuns >= activeContext.loopMaxRuns) {
          deps.autoDevMetrics.recordLoopStop("max_runs");
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
          await deps.channelSendNotice(
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
          return;
        }
        if (loopDeadlineAtMs !== null && Date.now() >= loopDeadlineAtMs) {
          deps.autoDevMetrics.recordLoopStop("deadline");
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
          await deps.channelSendNotice(
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

        const loopContext = await loadAutoDevContext(input.workdir);
        const loopTask = selectAutoDevTask(loopContext.tasks);
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
            await deps.channelSendNotice(
              input.message.conversationId,
              localize(
                "[CodeHarbor] 当前没有可执行任务（pending/in_progress）。",
                "[CodeHarbor] No executable tasks (pending/in_progress).",
              ),
            );
            return;
          }
          const summary = summarizeAutoDevTasks(loopContext.tasks);
          await deps.channelSendNotice(
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

        const taskListBeforeRun = loopContext.taskListContent ?? "";
        attemptedRuns += 1;
        await runAutoDevCommand(deps, {
          ...input,
          taskId: loopTask.id,
          taskLineIndex: loopTask.lineIndex,
          runContext: {
            mode: "loop",
            loopRound: attemptedRuns,
            loopCompletedRuns: completedRuns,
            loopMaxRuns: activeContext.loopMaxRuns,
            loopDeadlineAt: loopDeadlineAtIso,
          },
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
          await deps.channelSendNotice(
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
          await deps.channelSendNotice(
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
      await deps.channelSendNotice(
        input.message.conversationId,
        localize(`[CodeHarbor] 未找到任务 ${requestedTaskId}。`, `[CodeHarbor] Task ${requestedTaskId} was not found.`),
      );
      return;
    }
    await deps.channelSendNotice(
      input.message.conversationId,
      localize(
        "[CodeHarbor] 当前没有可执行任务（pending/in_progress）。",
        "[CodeHarbor] No executable tasks (pending/in_progress).",
      ),
    );
    return;
  }
  if (selectedTask.status === "completed") {
    await deps.channelSendNotice(
      input.message.conversationId,
      localize(`[CodeHarbor] 任务 ${selectedTask.id} 已完成（✅）。`, `[CodeHarbor] Task ${selectedTask.id} is already completed (✅).`),
    );
    return;
  }
  if (selectedTask.status === "cancelled") {
    await deps.channelSendNotice(
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
  let promotedToInProgress = false;
  if (selectedTask.status === "pending") {
    activeTask = await updateAutoDevTaskStatus(context.taskListPath, selectedTask, "in_progress");
    promotedToInProgress = true;
  }

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
  const workflowDiagRunId = deps.beginWorkflowDiagRun({
    kind: "autodev",
    sessionKey: input.sessionKey,
    conversationId: input.message.conversationId,
    requestId: input.requestId,
    objective: buildAutoDevObjective(activeTask),
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

  await deps.channelSendNotice(
    input.message.conversationId,
    localize(
      `[CodeHarbor] AutoDev 启动任务 ${activeTask.id}: ${activeTask.description}`,
      `[CodeHarbor] AutoDev started task ${activeTask.id}: ${activeTask.description}`,
    ),
  );

  try {
    const result = await deps.runWorkflowCommand({
      objective: buildAutoDevObjective(activeTask),
      sessionKey: input.sessionKey,
      message: input.message,
      requestId: input.requestId,
      workdir: input.workdir,
      diagRunId: workflowDiagRunId,
    });
    if (!result) {
      return;
    }

    let finalTask = activeTask;
    let gitCommit: AutoDevGitCommitResult = {
      kind: "skipped",
      reason: localize("reviewer 未批准，未自动提交", "reviewer not approved; auto commit skipped"),
    };
    let releaseResult: AutoDevReleaseResult = {
      kind: "skipped",
      reason: localize("reviewer 未批准，未自动发布", "reviewer not approved; auto release skipped"),
    };
    const validationPassed = inferAutoDevValidationPassed(result);
    const markCompletedCandidate = result.approved && validationPassed;
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
      await deps.channelSendNotice(input.message.conversationId, driftMessage);
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
      state: "succeeded",
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
      lastReleaseSummary: formatAutoDevReleaseResult(releaseResult),
      lastReleaseAt: releaseResult.kind === "released" ? new Date().toISOString() : null,
    });
    deps.autoDevMetrics.recordRunOutcome("succeeded");

    const refreshed = await loadAutoDevContext(input.workdir);
    const nextTask = selectAutoDevTask(refreshed.tasks);
    await deps.channelSendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 任务结果
- task: ${finalTask.id}
- reviewer approved: ${result.approved ? "yes" : "no"}
- completionGate: ${completionGate.passed ? "passed" : "failed"}
- completionGateReasons: ${
          completionGate.passed ? "N/A" : formatAutoDevCompletionGateReasons(completionGate.reasons, deps.outputLanguage)
        }
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
        }, taskStatus=${statusToSymbol(finalTask.status)}, gitCommit=${formatAutoDevGitCommitResult(gitCommit)}, release=${formatAutoDevReleaseResult(releaseResult)}`,
        `AutoDev task result: task=${finalTask.id}, reviewerApproved=${result.approved ? "yes" : "no"}, completionGate=${
          completionGate.passed ? "passed" : "failed"
        }, taskStatus=${statusToSymbol(finalTask.status)}, gitCommit=${formatAutoDevGitCommitResult(gitCommit)}, release=${formatAutoDevReleaseResult(releaseResult)}`,
      ),
    );
  } catch (error) {
    const failurePolicy = await deps.applyAutoDevFailurePolicy({
      workdir: input.workdir,
      task: activeTask,
      taskListPath: context.taskListPath,
    });
    activeTask = failurePolicy.task;
    if (promotedToInProgress && !failurePolicy.blocked) {
      try {
        await updateAutoDevTaskStatus(context.taskListPath, activeTask, "pending");
      } catch (restoreError) {
        deps.logger.warn("Failed to restore AutoDev task status after failure", {
          taskId: activeTask.id,
          error: formatError(restoreError),
        });
      }
    }

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
      await deps.channelSendNotice(
        input.message.conversationId,
        localize(
          `[CodeHarbor] AutoDev 任务 ${activeTask.id} 连续失败 ${failurePolicy.streak} 次，已标记为阻塞（🚫）。`,
          `[CodeHarbor] AutoDev task ${activeTask.id} failed ${failurePolicy.streak} times consecutively and is marked blocked (🚫).`,
        ),
      );
    }
    deps.autoDevMetrics.recordRunOutcome(status === "cancelled" ? "cancelled" : "failed");
    if (failurePolicy.blocked && effectiveContext.mode === "loop") {
      return;
    }
    throw error;
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

function evaluateAutoDevCompletionGate(input: {
  reviewerApproved: boolean;
  validationPassed: boolean;
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
  if (input.commitRequired && input.gitCommit.kind !== "committed") {
    reasons.push("auto_commit_not_committed");
  }
  return {
    passed: reasons.length === 0,
    reasons,
  };
}

function inferAutoDevValidationPassed(result: MultiAgentWorkflowRunResult): boolean {
  const combined = `${result.output}\n${result.review}`;
  const hasExplicitFailure = /\b(tests?\s+failed|failed\b|timeout|timed out|hang|hung|未通过|失败|卡住|挂起|❌)\b/i.test(combined);
  if (hasExplicitFailure) {
    return false;
  }
  return true;
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

  await deps.channelSendNotice(
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

async function handleAutoDevLoopStopIfRequested(
  deps: AutoDevRunnerDeps,
  input: AutoDevLoopStopCheckInput,
): Promise<boolean> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  if (deps.consumePendingStopRequest(input.sessionKey)) {
    deps.autoDevMetrics.recordLoopStop("stop_requested");
    const endedAtIso = new Date().toISOString();
    deps.setAutoDevSnapshot(input.sessionKey, {
      state: "idle",
      startedAt: new Date(input.loopStartedAt).toISOString(),
      endedAt: endedAtIso,
      taskId: null,
      taskDescription: null,
      approved: null,
      repairRounds: 0,
      error: "stopped by /stop",
      mode: "loop",
      loopRound: input.attemptedRuns,
      loopCompletedRuns: input.completedRuns,
      loopMaxRuns: input.loopMaxRuns,
      loopDeadlineAt: input.loopDeadlineAtIso,
      lastGitCommitSummary: null,
      lastGitCommitAt: null,
    });
    await deps.channelSendNotice(
      input.conversationId,
      localize(
        `[CodeHarbor] AutoDev 循环执行已停止。
- completedRuns: ${input.completedRuns}`,
        `[CodeHarbor] AutoDev loop stopped.
- completedRuns: ${input.completedRuns}`,
      ),
    );
    return true;
  }

  if (deps.consumePendingAutoDevLoopStopRequest(input.sessionKey)) {
    deps.autoDevMetrics.recordLoopStop("stop_requested");
    const endedAtIso = new Date().toISOString();
    deps.setAutoDevSnapshot(input.sessionKey, {
      state: "succeeded",
      startedAt: new Date(input.loopStartedAt).toISOString(),
      endedAt: endedAtIso,
      taskId: null,
      taskDescription: null,
      approved: null,
      repairRounds: 0,
      error: null,
      mode: "loop",
      loopRound: input.attemptedRuns,
      loopCompletedRuns: input.completedRuns,
      loopMaxRuns: input.loopMaxRuns,
      loopDeadlineAt: input.loopDeadlineAtIso,
      lastGitCommitSummary: null,
      lastGitCommitAt: null,
    });
    await deps.channelSendNotice(
      input.conversationId,
      localize(
        `[CodeHarbor] AutoDev 循环执行已按请求停止（当前任务已完成）。
- attemptedRuns: ${input.attemptedRuns}
- completedRuns: ${input.completedRuns}`,
        `[CodeHarbor] AutoDev loop stopped as requested (current task is complete).
- attemptedRuns: ${input.attemptedRuns}
- completedRuns: ${input.completedRuns}`,
      ),
    );
    return true;
  }

  return false;
}
