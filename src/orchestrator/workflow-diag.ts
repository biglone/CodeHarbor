import type { OutputLanguage } from "../config";

import {
  formatDurationMs,
  formatWorkflowDiagRunDuration,
  summarizeSingleLine,
} from "./helpers";

export type WorkflowDiagRunKind = "workflow" | "autodev";
export type WorkflowDiagRunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface WorkflowDiagRunRecord {
  runId: string;
  kind: WorkflowDiagRunKind;
  sessionKey: string;
  conversationId: string;
  requestId: string;
  objective: string;
  taskId: string | null;
  taskDescription: string | null;
  status: WorkflowDiagRunStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  approved: boolean | null;
  repairRounds: number;
  error: string | null;
  lastStage: string | null;
  lastMessage: string | null;
  updatedAt: string;
}

export interface WorkflowDiagEventRecord {
  runId: string;
  kind: WorkflowDiagRunKind;
  stage: string;
  round: number;
  message: string;
  at: string;
}

export interface WorkflowDiagStorePayload {
  version: 1;
  updatedAt: string;
  runs: WorkflowDiagRunRecord[];
  events: WorkflowDiagEventRecord[];
}

export const WORKFLOW_DIAG_MAX_RUNS = 120;
export const WORKFLOW_DIAG_MAX_EVENTS = 2_000;

export function createEmptyWorkflowDiagStorePayload(): WorkflowDiagStorePayload {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    runs: [],
    events: [],
  };
}

export function parseWorkflowDiagStorePayload(payloadJson: string | null): WorkflowDiagStorePayload {
  if (!payloadJson || !payloadJson.trim()) {
    return createEmptyWorkflowDiagStorePayload();
  }
  try {
    const parsed = JSON.parse(payloadJson) as Partial<WorkflowDiagStorePayload> | null;
    if (!parsed || typeof parsed !== "object") {
      return createEmptyWorkflowDiagStorePayload();
    }
    const runs = Array.isArray(parsed.runs) ? parsed.runs.filter(isWorkflowDiagRunRecord) : [];
    const events = Array.isArray(parsed.events) ? parsed.events.filter(isWorkflowDiagEventRecord) : [];
    const updatedAt = typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt : new Date(0).toISOString();
    return {
      version: 1,
      updatedAt,
      runs: runs.slice(-WORKFLOW_DIAG_MAX_RUNS),
      events: events.slice(-WORKFLOW_DIAG_MAX_EVENTS),
    };
  } catch {
    return createEmptyWorkflowDiagStorePayload();
  }
}

export function formatAutoDevDiagRuns(
  runs: WorkflowDiagRunRecord[],
  resolveEvents: (runId: string) => WorkflowDiagEventRecord[],
  outputLanguage: OutputLanguage = "zh",
): string {
  if (runs.length === 0) {
    return "- (empty)";
  }
  return runs
    .map((run) => {
      const localizedLastMessage =
        run.lastMessage === null ? null : localizeWorkflowDiagMessageForDisplay(run.lastMessage, outputLanguage);
      const stageText = run.lastStage ? `${run.lastStage}${localizedLastMessage ? `(${localizedLastMessage})` : ""}` : "N/A";
      const durationText = run.durationMs === null ? "running" : formatDurationMs(run.durationMs);
      const errorText = run.error ?? "none";
      const events = resolveEvents(run.runId);
      const eventSummary =
        events.length === 0
          ? "events=n/a"
          : `events=${events
              .map((event) =>
                summarizeSingleLine(
                  `${event.stage}#${event.round}:${localizeWorkflowDiagMessageForDisplay(event.message, outputLanguage)}`,
                  48,
                ),
              )
              .join(" -> ")}`;
      return [
        `- run=${run.runId} status=${run.status} task=${run.taskId ?? "N/A"} approved=${
          run.approved === null ? "N/A" : run.approved ? "yes" : "no"
        } repairRounds=${run.repairRounds} duration=${durationText}`,
        `  lastStage=${stageText}`,
        `  ${eventSummary}`,
        `  error=${errorText}`,
      ].join("\n");
    })
    .join("\n");
}

export function formatAutoDevStatusRunSummaries(
  runs: WorkflowDiagRunRecord[],
  outputLanguage: OutputLanguage = "zh",
): string {
  if (runs.length === 0) {
    return "- (empty)";
  }
  return runs
    .map((run) => {
      const taskDescription =
        outputLanguage === "en"
          ? null
          : run.taskDescription;
      const task = run.taskId
        ? `${run.taskId}${taskDescription ? ` ${taskDescription}` : ""}`.trim()
        : "N/A";
      const localizedLastMessage =
        run.lastMessage === null ? null : localizeWorkflowDiagMessageForDisplay(run.lastMessage, outputLanguage);
      const stage = run.lastStage ? `${run.lastStage}${localizedLastMessage ? `(${localizedLastMessage})` : ""}` : "N/A";
      const approvedText = run.approved === null ? "N/A" : run.approved ? "yes" : "no";
      return `- run=${run.runId} status=${run.status} task=${task} approved=${approvedText} duration=${formatWorkflowDiagRunDuration(run)} updatedAt=${run.updatedAt} lastStage=${summarizeSingleLine(stage, 180)}`;
    })
    .join("\n");
}

export function formatAutoDevStatusStageTrace(
  events: WorkflowDiagEventRecord[],
  outputLanguage: OutputLanguage = "zh",
): string {
  if (events.length === 0) {
    return "- (empty)";
  }
  return events
    .map((event, index) => {
      return `- #${index + 1} at=${event.at} stage=${event.stage} round=${event.round} message=${summarizeSingleLine(localizeWorkflowDiagMessageForDisplay(event.message, outputLanguage), 180)}`;
    })
    .join("\n");
}

export function localizeWorkflowDiagMessageForDisplay(message: string, outputLanguage: OutputLanguage): string {
  if (outputLanguage !== "en") {
    return message;
  }
  const normalized = message
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .replaceAll("，", ", ")
    .replaceAll("：", ": ");
  const replacements: Array<[string, string]> = [
    ["AutoDev 启动任务", "AutoDev started task"],
    ["AutoDev 任务结果", "AutoDev task result"],
    ["AutoDev 失败", "AutoDev failed"],
    ["AutoDev 循环执行完成", "AutoDev loop completed"],
    ["多智能体流程启动", "Multi-Agent workflow started"],
    ["Multi-Agent workflow 启动", "Multi-Agent workflow started"],
    ["规划代理", "Planner"],
    ["执行代理", "Executor"],
    ["审查代理", "Reviewer"],
    ["开始生成执行计划", "started plan generation"],
    ["执行完成", "completed"],
    ["开始根据计划执行任务", "started execution from plan"],
    ["初版交付完成", "initial delivery completed"],
    ["开始质量审查", "started quality review"],
    ["审查完成", "review completed"],
    ["开始按审查反馈修复", "started repair from review feedback"],
    ["修复轮次完成", "repair round completed"],
    ["契约补全启动", "contract repair started"],
    ["契约补全完成", "contract repair completed"],
    ["已拒绝但未提供可执行修复契约，已停止自动修复", "rejected without actionable repair contract; auto-repair stopped"],
    ["未检测到 git 仓库", "git repository not found"],
    ["运行前存在未提交改动，已跳过自动提交", "skipped auto-commit: worktree was dirty before run"],
    ["无文件改动可提交", "no file changes to commit"],
    ["任务未完成，跳过自动发布", "task not completed; auto-release skipped"],
    ["任务代码未自动提交，跳过自动发布", "task code was not auto-committed; auto-release skipped"],
    ["任务未配置大功能发布映射", "task has no big-feature release mapping"],
    ["发布未产生可提交文件", "release produced no committable files"],
    ["版本比较失败", "version comparison failed"],
    ["git status 读取失败", "git status read failed"],
    ["轮次", "round"],
    ["耗时", "duration"],
  ];

  let localized = normalized;
  for (const [pattern, replacement] of replacements) {
    localized = localized.split(pattern).join(replacement);
  }
  localized = localized.replace(/检测到\s*(\d+)\s*项未提交改动/g, "detected $1 uncommitted changes");

  localized = localized.replace(/(AutoDev started task [^:]+):\s*.+$/i, "$1");
  if (/[\u4e00-\u9fff]/.test(localized)) {
    localized = localized.replace(/[\u4e00-\u9fff]+/g, " ").replace(/\s{2,}/g, " ").trim();
  }
  return localized || "historical workflow message";
}

function isWorkflowDiagRunRecord(value: unknown): value is WorkflowDiagRunRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Partial<WorkflowDiagRunRecord>;
  if (typeof row.runId !== "string" || !row.runId.trim()) {
    return false;
  }
  if (row.kind !== "workflow" && row.kind !== "autodev") {
    return false;
  }
  if (typeof row.sessionKey !== "string" || typeof row.conversationId !== "string" || typeof row.requestId !== "string") {
    return false;
  }
  if (typeof row.objective !== "string" || typeof row.startedAt !== "string") {
    return false;
  }
  if (!(typeof row.taskId === "string" || row.taskId === null)) {
    return false;
  }
  if (!(typeof row.taskDescription === "string" || row.taskDescription === null)) {
    return false;
  }
  if (!["running", "succeeded", "failed", "cancelled"].includes(String(row.status ?? ""))) {
    return false;
  }
  if (!(typeof row.endedAt === "string" || row.endedAt === null)) {
    return false;
  }
  if (!(row.durationMs === null || (typeof row.durationMs === "number" && Number.isFinite(row.durationMs)))) {
    return false;
  }
  if (!(typeof row.approved === "boolean" || row.approved === null)) {
    return false;
  }
  if (typeof row.repairRounds !== "number" || !Number.isFinite(row.repairRounds)) {
    return false;
  }
  if (!(typeof row.error === "string" || row.error === null)) {
    return false;
  }
  if (!(typeof row.lastStage === "string" || row.lastStage === null)) {
    return false;
  }
  if (!(typeof row.lastMessage === "string" || row.lastMessage === null)) {
    return false;
  }
  if (typeof row.updatedAt !== "string") {
    return false;
  }
  return true;
}

function isWorkflowDiagEventRecord(value: unknown): value is WorkflowDiagEventRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Partial<WorkflowDiagEventRecord>;
  if (typeof row.runId !== "string" || !row.runId.trim()) {
    return false;
  }
  if (row.kind !== "workflow" && row.kind !== "autodev") {
    return false;
  }
  if (typeof row.stage !== "string" || typeof row.message !== "string" || typeof row.at !== "string") {
    return false;
  }
  if (typeof row.round !== "number" || !Number.isFinite(row.round)) {
    return false;
  }
  return true;
}
