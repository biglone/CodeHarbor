# CodeHarbor 需求文档

## 1. 功能概述
CodeHarbor 是一个“即时通讯版编码助手网关”，将用户在 IM（首期 Matrix）中的消息路由到 AI 编码助手会话，并将最终结果回传到原会话。

## 2. 背景和目标
**背景**：桌面端工具受平台限制（如设备架构、移动端不可用），无法满足“随时在手机或 IM 下发编码任务”的使用场景。  
**目标**：实现一个可部署在服务器的消息中继系统，让用户只通过 IM 消息即可完成发起任务、获取 AI 结果的完整流程。

## 3. 用户故事
- 作为开发者，我希望在 Matrix 房间里发送指令并获得代码建议，以便不依赖本地桌面客户端。
- 作为项目维护者，我希望按 Channel 配置接入不同 IM，以便同一套核心逻辑复用到多个平台。
- 作为系统管理员，我希望通过配置文件和环境变量管理凭据，以便快速部署与安全运维。

## 4. 功能详细描述
CodeHarbor 首期实现 Matrix 单 Channel MVP，后续可扩展多 Channel。

核心行为：
- 支持读取 Channel 配置（homeserver、bot 身份、鉴权方式、命令前缀）。
- 监听 Matrix 文本消息，识别可处理消息并过滤机器人自身消息。
- 按 `channel + conversation_id + sender_id` 生成会话键，将历史上下文持久化。
- 将会话历史提交给 OpenAI 模型，生成回复。
- 在同一 Matrix 会话回传最终文本结果。
- 对异常（模型超时、鉴权失败、网络错误）返回可读错误消息。
- 提供基础日志，支持后续接入监控。

## 5. 验收标准
- [ ] Given Matrix Bot 配置和 OpenAI Key 有效，When 用户在房间发送可处理消息，Then 系统在同一房间返回 AI 回复。
- [ ] Given 启用了命令前缀 `!code`，When 用户发送非前缀消息，Then 系统不触发 AI 调用。
- [ ] Given 同一用户持续发送多轮消息，When 触发多次请求，Then 系统可基于最近历史保持上下文连续。
- [ ] Given OpenAI 请求失败，When 系统处理该消息，Then 系统返回标准化错误提示而不是静默失败。
- [ ] Given Bot 收到自己发送的消息事件，When 事件进入处理链路，Then 系统忽略该事件避免回环。
- [ ] Given 系统重启，When 重新接收同一会话消息，Then 历史上下文可从本地数据库恢复。

## 6. 功能模块划分

### 6.1 前端模块
- 无 Web 前端（MVP）。
- 管理入口：环境变量配置 + 启动命令行。

### 6.2 后端模块
- `config`：读取和校验运行配置。
- `channels.base`：统一 Channel 适配器接口。
- `channels.matrix`：Matrix 收发与事件订阅。
- `session_store`：会话消息持久化与历史读取。
- `agent.openai`：模型调用封装。
- `service/orchestrator`：消息编排（路由、锁、重试、回传）。
- `main`：应用启动与生命周期管理。

### 6.3 数据库模块
- `sessions`（可选）：记录会话元信息。
- `messages`：记录用户与助手消息。
- `processed_events`：事件去重，避免重复消费（P1）。

## 7. 技术方案

### 7.1 技术栈
- 运行时：Python 3.11+
- 后端框架：`asyncio` 原生异步
- IM SDK：`matrix-nio`
- LLM SDK：`openai` Python SDK
- 数据库：SQLite（MVP），后续可迁移 PostgreSQL

### 7.2 关键技术点
- 会话隔离：按会话键建立上下文，避免跨用户串话。
- 并发控制：同会话串行处理（session lock），不同会话并发。
- 错误治理：统一异常捕获、可读错误输出、有限重试。
- 事件过滤：忽略机器人自身事件，减少环路风险。
- 可扩展性：通过 Channel 抽象新增 Slack/Telegram 等接入。

### 7.3 架构设计
```text
User(Matrix) -> Matrix Channel Adapter -> Orchestrator
                                           |-> Session Store(SQLite)
                                           |-> OpenAI Agent
Orchestrator -> Matrix Channel Adapter -> Matrix Room Reply
```

## 8. 接口设计（如适用）
MVP 为进程内接口，不暴露公网 API。

- `Channel.start(handler)`：启动监听并将入站消息交给编排器。
- `Channel.send_message(conversation_id, text)`：向指定会话发送文本。
- `SessionStore.append_message(session_id, role, content)`：持久化消息。
- `SessionStore.get_recent_messages(session_id, limit)`：读取最近上下文。
- `OpenAIAgent.reply(history)`：基于历史生成回复。
- `Orchestrator.handle_message(inbound_message)`：单条消息主处理流程。

## 9. 数据模型（如适用）

### 9.1 messages
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| id | INTEGER | 自增主键 | PK |
| session_id | TEXT | 会话键（channel+room+sender） | 非空，索引 |
| role | TEXT | user/assistant | 非空 |
| content | TEXT | 消息正文 | 非空 |
| created_at | DATETIME | 写入时间 | 默认当前时间 |

### 9.2 processed_events（P1）
| 字段 | 类型 | 说明 | 约束 |
|------|------|------|------|
| event_id | TEXT | IM 事件 ID | PK |
| session_id | TEXT | 所属会话 | 非空 |
| created_at | DATETIME | 记录时间 | 默认当前时间 |

## 10. 风险和注意事项
- ⚠️  Matrix SDK 与 homeserver 版本差异可能导致兼容性问题。
- ⚠️  长回复可能超过 IM 消息长度限制，需要分片发送（P1）。
- ⚠️  OpenAI 请求高延迟或限流会影响用户体验。
- ⚠️  凭据泄露风险，需要严格使用环境变量与最小权限账号。

## 11. 非功能需求
- 性能要求：单实例支持 >= 30 并发会话；普通回复 P95 < 12 秒（不含模型极端延迟）。
- 安全要求：不在日志打印密钥；最小化持久化敏感信息；支持前缀白名单策略。
- 兼容性要求：首期 Linux/macOS 可运行；Matrix 首期兼容 Synapse 主流版本。

---
生成时间：2026-03-02 21:00:10 CST
