# AutoDev 阶段 10 重构蓝图（T10.2）

## 1. 目标与边界

### 1.1 目标
- 将 `src/orchestrator/autodev-runner.ts` 从单体流程拆分为三个可独立演进的模块：
  - Loop Engine（循环推进与停止策略）
  - Stage Executor（阶段执行与状态推进）
  - Result Reporter（回显、归档、诊断摘要）
- 保持外部行为一致：命令入口、Matrix 回显、状态推进、归档结构不发生行为回归。
- 允许后续在不改动入口文件的情况下替换策略实现（例如更严格 gate 规则、不同回显模板）。

### 1.2 非目标
- 不在本阶段改动 AutoDev 的产品能力（不新增命令、不改变审批链语义）。
- 不在本阶段重写 Multi-Agent workflow 内核。
- 不在本阶段合并跨文件的大规模重命名（避免 review 噪音）。

## 2. 现状问题（Runner）

当前 `autodev-runner.ts` 同时承担：
- loop 控制（round/deadline/max-runs/stop/no-progress）
- 单任务执行编排（preflight -> workflow -> gate -> git/release）
- 状态保护与策略（status drift、validation fuse、failure policy）
- 消息输出（任务结果、循环完成、错误提示）
- 归档与诊断事件拼装

问题：
- 逻辑耦合高，修改某个策略容易影响其他分支。
- 单测难以聚焦，很多断言只能通过端到端行为覆盖。
- 多实例场景下，排障时难快速定位是“执行逻辑”还是“回显逻辑”问题。

## 3. 目标模块边界

### 3.1 Loop Engine

建议文件：
- `src/orchestrator/autodev-loop-engine.ts`
- `src/orchestrator/autodev-loop-stop-policy.ts`

职责：
- 决定是否继续下一轮（drained/max_runs/deadline/stop_requested/no_progress/task_incomplete）。
- 管理循环上下文（round、completedRuns、deadline、loop session 生命周期）。
- 不直接处理 workflow 输出、不直接拼接用户回显文案。

输入：
- 当前上下文快照（tasks/selectedTask/metrics flags）
- loop 配置（maxRuns/maxMinutes/stop flags）

输出：
- `LoopDecision`：`continue | stop`
- `stopReason`：`no_task | drained | max_runs | deadline | stop_requested | no_progress | task_incomplete`

### 3.2 Stage Executor

建议文件：
- `src/orchestrator/autodev-stage-executor.ts`
- `src/orchestrator/autodev-stage-contract.ts`
- `src/orchestrator/autodev-stage-handlers.ts`

职责：
- 串联阶段：preflight -> runWorkflow -> completion gate -> validation policy -> git/release。
- 产出标准化阶段结果，不负责最终消息模板。
- 封装状态推进（`pending/in_progress/completed/blocked`）与 drift 修复调用。

输入：
- `ActiveTask` + `RunContext` + 执行依赖（workflow/git/release/failure policy）

输出：
- `StageExecutionResult`（统一协议）：
  - `taskFinalStatus`
  - `approved`
  - `completionGate`
  - `validation`
  - `gitCommit`
  - `release`
  - `diagnostics`

### 3.3 Result Reporter

建议文件：
- `src/orchestrator/autodev-result-reporter.ts`
- `src/orchestrator/autodev-notice-template.ts`

职责：
- 负责所有用户可见回显格式（任务结果、循环停止原因、错误提示）。
- 负责将 `StageExecutionResult` 映射为：
  - Matrix notice
  - workflow diag summary
  - run archive payload 摘要字段
- 不决定业务策略，仅做格式化与本地化。

输入：
- `StageExecutionResult` + `LoopDecision` + outputLanguage

输出：
- 结构化 notice 文本
- archive/diag 的 message 摘要字段

## 4. 迁移顺序（无行为变更策略）

1. 提取类型契约（T10.3 前置）
- 先抽 `LoopDecision`、`StageExecutionResult`、`ReporterInput` 类型到独立文件。

2. 提取 Loop Engine（T10.3）
- 仅搬运循环决策分支；调用点仍在 `autodev-runner.ts`。
- 保持所有 message 文案与 stop reason 不变。

3. 提取 Stage Executor（T10.4）
- 将执行阶段函数搬到新模块，runner 只负责调用。
- 将完成门禁/validation 结果转为统一结构。

4. 提取 Result Reporter（T10.5）
- 将 notice 拼接迁移到 reporter。
- 对外文本保持完全一致（由基线测试锁定）。

5. 清理 runner 外壳
- runner 变成 orchestrator shell：
  - 选任务
  - 调 loop engine
  - 调 stage executor
  - 调 reporter

## 5. 回归与验证要求

- 契约基线：
  - `test/autodev-control-command.test.ts`
  - `test/autodev-status-command.test.ts`
  - `test/autodev-runner.test.ts`
- 每一步重构必须保证：
  - 快照文本不变或仅允许注释中列出的差异
  - `task status` 变更路径不变
  - `workflowDiag` 的关键字段（status/lastStage）不变

## 6. 风险与缓解

风险 1：拆分后跨模块状态不同步
- 缓解：通过 `StageExecutionResult` 单一出口传递，禁止 reporter 直接读取 mutable task state。

风险 2：回显文案漂移导致用户感知变化
- 缓解：保留基线快照测试，重构 PR 以 snapshot diff 作为首要审查项。

风险 3：循环停止条件变更引入死循环/提前退出
- 缓解：LoopDecision 增加穷举类型与单测覆盖全部 stop reason。

## 7. DoD（T10.2）

- 已明确 runner 三段式模块边界与输入输出契约。
- 已给出可执行迁移顺序，并映射到 `T10.3/T10.4/T10.5`。
- 已定义回归门槛，作为后续每步提交的验收基准。
