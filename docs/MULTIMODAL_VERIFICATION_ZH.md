# 多模态能力验证手册（中文）

本文用于上线前验证 CodeHarbor 的图片理解与语音转写能力。

## 1. 前置条件

- 已安装并登录 AI CLI（`codex login` / `claude login`）
- 已配置 Matrix 机器人账号（`MATRIX_HOMESERVER`、`MATRIX_USER_ID`、`MATRIX_ACCESS_TOKEN`）
- `.env` 建议最小配置：

```dotenv
CLI_COMPAT_FETCH_MEDIA=true
CLI_COMPAT_IMAGE_MAX_BYTES=10485760
CLI_COMPAT_IMAGE_MAX_COUNT=4
CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES=image/png,image/jpeg,image/webp,image/gif
CLI_COMPAT_TRANSCRIBE_AUDIO=true
# 二选一：本地 Whisper 或 OpenAI 回退
CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND=codeharbor-whisper-transcribe --input {input} --model small
# OPENAI_API_KEY=...
```

> 修改上述配置后，需重启 CodeHarbor 服务。

## 2. 验证用例

### 用例 A：Codex 图片理解（m.image）

1. Matrix 私聊发送：`/backend codex`
2. 发送一张 PNG/JPG 图片 + 文本：`请描述这张图的主要内容`
3. 预期结果：
   - 机器人返回图片分析结果
   - 无错误提示

### 用例 B：Claude 图片理解 + 降级重试

1. Matrix 私聊发送：`/backend claude`
2. 发送一张图片 + 文本问题
3. 预期结果：
   - 正常路径：直接返回图片分析
   - 异常路径（Claude 图片输入失败）：出现提示
     - `检测到 Claude 图片处理失败，已自动降级为纯文本重试...`
   - 随后仍有一次重试结果返回（成功或失败）

### 用例 C：语音理解（m.audio）

1. 发送一段语音（ogg/m4a/wav 等）
2. 发送文本：`请结合语音内容回答`
3. 预期结果：
   - 请求可继续处理
   - 转写成功时，回答会体现语音语义
   - 转写失败时，不会中断主流程（仅跳过转写）

## 3. 诊断检查

发送：

```text
/diag media 10
```

重点关注：

- `image.accepted` / `image.skipped_*`
- `audio.transcribed` / `audio.failed` / `audio.skipped_size`
- `claude.fallback_triggered` / `claude.fallback_ok` / `claude.fallback_failed`
- `records` 中最近事件明细（类型、requestId、原因）

## 4. 常见问题定位

- 图片被跳过：检查 MIME 白名单、图片大小、图片数量上限
- 语音未转写：检查 `CLI_COMPAT_TRANSCRIBE_AUDIO`、Whisper 命令可执行性、OpenAI Key
- `/help` 看不到多模态状态：确认已升级到包含该功能的版本并重启服务
