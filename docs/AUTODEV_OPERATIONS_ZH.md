# AutoDev 运行架构与排障手册（T10.13）

## 1. 适用范围

本文用于 AutoDev 阶段 10 重构后的日常运维与故障定位，覆盖：

- 模块边界与调用关系（Runner/Control/Policy）
- 控制命令处理链路（`/autodev ...`）
- 常见故障的快速定位路径

## 2. 架构图（当前实现）

```text
Matrix message (/autodev ...)
  -> parseAutoDevCommand (src/workflow/autodev.ts)
  -> autodev-control-command.ts
      -> autodev-control-parser.ts            # 路径解析/stop 权限/目录校验
      -> autodev-command-handler-registry.ts  # kind -> handler 解耦路由
      -> autodev-control-response.ts          # success/error/validation_error + code + next

/autodev run
  -> autodev-runner.ts
      -> autodev-loop-engine.ts               # loop boundary / stop reason / nested context
      -> autodev-stage-executor.ts            # preflight -> workflow -> gate -> git/release
      -> autodev-completion-gate-policy.ts    # completion gate pure policy
      -> autodev-validation-policy.ts         # validation inference pure policy
      -> autodev-status-heal-policy.ts        # status-heal pure policy
      -> autodev-result-reporter.ts           # secondary handoff / notices
      -> autodev-run-archive.ts               # run archive persistence
```

## 3. 模块边界速查

| 模块 | 主职责 | 不负责 |
|------|--------|--------|
| `autodev-control-parser.ts` | 路径归一化、`stop` 权限判定、目录断言 | 消息路由与业务执行 |
| `autodev-command-handler-registry.ts` | 将 `command.kind` 路由到独立 handler | 命令语义判定与文案 |
| `autodev-control-response.ts` | 统一控制响应 envelope（`status/code/next`） | 实际业务执行 |
| `autodev-loop-engine.ts` | 循环边界判定（`no_task/drained/max_runs/deadline/...`） | 阶段执行与提交发布 |
| `autodev-stage-executor.ts` | 单任务阶段执行编排（workflow/gate/git/release） | 循环轮次管理 |
| `autodev-completion-gate-policy.ts` | completion gate 通过条件与原因码 | Git、Matrix 回显 |
| `autodev-validation-policy.ts` | validation 结构化推断与失败分类 | 任务状态落盘 |
| `autodev-status-heal-policy.ts` | 状态漂移自愈规则 | workflow 执行 |
| `autodev-result-reporter.ts` | 手工触发二次评审回显、结果模板拼装 | gate 决策 |

## 4. 控制命令说明（重构后）

### 4.1 命令集合（`AutoDevCommand.kind`）

- `status`
- `run`（支持 `run <taskId>`）
- `stop`
- `reconcile`
- `workdir`
- `init`
- `progress`
- `content`
- `skills`
- `invalid`（兜底）

来源：`src/workflow/autodev.ts`。

### 4.2 处理链路

1. 解析：`parseAutoDevCommand()` 产出结构化 `kind + options`
2. 路由：`dispatchAutoDevCommandWithRegistry()` 做 handler 分发
3. 执行：`handleAutoDev*Command()` 系列执行实际动作
4. 输出：`withAutoDevControlEnvelope()` 统一响应格式

统一输出字段：

- `status`: `success | error | validation_error`
- `code`: 稳定机器可读错误码（如 `AUTODEV_CONTROL_STOP_NO_ACTIVE_LOOP`）
- `next`: 用户下一步建议（可选）

## 5. 排障路径（按模块边界）

### 5.1 快速采样（先做）

1. `//autodev status`
2. `//diag autodev 5`
3. 记录 `requestId`

### 5.2 故障分流

| 症状 | 第一定位模块 | 二级检查 |
|------|--------------|----------|
| `/autodev xxx` 被判 invalid | `src/workflow/autodev.ts` | 命令拼写、参数 token 化 |
| `workdir` 设置失败（路径/目录错误） | `autodev-control-parser.ts` | `resolveAutoDevTargetPath`、`assertAutoDevTargetDirectory` |
| `stop` 总提示无活动循环 | `autodev-control-parser.ts` | `activeAutoDevLoopSessions` 与 `pendingAutoDevLoopStopRequests` |
| 任务执行成功但未转 `✅` | `autodev-completion-gate-policy.ts` | reviewer verdict、validation 证据、git 提交结果 |
| 任务状态与运行记录不一致 | `autodev-status-heal-policy.ts` | 执行 `//autodev reconcile` 对账 |
| 配置了二次评审但未回显 handoff | `autodev-result-reporter.ts` | secondary review 开关/target/gate 条件 |
| 任务完成但未触发 release commit | `autodev-stage-executor.ts` + `autodev-release.ts` | `TASK_LIST.md` 发布映射、`AUTODEV_AUTO_RELEASE_ENABLED` |

### 5.3 深入定位顺序（推荐）

1. 控制面：`workflow/autodev.ts` -> `autodev-control-command.ts`
2. 循环面：`autodev-loop-engine.ts`
3. 执行面：`autodev-stage-executor.ts`
4. 策略面：`autodev-completion-gate-policy.ts` / `autodev-validation-policy.ts` / `autodev-status-heal-policy.ts`
5. 回显与归档：`autodev-result-reporter.ts` / `autodev-run-archive.ts`

## 6. 回归测试映射（当前）

- 控制命令解析/路由/响应契约：
  - `test/autodev-control-parser.test.ts`
  - `test/autodev-command-handler-registry.test.ts`
  - `test/autodev-control-command.test.ts`
- 策略契约与矩阵：
  - `test/autodev-completion-gate-policy.test.ts`
  - `test/autodev-validation-policy.test.ts`
  - `test/autodev-status-heal-policy.test.ts`
  - `test/autodev-policy-contract.test.ts`
- 集成回归（含 secondary review + release gating）：
  - `test/autodev-runner.test.ts`

## 7. 与蓝图文档关系

- 蓝图设计与迁移路线：`docs/AUTODEV_REFACTOR_PHASE10_ZH.md`
- 本文：运行时现状与排障实践（T10.13）
