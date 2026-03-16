# CodeHarbor Complete Configuration Guide

This guide is a single entry point for operators who want:

- a full setup flow from install to production service
- a clear configuration sequence (what to set first, what to tune later)
- a complete feature-to-config mapping

For the exhaustive key catalog (required/default/Admin UI/effect timing), see:

- [`docs/CONFIG_CATALOG.md`](./CONFIG_CATALOG.md)

---

## 0) Prerequisites

Prepare these before installation:

- Node.js 22+
- AI CLI installed and authenticated:
  - Codex (`codex login`) or
  - Claude Code (`claude login`)
- a Matrix bot account (or dedicated Matrix user) and valid access token

Optional:

- `OPENAI_API_KEY` if you plan to use OpenAI fallback for audio transcription

---

## 1) End-to-End Setup Flow

Use this sequence for first-time deployment.

### Step 1: Install runtime

Install from npm:

```bash
npm install -g codeharbor
```

Or use Linux easy installer (install + `.env` + systemd in one run):

```bash
curl -fsSL https://raw.githubusercontent.com/biglone/CodeHarbor/main/scripts/install-linux-easy.sh | bash -s -- \
  --matrix-homeserver https://matrix.example.com \
  --matrix-user-id @bot:example.com \
  --matrix-access-token 'your-token'
```

### Step 2: Initialize config template

```bash
codeharbor init
```

This creates `.env` in your runtime home (`~/.codeharbor` by default, or legacy `/opt/codeharbor` when detected).

### Step 3: Fill required boot config

Set at least:

- `MATRIX_HOMESERVER`
- `MATRIX_USER_ID`
- `MATRIX_ACCESS_TOKEN`

Recommended at the same time:

- `CODEX_WORKDIR`
- `CODEX_BIN` (if not in default PATH)

### Step 4: Validate before start

```bash
codeharbor doctor
```

If check fails, fix reported items first (Matrix auth, codex path, workdir, or `.env`).

### Step 5: Start runtime

```bash
codeharbor start
```

### Step 6: Verify chat path

In Matrix:

- DM the bot with a text prompt (should be processed directly)
- In group, trigger via mention/reply/prefix (unless direct mode enabled)

### Step 7: Install managed services (recommended for production)

Main service:

```bash
codeharbor service install
```

Main + admin:

```bash
codeharbor service install --with-admin
```

### Step 8: Open Admin Console

Start admin API/UI:

```bash
codeharbor admin serve
```

Open:

- `/settings/global`
- `/settings/rooms`
- `/health`
- `/audit`

### Step 9: Apply runtime tuning from Admin UI

Recommended order:

1. Global settings (prefix/workdir/limits/progress/CLI compat)
2. Room settings (room-specific workdir and trigger policy)
3. Health check
4. Audit review

### Step 10: Restart when needed

Global config writes `.env` and is restart-scoped. Restart after save:

- Admin UI button: `Restart Main Service` or `Restart Main + Admin`
- CLI: `codeharbor service restart --with-admin`

### Step 11: Enable backup automation

Manual snapshot:

```bash
./scripts/backup-config.sh
```

Install scheduled backup timer:

```bash
./scripts/install-backup-timer.sh --schedule "*-*-* 03:30:00"
```

### Step 12: Upgrade process

```bash
npm install -g codeharbor@latest
```

On Linux global install, postinstall performs best-effort service restart so upgrade can take effect immediately.

---

## 2) Configuration Sequence (What To Set First)

Use this order to avoid config drift:

1. **Connectivity + execution baseline**
   - Matrix access + Codex path/workdir
2. **Routing policy**
   - group direct mode, trigger policy, active window
3. **Protection limits**
   - rate limit and concurrency caps
4. **Output behavior**
   - progress and typing tuning
5. **Advanced compatibility**
   - CLI compat + media + audio transcription
6. **Security hardening**
   - admin token/RBAC, IP/origin allowlist
7. **Room-level overrides**
   - per-room enable/disable and trigger/workdir adjustments

---

## 3) Feature-to-Config Map

This section explains all runtime capabilities and the keys that control them.

### A. Matrix and Codex baseline

- **Purpose**: make requests executable end-to-end.
- **Keys**:
  - `AI_CLI_PROVIDER`
  - `MATRIX_HOMESERVER`
  - `MATRIX_USER_ID`
  - `MATRIX_ACCESS_TOKEN`
  - `CODEX_BIN`
  - `CODEX_MODEL`
  - `CODEX_WORKDIR`
  - `CODEX_EXEC_TIMEOUT_MS`
  - `CODEX_SANDBOX_MODE`
  - `CODEX_APPROVAL_POLICY`
  - `CODEX_EXTRA_ARGS`
  - `CODEX_EXTRA_ENV_JSON`
  - `CODEX_DANGEROUS_BYPASS`

### B. Conversation routing and trigger behavior

- **Purpose**: control which group/DM messages are accepted.
- **Keys**:
  - `MATRIX_COMMAND_PREFIX`
  - `SESSION_ACTIVE_WINDOW_MINUTES`
  - `GROUP_DIRECT_MODE_ENABLED`
  - `GROUP_TRIGGER_ALLOW_MENTION`
  - `GROUP_TRIGGER_ALLOW_REPLY`
  - `GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW`
  - `GROUP_TRIGGER_ALLOW_PREFIX`
  - `ROOM_TRIGGER_POLICY_JSON` (legacy JSON policy map)
- **Admin Room Config DB**:
  - room enable flag
  - room workdir
  - room-level trigger overrides

### C. Rate limiting and concurrency protection

- **Purpose**: anti-abuse and runtime stability.
- **Keys**:
  - `RATE_LIMIT_WINDOW_SECONDS`
  - `RATE_LIMIT_MAX_REQUESTS_PER_USER`
  - `RATE_LIMIT_MAX_REQUESTS_PER_ROOM`
  - `RATE_LIMIT_MAX_CONCURRENT_GLOBAL`
  - `RATE_LIMIT_MAX_CONCURRENT_PER_USER`
  - `RATE_LIMIT_MAX_CONCURRENT_PER_ROOM`
- **Tip**: set specific limiter values to `0` only when intentionally disabling that guard.

### D. Progress and response shaping

- **Purpose**: improve user feedback and reduce room noise.
- **Keys**:
  - `REPLY_CHUNK_SIZE`
  - `MATRIX_PROGRESS_UPDATES`
  - `MATRIX_PROGRESS_MIN_INTERVAL_MS`
  - `MATRIX_TYPING_TIMEOUT_MS`
  - `PACKAGE_UPDATE_CHECK_ENABLED`
  - `PACKAGE_UPDATE_CHECK_TIMEOUT_MS`
  - `PACKAGE_UPDATE_CHECK_TTL_MS`
- **Behavior**:
  - `/status` and `/version` include current version + update hint
  - `/status` shows the latest cached check time; `/version` triggers a forced refresh
  - Admin `/health` includes CodeHarbor app version/update row
  - when update check is disabled or lookup fails, health still shows current version with reason

### E. CLI compatibility and replay

- **Purpose**: make IM behavior closer to terminal codex CLI.
- **Keys**:
  - `CLI_COMPAT_MODE`
  - `CLI_COMPAT_PASSTHROUGH_EVENTS`
  - `CLI_COMPAT_PRESERVE_WHITESPACE`
  - `CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT`
  - `CLI_COMPAT_PROGRESS_THROTTLE_MS`
  - `CLI_COMPAT_RECORD_PATH`

### F. Media and audio understanding

- **Purpose**: support attachment-aware prompts (images and voice).
- **Keys**:
  - `CLI_COMPAT_FETCH_MEDIA` (download Matrix media)
  - `CLI_COMPAT_TRANSCRIBE_AUDIO`
  - `CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL`
  - `CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS`
  - `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS`
  - `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES`
  - `CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS`
  - `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES`
  - `CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND`
  - `CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS`
- **Behavior**:
  - local whisper first (if configured)
  - OpenAI fallback when local fails and `OPENAI_API_KEY` is present
  - oversized audio skip protection
  - best-effort retries and non-fatal failure path

### G. Multi-agent and AutoDev workflow

- **Purpose**: enable Planner/Executor/Reviewer and `/autodev` flows.
- **Keys**:
  - `AGENT_WORKFLOW_ENABLED`
  - `AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS`

### H. Persistence and retention

- **Purpose**: durable session/event tracking and bounded storage.
- **Keys**:
  - `STATE_DB_PATH`
  - `STATE_PATH`
  - `MAX_PROCESSED_EVENTS_PER_SESSION`
  - `MAX_SESSION_AGE_DAYS`
  - `MAX_SESSIONS`

### I. Admin UI/API security and operations

- **Purpose**: protect and operate management surface safely.
- **Keys**:
  - `ADMIN_BIND_HOST`
  - `ADMIN_PORT`
  - `ADMIN_TOKEN`
  - `ADMIN_TOKENS_JSON`
  - `ADMIN_IP_ALLOWLIST`
  - `ADMIN_ALLOWED_ORIGINS`
  - `DOCTOR_HTTP_TIMEOUT_MS`
  - `LOG_LEVEL`

---

## 4) Effect Timing Rules

- **Restart-scoped**
  - Most `.env` values (including Admin Global Config fields) require restart.
- **Immediate**
  - Room settings stored in Admin room config database are applied to new requests without full process restart.

When in doubt, treat config changes as restart-scoped for operational safety.

---

## 5) Recommended Profiles

### Local single-user

- Keep admin on loopback (`ADMIN_BIND_HOST=127.0.0.1`)
- optional token (`ADMIN_TOKEN`)
- moderate default rate limits

### Internal team

- set `ADMIN_TOKEN` or `ADMIN_TOKENS_JSON`
- consider `ADMIN_IP_ALLOWLIST`
- use reverse proxy and TLS

### Public access through tunnel/proxy

- keep admin bind host loopback
- require token or RBAC token set
- expose only through trusted gateway (for example Cloudflare Tunnel)
- never run public admin with empty token

---

## 6) Verification Checklist (Post-Setup)

- `codeharbor doctor` passes
- DM message gets response
- Group trigger behaves as expected
- `/status` returns session/limiter/worker info
- `/version` returns current version and update hint
- Admin `/health` reports Matrix/Codex and CodeHarbor app version status
- Admin `/audit` records your config updates
- restart commands work (`service restart` or Admin restart API/UI)
- backup snapshot file is generated and restorable

---

## 7) Related Docs

- Baseline quickstart and command reference: [`README.md`](../README.md)
- Full key catalog: [`docs/CONFIG_CATALOG.md`](./CONFIG_CATALOG.md)
- Standalone admin deployment: [`docs/ADMIN_STANDALONE_DEPLOY.md`](./ADMIN_STANDALONE_DEPLOY.md)
- Backup and timer operations: [`docs/BACKUP_AUTOMATION.md`](./BACKUP_AUTOMATION.md)
- Release flow: [`docs/RELEASE.md`](./RELEASE.md)
