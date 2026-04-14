import type { OutputLanguage } from "../config";
import { byOutputLanguage, yesNoByOutputLanguage } from "./output-language";

export function buildHelpNotice(input: {
  botNoticePrefix: string;
  outputLanguage: OutputLanguage;
  multimodalHelpStatus: string;
}): string {
  if (input.outputLanguage === "en") {
    return `${input.botNoticePrefix} Available commands
- /help: Show command help
- /status: Show session status (version check uses cached result)
- /version: Force real-time latest version check
- /autodev status: Show AutoDev task, stage, and run state
- /autodev run [taskId]: Run target task; when omitted, run task list in loop (example: /autodev run T6.2)
- /autodev stop: Stop AutoDev loop after current task completes
- /autodev reconcile: Reconcile TASK_LIST task states using latest AutoDev run records
- tip: TASK_LIST task status is system-managed; use /autodev reconcile instead of manual edits
- /autodev workdir|wd [path]|status|clear: Show/set/clear AutoDev workdir override for this session
- /autodev init|i [path] [--from file] [--dry-run] [--force]: Scaffold REQUIREMENTS.md + TASK_LIST.md + task compass in target project
- tip: /autodev init StrawBerry --dry-run (preview), then /autodev init StrawBerry --force to overwrite
- /autodev progress [on|off|status]: Control detailed AutoDev/Multi-Agent progress echo (default on)
- /autodev content [on|off|status]: Control AutoDev stage output echo for planner/executor/reviewer content (default on)
- /autodev skills [on|off|summary|progressive|full|status]: Control role-skill injection and disclosure mode (default progressive)
- multimodal: ${input.multimodalHelpStatus}
- /diag version: Show runtime diagnosis
- /diag media [count]: Show recent multimodal diagnosis (default count 10)
- /diag upgrade [count]: Show recent upgrade diagnosis (default count 5)
- /diag route [count]: Show backend routing hit/fallback diagnosis (default count 10)
- /diag autodev [count]: Show AutoDev diagnosis (default count 10)
- /diag queue [count]: Show task queue diagnosis (default count 10)
- /diag limiter [count]: Show limiter diagnosis (shared mode/rejection/recovery + recent decision records)
- /trace [requestId|latest]: Show in-memory trace for one request (chat prompt/progress/reply plus related diag/media events)
- /upgrade [version]: Upgrade and auto-restart services (DM only; MATRIX_UPGRADE_ALLOWED_USERS first, then MATRIX_ADMIN_USERS)
- /backend codex|claude|gemini [model] | /backend auto|status: Show/switch backend tool (auto = restore auto routing)
- /reset: Clear current session context
- /stop: Stop current execution (aliases: /cancel, /esc)
- If Matrix client intercepts / commands, use //autodev init StrawBerry (also supports //autodev run T6.2, //agents, //diag, //trace, //upgrade)
- help aliases: help | menu`;
  }
  return `${input.botNoticePrefix} 可用命令
- /help: 查看命令帮助
- /status: 查看会话状态（版本检查为缓存结果）
- /version: 实时检查最新版本
- /autodev status: 查看 AutoDev 当前任务、过程阶段与运行状态
- /autodev run [taskId]: 执行指定任务；不指定时连续执行任务清单（示例: /autodev run T6.2）
- /autodev stop: 不中断当前任务，在当前任务完成后停止 AutoDev 循环
- /autodev reconcile: 根据最近 AutoDev 运行记录对账并修正 TASK_LIST 任务状态
- 提示：TASK_LIST 任务状态由系统维护，避免手工修改，必要时使用 /autodev reconcile
- /autodev workdir|wd [path]|status|clear: 查看/设置/清除当前会话的 AutoDev 工作目录覆盖
- /autodev init|i [path] [--from file] [--dry-run] [--force]: 在目标项目初始化 REQUIREMENTS.md、TASK_LIST.md 与任务罗盘
- 提示：/autodev init StrawBerry --dry-run（预览），确认后用 --force 覆盖写入
- /autodev progress [on|off|status]: 控制 AutoDev/多智能体过程回显详细模式（默认 on）
- /autodev content [on|off|status]: 控制 AutoDev 阶段产出（planner/executor/reviewer 内容）回显（默认 on）
- /autodev skills [on|off|summary|progressive|full|status]: 控制角色技能注入开关与披露模式（默认 progressive）
- 多模态状态: ${input.multimodalHelpStatus}
- /diag version: 查看运行实例诊断信息
- /diag media [count]: 查看最近多模态处理诊断（count 默认 10）
- /diag upgrade [count]: 查看最近升级任务诊断（count 默认 5）
- /diag route [count]: 查看后端路由命中与回退原因诊断（count 默认 10）
- /diag autodev [count]: 查看自动化开发运行诊断（count 默认 10）
- /diag queue [count]: 查看任务队列状态诊断（count 默认 10）
- /diag limiter [count]: 查看限流诊断（shared 模式/拒绝率/恢复耗时 + 最近决策记录，count 默认 10）
- /trace [requestId|latest]: 查看单次请求的内存追踪（chat prompt/progress/reply + 关联 diag/media 事件）
- /upgrade [version]: 升级并自动重启服务（仅私聊；优先 MATRIX_UPGRADE_ALLOWED_USERS，否则 MATRIX_ADMIN_USERS）
- /backend codex|claude|gemini [model] | /backend auto|status: 查看/切换后端工具（auto=恢复自动路由）
- /reset: 清空当前会话上下文
- /stop: 停止当前执行任务（别名：/cancel、/esc、/撤回、/撤销）
- Matrix 客户端若拦截 / 命令，可发送 //autodev init StrawBerry（兼容 //autodev run T6.2、//agents、//diag、//trace、//upgrade）
- help|帮助|菜单: /help 的文本别名（用于 Matrix 拦截 /help 的客户端）`;
}

export function buildStatusNotice(input: {
  botNoticePrefix: string;
  outputLanguage: OutputLanguage;
  scope: string;
  topologyBotUserId: string;
  topologyConversationId: string;
  topologySenderId: string;
  topologySessionKey: string;
  topologyTriggerMode: string;
  topologyRoomSource: "default" | "room";
  topologyRoomEnabled: boolean;
  topologyRoomPolicy: string;
  topologyRoleChain: string;
  isActive: boolean;
  activeUntil: string;
  hasCodexSession: boolean;
  workdir: string;
  backendLabel: string;
  backendRouteMode: string;
  backendRouteReason: string;
  backendRouteRuleId: string;
  backendRouteReasonDesc: string;
  backendRouteFallback: string;
  currentVersion: string;
  updateHint: string;
  checkedAt: string;
  updateCacheTtlText: string;
  latestUpgradeSummary: string;
  recentUpgradesSummary: string;
  upgradeStats: { total: number; succeeded: number; failed: number; running: number; avgDurationMs: number };
  upgradeLockSummary: string;
  metrics: {
    activeExecutions: number;
    total: number;
    success: number;
    failed: number;
    timeout: number;
    cancelled: number;
    rateLimited: number;
    avgQueueMs: number;
    avgExecMs: number;
    avgSendMs: number;
  };
  limiter: { activeGlobal: number; activeUsers: number; activeRooms: number };
  runtime: { workerCount: number; runningCount: number };
  cliCompatEnabled: boolean;
  workflowEnabled: boolean;
  workflowState: string;
  workflowApproved: boolean | null;
  workflowPlanBudget: string;
  workflowOutputBudget: string;
  workflowFeedbackBudget: string;
  roleSkillStatus: { enabled: boolean; mode: string; maxChars: number; override: string; loaded: string };
  autoDevState: string;
  autoDevMode: string;
  autoDevTask: string;
  autoDevRunDuration: string;
  autoDevLoopRound: number;
  autoDevLoopMaxRuns: number;
  autoDevLoopCompletedRuns: number;
  autoDevLoopDeadlineAt: string | null;
  autoDevLoopActive: string;
  autoDevLoopStopRequested: string;
  autoDevStopRequested: string;
  autoDevDetailedProgress: string;
  autoDevDetailedProgressDefault: string;
  autoDevStageOutputEcho: string;
  autoDevStageOutputEchoDefault: string;
  autoDevDiagRunId: string;
  autoDevDiagRunStatus: string;
  autoDevStageSummary: string;
  autoDevStageMessage: string;
}): string {
  const activeText = yesNoByOutputLanguage(input.outputLanguage, input.isActive);
  const sessionText = yesNoByOutputLanguage(input.outputLanguage, input.hasCodexSession);
  const updateSource = byOutputLanguage(
    input.outputLanguage,
    `缓存结果（TTL=${input.updateCacheTtlText}，发送 /version 可实时刷新）`,
    `cached result (TTL=${input.updateCacheTtlText}; use /version to force refresh)`,
  );
  const title = byOutputLanguage(input.outputLanguage, "当前状态", "Current status");
  const sessionType = byOutputLanguage(input.outputLanguage, "会话类型", "session");
  const topology = byOutputLanguage(input.outputLanguage, "会话拓扑", "topology");
  const triggerMode = byOutputLanguage(input.outputLanguage, "触发模式", "triggerMode");
  const roomSource = byOutputLanguage(input.outputLanguage, "房间配置来源", "roomConfigSource");
  const roomEnabled = byOutputLanguage(input.outputLanguage, "房间启用", "roomEnabled");
  const roomPolicy = byOutputLanguage(input.outputLanguage, "房间触发策略", "roomPolicy");
  const roleTopology = byOutputLanguage(input.outputLanguage, "角色链路", "roleTopology");
  const active = byOutputLanguage(input.outputLanguage, "激活中", "active");
  const bound = byOutputLanguage(input.outputLanguage, "已绑定会话", "sessionBound");
  const cwd = byOutputLanguage(input.outputLanguage, "当前工作目录", "workdir");
  const currentVersion = byOutputLanguage(input.outputLanguage, "当前版本", "currentVersion");
  const updateCheck = byOutputLanguage(input.outputLanguage, "更新检查", "updateHint");
  const checkedAt = byOutputLanguage(input.outputLanguage, "更新检查时间", "checkedAt");
  const updateSourceLabel = byOutputLanguage(input.outputLanguage, "更新来源", "updateSource");
  const latestUpgrade = byOutputLanguage(input.outputLanguage, "最近升级", "latestUpgrade");
  const upgradeHistory = byOutputLanguage(input.outputLanguage, "升级记录", "upgradeHistory");
  const upgradeStats = byOutputLanguage(input.outputLanguage, "升级指标", "upgradeStats");
  const upgradeLock = byOutputLanguage(input.outputLanguage, "升级锁", "upgradeLock");
  const activeTasks = byOutputLanguage(input.outputLanguage, "运行中任务", "activeExecutions");
  const metrics = byOutputLanguage(input.outputLanguage, "指标", "metrics");
  const avgCost = byOutputLanguage(input.outputLanguage, "平均耗时", "avgDuration");
  const limiter = byOutputLanguage(input.outputLanguage, "限流并发", "limiter");
  const autoDevStage = byOutputLanguage(input.outputLanguage, "AutoDev 阶段", "AutoDev stage");
  const autoDevStageDetail = byOutputLanguage(input.outputLanguage, "AutoDev 阶段详情", "AutoDev stage detail");

  return `${input.botNoticePrefix} ${title}
- ${sessionType}: ${input.scope}
- ${topology}: bot=${input.topologyBotUserId}, room=${input.topologyConversationId}, user=${input.topologySenderId}, session=${input.topologySessionKey}
- ${triggerMode}: ${input.topologyTriggerMode}
- ${roomSource}: ${input.topologyRoomSource}
- ${roomEnabled}: ${yesNoByOutputLanguage(input.outputLanguage, input.topologyRoomEnabled)}
- ${roomPolicy}: ${input.topologyRoomPolicy}
- ${roleTopology}: ${input.topologyRoleChain}
- ${active}: ${activeText}
- activeUntil: ${input.activeUntil}
- ${bound}: ${sessionText}
- ${cwd}: ${input.workdir}
- AI CLI: ${input.backendLabel}
- backend route: mode=${input.backendRouteMode}, reason=${input.backendRouteReason}, rule=${input.backendRouteRuleId}
- backend route detail: desc=${input.backendRouteReasonDesc}, fallback=${input.backendRouteFallback}
- ${currentVersion}: ${input.currentVersion}
- ${updateCheck}: ${input.updateHint}
- ${checkedAt}: ${input.checkedAt}
- ${updateSourceLabel}: ${updateSource}
- ${latestUpgrade}: ${input.latestUpgradeSummary}
- ${upgradeHistory}: ${input.recentUpgradesSummary}
- ${upgradeStats}: total=${input.upgradeStats.total}, succeeded=${input.upgradeStats.succeeded}, failed=${input.upgradeStats.failed}, running=${input.upgradeStats.running}, avg=${input.upgradeStats.avgDurationMs}ms
- ${upgradeLock}: ${input.upgradeLockSummary}
- ${activeTasks}: ${input.metrics.activeExecutions}
- ${metrics}: total=${input.metrics.total}, success=${input.metrics.success}, failed=${input.metrics.failed}, timeout=${input.metrics.timeout}, cancelled=${input.metrics.cancelled}, rate_limited=${input.metrics.rateLimited}
- ${avgCost}: queue=${input.metrics.avgQueueMs}ms, exec=${input.metrics.avgExecMs}ms, send=${input.metrics.avgSendMs}ms
- ${limiter}: global=${input.limiter.activeGlobal}, users=${input.limiter.activeUsers}, rooms=${input.limiter.activeRooms}
- CLI runtime: workers=${input.runtime.workerCount}, running=${input.runtime.runningCount}, compat_mode=${input.cliCompatEnabled ? "on" : "off"}
- Multi-Agent workflow: enabled=${input.workflowEnabled ? "on" : "off"}, state=${input.workflowState}, approved=${
    input.workflowApproved === null ? "N/A" : input.workflowApproved ? "yes" : "no"
  }
- Multi-Agent context: plan=${input.workflowPlanBudget}, output=${input.workflowOutputBudget}, feedback=${input.workflowFeedbackBudget}
- Multi-Agent role skills: enabled=${input.roleSkillStatus.enabled ? "on" : "off"}, mode=${input.roleSkillStatus.mode}, maxChars=${input.roleSkillStatus.maxChars}, override=${input.roleSkillStatus.override}
- Multi-Agent role skills loaded: ${input.roleSkillStatus.loaded}
- AutoDev: enabled=${input.workflowEnabled ? "on" : "off"}, state=${input.autoDevState}, mode=${input.autoDevMode}, task=${input.autoDevTask}, duration=${input.autoDevRunDuration}
- AutoDev loop: round=${input.autoDevLoopRound}/${input.autoDevLoopMaxRuns}, completed=${input.autoDevLoopCompletedRuns}, deadline=${input.autoDevLoopDeadlineAt ?? "N/A"}, active=${input.autoDevLoopActive}
- AutoDev control: loopStopRequested=${input.autoDevLoopStopRequested}, stopRequested=${input.autoDevStopRequested}, detailedProgress=${input.autoDevDetailedProgress} (default=${input.autoDevDetailedProgressDefault}), stageOutputEcho=${input.autoDevStageOutputEcho} (default=${input.autoDevStageOutputEchoDefault})
- ${autoDevStage}: run=${input.autoDevDiagRunId}, status=${input.autoDevDiagRunStatus}, latest=${input.autoDevStageSummary}
- ${autoDevStageDetail}: ${input.autoDevStageMessage}`;
}
