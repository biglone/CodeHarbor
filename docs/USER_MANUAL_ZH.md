# CodeHarbor 中文用户手册（安装-配置-验证）

这份手册面向运维同学和普通使用者，目标是让你按步骤完成：

- 安装 CodeHarbor
- 配置 Matrix + Codex
- 启动并验证可用
- 通过管理后台完成常见功能配置

如果你需要“所有配置项的完整字典”，请同时查看：

- [`docs/CONFIG_CATALOG.md`](./CONFIG_CATALOG.md)
- [`docs/COMPLETE_CONFIGURATION_GUIDE.md`](./COMPLETE_CONFIGURATION_GUIDE.md)

---

## 0. 使用前提（必须先准备）

在安装前，请先确认以下条件：

- 已安装并可执行 `codex` CLI
- 已完成 AI CLI 登录（任选其一）：
  - `codex login`
  - `claude login`
- 有可用的 Matrix 账号（建议单独机器人账号）
- 已获取 Matrix 机器人的 access token（用于 `MATRIX_ACCESS_TOKEN`）

可选但常见：

- 若你要启用“语音转写 OpenAI 回退”，还需要配置 `OPENAI_API_KEY`

---

## 1. 安装（推荐 Linux）

### 方式 A：先安装，再手动配置

```bash
npm install -g codeharbor
codeharbor init
```

推荐的 npm 包安装/升级/校验流程：

```bash
# 安装或升级到最新版本
npm install -g codeharbor@latest

# 校验本机已安装版本
codeharbor --version

# 一键升级并按平台执行重启策略
codeharbor self-update
```

### 方式 B：一条命令安装 + 写入基础配置（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/biglone/CodeHarbor/main/scripts/install-linux-easy.sh | bash -s -- \
  --matrix-homeserver https://matrix.example.com \
  --matrix-user-id @bot:example.com \
  --matrix-access-token 'your-token'
```

---

## 2. 必填配置（先保证能跑起来）

编辑 `.env`（默认在 `~/.codeharbor/.env`，旧环境可能在 `/opt/codeharbor/.env`）：

- `MATRIX_HOMESERVER`：Matrix 服务器地址
- `MATRIX_USER_ID`：机器人账号
- `MATRIX_ACCESS_TOKEN`：机器人 token
- `CODEX_WORKDIR`：Codex 默认工作目录（建议设置成项目根目录）

建议一起确认：

- `AI_CLI_PROVIDER`：`codex` 或 `claude`（默认 `codex`）
- `CODEX_BIN`：一般保持 `codex`
- `BACKEND_MODEL_ROUTING_RULES_JSON`：可选，按规则自动选择 `backend/model`（JSON 数组）
- `CONTEXT_BRIDGE_HISTORY_LIMIT` / `CONTEXT_BRIDGE_MAX_CHARS`：切换后一次性桥接上下文的历史窗口与长度上限
- `MATRIX_COMMAND_PREFIX`：群聊触发前缀，默认 `!code`

---

## 3. 启动与健康检查

```bash
codeharbor doctor
codeharbor start
```

查看完整命令帮助：

```bash
codeharbor --help
codeharbor admin --help
codeharbor config --help
codeharbor service --help
```

如果你要长期运行，建议安装系统服务：

```bash
codeharbor service install --with-admin
```

---

## 4. 管理后台使用（默认中文，可切英文）

启动后台：

```bash
codeharbor admin serve
```

打开浏览器访问：

- `http://127.0.0.1:8787/settings/global`
- `http://127.0.0.1:8787/settings/rooms`
- `http://127.0.0.1:8787/health`
- `http://127.0.0.1:8787/audit`

建议操作顺序：

1. 在“全局配置”调整前缀、工作目录、限流、CLI 兼容等。
2. 在“房间配置”设置房间是否启用、房间工作目录、触发策略。
3. 到“健康检查”确认 Codex/Matrix 都正常。
4. 到“配置审计”检查变更记录是否准确。

补充：`/health` 页面会显示 CodeHarbor 当前版本、最新版本（如可查询）以及是否可更新。

注意：全局配置保存后通常需要重启主服务才能完全生效（页面已提供重启按钮）。

---

## 5. 常用功能开关说明（实用版）

### 5.1 群聊触发相关

- `GROUP_DIRECT_MODE_ENABLED=true`：群里消息直接进入 AI（无需 @、回复、前缀）
- `GROUP_TRIGGER_ALLOW_*`：控制 mention/reply/活跃窗口/前缀哪些能触发
- `SESSION_ACTIVE_WINDOW_MINUTES`：会话活跃窗口时长

### 5.2 稳定性与防刷

- `RATE_LIMIT_WINDOW_SECONDS`
- `RATE_LIMIT_MAX_REQUESTS_PER_USER`
- `RATE_LIMIT_MAX_REQUESTS_PER_ROOM`
- `RATE_LIMIT_MAX_CONCURRENT_GLOBAL`
- `RATE_LIMIT_MAX_CONCURRENT_PER_USER`
- `RATE_LIMIT_MAX_CONCURRENT_PER_ROOM`

值设为 `0` 表示关闭该项限制（仅在你确认风险后再关）。

### 5.3 富文本显示与进度反馈

- `MATRIX_PROGRESS_UPDATES=true`：发送处理中进度
- `MATRIX_PROGRESS_MIN_INTERVAL_MS`：进度更新间隔
- `MATRIX_TYPING_TIMEOUT_MS`：输入中状态超时

### 5.4 图片与语音（附件）能力

- `CLI_COMPAT_FETCH_MEDIA=true`：下载并处理附件
  - 图片会在 Codex 后端走 `--image`，在 Claude 后端走 stream-json base64 图像块
- `CLI_COMPAT_IMAGE_MAX_BYTES`：单张图片大小上限（超限自动跳过并提示）
- `CLI_COMPAT_IMAGE_MAX_COUNT`：单次请求最多携带图片数（超出的会跳过并提示）
- `CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES`：允许的图片 MIME 白名单（逗号分隔）
- Claude 图片输入失败时会自动降级为“纯文本重试一次”，并在会话中提示
- `CLI_COMPAT_TRANSCRIBE_AUDIO=true`：开启音频转写
- `CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND`：本地 Whisper 命令（优先）
- `CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL`：OpenAI 转写模型（本地失败时可回退）
- `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES`：超大音频直接跳过，保护系统

### 5.5 多智能体工作流

- `AGENT_WORKFLOW_ENABLED=true`：开启 `/agents`、`/autodev`
- `AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS`：自动修复轮次上限
- `AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS`：可选，Planner 计划上下文最大字符数（默认不限）
- `AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS`：可选，Executor 输出上下文最大字符数（默认不限）
- `AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS`：可选，Reviewer 反馈上下文最大字符数（默认不限）
- `AGENT_WORKFLOW_ROLE_SKILLS_ENABLED=true|false`：是否启用角色 SKILL 注入（默认 true）
- `AGENT_WORKFLOW_ROLE_SKILLS_MODE=summary|progressive|full`：角色 SKILL 披露模式（默认 progressive）
- `AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS`：角色 SKILL 注入块最大字符数（默认 2400）
- `AGENT_WORKFLOW_ROLE_SKILLS_ROOTS`：可选，SKILL 根目录列表（逗号分隔，默认 `~/.codex/skills`）
- `AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON`：可选，角色到 SKILL 列表映射（JSON）
  - 默认映射已内置可开箱即用的基础 SKILL；若本地存在同名 SKILL，会自动覆盖内置版本
  - 内置兜底 SKILL 提示词统一维护为英文，保证国际化场景的一致默认体验
  - 默认内置映射：
    - planner: `task-planner`, `requirements-doc`, `builtin-planner-core`, `dependency-analyzer`
    - executor: `autonomous-dev`, `bug-finder`, `test-generator`, `builtin-executor-core`, `refactoring`
    - reviewer: `code-reviewer`, `security-audit`, `builtin-reviewer-core`, `changelog-generator`, `commit-message`
  - 可选扩展内置 SKILL（按需在 ASSIGNMENTS_JSON 中启用）：
    - 规划/设计：`api-designer`, `superpowers-workflow`, `brainstorming`, `planning-with-files`
    - 执行/测试：`performance-optimizer`, `auto-code-pipeline`, `migration-helper`, `tdd-workflow`, `webapp-testing`, `ui-ux-pro-max`, `pptx`, `ralph-loop`
    - 审查/发布：`commit-message`, `code-simplifier`, `multi-agent-code-review`
- `AUTODEV_LOOP_MAX_RUNS`：一次 `/autodev run` 最多尝试任务数（默认 20，`0` 表示不限制）
- `AUTODEV_LOOP_MAX_MINUTES`：一次 `/autodev run` 最长执行分钟数（默认 120，`0` 表示不限制）
- `AUTODEV_AUTO_COMMIT=true|false`：是否在审查通过后自动提交（默认 true）
- `AUTODEV_RUN_ARCHIVE_ENABLED=true|false`：是否将每次 `/autodev run` 过程归档落盘（默认 true）
- `AUTODEV_RUN_ARCHIVE_DIR`：归档目录（相对工作目录或绝对路径，默认 `.codeharbor/autodev-runs`）
- `AUTODEV_PREFLIGHT_AUTO_STASH=true|false`：Git 预检检测到脏工作区时自动 `stash` 后继续执行（默认 false）
- `AUTODEV_MAX_CONSECUTIVE_FAILURES`：同一任务连续失败达到阈值后自动标记 `🚫`（默认 3）
- `/autodev run`：循环执行任务清单（优先 `🔄`，再选 `⬜`），直到没有可执行任务
  - 当达到轮次/时间上限时会“暂停”并输出剩余任务摘要，可再次执行 `/autodev run` 续跑
- `/autodev run [taskId]`：只执行指定任务，不进入循环
- `/autodev stop`：不中断当前任务，等待当前任务完成后停止循环
- `TASK_LIST.md` 的任务状态由系统维护，尽量不要手工改；发生漂移优先用 `/autodev reconcile` 对账修复
- 循环护栏规则（建议）：
  - `AUTODEV_LOOP_MAX_RUNS=0`：轮次不限制
  - `AUTODEV_LOOP_MAX_MINUTES=0`：总时长不限制
  - 达到轮次/时间上限时是“安全暂停”而不是失败，可直接 `/autodev run` 续跑
  - `/autodev run [taskId]` 属于单任务模式，不消耗循环轮次/时间预算
  - 长周期任务建议将轮次/时长都设为 `0`，并保留 `AUTODEV_MAX_CONSECUTIVE_FAILURES` 与“无进展停止”作为安全护栏
- `/autodev workdir|wd [path]|status|clear`：查看/设置/清除当前会话 AutoDev 工作目录覆盖
- `/autodev init|i [path] [--from 文件]`：在目标项目初始化 `REQUIREMENTS.md`、`TASK_LIST.md`、`docs/AUTODEV_TASK_COMPASS.md`
  - 推荐移动端短流程：`//autodev init StrawBerry` -> `//autodev run`
  - 不传 `--from` 时会自动发现项目内设计/方案文档并用于初始化；传 `--from` 可强制指定来源文档
  - 初始化采用三阶段：Stage-A 固定模板生成、Stage-B AI 增强、Stage-C 硬校验（不合规自动回退到 Stage-A 基线）
  - Stage-B 仅在本次 `init` 新建了 `REQUIREMENTS.md` 与 `TASK_LIST.md` 时执行；若已有同名文件则默认保留并跳过增强
- `/autodev skills [on|off|summary|progressive|full|status]`：会话级控制角色 SKILL 开关与披露模式
- 审查通过（`APPROVED`）后会自动将任务状态写为 `✅`，并在 Git 工作区干净时自动提交：
  - 提交标题格式：`<type>(<scope>): <business-summary> (<taskId>)`（按任务目标与改动文件自动推断）
  - 标题摘要采用混合策略：优先使用 Reviewer `SUMMARY`（来自角色 SKILL 输出）；若与当前目标语言不匹配则自动回退到模板推断
  - 日志语言策略：新项目首条 AutoDev 提交默认英文；已有项目会跟随仓库近期提交日志的主语言
  - 提交正文固定包含：`Task-ID`、`Changed-files`、`Generated-by`
- AutoDev 结果消息会固定输出 `git commit` 与 `git changed files`
- 若运行前仓库已存在未提交改动，或当前目录不是 Git 仓库，会跳过自动提交并在结果消息提示原因
- 若开启 `AUTODEV_PREFLIGHT_AUTO_STASH=true`，脏工作区会自动暂存后继续运行（消息里会给出 stash 引用）
- 若 workflow 试图修改 `TASK_LIST.md`，系统会自动回滚，并以 `task-list-policy-violated` 拒绝完成 gate

### 5.6 版本检查与更新提示

- `/help`：查看机器人可用命令列表（包含当前多模态状态摘要）
- 若 Matrix 客户端拦截 `/...`，可改发 `//...`（适用于所有斜杠命令；例如 `//status`、`//version`、`//diag queue 5`、`//upgrade`、`//autodev init StrawBerry`、`//autodev run T6.2`）
- `/status`：包含当前版本、更新提示、最近升级结果、最近升级记录（带任务ID）、升级指标/锁状态，以及最近一次检查时间（缓存结果，受 TTL 控制）
- `/version`：单独查看当前版本与更新提示（会强制实时检查）
- `/diag version`：输出运行实例诊断信息（PID、启动时间、执行路径、当前后端）
- `/diag media [count]`：输出多模态诊断（图片/语音计数器 + 最近处理记录）
- `/diag upgrade [count]`：输出升级诊断信息（分布式升级锁、聚合指标、最近升级记录）
- `/diag route [count]`：输出后端路由诊断（策略命中/回退原因 + 最近路由记录）
- `/diag autodev [count]`：输出 AutoDev 诊断（最近运行状态统计、循环快照、最近 Git 提交记录与阶段轨迹）
- `/diag queue [count]`：输出可恢复任务队列诊断（pending/running 计数、待重试会话、失败归档）
- `/upgrade [version]`：在私聊中触发升级与自动重启（默认 latest，也可指定版本）
  - 权限优先级：`MATRIX_UPGRADE_ALLOWED_USERS` > `MATRIX_ADMIN_USERS` > 任意私聊用户（两者都为空时）
  - Linux 支持 systemd 信号重启回退；macOS 支持 launchd/手工回退；Windows 默认安全降级为手工回退
  - 会输出结构化升级结果摘要（成功/失败）与回滚/重启命令模板，降低失败恢复成本
- `/backend codex|claude [model] | /backend auto|status`：会话内切换后端工具（`auto` 恢复自动路由）；切换后下一条请求会自动注入最近本地会话历史作为桥接上下文
- `/reset`：清空会话上下文，并抑制“下一条请求自动桥接”，用于强制从空上下文开始
- `/stop`：请求停止当前执行（繁忙时进入待停止），并清理会话上下文/当前会话待处理队列
  - 别名：`/cancel`、`/esc`、`/撤回`、`/撤销`
- `PACKAGE_UPDATE_CHECK_ENABLED=true|false`：是否启用版本更新检查
- `PACKAGE_UPDATE_CHECK_TIMEOUT_MS`：检查超时时间（毫秒）
- `PACKAGE_UPDATE_CHECK_TTL_MS`：更新检查结果缓存时长（毫秒，默认 6 小时）
- `MATRIX_ADMIN_USERS`：可选；Matrix 管理员列表（逗号分隔 mxid），当 `MATRIX_UPGRADE_ALLOWED_USERS` 为空时生效
- `MATRIX_UPGRADE_ALLOWED_USERS`：可选；显式限制哪些 Matrix 用户可执行 `/upgrade`（逗号分隔 mxid，优先级高于 `MATRIX_ADMIN_USERS`）
- `CODEHARBOR_LAUNCHD_MAIN_LABEL` / `CODEHARBOR_LAUNCHD_ADMIN_LABEL`：可选；macOS 下升级/安装后自动重启使用的 launchd label

---

## 6. 安全建议（强烈推荐）

如果后台要非本机访问，请务必开启鉴权：

- `ADMIN_TOKEN`（单 token）
- 或 `ADMIN_TOKENS_JSON`（RBAC，支持 `admin` / `viewer`）

可选再加：

- `ADMIN_IP_ALLOWLIST`
- `ADMIN_ALLOWED_ORIGINS`

不要在公网暴露“无 token”的管理后台。

---

## 7. 验证清单（上线前）

- `codeharbor doctor` 通过
- DM 发消息，机器人能回复
- 群聊触发策略符合预期
- 管理后台 `health` 正常
- `/status` 返回会话状态与运行指标
- `/version` 返回当前版本与更新提示
- `/diag version` / `/diag route` / `/diag autodev` / `/diag queue` 可返回诊断信息（如启用队列则校验 queue 明细）
- 管理后台 `audit` 能看到配置变更
- 重启按钮或 `codeharbor service restart --with-admin` 可用
- 升级后版本正确：`codeharbor --version`

---

## 8. 升级方式

```bash
npm install -g codeharbor@latest
codeharbor --version
```

全局安装场景下，升级后会按平台尽力自动重启服务以让新版本立即生效：

- Linux：重启活动的 `codeharbor(.service)` systemd 单元
- macOS：尝试重启配置的 launchd jobs（默认 `com.codeharbor.main` / `com.codeharbor.admin`）
- Windows：默认不自动重启，输出可复制的 PowerShell 手工重启命令

也可以直接使用：

```bash
codeharbor self-update
```

该命令会安装最新版本并执行跨平台重启策略，同时输出结构化结果摘要（状态、安装版本、回滚命令、重启命令）。

如果你希望直接在 Matrix 私聊里执行升级，可发送：

- `/upgrade`
- `/upgrade 0.1.33`
- `/diag upgrade 5`（查看最近升级诊断）

---

## 9. 常见问题

### Q1：为什么保存了配置但行为没变？

大多数全局配置是“重启生效”，请重启主服务后再验证。

### Q2：为什么语音消息没有转写？

先检查：

- `CLI_COMPAT_FETCH_MEDIA=true`
- `CLI_COMPAT_TRANSCRIBE_AUDIO=true`
- 本地 Whisper 命令是否可执行（或 OpenAI key 是否可用）

### Q3：为什么图片没有进入模型分析？

先检查：

- `CLI_COMPAT_FETCH_MEDIA=true`
- 图片 MIME 是否在 `CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES` 白名单
- 图片体积是否超过 `CLI_COMPAT_IMAGE_MAX_BYTES`
- 单次图片数量是否超过 `CLI_COMPAT_IMAGE_MAX_COUNT`
- 发送 `/diag media 10` 查看最近被跳过的原因

### Q4：为什么管理后台显示无权限？

先在页面填写 `Admin Token` 并点击“保存认证”，再看权限状态是否变为 `ADMIN` 或 `VIEWER`。
