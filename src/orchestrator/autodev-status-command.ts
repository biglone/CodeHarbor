import type { InboundMessage } from "../types";
import type { OutputLanguage } from "../config";
import { formatTaskForDisplay, loadAutoDevContext, summarizeAutoDevTasks } from "../workflow/autodev";
import { inspectAutoDevGitPreflight } from "./autodev-git";
import type { AutoDevRunSnapshot } from "./autodev-runner";
import { createIdleAutoDevSnapshot } from "./autodev-snapshot";
import { healAutoDevTaskStatuses } from "./autodev-status-heal";
import { formatError, formatRunWindowDuration, formatWorkflowDiagRunDuration } from "./helpers";
import {
  formatAutoDevStatusRunSummaries,
  formatAutoDevStatusStageTrace,
  localizeWorkflowDiagMessageForDisplay,
  type WorkflowDiagEventRecord,
  type WorkflowDiagRunRecord,
} from "./workflow-diag";
import { byOutputLanguage } from "./output-language";

interface RoleSkillStatusLike {
  enabled: boolean;
  mode: string;
  maxChars: number;
  override: string;
  loaded: string;
}

interface AutoDevStatusCommandDeps {
  outputLanguage: OutputLanguage;
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevAutoReleaseEnabled: boolean;
  autoDevAutoReleasePush: boolean;
  autoDevMaxConsecutiveFailures: number;
  autoDevRunArchiveEnabled: boolean;
  autoDevRunArchiveDir: string;
  autoDevDetailedProgressDefaultEnabled: boolean;
  autoDevInitEnhancementEnabled: boolean;
  autoDevInitEnhancementTimeoutMs: number;
  autoDevInitEnhancementMaxChars: number;
  getAutoDevSnapshot: (sessionKey: string) => AutoDevRunSnapshot | null;
  hasActiveAutoDevLoopSession: (sessionKey: string) => boolean;
  hasPendingAutoDevLoopStopRequest: (sessionKey: string) => boolean;
  hasPendingStopRequest: (sessionKey: string) => boolean;
  isAutoDevDetailedProgressEnabled: (sessionKey: string) => boolean;
  buildWorkflowRoleSkillStatus: (sessionKey: string) => RoleSkillStatusLike;
  listWorkflowDiagRunsBySession: (kind: "autodev", sessionKey: string, limit: number) => WorkflowDiagRunRecord[];
  listWorkflowDiagEvents: (runId: string, limit?: number) => WorkflowDiagEventRecord[];
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

interface AutoDevStatusCommandInput {
  sessionKey: string;
  message: InboundMessage;
  workdir: string;
}

export async function handleAutoDevStatusCommand(
  deps: AutoDevStatusCommandDeps,
  input: AutoDevStatusCommandInput,
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  const snapshot = deps.getAutoDevSnapshot(input.sessionKey) ?? createIdleAutoDevSnapshot();
  try {
    let context = await loadAutoDevContext(input.workdir);
    const recentRuns = deps.listWorkflowDiagRunsBySession("autodev", input.sessionKey, 20);
    const healedStatuses = await healAutoDevTaskStatuses({
      taskListPath: context.taskListPath,
      tasks: context.tasks,
      runs: recentRuns,
      targetTaskIds: null,
    });
    if (healedStatuses.length > 0) {
      context = await loadAutoDevContext(input.workdir);
    }
    const summary = summarizeAutoDevTasks(context.tasks);
    const gitPreflight = await inspectAutoDevGitPreflight(input.workdir);
    const inProgressTask = context.tasks.find((task) => task.status === "in_progress") ?? null;
    const runDuration = formatRunWindowDuration(snapshot.startedAt, snapshot.endedAt);
    const loopActive = deps.hasActiveAutoDevLoopSession(input.sessionKey) ? "yes" : "no";
    const loopStopRequested = deps.hasPendingAutoDevLoopStopRequest(input.sessionKey) ? "yes" : "no";
    const stopRequested = deps.hasPendingStopRequest(input.sessionKey) ? "yes" : "no";
    const detailedProgress = deps.isAutoDevDetailedProgressEnabled(input.sessionKey) ? "on" : "off";
    const detailedProgressDefault = deps.autoDevDetailedProgressDefaultEnabled ? "on" : "off";
    const roleSkillStatus = deps.buildWorkflowRoleSkillStatus(input.sessionKey);
    const latestRun = recentRuns[0] ?? null;
    const stageEvents = latestRun ? deps.listWorkflowDiagEvents(latestRun.runId, 12) : [];
    const gitPreflightReason = gitPreflight.reason
      ? localizeWorkflowDiagMessageForDisplay(gitPreflight.reason, deps.outputLanguage)
      : "N/A";
    const runGitCommitSummary = snapshot.lastGitCommitSummary
      ? localizeWorkflowDiagMessageForDisplay(snapshot.lastGitCommitSummary, deps.outputLanguage)
      : "N/A";
    const runReleaseSummary = snapshot.lastReleaseSummary
      ? localizeWorkflowDiagMessageForDisplay(snapshot.lastReleaseSummary, deps.outputLanguage)
      : "N/A";
    const latestStageEvent = stageEvents.length > 0 ? stageEvents[stageEvents.length - 1] : null;
    const latestStageSummary = latestStageEvent
      ? `stage=${latestStageEvent.stage}, round=${latestStageEvent.round}, at=${latestStageEvent.at}, message=${localizeWorkflowDiagMessageForDisplay(
          latestStageEvent.message,
          deps.outputLanguage,
        )}`
      : "N/A";
    const latestRunLastStage = latestRun?.lastStage
      ? `${latestRun.lastStage}${
          latestRun.lastMessage
            ? `(${localizeWorkflowDiagMessageForDisplay(latestRun.lastMessage, deps.outputLanguage)})`
            : ""
        }`
      : "N/A";
    const autoReleasePushWarning =
      deps.autoDevAutoReleaseEnabled && !deps.autoDevAutoReleasePush
        ? localize(
            `\n- warning: autoRelease=on 但 autoReleasePush=off；发布提交不会自动推送，请手动执行 \`git push\` 触发 CI 发布`,
            `\n- warning: autoRelease=on while autoReleasePush=off; release commit will not be pushed automatically. Run \`git push\` to trigger CI release`,
          )
        : "";
    const taskAutoHealSummary =
      healedStatuses.length === 0
        ? "none"
        : healedStatuses
            .map((item) => `${item.taskId}:${item.from}->${item.to}`)
            .join(", ");
    const currentTask =
      snapshot.taskId && snapshot.taskDescription
        ? deps.outputLanguage === "en"
          ? snapshot.taskId
          : `${snapshot.taskId} ${snapshot.taskDescription}`.trim()
        : snapshot.taskId
          ? snapshot.taskId
          : inProgressTask
            ? deps.outputLanguage === "en"
              ? inProgressTask.id
              : formatTaskForDisplay(inProgressTask)
            : "N/A";

    if (deps.outputLanguage === "en") {
      await deps.sendNotice(
        input.message.conversationId,
        `[CodeHarbor] AutoDev status
- workdir: ${input.workdir}
- REQUIREMENTS.md: ${context.requirementsContent ? "found" : "missing"}
- TASK_LIST.md: ${context.taskListContent ? "found" : "missing"}
- tasks: total=${summary.total}, pending=${summary.pending}, in_progress=${summary.inProgress}, completed=${summary.completed}, blocked=${summary.blocked}, cancelled=${summary.cancelled}
- taskAutoHeal: ${taskAutoHealSummary}
- gitPreflight: ${gitPreflight.state}
- config: loopMaxRuns=${deps.autoDevLoopMaxRuns}, loopMaxMinutes=${deps.autoDevLoopMaxMinutes}, autoCommit=${deps.autoDevAutoCommit ? "on" : "off"}, autoRelease=${deps.autoDevAutoReleaseEnabled ? "on" : "off"}, autoReleasePush=${deps.autoDevAutoReleasePush ? "on" : "off"}, maxConsecutiveFailures=${deps.autoDevMaxConsecutiveFailures}, runArchive=${deps.autoDevRunArchiveEnabled ? "on" : "off"}, runArchiveDir=${deps.autoDevRunArchiveDir}, initEnhancement=${deps.autoDevInitEnhancementEnabled ? "on" : "off"}, initEnhancementTimeoutMs=${deps.autoDevInitEnhancementTimeoutMs}, initEnhancementMaxChars=${deps.autoDevInitEnhancementMaxChars}, detailedProgress=${detailedProgress} (default=${detailedProgressDefault})
- gitPreflightReason: ${gitPreflightReason}${autoReleasePushWarning}
- roleSkills: enabled=${roleSkillStatus.enabled ? "on" : "off"}, mode=${roleSkillStatus.mode}, maxChars=${roleSkillStatus.maxChars}, override=${roleSkillStatus.override}
- roleSkillsLoaded: ${roleSkillStatus.loaded}
- runState: ${snapshot.state}
- currentTask: ${currentTask}
- runWindow: startedAt=${snapshot.startedAt ?? "N/A"}, endedAt=${snapshot.endedAt ?? "N/A"}, duration=${runDuration}
- runMode: ${snapshot.mode}
- runLoop: round=${snapshot.loopRound}, completed=${snapshot.loopCompletedRuns}/${snapshot.loopMaxRuns}, deadline=${snapshot.loopDeadlineAt ?? "N/A"}
- runControl: loopActive=${loopActive}, loopStopRequested=${loopStopRequested}, stopRequested=${stopRequested}
- runApproved: ${snapshot.approved === null ? "N/A" : snapshot.approved ? "yes" : "no"}
- runError: ${snapshot.error ?? "N/A"}
- runGitCommit: ${runGitCommitSummary}
- runGitCommitAt: ${snapshot.lastGitCommitAt ?? "N/A"}
- runRelease: ${runReleaseSummary}
- runReleaseAt: ${snapshot.lastReleaseAt ?? "N/A"}
- workflowDiag: runId=${latestRun?.runId ?? "N/A"}, status=${latestRun?.status ?? "N/A"}, startedAt=${latestRun?.startedAt ?? "N/A"}, updatedAt=${latestRun?.updatedAt ?? "N/A"}, duration=${latestRun ? formatWorkflowDiagRunDuration(latestRun) : "N/A"}
- workflowDiagLastStage: ${latestRunLastStage}
- workflowStage: ${latestStageSummary}
- recentRuns:
${formatAutoDevStatusRunSummaries(recentRuns, deps.outputLanguage)}
- stageTrace:
${formatAutoDevStatusStageTrace(stageEvents, deps.outputLanguage)}`,
      );
      return;
    }

    await deps.sendNotice(
      input.message.conversationId,
      `[CodeHarbor] AutoDev 状态
- workdir: ${input.workdir}
- REQUIREMENTS.md: ${context.requirementsContent ? "found" : "missing"}
- TASK_LIST.md: ${context.taskListContent ? "found" : "missing"}
- tasks: total=${summary.total}, pending=${summary.pending}, in_progress=${summary.inProgress}, completed=${summary.completed}, blocked=${summary.blocked}, cancelled=${summary.cancelled}
- taskAutoHeal: ${taskAutoHealSummary}
- gitPreflight: ${gitPreflight.state}
- config: loopMaxRuns=${deps.autoDevLoopMaxRuns}, loopMaxMinutes=${deps.autoDevLoopMaxMinutes}, autoCommit=${deps.autoDevAutoCommit ? "on" : "off"}, autoRelease=${deps.autoDevAutoReleaseEnabled ? "on" : "off"}, autoReleasePush=${deps.autoDevAutoReleasePush ? "on" : "off"}, maxConsecutiveFailures=${deps.autoDevMaxConsecutiveFailures}, runArchive=${deps.autoDevRunArchiveEnabled ? "on" : "off"}, runArchiveDir=${deps.autoDevRunArchiveDir}, initEnhancement=${deps.autoDevInitEnhancementEnabled ? "on" : "off"}, initEnhancementTimeoutMs=${deps.autoDevInitEnhancementTimeoutMs}, initEnhancementMaxChars=${deps.autoDevInitEnhancementMaxChars}, detailedProgress=${detailedProgress} (default=${detailedProgressDefault})
- gitPreflightReason: ${gitPreflightReason}${autoReleasePushWarning}
- roleSkills: enabled=${roleSkillStatus.enabled ? "on" : "off"}, mode=${roleSkillStatus.mode}, maxChars=${roleSkillStatus.maxChars}, override=${roleSkillStatus.override}
- roleSkillsLoaded: ${roleSkillStatus.loaded}
- runState: ${snapshot.state}
- currentTask: ${currentTask}
- runWindow: startedAt=${snapshot.startedAt ?? "N/A"}, endedAt=${snapshot.endedAt ?? "N/A"}, duration=${runDuration}
- runMode: ${snapshot.mode}
- runLoop: round=${snapshot.loopRound}, completed=${snapshot.loopCompletedRuns}/${snapshot.loopMaxRuns}, deadline=${snapshot.loopDeadlineAt ?? "N/A"}
- runControl: loopActive=${loopActive}, loopStopRequested=${loopStopRequested}, stopRequested=${stopRequested}
- runApproved: ${snapshot.approved === null ? "N/A" : snapshot.approved ? "yes" : "no"}
- runError: ${snapshot.error ?? "N/A"}
- runGitCommit: ${runGitCommitSummary}
- runGitCommitAt: ${snapshot.lastGitCommitAt ?? "N/A"}
- runRelease: ${runReleaseSummary}
- runReleaseAt: ${snapshot.lastReleaseAt ?? "N/A"}
- workflowDiag: runId=${latestRun?.runId ?? "N/A"}, status=${latestRun?.status ?? "N/A"}, startedAt=${latestRun?.startedAt ?? "N/A"}, updatedAt=${latestRun?.updatedAt ?? "N/A"}, duration=${latestRun ? formatWorkflowDiagRunDuration(latestRun) : "N/A"}
- workflowDiagLastStage: ${latestRunLastStage}
- workflowStage: ${latestStageSummary}
- recentRuns:
${formatAutoDevStatusRunSummaries(recentRuns, deps.outputLanguage)}
- stageTrace:
${formatAutoDevStatusStageTrace(stageEvents, deps.outputLanguage)}`,
    );
  } catch (error) {
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 状态读取失败: ${formatError(error)}`,
        `[CodeHarbor] Failed to read AutoDev status: ${formatError(error)}`,
      ),
    );
  }
}
