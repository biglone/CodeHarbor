import type { Logger } from "../logger";
import type { InboundMessage } from "../types";
import type { MultiAgentWorkflowRunResult } from "../workflow/multi-agent-workflow";
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
import { formatError } from "./helpers";
import { classifyExecutionOutcome } from "./workflow-status";

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
  recordAutoDevGitCommit: (sessionKey: string, taskId: string, result: AutoDevGitCommitResult) => void;
  resetAutoDevFailureStreak: (workdir: string, taskId: string) => void;
  applyAutoDevFailurePolicy: (input: {
    workdir: string;
    task: AutoDevTask;
    taskListPath: string;
  }) => Promise<AutoDevFailurePolicyResult>;
  autoDevMetrics: {
    recordRunOutcome: (outcome: "succeeded" | "failed" | "cancelled") => void;
    recordLoopStop: (reason: "no_task" | "drained" | "max_runs" | "deadline" | "stop_requested" | "task_incomplete") => void;
    recordTaskBlocked: () => void;
  };
}

interface RunAutoDevCommandInput {
  taskId: string | null;
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
  const context = await loadAutoDevContext(input.workdir);
  const activeContext: AutoDevRunContext = input.runContext ?? {
    mode: requestedTaskId ? "single" : "loop",
    loopRound: requestedTaskId ? 1 : 0,
    loopCompletedRuns: 0,
    loopMaxRuns: requestedTaskId ? 1 : deps.autoDevLoopMaxRuns,
    loopDeadlineAt:
      requestedTaskId || deps.autoDevLoopMaxMinutes <= 0
        ? null
        : new Date(Date.now() + deps.autoDevLoopMaxMinutes * 60_000).toISOString(),
  };
  if (!context.requirementsContent) {
    await deps.channelSendNotice(
      input.message.conversationId,
      `[CodeHarbor] AutoDev 需要 ${context.requirementsPath}，请先准备需求文档。`,
    );
    return;
  }
  if (!context.taskListContent) {
    await deps.channelSendNotice(
      input.message.conversationId,
      `[CodeHarbor] AutoDev 需要 ${context.taskListPath}，请先准备任务清单。`,
    );
    return;
  }
  if (context.tasks.length === 0) {
    await deps.channelSendNotice(
      input.message.conversationId,
      "[CodeHarbor] 未在 TASK_LIST.md 识别到任务（需包含任务 ID 与状态列）。",
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
        if (attemptedRuns >= activeContext.loopMaxRuns) {
          deps.autoDevMetrics.recordLoopStop("max_runs");
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
            `[CodeHarbor] AutoDev 循环执行已达到上限，已停止。
- attemptedRuns: ${attemptedRuns}
- completedRuns: ${completedRuns}
- loopMaxRuns: ${activeContext.loopMaxRuns}`,
          );
          return;
        }
        if (loopDeadlineAtMs !== null && Date.now() >= loopDeadlineAtMs) {
          deps.autoDevMetrics.recordLoopStop("deadline");
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
            `[CodeHarbor] AutoDev 循环执行已达到时间上限，已停止。
- attemptedRuns: ${attemptedRuns}
- completedRuns: ${completedRuns}
- loopDeadlineAt: ${loopDeadlineAtIso}`,
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
            await deps.channelSendNotice(input.message.conversationId, "[CodeHarbor] 当前没有可执行任务（pending/in_progress）。");
            return;
          }
          const summary = summarizeAutoDevTasks(loopContext.tasks);
          await deps.channelSendNotice(
            input.message.conversationId,
            `[CodeHarbor] AutoDev 循环执行完成
- completedRuns: ${completedRuns}
- remaining: pending=${summary.pending}, in_progress=${summary.inProgress}, blocked=${summary.blocked}, cancelled=${summary.cancelled}`,
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

        attemptedRuns += 1;
        await runAutoDevCommand(deps, {
          ...input,
          taskId: loopTask.id,
          runContext: {
            mode: "loop",
            loopRound: attemptedRuns,
            loopCompletedRuns: completedRuns,
            loopMaxRuns: activeContext.loopMaxRuns,
            loopDeadlineAt: loopDeadlineAtIso,
          },
        });

        const refreshed = await loadAutoDevContext(input.workdir);
        const refreshedTask = selectAutoDevTask(refreshed.tasks, loopTask.id);
        if (refreshedTask?.status === "completed") {
          completedRuns += 1;
        }
        if (refreshedTask && refreshedTask.status !== "completed") {
          deps.autoDevMetrics.recordLoopStop("task_incomplete");
          await deps.channelSendNotice(
            input.message.conversationId,
            `[CodeHarbor] AutoDev 循环执行暂停：任务 ${refreshedTask.id} 当前状态为 ${statusToSymbol(refreshedTask.status)}。请处理后继续。`,
          );
          return;
        }
      }
    } finally {
      deps.activeAutoDevLoopSessions.delete(input.sessionKey);
      deps.pendingAutoDevLoopStopRequests.delete(input.sessionKey);
    }
  }

  const selectedTask = selectAutoDevTask(context.tasks, requestedTaskId);
  if (!selectedTask) {
    if (requestedTaskId) {
      await deps.channelSendNotice(input.message.conversationId, `[CodeHarbor] 未找到任务 ${requestedTaskId}。`);
      return;
    }
    await deps.channelSendNotice(input.message.conversationId, "[CodeHarbor] 当前没有可执行任务（pending/in_progress）。");
    return;
  }
  if (selectedTask.status === "completed") {
    await deps.channelSendNotice(input.message.conversationId, `[CodeHarbor] 任务 ${selectedTask.id} 已完成（✅）。`);
    return;
  }
  if (selectedTask.status === "cancelled") {
    await deps.channelSendNotice(input.message.conversationId, `[CodeHarbor] 任务 ${selectedTask.id} 已取消（❌）。`);
    return;
  }

  const effectiveContext: AutoDevRunContext = {
    mode: activeContext.mode,
    loopRound: Math.max(1, activeContext.loopRound),
    loopCompletedRuns: Math.max(0, activeContext.loopCompletedRuns),
    loopMaxRuns: Math.max(1, activeContext.loopMaxRuns),
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
    `AutoDev 启动任务 ${activeTask.id}: ${activeTask.description}`,
  );

  await deps.channelSendNotice(
    input.message.conversationId,
    `[CodeHarbor] AutoDev 启动任务 ${activeTask.id}: ${activeTask.description}`,
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
      reason: "reviewer 未批准，未自动提交",
    };
    let releaseResult: AutoDevReleaseResult = {
      kind: "skipped",
      reason: "reviewer 未批准，未自动发布",
    };
    if (result.approved) {
      finalTask = await updateAutoDevTaskStatus(context.taskListPath, activeTask, "completed");
      gitCommit = await tryAutoDevGitCommit({
        workdir: input.workdir,
        task: finalTask,
        baseline: gitBaseline,
        workflowResult: result,
        autoCommit: deps.autoDevAutoCommit,
        logger: deps.logger,
      });
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
      `[CodeHarbor] AutoDev 任务结果
- task: ${finalTask.id}
- reviewer approved: ${result.approved ? "yes" : "no"}
- task status: ${statusToSymbol(finalTask.status)}
- git commit: ${formatAutoDevGitCommitResult(gitCommit)}
- git changed files: ${formatAutoDevGitChangedFiles(gitCommit)}
- release: ${formatAutoDevReleaseResult(releaseResult)}
- nextTask: ${nextTask ? formatTaskForDisplay(nextTask) : "N/A"}`,
    );
    deps.appendWorkflowDiagEvent(
      workflowDiagRunId,
      "autodev",
      "autodev",
      0,
      `AutoDev 任务结果: task=${finalTask.id}, reviewerApproved=${result.approved ? "yes" : "no"}, taskStatus=${statusToSymbol(finalTask.status)}, gitCommit=${formatAutoDevGitCommitResult(gitCommit)}, release=${formatAutoDevReleaseResult(releaseResult)}`,
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
      `AutoDev 失败: ${formatError(error)}, streak=${failurePolicy.streak}, blocked=${
        failurePolicy.blocked ? "yes" : "no"
      }`,
    );
    if (failurePolicy.blocked) {
      deps.autoDevMetrics.recordTaskBlocked();
      await deps.channelSendNotice(
        input.message.conversationId,
        `[CodeHarbor] AutoDev 任务 ${activeTask.id} 连续失败 ${failurePolicy.streak} 次，已标记为阻塞（🚫）。`,
      );
    }
    deps.autoDevMetrics.recordRunOutcome(status === "cancelled" ? "cancelled" : "failed");
    if (failurePolicy.blocked && effectiveContext.mode === "loop") {
      return;
    }
    throw error;
  }
}

async function failAutoDevOnGitPreflightError(
  deps: AutoDevRunnerDeps,
  input: AutoDevGitPreflightCheckInput,
): Promise<boolean> {
  if (!deps.autoDevAutoCommit) {
    return false;
  }

  const preflight = await inspectAutoDevGitPreflight(input.workdir);
  if (preflight.state !== "dirty") {
    return false;
  }

  const endedAtIso = new Date().toISOString();
  const reason = preflight.reason ?? "运行前存在未提交改动";
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
    `[CodeHarbor] AutoDev 已停止（Git preflight 未通过）。
- reason: ${reason}
- mode: ${input.mode}
- task: ${taskLabel}
- gitPreflight: dirty${changedPreviewLine}
- fix: \`git status\`
- fix: \`git add -A && git commit -m "chore: checkpoint before autodev run"\`
- fix: \`git stash --include-untracked\`（如需暂存）`,
  );
  return true;
}

async function handleAutoDevLoopStopIfRequested(
  deps: AutoDevRunnerDeps,
  input: AutoDevLoopStopCheckInput,
): Promise<boolean> {
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
      `[CodeHarbor] AutoDev 循环执行已停止。
- completedRuns: ${input.completedRuns}`,
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
      `[CodeHarbor] AutoDev 循环执行已按请求停止（当前任务已完成）。
- attemptedRuns: ${input.attemptedRuns}
- completedRuns: ${input.completedRuns}`,
    );
    return true;
  }

  return false;
}
