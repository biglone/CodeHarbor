import type { InboundMessage } from "../types";
import { formatTaskForDisplay, loadAutoDevContext, summarizeAutoDevTasks } from "../workflow/autodev";
import { inspectAutoDevGitPreflight } from "./autodev-git";
import type { AutoDevRunSnapshot } from "./autodev-runner";
import { createIdleAutoDevSnapshot } from "./autodev-snapshot";
import { formatError, formatRunWindowDuration, formatWorkflowDiagRunDuration } from "./helpers";
import {
  formatAutoDevStatusRunSummaries,
  formatAutoDevStatusStageTrace,
  type WorkflowDiagEventRecord,
  type WorkflowDiagRunRecord,
} from "./workflow-diag";

interface RoleSkillStatusLike {
  enabled: boolean;
  mode: string;
  maxChars: number;
  override: string;
  loaded: string;
}

interface AutoDevStatusCommandDeps {
  autoDevLoopMaxRuns: number;
  autoDevLoopMaxMinutes: number;
  autoDevAutoCommit: boolean;
  autoDevAutoReleaseEnabled: boolean;
  autoDevAutoReleasePush: boolean;
  autoDevMaxConsecutiveFailures: number;
  autoDevDetailedProgressDefaultEnabled: boolean;
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
  const snapshot = deps.getAutoDevSnapshot(input.sessionKey) ?? createIdleAutoDevSnapshot();
  try {
    const context = await loadAutoDevContext(input.workdir);
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
    const recentRuns = deps.listWorkflowDiagRunsBySession("autodev", input.sessionKey, 3);
    const latestRun = recentRuns[0] ?? null;
    const stageEvents = latestRun ? deps.listWorkflowDiagEvents(latestRun.runId, 12) : [];
    const latestStageEvent = stageEvents.length > 0 ? stageEvents[stageEvents.length - 1] : null;
    const latestStageSummary = latestStageEvent
      ? `stage=${latestStageEvent.stage}, round=${latestStageEvent.round}, at=${latestStageEvent.at}, message=${latestStageEvent.message}`
      : "N/A";
    const latestRunLastStage = latestRun?.lastStage
      ? `${latestRun.lastStage}${latestRun.lastMessage ? `(${latestRun.lastMessage})` : ""}`
      : "N/A";
    const autoReleasePushWarning =
      deps.autoDevAutoReleaseEnabled && !deps.autoDevAutoReleasePush
        ? `\n- warning: autoRelease=on 但 autoReleasePush=off；发布提交不会自动推送，请手动执行 \`git push\` 触发 CI 发布`
        : "";
    const currentTask =
      snapshot.taskId && snapshot.taskDescription
        ? `${snapshot.taskId} ${snapshot.taskDescription}`.trim()
        : snapshot.taskId
          ? snapshot.taskId
          : inProgressTask
            ? formatTaskForDisplay(inProgressTask)
            : "N/A";

    await deps.sendNotice(
      input.message.conversationId,
      `[CodeHarbor] AutoDev 状态
- workdir: ${input.workdir}
- REQUIREMENTS.md: ${context.requirementsContent ? "found" : "missing"}
- TASK_LIST.md: ${context.taskListContent ? "found" : "missing"}
- tasks: total=${summary.total}, pending=${summary.pending}, in_progress=${summary.inProgress}, completed=${summary.completed}, blocked=${summary.blocked}, cancelled=${summary.cancelled}
- gitPreflight: ${gitPreflight.state}
- config: loopMaxRuns=${deps.autoDevLoopMaxRuns}, loopMaxMinutes=${deps.autoDevLoopMaxMinutes}, autoCommit=${deps.autoDevAutoCommit ? "on" : "off"}, autoRelease=${deps.autoDevAutoReleaseEnabled ? "on" : "off"}, autoReleasePush=${deps.autoDevAutoReleasePush ? "on" : "off"}, maxConsecutiveFailures=${deps.autoDevMaxConsecutiveFailures}, detailedProgress=${detailedProgress} (default=${detailedProgressDefault})
- gitPreflightReason: ${gitPreflight.reason ?? "N/A"}${autoReleasePushWarning}
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
- runGitCommit: ${snapshot.lastGitCommitSummary ?? "N/A"}
- runGitCommitAt: ${snapshot.lastGitCommitAt ?? "N/A"}
- runRelease: ${snapshot.lastReleaseSummary ?? "N/A"}
- runReleaseAt: ${snapshot.lastReleaseAt ?? "N/A"}
- workflowDiag: runId=${latestRun?.runId ?? "N/A"}, status=${latestRun?.status ?? "N/A"}, startedAt=${latestRun?.startedAt ?? "N/A"}, updatedAt=${latestRun?.updatedAt ?? "N/A"}, duration=${latestRun ? formatWorkflowDiagRunDuration(latestRun) : "N/A"}
- workflowDiagLastStage: ${latestRunLastStage}
- workflowStage: ${latestStageSummary}
- recentRuns:
${formatAutoDevStatusRunSummaries(recentRuns)}
- stageTrace:
${formatAutoDevStatusStageTrace(stageEvents)}`,
    );
  } catch (error) {
    await deps.sendNotice(input.message.conversationId, `[CodeHarbor] AutoDev 状态读取失败: ${formatError(error)}`);
  }
}
