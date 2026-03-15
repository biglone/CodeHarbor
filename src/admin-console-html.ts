export const ADMIN_CONSOLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CodeHarbor Admin Console</title>
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
        max-width: 1100px;
        margin: 0 auto;
        padding: 20px 16px 40px;
      }
      .header {
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 16px;
        padding: 16px;
        backdrop-filter: blur(8px);
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
      .tabs {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .tab {
        color: var(--text);
        text-decoration: none;
        border: 1px solid var(--panel-border);
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 13px;
      }
      .tab.active {
        border-color: var(--accent);
        background: #155e7555;
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
      button,
      textarea {
        font: inherit;
      }
      input[type="text"],
      input[type="password"],
      input[type="number"] {
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
      .notice {
        margin: 12px 0 0;
        border-radius: 10px;
        padding: 8px 10px;
        font-size: 13px;
        border: 1px solid #334155;
        color: var(--muted);
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
        margin-top: 14px;
        background: var(--panel);
        border: 1px solid var(--panel-border);
        border-radius: 16px;
        padding: 16px;
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
      @media (max-width: 900px) {
        .auth-row {
          grid-template-columns: 1fr;
        }
        .grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="header">
        <h1 class="title">CodeHarbor Admin Console</h1>
        <p class="subtitle">Manage global settings, room policies, health checks, and config audit records.</p>
        <nav class="tabs">
          <a class="tab" data-page="settings-global" href="#/settings/global">Global</a>
          <a class="tab" data-page="settings-rooms" href="#/settings/rooms">Rooms</a>
          <a class="tab" data-page="health" href="#/health">Health</a>
          <a class="tab" data-page="audit" href="#/audit">Audit</a>
        </nav>
        <div class="auth-row">
          <label class="field">
            <span class="field-label">Admin Token (optional)</span>
            <input id="auth-token" type="password" placeholder="ADMIN_TOKEN" />
          </label>
          <label class="field">
            <span class="field-label">Actor (for audit logs)</span>
            <input id="auth-actor" type="text" placeholder="your-name" />
          </label>
          <button id="auth-save-btn" type="button" class="secondary">Save Auth</button>
          <button id="auth-clear-btn" type="button" class="secondary">Clear Auth</button>
        </div>
        <div id="notice" class="notice">Ready.</div>
        <p id="auth-role" class="muted">Permission: unknown</p>
      </section>

      <section class="panel" data-view="settings-global">
        <h2 class="panel-title">Global Config</h2>
        <div class="grid">
          <label class="field">
            <span class="field-label">Command Prefix</span>
            <input id="global-matrix-prefix" type="text" />
          </label>
          <label class="field">
            <span class="field-label">Default Workdir</span>
            <input id="global-workdir" type="text" />
          </label>
          <label class="field">
            <span class="field-label">Progress Interval (ms)</span>
            <input id="global-progress-interval" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label">Typing Timeout (ms)</span>
            <input id="global-typing-timeout" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label">Session Active Window (minutes)</span>
            <input id="global-active-window" type="number" min="1" />
          </label>
          <label class="checkbox">
            <input id="global-progress-enabled" type="checkbox" />
            <span>Enable progress updates</span>
          </label>

          <label class="field">
            <span class="field-label">Rate Window (ms)</span>
            <input id="global-rate-window" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label">Rate Max Requests / User</span>
            <input id="global-rate-user" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label">Rate Max Requests / Room</span>
            <input id="global-rate-room" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label">Max Concurrent Global</span>
            <input id="global-concurrency-global" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label">Max Concurrent / User</span>
            <input id="global-concurrency-user" type="number" min="0" />
          </label>
          <label class="field">
            <span class="field-label">Max Concurrent / Room</span>
            <input id="global-concurrency-room" type="number" min="0" />
          </label>

          <label class="checkbox"><input id="global-direct-mode" type="checkbox" /><span>Group direct mode (no trigger required)</span></label>
          <label class="checkbox"><input id="global-trigger-mention" type="checkbox" /><span>Trigger: mention</span></label>
          <label class="checkbox"><input id="global-trigger-reply" type="checkbox" /><span>Trigger: reply</span></label>
          <label class="checkbox"><input id="global-trigger-window" type="checkbox" /><span>Trigger: active window</span></label>
          <label class="checkbox"><input id="global-trigger-prefix" type="checkbox" /><span>Trigger: prefix</span></label>

          <label class="checkbox"><input id="global-cli-enabled" type="checkbox" /><span>CLI compat mode</span></label>
          <label class="checkbox"><input id="global-cli-pass" type="checkbox" /><span>CLI passthrough events</span></label>
          <label class="checkbox"><input id="global-cli-whitespace" type="checkbox" /><span>Preserve whitespace</span></label>
          <label class="checkbox"><input id="global-cli-disable-split" type="checkbox" /><span>Disable reply split</span></label>
          <label class="field">
            <span class="field-label">CLI progress throttle (ms)</span>
            <input id="global-cli-throttle" type="number" min="0" />
          </label>
          <label class="checkbox"><input id="global-cli-fetch-media" type="checkbox" /><span>Fetch media attachments</span></label>
          <label class="checkbox"><input id="global-cli-transcribe-audio" type="checkbox" /><span>Transcribe audio attachments</span></label>
          <label class="field">
            <span class="field-label">Audio transcribe model</span>
            <input id="global-cli-audio-model" type="text" />
          </label>
          <label class="field">
            <span class="field-label">Audio transcribe timeout (ms)</span>
            <input id="global-cli-audio-timeout" type="number" min="1" />
          </label>
          <label class="field">
            <span class="field-label">Audio transcript max chars</span>
            <input id="global-cli-audio-max-chars" type="number" min="1" />
          </label>
          <label class="checkbox"><input id="global-agent-enabled" type="checkbox" /><span>Enable multi-agent workflow</span></label>
          <label class="field">
            <span class="field-label">Workflow auto-repair rounds</span>
            <input id="global-agent-repair-rounds" type="number" min="0" max="10" />
          </label>
        </div>
        <div class="actions">
          <button id="global-save-btn" type="button">Save Global Config</button>
          <button id="global-reload-btn" type="button" class="secondary">Reload</button>
          <button id="global-restart-main-btn" type="button" class="secondary">Restart Main Service</button>
          <button id="global-restart-all-btn" type="button" class="secondary">Restart Main + Admin</button>
        </div>
        <p class="muted">Saving global config updates .env and requires restart to fully take effect.</p>
      </section>

      <section class="panel" data-view="settings-rooms" hidden>
        <h2 class="panel-title">Room Config</h2>
        <div class="grid">
          <label class="field">
            <span class="field-label">Room ID</span>
            <input id="room-id" type="text" placeholder="!room:example.com" />
          </label>
          <label class="field">
            <span class="field-label">Audit Summary (optional)</span>
            <input id="room-summary" type="text" placeholder="bind room to project A" />
          </label>
          <label class="field full">
            <span class="field-label">Workdir</span>
            <input id="room-workdir" type="text" />
          </label>
          <label class="checkbox"><input id="room-enabled" type="checkbox" /><span>Enabled</span></label>
          <label class="checkbox"><input id="room-mention" type="checkbox" /><span>Allow mention trigger</span></label>
          <label class="checkbox"><input id="room-reply" type="checkbox" /><span>Allow reply trigger</span></label>
          <label class="checkbox"><input id="room-window" type="checkbox" /><span>Allow active-window trigger</span></label>
          <label class="checkbox"><input id="room-prefix" type="checkbox" /><span>Allow prefix trigger</span></label>
        </div>
        <div class="actions">
          <button id="room-load-btn" type="button" class="secondary">Load Room</button>
          <button id="room-save-btn" type="button">Save Room</button>
          <button id="room-delete-btn" type="button" class="danger">Delete Room</button>
          <button id="room-refresh-btn" type="button" class="secondary">Refresh List</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Room ID</th>
                <th>Enabled</th>
                <th>Workdir</th>
                <th>Updated At</th>
              </tr>
            </thead>
            <tbody id="room-list-body"></tbody>
          </table>
        </div>
      </section>

      <section class="panel" data-view="health" hidden>
        <h2 class="panel-title">Health Check</h2>
        <div class="actions">
          <button id="health-refresh-btn" type="button">Run Health Check</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Component</th>
                <th>Status</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody id="health-body"></tbody>
          </table>
        </div>
      </section>

      <section class="panel" data-view="audit" hidden>
        <h2 class="panel-title">Config Audit</h2>
        <div class="actions">
          <label class="field" style="max-width: 120px;">
            <span class="field-label">Limit</span>
            <input id="audit-limit" type="number" min="1" max="200" value="30" />
          </label>
          <button id="audit-refresh-btn" type="button">Refresh Audit</button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Time</th>
                <th>Actor</th>
                <th>Summary</th>
                <th>Payload</th>
              </tr>
            </thead>
            <tbody id="audit-body"></tbody>
          </table>
        </div>
      </section>
    </main>

    <script>
      (function () {
        "use strict";

        var routeToView = {
          "#/settings/global": "settings-global",
          "#/settings/rooms": "settings-rooms",
          "#/health": "health",
          "#/audit": "audit"
        };
        var pathToRoute = {
          "/settings/global": "#/settings/global",
          "/settings/rooms": "#/settings/rooms",
          "/health": "#/health",
          "/audit": "#/audit"
        };
        var storageTokenKey = "codeharbor.admin.token";
        var storageActorKey = "codeharbor.admin.actor";
        var loaded = {
          "settings-global": false,
          "settings-rooms": false,
          health: false,
          audit: false
        };

        var tokenInput = document.getElementById("auth-token");
        var actorInput = document.getElementById("auth-actor");
        var noticeNode = document.getElementById("notice");
        var authRoleNode = document.getElementById("auth-role");
        var roomListBody = document.getElementById("room-list-body");
        var healthBody = document.getElementById("health-body");
        var auditBody = document.getElementById("audit-body");

        tokenInput.value = localStorage.getItem(storageTokenKey) || "";
        actorInput.value = localStorage.getItem(storageActorKey) || "";

        document.getElementById("auth-save-btn").addEventListener("click", function () {
          localStorage.setItem(storageTokenKey, tokenInput.value.trim());
          localStorage.setItem(storageActorKey, actorInput.value.trim());
          showNotice("ok", "Auth settings saved to localStorage.");
          void refreshAuthStatus();
        });

        document.getElementById("auth-clear-btn").addEventListener("click", function () {
          tokenInput.value = "";
          actorInput.value = "";
          localStorage.removeItem(storageTokenKey);
          localStorage.removeItem(storageActorKey);
          showNotice("warn", "Auth settings cleared.");
          void refreshAuthStatus();
        });

        document.getElementById("global-save-btn").addEventListener("click", saveGlobal);
        document.getElementById("global-reload-btn").addEventListener("click", loadGlobal);
        document.getElementById("global-restart-main-btn").addEventListener("click", function () {
          restartManagedServices(false);
        });
        document.getElementById("global-restart-all-btn").addEventListener("click", function () {
          restartManagedServices(true);
        });
        document.getElementById("room-load-btn").addEventListener("click", loadRoom);
        document.getElementById("room-save-btn").addEventListener("click", saveRoom);
        document.getElementById("room-delete-btn").addEventListener("click", deleteRoom);
        document.getElementById("room-refresh-btn").addEventListener("click", refreshRoomList);
        document.getElementById("health-refresh-btn").addEventListener("click", loadHealth);
        document.getElementById("audit-refresh-btn").addEventListener("click", loadAudit);

        window.addEventListener("hashchange", handleRoute);

        if (!window.location.hash) {
          window.location.hash = pathToRoute[window.location.pathname] || "#/settings/global";
        } else {
          handleRoute();
        }
        void refreshAuthStatus();

        function getCurrentView() {
          return routeToView[window.location.hash] || "settings-global";
        }

        function handleRoute() {
          var view = getCurrentView();
          var panels = document.querySelectorAll("[data-view]");
          for (var i = 0; i < panels.length; i += 1) {
            var panel = panels[i];
            panel.hidden = panel.getAttribute("data-view") !== view;
          }
          var tabs = document.querySelectorAll(".tab");
          for (var j = 0; j < tabs.length; j += 1) {
            var tab = tabs[j];
            if (tab.getAttribute("data-page") === view) {
              tab.classList.add("active");
            } else {
              tab.classList.remove("active");
            }
          }
          ensureLoaded(view);
        }

        function ensureLoaded(view) {
          if (loaded[view]) {
            return;
          }
          if (view === "settings-global") {
            loadGlobal();
          } else if (view === "settings-rooms") {
            refreshRoomList();
          } else if (view === "health") {
            loadHealth();
          } else if (view === "audit") {
            loadAudit();
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

        function showNotice(type, message) {
          noticeNode.className = "notice " + type;
          noticeNode.textContent = message;
        }

        async function refreshAuthStatus() {
          try {
            var response = await apiRequest("/api/admin/auth/status", "GET");
            var data = response.data || {};
            if (!data.role) {
              authRoleNode.textContent = "Permission: unauthenticated";
              return;
            }

            var role = String(data.role).toUpperCase();
            var source = data.source ? " (" + String(data.source) + ")" : "";
            var actor = data.actor ? " as " + String(data.actor) : "";
            authRoleNode.textContent = "Permission: " + role + source + actor;
          } catch (error) {
            var message = error && error.message ? String(error.message) : "";
            if (/Unauthorized/i.test(message)) {
              authRoleNode.textContent = "Permission: unauthenticated";
              return;
            }
            authRoleNode.textContent = "Permission: unknown";
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

        async function loadGlobal() {
          try {
            var response = await apiRequest("/api/admin/config/global", "GET");
            var data = response.data || {};
            var rateLimiter = data.rateLimiter || {};
            var trigger = data.defaultGroupTriggerPolicy || {};
            var cliCompat = data.cliCompat || {};
            var agentWorkflow = data.agentWorkflow || {};

            document.getElementById("global-matrix-prefix").value = data.matrixCommandPrefix || "";
            document.getElementById("global-workdir").value = data.codexWorkdir || "";
            document.getElementById("global-progress-enabled").checked = Boolean(data.matrixProgressUpdates);
            document.getElementById("global-progress-interval").value = String(data.matrixProgressMinIntervalMs || 2500);
            document.getElementById("global-typing-timeout").value = String(data.matrixTypingTimeoutMs || 10000);
            document.getElementById("global-active-window").value = String(data.sessionActiveWindowMinutes || 20);
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
            document.getElementById("global-cli-transcribe-audio").checked = Boolean(cliCompat.transcribeAudio);
            document.getElementById("global-cli-audio-model").value = cliCompat.audioTranscribeModel || "gpt-4o-mini-transcribe";
            document.getElementById("global-cli-audio-timeout").value = String(cliCompat.audioTranscribeTimeoutMs || 120000);
            document.getElementById("global-cli-audio-max-chars").value = String(cliCompat.audioTranscribeMaxChars || 6000);
            document.getElementById("global-agent-enabled").checked = Boolean(agentWorkflow.enabled);
            document.getElementById("global-agent-repair-rounds").value = String(
              typeof agentWorkflow.autoRepairMaxRounds === "number" ? agentWorkflow.autoRepairMaxRounds : 1
            );

            showNotice("ok", "Global config loaded.");
          } catch (error) {
            showNotice("error", "Failed to load global config: " + error.message);
          }
        }

        async function saveGlobal() {
          try {
            var body = {
              matrixCommandPrefix: asText("global-matrix-prefix"),
              codexWorkdir: asText("global-workdir"),
              matrixProgressUpdates: asBool("global-progress-enabled"),
              matrixProgressMinIntervalMs: asNumber("global-progress-interval", 2500),
              matrixTypingTimeoutMs: asNumber("global-typing-timeout", 10000),
              sessionActiveWindowMinutes: asNumber("global-active-window", 20),
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
                transcribeAudio: asBool("global-cli-transcribe-audio"),
                audioTranscribeModel: asText("global-cli-audio-model") || "gpt-4o-mini-transcribe",
                audioTranscribeTimeoutMs: asNumber("global-cli-audio-timeout", 120000),
                audioTranscribeMaxChars: asNumber("global-cli-audio-max-chars", 6000)
              },
              agentWorkflow: {
                enabled: asBool("global-agent-enabled"),
                autoRepairMaxRounds: asNumber("global-agent-repair-rounds", 1)
              }
            };
            var response = await apiRequest("/api/admin/config/global", "PUT", body);
            var keys = Array.isArray(response.updatedKeys) ? response.updatedKeys.join(", ") : "global config";
            showNotice("warn", "Saved: " + keys + ". Restart is required.");
            await loadAudit();
          } catch (error) {
            showNotice("error", "Failed to save global config: " + error.message);
          }
        }

        async function restartManagedServices(withAdmin) {
          try {
            var response = await apiRequest("/api/admin/service/restart", "POST", {
              withAdmin: Boolean(withAdmin)
            });
            var restarted = Array.isArray(response.restarted) ? response.restarted.join(", ") : "codeharbor";
            var suffix = withAdmin ? " Admin page may reconnect during restart." : "";
            showNotice("warn", "Restart requested: " + restarted + "." + suffix);
          } catch (error) {
            showNotice("error", "Failed to restart service(s): " + error.message);
          }
        }

        async function refreshRoomList() {
          try {
            var response = await apiRequest("/api/admin/config/rooms", "GET");
            var items = Array.isArray(response.data) ? response.data : [];
            roomListBody.innerHTML = "";
            if (items.length === 0) {
              renderEmptyRow(roomListBody, 4, "No room settings.");
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
            showNotice("ok", "Loaded " + items.length + " room setting(s).");
          } catch (error) {
            showNotice("error", "Failed to load room list: " + error.message);
            renderEmptyRow(roomListBody, 4, "Failed to load room settings.");
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
            showNotice("warn", "Room ID is required.");
            return;
          }
          try {
            var response = await apiRequest("/api/admin/config/rooms/" + encodeURIComponent(roomId), "GET");
            fillRoomForm(response.data || {});
            showNotice("ok", "Room config loaded for " + roomId + ".");
          } catch (error) {
            showNotice("error", "Failed to load room config: " + error.message);
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

        async function saveRoom() {
          var roomId = asText("room-id");
          if (!roomId) {
            showNotice("warn", "Room ID is required.");
            return;
          }
          try {
            var body = {
              enabled: asBool("room-enabled"),
              allowMention: asBool("room-mention"),
              allowReply: asBool("room-reply"),
              allowActiveWindow: asBool("room-window"),
              allowPrefix: asBool("room-prefix"),
              workdir: asText("room-workdir"),
              summary: asText("room-summary")
            };
            await apiRequest("/api/admin/config/rooms/" + encodeURIComponent(roomId), "PUT", body);
            showNotice("ok", "Room config saved for " + roomId + ".");
            await refreshRoomList();
            await loadAudit();
          } catch (error) {
            showNotice("error", "Failed to save room config: " + error.message);
          }
        }

        async function deleteRoom() {
          var roomId = asText("room-id");
          if (!roomId) {
            showNotice("warn", "Room ID is required.");
            return;
          }
          if (!window.confirm("Delete room config for " + roomId + "?")) {
            return;
          }
          try {
            await apiRequest("/api/admin/config/rooms/" + encodeURIComponent(roomId), "DELETE");
            showNotice("ok", "Room config deleted for " + roomId + ".");
            await refreshRoomList();
            await loadAudit();
          } catch (error) {
            showNotice("error", "Failed to delete room config: " + error.message);
          }
        }

        async function loadHealth() {
          try {
            var response = await apiRequest("/api/admin/health", "GET");
            healthBody.innerHTML = "";

            var codex = response.codex || {};
            var matrix = response.matrix || {};

            appendHealthRow("Codex", Boolean(codex.ok), codex.ok ? (codex.version || "ok") : (codex.error || "failed"));
            appendHealthRow(
              "Matrix",
              Boolean(matrix.ok),
              matrix.ok ? "HTTP " + matrix.status + " " + JSON.stringify(matrix.versions || []) : (matrix.error || "failed")
            );
            appendHealthRow("Overall", Boolean(response.ok), response.timestamp || "");
            showNotice("ok", "Health check completed.");
          } catch (error) {
            showNotice("error", "Health check failed: " + error.message);
            renderEmptyRow(healthBody, 3, "Failed to run health check.");
          }
        }

        function appendHealthRow(component, ok, detail) {
          var row = document.createElement("tr");
          appendCell(row, component);
          appendCell(row, ok ? "OK" : "FAIL");
          appendCell(row, detail);
          healthBody.appendChild(row);
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
              renderEmptyRow(auditBody, 5, "No audit records.");
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
            showNotice("ok", "Audit loaded: " + items.length + " record(s).");
          } catch (error) {
            showNotice("error", "Failed to load audit: " + error.message);
            renderEmptyRow(auditBody, 5, "Failed to load audit records.");
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
