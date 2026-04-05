export const ADMIN_CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeHarbor 管理后台 / Admin Console</title>
    <style>
      :root {
        --bg-start: #0f172a;
        --bg-end: #1e293b;
        --panel: #0b1224cc;
        --panel-border: #334155;
        --text: #e2e8f0;
        --muted: #94a3b8;
        --accent: #22d3ee;
        --accent-strong: #06b6d4;
        --danger: #f43f5e;
        --ok: #10b981;
        --warn: #f59e0b;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", "Helvetica Neue", sans-serif;
        color: var(--text);
        background: radial-gradient(1200px 600px at 20% -10%, #1d4ed8 0%, transparent 55%),
          radial-gradient(1000px 500px at 100% 0%, #0f766e 0%, transparent 55%),
          linear-gradient(135deg, var(--bg-start), var(--bg-end));
        min-height: 100vh;
      }
      .shell {
        max-width: 1320px;
        margin: 0 auto;
        padding: 20px 16px 40px;
      }
      .header {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 16px;
        padding: 16px;
        backdrop-filter: blur(8px);
        margin-bottom: 14px;
      }
      .title {
        margin: 0 0 8px;
        font-size: 24px;
        letter-spacing: 0.2px;
      }
      .subtitle {
        margin: 0 0 14px;
        color: var(--muted);
        font-size: 14px;
      }
      .workspace {
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr);
        gap: 14px;
        align-items: start;
      }
      .sidebar {
        position: sticky;
        top: 20px;
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 16px;
        padding: 14px 12px;
        backdrop-filter: blur(8px);
      }
      .menu {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .menu-group-title {
        margin: 8px 4px 2px;
        color: #7dd3fc;
        font-size: 11px;
        letter-spacing: 0.8px;
        text-transform: uppercase;
      }
      .submenu {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin: -2px 0 6px;
      }
      .tab {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        color: var(--text);
        text-decoration: none;
        border: 1px solid var(--panel-border);
        border-radius: 10px;
        padding: 9px 12px;
        font-size: 12px;
        text-align: left;
        min-height: 40px;
        transition: border-color 0.16s ease, background-color 0.16s ease, transform 0.16s ease;
      }
      .tab:hover {
        border-color: #4fd1e8;
        background: #133347;
      }
      .tab-parent {
        font-weight: 600;
      }
      .tab-sub {
        margin-left: 14px;
        font-size: 11px;
        color: #cbd5e1;
        background: #0f172acc;
        border-color: #374151;
        min-height: 36px;
      }
      .tab.active {
        border-color: var(--accent);
        background: linear-gradient(90deg, #164e63cc, #0f2942cc);
      }
      .content {
        min-width: 0;
      }
      .auth-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(220px, 1fr)) auto auto;
        gap: 8px;
        align-items: end;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field-label {
        font-size: 12px;
        color: var(--muted);
      }
      input,
      select,
      button,
      textarea {
        font: inherit;
      }
      input[type="text"],
      input[type="password"],
      input[type="number"],
      select,
      textarea {
        border: 1px solid var(--panel-border);
        background: #0f172acc;
        color: var(--text);
        border-radius: 10px;
        padding: 8px 10px;
      }
      button {
        border: 1px solid var(--accent);
        background: #164e63;
        color: #ecfeff;
        border-radius: 10px;
        padding: 8px 12px;
        cursor: pointer;
      }
      button.secondary {
        border-color: var(--panel-border);
        background: #1e293b;
        color: var(--text);
      }
      button.danger {
        border-color: var(--danger);
        background: #881337;
      }
      textarea {
        resize: vertical;
        min-height: 96px;
      }
      .notice {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 1000;
        max-width: min(560px, calc(100vw - 32px));
        margin: 0;
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 13px;
        border: 1px solid #334155;
        color: var(--muted);
        background: #0b1224ee;
        box-shadow: 0 12px 28px #020617aa;
        opacity: 0;
        transform: translateY(8px);
        pointer-events: none;
        transition:
          opacity 0.2s ease,
          transform 0.2s ease;
      }
      .notice-content {
        display: flex;
        gap: 8px;
        align-items: flex-start;
      }
      .notice-text {
        flex: 1 1 auto;
        min-width: 0;
      }
      .notice-close {
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        padding: 0 2px;
        line-height: 1;
        font-size: 16px;
        opacity: 0.9;
      }
      .notice-close:hover {
        opacity: 1;
      }
      .notice.visible {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      .notice.ok {
        border-color: #065f46;
        color: #d1fae5;
        background: #064e3b88;
      }
      .notice.error {
        border-color: #881337;
        color: #ffe4e6;
        background: #4c051988;
      }
      .notice.warn {
        border-color: #92400e;
        color: #fef3c7;
        background: #78350f88;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 16px;
        padding: 16px;
      }
      .content > .panel {
        margin-top: 0;
      }
      .panel[hidden] {
        display: none;
      }
      .panel-title {
        margin: 0 0 12px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }
      .full {
        grid-column: 1 / -1;
      }
      .checkbox {
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: 14px;
      }
      .actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid #334155;
        border-radius: 12px;
        margin-top: 12px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 720px;
      }
      th,
      td {
        border-bottom: 1px solid #334155;
        text-align: left;
        padding: 8px;
        font-size: 12px;
        vertical-align: top;
      }
      th {
        color: var(--muted);
      }
      tr.row-active {
        background: #0e749066;
      }
      .split-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
        gap: 12px;
        align-items: start;
      }
      details.advanced-json {
        margin-top: 12px;
        border: 1px solid #334155;
        border-radius: 10px;
        padding: 8px 10px;
        background: #0f172a88;
      }
      details.advanced-json summary {
        cursor: pointer;
        color: #93c5fd;
        font-size: 12px;
      }
      .table-actions {
        width: 110px;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 11px;
        color: #cbd5e1;
      }
      .muted {
        color: var(--muted);
        font-size: 12px;
      }
      [hidden] {
        display: none !important;
      }
      @media (max-width: 1024px) {
        .workspace {
          grid-template-columns: 240px minmax(0, 1fr);
        }
      }
      @media (max-width: 900px) {
        .auth-row {
          grid-template-columns: 1fr;
        }
        .grid {
          grid-template-columns: 1fr;
        }
        .workspace {
          grid-template-columns: 1fr;
        }
        .split-grid {
          grid-template-columns: 1fr;
        }
        .sidebar {
          position: static;
        }
        .menu {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        .menu-group-title {
          grid-column: 1 / -1;
          margin-top: 4px;
        }
        .submenu {
          margin: 0;
          gap: 6px;
        }
        .tab-sub {
          margin-left: 0;
        }
      }
      @media (max-width: 640px) {
        .notice {
          left: 12px;
          right: 12px;
          bottom: 12px;
          max-width: none;
        }
        .menu {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="header">
        <h1 class="title" data-i18n="header.title">CodeHarbor 管理后台</h1>
        <p class="subtitle" data-i18n="header.subtitle">通过左侧分层菜单管理全局配置、房间策略、健康检查与配置审计记录。</p>
        <div class="auth-row">
          <label class="field">
            <span class="field-label" data-i18n="auth.token.label">管理员令牌（可选）</span>
            <input id="auth-token" type="password" placeholder="ADMIN_TOKEN" data-i18n-placeholder="auth.token.placeholder" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="auth.actor.label">操作者（用于审计日志）</span>
            <input id="auth-actor" type="text" placeholder="你的名字" data-i18n-placeholder="auth.actor.placeholder" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="auth.language.label">界面语言</span>
            <select id="lang-select">
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <button id="auth-save-btn" type="button" class="secondary" data-i18n="auth.save">保存认证</button>
          <button id="auth-clear-btn" type="button" class="secondary" data-i18n="auth.clear">清除认证</button>
        </div>
        <div id="notice" class="notice" role="status" aria-live="polite" aria-atomic="true">
          <div class="notice-content">
            <span id="notice-text" class="notice-text" data-i18n="notice.ready">就绪。</span>
            <button id="notice-close-btn" class="notice-close" type="button" data-i18n-aria-label="notice.dismiss">×</button>
          </div>
        </div>
        <p id="auth-role" class="muted" data-i18n="auth.permission.unknown">权限：未知</p>
      </section>

      <div class="workspace">
        <aside class="sidebar">
          <nav class="menu" aria-label="Admin navigation">
            <p class="menu-group-title" data-i18n="menu.group.global">全局配置</p>
            <a
              class="tab tab-parent"
              data-page="settings-global"
              data-route="#/settings/global/basic"
              data-route-prefix="#/settings/global/"
              href="#/settings/global/basic"
              data-i18n="menu.global"
            >全局配置中心</a>
            <div class="submenu">
              <a class="tab tab-sub" data-page="settings-global" data-route="#/settings/global/basic" href="#/settings/global/basic" data-i18n="tab.globalBasic">基础设置</a>
              <a class="tab tab-sub" data-page="settings-global" data-route="#/settings/global/autodev" href="#/settings/global/autodev" data-i18n="tab.globalAutoDev">AutoDev 策略</a>
              <a class="tab tab-sub" data-page="settings-global" data-route="#/settings/global/rate" href="#/settings/global/rate" data-i18n="tab.globalRate">限流与并发</a>
              <a class="tab tab-sub" data-page="settings-global" data-route="#/settings/global/triggers" href="#/settings/global/triggers" data-i18n="tab.globalTriggers">触发策略</a>
              <a class="tab tab-sub" data-page="settings-global" data-route="#/settings/global/cli" href="#/settings/global/cli" data-i18n="tab.globalCli">CLI 与多模态</a>
              <a class="tab tab-sub" data-page="settings-global" data-route="#/settings/global/agent" href="#/settings/global/agent" data-i18n="tab.globalAgent">技能与高级</a>
              <a class="tab tab-sub" data-page="settings-global" data-route="#/settings/global/snapshot" href="#/settings/global/snapshot" data-i18n="tab.globalSnapshot">快照与重启</a>
            </div>

            <p class="menu-group-title" data-i18n="menu.group.instances">实例编排</p>
            <a class="tab tab-parent" data-page="settings-bots" data-route="#/settings/bots" href="#/settings/bots" data-i18n="tab.bots">机器人实例</a>

            <p class="menu-group-title" data-i18n="menu.group.workspace">房间治理</p>
            <a class="tab tab-parent" data-page="settings-rooms" data-route="#/settings/rooms" href="#/settings/rooms" data-i18n="tab.rooms">房间配置</a>

            <p class="menu-group-title" data-i18n="menu.group.observe">运行观测</p>
            <a class="tab tab-parent" data-page="diagnostics" data-route="#/diagnostics" href="#/diagnostics" data-i18n="tab.diagnostics">运行诊断</a>
            <a class="tab tab-parent" data-page="health" data-route="#/health" href="#/health" data-i18n="tab.health">健康检查</a>
            <a class="tab tab-parent" data-page="audit" data-route="#/audit" href="#/audit" data-i18n="tab.audit">配置审计</a>
          </nav>
        </aside>

        <section class="content">
      <section class="panel" data-view="settings-global">
        <h2 class="panel-title" data-i18n="global.title">全局配置</h2>
        <div class="grid" id="global-grid">
          <label class="field">
            <span class="field-label" data-i18n="global.commandPrefix">命令前缀</span>
            <input id="global-matrix-prefix" type="text" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.defaultWorkdir">默认工作目录</span>
            <input id="global-workdir" type="text" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.outputLanguage">机器人输出语言</span>
            <select id="global-output-language">
              <option value="zh">zh</option>
              <option value="en">en</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.progressInterval">进度更新间隔（毫秒）</span>
            <input id="global-progress-interval" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.progressDeliveryMode">进度投递模式</span>
            <select id="global-progress-delivery-mode">
              <option value="upsert">upsert</option>
              <option value="timeline">timeline</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.typingTimeout">输入状态超时（毫秒）</span>
            <input id="global-typing-timeout" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.sessionWindow">会话活跃窗口（分钟）</span>
            <input id="global-active-window" type="number" min="1" />
          </label>
          <label class="checkbox">
            <input id="global-update-check-enabled" type="checkbox" />
            <span data-i18n="global.updateCheckEnabled">启用版本更新检查</span>
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.updateCheckTimeout">更新检查超时（毫秒）</span>
            <input id="global-update-check-timeout" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.updateCheckTtl">更新检查缓存时间（毫秒）</span>
            <input id="global-update-check-ttl" type="number" min="1" />
          </label>
          <label class="checkbox">
            <input id="global-progress-enabled" type="checkbox" />
            <span data-i18n="global.progressEnabled">启用进度更新</span>
          </label>
          <label class="checkbox">
            <input id="global-notice-badge-enabled" type="checkbox" />
            <span data-i18n="global.noticeBadgeEnabled">启用 Matrix 消息徽标（CodeHarbor 提示/AI 回复）</span>
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.autodevLoopMaxRuns">AutoDev 循环最大轮次（0=不限制）</span>
            <input id="global-autodev-loop-max-runs" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.autodevLoopMaxMinutes">AutoDev 循环最大分钟（0=不限制）</span>
            <input id="global-autodev-loop-max-minutes" type="number" min="0" />
          </label>
          <label class="checkbox">
            <input id="global-autodev-auto-commit" type="checkbox" />
            <span data-i18n="global.autodevAutoCommit">AutoDev 自动提交</span>
          </label>
          <label class="checkbox">
            <input id="global-autodev-auto-release-enabled" type="checkbox" />
            <span data-i18n="global.autodevAutoReleaseEnabled">AutoDev 自动发布</span>
          </label>
          <label class="checkbox">
            <input id="global-autodev-auto-release-push" type="checkbox" />
            <span data-i18n="global.autodevAutoReleasePush">AutoDev 自动推送发布提交</span>
          </label>
          <label class="checkbox">
            <input id="global-bot-profiles-auto-retire-default" type="checkbox" />
            <span data-i18n="global.botProfilesAutoRetireDefault">机器人实例 apply 默认自动退役单实例服务</span>
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.autodevMaxConsecutiveFailures">AutoDev 最大连续失败次数</span>
            <input id="global-autodev-max-consecutive-failures" type="number" min="1" />
          </label>
          <label class="checkbox">
            <input id="global-autodev-init-enhancement-enabled" type="checkbox" />
            <span data-i18n="global.autodevInitEnhancementEnabled">启用 /autodev init Stage-B 增强</span>
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.autodevInitEnhancementTimeout">Stage-B 增强超时（毫秒）</span>
            <input id="global-autodev-init-enhancement-timeout" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.autodevInitEnhancementMaxChars">Stage-B 增强提示预算（字符）</span>
            <input id="global-autodev-init-enhancement-max-chars" type="number" min="1" />
          </label>

          <label class="field">
            <span class="field-label" data-i18n="global.rateWindow">限流窗口（毫秒）</span>
            <input id="global-rate-window" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.rateUser">单用户窗口最大请求数</span>
            <input id="global-rate-user" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.rateRoom">单房间窗口最大请求数</span>
            <input id="global-rate-room" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.concurrentGlobal">全局最大并发</span>
            <input id="global-concurrency-global" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.concurrentUser">单用户最大并发</span>
            <input id="global-concurrency-user" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.concurrentRoom">单房间最大并发</span>
            <input id="global-concurrency-room" type="number" min="0" />
          </label>

          <label class="checkbox"><input id="global-direct-mode" type="checkbox" /><span data-i18n="global.groupDirect">群聊直通模式（无需触发）</span></label>
          <label class="checkbox"><input id="global-trigger-mention" type="checkbox" /><span data-i18n="global.triggerMention">触发：提及机器人</span></label>
          <label class="checkbox"><input id="global-trigger-reply" type="checkbox" /><span data-i18n="global.triggerReply">触发：回复机器人</span></label>
          <label class="checkbox"><input id="global-trigger-window" type="checkbox" /><span data-i18n="global.triggerWindow">触发：活跃窗口</span></label>
          <label class="checkbox"><input id="global-trigger-prefix" type="checkbox" /><span data-i18n="global.triggerPrefix">触发：命令前缀</span></label>

          <label class="checkbox"><input id="global-cli-enabled" type="checkbox" /><span data-i18n="global.cliEnabled">CLI 兼容模式</span></label>
          <label class="checkbox"><input id="global-cli-pass" type="checkbox" /><span data-i18n="global.cliPass">CLI 透传事件</span></label>
          <label class="checkbox"><input id="global-cli-whitespace" type="checkbox" /><span data-i18n="global.cliWhitespace">保留空白符</span></label>
          <label class="checkbox"><input id="global-cli-disable-split" type="checkbox" /><span data-i18n="global.cliDisableSplit">禁用回复分片</span></label>
          <label class="field">
            <span class="field-label" data-i18n="global.cliThrottle">CLI 进度节流（毫秒）</span>
            <input id="global-cli-throttle" type="number" min="0" />
          </label>
          <label class="checkbox"><input id="global-cli-fetch-media" type="checkbox" /><span data-i18n="global.cliFetchMedia">下载媒体附件</span></label>
          <label class="field">
            <span class="field-label" data-i18n="global.cliImageMaxBytes">图片最大字节数</span>
            <input id="global-cli-image-max-bytes" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.cliImageMaxCount">图片最大数量</span>
            <input id="global-cli-image-max-count" type="number" min="1" />
          </label>
          <label class="field full">
            <span class="field-label" data-i18n="global.cliImageMimeTypes">图片允许 MIME（逗号分隔）</span>
            <input id="global-cli-image-mime-types" type="text" />
          </label>
          <label class="checkbox"><input id="global-cli-transcribe-audio" type="checkbox" /><span data-i18n="global.cliTranscribeAudio">转写音频附件</span></label>
          <label class="field">
            <span class="field-label" data-i18n="global.audioModel">音频转写模型</span>
            <input id="global-cli-audio-model" type="text" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.audioTimeout">音频转写超时（毫秒）</span>
            <input id="global-cli-audio-timeout" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.audioMaxChars">音频转写最大字符数</span>
            <input id="global-cli-audio-max-chars" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.audioMaxRetries">音频转写最大重试次数</span>
            <input id="global-cli-audio-max-retries" type="number" min="0" max="10" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.audioRetryDelay">音频转写重试间隔（毫秒）</span>
            <input id="global-cli-audio-retry-delay" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.audioMaxBytes">音频最大字节数</span>
            <input id="global-cli-audio-max-bytes" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.audioLocalCommand">本地 Whisper 命令</span>
            <input id="global-cli-audio-local-command" type="text" placeholder='python3 /opt/whisper/transcribe.py --input {input}' data-i18n-placeholder="global.audioLocalCommandPlaceholder" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.audioLocalTimeout">本地 Whisper 超时（毫秒）</span>
            <input id="global-cli-audio-local-timeout" type="number" min="1" />
          </label>
          <label class="field full">
            <span class="field-label" data-i18n="global.cliRecordPath">CLI 回放记录文件路径（可选）</span>
            <input id="global-cli-record-path" type="text" placeholder="./logs/cli-record.ndjson" data-i18n-placeholder="global.cliRecordPathPlaceholder" />
          </label>
          <label class="checkbox"><input id="global-proxy-enabled" type="checkbox" /><span data-i18n="global.proxyEnabled">启用 CLI 代理</span></label>
          <label class="field full">
            <span class="field-label" data-i18n="global.proxyHttp">HTTP 代理（HTTP_PROXY）</span>
            <input id="global-proxy-http" type="text" placeholder="http://127.0.0.1:7890" />
          </label>
          <label class="field full">
            <span class="field-label" data-i18n="global.proxyHttps">HTTPS 代理（HTTPS_PROXY）</span>
            <input id="global-proxy-https" type="text" placeholder="http://127.0.0.1:7890" />
          </label>
          <label class="field full">
            <span class="field-label" data-i18n="global.proxyAll">全局代理（ALL_PROXY）</span>
            <input id="global-proxy-all" type="text" placeholder="socks5://127.0.0.1:7890" />
          </label>
          <label class="field full">
            <span class="field-label" data-i18n="global.proxyNo">代理白名单（NO_PROXY）</span>
            <input id="global-proxy-no" type="text" placeholder="localhost,127.0.0.1" />
          </label>
          <label class="checkbox"><input id="global-agent-enabled" type="checkbox" /><span data-i18n="global.agentEnabled">启用多智能体工作流</span></label>
          <label class="field">
            <span class="field-label" data-i18n="global.agentRounds">工作流自动修复轮次</span>
            <input id="global-agent-repair-rounds" type="number" min="0" max="10" />
          </label>
          <label class="checkbox"><input id="global-agent-skills-enabled" type="checkbox" /><span data-i18n="global.agentSkillsEnabled">启用角色技能注入</span></label>
          <label class="field">
            <span class="field-label" data-i18n="global.agentSkillsMode">角色技能披露模式</span>
            <select id="global-agent-skills-mode">
              <option value="summary">summary</option>
              <option value="progressive">progressive</option>
              <option value="full">full</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label" data-i18n="global.agentSkillsMaxChars">角色技能提示上限字符数（留空=默认）</span>
            <input id="global-agent-skills-max-chars" type="number" min="1" />
          </label>
          <label class="field full">
            <span class="field-label" data-i18n="global.agentSkillsRoots">角色技能根目录（逗号分隔）</span>
            <input
              id="global-agent-skills-roots"
              type="text"
              placeholder="/home/user/.codex/skills,/opt/codeharbor/skills"
              data-i18n-placeholder="global.agentSkillsRootsPlaceholder"
            />
          </label>
          <label class="field full">
            <span class="field-label" data-i18n="global.agentSkillsAssignments">角色技能分配 JSON（planner/executor/reviewer）</span>
            <textarea id="global-agent-skills-assignments" rows="6" placeholder='{"planner":["task-planner"],"executor":["autonomous-dev"],"reviewer":["code-reviewer"]}' data-i18n-placeholder="global.agentSkillsAssignmentsPlaceholder"></textarea>
          </label>
          <div class="field full">
            <span class="field-label" data-i18n="global.agentSkillsCatalog">可用 SKILL 目录（内置 + 本地）</span>
            <div class="actions">
              <button id="global-agent-skills-refresh-btn" type="button" class="secondary" data-i18n="global.agentSkillsRefresh">刷新 SKILL 目录</button>
            </div>
            <textarea id="global-agent-skills-catalog" rows="8" readonly></textarea>
            <p id="global-agent-skills-missing" class="muted" data-i18n="global.agentSkillsMissingEmpty">缺失 SKILL：无</p>
          </div>
          <label class="field full">
            <span class="field-label" data-i18n="global.envOverrides">高级环境变量覆盖（JSON，可选）</span>
            <textarea id="global-env-overrides" rows="8" placeholder='{"AUTODEV_STAGE_OUTPUT_ECHO_ENABLED":"true","AUTODEV_PREFLIGHT_AUTO_STASH":"true","AUTODEV_RUN_ARCHIVE_ENABLED":"true","AUTODEV_RUN_ARCHIVE_DIR":".codeharbor/autodev-runs"}' data-i18n-placeholder="global.envOverridesPlaceholder"></textarea>
            <p class="muted" data-i18n="global.envOverridesHint">
              常用 AutoDev 覆盖键：AUTODEV_STAGE_OUTPUT_ECHO_ENABLED、AUTODEV_PREFLIGHT_AUTO_STASH、AUTODEV_RUN_ARCHIVE_ENABLED、AUTODEV_RUN_ARCHIVE_DIR
            </p>
          </label>
        </div>
        <div id="global-main-actions" class="actions">
          <button id="global-save-btn" type="button" data-i18n="global.save">保存全局配置</button>
          <button id="global-validate-btn" type="button" class="secondary" data-i18n="global.validate">校验全局配置</button>
          <button id="global-reload-btn" type="button" class="secondary" data-i18n="global.reload">重新加载</button>
          <button id="global-restart-main-btn" type="button" class="secondary" data-i18n="global.restartMain">重启主服务</button>
          <button id="global-restart-all-btn" type="button" class="secondary" data-i18n="global.restartAll">重启主服务+管理后台</button>
        </div>
        <p id="global-restart-hint" class="muted" data-i18n="global.restartHint">保存全局配置会更新 .env，并需要重启后完全生效。</p>

        <div id="global-snapshot-block" hidden>
          <h3 class="panel-title" style="margin-top: 18px;" data-i18n="snapshot.title">配置导入/导出</h3>
          <div class="actions">
            <button id="config-export-btn" type="button" class="secondary" data-i18n="snapshot.export">导出配置快照</button>
          </div>
          <div class="grid">
            <label class="field full">
              <span class="field-label" data-i18n="snapshot.importFile">导入文件（JSON）</span>
              <input id="config-import-file" type="file" accept="application/json,.json" />
            </label>
          </div>
          <div class="actions">
            <button id="config-import-dry-run-btn" type="button" class="secondary" data-i18n="snapshot.importDryRun">先执行 dry-run</button>
            <button id="config-import-apply-btn" type="button" data-i18n="snapshot.importApply">应用导入</button>
          </div>
        </div>
      </section>

      <section class="panel" data-view="settings-bots" hidden>
        <h2 class="panel-title" data-i18n="bots.title">机器人实例</h2>
        <p class="muted" data-i18n="bots.description">
          在同一管理后台维护多实例配置：每个实例对应独立 Matrix 账号、运行目录和可选后端模型。保存后可一键应用服务变更。
        </p>
        <div class="actions">
          <button id="bots-load-btn" type="button" class="secondary" data-i18n="bots.load">加载实例配置</button>
          <button id="bots-save-btn" type="button" data-i18n="bots.save">保存实例配置</button>
          <button id="bots-migrate-dry-run-btn" type="button" class="secondary" data-i18n="bots.migrateDryRun">迁移预检（单实例）</button>
          <button id="bots-migrate-apply-btn" type="button" class="secondary" data-i18n="bots.migrateApply">一键迁移主机器人</button>
          <button id="bots-apply-dry-run-btn" type="button" class="secondary" data-i18n="bots.applyDryRun">应用预检（dry-run）</button>
          <button id="bots-apply-btn" type="button" class="secondary" data-i18n="bots.apply">应用实例变更</button>
          <label class="checkbox" style="margin: 0 0 0 6px;">
            <input id="bots-retire-default-toggle" type="checkbox" />
            <span data-i18n="bots.retireDefault">应用后自动退役默认单实例服务（codeharbor.service + codeharbor-admin.service）</span>
          </label>
        </div>
        <div class="split-grid">
          <div class="panel" style="padding: 12px;">
            <h3 class="panel-title" style="font-size: 16px; margin-bottom: 10px;" data-i18n="bots.editorTitle">实例表单</h3>
            <p id="bots-selected-label" class="muted" data-i18n="bots.selectedNone">当前：未选择实例（新建模式）</p>
            <div class="grid">
              <label class="field">
                <span class="field-label" data-i18n="bots.field.id">实例 ID</span>
                <input id="bots-form-id" type="text" placeholder="bot-a" />
              </label>
              <label class="field">
                <span class="field-label" data-i18n="bots.field.runUser">运行用户</span>
                <input id="bots-form-run-user" type="text" placeholder="bot-a" />
              </label>
              <label class="field full">
                <span class="field-label" data-i18n="bots.field.runtimeHome">运行目录</span>
                <input id="bots-form-runtime-home" type="text" placeholder="/home/bot-a/.codeharbor" />
              </label>
              <label class="field">
                <span class="field-label" data-i18n="bots.field.matrixUserId">Matrix 用户 ID</span>
                <input id="bots-form-matrix-user-id" type="text" placeholder="@bot-a:example.com" />
              </label>
              <label class="field">
                <span class="field-label" data-i18n="bots.field.matrixHomeserver">Matrix Homeserver</span>
                <input id="bots-form-matrix-homeserver" type="text" placeholder="https://matrix.example.com" />
              </label>
              <label class="field full">
                <span class="field-label" data-i18n="bots.field.matrixAccessToken">Matrix Access Token</span>
                <input
                  id="bots-form-matrix-token"
                  type="password"
                  placeholder="留空=保持现有 token；填写=覆盖 token"
                  data-i18n-placeholder="bots.field.matrixAccessTokenPlaceholder"
                />
                <p id="bots-token-state" class="muted" data-i18n="bots.tokenState.unknown">token 状态：未知</p>
              </label>
              <label class="checkbox">
                <input id="bots-form-enabled" type="checkbox" />
                <span data-i18n="bots.field.enabled">启用该实例</span>
              </label>
              <label class="checkbox">
                <input id="bots-form-is-primary" type="checkbox" />
                <span data-i18n="bots.field.isPrimary">设为主机器人</span>
              </label>
              <label class="checkbox">
                <input id="bots-form-with-admin" type="checkbox" />
                <span data-i18n="bots.field.withAdmin">安装 Admin 子服务</span>
              </label>
              <label class="checkbox full">
                <input id="bots-form-clear-token" type="checkbox" />
                <span data-i18n="bots.field.clearToken">清空已有 Matrix token（危险）</span>
              </label>
              <label class="field full">
                <span class="field-label" data-i18n="bots.triggerPolicyTitle">群聊触发策略（实例级）</span>
                <div class="grid" style="margin-top: 6px;">
                  <label class="checkbox"><input id="bots-form-trigger-group-direct" type="checkbox" /><span data-i18n="bots.field.groupDirectModeEnabled">群聊直通模式（无需触发）</span></label>
                  <label class="checkbox"><input id="bots-form-trigger-mention" type="checkbox" /><span data-i18n="bots.field.allowMention">触发：提及机器人</span></label>
                  <label class="checkbox"><input id="bots-form-trigger-reply" type="checkbox" /><span data-i18n="bots.field.allowReply">触发：回复机器人</span></label>
                  <label class="checkbox"><input id="bots-form-trigger-window" type="checkbox" /><span data-i18n="bots.field.allowActiveWindow">触发：活跃窗口</span></label>
                  <label class="checkbox"><input id="bots-form-trigger-prefix" type="checkbox" /><span data-i18n="bots.field.allowPrefix">触发：命令前缀</span></label>
                </div>
              </label>
              <label class="field">
                <span class="field-label" data-i18n="bots.field.backendProvider">后端提供方</span>
                <select id="bots-form-backend-provider">
                  <option value="">(inherit/default)</option>
                  <option value="codex">codex</option>
                  <option value="claude">claude</option>
                  <option value="gemini">gemini</option>
                </select>
              </label>
              <label class="field">
                <span class="field-label" data-i18n="bots.field.backendModel">后端模型（可选）</span>
                <input id="bots-form-backend-model" type="text" placeholder="gpt-5.4 / sonnet / gemini-2.5-pro" />
              </label>
              <label class="field full">
                <span class="field-label" data-i18n="bots.field.backendBin">后端命令路径（可选）</span>
                <input id="bots-form-backend-bin" type="text" placeholder="/usr/local/bin/codex" />
              </label>
              <label class="field full">
                <span class="field-label" data-i18n="bots.field.workdir">工作目录（可选）</span>
                <input id="bots-form-workdir" type="text" placeholder="/srv/project-a" />
              </label>
              <label class="field full">
                <span class="field-label" data-i18n="bots.field.notes">备注（可选）</span>
                <textarea id="bots-form-notes" rows="3" placeholder="用途/负责人/环境说明"></textarea>
              </label>
            </div>
            <div class="actions">
              <button id="bots-new-btn" type="button" class="secondary" data-i18n="bots.new">新建实例</button>
              <button id="bots-upsert-btn" type="button" data-i18n="bots.upsert">加入/更新列表</button>
              <button id="bots-delete-btn" type="button" class="danger" data-i18n="bots.delete">从列表移除</button>
            </div>
          </div>

          <div>
            <div class="table-wrap" style="margin-top: 0;">
              <table>
                <thead>
                  <tr>
                    <th data-i18n="bots.table.id">实例 ID</th>
                    <th data-i18n="bots.table.enabled">启用</th>
                    <th data-i18n="bots.table.primary">主机器人</th>
                    <th data-i18n="bots.table.matrixUser">Matrix 账号</th>
                    <th data-i18n="bots.table.runtimeHome">运行目录</th>
                    <th data-i18n="bots.table.backend">后端</th>
                    <th class="table-actions" data-i18n="bots.table.actions">操作</th>
                  </tr>
                </thead>
                <tbody id="bots-list-body"></tbody>
              </table>
            </div>
            <details class="advanced-json">
              <summary data-i18n="bots.advancedTitle">高级：JSON 批量编辑</summary>
              <div class="grid" style="margin-top: 8px;">
                <label class="field full">
                  <span class="field-label" data-i18n="bots.jsonLabel">实例配置 JSON（数组）</span>
                  <textarea
                    id="bots-profiles-json"
                    rows="12"
                    placeholder='[{"id":"bot-a","enabled":true,"isPrimary":false,"runtimeHome":"/home/bot-a/.codeharbor","runUser":"bot-a","withAdmin":true,"matrixUserId":"@bot-a:example.com","matrixHomeserver":"https://matrix.example.com","triggerPolicy":{"groupDirectModeEnabled":false,"allowMention":true,"allowReply":false,"allowActiveWindow":false,"allowPrefix":true},"backend":{"provider":"codex","model":"gpt-5.4"},"workdir":"/srv/project-a","notes":"project-a bot"}]'
                    data-i18n-placeholder="bots.jsonPlaceholder"
                  ></textarea>
                </label>
              </div>
              <div class="actions">
                <button id="bots-load-json-btn" type="button" class="secondary" data-i18n="bots.loadJson">从 JSON 覆盖列表</button>
                <button id="bots-sync-json-btn" type="button" class="secondary" data-i18n="bots.syncJson">从列表同步 JSON</button>
              </div>
            </details>
          </div>
        </div>
      </section>

      <section class="panel" data-view="settings-rooms" hidden>
        <h2 class="panel-title" data-i18n="rooms.title">房间配置</h2>
        <div class="grid">
          <label class="field">
            <span class="field-label" data-i18n="rooms.roomId">房间 ID</span>
            <input id="room-id" type="text" placeholder="!room:example.com" data-i18n-placeholder="rooms.roomIdPlaceholder" />
          </label>
          <label class="field">
            <span class="field-label" data-i18n="rooms.summary">审计摘要（可选）</span>
            <input id="room-summary" type="text" placeholder="绑定房间到项目 A" data-i18n-placeholder="rooms.summaryPlaceholder" />
          </label>
          <label class="field full">
            <span class="field-label" data-i18n="rooms.workdir">工作目录</span>
            <input id="room-workdir" type="text" />
          </label>
          <label class="checkbox"><input id="room-enabled" type="checkbox" /><span data-i18n="rooms.enabled">启用</span></label>
          <label class="checkbox"><input id="room-mention" type="checkbox" /><span data-i18n="rooms.allowMention">允许提及触发</span></label>
          <label class="checkbox"><input id="room-reply" type="checkbox" /><span data-i18n="rooms.allowReply">允许回复触发</span></label>
          <label class="checkbox"><input id="room-window" type="checkbox" /><span data-i18n="rooms.allowWindow">允许活跃窗口触发</span></label>
          <label class="checkbox"><input id="room-prefix" type="checkbox" /><span data-i18n="rooms.allowPrefix">允许前缀触发</span></label>
        </div>
        <div class="actions">
          <button id="room-load-btn" type="button" class="secondary" data-i18n="rooms.load">加载房间</button>
          <button id="room-save-btn" type="button" data-i18n="rooms.save">保存房间</button>
          <button id="room-validate-btn" type="button" class="secondary" data-i18n="rooms.validate">校验房间</button>
          <button id="room-delete-btn" type="button" class="danger" data-i18n="rooms.delete">删除房间</button>
          <button id="room-refresh-btn" type="button" class="secondary" data-i18n="rooms.refresh">刷新列表</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th data-i18n="rooms.table.roomId">房间 ID</th>
                <th data-i18n="rooms.table.enabled">启用</th>
                <th data-i18n="rooms.table.workdir">工作目录</th>
                <th data-i18n="rooms.table.updatedAt">更新时间</th>
              </tr>
            </thead>
            <tbody id="room-list-body"></tbody>
          </table>
        </div>
      </section>

      <section class="panel" data-view="diagnostics" hidden>
        <h2 class="panel-title" data-i18n="diagnostics.title">运行诊断</h2>
        <div class="actions">
          <button id="diagnostics-refresh-btn" type="button" data-i18n="diagnostics.refresh">刷新诊断</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th data-i18n="diagnostics.summary.key">项</th>
                <th data-i18n="diagnostics.summary.value">值</th>
              </tr>
            </thead>
            <tbody id="diagnostics-summary-body"></tbody>
          </table>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th data-i18n="diagnostics.warn.title">告警</th>
              </tr>
            </thead>
            <tbody id="diagnostics-warning-body"></tbody>
          </table>
        </div>
      </section>

      <section class="panel" data-view="health" hidden>
        <h2 class="panel-title" data-i18n="health.title">健康检查</h2>
        <div class="actions">
          <button id="health-refresh-btn" type="button" data-i18n="health.run">执行健康检查</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th data-i18n="health.table.component">组件</th>
                <th data-i18n="health.table.status">状态</th>
                <th data-i18n="health.table.details">详情</th>
              </tr>
            </thead>
            <tbody id="health-body"></tbody>
          </table>
        </div>
      </section>

      <section class="panel" data-view="audit" hidden>
        <h2 class="panel-title" data-i18n="audit.title">配置审计</h2>
        <div class="actions">
          <label class="field" style="max-width: 120px;">
            <span class="field-label" data-i18n="audit.limit">条数</span>
            <input id="audit-limit" type="number" min="1" max="200" value="30" />
          </label>
          <button id="audit-refresh-btn" type="button" data-i18n="audit.refresh">刷新审计</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th data-i18n="audit.table.id">ID</th>
                <th data-i18n="audit.table.time">时间</th>
                <th data-i18n="audit.table.actor">操作者</th>
                <th data-i18n="audit.table.summary">摘要</th>
                <th data-i18n="audit.table.payload">载荷</th>
              </tr>
            </thead>
            <tbody id="audit-body"></tbody>
          </table>
        </div>
      </section>
        </section>
      </div>
    </main>

    <script>
      (function () {
        "use strict";

        var globalSections = ["basic", "autodev", "rate", "triggers", "cli", "agent", "snapshot"];
        var defaultGlobalSection = "basic";
        var routeToView = {
          "#/settings/global": "settings-global",
          "#/settings/global/basic": "settings-global",
          "#/settings/global/autodev": "settings-global",
          "#/settings/global/rate": "settings-global",
          "#/settings/global/triggers": "settings-global",
          "#/settings/global/cli": "settings-global",
          "#/settings/global/agent": "settings-global",
          "#/settings/global/snapshot": "settings-global",
          "#/settings/bots": "settings-bots",
          "#/settings/rooms": "settings-rooms",
          "#/diagnostics": "diagnostics",
          "#/health": "health",
          "#/audit": "audit"
        };
        var pathToRoute = {
          "/settings/global": "#/settings/global/basic",
          "/settings/global/basic": "#/settings/global/basic",
          "/settings/global/autodev": "#/settings/global/autodev",
          "/settings/global/rate": "#/settings/global/rate",
          "/settings/global/triggers": "#/settings/global/triggers",
          "/settings/global/cli": "#/settings/global/cli",
          "/settings/global/agent": "#/settings/global/agent",
          "/settings/global/snapshot": "#/settings/global/snapshot",
          "/settings/bots": "#/settings/bots",
          "/settings/rooms": "#/settings/rooms",
          "/diagnostics": "#/diagnostics",
          "/health": "#/health",
          "/audit": "#/audit"
        };
        var storageTokenKey = "codeharbor.admin.token";
        var storageActorKey = "codeharbor.admin.actor";
        var storageLangKey = "codeharbor.admin.lang";
        var defaultLang = "zh";
        var i18n = {
          zh: {
            "header.title": "CodeHarbor 管理后台",
            "header.subtitle": "通过左侧分层菜单管理全局配置、房间策略、诊断视图、健康检查与配置审计记录。",
            "menu.group.global": "全局配置",
            "menu.group.instances": "实例编排",
            "menu.group.workspace": "房间治理",
            "menu.group.observe": "运行观测",
            "menu.global": "全局配置中心",
            "tab.globalBasic": "基础设置",
            "tab.globalAutoDev": "AutoDev 策略",
            "tab.globalRate": "限流与并发",
            "tab.globalTriggers": "触发策略",
            "tab.globalCli": "CLI 与多模态",
            "tab.globalAgent": "技能与高级",
            "tab.globalSnapshot": "快照与重启",
            "tab.bots": "机器人实例",
            "tab.rooms": "房间配置",
            "tab.diagnostics": "运行诊断",
            "tab.health": "健康检查",
            "tab.audit": "配置审计",
            "auth.token.label": "管理员令牌（可选）",
            "auth.token.placeholder": "ADMIN_TOKEN",
            "auth.actor.label": "操作者（用于审计日志）",
            "auth.actor.placeholder": "你的名字",
            "auth.language.label": "界面语言",
            "auth.save": "保存认证",
            "auth.clear": "清除认证",
            "auth.permission.unknown": "权限：未知",
            "auth.permission.unauth": "权限：未认证",
            "auth.permission.prefix": "权限：{role}{source}{actor}",
            "auth.permission.actorSuffix": "（用户：{actor}）",
            "notice.ready": "就绪。",
            "notice.dismiss": "关闭提示",
            "notice.authSaved": "认证设置已保存到 localStorage。",
            "notice.authCleared": "认证设置已清除。",
            "global.title": "全局配置",
            "global.commandPrefix": "命令前缀",
            "global.defaultWorkdir": "默认工作目录",
            "global.outputLanguage": "机器人输出语言",
            "global.progressInterval": "进度更新间隔（毫秒）",
            "global.progressDeliveryMode": "进度投递模式（upsert=编辑同一条，timeline=追加时间线）",
            "global.typingTimeout": "输入状态超时（毫秒）",
            "global.sessionWindow": "会话活跃窗口（分钟）",
            "global.updateCheckEnabled": "启用版本更新检查",
            "global.updateCheckTimeout": "更新检查超时（毫秒）",
            "global.updateCheckTtl": "更新检查缓存时间（毫秒）",
            "global.progressEnabled": "启用进度更新",
            "global.noticeBadgeEnabled": "启用 Matrix 消息徽标（CodeHarbor 提示/AI 回复）",
            "global.autodevLoopMaxRuns": "AutoDev 循环最大轮次（0=不限制）",
            "global.autodevLoopMaxMinutes": "AutoDev 循环最大分钟（0=不限制）",
            "global.autodevAutoCommit": "AutoDev 自动提交",
            "global.autodevAutoReleaseEnabled": "AutoDev 自动发布",
            "global.autodevAutoReleasePush": "AutoDev 自动推送发布提交",
            "global.botProfilesAutoRetireDefault": "机器人实例 apply 默认自动退役单实例服务（codeharbor.service + codeharbor-admin.service）",
            "global.autodevMaxConsecutiveFailures": "AutoDev 最大连续失败次数",
            "global.autodevInitEnhancementEnabled": "启用 /autodev init Stage-B 增强",
            "global.autodevInitEnhancementTimeout": "Stage-B 增强超时（毫秒）",
            "global.autodevInitEnhancementMaxChars": "Stage-B 增强提示预算（字符）",
            "global.rateWindow": "限流窗口（毫秒）",
            "global.rateUser": "单用户窗口最大请求数",
            "global.rateRoom": "单房间窗口最大请求数",
            "global.concurrentGlobal": "全局最大并发",
            "global.concurrentUser": "单用户最大并发",
            "global.concurrentRoom": "单房间最大并发",
            "global.groupDirect": "群聊直通模式（无需触发）",
            "global.triggerMention": "触发：提及机器人",
            "global.triggerReply": "触发：回复机器人",
            "global.triggerWindow": "触发：活跃窗口",
            "global.triggerPrefix": "触发：命令前缀",
            "global.cliEnabled": "CLI 兼容模式",
            "global.cliPass": "CLI 透传事件",
            "global.cliWhitespace": "保留空白符",
            "global.cliDisableSplit": "禁用回复分片",
            "global.cliThrottle": "CLI 进度节流（毫秒）",
            "global.cliFetchMedia": "下载媒体附件",
            "global.cliImageMaxBytes": "图片最大字节数",
            "global.cliImageMaxCount": "图片最大数量",
            "global.cliImageMimeTypes": "图片允许 MIME（逗号分隔）",
            "global.cliTranscribeAudio": "转写音频附件",
            "global.audioModel": "音频转写模型",
            "global.audioTimeout": "音频转写超时（毫秒）",
            "global.audioMaxChars": "音频转写最大字符数",
            "global.audioMaxRetries": "音频转写最大重试次数",
            "global.audioRetryDelay": "音频转写重试间隔（毫秒）",
            "global.audioMaxBytes": "音频最大字节数",
            "global.audioLocalCommand": "本地 Whisper 命令",
            "global.audioLocalCommandPlaceholder": "python3 /opt/whisper/transcribe.py --input {input}",
            "global.audioLocalTimeout": "本地 Whisper 超时（毫秒）",
            "global.cliRecordPath": "CLI 回放记录文件路径（可选）",
            "global.cliRecordPathPlaceholder": "./logs/cli-record.ndjson",
            "global.proxyEnabled": "启用 CLI 代理",
            "global.proxyHttp": "HTTP 代理（HTTP_PROXY）",
            "global.proxyHttps": "HTTPS 代理（HTTPS_PROXY）",
            "global.proxyAll": "全局代理（ALL_PROXY）",
            "global.proxyNo": "代理白名单（NO_PROXY）",
            "global.agentEnabled": "启用多智能体工作流",
            "global.agentRounds": "工作流自动修复轮次",
            "global.agentSkillsEnabled": "启用角色技能注入",
            "global.agentSkillsMode": "角色技能披露模式",
            "global.agentSkillsMaxChars": "角色技能提示上限字符数（留空=默认）",
            "global.agentSkillsRoots": "角色技能根目录（逗号分隔）",
            "global.agentSkillsRootsPlaceholder": "/home/user/.codex/skills,/opt/codeharbor/skills",
            "global.agentSkillsAssignments": "角色技能分配 JSON（planner/executor/reviewer）",
            "global.agentSkillsAssignmentsPlaceholder":
              '{"planner":["task-planner"],"executor":["autonomous-dev"],"reviewer":["code-reviewer"]}',
            "global.agentSkillsCatalog": "可用 SKILL 目录（内置 + 本地）",
            "global.agentSkillsRefresh": "刷新 SKILL 目录",
            "global.agentSkillsMissingEmpty": "缺失 SKILL：无",
            "global.agentSkillsMissingPrefix": "缺失 SKILL：{items}",
            "global.agentSkillsLoadFailed": "加载 SKILL 目录失败：{error}",
            "global.envOverrides": "高级环境变量覆盖（JSON，可选）",
            "global.envOverridesPlaceholder":
              '{"AUTODEV_STAGE_OUTPUT_ECHO_ENABLED":"true","AUTODEV_PREFLIGHT_AUTO_STASH":"true","AUTODEV_RUN_ARCHIVE_ENABLED":"true","AUTODEV_RUN_ARCHIVE_DIR":".codeharbor/autodev-runs"}',
            "global.envOverridesHint":
              "常用 AutoDev 覆盖键：AUTODEV_STAGE_OUTPUT_ECHO_ENABLED、AUTODEV_PREFLIGHT_AUTO_STASH、AUTODEV_RUN_ARCHIVE_ENABLED、AUTODEV_RUN_ARCHIVE_DIR（布尔值请使用字符串 true/false）",
            "global.save": "保存全局配置",
            "global.validate": "校验全局配置",
            "global.reload": "重新加载",
            "global.restartMain": "重启主服务",
            "global.restartAll": "重启主服务+管理后台",
            "global.restartHint": "保存后会按字段分类提示：hot（即时生效）或 restart（需重启）。",
            "snapshot.title": "配置导入/导出",
            "snapshot.export": "导出配置快照",
            "snapshot.importFile": "导入文件（JSON）",
            "snapshot.importDryRun": "先执行 dry-run",
            "snapshot.importApply": "应用导入",
            "notice.globalLoaded": "全局配置已加载。",
            "notice.globalLoadFailed": "加载全局配置失败：{error}",
            "notice.globalSavedHot": "保存成功（hot）：{keys}。",
            "notice.globalSavedRestart": "保存成功（restart）：{keys}。请重启以完全生效。",
            "notice.globalValidated": "全局配置校验通过：{keys}",
            "notice.globalValidateFailed": "全局配置校验失败：{error}",
            "notice.globalSaveFailed": "保存全局配置失败：{error}",
            "notice.snapshotExported": "配置快照已导出：{filename}",
            "notice.snapshotExportFailed": "导出配置快照失败：{error}",
            "notice.snapshotFileRequired": "请先选择导入文件。",
            "notice.snapshotJsonInvalid": "导入文件不是有效 JSON：{error}",
            "notice.snapshotDryRunDone": "快照 dry-run 校验通过。",
            "notice.snapshotImportDone": "配置快照已导入，建议重启服务。",
            "notice.snapshotImportFailed": "导入配置快照失败：{error}",
            "notice.restartRequested": "已请求重启：{services}。{suffix}",
            "notice.restartFailed": "重启服务失败：{error}",
            "notice.restartSuffixAll": "管理后台页面可能在重启期间短暂断连。",
            "bots.title": "机器人实例",
            "bots.description": "在同一管理后台维护多实例配置：每个实例对应独立 Matrix 账号、运行目录和可选后端模型。",
            "bots.load": "加载实例配置",
            "bots.save": "保存实例配置",
            "bots.migrateDryRun": "迁移预检（单实例）",
            "bots.migrateApply": "一键迁移主机器人",
            "bots.applyDryRun": "应用预检（dry-run）",
            "bots.apply": "应用实例变更",
            "bots.retireDefault": "应用后自动退役默认单实例服务（codeharbor.service + codeharbor-admin.service）",
            "bots.editorTitle": "实例表单",
            "bots.selectedNone": "当前：未选择实例（新建模式）",
            "bots.selectedPrefix": "当前实例：{id}",
            "bots.new": "新建实例",
            "bots.upsert": "加入/更新列表",
            "bots.delete": "从列表移除",
            "bots.advancedTitle": "高级：JSON 批量编辑",
            "bots.loadJson": "从 JSON 覆盖列表",
            "bots.syncJson": "从列表同步 JSON",
            "bots.jsonLabel": "实例配置 JSON（数组）",
            "bots.jsonPlaceholder":
              '[{"id":"bot-a","enabled":true,"isPrimary":false,"runtimeHome":"/home/bot-a/.codeharbor","runUser":"bot-a","withAdmin":true,"matrixUserId":"@bot-a:example.com","matrixHomeserver":"https://matrix.example.com","triggerPolicy":{"groupDirectModeEnabled":false,"allowMention":true,"allowReply":false,"allowActiveWindow":false,"allowPrefix":true},"backend":{"provider":"codex","model":"gpt-5.4"},"workdir":"/srv/project-a","notes":"project-a bot"}]',
            "bots.field.id": "实例 ID",
            "bots.field.runUser": "运行用户",
            "bots.field.runtimeHome": "运行目录",
            "bots.field.matrixUserId": "Matrix 用户 ID",
            "bots.field.matrixHomeserver": "Matrix Homeserver",
            "bots.field.matrixAccessToken": "Matrix Access Token",
            "bots.field.matrixAccessTokenPlaceholder": "留空=保持现有 token；填写=覆盖 token",
            "bots.field.enabled": "启用该实例",
            "bots.field.isPrimary": "设为主机器人",
            "bots.field.withAdmin": "安装 Admin 子服务",
            "bots.field.clearToken": "清空已有 Matrix token（危险）",
            "bots.triggerPolicyTitle": "群聊触发策略（实例级）",
            "bots.field.groupDirectModeEnabled": "群聊直通模式（无需触发）",
            "bots.field.allowMention": "触发：提及机器人",
            "bots.field.allowReply": "触发：回复机器人",
            "bots.field.allowActiveWindow": "触发：活跃窗口",
            "bots.field.allowPrefix": "触发：命令前缀",
            "bots.field.backendProvider": "后端提供方",
            "bots.field.backendModel": "后端模型（可选）",
            "bots.field.backendBin": "后端命令路径（可选）",
            "bots.field.workdir": "工作目录（可选）",
            "bots.field.notes": "备注（可选）",
            "bots.tokenState.unknown": "token 状态：未知",
            "bots.tokenState.present": "token 状态：已配置（{masked}）",
            "bots.tokenState.empty": "token 状态：未配置",
            "bots.table.id": "实例 ID",
            "bots.table.enabled": "启用",
            "bots.table.primary": "主机器人",
            "bots.table.matrixUser": "Matrix 账号",
            "bots.table.runtimeHome": "运行目录",
            "bots.table.backend": "后端",
            "bots.table.actions": "操作",
            "bots.table.edit": "编辑",
            "notice.botsLoaded": "机器人实例配置已加载：{count} 项。",
            "notice.botsLoadFailed": "加载机器人实例配置失败：{error}",
            "notice.botsJsonInvalid": "实例配置 JSON 解析失败：{error}",
            "notice.botsSaved": "机器人实例配置已保存：{count} 项。",
            "notice.botsSaveFailed": "保存机器人实例配置失败：{error}",
            "notice.botsMigrated": "迁移结果：{message}（dryRun={dryRun}）。",
            "notice.botsMigrateFailed": "迁移失败：{error}",
            "notice.botsApplied": "实例应用结果：成功 {succeeded}，失败 {failed}，跳过 {skipped}，退役默认单实例={retire}。",
            "notice.botsApplyFailed": "应用实例配置失败：{error}",
            "notice.botsEmpty": "暂无机器人实例配置。",
            "notice.botsFormInvalid": "实例表单校验失败：{error}",
            "notice.botsProfileStaged": "实例已加入本地列表：{id}",
            "notice.botsProfileRemoved": "实例已从本地列表移除：{id}",
            "notice.botsProfileNotSelected": "请先在列表中选择实例。",
            "notice.botsJsonLoaded": "已从 JSON 覆盖本地实例列表：{count} 项。",
            "rooms.title": "房间配置",
            "rooms.roomId": "房间 ID",
            "rooms.roomIdPlaceholder": "!room:example.com",
            "rooms.summary": "审计摘要（可选）",
            "rooms.summaryPlaceholder": "绑定房间到项目 A",
            "rooms.workdir": "工作目录",
            "rooms.enabled": "启用",
            "rooms.allowMention": "允许提及触发",
            "rooms.allowReply": "允许回复触发",
            "rooms.allowWindow": "允许活跃窗口触发",
            "rooms.allowPrefix": "允许前缀触发",
            "rooms.load": "加载房间",
            "rooms.save": "保存房间",
            "rooms.validate": "校验房间",
            "rooms.delete": "删除房间",
            "rooms.refresh": "刷新列表",
            "rooms.table.roomId": "房间 ID",
            "rooms.table.enabled": "启用",
            "rooms.table.workdir": "工作目录",
            "rooms.table.updatedAt": "更新时间",
            "notice.roomsEmpty": "暂无房间配置。",
            "notice.roomsLoaded": "已加载 {count} 条房间配置。",
            "notice.roomsLoadFailed": "加载房间列表失败：{error}",
            "notice.roomIdRequired": "房间 ID 不能为空。",
            "notice.roomLoaded": "房间配置已加载：{roomId}。",
            "notice.roomLoadFailed": "加载房间配置失败：{error}",
            "notice.roomValidated": "房间配置校验通过：{roomId}。",
            "notice.roomValidateFailed": "房间配置校验失败：{error}",
            "notice.roomSaved": "房间配置已保存：{roomId}。",
            "notice.roomSaveFailed": "保存房间配置失败：{error}",
            "notice.roomDeleted": "房间配置已删除：{roomId}。",
            "notice.roomDeleteFailed": "删除房间配置失败：{error}",
            "confirm.roomDelete": "确认删除房间配置：{roomId}？",
            "diagnostics.title": "运行诊断",
            "diagnostics.refresh": "刷新诊断",
            "diagnostics.summary.key": "项",
            "diagnostics.summary.value": "值",
            "diagnostics.warn.title": "告警",
            "notice.diagnosticsLoaded": "诊断信息已刷新。",
            "notice.diagnosticsLoadFailed": "加载诊断信息失败：{error}",
            "notice.diagnosticsWarningEmpty": "暂无告警。",
            "diagnostics.key.provider": "CLI 提供方",
            "diagnostics.key.runtimeMetrics": "运行时指标快照",
            "diagnostics.key.metricsUpdatedAt": "指标更新时间",
            "diagnostics.key.requestTotal": "累计请求数",
            "diagnostics.key.activeExecutions": "当前执行中请求",
            "diagnostics.key.roomSettings": "房间配置数量",
            "diagnostics.key.runtimeHotVersion": "热更新配置版本",
            "diagnostics.key.retention": "历史保留策略",
            "diagnostics.key.latestRevision": "最近审计摘要",
            "health.title": "健康检查",
            "health.run": "执行健康检查",
            "health.table.component": "组件",
            "health.table.status": "状态",
            "health.table.details": "详情",
            "health.component.app": "CodeHarbor",
            "health.component.codex": "Codex",
            "health.component.claude": "Claude Code",
            "health.component.gemini": "Gemini CLI",
            "health.component.matrix": "Matrix",
            "health.component.overall": "整体",
            "health.app.detail.updateAvailable": "当前 {current}，最新 {latest}（可更新）",
            "health.app.detail.upToDate": "当前 {current}，已是最新",
            "health.app.detail.disabled": "当前 {current}，已禁用更新检查",
            "health.app.detail.unknown": "当前 {current}，更新检查不可用：{error}",
            "health.app.detail.noVersion": "无法读取版本信息",
            "health.status.ok": "正常",
            "health.status.fail": "失败",
            "notice.healthDone": "健康检查完成。",
            "notice.healthFailed": "健康检查失败：{error}",
            "notice.healthEmptyFailed": "健康检查执行失败。",
            "audit.title": "配置审计",
            "audit.limit": "条数",
            "audit.refresh": "刷新审计",
            "audit.table.id": "ID",
            "audit.table.time": "时间",
            "audit.table.actor": "操作者",
            "audit.table.summary": "摘要",
            "audit.table.payload": "载荷",
            "notice.auditEmpty": "暂无审计记录。",
            "notice.auditLoaded": "审计记录已加载：{count} 条。",
            "notice.auditLoadFailed": "加载审计记录失败：{error}",
            "table.loadFailed": "加载失败。"
          },
          en: {
            "header.title": "CodeHarbor Admin Console",
            "header.subtitle": "Use left hierarchical navigation to manage global settings, rooms, diagnostics, health checks, and audit records.",
            "menu.group.global": "Global Settings",
            "menu.group.instances": "Instance Orchestration",
            "menu.group.workspace": "Room Governance",
            "menu.group.observe": "Observability",
            "menu.global": "Global Control Center",
            "tab.globalBasic": "Basics",
            "tab.globalAutoDev": "AutoDev Policy",
            "tab.globalRate": "Rate & Concurrency",
            "tab.globalTriggers": "Trigger Policy",
            "tab.globalCli": "CLI & Multimodal",
            "tab.globalAgent": "Skills & Advanced",
            "tab.globalSnapshot": "Snapshot & Restart",
            "tab.bots": "Bot Instances",
            "tab.rooms": "Rooms",
            "tab.diagnostics": "Runtime Diagnostics",
            "tab.health": "Health Check",
            "tab.audit": "Config Audit",
            "auth.token.label": "Admin Token (optional)",
            "auth.token.placeholder": "ADMIN_TOKEN",
            "auth.actor.label": "Actor (for audit logs)",
            "auth.actor.placeholder": "your-name",
            "auth.language.label": "Language",
            "auth.save": "Save Auth",
            "auth.clear": "Clear Auth",
            "auth.permission.unknown": "Permission: unknown",
            "auth.permission.unauth": "Permission: unauthenticated",
            "auth.permission.prefix": "Permission: {role}{source}{actor}",
            "auth.permission.actorSuffix": " as {actor}",
            "notice.ready": "Ready.",
            "notice.dismiss": "Dismiss notice",
            "notice.authSaved": "Auth settings saved to localStorage.",
            "notice.authCleared": "Auth settings cleared.",
            "global.title": "Global Config",
            "global.commandPrefix": "Command Prefix",
            "global.defaultWorkdir": "Default Workdir",
            "global.outputLanguage": "Bot Output Language",
            "global.progressInterval": "Progress Interval (ms)",
            "global.progressDeliveryMode": "Progress Delivery Mode (upsert=edit one notice, timeline=append notices)",
            "global.typingTimeout": "Typing Timeout (ms)",
            "global.sessionWindow": "Session Active Window (minutes)",
            "global.updateCheckEnabled": "Enable update check",
            "global.updateCheckTimeout": "Update check timeout (ms)",
            "global.updateCheckTtl": "Update check cache TTL (ms)",
            "global.progressEnabled": "Enable progress updates",
            "global.noticeBadgeEnabled": "Enable Matrix message badges (CodeHarbor notice/AI reply)",
            "global.autodevLoopMaxRuns": "AutoDev loop max runs (0 = unlimited)",
            "global.autodevLoopMaxMinutes": "AutoDev loop max minutes (0 = unlimited)",
            "global.autodevAutoCommit": "AutoDev auto commit",
            "global.autodevAutoReleaseEnabled": "AutoDev auto release",
            "global.autodevAutoReleasePush": "AutoDev auto push release commits",
            "global.botProfilesAutoRetireDefault": "Bot apply default: auto-retire single-instance services (codeharbor.service + codeharbor-admin.service)",
            "global.autodevMaxConsecutiveFailures": "AutoDev max consecutive failures",
            "global.autodevInitEnhancementEnabled": "Enable /autodev init Stage-B enhancement",
            "global.autodevInitEnhancementTimeout": "Stage-B enhancement timeout (ms)",
            "global.autodevInitEnhancementMaxChars": "Stage-B enhancement prompt budget (chars)",
            "global.rateWindow": "Rate Window (ms)",
            "global.rateUser": "Rate Max Requests / User",
            "global.rateRoom": "Rate Max Requests / Room",
            "global.concurrentGlobal": "Max Concurrent Global",
            "global.concurrentUser": "Max Concurrent / User",
            "global.concurrentRoom": "Max Concurrent / Room",
            "global.groupDirect": "Group direct mode (no trigger required)",
            "global.triggerMention": "Trigger: mention",
            "global.triggerReply": "Trigger: reply",
            "global.triggerWindow": "Trigger: active window",
            "global.triggerPrefix": "Trigger: prefix",
            "global.cliEnabled": "CLI compat mode",
            "global.cliPass": "CLI passthrough events",
            "global.cliWhitespace": "Preserve whitespace",
            "global.cliDisableSplit": "Disable reply split",
            "global.cliThrottle": "CLI progress throttle (ms)",
            "global.cliFetchMedia": "Fetch media attachments",
            "global.cliImageMaxBytes": "Image max bytes",
            "global.cliImageMaxCount": "Image max count",
            "global.cliImageMimeTypes": "Image allowed MIME types (comma-separated)",
            "global.cliTranscribeAudio": "Transcribe audio attachments",
            "global.audioModel": "Audio transcribe model",
            "global.audioTimeout": "Audio transcribe timeout (ms)",
            "global.audioMaxChars": "Audio transcript max chars",
            "global.audioMaxRetries": "Audio transcribe max retries",
            "global.audioRetryDelay": "Audio transcribe retry delay (ms)",
            "global.audioMaxBytes": "Audio max bytes",
            "global.audioLocalCommand": "Local whisper command",
            "global.audioLocalCommandPlaceholder": "python3 /opt/whisper/transcribe.py --input {input}",
            "global.audioLocalTimeout": "Local whisper timeout (ms)",
            "global.cliRecordPath": "CLI replay record path (optional)",
            "global.cliRecordPathPlaceholder": "./logs/cli-record.ndjson",
            "global.proxyEnabled": "Enable CLI proxy",
            "global.proxyHttp": "HTTP proxy (HTTP_PROXY)",
            "global.proxyHttps": "HTTPS proxy (HTTPS_PROXY)",
            "global.proxyAll": "Global proxy (ALL_PROXY)",
            "global.proxyNo": "Proxy bypass list (NO_PROXY)",
            "global.agentEnabled": "Enable multi-agent workflow",
            "global.agentRounds": "Workflow auto-repair rounds",
            "global.agentSkillsEnabled": "Enable role skill injection",
            "global.agentSkillsMode": "Role skill disclosure mode",
            "global.agentSkillsMaxChars": "Role skill prompt max chars (blank = default)",
            "global.agentSkillsRoots": "Role skill roots (comma-separated)",
            "global.agentSkillsRootsPlaceholder": "/home/user/.codex/skills,/opt/codeharbor/skills",
            "global.agentSkillsAssignments": "Role skill assignment JSON (planner/executor/reviewer)",
            "global.agentSkillsAssignmentsPlaceholder":
              '{"planner":["task-planner"],"executor":["autonomous-dev"],"reviewer":["code-reviewer"]}',
            "global.agentSkillsCatalog": "Available SKILL catalog (builtin + local)",
            "global.agentSkillsRefresh": "Refresh SKILL Catalog",
            "global.agentSkillsMissingEmpty": "Missing SKILLs: none",
            "global.agentSkillsMissingPrefix": "Missing SKILLs: {items}",
            "global.agentSkillsLoadFailed": "Failed to load SKILL catalog: {error}",
            "global.envOverrides": "Advanced env overrides (JSON, optional)",
            "global.envOverridesPlaceholder":
              '{"AUTODEV_STAGE_OUTPUT_ECHO_ENABLED":"true","AUTODEV_PREFLIGHT_AUTO_STASH":"true","AUTODEV_RUN_ARCHIVE_ENABLED":"true","AUTODEV_RUN_ARCHIVE_DIR":".codeharbor/autodev-runs"}',
            "global.envOverridesHint":
              "Common AutoDev keys: AUTODEV_STAGE_OUTPUT_ECHO_ENABLED, AUTODEV_PREFLIGHT_AUTO_STASH, AUTODEV_RUN_ARCHIVE_ENABLED, AUTODEV_RUN_ARCHIVE_DIR (use string booleans: true/false)",
            "global.save": "Save Global Config",
            "global.validate": "Validate Global Config",
            "global.reload": "Reload",
            "global.restartMain": "Restart Main Service",
            "global.restartAll": "Restart Main + Admin",
            "global.restartHint": "Save result now labels each field as hot (applied now) or restart (requires service restart).",
            "snapshot.title": "Config Import/Export",
            "snapshot.export": "Export Config Snapshot",
            "snapshot.importFile": "Import file (JSON)",
            "snapshot.importDryRun": "Run dry-run first",
            "snapshot.importApply": "Apply Import",
            "notice.globalLoaded": "Global config loaded.",
            "notice.globalLoadFailed": "Failed to load global config: {error}",
            "notice.globalSavedHot": "Saved (hot): {keys}.",
            "notice.globalSavedRestart": "Saved (restart): {keys}. Please restart services.",
            "notice.globalValidated": "Global config validation passed: {keys}",
            "notice.globalValidateFailed": "Global config validation failed: {error}",
            "notice.globalSaveFailed": "Failed to save global config: {error}",
            "notice.snapshotExported": "Config snapshot exported: {filename}",
            "notice.snapshotExportFailed": "Failed to export config snapshot: {error}",
            "notice.snapshotFileRequired": "Please choose a snapshot file first.",
            "notice.snapshotJsonInvalid": "Snapshot file is not valid JSON: {error}",
            "notice.snapshotDryRunDone": "Snapshot dry-run validation passed.",
            "notice.snapshotImportDone": "Snapshot imported. Restart is recommended.",
            "notice.snapshotImportFailed": "Failed to import snapshot: {error}",
            "notice.restartRequested": "Restart requested: {services}. {suffix}",
            "notice.restartFailed": "Failed to restart service(s): {error}",
            "notice.restartSuffixAll": "Admin page may reconnect during restart.",
            "bots.title": "Bot Instances",
            "bots.description":
              "Manage multiple bot instances from one control plane. Each profile can define Matrix identity, runtime home, and backend model overrides.",
            "bots.load": "Load Profiles",
            "bots.save": "Save Profiles",
            "bots.migrateDryRun": "Migration Dry-Run",
            "bots.migrateApply": "Migrate As Primary",
            "bots.applyDryRun": "Apply Dry-Run",
            "bots.apply": "Apply Changes",
            "bots.retireDefault": "Retire default single-instance services after apply (codeharbor.service + codeharbor-admin.service)",
            "bots.editorTitle": "Profile Form",
            "bots.selectedNone": "Current: none selected (create mode)",
            "bots.selectedPrefix": "Current profile: {id}",
            "bots.new": "New Profile",
            "bots.upsert": "Add/Update List",
            "bots.delete": "Remove From List",
            "bots.advancedTitle": "Advanced: Bulk JSON Editor",
            "bots.loadJson": "Load List From JSON",
            "bots.syncJson": "Sync JSON From List",
            "bots.jsonLabel": "Profiles JSON (array)",
            "bots.jsonPlaceholder":
              '[{"id":"bot-a","enabled":true,"isPrimary":false,"runtimeHome":"/home/bot-a/.codeharbor","runUser":"bot-a","withAdmin":true,"matrixUserId":"@bot-a:example.com","matrixHomeserver":"https://matrix.example.com","triggerPolicy":{"groupDirectModeEnabled":false,"allowMention":true,"allowReply":false,"allowActiveWindow":false,"allowPrefix":true},"backend":{"provider":"codex","model":"gpt-5.4"},"workdir":"/srv/project-a","notes":"project-a bot"}]',
            "bots.field.id": "Instance ID",
            "bots.field.runUser": "Run User",
            "bots.field.runtimeHome": "Runtime Home",
            "bots.field.matrixUserId": "Matrix User ID",
            "bots.field.matrixHomeserver": "Matrix Homeserver",
            "bots.field.matrixAccessToken": "Matrix Access Token",
            "bots.field.matrixAccessTokenPlaceholder": "Leave empty to keep existing token; fill to replace",
            "bots.field.enabled": "Enable this instance",
            "bots.field.isPrimary": "Set as primary bot",
            "bots.field.withAdmin": "Install Admin sidecar service",
            "bots.field.clearToken": "Clear existing Matrix token (dangerous)",
            "bots.triggerPolicyTitle": "Group Trigger Policy (per instance)",
            "bots.field.groupDirectModeEnabled": "Group direct mode (no trigger required)",
            "bots.field.allowMention": "Trigger: mention",
            "bots.field.allowReply": "Trigger: reply",
            "bots.field.allowActiveWindow": "Trigger: active window",
            "bots.field.allowPrefix": "Trigger: command prefix",
            "bots.field.backendProvider": "Backend Provider",
            "bots.field.backendModel": "Backend Model (optional)",
            "bots.field.backendBin": "Backend Binary Path (optional)",
            "bots.field.workdir": "Workdir (optional)",
            "bots.field.notes": "Notes (optional)",
            "bots.tokenState.unknown": "Token state: unknown",
            "bots.tokenState.present": "Token state: configured ({masked})",
            "bots.tokenState.empty": "Token state: not configured",
            "bots.table.id": "Instance ID",
            "bots.table.enabled": "Enabled",
            "bots.table.primary": "Primary",
            "bots.table.matrixUser": "Matrix User",
            "bots.table.runtimeHome": "Runtime Home",
            "bots.table.backend": "Backend",
            "bots.table.actions": "Actions",
            "bots.table.edit": "Edit",
            "notice.botsLoaded": "Loaded bot profiles: {count}.",
            "notice.botsLoadFailed": "Failed to load bot profiles: {error}",
            "notice.botsJsonInvalid": "Profiles JSON parse failed: {error}",
            "notice.botsSaved": "Saved bot profiles: {count}.",
            "notice.botsSaveFailed": "Failed to save bot profiles: {error}",
            "notice.botsMigrated": "Migration result: {message} (dryRun={dryRun}).",
            "notice.botsMigrateFailed": "Failed to migrate single-instance profile: {error}",
            "notice.botsApplied": "Apply result: succeeded {succeeded}, failed {failed}, skipped {skipped}, retire default={retire}.",
            "notice.botsApplyFailed": "Failed to apply bot profiles: {error}",
            "notice.botsEmpty": "No bot profiles.",
            "notice.botsFormInvalid": "Profile form validation failed: {error}",
            "notice.botsProfileStaged": "Profile staged in local list: {id}",
            "notice.botsProfileRemoved": "Profile removed from local list: {id}",
            "notice.botsProfileNotSelected": "Select a profile from the list first.",
            "notice.botsJsonLoaded": "Loaded list from JSON: {count} profile(s).",
            "rooms.title": "Room Config",
            "rooms.roomId": "Room ID",
            "rooms.roomIdPlaceholder": "!room:example.com",
            "rooms.summary": "Audit Summary (optional)",
            "rooms.summaryPlaceholder": "bind room to project A",
            "rooms.workdir": "Workdir",
            "rooms.enabled": "Enabled",
            "rooms.allowMention": "Allow mention trigger",
            "rooms.allowReply": "Allow reply trigger",
            "rooms.allowWindow": "Allow active-window trigger",
            "rooms.allowPrefix": "Allow prefix trigger",
            "rooms.load": "Load Room",
            "rooms.save": "Save Room",
            "rooms.validate": "Validate Room",
            "rooms.delete": "Delete Room",
            "rooms.refresh": "Refresh List",
            "rooms.table.roomId": "Room ID",
            "rooms.table.enabled": "Enabled",
            "rooms.table.workdir": "Workdir",
            "rooms.table.updatedAt": "Updated At",
            "notice.roomsEmpty": "No room settings.",
            "notice.roomsLoaded": "Loaded {count} room setting(s).",
            "notice.roomsLoadFailed": "Failed to load room list: {error}",
            "notice.roomIdRequired": "Room ID is required.",
            "notice.roomLoaded": "Room config loaded for {roomId}.",
            "notice.roomLoadFailed": "Failed to load room config: {error}",
            "notice.roomValidated": "Room config validation passed for {roomId}.",
            "notice.roomValidateFailed": "Room config validation failed: {error}",
            "notice.roomSaved": "Room config saved for {roomId}.",
            "notice.roomSaveFailed": "Failed to save room config: {error}",
            "notice.roomDeleted": "Room config deleted for {roomId}.",
            "notice.roomDeleteFailed": "Failed to delete room config: {error}",
            "confirm.roomDelete": "Delete room config for {roomId}?",
            "diagnostics.title": "Diagnostics",
            "diagnostics.refresh": "Refresh Diagnostics",
            "diagnostics.summary.key": "Key",
            "diagnostics.summary.value": "Value",
            "diagnostics.warn.title": "Warnings",
            "notice.diagnosticsLoaded": "Diagnostics refreshed.",
            "notice.diagnosticsLoadFailed": "Failed to load diagnostics: {error}",
            "notice.diagnosticsWarningEmpty": "No warnings.",
            "diagnostics.key.provider": "CLI provider",
            "diagnostics.key.runtimeMetrics": "Runtime metrics snapshot",
            "diagnostics.key.metricsUpdatedAt": "Metrics updated at",
            "diagnostics.key.requestTotal": "Total requests",
            "diagnostics.key.activeExecutions": "Active executions",
            "diagnostics.key.roomSettings": "Room settings count",
            "diagnostics.key.runtimeHotVersion": "Runtime hot config version",
            "diagnostics.key.retention": "History retention policy",
            "diagnostics.key.latestRevision": "Latest audit summary",
            "health.title": "Health Check",
            "health.run": "Run Health Check",
            "health.table.component": "Component",
            "health.table.status": "Status",
            "health.table.details": "Details",
            "health.component.app": "CodeHarbor",
            "health.component.codex": "Codex",
            "health.component.claude": "Claude Code",
            "health.component.gemini": "Gemini CLI",
            "health.component.matrix": "Matrix",
            "health.component.overall": "Overall",
            "health.app.detail.updateAvailable": "Current {current}, latest {latest} (update available)",
            "health.app.detail.upToDate": "Current {current}, up to date",
            "health.app.detail.disabled": "Current {current}, update check disabled",
            "health.app.detail.unknown": "Current {current}, update check unavailable: {error}",
            "health.app.detail.noVersion": "Version information unavailable",
            "health.status.ok": "OK",
            "health.status.fail": "FAIL",
            "notice.healthDone": "Health check completed.",
            "notice.healthFailed": "Health check failed: {error}",
            "notice.healthEmptyFailed": "Failed to run health check.",
            "audit.title": "Config Audit",
            "audit.limit": "Limit",
            "audit.refresh": "Refresh Audit",
            "audit.table.id": "ID",
            "audit.table.time": "Time",
            "audit.table.actor": "Actor",
            "audit.table.summary": "Summary",
            "audit.table.payload": "Payload",
            "notice.auditEmpty": "No audit records.",
            "notice.auditLoaded": "Audit loaded: {count} record(s).",
            "notice.auditLoadFailed": "Failed to load audit: {error}",
            "table.loadFailed": "Failed to load."
          }
        };
        var currentLang = localStorage.getItem(storageLangKey);
        if (currentLang !== "en" && currentLang !== "zh") {
          currentLang = defaultLang;
        }
        var loaded = {
          "settings-global": false,
          "settings-bots": false,
          "settings-rooms": false,
          diagnostics: false,
          health: false,
          audit: false
        };
        var botProfilesState = [];
        var selectedBotProfileId = null;

        var tokenInput = document.getElementById("auth-token");
        var actorInput = document.getElementById("auth-actor");
        var langSelect = document.getElementById("lang-select");
        var noticeNode = document.getElementById("notice");
        var noticeTextNode = document.getElementById("notice-text");
        var noticeCloseBtn = document.getElementById("notice-close-btn");
        var noticeTimer = null;
        var authRoleNode = document.getElementById("auth-role");
        var botsListBody = document.getElementById("bots-list-body");
        var roomListBody = document.getElementById("room-list-body");
        var diagnosticsSummaryBody = document.getElementById("diagnostics-summary-body");
        var diagnosticsWarningBody = document.getElementById("diagnostics-warning-body");
        var healthBody = document.getElementById("health-body");
        var auditBody = document.getElementById("audit-body");
        var globalGrid = document.getElementById("global-grid");
        var globalMainActions = document.getElementById("global-main-actions");
        var globalRestartHint = document.getElementById("global-restart-hint");
        var globalSnapshotBlock = document.getElementById("global-snapshot-block");
        var globalSectionFieldMap = {
          basic: [
            "global-matrix-prefix",
            "global-workdir",
            "global-output-language",
            "global-progress-interval",
            "global-progress-delivery-mode",
            "global-typing-timeout",
            "global-active-window",
            "global-update-check-enabled",
            "global-update-check-timeout",
            "global-update-check-ttl",
            "global-progress-enabled",
            "global-notice-badge-enabled"
          ],
          autodev: [
            "global-autodev-loop-max-runs",
            "global-autodev-loop-max-minutes",
            "global-autodev-auto-commit",
            "global-autodev-auto-release-enabled",
            "global-autodev-auto-release-push",
            "global-bot-profiles-auto-retire-default",
            "global-autodev-max-consecutive-failures",
            "global-autodev-init-enhancement-enabled",
            "global-autodev-init-enhancement-timeout",
            "global-autodev-init-enhancement-max-chars"
          ],
          rate: [
            "global-rate-window",
            "global-rate-user",
            "global-rate-room",
            "global-concurrency-global",
            "global-concurrency-user",
            "global-concurrency-room"
          ],
          triggers: [
            "global-direct-mode",
            "global-trigger-mention",
            "global-trigger-reply",
            "global-trigger-window",
            "global-trigger-prefix"
          ],
          cli: [
            "global-cli-enabled",
            "global-cli-pass",
            "global-cli-whitespace",
            "global-cli-disable-split",
            "global-cli-throttle",
            "global-cli-fetch-media",
            "global-cli-image-max-bytes",
            "global-cli-image-max-count",
            "global-cli-image-mime-types",
            "global-cli-transcribe-audio",
            "global-cli-audio-model",
            "global-cli-audio-timeout",
            "global-cli-audio-max-chars",
            "global-cli-audio-max-retries",
            "global-cli-audio-retry-delay",
            "global-cli-audio-max-bytes",
            "global-cli-audio-local-command",
            "global-cli-audio-local-timeout",
            "global-cli-record-path",
            "global-proxy-enabled",
            "global-proxy-http",
            "global-proxy-https",
            "global-proxy-all",
            "global-proxy-no"
          ],
          agent: [
            "global-agent-enabled",
            "global-agent-repair-rounds",
            "global-agent-skills-enabled",
            "global-agent-skills-mode",
            "global-agent-skills-max-chars",
            "global-agent-skills-roots",
            "global-agent-skills-assignments",
            "global-agent-skills-refresh-btn",
            "global-agent-skills-catalog",
            "global-agent-skills-missing",
            "global-env-overrides"
          ],
          snapshot: []
        };

        tokenInput.value = localStorage.getItem(storageTokenKey) || "";
        actorInput.value = localStorage.getItem(storageActorKey) || "";
        langSelect.value = currentLang;

        langSelect.addEventListener("change", function () {
          currentLang = langSelect.value === "en" ? "en" : "zh";
          localStorage.setItem(storageLangKey, currentLang);
          applyLanguage();
          void refreshAuthStatus();
        });

        document.getElementById("auth-save-btn").addEventListener("click", async function () {
          localStorage.setItem(storageTokenKey, tokenInput.value.trim());
          localStorage.setItem(storageActorKey, actorInput.value.trim());
          showNotice("ok", t("notice.authSaved"));
          await reloadCurrentViewData();
          await refreshAuthStatus();
        });

        document.getElementById("auth-clear-btn").addEventListener("click", function () {
          tokenInput.value = "";
          actorInput.value = "";
          localStorage.removeItem(storageTokenKey);
          localStorage.removeItem(storageActorKey);
          showNotice("warn", t("notice.authCleared"));
          void refreshAuthStatus();
        });
        noticeCloseBtn.addEventListener("click", function () {
          hideNotice();
        });

        document.getElementById("global-save-btn").addEventListener("click", saveGlobal);
        document.getElementById("global-validate-btn").addEventListener("click", validateGlobalConfig);
        document.getElementById("global-reload-btn").addEventListener("click", loadGlobal);
        document.getElementById("global-agent-skills-refresh-btn").addEventListener("click", loadSkillCatalog);
        document.getElementById("global-restart-main-btn").addEventListener("click", function () {
          restartManagedServices(false);
        });
        document.getElementById("global-restart-all-btn").addEventListener("click", function () {
          restartManagedServices(true);
        });
        document.getElementById("config-export-btn").addEventListener("click", exportConfigSnapshot);
        document.getElementById("config-import-dry-run-btn").addEventListener("click", function () {
          importConfigSnapshot(true);
        });
        document.getElementById("config-import-apply-btn").addEventListener("click", function () {
          importConfigSnapshot(false);
        });
        document.getElementById("bots-load-btn").addEventListener("click", loadBotProfiles);
        document.getElementById("bots-save-btn").addEventListener("click", saveBotProfiles);
        document.getElementById("bots-migrate-dry-run-btn").addEventListener("click", function () {
          migrateSingleInstanceProfile(true);
        });
        document.getElementById("bots-migrate-apply-btn").addEventListener("click", function () {
          migrateSingleInstanceProfile(false);
        });
        document.getElementById("bots-new-btn").addEventListener("click", startCreateBotProfile);
        document.getElementById("bots-upsert-btn").addEventListener("click", upsertBotProfileLocal);
        document.getElementById("bots-delete-btn").addEventListener("click", removeSelectedBotProfileLocal);
        document.getElementById("bots-load-json-btn").addEventListener("click", loadBotProfilesFromJsonEditor);
        document.getElementById("bots-sync-json-btn").addEventListener("click", syncBotProfilesJsonEditor);
        document.getElementById("bots-apply-dry-run-btn").addEventListener("click", function () {
          applyBotProfiles(true);
        });
        document.getElementById("bots-apply-btn").addEventListener("click", function () {
          applyBotProfiles(false);
        });
        document.getElementById("room-load-btn").addEventListener("click", loadRoom);
        document.getElementById("room-save-btn").addEventListener("click", saveRoom);
        document.getElementById("room-validate-btn").addEventListener("click", validateRoomConfig);
        document.getElementById("room-delete-btn").addEventListener("click", deleteRoom);
        document.getElementById("room-refresh-btn").addEventListener("click", refreshRoomList);
        document.getElementById("diagnostics-refresh-btn").addEventListener("click", loadDiagnostics);
        document.getElementById("health-refresh-btn").addEventListener("click", loadHealth);
        document.getElementById("audit-refresh-btn").addEventListener("click", loadAudit);

        window.addEventListener("hashchange", handleRoute);

        if (!window.location.hash) {
          window.location.hash = pathToRoute[window.location.pathname] || "#/settings/global/basic";
        }
        handleRoute();
        applyLanguage();
        showNotice("ok", t("notice.ready"));
        void refreshAuthStatus();

        function normalizeRouteHash(hashValue) {
          var raw = (hashValue || "").trim();
          if (!raw) {
            return "#/settings/global/basic";
          }
          if (raw === "#/settings/global") {
            return "#/settings/global/basic";
          }
          if (raw.indexOf("#/settings/global/") === 0) {
            var section = raw.slice("#/settings/global/".length).trim().toLowerCase();
            if (globalSections.indexOf(section) >= 0) {
              return "#/settings/global/" + section;
            }
            return "#/settings/global/basic";
          }
          if (routeToView[raw]) {
            return raw;
          }
          return "#/settings/global/basic";
        }

        function getRouteState() {
          var hash = normalizeRouteHash(window.location.hash);
          var view = routeToView[hash] || "settings-global";
          var globalSection = defaultGlobalSection;
          if (view === "settings-global") {
            var prefix = "#/settings/global/";
            if (hash.indexOf(prefix) === 0) {
              globalSection = hash.slice(prefix.length) || defaultGlobalSection;
            }
          }
          return {
            hash: hash,
            view: view,
            globalSection: globalSection
          };
        }

        function getCurrentView() {
          return getRouteState().view;
        }

        function handleRoute() {
          var route = getRouteState();
          if (window.location.hash !== route.hash) {
            window.location.hash = route.hash;
            return;
          }
          var view = route.view;
          var panels = document.querySelectorAll("[data-view]");
          for (var i = 0; i < panels.length; i += 1) {
            var panel = panels[i];
            panel.hidden = panel.getAttribute("data-view") !== view;
          }
          var tabs = document.querySelectorAll(".tab");
          for (var j = 0; j < tabs.length; j += 1) {
            var tab = tabs[j];
            var targetRoute = tab.getAttribute("data-route");
            var targetPrefix = tab.getAttribute("data-route-prefix");
            var matchedByPrefix = Boolean(targetPrefix && route.hash.indexOf(targetPrefix) === 0);
            if ((targetRoute && targetRoute === route.hash) || matchedByPrefix) {
              tab.classList.add("active");
            } else {
              tab.classList.remove("active");
            }
          }
          renderGlobalSection(route.globalSection);
          ensureLoaded(view);
        }

        function resolveGlobalFieldContainer(inputId) {
          var node = document.getElementById(inputId);
          if (!node || typeof node.closest !== "function") {
            return null;
          }
          return node.closest(".field, .checkbox");
        }

        function setElementVisible(node, visible) {
          if (!node) {
            return;
          }
          node.hidden = !visible;
        }

        function renderGlobalSection(section) {
          var normalized = (section || defaultGlobalSection).toLowerCase();
          if (globalSections.indexOf(normalized) < 0) {
            normalized = defaultGlobalSection;
          }
          var isSnapshot = normalized === "snapshot";
          setElementVisible(globalGrid, !isSnapshot);
          setElementVisible(globalMainActions, !isSnapshot);
          setElementVisible(globalRestartHint, !isSnapshot);
          setElementVisible(globalSnapshotBlock, isSnapshot);
          if (!globalGrid || isSnapshot) {
            return;
          }
          var containers = globalGrid.querySelectorAll(".field, .checkbox");
          for (var i = 0; i < containers.length; i += 1) {
            containers[i].hidden = true;
          }
          var fields = globalSectionFieldMap[normalized] || [];
          for (var j = 0; j < fields.length; j += 1) {
            var container = resolveGlobalFieldContainer(fields[j]);
            if (container) {
              container.hidden = false;
            }
          }
        }

        function ensureLoaded(view) {
          if (loaded[view]) {
            return;
          }
          if (view === "settings-global") {
            loadGlobal();
          } else if (view === "settings-bots") {
            loadBotProfiles();
          } else if (view === "settings-rooms") {
            refreshRoomList();
          } else if (view === "diagnostics") {
            loadDiagnostics();
          } else if (view === "health") {
            loadHealth();
          } else if (view === "audit") {
            loadAudit();
          }
          loaded[view] = true;
        }

        async function reloadCurrentViewData() {
          var view = getCurrentView();
          loaded[view] = false;
          if (view === "settings-global") {
            await loadGlobal();
          } else if (view === "settings-bots") {
            await loadBotProfiles();
          } else if (view === "settings-rooms") {
            await refreshRoomList();
          } else if (view === "diagnostics") {
            await loadDiagnostics();
          } else if (view === "health") {
            await loadHealth();
          } else if (view === "audit") {
            await loadAudit();
          }
          loaded[view] = true;
        }

        async function apiRequest(path, method, body) {
          var headers = {};
          var token = tokenInput.value.trim();
          var actor = actorInput.value.trim();
          if (token) {
            headers.authorization = "Bearer " + token;
          }
          if (actor) {
            headers["x-admin-actor"] = actor;
          }
          if (body !== undefined) {
            headers["content-type"] = "application/json";
          }
          var response = await fetch(path, {
            method: method || "GET",
            headers: headers,
            body: body === undefined ? undefined : JSON.stringify(body)
          });
          var text = await response.text();
          var payload;
          try {
            payload = text ? JSON.parse(text) : {};
          } catch (error) {
            payload = { raw: text };
          }
          if (!response.ok) {
            var message = payload && payload.error ? payload.error : response.status + " " + response.statusText;
            throw new Error(message);
          }
          return payload;
        }

        function asNumber(inputId, fallback) {
          var value = Number.parseInt(document.getElementById(inputId).value, 10);
          return Number.isFinite(value) ? value : fallback;
        }

        function asBool(inputId) {
          return Boolean(document.getElementById(inputId).checked);
        }

        function asText(inputId) {
          return document.getElementById(inputId).value.trim();
        }

        function asOptionalNumber(inputId) {
          var raw = document.getElementById(inputId).value.trim();
          if (!raw) {
            return null;
          }
          var value = Number.parseInt(raw, 10);
          return Number.isFinite(value) ? value : null;
        }

        function parseCsvText(value) {
          if (!value) {
            return [];
          }
          return value
            .split(",")
            .map(function (item) {
              return item.trim();
            })
            .filter(function (item) {
              return item.length > 0;
            });
        }

        function parseRoleSkillAssignmentsInput(raw) {
          if (!raw) {
            return undefined;
          }
          var parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            throw new Error("agentWorkflow.roleSkills.roleAssignments must be valid JSON.");
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("agentWorkflow.roleSkills.roleAssignments must be a JSON object.");
          }
          var roles = ["planner", "executor", "reviewer"];
          for (var i = 0; i < roles.length; i += 1) {
            var role = roles[i];
            if (!(role in parsed)) {
              continue;
            }
            var list = parsed[role];
            if (!Array.isArray(list)) {
              throw new Error("agentWorkflow.roleSkills.roleAssignments." + role + " must be an array.");
            }
            for (var j = 0; j < list.length; j += 1) {
              if (typeof list[j] !== "string") {
                throw new Error("agentWorkflow.roleSkills.roleAssignments." + role + "[" + j + "] must be a string.");
              }
            }
          }
          return parsed;
        }

        function parseEnvOverridesInput(raw) {
          if (!raw) {
            return undefined;
          }
          var parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            throw new Error("envOverrides must be valid JSON.");
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("envOverrides must be a JSON object.");
          }
          return parsed;
        }

        function formatRoleSkillAssignments(value) {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return "";
          }
          try {
            return JSON.stringify(value, null, 2);
          } catch (error) {
            return "";
          }
        }

        function numberInRange(value, min, max) {
          return Number.isFinite(value) && value >= min && value <= max;
        }

        function validateGlobalPayloadLocal(payload) {
          var errors = [];
          if (!payload.codexWorkdir) {
            errors.push("global.defaultWorkdir");
          }
          if (payload.outputLanguage !== "zh" && payload.outputLanguage !== "en") {
            errors.push("global.outputLanguage");
          }
          if (!numberInRange(payload.matrixProgressMinIntervalMs, 1, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.progressInterval");
          }
          if (payload.matrixProgressDeliveryMode !== "upsert" && payload.matrixProgressDeliveryMode !== "timeline") {
            errors.push("global.progressDeliveryMode");
          }
          if (!numberInRange(payload.matrixTypingTimeoutMs, 1, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.typingTimeout");
          }
          if (!numberInRange(payload.sessionActiveWindowMinutes, 1, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.sessionWindow");
          }
          if (!numberInRange(payload.autoDev.loopMaxRuns, 0, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.autodevLoopMaxRuns");
          }
          if (!numberInRange(payload.autoDev.loopMaxMinutes, 0, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.autodevLoopMaxMinutes");
          }
          if (!numberInRange(payload.autoDev.maxConsecutiveFailures, 1, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.autodevMaxConsecutiveFailures");
          }
          if (!numberInRange(payload.autoDev.initEnhancementTimeoutMs, 1, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.autodevInitEnhancementTimeout");
          }
          if (!numberInRange(payload.autoDev.initEnhancementMaxChars, 1, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.autodevInitEnhancementMaxChars");
          }
          if (!numberInRange(payload.rateLimiter.windowMs, 1, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.rateWindow");
          }
          if (!numberInRange(payload.rateLimiter.maxRequestsPerUser, 0, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.rateUser");
          }
          if (!numberInRange(payload.rateLimiter.maxRequestsPerRoom, 0, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.rateRoom");
          }
          if (!numberInRange(payload.rateLimiter.maxConcurrentGlobal, 0, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.concurrentGlobal");
          }
          if (!numberInRange(payload.rateLimiter.maxConcurrentPerUser, 0, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.concurrentUser");
          }
          if (!numberInRange(payload.rateLimiter.maxConcurrentPerRoom, 0, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.concurrentRoom");
          }
          if (
            payload.rateLimiter.maxConcurrentGlobal > 0 &&
            payload.rateLimiter.maxConcurrentPerUser > payload.rateLimiter.maxConcurrentGlobal
          ) {
            errors.push("rateLimiter.maxConcurrentGlobal >= rateLimiter.maxConcurrentPerUser");
          }
          if (
            payload.rateLimiter.maxConcurrentGlobal > 0 &&
            payload.rateLimiter.maxConcurrentPerRoom > payload.rateLimiter.maxConcurrentGlobal
          ) {
            errors.push("rateLimiter.maxConcurrentGlobal >= rateLimiter.maxConcurrentPerRoom");
          }
          if (!numberInRange(payload.cliCompat.audioTranscribeMaxRetries, 0, 10)) {
            errors.push("global.audioMaxRetries");
          }
          if (!numberInRange(payload.cliCompat.imageMaxBytes, 1, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.cliImageMaxBytes");
          }
          if (!numberInRange(payload.cliCompat.imageMaxCount, 1, Number.MAX_SAFE_INTEGER)) {
            errors.push("global.cliImageMaxCount");
          }
          if (!payload.cliCompat.imageAllowedMimeTypes || payload.cliCompat.imageAllowedMimeTypes.length === 0) {
            errors.push("global.cliImageMimeTypes");
          }
          if (
            payload.proxy &&
            payload.proxy.enabled &&
            !payload.proxy.httpProxy &&
            !payload.proxy.httpsProxy &&
            !payload.proxy.allProxy
          ) {
            errors.push("global.proxyHttp");
          }
          if (!numberInRange(payload.agentWorkflow.autoRepairMaxRounds, 0, 10)) {
            errors.push("global.agentRounds");
          }
          if (
            payload.agentWorkflow.roleSkills.mode !== "summary" &&
            payload.agentWorkflow.roleSkills.mode !== "progressive" &&
            payload.agentWorkflow.roleSkills.mode !== "full"
          ) {
            errors.push("global.agentSkillsMode");
          }
          if (
            payload.agentWorkflow.roleSkills.maxChars !== null &&
            !numberInRange(payload.agentWorkflow.roleSkills.maxChars, 1, Number.MAX_SAFE_INTEGER)
          ) {
            errors.push("global.agentSkillsMaxChars");
          }
          return errors;
        }

        function validateRoomPayloadLocal(payload) {
          var errors = [];
          if (!payload.roomId) {
            errors.push("rooms.roomId");
          }
          if (!payload.workdir) {
            errors.push("rooms.workdir");
          }
          return errors;
        }

        function t(key, vars) {
          var dict = i18n[currentLang] || i18n[defaultLang];
          var template = dict[key] || key;
          if (!vars) {
            return template;
          }
          return template.replace(/{([a-zA-Z0-9_]+)}/g, function (_all, name) {
            return vars[name] === undefined || vars[name] === null ? "" : String(vars[name]);
          });
        }

        function applyLanguage() {
          var nodes = document.querySelectorAll("[data-i18n]");
          for (var i = 0; i < nodes.length; i += 1) {
            var node = nodes[i];
            var key = node.getAttribute("data-i18n");
            if (!key) {
              continue;
            }
            node.textContent = t(key);
          }
          var placeholderNodes = document.querySelectorAll("[data-i18n-placeholder]");
          for (var j = 0; j < placeholderNodes.length; j += 1) {
            var input = placeholderNodes[j];
            var placeholderKey = input.getAttribute("data-i18n-placeholder");
            if (!placeholderKey) {
              continue;
            }
            input.setAttribute("placeholder", t(placeholderKey));
          }
          var ariaLabelNodes = document.querySelectorAll("[data-i18n-aria-label]");
          for (var k = 0; k < ariaLabelNodes.length; k += 1) {
            var ariaLabelNode = ariaLabelNodes[k];
            var ariaLabelKey = ariaLabelNode.getAttribute("data-i18n-aria-label");
            if (!ariaLabelKey) {
              continue;
            }
            ariaLabelNode.setAttribute("aria-label", t(ariaLabelKey));
          }
          document.documentElement.lang = currentLang === "en" ? "en" : "zh-CN";
          if (langSelect.value !== currentLang) {
            langSelect.value = currentLang;
          }
          refreshBotSelectionLabel();
          renderBotTokenState(getSelectedBotProfile());
        }

        function hideNotice() {
          if (noticeTimer) {
            window.clearTimeout(noticeTimer);
            noticeTimer = null;
          }
          noticeNode.className = "notice";
        }

        function showNotice(type, message) {
          hideNotice();
          noticeNode.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
          noticeNode.setAttribute("role", type === "error" ? "alert" : "status");
          noticeNode.className = "notice " + type + " visible";
          noticeTextNode.textContent = message;
          var timeoutMs = type === "error" ? 12000 : type === "warn" ? 8000 : 5000;
          noticeTimer = window.setTimeout(function () {
            noticeNode.className = "notice " + type;
            noticeTimer = null;
          }, timeoutMs);
        }

        async function refreshAuthStatus() {
          try {
            var response = await apiRequest("/api/admin/auth/status", "GET");
            var data = response.data || {};
            if (!data.role) {
              authRoleNode.textContent = t("auth.permission.unauth");
              return;
            }

            var role = String(data.role).toUpperCase();
            var source = data.source ? " (" + String(data.source) + ")" : "";
            var actor = data.actor ? t("auth.permission.actorSuffix", { actor: String(data.actor) }) : "";
            authRoleNode.textContent = t("auth.permission.prefix", {
              role: role,
              source: source,
              actor: actor
            });
          } catch (error) {
            var message = error && error.message ? String(error.message) : "";
            if (/Unauthorized/i.test(message)) {
              authRoleNode.textContent = t("auth.permission.unauth");
              return;
            }
            authRoleNode.textContent = t("auth.permission.unknown");
          }
        }

        function renderEmptyRow(body, columns, text) {
          body.innerHTML = "";
          var row = document.createElement("tr");
          var cell = document.createElement("td");
          cell.colSpan = columns;
          cell.textContent = text;
          row.appendChild(cell);
          body.appendChild(row);
        }

        async function loadSkillCatalog(options) {
          var quiet = Boolean(options && options.quiet);
          var catalogNode = document.getElementById("global-agent-skills-catalog");
          var missingNode = document.getElementById("global-agent-skills-missing");
          try {
            var response = await apiRequest("/api/admin/config/skills", "GET");
            var data = response.data || {};
            var catalog = data.catalog || {};
            var available = Array.isArray(catalog.availableSkills) ? catalog.availableSkills : [];
            var lines = [];
            for (var i = 0; i < available.length; i += 1) {
              var entry = available[i] || {};
              if (!entry.id) {
                continue;
              }
              var title = entry.title ? " - " + String(entry.title) : "";
              lines.push(String(entry.id) + " (" + String(entry.source || "unknown") + ")" + title);
            }
            catalogNode.value = lines.join("\\n");

            var missingAssignments = catalog.missingAssignments || {};
            var roleLabels = { planner: "planner", executor: "executor", reviewer: "reviewer" };
            var missingParts = [];
            var roles = ["planner", "executor", "reviewer"];
            for (var j = 0; j < roles.length; j += 1) {
              var role = roles[j];
              var missing = Array.isArray(missingAssignments[role]) ? missingAssignments[role] : [];
              if (missing.length === 0) {
                continue;
              }
              missingParts.push(roleLabels[role] + ": " + missing.join(", "));
            }
            missingNode.textContent = missingParts.length > 0
              ? t("global.agentSkillsMissingPrefix", { items: missingParts.join(" ; ") })
              : t("global.agentSkillsMissingEmpty");
          } catch (error) {
            catalogNode.value = "";
            missingNode.textContent = t("global.agentSkillsLoadFailed", { error: error.message });
            if (!quiet) {
              showNotice("error", t("global.agentSkillsLoadFailed", { error: error.message }));
            }
          }
        }

        async function loadGlobal() {
          try {
            var response = await apiRequest("/api/admin/config/global", "GET");
            var data = response.data || {};
            var rateLimiter = data.rateLimiter || {};
            var trigger = data.defaultGroupTriggerPolicy || {};
            var cliCompat = data.cliCompat || {};
            var agentWorkflow = data.agentWorkflow || {};
            var roleSkills = agentWorkflow.roleSkills || {};
            var updateCheck = data.updateCheck || {};
            var autoDev = data.autoDev || {};
            var proxy = data.proxy || {};

            document.getElementById("global-matrix-prefix").value = data.matrixCommandPrefix || "";
            document.getElementById("global-workdir").value = data.codexWorkdir || "";
            document.getElementById("global-output-language").value = data.outputLanguage || "zh";
            document.getElementById("global-progress-enabled").checked = Boolean(data.matrixProgressUpdates);
            document.getElementById("global-progress-interval").value = String(data.matrixProgressMinIntervalMs || 2500);
            document.getElementById("global-progress-delivery-mode").value = data.matrixProgressDeliveryMode || "upsert";
            document.getElementById("global-typing-timeout").value = String(data.matrixTypingTimeoutMs || 10000);
            document.getElementById("global-notice-badge-enabled").checked =
              data.matrixNoticeBadgeEnabled === undefined ? true : Boolean(data.matrixNoticeBadgeEnabled);
            document.getElementById("global-active-window").value = String(data.sessionActiveWindowMinutes || 20);
            document.getElementById("global-update-check-enabled").checked =
              updateCheck.enabled === undefined ? true : Boolean(updateCheck.enabled);
            document.getElementById("global-update-check-timeout").value = String(updateCheck.timeoutMs || 3000);
            document.getElementById("global-update-check-ttl").value = String(updateCheck.ttlMs || 21600000);
            document.getElementById("global-autodev-loop-max-runs").value = String(
              typeof autoDev.loopMaxRuns === "number" ? autoDev.loopMaxRuns : 20
            );
            document.getElementById("global-autodev-loop-max-minutes").value = String(
              typeof autoDev.loopMaxMinutes === "number" ? autoDev.loopMaxMinutes : 120
            );
            document.getElementById("global-autodev-auto-commit").checked =
              autoDev.autoCommit === undefined ? true : Boolean(autoDev.autoCommit);
            document.getElementById("global-autodev-auto-release-enabled").checked =
              autoDev.autoReleaseEnabled === undefined ? true : Boolean(autoDev.autoReleaseEnabled);
            document.getElementById("global-autodev-auto-release-push").checked =
              autoDev.autoReleasePush === undefined ? false : Boolean(autoDev.autoReleasePush);
            document.getElementById("global-bot-profiles-auto-retire-default").checked =
              data.botProfilesAutoRetireDefaultSingleInstance === undefined
                ? false
                : Boolean(data.botProfilesAutoRetireDefaultSingleInstance);
            var retireToggle = document.getElementById("bots-retire-default-toggle");
            if (retireToggle) {
              retireToggle.checked =
                data.botProfilesAutoRetireDefaultSingleInstance === undefined
                  ? false
                  : Boolean(data.botProfilesAutoRetireDefaultSingleInstance);
              retireToggle.dataset.syncState = "synced";
            }
            document.getElementById("global-autodev-max-consecutive-failures").value = String(
              autoDev.maxConsecutiveFailures || 3
            );
            document.getElementById("global-autodev-init-enhancement-enabled").checked =
              autoDev.initEnhancementEnabled === undefined ? true : Boolean(autoDev.initEnhancementEnabled);
            document.getElementById("global-autodev-init-enhancement-timeout").value = String(
              autoDev.initEnhancementTimeoutMs || 480000
            );
            document.getElementById("global-autodev-init-enhancement-max-chars").value = String(
              autoDev.initEnhancementMaxChars || 4000
            );
            document.getElementById("global-rate-window").value = String(rateLimiter.windowMs || 60000);
            document.getElementById("global-rate-user").value = String(rateLimiter.maxRequestsPerUser || 0);
            document.getElementById("global-rate-room").value = String(rateLimiter.maxRequestsPerRoom || 0);
            document.getElementById("global-concurrency-global").value = String(rateLimiter.maxConcurrentGlobal || 0);
            document.getElementById("global-concurrency-user").value = String(rateLimiter.maxConcurrentPerUser || 0);
            document.getElementById("global-concurrency-room").value = String(rateLimiter.maxConcurrentPerRoom || 0);
            document.getElementById("global-direct-mode").checked = Boolean(data.groupDirectModeEnabled);

            document.getElementById("global-trigger-mention").checked = Boolean(trigger.allowMention);
            document.getElementById("global-trigger-reply").checked = Boolean(trigger.allowReply);
            document.getElementById("global-trigger-window").checked = Boolean(trigger.allowActiveWindow);
            document.getElementById("global-trigger-prefix").checked = Boolean(trigger.allowPrefix);

            document.getElementById("global-cli-enabled").checked = Boolean(cliCompat.enabled);
            document.getElementById("global-cli-pass").checked = Boolean(cliCompat.passThroughEvents);
            document.getElementById("global-cli-whitespace").checked = Boolean(cliCompat.preserveWhitespace);
            document.getElementById("global-cli-disable-split").checked = Boolean(cliCompat.disableReplyChunkSplit);
            document.getElementById("global-cli-throttle").value = String(cliCompat.progressThrottleMs || 0);
            document.getElementById("global-cli-fetch-media").checked = Boolean(cliCompat.fetchMedia);
            document.getElementById("global-cli-image-max-bytes").value = String(cliCompat.imageMaxBytes || 10485760);
            document.getElementById("global-cli-image-max-count").value = String(cliCompat.imageMaxCount || 4);
            document.getElementById("global-cli-image-mime-types").value = Array.isArray(cliCompat.imageAllowedMimeTypes)
              ? cliCompat.imageAllowedMimeTypes.join(",")
              : "image/png,image/jpeg,image/webp,image/gif";
            document.getElementById("global-cli-transcribe-audio").checked = Boolean(cliCompat.transcribeAudio);
            document.getElementById("global-cli-audio-model").value = cliCompat.audioTranscribeModel || "gpt-4o-mini-transcribe";
            document.getElementById("global-cli-audio-timeout").value = String(cliCompat.audioTranscribeTimeoutMs || 120000);
            document.getElementById("global-cli-audio-max-chars").value = String(cliCompat.audioTranscribeMaxChars || 6000);
            document.getElementById("global-cli-audio-max-retries").value = String(
              typeof cliCompat.audioTranscribeMaxRetries === "number" ? cliCompat.audioTranscribeMaxRetries : 1
            );
            document.getElementById("global-cli-audio-retry-delay").value = String(cliCompat.audioTranscribeRetryDelayMs || 800);
            document.getElementById("global-cli-audio-max-bytes").value = String(cliCompat.audioTranscribeMaxBytes || 26214400);
            document.getElementById("global-cli-audio-local-command").value = cliCompat.audioLocalWhisperCommand || "";
            document.getElementById("global-cli-audio-local-timeout").value = String(cliCompat.audioLocalWhisperTimeoutMs || 180000);
            document.getElementById("global-cli-record-path").value = cliCompat.recordPath || "";
            document.getElementById("global-proxy-enabled").checked = Boolean(proxy.enabled);
            document.getElementById("global-proxy-http").value = proxy.httpProxy || "";
            document.getElementById("global-proxy-https").value = proxy.httpsProxy || "";
            document.getElementById("global-proxy-all").value = proxy.allProxy || "";
            document.getElementById("global-proxy-no").value = proxy.noProxy || "";
            document.getElementById("global-agent-enabled").checked = Boolean(agentWorkflow.enabled);
            document.getElementById("global-agent-repair-rounds").value = String(
              typeof agentWorkflow.autoRepairMaxRounds === "number" ? agentWorkflow.autoRepairMaxRounds : 1
            );
            document.getElementById("global-agent-skills-enabled").checked =
              roleSkills.enabled === undefined ? true : Boolean(roleSkills.enabled);
            document.getElementById("global-agent-skills-mode").value = roleSkills.mode || "progressive";
            document.getElementById("global-agent-skills-max-chars").value =
              typeof roleSkills.maxChars === "number" ? String(roleSkills.maxChars) : "";
            document.getElementById("global-agent-skills-roots").value = Array.isArray(roleSkills.roots)
              ? roleSkills.roots.join(", ")
              : "";
            document.getElementById("global-agent-skills-assignments").value = formatRoleSkillAssignments(
              roleSkills.roleAssignments
            );
            document.getElementById("global-env-overrides").value = "";
            await loadSkillCatalog({ quiet: true });

            showNotice("ok", t("notice.globalLoaded"));
          } catch (error) {
            showNotice("error", t("notice.globalLoadFailed", { error: error.message }));
          }
        }

        function buildGlobalPayloadFromForm() {
          var roleAssignments = parseRoleSkillAssignmentsInput(asText("global-agent-skills-assignments"));
          var envOverrides = parseEnvOverridesInput(asText("global-env-overrides"));
          return {
            matrixCommandPrefix: asText("global-matrix-prefix"),
            codexWorkdir: asText("global-workdir"),
            outputLanguage: asText("global-output-language") || "zh",
            matrixProgressUpdates: asBool("global-progress-enabled"),
            matrixProgressMinIntervalMs: asNumber("global-progress-interval", 2500),
            matrixProgressDeliveryMode: asText("global-progress-delivery-mode") || "upsert",
            matrixTypingTimeoutMs: asNumber("global-typing-timeout", 10000),
            matrixNoticeBadgeEnabled: asBool("global-notice-badge-enabled"),
            sessionActiveWindowMinutes: asNumber("global-active-window", 20),
            updateCheck: {
              enabled: asBool("global-update-check-enabled"),
              timeoutMs: asNumber("global-update-check-timeout", 3000),
              ttlMs: asNumber("global-update-check-ttl", 21600000)
            },
            autoDev: {
              loopMaxRuns: asNumber("global-autodev-loop-max-runs", 20),
              loopMaxMinutes: asNumber("global-autodev-loop-max-minutes", 120),
              autoCommit: asBool("global-autodev-auto-commit"),
              autoReleaseEnabled: asBool("global-autodev-auto-release-enabled"),
              autoReleasePush: asBool("global-autodev-auto-release-push"),
              maxConsecutiveFailures: asNumber("global-autodev-max-consecutive-failures", 3),
              initEnhancementEnabled: asBool("global-autodev-init-enhancement-enabled"),
              initEnhancementTimeoutMs: asNumber("global-autodev-init-enhancement-timeout", 480000),
              initEnhancementMaxChars: asNumber("global-autodev-init-enhancement-max-chars", 4000)
            },
            botProfilesAutoRetireDefaultSingleInstance: asBool("global-bot-profiles-auto-retire-default"),
            groupDirectModeEnabled: asBool("global-direct-mode"),
            rateLimiter: {
              windowMs: asNumber("global-rate-window", 60000),
              maxRequestsPerUser: asNumber("global-rate-user", 20),
              maxRequestsPerRoom: asNumber("global-rate-room", 120),
              maxConcurrentGlobal: asNumber("global-concurrency-global", 8),
              maxConcurrentPerUser: asNumber("global-concurrency-user", 1),
              maxConcurrentPerRoom: asNumber("global-concurrency-room", 4)
            },
            defaultGroupTriggerPolicy: {
              allowMention: asBool("global-trigger-mention"),
              allowReply: asBool("global-trigger-reply"),
              allowActiveWindow: asBool("global-trigger-window"),
              allowPrefix: asBool("global-trigger-prefix")
            },
            cliCompat: {
              enabled: asBool("global-cli-enabled"),
              passThroughEvents: asBool("global-cli-pass"),
              preserveWhitespace: asBool("global-cli-whitespace"),
              disableReplyChunkSplit: asBool("global-cli-disable-split"),
              progressThrottleMs: asNumber("global-cli-throttle", 300),
              fetchMedia: asBool("global-cli-fetch-media"),
              imageMaxBytes: asNumber("global-cli-image-max-bytes", 10485760),
              imageMaxCount: asNumber("global-cli-image-max-count", 4),
              imageAllowedMimeTypes: parseCsvText(asText("global-cli-image-mime-types")),
              transcribeAudio: asBool("global-cli-transcribe-audio"),
              audioTranscribeModel: asText("global-cli-audio-model") || "gpt-4o-mini-transcribe",
              audioTranscribeTimeoutMs: asNumber("global-cli-audio-timeout", 120000),
              audioTranscribeMaxChars: asNumber("global-cli-audio-max-chars", 6000),
              audioTranscribeMaxRetries: asNumber("global-cli-audio-max-retries", 1),
              audioTranscribeRetryDelayMs: asNumber("global-cli-audio-retry-delay", 800),
              audioTranscribeMaxBytes: asNumber("global-cli-audio-max-bytes", 26214400),
              audioLocalWhisperCommand: asText("global-cli-audio-local-command"),
              audioLocalWhisperTimeoutMs: asNumber("global-cli-audio-local-timeout", 180000),
              recordPath: asText("global-cli-record-path")
            },
            proxy: {
              enabled: asBool("global-proxy-enabled"),
              httpProxy: asText("global-proxy-http"),
              httpsProxy: asText("global-proxy-https"),
              allProxy: asText("global-proxy-all"),
              noProxy: asText("global-proxy-no")
            },
            agentWorkflow: {
              enabled: asBool("global-agent-enabled"),
              autoRepairMaxRounds: asNumber("global-agent-repair-rounds", 1),
              roleSkills: {
                enabled: asBool("global-agent-skills-enabled"),
                mode: asText("global-agent-skills-mode") || "progressive",
                maxChars: asOptionalNumber("global-agent-skills-max-chars"),
                roots: parseCsvText(asText("global-agent-skills-roots")),
                roleAssignments: roleAssignments
              }
            },
            envOverrides: envOverrides
          };
        }

        async function validateGlobalConfig() {
          try {
            var payload = buildGlobalPayloadFromForm();
            var localErrors = validateGlobalPayloadLocal(payload);
            if (localErrors.length > 0) {
              throw new Error(localErrors.join(", "));
            }
            var response = await apiRequest("/api/admin/config/validate", "POST", {
              kind: "global",
              data: payload
            });
            var keys = response && response.data && Array.isArray(response.data.checkedKeys)
              ? response.data.checkedKeys.join(", ")
              : "global config";
            showNotice("ok", t("notice.globalValidated", { keys: keys }));
          } catch (error) {
            showNotice("error", t("notice.globalValidateFailed", { error: error.message }));
          }
        }

        async function saveGlobal() {
          try {
            var body = buildGlobalPayloadFromForm();
            var localErrors = validateGlobalPayloadLocal(body);
            if (localErrors.length > 0) {
              throw new Error(localErrors.join(", "));
            }
            await apiRequest("/api/admin/config/validate", "POST", {
              kind: "global",
              data: body
            });
            var response = await apiRequest("/api/admin/config/global", "PUT", body);
            var keys = Array.isArray(response.updatedKeys) ? response.updatedKeys.join(", ") : "global config";
            var hotKeys = Array.isArray(response.hotAppliedKeys) ? response.hotAppliedKeys : [];
            var restartKeys = Array.isArray(response.restartRequiredKeys) ? response.restartRequiredKeys : [];
            if (restartKeys.length > 0) {
              showNotice("warn", t("notice.globalSavedRestart", { keys: keys }));
            } else if (hotKeys.length > 0) {
              showNotice("ok", t("notice.globalSavedHot", { keys: keys }));
            } else {
              showNotice("warn", t("notice.globalSavedRestart", { keys: keys }));
            }
            await loadAudit();
          } catch (error) {
            showNotice("error", t("notice.globalSaveFailed", { error: error.message }));
          }
        }

        async function restartManagedServices(withAdmin) {
          try {
            var response = await apiRequest("/api/admin/service/restart", "POST", {
              withAdmin: Boolean(withAdmin)
            });
            var restarted = Array.isArray(response.restarted) ? response.restarted.join(", ") : "codeharbor";
            var suffix = withAdmin ? t("notice.restartSuffixAll") : "";
            showNotice("warn", t("notice.restartRequested", { services: restarted, suffix: suffix }));
          } catch (error) {
            showNotice("error", t("notice.restartFailed", { error: error.message }));
          }
        }

        async function exportConfigSnapshot() {
          try {
            var response = await apiRequest("/api/admin/config/export", "GET");
            var snapshot = response.data || {};
            var timestamp = typeof snapshot.exportedAt === "string" ? snapshot.exportedAt : new Date().toISOString();
            var filename =
              "codeharbor-config-" +
              timestamp.replace(/[:]/g, "-").replace(/[.][0-9]{3}Z$/, "Z") +
              ".json";
            var raw = JSON.stringify(snapshot, null, 2) + "\\n";
            var blob = new Blob([raw], { type: "application/json;charset=utf-8" });
            var url = URL.createObjectURL(blob);
            var link = document.createElement("a");
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            showNotice("ok", t("notice.snapshotExported", { filename: filename }));
          } catch (error) {
            showNotice("error", t("notice.snapshotExportFailed", { error: error.message }));
          }
        }

        async function readImportSnapshotFile() {
          var input = document.getElementById("config-import-file");
          var file = input && input.files && input.files[0] ? input.files[0] : null;
          if (!file) {
            throw new Error(t("notice.snapshotFileRequired"));
          }
          var raw = await file.text();
          try {
            return {
              fileName: file.name,
              snapshot: JSON.parse(raw)
            };
          } catch (error) {
            var message = error && error.message ? String(error.message) : "invalid JSON";
            throw new Error(t("notice.snapshotJsonInvalid", { error: message }));
          }
        }

        async function importConfigSnapshot(dryRun) {
          try {
            var loadedFile = await readImportSnapshotFile();
            var response = await apiRequest("/api/admin/config/import", "POST", {
              dryRun: Boolean(dryRun),
              snapshot: loadedFile.snapshot
            });
            if (dryRun) {
              showNotice("ok", t("notice.snapshotDryRunDone"));
              return;
            }
            showNotice("warn", t("notice.snapshotImportDone"));
            await Promise.all([loadGlobal(), refreshRoomList(), loadAudit(), loadDiagnostics()]);
            if (response && response.data && Array.isArray(response.data.outputLines) && response.data.outputLines.length > 0) {
              console.log("[config-import]", response.data.outputLines.join(" | "));
            }
          } catch (error) {
            showNotice("error", t("notice.snapshotImportFailed", { error: error.message }));
          }
        }

        function getSelectedBotProfile() {
          if (!selectedBotProfileId) {
            return null;
          }
          for (var i = 0; i < botProfilesState.length; i += 1) {
            if (botProfilesState[i].id === selectedBotProfileId) {
              return botProfilesState[i];
            }
          }
          return null;
        }

        function refreshBotSelectionLabel() {
          var labelNode = document.getElementById("bots-selected-label");
          if (!labelNode) {
            return;
          }
          var selected = getSelectedBotProfile();
          if (!selected) {
            labelNode.textContent = t("bots.selectedNone");
            return;
          }
          labelNode.textContent = t("bots.selectedPrefix", { id: selected.id });
        }

        function maskTokenLocal(value) {
          if (!value) {
            return null;
          }
          if (value.length <= 6) {
            return "***";
          }
          return value.slice(0, 3) + "***" + value.slice(-3);
        }

        function renderBotTokenState(profile) {
          var tokenStateNode = document.getElementById("bots-token-state");
          if (!tokenStateNode) {
            return;
          }
          if (!profile) {
            tokenStateNode.textContent = t("bots.tokenState.unknown");
            return;
          }
          if (profile.hasMatrixAccessToken) {
            tokenStateNode.textContent = t("bots.tokenState.present", {
              masked: profile.matrixAccessTokenMasked || "***",
            });
            return;
          }
          tokenStateNode.textContent = t("bots.tokenState.empty");
        }

        function normalizeOptionalTextValue(value) {
          if (value === null || value === undefined) {
            return null;
          }
          var text = String(value).trim();
          return text ? text : null;
        }

        function normalizeBotProfileForState(input) {
          var item = input || {};
          var triggerSource = item;
          if (item.triggerPolicy && typeof item.triggerPolicy === "object" && !Array.isArray(item.triggerPolicy)) {
            triggerSource = item.triggerPolicy;
          }
          var normalized = {
            id: String(item.id || "").trim(),
            enabled: Boolean(item.enabled),
            isPrimary: Boolean(item.isPrimary),
            runtimeHome: String(item.runtimeHome || "").trim(),
            runUser: String(item.runUser || "").trim(),
            withAdmin: item.withAdmin === undefined ? true : Boolean(item.withAdmin),
            matrixUserId: String(item.matrixUserId || "").trim(),
            matrixHomeserver: String(item.matrixHomeserver || "").trim(),
            hasMatrixAccessToken: Boolean(item.hasMatrixAccessToken),
            matrixAccessTokenMasked: item.matrixAccessTokenMasked ? String(item.matrixAccessTokenMasked) : null,
            workdir: normalizeOptionalTextValue(item.workdir),
            notes: normalizeOptionalTextValue(item.notes),
            backend: null,
            triggerPolicy: {
              groupDirectModeEnabled:
                triggerSource.groupDirectModeEnabled === undefined ? false : Boolean(triggerSource.groupDirectModeEnabled),
              allowMention: triggerSource.allowMention === undefined ? true : Boolean(triggerSource.allowMention),
              allowReply: triggerSource.allowReply === undefined ? false : Boolean(triggerSource.allowReply),
              allowActiveWindow: triggerSource.allowActiveWindow === undefined ? false : Boolean(triggerSource.allowActiveWindow),
              allowPrefix: triggerSource.allowPrefix === undefined ? true : Boolean(triggerSource.allowPrefix),
            },
          };

          if (item.backend && typeof item.backend === "object" && !Array.isArray(item.backend)) {
            var backendProvider = String(item.backend.provider || "").trim();
            if (backendProvider) {
              normalized.backend = {
                provider: backendProvider,
                model: normalizeOptionalTextValue(item.backend.model),
                bin: normalizeOptionalTextValue(item.backend.bin),
              };
            }
          }

          if (Object.prototype.hasOwnProperty.call(item, "matrixAccessToken")) {
            normalized.matrixAccessToken = typeof item.matrixAccessToken === "string" ? item.matrixAccessToken : "";
            if (normalized.matrixAccessToken) {
              normalized.hasMatrixAccessToken = true;
              normalized.matrixAccessTokenMasked = maskTokenLocal(normalized.matrixAccessToken);
            } else {
              normalized.hasMatrixAccessToken = false;
              normalized.matrixAccessTokenMasked = null;
            }
          }

          return normalized;
        }

        function serializeBotProfilesForSave(items) {
          var output = [];
          for (var i = 0; i < items.length; i += 1) {
            var item = items[i];
            var triggerPolicy = item.triggerPolicy && typeof item.triggerPolicy === "object" ? item.triggerPolicy : {};
            var next = {
              id: item.id,
              enabled: Boolean(item.enabled),
              isPrimary: Boolean(item.isPrimary),
              runtimeHome: item.runtimeHome,
              runUser: item.runUser,
              withAdmin: Boolean(item.withAdmin),
              matrixUserId: item.matrixUserId,
              matrixHomeserver: item.matrixHomeserver,
              triggerPolicy: {
                groupDirectModeEnabled:
                  triggerPolicy.groupDirectModeEnabled === undefined ? false : Boolean(triggerPolicy.groupDirectModeEnabled),
                allowMention: triggerPolicy.allowMention === undefined ? true : Boolean(triggerPolicy.allowMention),
                allowReply: triggerPolicy.allowReply === undefined ? false : Boolean(triggerPolicy.allowReply),
                allowActiveWindow: triggerPolicy.allowActiveWindow === undefined ? false : Boolean(triggerPolicy.allowActiveWindow),
                allowPrefix: triggerPolicy.allowPrefix === undefined ? true : Boolean(triggerPolicy.allowPrefix),
              },
              backend: null,
              workdir: item.workdir || null,
              notes: item.notes || null,
            };

            if (item.backend && item.backend.provider) {
              next.backend = {
                provider: String(item.backend.provider).trim(),
                model: item.backend.model || null,
                bin: item.backend.bin || null,
              };
            } else {
              next.backend = null;
            }

            if (Object.prototype.hasOwnProperty.call(item, "matrixAccessToken")) {
              next.matrixAccessToken = typeof item.matrixAccessToken === "string" ? item.matrixAccessToken : "";
            }

            output.push(next);
          }
          return output;
        }

        function syncBotProfilesJsonEditor() {
          document.getElementById("bots-profiles-json").value = JSON.stringify(serializeBotProfilesForSave(botProfilesState), null, 2);
        }

        function parseBotProfilesEditor() {
          var raw = document.getElementById("bots-profiles-json").value.trim();
          if (!raw) {
            return [];
          }
          var parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            throw new Error(t("notice.botsJsonInvalid", { error: error && error.message ? String(error.message) : "invalid JSON" }));
          }
          var items = [];
          if (Array.isArray(parsed)) {
            items = parsed;
          } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.profiles)) {
            items = parsed.profiles;
          } else {
            throw new Error(t("notice.botsJsonInvalid", { error: "expected JSON array or {profiles: [...]}" }));
          }

          var normalizedItems = [];
          var seen = {};
          for (var i = 0; i < items.length; i += 1) {
            var normalized = normalizeBotProfileForState(items[i]);
            if (!normalized.id) {
              throw new Error(t("notice.botsJsonInvalid", { error: "profile.id is required" }));
            }
            if (seen[normalized.id]) {
              throw new Error(t("notice.botsJsonInvalid", { error: "duplicate id: " + normalized.id }));
            }
            seen[normalized.id] = true;
            normalizedItems.push(normalized);
          }
          return normalizedItems;
        }

        function setSelectedBotProfileById(id) {
          var target = null;
          for (var i = 0; i < botProfilesState.length; i += 1) {
            if (botProfilesState[i].id === id) {
              target = botProfilesState[i];
              break;
            }
          }
          if (!target) {
            selectedBotProfileId = null;
            startCreateBotProfile();
            return;
          }
          selectedBotProfileId = target.id;
          fillBotProfileForm(target);
          renderBotProfileTable(botProfilesState);
        }

        function startCreateBotProfile() {
          selectedBotProfileId = null;
          document.getElementById("bots-form-id").value = "";
          document.getElementById("bots-form-enabled").checked = true;
          document.getElementById("bots-form-is-primary").checked = false;
          document.getElementById("bots-form-runtime-home").value = "";
          document.getElementById("bots-form-run-user").value = "";
          document.getElementById("bots-form-with-admin").checked = true;
          document.getElementById("bots-form-matrix-user-id").value = "";
          document.getElementById("bots-form-matrix-homeserver").value = "";
          document.getElementById("bots-form-matrix-token").value = "";
          document.getElementById("bots-form-clear-token").checked = false;
          document.getElementById("bots-form-trigger-group-direct").checked = false;
          document.getElementById("bots-form-trigger-mention").checked = true;
          document.getElementById("bots-form-trigger-reply").checked = false;
          document.getElementById("bots-form-trigger-window").checked = false;
          document.getElementById("bots-form-trigger-prefix").checked = true;
          document.getElementById("bots-form-backend-provider").value = "";
          document.getElementById("bots-form-backend-model").value = "";
          document.getElementById("bots-form-backend-bin").value = "";
          document.getElementById("bots-form-workdir").value = "";
          document.getElementById("bots-form-notes").value = "";
          refreshBotSelectionLabel();
          renderBotTokenState(null);
          renderBotProfileTable(botProfilesState);
        }

        function fillBotProfileForm(profile) {
          var triggerPolicy = profile && profile.triggerPolicy && typeof profile.triggerPolicy === "object" ? profile.triggerPolicy : {};
          document.getElementById("bots-form-id").value = profile.id || "";
          document.getElementById("bots-form-enabled").checked = Boolean(profile.enabled);
          document.getElementById("bots-form-is-primary").checked = Boolean(profile.isPrimary);
          document.getElementById("bots-form-runtime-home").value = profile.runtimeHome || "";
          document.getElementById("bots-form-run-user").value = profile.runUser || "";
          document.getElementById("bots-form-with-admin").checked = profile.withAdmin === undefined ? true : Boolean(profile.withAdmin);
          document.getElementById("bots-form-matrix-user-id").value = profile.matrixUserId || "";
          document.getElementById("bots-form-matrix-homeserver").value = profile.matrixHomeserver || "";
          document.getElementById("bots-form-matrix-token").value = "";
          document.getElementById("bots-form-clear-token").checked = false;
          document.getElementById("bots-form-trigger-group-direct").checked =
            triggerPolicy.groupDirectModeEnabled === undefined ? false : Boolean(triggerPolicy.groupDirectModeEnabled);
          document.getElementById("bots-form-trigger-mention").checked =
            triggerPolicy.allowMention === undefined ? true : Boolean(triggerPolicy.allowMention);
          document.getElementById("bots-form-trigger-reply").checked =
            triggerPolicy.allowReply === undefined ? false : Boolean(triggerPolicy.allowReply);
          document.getElementById("bots-form-trigger-window").checked =
            triggerPolicy.allowActiveWindow === undefined ? false : Boolean(triggerPolicy.allowActiveWindow);
          document.getElementById("bots-form-trigger-prefix").checked =
            triggerPolicy.allowPrefix === undefined ? true : Boolean(triggerPolicy.allowPrefix);
          document.getElementById("bots-form-backend-provider").value = profile.backend && profile.backend.provider ? profile.backend.provider : "";
          document.getElementById("bots-form-backend-model").value = profile.backend && profile.backend.model ? profile.backend.model : "";
          document.getElementById("bots-form-backend-bin").value = profile.backend && profile.backend.bin ? profile.backend.bin : "";
          document.getElementById("bots-form-workdir").value = profile.workdir || "";
          document.getElementById("bots-form-notes").value = profile.notes || "";
          refreshBotSelectionLabel();
          renderBotTokenState(profile);
        }

        function readBotProfileFromForm() {
          var id = asText("bots-form-id");
          var runtimeHome = asText("bots-form-runtime-home");
          var runUser = asText("bots-form-run-user");
          var matrixUserId = asText("bots-form-matrix-user-id");
          var matrixHomeserver = asText("bots-form-matrix-homeserver");
          if (!id) {
            throw new Error("id");
          }
          if (!runtimeHome) {
            throw new Error("runtimeHome");
          }
          if (!runUser) {
            throw new Error("runUser");
          }
          if (!matrixUserId) {
            throw new Error("matrixUserId");
          }
          if (!/^@[^:\\s]+:.+/.test(matrixUserId)) {
            throw new Error("matrixUserId format");
          }
          if (!matrixHomeserver) {
            throw new Error("matrixHomeserver");
          }
          try {
            new URL(matrixHomeserver);
          } catch (error) {
            throw new Error("matrixHomeserver url");
          }

          var backendProvider = asText("bots-form-backend-provider");
          var backendModel = normalizeOptionalTextValue(asText("bots-form-backend-model"));
          var backendBin = normalizeOptionalTextValue(asText("bots-form-backend-bin"));
          var profile = {
            id: id,
            enabled: asBool("bots-form-enabled"),
            isPrimary: asBool("bots-form-is-primary"),
            runtimeHome: runtimeHome,
            runUser: runUser,
            withAdmin: asBool("bots-form-with-admin"),
            matrixUserId: matrixUserId,
            matrixHomeserver: matrixHomeserver,
            backend: backendProvider
              ? {
                  provider: backendProvider,
                  model: backendModel,
                  bin: backendBin,
                }
              : null,
            triggerPolicy: {
              groupDirectModeEnabled: asBool("bots-form-trigger-group-direct"),
              allowMention: asBool("bots-form-trigger-mention"),
              allowReply: asBool("bots-form-trigger-reply"),
              allowActiveWindow: asBool("bots-form-trigger-window"),
              allowPrefix: asBool("bots-form-trigger-prefix"),
            },
            workdir: normalizeOptionalTextValue(asText("bots-form-workdir")),
            notes: normalizeOptionalTextValue(asText("bots-form-notes")),
          };

          if (profile.triggerPolicy.groupDirectModeEnabled && !profile.isPrimary) {
            throw new Error("groupDirectModeEnabled requires isPrimary=true");
          }

          var tokenInputValue = asText("bots-form-matrix-token");
          var clearToken = asBool("bots-form-clear-token");
          if (clearToken) {
            profile.matrixAccessToken = "";
          } else if (tokenInputValue) {
            profile.matrixAccessToken = tokenInputValue;
          }
          return profile;
        }

        function upsertBotProfileLocal() {
          try {
            var draft = readBotProfileFromForm();
            if (selectedBotProfileId && selectedBotProfileId !== draft.id) {
              botProfilesState = botProfilesState.filter(function (item) {
                return item.id !== selectedBotProfileId;
              });
            }
            var next = normalizeBotProfileForState(draft);
            var existingIndex = -1;
            for (var i = 0; i < botProfilesState.length; i += 1) {
              if (botProfilesState[i].id === next.id) {
                existingIndex = i;
                break;
              }
            }
            if (existingIndex >= 0) {
              var existing = botProfilesState[existingIndex];
              if (!Object.prototype.hasOwnProperty.call(next, "matrixAccessToken") && Object.prototype.hasOwnProperty.call(existing, "matrixAccessToken")) {
                next.matrixAccessToken = existing.matrixAccessToken;
              }
              if (!Object.prototype.hasOwnProperty.call(next, "matrixAccessToken")) {
                next.hasMatrixAccessToken = existing.hasMatrixAccessToken;
                next.matrixAccessTokenMasked = existing.matrixAccessTokenMasked;
              }
              botProfilesState[existingIndex] = next;
            } else {
              botProfilesState.push(next);
            }
            botProfilesState.sort(function (a, b) {
              return a.id.localeCompare(b.id);
            });
            selectedBotProfileId = next.id;
            syncBotProfilesJsonEditor();
            setSelectedBotProfileById(next.id);
            showNotice("ok", t("notice.botsProfileStaged", { id: next.id }));
          } catch (error) {
            showNotice("error", t("notice.botsFormInvalid", { error: error.message }));
          }
        }

        function removeSelectedBotProfileLocal() {
          if (!selectedBotProfileId) {
            showNotice("warn", t("notice.botsProfileNotSelected"));
            return;
          }
          var removedId = selectedBotProfileId;
          botProfilesState = botProfilesState.filter(function (item) {
            return item.id !== removedId;
          });
          selectedBotProfileId = null;
          syncBotProfilesJsonEditor();
          if (botProfilesState.length > 0) {
            setSelectedBotProfileById(botProfilesState[0].id);
          } else {
            startCreateBotProfile();
          }
          showNotice("warn", t("notice.botsProfileRemoved", { id: removedId }));
        }

        function loadBotProfilesFromJsonEditor() {
          try {
            botProfilesState = parseBotProfilesEditor();
            syncBotProfilesJsonEditor();
            if (botProfilesState.length > 0) {
              setSelectedBotProfileById(botProfilesState[0].id);
            } else {
              startCreateBotProfile();
            }
            renderBotProfileTable(botProfilesState);
            showNotice("ok", t("notice.botsJsonLoaded", { count: botProfilesState.length }));
          } catch (error) {
            showNotice("error", t("notice.botsJsonInvalid", { error: error.message }));
          }
        }

        function buildBackendSummary(item) {
          if (!item.backend || !item.backend.provider) {
            return "-";
          }
          return String(item.backend.provider) + (item.backend.model ? " (" + String(item.backend.model) + ")" : "");
        }

        function renderBotProfileTable(items) {
          botsListBody.innerHTML = "";
          if (!Array.isArray(items) || items.length === 0) {
            renderEmptyRow(botsListBody, 7, t("notice.botsEmpty"));
            return;
          }
          for (var i = 0; i < items.length; i += 1) {
            var item = items[i] || {};
            var row = document.createElement("tr");
            if (selectedBotProfileId && item.id === selectedBotProfileId) {
              row.classList.add("row-active");
            }
            appendCell(row, item.id || "");
            appendCell(row, String(Boolean(item.enabled)));
            appendCell(row, String(Boolean(item.isPrimary)));
            appendCell(row, item.matrixUserId || "");
            appendCell(row, item.runtimeHome || "");
            appendCell(row, buildBackendSummary(item));
            var actionCell = document.createElement("td");
            var editButton = document.createElement("button");
            editButton.type = "button";
            editButton.className = "secondary";
            editButton.textContent = t("bots.table.edit");
            (function (profileId) {
              editButton.addEventListener("click", function () {
                setSelectedBotProfileById(profileId);
              });
              row.addEventListener("click", function (event) {
                if (event.target && event.target.tagName === "BUTTON") {
                  return;
                }
                setSelectedBotProfileById(profileId);
              });
            })(item.id || "");
            actionCell.appendChild(editButton);
            row.appendChild(actionCell);
            botsListBody.appendChild(row);
          }
        }

        async function loadBotProfiles() {
          try {
            try {
              var globalResponse = await apiRequest("/api/admin/config/global", "GET");
              var globalData = globalResponse.data || {};
              var retireDefault =
                globalData.botProfilesAutoRetireDefaultSingleInstance === undefined
                  ? false
                  : Boolean(globalData.botProfilesAutoRetireDefaultSingleInstance);
              var retireToggle = document.getElementById("bots-retire-default-toggle");
              if (retireToggle) {
                retireToggle.checked = retireDefault;
                retireToggle.dataset.syncState = "synced";
              }
            } catch (error) {
              var retireToggleFallback = document.getElementById("bots-retire-default-toggle");
              if (retireToggleFallback) {
                retireToggleFallback.dataset.syncState = "unsynced";
              }
              console.warn("[bot-profiles] failed to sync retire-default toggle", error);
            }
            var response = await apiRequest("/api/admin/bot-profiles", "GET");
            var data = response.data || {};
            var profiles = Array.isArray(data.profiles) ? data.profiles : [];
            botProfilesState = profiles.map(function (item) {
              return normalizeBotProfileForState(item);
            });
            syncBotProfilesJsonEditor();
            if (botProfilesState.length > 0) {
              setSelectedBotProfileById(botProfilesState[0].id);
            } else {
              startCreateBotProfile();
            }
            renderBotProfileTable(botProfilesState);
            showNotice("ok", t("notice.botsLoaded", { count: botProfilesState.length }));
          } catch (error) {
            showNotice("error", t("notice.botsLoadFailed", { error: error.message }));
            renderEmptyRow(botsListBody, 6, t("table.loadFailed"));
          }
        }

        async function saveBotProfiles() {
          try {
            var profilesForSave = serializeBotProfilesForSave(botProfilesState);
            var response = await apiRequest("/api/admin/bot-profiles", "PUT", {
              profiles: profilesForSave
            });
            var data = response.data || {};
            var nextProfiles = Array.isArray(data.profiles) ? data.profiles : [];
            botProfilesState = nextProfiles.map(function (item) {
              return normalizeBotProfileForState(item);
            });
            syncBotProfilesJsonEditor();
            if (selectedBotProfileId) {
              setSelectedBotProfileById(selectedBotProfileId);
            } else if (botProfilesState.length > 0) {
              setSelectedBotProfileById(botProfilesState[0].id);
            } else {
              startCreateBotProfile();
            }
            renderBotProfileTable(botProfilesState);
            showNotice("ok", t("notice.botsSaved", { count: botProfilesState.length }));
            await loadAudit();
          } catch (error) {
            showNotice("error", t("notice.botsSaveFailed", { error: error.message }));
          }
        }

        async function migrateSingleInstanceProfile(dryRun) {
          try {
            var response = await apiRequest("/api/admin/bot-profiles/migrate", "POST", {
              dryRun: Boolean(dryRun)
            });
            var data = response.data || {};
            showNotice(
              data.performed ? "ok" : "warn",
              t("notice.botsMigrated", {
                message: data.message || "",
                dryRun: data.dryRun ? "true" : "false"
              })
            );
            if (data.profile && data.profile.id) {
              await loadBotProfiles();
              setSelectedBotProfileById(data.profile.id);
            }
            await loadAudit();
          } catch (error) {
            showNotice("error", t("notice.botsMigrateFailed", { error: error.message }));
          }
        }

        async function applyBotProfiles(dryRun) {
          try {
            var retireToggle = document.getElementById("bots-retire-default-toggle");
            var payload = {
              dryRun: Boolean(dryRun),
              includeDisabled: true
            };
            if (retireToggle && retireToggle.dataset.syncState !== "unsynced") {
              payload.retireDefaultSingleInstance = Boolean(retireToggle.checked);
            }
            var response = await apiRequest("/api/admin/bot-profiles/apply", "POST", payload);
            var data = response.data || {};
            var summary = data.summary || {};
            var retireApplied = data.retireDefaultSingleInstance ? "on" : "off";
            showNotice(
              summary.failed > 0 ? "warn" : "ok",
              t("notice.botsApplied", {
                succeeded: String(summary.succeeded || 0),
                failed: String(summary.failed || 0),
                skipped: String(summary.skipped || 0),
                retire: retireApplied
              })
            );
            if (Array.isArray(data.items) && data.items.length > 0) {
              console.log("[bot-profiles-apply]", data.items);
            }
            await loadAudit();
          } catch (error) {
            showNotice("error", t("notice.botsApplyFailed", { error: error.message }));
          }
        }

        async function refreshRoomList() {
          try {
            var response = await apiRequest("/api/admin/config/rooms", "GET");
            var items = Array.isArray(response.data) ? response.data : [];
            roomListBody.innerHTML = "";
            if (items.length === 0) {
              renderEmptyRow(roomListBody, 4, t("notice.roomsEmpty"));
              return;
            }
            for (var i = 0; i < items.length; i += 1) {
              var item = items[i];
              var row = document.createElement("tr");
              appendCell(row, item.roomId || "");
              appendCell(row, String(Boolean(item.enabled)));
              appendCell(row, item.workdir || "");
              appendCell(row, item.updatedAt ? new Date(item.updatedAt).toISOString() : "-");
              roomListBody.appendChild(row);
            }
            showNotice("ok", t("notice.roomsLoaded", { count: items.length }));
          } catch (error) {
            showNotice("error", t("notice.roomsLoadFailed", { error: error.message }));
            renderEmptyRow(roomListBody, 4, t("table.loadFailed"));
          }
        }

        function appendCell(row, text) {
          var cell = document.createElement("td");
          cell.textContent = text;
          row.appendChild(cell);
        }

        async function loadRoom() {
          var roomId = asText("room-id");
          if (!roomId) {
            showNotice("warn", t("notice.roomIdRequired"));
            return;
          }
          try {
            var response = await apiRequest("/api/admin/config/rooms/" + encodeURIComponent(roomId), "GET");
            fillRoomForm(response.data || {});
            showNotice("ok", t("notice.roomLoaded", { roomId: roomId }));
          } catch (error) {
            showNotice("error", t("notice.roomLoadFailed", { error: error.message }));
          }
        }

        function fillRoomForm(data) {
          document.getElementById("room-enabled").checked = Boolean(data.enabled);
          document.getElementById("room-mention").checked = Boolean(data.allowMention);
          document.getElementById("room-reply").checked = Boolean(data.allowReply);
          document.getElementById("room-window").checked = Boolean(data.allowActiveWindow);
          document.getElementById("room-prefix").checked = Boolean(data.allowPrefix);
          document.getElementById("room-workdir").value = data.workdir || "";
        }

        function buildRoomPayloadFromForm() {
          return {
            roomId: asText("room-id"),
            enabled: asBool("room-enabled"),
            allowMention: asBool("room-mention"),
            allowReply: asBool("room-reply"),
            allowActiveWindow: asBool("room-window"),
            allowPrefix: asBool("room-prefix"),
            workdir: asText("room-workdir"),
            summary: asText("room-summary")
          };
        }

        async function validateRoomConfig() {
          try {
            var payload = buildRoomPayloadFromForm();
            var localErrors = validateRoomPayloadLocal(payload);
            if (localErrors.length > 0) {
              throw new Error(localErrors.join(", "));
            }
            await apiRequest("/api/admin/config/validate", "POST", {
              kind: "room",
              data: payload
            });
            showNotice("ok", t("notice.roomValidated", { roomId: payload.roomId }));
          } catch (error) {
            showNotice("error", t("notice.roomValidateFailed", { error: error.message }));
          }
        }

        async function saveRoom() {
          var roomId = asText("room-id");
          if (!roomId) {
            showNotice("warn", t("notice.roomIdRequired"));
            return;
          }
          try {
            var payload = buildRoomPayloadFromForm();
            var localErrors = validateRoomPayloadLocal(payload);
            if (localErrors.length > 0) {
              throw new Error(localErrors.join(", "));
            }
            await apiRequest("/api/admin/config/validate", "POST", {
              kind: "room",
              data: payload
            });
            var body = {
              enabled: payload.enabled,
              allowMention: payload.allowMention,
              allowReply: payload.allowReply,
              allowActiveWindow: payload.allowActiveWindow,
              allowPrefix: payload.allowPrefix,
              workdir: payload.workdir,
              summary: payload.summary
            };
            await apiRequest("/api/admin/config/rooms/" + encodeURIComponent(roomId), "PUT", body);
            showNotice("ok", t("notice.roomSaved", { roomId: roomId }));
            await refreshRoomList();
            await loadAudit();
          } catch (error) {
            showNotice("error", t("notice.roomSaveFailed", { error: error.message }));
          }
        }

        async function deleteRoom() {
          var roomId = asText("room-id");
          if (!roomId) {
            showNotice("warn", t("notice.roomIdRequired"));
            return;
          }
          if (!window.confirm(t("confirm.roomDelete", { roomId: roomId }))) {
            return;
          }
          try {
            await apiRequest("/api/admin/config/rooms/" + encodeURIComponent(roomId), "DELETE");
            showNotice("ok", t("notice.roomDeleted", { roomId: roomId }));
            await refreshRoomList();
            await loadAudit();
          } catch (error) {
            showNotice("error", t("notice.roomDeleteFailed", { error: error.message }));
          }
        }

        async function loadDiagnostics() {
          try {
            var response = await apiRequest("/api/admin/diagnostics", "GET");
            var data = response.data || {};
            var health = data.health || {};
            var runtime = data.runtime || {};
            var config = data.config || {};
            diagnosticsSummaryBody.innerHTML = "";
            appendDiagnosticsRow(t("diagnostics.key.provider"), data.cliProvider || "-");
            appendDiagnosticsRow(
              t("diagnostics.key.runtimeMetrics"),
              runtime.metricsSnapshotAvailable ? t("health.status.ok") : t("health.status.fail")
            );
            appendDiagnosticsRow(t("diagnostics.key.metricsUpdatedAt"), runtime.metricsUpdatedAtIso || "-");
            appendDiagnosticsRow(t("diagnostics.key.requestTotal"), String(runtime.requestTotal || 0));
            appendDiagnosticsRow(t("diagnostics.key.activeExecutions"), String(runtime.activeExecutions || 0));
            appendDiagnosticsRow(t("diagnostics.key.roomSettings"), String(config.roomSettingsCount || 0));
            appendDiagnosticsRow(t("diagnostics.key.runtimeHotVersion"), String(config.runtimeHotConfigVersion || 0));
            var retention = config.retentionPolicy || {};
            appendDiagnosticsRow(
              t("diagnostics.key.retention"),
              (retention.enabled ? "on" : "off") + " / " + String(retention.retentionDays || 0) + "d"
            );
            appendDiagnosticsRow(
              t("diagnostics.key.latestRevision"),
              config.latestRevision ? String(config.latestRevision.summary || "-") : "-"
            );
            var diagProvider = data.cliProvider === "claude" ? "claude" : (data.cliProvider === "gemini" ? "gemini" : "codex");
            var diagCliComponentKey =
              diagProvider === "claude"
                ? "health.component.claude"
                : (diagProvider === "gemini" ? "health.component.gemini" : "health.component.codex");
            appendDiagnosticsRow(
              t(diagCliComponentKey),
              health.codex && health.codex.ok ? t("health.status.ok") : t("health.status.fail")
            );
            appendDiagnosticsRow(
              t("health.component.matrix"),
              health.matrix && health.matrix.ok ? t("health.status.ok") : t("health.status.fail")
            );

            diagnosticsWarningBody.innerHTML = "";
            var warnings = Array.isArray(data.warnings) ? data.warnings : [];
            if (warnings.length === 0) {
              var emptyWarningRow = document.createElement("tr");
              var emptyWarningCell = document.createElement("td");
              emptyWarningCell.textContent = t("notice.diagnosticsWarningEmpty");
              emptyWarningRow.appendChild(emptyWarningCell);
              diagnosticsWarningBody.appendChild(emptyWarningRow);
            } else {
              for (var i = 0; i < warnings.length; i += 1) {
                var warningRow = document.createElement("tr");
                var warningCell = document.createElement("td");
                warningCell.textContent = String(warnings[i]);
                warningRow.appendChild(warningCell);
                diagnosticsWarningBody.appendChild(warningRow);
              }
            }
            showNotice("ok", t("notice.diagnosticsLoaded"));
          } catch (error) {
            showNotice("error", t("notice.diagnosticsLoadFailed", { error: error.message }));
            renderEmptyRow(diagnosticsSummaryBody, 2, t("table.loadFailed"));
            renderEmptyRow(diagnosticsWarningBody, 1, t("table.loadFailed"));
          }
        }

        function appendDiagnosticsRow(key, value) {
          var row = document.createElement("tr");
          appendCell(row, key);
          appendCell(row, value);
          diagnosticsSummaryBody.appendChild(row);
        }

        async function loadHealth() {
          try {
            var response = await apiRequest("/api/admin/health", "GET");
            healthBody.innerHTML = "";

            var app = response.app || {};
            var codex = response.codex || {};
            var matrix = response.matrix || {};
            var provider = response.cliProvider === "claude" ? "claude" : (response.cliProvider === "gemini" ? "gemini" : "codex");
            var cliComponentKey =
              provider === "claude" ? "health.component.claude" : (provider === "gemini" ? "health.component.gemini" : "health.component.codex");

            appendHealthRow(t("health.component.app"), isAppHealthOk(app), formatAppHealthDetail(app));
            appendHealthRow(
              t(cliComponentKey),
              Boolean(codex.ok),
              codex.ok ? (codex.version || t("health.status.ok")) : (codex.error || t("health.status.fail"))
            );
            appendHealthRow(
              t("health.component.matrix"),
              Boolean(matrix.ok),
              matrix.ok
                ? "HTTP " + matrix.status + " " + JSON.stringify(matrix.versions || [])
                : (matrix.error || t("health.status.fail"))
            );
            appendHealthRow(t("health.component.overall"), Boolean(response.ok), response.timestamp || "");
            showNotice("ok", t("notice.healthDone"));
          } catch (error) {
            showNotice("error", t("notice.healthFailed", { error: error.message }));
            renderEmptyRow(healthBody, 3, t("notice.healthEmptyFailed"));
          }
        }

        function appendHealthRow(component, ok, detail) {
          var row = document.createElement("tr");
          appendCell(row, component);
          appendCell(row, ok ? t("health.status.ok") : t("health.status.fail"));
          appendCell(row, detail);
          healthBody.appendChild(row);
        }

        function isAppHealthOk(app) {
          if (!app || typeof app !== "object") {
            return false;
          }
          if (app.state === "up_to_date" || app.state === "update_available") {
            return true;
          }
          return app.state === "unknown" && String(app.error || "").toLowerCase() === "update check disabled";
        }

        function formatAppHealthDetail(app) {
          var current = app && app.currentVersion ? String(app.currentVersion) : "";
          if (!current) {
            return t("health.app.detail.noVersion");
          }
          if (app.state === "update_available" && app.latestVersion) {
            return t("health.app.detail.updateAvailable", {
              current: current,
              latest: String(app.latestVersion)
            });
          }
          if (app.state === "up_to_date") {
            return t("health.app.detail.upToDate", { current: current });
          }
          if (app.state === "unknown" && String(app.error || "").toLowerCase() === "update check disabled") {
            return t("health.app.detail.disabled", { current: current });
          }
          return t("health.app.detail.unknown", {
            current: current,
            error: app && app.error ? String(app.error) : "-"
          });
        }

        async function loadAudit() {
          var limit = asNumber("audit-limit", 30);
          if (limit < 1) {
            limit = 1;
          }
          if (limit > 200) {
            limit = 200;
          }
          try {
            var response = await apiRequest("/api/admin/audit?limit=" + limit, "GET");
            var items = Array.isArray(response.data) ? response.data : [];
            auditBody.innerHTML = "";
            if (items.length === 0) {
              renderEmptyRow(auditBody, 5, t("notice.auditEmpty"));
              return;
            }
            for (var i = 0; i < items.length; i += 1) {
              var item = items[i];
              var row = document.createElement("tr");
              appendCell(row, String(item.id || ""));
              appendCell(row, item.createdAtIso || "");
              appendCell(row, item.actor || "-");
              appendCell(row, item.summary || "");
              var payloadCell = document.createElement("td");
              var payloadNode = document.createElement("pre");
              payloadNode.textContent = formatPayload(item);
              payloadCell.appendChild(payloadNode);
              row.appendChild(payloadCell);
              auditBody.appendChild(row);
            }
            showNotice("ok", t("notice.auditLoaded", { count: items.length }));
          } catch (error) {
            showNotice("error", t("notice.auditLoadFailed", { error: error.message }));
            renderEmptyRow(auditBody, 5, t("table.loadFailed"));
          }
        }

        function formatPayload(item) {
          if (item.payload && typeof item.payload === "object") {
            return JSON.stringify(item.payload, null, 2);
          }
          if (typeof item.payloadJson === "string" && item.payloadJson) {
            return item.payloadJson;
          }
          return "";
        }
      })();
    </script>
  </body>
</html>
`;
