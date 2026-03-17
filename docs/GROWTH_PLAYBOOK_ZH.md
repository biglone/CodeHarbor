# CodeHarbor 增长与社区运营手册（中文）

本文用于提升 CodeHarbor 的下载量、关注度与用户反馈质量。

## 1. 增长漏斗

把增长分成四个环节，逐环优化：

1. 被发现（Discovery）
2. 被试用（Activation）
3. 被留存（Retention）
4. 被反馈（Feedback）

## 2. 被发现：让用户先找到你

### 2.1 npm 页面可发现性

- 持续优化 `package.json` 的 `description` 与 `keywords`
- README 前 30 秒内必须给出：
  - 一句话价值说明
  - 安装命令
  - 最小可用示例

### 2.2 GitHub 仓库可发现性（需要仓库管理员在网页端设置）

- 设置仓库 Topics（至少：`matrix-bot`、`codex`、`claude-code`、`self-hosted`）
- 上传 Social Preview 图（用于链接卡片展示）

### 2.3 社区曝光

- 提交到 Matrix 生态清单（如 awesome-matrix）
- 在项目 README 放置可加入的社区入口（Matrix 房间 / Discussions）

## 3. 被试用：降低首次体验门槛

- 确保 README 有“复制即用”的 Quick Start
- 把“常见失败”放在最靠前位置（例如权限、登录、版本不一致）
- 每个发版都带可复制验证命令（例如 `/version`、`/diag version`）

## 4. 被留存：让用户第二次回来

- 每个版本强调用户可感知价值（不是只写内部重构）
- 关键变更必须有迁移说明（配置项、命令变化）
- 保持高频小版本，避免长期无更新

## 5. 被反馈：让建议可收集、可处理

本仓库已落地：

- Issue 模板（Bug / Feature）
- Pull Request 模板
- Release notes 分类配置

推荐再做（网页端）：

- 开启 GitHub Discussions
- 至少创建 3 个分类：`Q&A`、`Ideas`、`Announcements`

## 6. 反馈处理 SLA（建议）

- Bug 首次响应：24 小时内
- Feature 首次响应：72 小时内
- 每周固定一次 triage（清理未分类 issue/discussion）

## 7. 每周运营节奏（建议）

### 周一：看数据

- npm 周下载量
- GitHub Traffic（views/clones/referrers）
- 新增 issue/discussion 数量

### 周三：做改进

- 修 1 个高频痛点
- 提交 1 个“低门槛体验优化”（文档、帮助、默认值）

### 周五：做传播

- 发布版本说明（突出用户价值）
- 在 Discussions 发一条公告并征集反馈

## 8. 版本发布后必做清单

- `npm view codeharbor version` 确认线上版本
- README 中命令与新版本行为一致
- 在公告中给出“试用入口 + 反馈入口”
- 收集 3 条以上真实用户反馈后再排下一轮
