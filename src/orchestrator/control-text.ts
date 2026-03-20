export function buildHelpNotice(input: {
  botNoticePrefix: string;
  multimodalHelpStatus: string;
}): string {
  return `${input.botNoticePrefix} 可用命令
- /help: 查看命令帮助
- /status: 查看会话状态（版本检查为缓存结果）
- /version: 实时检查最新版本
- /autodev status: 查看 AutoDev 当前任务、过程阶段与运行状态
- /autodev run [taskId]: 执行指定任务；不指定时连续执行任务清单（示例: /autodev run T6.2）
- /autodev stop: 不中断当前任务，在当前任务完成后停止 AutoDev 循环
- /autodev progress [on|off|status]: 控制 AutoDev/Multi-Agent 过程回显详细模式（默认 on）
- /autodev skills [on|off|summary|progressive|full|status]: 控制角色技能注入开关与披露模式（默认 progressive）
- 多模态状态: ${input.multimodalHelpStatus}
- /diag version: 查看运行实例诊断信息
- /diag media [count]: 查看最近多模态处理诊断（count 默认 10）
- /diag upgrade [count]: 查看最近升级任务诊断（count 默认 5）
- /diag route [count]: 查看后端路由命中与回退原因诊断（count 默认 10）
- /diag autodev [count]: 查看自动化开发运行诊断（count 默认 10）
- /diag queue [count]: 查看任务队列状态诊断（count 默认 10）
- /upgrade [version]: 升级并自动重启服务（仅私聊；优先 MATRIX_UPGRADE_ALLOWED_USERS，否则 MATRIX_ADMIN_USERS）
- /backend codex|claude|auto|status: 查看/切换后端工具（auto=恢复自动路由）
- /reset: 清空当前会话上下文
- /stop: 停止当前执行任务
- Matrix 客户端若拦截 / 命令，可发送 //autodev run T6.2（兼容 //agents、//diag、//upgrade）
- help|帮助|菜单: /help 的文本别名（用于 Matrix 拦截 /help 的客户端）`;
}

export function buildStatusNotice(input: {
  botNoticePrefix: string;
  scope: string;
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
  autoDevDiagRunId: string;
  autoDevDiagRunStatus: string;
  autoDevStageSummary: string;
  autoDevStageMessage: string;
}): string {
  return `${input.botNoticePrefix} 当前状态
- 会话类型: ${input.scope}
- 激活中: ${input.isActive ? "是" : "否"}
- activeUntil: ${input.activeUntil}
- 已绑定会话: ${input.hasCodexSession ? "是" : "否"}
- 当前工作目录: ${input.workdir}
- AI CLI: ${input.backendLabel}
- backend route: mode=${input.backendRouteMode}, reason=${input.backendRouteReason}, rule=${input.backendRouteRuleId}
- backend route detail: desc=${input.backendRouteReasonDesc}, fallback=${input.backendRouteFallback}
- 当前版本: ${input.currentVersion}
- 更新检查: ${input.updateHint}
- 更新检查时间: ${input.checkedAt}
- 更新来源: 缓存结果（TTL=${input.updateCacheTtlText}，发送 /version 可实时刷新）
- 最近升级: ${input.latestUpgradeSummary}
- 升级记录: ${input.recentUpgradesSummary}
- 升级指标: total=${input.upgradeStats.total}, succeeded=${input.upgradeStats.succeeded}, failed=${input.upgradeStats.failed}, running=${input.upgradeStats.running}, avg=${input.upgradeStats.avgDurationMs}ms
- 升级锁: ${input.upgradeLockSummary}
- 运行中任务: ${input.metrics.activeExecutions}
- 指标: total=${input.metrics.total}, success=${input.metrics.success}, failed=${input.metrics.failed}, timeout=${input.metrics.timeout}, cancelled=${input.metrics.cancelled}, rate_limited=${input.metrics.rateLimited}
- 平均耗时: queue=${input.metrics.avgQueueMs}ms, exec=${input.metrics.avgExecMs}ms, send=${input.metrics.avgSendMs}ms
- 限流并发: global=${input.limiter.activeGlobal}, users=${input.limiter.activeUsers}, rooms=${input.limiter.activeRooms}
- CLI runtime: workers=${input.runtime.workerCount}, running=${input.runtime.runningCount}, compat_mode=${input.cliCompatEnabled ? "on" : "off"}
- Multi-Agent workflow: enabled=${input.workflowEnabled ? "on" : "off"}, state=${input.workflowState}
- Multi-Agent context: plan=${input.workflowPlanBudget}, output=${input.workflowOutputBudget}, feedback=${input.workflowFeedbackBudget}
- Multi-Agent role skills: enabled=${input.roleSkillStatus.enabled ? "on" : "off"}, mode=${input.roleSkillStatus.mode}, maxChars=${input.roleSkillStatus.maxChars}, override=${input.roleSkillStatus.override}
- Multi-Agent role skills loaded: ${input.roleSkillStatus.loaded}
- AutoDev: enabled=${input.workflowEnabled ? "on" : "off"}, state=${input.autoDevState}, mode=${input.autoDevMode}, task=${input.autoDevTask}, duration=${input.autoDevRunDuration}
- AutoDev loop: round=${input.autoDevLoopRound}/${input.autoDevLoopMaxRuns}, completed=${input.autoDevLoopCompletedRuns}, deadline=${input.autoDevLoopDeadlineAt ?? "N/A"}, active=${input.autoDevLoopActive}
- AutoDev control: loopStopRequested=${input.autoDevLoopStopRequested}, stopRequested=${input.autoDevStopRequested}, detailedProgress=${input.autoDevDetailedProgress} (default=${input.autoDevDetailedProgressDefault})
- AutoDev stage: run=${input.autoDevDiagRunId}, status=${input.autoDevDiagRunStatus}, latest=${input.autoDevStageSummary}
- AutoDev stage detail: ${input.autoDevStageMessage}`;
}
