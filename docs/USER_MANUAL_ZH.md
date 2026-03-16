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
- `CLI_COMPAT_TRANSCRIBE_AUDIO=true`：开启音频转写
- `CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND`：本地 Whisper 命令（优先）
- `CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL`：OpenAI 转写模型（本地失败时可回退）
- `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES`：超大音频直接跳过，保护系统

### 5.5 多智能体工作流

- `AGENT_WORKFLOW_ENABLED=true`：开启 `/agents`、`/autodev`
- `AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS`：自动修复轮次上限

### 5.6 版本检查与更新提示

- `/help`：查看机器人可用命令列表
- `/status`：包含当前版本、更新提示、最近升级结果、最近升级记录（带任务ID）和最近一次检查时间（缓存结果，受 TTL 控制）
- `/version`：单独查看当前版本与更新提示（会强制实时检查）
- `/diag version`：输出运行实例诊断信息（PID、启动时间、执行路径、当前后端）
- `/upgrade [version]`：在私聊中触发升级与自动重启（默认 latest，也可指定版本）
  - 在 systemd `NoNewPrivileges=true` 场景下会自动走信号重启回退，无需手工 sudo 重启
- `/backend codex|claude|status`：会话内切换后端工具；切换后下一条请求会自动注入最近本地会话历史作为桥接上下文
- `/reset`、`/stop`：会清理会话，并抑制“下一条请求自动桥接”，用于强制从空上下文开始
- `PACKAGE_UPDATE_CHECK_ENABLED=true|false`：是否启用版本更新检查
- `PACKAGE_UPDATE_CHECK_TIMEOUT_MS`：检查超时时间（毫秒）
- `PACKAGE_UPDATE_CHECK_TTL_MS`：更新检查结果缓存时长（毫秒，默认 6 小时）
- `MATRIX_UPGRADE_ALLOWED_USERS`：可选；限制哪些 Matrix 用户可执行 `/upgrade`（逗号分隔 mxid）

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
- `/version` 返回当前版本与更新提示
- 管理后台 `audit` 能看到配置变更
- 重启按钮或 `codeharbor service restart --with-admin` 可用
- 升级后版本正确：`codeharbor --version`

---

## 8. 升级方式

```bash
npm install -g codeharbor@latest
codeharbor --version
```

Linux 全局安装场景下，升级后会尽力自动重启服务以让新版本立即生效。

也可以直接使用：

```bash
codeharbor self-update
```

该命令会安装最新版本并尝试重启已安装的 systemd 主服务（可选 admin 服务）。

如果你希望直接在 Matrix 私聊里执行升级，可发送：

- `/upgrade`
- `/upgrade 0.1.33`

---

## 9. 常见问题

### Q1：为什么保存了配置但行为没变？

大多数全局配置是“重启生效”，请重启主服务后再验证。

### Q2：为什么语音消息没有转写？

先检查：

- `CLI_COMPAT_FETCH_MEDIA=true`
- `CLI_COMPAT_TRANSCRIBE_AUDIO=true`
- 本地 Whisper 命令是否可执行（或 OpenAI key 是否可用）

### Q3：为什么管理后台显示无权限？

先在页面填写 `Admin Token` 并点击“保存认证”，再看权限状态是否变为 `ADMIN` 或 `VIEWER`。
