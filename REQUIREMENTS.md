# CodeHarbor 需求文档（现状补全 + 配置 UI 新需求）

## 1. 功能概述
CodeHarbor 是一个“即时通讯版 Codex CLI 网关”，将 Matrix 消息路由到 `codex exec/resume` 会话，并把结果回传到原房间。

当前版本已经支持多房间、多会话并发、会话持久化、限流、控制命令与 npm 分发；下一阶段新增“配置管理 UI”以降低运维门槛。

## 2. 背景和目标
**背景**：当前主要通过 `.env` 管理配置，随着多房间、多项目并发使用增加，配置复杂度和误操作风险上升。  
**目标**：
- 保持现有 CLI/IM 主流程稳定。
- 补齐文档与实际实现的一致性。
- 引入可视化配置 UI，支持并发参数、房间策略、房间项目映射的安全管理与快速生效。

## 3. 用户故事
- 作为开发者，我希望在多个 Matrix 房间并行驱动不同任务，以便同时处理多个项目。
- 作为管理员，我希望不用手改 `.env` 就能调整并发、触发策略和房间配置，以便降低运维成本。
- 作为维护者，我希望能追踪配置变更与回滚，以便快速定位问题并恢复服务。

## 4. 功能详细描述

### 4.1 已实现能力（As-Is）
- Matrix Channel 适配：收发消息、忽略机器人自身消息、自动加入邀请房间。
- 会话隔离：按 `channel:room:user` 维度维护 Codex 会话上下文。
- SQLite 持久化：会话、事件去重、会话活跃窗口、清理策略。
- 消息路由策略：
  - 私聊默认触发。
  - 群聊支持 mention/reply/active-window/prefix 组合触发。
  - 支持房间级策略覆盖（`ROOM_TRIGGER_POLICY_JSON`）。
- 控制命令：`/status`、`/reset`、`/stop`。
- 并发与限流：用户/房间/全局窗口限流与并发控制。
- 执行过程反馈：typing、阶段进度、群聊状态合并编辑（`m.replace`）。
- CLI 兼容模式：更接近 codex CLI 行为，支持事件透传、保留空白、媒体拉取、录制回放。
- 附件处理：支持图片附件下载并通过 `--image` 传递给 Codex。
- 可运维性：`codeharbor init` 配置向导、`start/doctor` 启动预检。
- 分发与发布：npm 打包发布能力，GitHub Actions 条件自动发布工作流。

### 4.2 新增需求（To-Be）：配置管理 UI
新增一个最小可用管理面板（MVP），覆盖“最高频且高风险”的配置项。

MVP 范围：
- 全局配置管理：并发与限流、命令前缀、进度与兼容模式关键开关。
- 房间配置管理：
  - 房间触发策略（mention/reply/active-window/prefix）
  - 房间启用状态
  - 房间项目目录映射（Room -> Workdir）
- 连接健康检查：Matrix 连接、codex 可执行、关键配置完整性。
- 配置生效机制：保存后校验；支持热加载（可行项）或提示重启。
- 配置审计：记录最近变更时间、操作者标识（MVP 可先记录文本标记）。

非 MVP（后续）：
- 完整 RBAC。
- 多租户与组织级权限模型。
- 复杂审批流。

## 5. 验收标准

### 5.1 现有能力一致性（文档补全验收）
- [ ] Given 当前 `src/` 实现，When 对照需求文档，Then 文档覆盖核心模块与行为（会话、限流、命令、预检、发布链路）。
- [ ] Given README/REQUIREMENTS/TASK_LIST，When 阅读关键能力，Then 术语和流程保持一致，无 Python/OpenAI 主实现表述偏差。

### 5.2 配置 UI 需求验收（设计验收）
- [ ] Given 管理员打开配置 UI，When 修改并发参数，Then 保存前有格式校验，保存后可查看生效状态。
- [ ] Given 管理员配置房间策略，When 指定某房间触发规则，Then 新规则可覆盖全局默认并被运行时读取。
- [ ] Given 管理员配置房间工作目录，When 该房间触发请求，Then 执行上下文可路由到对应 workdir。
- [ ] Given 配置导致校验失败，When 点击保存，Then UI 返回可读错误并拒绝落盘。
- [ ] Given 配置保存成功，When 查询变更记录，Then 可看到最近修改摘要。

## 6. 功能模块划分

### 6.1 前端模块（新增）
- `admin-ui`：配置表单、房间策略页、健康状态页、保存结果反馈。

### 6.2 后端模块（扩展）
- `config-loader`：现有环境变量读取与校验。
- `config-service`（新增）：统一配置读写、运行时校验、版本化存储。
- `room-routing`（新增）：按 roomId 解析执行策略与工作目录。
- `channels.matrix`：保持现有收发逻辑，读取最新策略。
- `orchestrator`：沿用现有编排流程并接入 room 级配置。

### 6.3 数据模块（扩展）
- 现有：`sessions`、`processed_events`。
- 新增建议：
  - `room_settings`：房间级策略与工作目录映射。
  - `config_revisions`：配置版本与审计日志。

## 7. 技术方案

### 7.1 技术栈
- 运行时：Node.js 20+
- 主实现：TypeScript
- IM SDK：`matrix-js-sdk`
- CLI 集成：`codex` CLI（`exec/resume`）
- 配置校验：`zod`
- 持久化：SQLite（`node:sqlite`）
- CLI：`commander`

### 7.2 关键技术点
- 会话隔离与并发控制：同 session 串行，不同 session 并行，叠加全局/用户/房间限流。
- 运行时配置一致性：区分“可热更新”与“需重启”配置项，避免半生效状态。
- 房间路由：在不破坏现有会话键规则前提下增加 room -> workdir 映射层。
- 可观测性：保留 request_id、状态计数、执行耗时与失败分类。

### 7.3 架构设计
```text
Matrix Room -> MatrixChannel -> Orchestrator -> CodexSessionRuntime -> CodexExecutor(codex exec/resume)
                                          |                |
                                          |                -> room-level workdir routing (new)
                                          -> StateStore(SQLite)

Admin UI -> Config Service -> SQLite(config tables) + runtime config cache
```

## 8. 接口设计（进程内 / CLI）
现有 CLI：
- `codeharbor init`
- `codeharbor start`
- `codeharbor doctor`

新增规划（配置 UI 相关）：
- `codeharbor admin serve`：启动配置 UI 服务。
- `codeharbor config export`：导出当前配置快照。
- `codeharbor config import`：导入并校验配置快照。

## 9. 数据模型

### 9.1 已有表
- `sessions(session_key, codex_session_id, active_until, updated_at)`
- `processed_events(session_key, event_id, created_at)`

### 9.2 新增建议表
#### `room_settings`
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| room_id | TEXT | Matrix 房间 ID | PK |
| enabled | INTEGER | 是否启用 | 0/1 |
| allow_mention | INTEGER | 触发策略 | 0/1 |
| allow_reply | INTEGER | 触发策略 | 0/1 |
| allow_active_window | INTEGER | 触发策略 | 0/1 |
| allow_prefix | INTEGER | 触发策略 | 0/1 |
| workdir | TEXT | 房间工作目录 | 非空 |
| updated_at | INTEGER | 更新时间 | 非空 |

#### `config_revisions`
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | INTEGER | 版本ID | PK |
| actor | TEXT | 操作者标识 | 可空 |
| summary | TEXT | 变更摘要 | 非空 |
| payload_json | TEXT | 配置快照 | 非空 |
| created_at | INTEGER | 创建时间 | 非空 |

## 10. 风险和注意事项
- ⚠️ 高并发下 Codex/OpenAI 上游限流可能导致超时与失败，需要明确退避与提示。
- ⚠️ workdir 房间映射若配置错误会导致“房间与项目串线”，必须做强校验。
- ⚠️ 管理 UI 若无鉴权存在配置篡改风险，MVP 需至少提供本地访问控制或令牌保护。
- ⚠️ 配置热更新与运行中任务并发可能产生短暂不一致，需要定义边界（新请求生效、旧请求不回滚）。

## 11. 非功能需求
- 性能要求：单实例默认支持 >= 8 并发执行，可通过配置扩展到更高并发。
- 安全要求：敏感配置脱敏展示，不记录 access token 明文日志。
- 可用性要求：配置保存错误必须可读可定位；关键检查项需在 UI 和 CLI 双通道可见。
- 兼容性要求：Linux/macOS 运行；Node.js >= 20。

---
生成时间：2026-03-21 20:20:00 CST
