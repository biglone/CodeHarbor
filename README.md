# CodeHarbor

CodeHarbor is a self-hosted Matrix bot and AI chat bridge for `codex` and `claude` CLI.
Users send messages in Matrix rooms, CodeHarbor routes each request to the selected backend,
keeps room/session state in SQLite, and sends the final result back to the same room.

Maintainer: <https://github.com/biglone>
Verified by CI:
- [![CI](https://github.com/biglone/CodeHarbor/actions/workflows/ci.yml/badge.svg)](https://github.com/biglone/CodeHarbor/actions/workflows/ci.yml)
- [![Release NPM](https://github.com/biglone/CodeHarbor/actions/workflows/release-npm.yml/badge.svg)](https://github.com/biglone/CodeHarbor/actions/workflows/release-npm.yml)

Quick feedback:
- Questions/usage: <https://github.com/biglone/CodeHarbor/discussions>
- Bug report: <https://github.com/biglone/CodeHarbor/issues/new?template=bug_report.yml>
- Feature request: <https://github.com/biglone/CodeHarbor/issues/new?template=feature_request.yml>
- Release announcements (EN/中文 in one thread): <https://github.com/biglone/CodeHarbor/discussions/3>
- Roadmap poll (EN/中文 in one thread): <https://github.com/biglone/CodeHarbor/discussions/4>

## What It Does

- Matrix channel adapter (receive + reply)
- Session-to-backend mapping via persistent SQLite state
- One-time migration import from legacy `state.json`
- Duplicate Matrix event protection
- Context-aware trigger (DM direct chat + group mention/reply + active session window)
- Room-level trigger policy overrides
- Runtime backend switch: `/backend codex|claude|status`
- Cross-backend context bridge on next request after switch
- Real `/stop` cancellation (kills in-flight AI CLI process)
- Session runtime workers (logical worker per `channel:room:user`, with worker stats in `/status`)
- Rate limiting + concurrency guardrails (user/room/global)
- Progress + typing updates with group notice coalescing (`m.replace` edit)
- CLI-compat mode (`cli_compat_mode`) for minimal prompt rewriting + raw event passthrough
- Image attachment metadata passthrough from Matrix events into prompt context
- Voice attachment transcription (local Whisper/OpenAI fallback)
- Request observability (request_id, queue/exec/send durations, status counters)
- NPM-distributed CLI (`codeharbor`)

## Architecture

```text
Matrix Room -> MatrixChannel -> Orchestrator -> AI CLI Executor (codex/claude)
                                          |
                                          -> StateStore (SQLite)
```

## Implementation Status

- Primary runtime: TypeScript/Node (`src/`, `dist/`, `npm run ...`)
- Legacy/reference implementation: Python (`app/`, `tests/`)
- New features and fixes target the TypeScript runtime.
- Python code is kept as legacy reference only (maintenance mode).

## Prerequisites

- Node.js 22+
- AI CLI installed and authenticated:
  - Codex: `codex login`
  - Claude Code: `claude login`
- A Matrix bot user + access token

## Install

Install globally from npm (after publish):

```bash
npm install -g codeharbor
```

Linux one-command install (creates `/opt/codeharbor`, sets ownership, installs latest package):

```bash
curl -fsSL https://raw.githubusercontent.com/biglone/CodeHarbor/main/scripts/install-linux.sh | bash
```

Linux easy mode (install + write `.env` + enable/start systemd in one run):

```bash
curl -fsSL https://raw.githubusercontent.com/biglone/CodeHarbor/main/scripts/install-linux-easy.sh | bash -s -- \
  --matrix-homeserver https://matrix.example.com \
  --matrix-user-id @bot:example.com \
  --matrix-access-token 'your-token'
```

Install first, then enable systemd service with one command:

```bash
codeharbor service install
```

Install + enable main and admin services:

```bash
codeharbor service install --with-admin
```

Restart installed service(s):

```bash
codeharbor service restart --with-admin
```

Remove installed services:

```bash
codeharbor service uninstall --with-admin
```

Notes:

- Service commands auto-elevate with `sudo` when root privileges are required.
- `codeharbor service install --with-admin` and `install-linux-easy.sh --enable-admin-service` now install
  `/etc/sudoers.d/codeharbor-restart` for non-root service users, so Admin UI restart actions work out-of-box.
- `npm install -g codeharbor@latest` now performs best-effort restart for active `codeharbor(.service)` units on Linux
  so upgrades take effect immediately (set `CODEHARBOR_SKIP_POSTINSTALL_RESTART=1` to disable).
- If your environment blocks interactive `sudo`, use explicit fallback:
  - `sudo <node-bin> <codeharbor-cli-script> service ...`

Enable Admin service at install time:

```bash
curl -fsSL https://raw.githubusercontent.com/biglone/CodeHarbor/main/scripts/install-linux-easy.sh | bash -s -- \
  --matrix-homeserver https://matrix.example.com \
  --matrix-user-id @bot:example.com \
  --matrix-access-token 'your-token' \
  --enable-admin-service \
  --admin-token 'replace-with-strong-token'
```

Run local script with custom options:

```bash
./scripts/install-linux.sh --app-dir /srv/codeharbor --package codeharbor@0.1.1 --init
```

Runtime home behavior:

- By default, all `codeharbor` commands use `~/.codeharbor` for `.env` and relative data paths.
- Backward compatibility: if `/opt/codeharbor/.env` already exists, it continues to be used automatically.
- No manual `cd` is required after installation.
- To use a custom runtime directory, set `CODEHARBOR_HOME` (for example `export CODEHARBOR_HOME=/srv/codeharbor`).

Install directly from GitHub:

```bash
npm install -g github:biglone/CodeHarbor
```

Build a local package tarball and install it:

```bash
npm pack
npm install -g ./codeharbor-<version>.tgz
```

## CLI Help Quick Reference

Show CLI help:

```bash
codeharbor --help
codeharbor admin --help
codeharbor config --help
codeharbor service --help
```

Common in-chat control commands:

- `/help` show command help
- `/status` show session status, version/update hint, latest upgrade result + recent upgrade ids + upgrade metrics/lock, and runtime metrics
- `/version` force-refresh latest version check
- `/diag version` show runtime version diagnostics (pid/start time/bin path/backend)
- `/diag media [count]` show multimodal diagnostics (image/audio counters + recent records)
- `/diag upgrade [count]` show upgrade diagnostics (distributed lock, aggregate stats, recent upgrade records)
- `/diag autodev [count]` show AutoDev workflow diagnostics (stage trace, status, last error)
- `/diag queue [count]` show recoverable queue diagnostics (pending/running/retry/failure archive)
- `/upgrade [version]` run self-update and auto-restart service from Matrix chat
  - auth priority: `MATRIX_UPGRADE_ALLOWED_USERS` > `MATRIX_ADMIN_USERS` > any DM user (when both empty)
  - supports hardened systemd (`NoNewPrivileges=true`) by using signal-based restart fallback
- `/backend codex|claude|status` switch or inspect active AI backend
- `/reset` clear current conversation context
- `/stop` cancel current running request

## GitHub CI/CD Publish

CodeHarbor supports auto publish to npm from GitHub Actions.

Setup once:

1. Configure npm Trusted Publishing for this repository/workflow (preferred):
   - npm package settings -> Trusted publishing -> Add publisher
   - Provider: GitHub Actions
   - Repository: `biglone/CodeHarbor`
   - Workflow file: `.github/workflows/release-npm.yml`
2. Optional fallback: set repository secret `NPM_TOKEN` (npm automation token).
3. Push to `main` with a publish trigger commit message.

Trigger rules:

- `push` to `main` + commit message includes `[publish-npm]` -> run publish workflow
- `push` to `main` + commit message includes both `release` and a semver version -> run publish workflow
  - examples: `release v0.1.1`, `chore: release 0.1.2`
- `workflow_dispatch` -> manual publish from GitHub Actions UI

The workflow runs `typecheck`, `test`, `test:e2e` (Admin UI Playwright), `build`, `node dist/cli.js --help`, `npm pack --dry-run`, then publishes with:

```bash
npm publish --provenance --access public
```

Auth mode selection:

- If `NPM_TOKEN` secret exists: publish with token.
- If `NPM_TOKEN` is absent: publish via npm Trusted Publishing (OIDC).

If the same package version already exists on npm, publish is skipped automatically.

Release checklist (recommended):

1. Update `CHANGELOG.md` with a new version section and bullet-point release notes.
2. Update version in `package.json` (`npm version patch|minor|major`).
3. Validate changelog entry:
   - `npm run changelog:check`
4. Push to `main` with `[publish-npm]` or `release vX.Y.Z` in commit message.
5. Verify workflow status in GitHub Actions.
6. Verify package on npm:

```bash
npm view codeharbor version
```

Run e2e locally:

```bash
npm run test:e2e
```

If your machine has no system Chrome, run:

```bash
PLAYWRIGHT_USE_SYSTEM_CHROME=false npm run e2e:install
PLAYWRIGHT_USE_SYSTEM_CHROME=false npm run test:e2e
```

## Planning Docs

- `REQUIREMENTS.md`: current baseline + next-stage requirements
- `TASK_LIST.md`: implementation task breakdown and status
- `docs/USER_MANUAL_ZH.md`: Chinese user manual (installation, configuration, verification)
- `docs/COMPLETE_CONFIGURATION_GUIDE.md`: end-to-end setup flow + full feature-to-config mapping
- `docs/CONFIG_UI_DESIGN.md`: configuration UI MVP design
- `docs/CONFIG_CATALOG.md`: consolidated configuration matrix (required/runtime/UI/effective timing)
- `docs/MULTIMODAL_VERIFICATION_ZH.md`: multimodal verification playbook (Codex/Claude image + audio transcription)
- `docs/GROWTH_PLAYBOOK_ZH.md`: growth and community feedback playbook
- `docs/SOCIAL_PREVIEW_UPLOAD_ZH.md`: GitHub social preview image upload guide
- `docs/DISCUSSION_TEMPLATE_BILINGUAL.md`: single-thread bilingual discussion template
- `docs/ADMIN_STANDALONE_DEPLOY.md`: standalone admin deployment and Cloudflare Tunnel exposure guide
- `docs/BACKUP_AUTOMATION.md`: scheduled config backup and restore operations
- `docs/RELEASE.md`: release process and CI/publish policy

## Quick Start

For local development from source:

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
export CODEHARBOR_HOME="$(pwd)"
codeharbor init
```

Required values:

- `MATRIX_HOMESERVER`
- `MATRIX_USER_ID`
- `MATRIX_ACCESS_TOKEN`

3. Run in dev mode:

```bash
export CODEHARBOR_HOME="$(pwd)"
npm run dev
```

4. Build and run as CLI:

```bash
npm run build
export CODEHARBOR_HOME="$(pwd)"
node dist/cli.js start
```

## Configuration Baseline

Use this layered reference to avoid mixing boot-only and runtime tuning items:

- [`docs/CONFIG_CATALOG.md`](docs/CONFIG_CATALOG.md)
- [`docs/COMPLETE_CONFIGURATION_GUIDE.md`](docs/COMPLETE_CONFIGURATION_GUIDE.md)
- [`docs/MULTIMODAL_VERIFICATION_ZH.md`](docs/MULTIMODAL_VERIFICATION_ZH.md)

It documents:

- which keys are required vs optional
- which keys can be edited in Admin UI
- whether changes are immediate or restart-scoped
- recommended profiles for local/internal/public deployment
- a complete setup sequence from install to production operations

## Commands

- `codeharbor init`: guided setup for `.env` (supports `--force` to overwrite directly)
- `codeharbor start`: start service
- `codeharbor doctor`: check AI CLI and Matrix connectivity
- `codeharbor admin serve`: start admin UI + config API server
- `codeharbor service install`: install/enable systemd unit(s) after npm install (supports `--with-admin`)
- `codeharbor service restart`: restart installed systemd unit(s) (supports `--with-admin`)
- `codeharbor service uninstall`: remove installed systemd unit(s) (supports `--with-admin`)
- `codeharbor config export`: export current config snapshot as JSON
- `codeharbor config import <file>`: import config snapshot JSON (supports `--dry-run`)
- `npm run changelog:check`: validate `CHANGELOG.md` has notes for current package version
- `scripts/install-linux.sh`: Linux bootstrap installer (creates runtime dir + installs npm package)
- `scripts/install-linux-easy.sh`: one-shot Linux install + config + systemd auto-start
- `scripts/backup-config.sh`: export timestamped snapshot and keep latest N backups
- `scripts/install-backup-timer.sh`: install/update user-level systemd timer for automatic backups
- `npm run test:e2e`: run Admin UI end-to-end tests (Playwright)

## Community and Feedback

- Questions and usage help: [GitHub Discussions](https://github.com/biglone/CodeHarbor/discussions) (`Q&A`)
- Feature ideas: [GitHub Discussions](https://github.com/biglone/CodeHarbor/discussions) (`Ideas`) or `Feature request` issue template
- Bug reports: use `Bug report` issue template for reproducible diagnostics
- Contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Growth and community playbook: [`docs/GROWTH_PLAYBOOK_ZH.md`](docs/GROWTH_PLAYBOOK_ZH.md)

### Config Backup Script

Create a timestamped snapshot in `backups/config` and keep latest 20 by default:

```bash
./scripts/backup-config.sh
```

Custom directory and retention:

```bash
./scripts/backup-config.sh --dir /var/backups/codeharbor --keep 30
```

Install/update automatic backup timer:

```bash
./scripts/install-backup-timer.sh --schedule "*-*-* 03:30:00" --dir /var/backups/codeharbor --keep 30
```

Full guide:

- [`docs/BACKUP_AUTOMATION.md`](docs/BACKUP_AUTOMATION.md)

## Admin UI And API

Start server:

```bash
codeharbor admin serve
```

Optional overrides:

```bash
codeharbor admin serve --host 127.0.0.1 --port 8787
```

If you bind Admin to a non-loopback host and both `ADMIN_TOKEN` and `ADMIN_TOKENS_JSON` are empty, startup is rejected by default.
Explicit bypass exists but is not recommended:

```bash
codeharbor admin serve --host 0.0.0.0 --allow-insecure-no-token
```

Open these UI routes in browser:

- `/` or `/settings/global`
- `/settings/rooms`
- `/health`
- `/audit`

`/health` now includes a CodeHarbor app row with current version, latest version, and update availability.

Main endpoints:

- `GET /metrics` (Prometheus exposition format)
- `GET /api/admin/auth/status`
- `GET /api/admin/config/global`
- `PUT /api/admin/config/global`
- `GET /api/admin/config/rooms`
- `GET /api/admin/config/rooms/:roomId`
- `PUT /api/admin/config/rooms/:roomId`
- `DELETE /api/admin/config/rooms/:roomId`
- `GET /api/admin/health`
- `GET /api/admin/audit?limit=50`

When `ADMIN_TOKEN` or `ADMIN_TOKENS_JSON` is set, requests must include:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

Access control options:

- `ADMIN_TOKEN`: require bearer token for `/api/admin/*` and `/metrics`
- `ADMIN_TOKENS_JSON`: optional multi-token RBAC list (supports `admin` and `viewer` roles)
- `ADMIN_IP_ALLOWLIST`: optional comma-separated client IP whitelist (for example `127.0.0.1,192.168.1.10`)
- `ADMIN_ALLOWED_ORIGINS`: optional CORS origin allowlist for browser-based cross-origin admin access

RBAC behavior:

- `viewer` tokens can call read endpoints (`GET /api/admin/*` and `GET /metrics`)
- `admin` tokens can call read + write endpoints (`PUT/POST/DELETE /api/admin/*`)
- for `ADMIN_TOKENS_JSON`, audit actor is derived from token identity (`actor` field), not `x-admin-actor`
- Admin UI shows current permission status (role/source) after saving auth

Metrics quick check:

```bash
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  http://127.0.0.1:8787/metrics
```

Alerting baseline:

- Example Prometheus alert rules: [`docs/PROMETHEUS_ALERT_RULES_EXAMPLE.yml`](docs/PROMETHEUS_ALERT_RULES_EXAMPLE.yml)
- Includes:
  - high request failure ratio
  - high queue wait p95
  - recent upgrade failure detection

Rotate tokens quickly (repository script):

```bash
./scripts/rotate-admin-token.sh --target rbac --role admin --actor ops-admin
./scripts/rotate-admin-token.sh --target rbac --role viewer --actor ops-audit
```

Note: `PUT /api/admin/config/global` writes to `.env` and marks changes as restart-required.

### Admin UI Quick Walkthrough

1. Start server: `codeharbor admin serve`.
2. Open `/settings/global`, set `Admin Token` (if enabled), then click `Save Auth`.
3. Adjust global fields and click `Save Global Config` (UI shows restart-required warning).
4. Use `Restart Main Service` or `Restart Main + Admin` buttons for one-click restart from Admin UI.
   If services were installed with `--with-admin`, restart permissions are auto-configured by installer.
5. Open `/settings/rooms`, fill `Room ID + Workdir`, then `Save Room`.
6. Open `/health` to run connectivity checks (`codex` + Matrix).
7. Open `/audit` to verify config revisions (actor/summary/payload).

## Standalone Admin Deployment

`codeharbor admin serve` can run as an independent service on target servers without browser/desktop.
Access can come from your local browser through a gateway (for example Cloudflare Tunnel).

See:

- [`docs/ADMIN_STANDALONE_DEPLOY.md`](docs/ADMIN_STANDALONE_DEPLOY.md)

## Startup Preflight

Before `codeharbor start` and `codeharbor doctor`, CodeHarbor runs a preflight check for:

- required Matrix env vars
- selected AI CLI binary availability (`AI_CLI_PROVIDER` + `CODEX_BIN`)
- `CODEX_WORKDIR` validity
- `.env` presence warning

If any check fails, it prints actionable fix commands (for example `codeharbor init`).

## Message Rules

- Direct Message (DM)
  - all text messages are processed by default (no prefix required)
- Group Room
  - when `GROUP_DIRECT_MODE_ENABLED=true`, all non-empty messages are processed directly (no prefix/mention/reply required)
  - processed when **any allowed trigger** matches:
    - message mentions bot user id
    - message replies to a bot message
    - sender has an active conversation window
    - optional explicit prefix match (`MATRIX_COMMAND_PREFIX`)
- Trigger Policy
  - `GROUP_DIRECT_MODE_ENABLED` controls whether groups bypass trigger matching entirely
  - global defaults via `GROUP_TRIGGER_ALLOW_*`
  - per-room overrides via `ROOM_TRIGGER_POLICY_JSON`
- Active Conversation Window
  - each accepted request activates the sender's conversation in that room
  - activation TTL: `SESSION_ACTIVE_WINDOW_MINUTES` (default: `20`)
- Control commands
  - `/help` show command cheat sheet for in-chat controls
  - `/status` show session + limiter + metrics + runtime worker status, current version, update hint, latest upgrade result, recent upgrade ids, upgrade metrics/lock, and update checked time (cached by TTL)
  - `/version` show current package version and latest-update hint (force refresh)
  - `/diag version` show runtime diagnostics (pid/start time/binary path/backend)
  - `/diag media [count]` show multimodal diagnostics (image/audio counters + recent records)
  - `/diag upgrade [count]` show distributed lock + aggregate stats + recent upgrade run diagnostics
  - `/diag autodev [count]` show AutoDev diagnostics (stage trace + status + error summary)
  - `/diag queue [count]` show queue diagnostics (counts + pending sessions + failure archive)
  - `/upgrade [version]` install latest (or specified) npm version and trigger service restart (DM only)
    - auth priority: `MATRIX_UPGRADE_ALLOWED_USERS` > `MATRIX_ADMIN_USERS` > any DM user (when both empty)
    - includes service-context signal restart fallback when sudo escalation is unavailable
  - `/backend codex|claude|status` switch backend AI CLI tool at runtime (next request auto-bridges recent local history)
  - `/reset` clear bound Codex session and keep conversation active
  - `/stop` cancel in-flight execution (if running) and reset session context
  - `/agents status` show multi-agent workflow status for current session (when enabled)
  - `/agents run <objective>` run Planner -> Executor -> Reviewer workflow (when enabled)
  - `/autodev status` show AutoDev doc/task summary + run snapshot (when enabled)
  - `/autodev run [taskId]` auto-pick pending task (or run specified task) from `TASK_LIST.md` (when enabled)

Version update check controls:

- `PACKAGE_UPDATE_CHECK_ENABLED=true|false`
  - enable/disable npm latest-version check used by `/status`, `/version`, and Admin health app row
- `PACKAGE_UPDATE_CHECK_TIMEOUT_MS=3000`
  - timeout (ms) for npm registry version lookup
- `PACKAGE_UPDATE_CHECK_TTL_MS=21600000`
  - cache TTL (ms) for update-check results (`/status` reads cache; `/version` forces refresh)
- `MATRIX_ADMIN_USERS=@admin:example.com,@ops:example.com`
  - optional Matrix admin list used as `/upgrade` permission fallback when `MATRIX_UPGRADE_ALLOWED_USERS` is empty
- `MATRIX_UPGRADE_ALLOWED_USERS=@admin:example.com,@ops:example.com`
  - optional explicit `/upgrade` allowlist (higher priority than `MATRIX_ADMIN_USERS`)

CLI update helper:

- `codeharbor self-update`
  - install latest npm package and attempt auto-restart for installed systemd service

AI CLI backend controls:

- `AI_CLI_PROVIDER=codex|claude`
  - select runtime backend (`codex` by default)
- `CODEX_BIN=<path-or-command>`
  - executable for selected provider (for example `codex` or `claude`)
- `CODEX_MODEL=<model>`
  - optional model override for selected provider
- `CODEX_EXEC_TIMEOUT_MS`
  - base timeout for one backend execution (default `600000`)
  - `/agents` and `/autodev` use `max(CODEX_EXEC_TIMEOUT_MS, 1800000)` per role to reduce long-task timeout loops

Cross-backend context bridge behavior:

- CodeHarbor stores recent local `user/assistant` turns per Matrix session.
- After `/backend codex|claude`, the next non-command request injects a `[conversation_bridge]` block so the new backend can continue with recent context.
- `/reset` and `/stop` explicitly suppress this one-shot bridge on the immediate next request so users can start fresh.

### Multi-Agent Workflow (Phase B, Opt-In)

- `AGENT_WORKFLOW_ENABLED=true`
  - enable `/agents` and `/autodev` workflow commands
- `AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS`
  - reviewer reject loop upper bound (default `1`)

AutoDev (`/autodev`) conventions:

- Workspace must contain `REQUIREMENTS.md` and `TASK_LIST.md`.
- `TASK_LIST.md` should include task IDs and status markers (`⬜`, `🔄`, `✅`, `❌`, `🚫`) in table rows or checklist rows.
- `/autodev run` selects `🔄` task first, then `⬜` task.
- When reviewer verdict is `APPROVED`, CodeHarbor updates the task status to `✅` automatically.
- When reviewer verdict is `APPROVED` and the workdir is a clean Git repo, CodeHarbor auto-commits changes with `chore(autodev): complete <taskId>`.
- If the repo is missing or already dirty before run, AutoDev skips commit and reports the reason in the result notice.
- When using `scripts/autodev-loop-runner.sh`, a new trigger is skipped while any task is already `🔄` in progress.

Default is disabled to keep legacy behavior unchanged.

## CLI Compatibility Mode

To make IM behavior closer to local `codex` CLI interaction, enable:

- `CLI_COMPAT_MODE=true`
  - preserve user prompt whitespace
  - avoid stripping `@bot` mention text in prompt body
  - enable richer raw event passthrough summaries
- `CLI_COMPAT_PASSTHROUGH_EVENTS=true`
  - emit raw event summaries from codex JSON stream
- `CLI_COMPAT_PRESERVE_WHITESPACE=true`
  - keep incoming Matrix message body untrimmed for execution
- `CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT=true|false`
  - optionally send one full message chunk to Matrix without auto split
- `CLI_COMPAT_PROGRESS_THROTTLE_MS`
  - lower update throttle for near-real-time progress
- `CLI_COMPAT_FETCH_MEDIA=true|false`
  - download Matrix `mxc://` media (image) to temp file and pass image context to backend
- `CLI_COMPAT_IMAGE_MAX_BYTES`
  - per-image max size guard (bytes), oversized images are skipped with user notice
- `CLI_COMPAT_IMAGE_MAX_COUNT`
  - max number of images passed to backend in one request
- `CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES`
  - comma-separated image MIME allowlist (`image/png,image/jpeg,...`)
- `CLI_COMPAT_TRANSCRIBE_AUDIO=true|false`
  - download Matrix `m.audio` attachments and transcribe them into prompt context
- `CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL`
  - OpenAI transcription model (default `gpt-4o-mini-transcribe`)
- `CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS`
  - timeout for each audio transcription request
- `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS`
  - max transcript length appended to prompt for one attachment
- `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES`
  - retry count for local/OpenAI transcription failures (default `1`)
- `CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS`
  - base retry delay between attempts
- `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES`
  - skip transcription when attachment is larger than this size
- `CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND`
  - optional local whisper command template (use `{input}` placeholder for audio file path)
  - helper command shipped by package: `codeharbor-whisper-transcribe --input {input} --model small`
- `CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS`
  - timeout for local whisper command execution
- `CLI_COMPAT_RECORD_PATH=/abs/path/records.jsonl`
  - append executed prompts as JSONL for replay benchmarking

Note: execution still uses `codex exec/resume` per request; compatibility mode focuses on behavior parity and reduced middleware interference.

## Persistence

- `STATE_DB_PATH=data/state.db`
  - SQLite store for sessions + processed event ids
- `STATE_PATH=data/state.json`
  - legacy JSON source for one-time migration import when SQLite is empty
- `MAX_SESSION_AGE_DAYS=30`
  - prune stale sessions by age
- `MAX_SESSIONS=5000`
  - prune least-recently-updated sessions when over limit

## Rate Limiting

- `RATE_LIMIT_WINDOW_SECONDS`
- `RATE_LIMIT_MAX_REQUESTS_PER_USER`
- `RATE_LIMIT_MAX_REQUESTS_PER_ROOM`
- `RATE_LIMIT_MAX_CONCURRENT_GLOBAL`
- `RATE_LIMIT_MAX_CONCURRENT_PER_USER`
- `RATE_LIMIT_MAX_CONCURRENT_PER_ROOM`

Set a value to `0` to disable a specific limiter.

## Codex CLI Alignment

Use these to align runtime with your terminal CLI profile:

- `CODEX_SANDBOX_MODE`
- `CODEX_APPROVAL_POLICY`
- `CODEX_EXTRA_ARGS`
- `CODEX_EXTRA_ENV_JSON`

When image attachments are present and `CLI_COMPAT_FETCH_MEDIA=true`, CodeHarbor will:

1. download `mxc://` media to a temp file
2. apply image policy guardrails (`CLI_COMPAT_IMAGE_MAX_BYTES`, `CLI_COMPAT_IMAGE_MAX_COUNT`, `CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES`)
3. for Codex backend, pass local file paths as `--image`
4. for Claude backend, use stream-json input with base64 image blocks
5. if Claude image input fails, auto-retry once without image blocks and notify user
6. best-effort cleanup temp files after the request
7. optional prompt record append (`CLI_COMPAT_RECORD_PATH`) for deterministic replay input

When audio attachments are present and both `CLI_COMPAT_FETCH_MEDIA=true` and `CLI_COMPAT_TRANSCRIBE_AUDIO=true`, CodeHarbor will:

1. download `m.audio` media to a temp file
2. skip oversized audio files based on `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES`
3. if `CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND` is configured, execute local whisper first
4. if local whisper fails and `OPENAI_API_KEY` is available, fallback to OpenAI transcription API
5. retry transient failures using `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES`
6. append transcript to `[audio_transcripts]` prompt block
7. continue request even if transcription fails (warn log + no transcript)
8. best-effort cleanup temp files after the request

`OPENAI_API_KEY` is optional when local whisper command is configured, and required only for OpenAI fallback.
For `codeharbor-whisper-transcribe`, install runtime first: `python3 -m pip install faster-whisper`.

## Replay Benchmark

Replay recorded prompts directly against codex CLI to quantify drift and latency:

```bash
npm run replay:cli-compat -- --input data/cli-compat-record.jsonl --out data/replay-report.json --max 50
```

Useful flags:

- `--model <name>`
- `--workdir <path>`
- `--timeout-ms <n>`
- `--sandbox <mode>`
- `--approval <policy>`
- `--dangerous`

## Progress + Output

- `MATRIX_PROGRESS_UPDATES=true`
  - emit stage progress updates (for example reasoning/thinking snippets)
- `MATRIX_PROGRESS_MIN_INTERVAL_MS=2500`
  - minimum interval between progress updates
- `MATRIX_TYPING_TIMEOUT_MS=10000`
  - typing indicator timeout; CodeHarbor refreshes typing state while handling a request
- Group rooms use notice edit (`m.replace`) to coalesce progress and reduce spam.
- Reply chunking is paragraph/code-block aware to avoid cutting fenced blocks when possible.

## Tests

```bash
npm run typecheck
npm test
npm run build
npm run test:legacy
```

If Python legacy dependencies are missing, install them first:

```bash
python3 -m pip install -r requirements.txt
```

## Legacy Runtime

- Legacy Python runtime exists in `app/` and `tests/`.
- It is not part of default release/CI gates.
- Use `npm run test:legacy` for optional regression checks.
