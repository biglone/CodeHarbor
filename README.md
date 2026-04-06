# CodeHarbor

CodeHarbor is a self-hosted Matrix bot and AI chat bridge for `codex`, `claude`, and `gemini` CLI.
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
- Runtime backend switch: `/backend codex|claude|gemini [model] | /backend auto|status`
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
Matrix Room -> MatrixChannel -> Orchestrator -> AI CLI Executor (codex/claude/gemini)
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
  - Gemini CLI: `gemini`
- A Matrix bot user + access token

## Install

Install globally from npm (after publish):

```bash
npm install -g codeharbor
```

Recommended npm package lifecycle (install/upgrade/verify):

```bash
# install latest
npm install -g codeharbor@latest

# verify installed version
codeharbor --version

# upgrade helper (installs latest + restart strategy)
codeharbor self-update
```

Systemd multi-instance example (Linux):

```bash
codeharbor service install --instance bot-a --runtime-home /srv/codeharbor-bot-a --with-admin
codeharbor service install --instance bot-b --runtime-home /srv/codeharbor-bot-b --with-admin
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
- `npm install -g codeharbor@latest` now performs best-effort restart per platform:
  - Linux: active `codeharbor*.service` systemd units (including multi-instance units)
  - macOS: configured launchd labels (`CODEHARBOR_LAUNCHD_MAIN_LABEL`, `CODEHARBOR_LAUNCHD_ADMIN_LABEL`)
  - Windows: safe fallback (prints manual PowerShell restart commands)
  - set `CODEHARBOR_SKIP_POSTINSTALL_RESTART=1` to disable postinstall restart attempts.
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
- if Matrix client intercepts slash commands, use escaped `//...` form for all slash controls (for example `//status`, `//version`, `//diag queue 5`, `//upgrade`, `//autodev init StrawBerry`, `//autodev run T6.2`)
- `/status` show session status, version/update hint, latest upgrade result + recent upgrade ids + upgrade metrics/lock, and runtime metrics
- `/version` force-refresh latest version check
- `/diag version` show runtime version diagnostics (pid/start time/bin path/backend)
- `/diag media [count]` show multimodal diagnostics (image/audio counters + recent records)
- `/diag upgrade [count]` show upgrade diagnostics (distributed lock, aggregate stats, recent upgrade records)
- `/diag route [count]` show backend routing diagnostics (rule hit/fallback reason + recent route records)
- `/diag autodev [count]` show AutoDev diagnostics (stage trace, live loop snapshot, and recent git commit records)
- `/diag queue [count]` show recoverable queue diagnostics (pending/running/retry/failure archive)
- `/trace <requestId|latest>` show one-request trace (prompt/progress/reply + related workflow/media events; `latest` resolves the newest request in current session)
- Chat final reply includes `requestId` footer so you can copy it directly for `/trace`.
  - access is restricted to the same session sender or Matrix admin user
- `/upgrade [version]` run self-update and auto-restart service from Matrix DM only
  - auth priority: `MATRIX_UPGRADE_ALLOWED_USERS` > `MATRIX_ADMIN_USERS` > any DM user (when both empty)
  - supports Linux systemd signal restart fallback, macOS launchd/manual fallback, and Windows safe manual fallback
  - emits structured success/failure summary with rollback and restart command templates
- `/backend codex|claude|gemini [model] | /backend auto|status` switch or inspect active AI backend (`auto` restores rule-based routing)
- `/reset` clear current conversation context and suppress one-shot history bridge on the next request
- `/stop` cancel current running request (or queue the stop), clear session context, and drop pending queued tasks for this session
  - aliases: `/cancel`, `/esc`, `/撤回`, `/撤销`

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

If the same package version already exists on npm, publish is skipped automatically and the workflow prints a suggested next patch version.

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

If release CI fails before npm publish, keep the same version and retry publish after fixing CI.
Do not skip to the next version number.

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
- hot-update rollback paths (quick hot rollback vs full snapshot rollback)
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
- `/settings/bots`
- `/settings/rooms`
- `/health`
- `/audit`

`/health` now includes a CodeHarbor app row with current version, latest version, and update availability.

Main endpoints:

- `GET /metrics` (Prometheus exposition format)
- `GET /api/admin/auth/status`
- `GET /api/admin/config/global`
- `GET /api/admin/config/skills`
- `PUT /api/admin/config/global`
- `GET /api/admin/config/rooms`
- `GET /api/admin/config/rooms/:roomId`
- `PUT /api/admin/config/rooms/:roomId`
- `DELETE /api/admin/config/rooms/:roomId`
- `GET /api/admin/bot-profiles`
- `PUT /api/admin/bot-profiles`
- `POST /api/admin/bot-profiles/migrate` (single-instance -> primary-bot migration, supports `dryRun`, `force`, `profileId`)
- `POST /api/admin/bot-profiles/apply` (supports `dryRun`, `includeDisabled`, `instanceIds`, `retireDefaultSingleInstance`)
- `GET /api/admin/health`
- `GET /api/admin/audit?limit=50&kind=config|operations|all&surface=admin|api|webhook&outcome=allowed|denied|error&actor=...&source=...&action=...&method=GET&pathPrefix=/api/...&reasonContains=...&createdFrom=...&createdTo=...`
- `GET /api/admin/sessions?roomId=...&userId=...&from=...&to=...&limit=50&offset=0`
- `GET /api/admin/sessions/export?roomId=...&userId=...&from=...&to=...&limit=50&offset=0&includeMessages=true`
- `GET /api/admin/sessions/:sessionKey/messages?limit=100`
- `GET /api/admin/history/retention`
- `PUT /api/admin/history/retention`
- `POST /api/admin/history/cleanup`
- `GET /api/admin/history/cleanup/runs?limit=20`

`GET /api/admin/config/skills` returns a read-only snapshot for role-skill management:

- effective `agentWorkflow.roleSkills` config
- `catalog.availableSkills` (builtin + discovered local skills)
- `catalog.missingAssignments` (per-role unresolved skill ids)

When `ADMIN_TOKEN` or `ADMIN_TOKENS_JSON` is set, requests must include:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

Access control options:

- `ADMIN_TOKEN`: require bearer token for `/api/admin/*` and `/metrics`
- `ADMIN_TOKENS_JSON`: optional multi-token RBAC list (supports `admin`/`viewer` role defaults and custom `scopes`)
- `API_TOKEN_SCOPES_JSON`: optional API token scope override (JSON array, for example `["tasks.submit.api"]` or `["tasks.read.api"]`)
- `ADMIN_IP_ALLOWLIST`: optional comma-separated client IP whitelist (for example `127.0.0.1,192.168.1.10`)
- `ADMIN_ALLOWED_ORIGINS`: optional CORS origin allowlist for browser-based cross-origin admin access
- `EXTERNAL_INTEGRATION_*`: optional outbound callback config for API/webhook lifecycle + ticket sync (`queued/executing/retrying/completed/failed`)

RBAC behavior:

- `viewer` role defaults: `admin.read` + `metrics.read` (broad read compatibility)
- `admin` role defaults: `admin.read` + `metrics.read` + `admin.write`
- optional `scopes` in `ADMIN_TOKENS_JSON` overrides role defaults for that token (supports patterns like `admin.read.audit`, `admin.write.config.*`, `*`)
- API token defaults to broad compatibility scopes `tasks.submit` + `tasks.read`; `API_TOKEN_SCOPES_JSON` can narrow it to submit-only/read-only
- legacy broad scopes (`admin.read`, `admin.write`, `tasks.submit`, `tasks.read`, `webhook.ingest`) still authorize new fine-grained actions for backward compatibility
- for `ADMIN_TOKENS_JSON`, audit actor is derived from token identity (`actor` field), not `x-admin-actor`
- Admin UI shows current permission status (role/source) after saving auth

External integration callbacks:

- inbound `POST /api/webhooks/ci|ticket` requests are normalized into `externalContext` and persisted into queue payloads
- when `EXTERNAL_INTEGRATION_ENABLED=true`, CodeHarbor emits non-blocking lifecycle callbacks with short-timeout retries (`EXTERNAL_NOTIFY_WEBHOOK_URL`)
- optional ticket callback (`EXTERNAL_TICKET_WEBHOOK_URL`) is emitted only for ticket-source tasks
- delivery failures never block task execution; outcomes are written into operation audit logs (`source=integration:notify|ticket`)

Operation audit behavior:

- `kind=config` (default): configuration revision audit entries
- `kind=operations`: authorization and operation outcomes for Admin/API/Webhook (`allowed`/`denied`/`error`)
- `kind=all`: merged timeline of config + operation audit entries (sorted by latest first)
- operation entries support additional filters: `actor`, `source`, `action`, `method`, `pathPrefix`, `reasonContains`, `createdFrom`, `createdTo`

Metrics quick check:

```bash
curl -H "Authorization: Bearer <ADMIN_TOKEN>" \
  http://127.0.0.1:8787/metrics
```

AutoDev metrics exported:

- `codeharbor_autodev_runs_total{outcome="succeeded|failed|cancelled"}`
- `codeharbor_autodev_loop_stops_total{reason="no_task|drained|max_runs|deadline|stop_requested|task_incomplete"}`
- `codeharbor_autodev_tasks_blocked_total`

Alerting baseline:

- Example Prometheus alert rules: [`docs/PROMETHEUS_ALERT_RULES_EXAMPLE.yml`](docs/PROMETHEUS_ALERT_RULES_EXAMPLE.yml)
- Includes:
  - high request failure ratio
  - high queue wait p95
  - recent upgrade failure detection
  - AutoDev loop stop/block anomaly signals

Rotate tokens quickly (repository script):

```bash
./scripts/rotate-admin-token.sh --target rbac --role admin --actor ops-admin
./scripts/rotate-admin-token.sh --target rbac --role viewer --actor ops-audit
./scripts/rotate-admin-token.sh --target rbac --role viewer --actor ops-audit --scopes admin.read.auth,admin.read.audit
```

Note: `PUT /api/admin/config/global` always writes `.env`; high-frequency whitelist keys hot-apply for new requests, while non-whitelist keys still require restart.

### Hot Update Rollback

1. Backup before change:

```bash
codeharbor config export -o backups/pre-hot-update.json
```

2. Fast rollback for hot-whitelist keys (`restartRequired=false`):
- write previous value back via Admin UI, or call `PUT /api/admin/config/global`
- confirm response `hotAppliedKeys` contains expected key(s)

3. Full rollback for mixed/restart-required changes:

```bash
codeharbor config import backups/pre-hot-update.json --dry-run
codeharbor config import backups/pre-hot-update.json
codeharbor service restart
```

4. Verify + audit:
- `GET /api/admin/audit?limit=20`
- `GET /api/admin/health`
- send one Matrix smoke request in each critical room

Boundary: hot updates affect new requests only; in-flight requests are not rolled back.

### Admin UI Quick Walkthrough

1. Start server: `codeharbor admin serve`.
2. Open `/settings/global`, set `Admin Token` (if enabled), then click `Save Auth`.
3. Open `Global Settings -> Skills & Advanced`:
   - click `Refresh SKILL catalog` to review builtin/local skill IDs
   - check `Missing SKILL` hint before saving role assignments
4. Adjust global fields and click `Save Global Config` (UI shows restart-required warning).
5. Use `Restart Main Service` or `Restart Main + Admin` buttons for one-click restart from Admin UI.
   If services were installed with `--with-admin`, restart permissions are auto-configured by installer.
6. Open `/settings/rooms`, fill `Room ID + Workdir`, then `Save Room`.
7. Open `/health` to run connectivity checks (`codex` + Matrix).
8. Open `/audit` to verify config revisions (actor/summary/payload).

### Primary Bot Governance (Multi-Instance)

Recommended role split in group rooms:

- `main-hub`: primary bot (`isPrimary=true`), can enable `groupDirectModeEnabled=true` for non-@ group messages.
- `dev-main` / `review-guard`: execution/review bots (`isPrimary=false`), keep group direct mode disabled to avoid cross-talk.

Migration from legacy single-instance:

1. Open `/settings/bots`.
2. Click `Migration Dry-Run` (`POST /api/admin/bot-profiles/migrate` with `dryRun=true`).
3. Click `Migrate As Primary`, then `Apply Changes`.
4. Optional: enable `Retire default single-instance services` to disable `codeharbor.service` / `codeharbor-admin.service`.

Safety boundaries:

- `groupDirectModeEnabled` is rejected on non-primary profiles.
- Direct mode requires an enabled primary profile (`isPrimary=true` + `enabled=true`).
- Migration returns actionable errors for conflicting primaries; use `force=true` only when switching ownership intentionally.

Troubleshooting quick checks:

- Error `groupDirectModeEnabled requires an enabled primary profile`:
Set one profile to `isPrimary=true` and `enabled=true`, or disable direct mode.
- Migration blocked by existing primary:
Use another `profileId` or rerun migration with `force=true` after confirming primary ownership switch.
- Group messages no longer trigger without @:
Verify primary profile has `groupDirectModeEnabled=true` and profile changes were applied.

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
  - if Matrix intercepts `/...`, use escaped `//...` command form for all slash controls (for example `//status`, `//version`, `//diag queue 5`, `//trace req-123`, `//trace latest`, `//upgrade`, `//autodev init StrawBerry`, `//autodev run T6.2`)
  - `/status` show session + limiter + metrics + runtime worker status, current version, update hint, latest upgrade result, recent upgrade ids, upgrade metrics/lock, and update checked time (cached by TTL)
  - `/version` show current package version and latest-update hint (force refresh)
  - `/diag version` show runtime diagnostics (pid/start time/binary path/backend)
  - `/diag media [count]` show multimodal diagnostics (image/audio counters + recent records)
  - `/diag upgrade [count]` show distributed lock + aggregate stats + recent upgrade run diagnostics
  - `/diag route [count]` show backend routing diagnostics (rule hit + fallback reason + recent route records)
  - `/diag autodev [count]` show AutoDev diagnostics (stage trace + loop status + recent git commit records + error summary)
  - `/diag queue [count]` show queue diagnostics (counts + pending sessions + failure archive)
  - `/trace <requestId|latest>` show per-request trace (prompt/progress/reply + related workflow/media events; same-session sender/admin only; `latest` = current session latest)
  - `/upgrade [version]` install latest (or specified) npm version and trigger service restart (DM only)
    - auth priority: `MATRIX_UPGRADE_ALLOWED_USERS` > `MATRIX_ADMIN_USERS` > any DM user (when both empty)
    - includes service-context signal restart fallback when sudo escalation is unavailable
  - `/backend codex|claude|gemini [model] | /backend auto|status` switch backend AI CLI tool at runtime (`auto` restores rule routing; next request auto-bridges recent local history)
  - `/reset` clear bound Codex session, keep conversation active, and suppress one-shot history bridge on the next request
  - `/stop` cancel in-flight execution (or queue a pending stop when busy), reset session context, and clear pending queue tasks for current session
    - aliases: `/cancel`, `/esc`, `/撤回`, `/撤销`
  - `/agents status` show multi-agent workflow status for current session (when enabled)
  - `/agents run <objective>` run Planner -> Executor -> Reviewer workflow (when enabled)
  - `/autodev status` show AutoDev doc/task summary + currentTask/nextTask + run snapshot (when enabled)
  - `/autodev run [taskId]` auto-pick pending task (or run specified task) from `TASK_LIST.md` (when enabled)
  - `/autodev stop` graceful loop stop: finish current task, then stop before next task
  - `/autodev reconcile` reconcile `TASK_LIST.md` task states from recent AutoDev run records
  - `/autodev workdir|wd [path]|status|clear` show/set/clear AutoDev workdir override for current session
  - `/autodev init|i [path] [--from file]` initialize `REQUIREMENTS.md` + `TASK_LIST.md` + `docs/AUTODEV_TASK_COMPASS.md` in target project
    - short mobile-friendly flow: `//autodev init StrawBerry` -> `//autodev run`
    - omit `--from` to auto-discover design/spec docs in project; use `--from` to force one source file
  - `/autodev skills [on|off|summary|progressive|full|status]` control role-skill injection and disclosure mode per session

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
- `CODEHARBOR_LAUNCHD_MAIN_LABEL=com.codeharbor.main`
- `CODEHARBOR_LAUNCHD_ADMIN_LABEL=com.codeharbor.admin`
  - optional launchd labels used by macOS upgrade/postinstall restart flow

CLI update helper:

- `codeharbor self-update`
  - install latest npm package and run cross-platform restart strategy (Linux systemd / macOS launchd / Windows manual fallback)
  - prints structured result summary with rollback + restart command templates for failure recovery

AI CLI backend controls:

- `AI_CLI_PROVIDER=codex|claude|gemini`
  - select runtime backend (`codex` by default)
- `CODEX_BIN=<path-or-command>`
  - executable for selected provider (for example `codex` / `claude` / `gemini`)
- `CODEX_MODEL=<model>`
  - optional model override for selected provider
- `CODEX_EXEC_TIMEOUT_MS`
  - base timeout for one backend execution (default `600000`)
  - `/agents` and `/autodev` use `max(CODEX_EXEC_TIMEOUT_MS, 1800000)` per role to reduce long-task timeout loops

Cross-backend context bridge behavior:

- CodeHarbor stores recent local `user/assistant` turns per Matrix session.
- After `/backend codex|claude|gemini [model]` or `/backend auto`, the next non-command request injects a `[conversation_bridge]` block so the new backend can continue with recent context.
- `/reset` and `/stop` explicitly suppress this one-shot bridge on the immediate next request so users can start fresh.
- `CONTEXT_BRIDGE_HISTORY_LIMIT` controls how many recent local turns are considered for bridge assembly.
- `CONTEXT_BRIDGE_MAX_CHARS` controls the max bridge payload length (characters).

Backend/model rule routing:

- `BACKEND_MODEL_ROUTING_RULES_JSON`
  - optional JSON array rule engine for automatic backend/model selection per request
  - conditions support `roomIds` / `senderIds` / `taskTypes` / `directMessage` / `textIncludes` / `textRegex`
  - targets support `provider` (`codex|claude|gemini`) and/or `model`; rules are evaluated by `priority` (high -> low), then declaration order
  - when rule target cannot be instantiated (for example no `executorFactory` runtime), CodeHarbor falls back to default backend and marks status reason as `factory_unavailable`

### Multi-Agent Workflow (Phase B, Opt-In)

- `AGENT_WORKFLOW_ENABLED=true`
  - enable `/agents` and `/autodev` workflow commands
- `AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS`
  - reviewer reject loop upper bound (default `1`)
- `AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS`
  - optional planner-plan context char budget per role prompt (default: unlimited / no truncation)
- `AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS`
  - optional executor/reviewer output context char budget per role prompt (default: unlimited / no truncation)
- `AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS`
  - optional reviewer feedback context char budget per repair prompt (default: unlimited / no truncation)
- `AGENT_WORKFLOW_ROLE_SKILLS_ENABLED=true|false`
  - enable/disable Planner/Executor/Reviewer role-skill prompt injection (default `true`)
- `AGENT_WORKFLOW_ROLE_SKILLS_MODE=summary|progressive|full`
  - role-skill disclosure mode (`progressive` default: summary first round, full in later rounds/repair)
- `AGENT_WORKFLOW_ROLE_SKILLS_MAX_CHARS`
  - max chars for injected `[role_skills]` block (default `2400`)
- `AGENT_WORKFLOW_ROLE_SKILLS_ROOTS`
  - optional comma-separated local skill roots (default `~/.codex/skills`)
- `AGENT_WORKFLOW_ROLE_SKILLS_ASSIGNMENTS_JSON`
  - optional role-to-skill mapping override JSON (`planner`/`executor`/`reviewer` -> `string[]`)
  - defaults map to install-ready builtin fallback skills; local skills with the same id override builtin entries automatically
  - builtin fallback skill prompts are maintained in English for consistent global defaults
  - default builtin assignment baseline:
    - planner: `task-planner`, `requirements-doc`, `builtin-planner-core`, `dependency-analyzer`
    - executor: `autonomous-dev`, `bug-finder`, `test-generator`, `builtin-executor-core`, `refactoring`
    - reviewer: `code-reviewer`, `security-audit`, `builtin-reviewer-core`, `changelog-generator`, `commit-message`
  - additional builtin fallbacks are also available for assignment override:
    - planning/design: `api-designer`, `superpowers-workflow`, `brainstorming`, `planning-with-files`
    - execution/testing: `performance-optimizer`, `auto-code-pipeline`, `migration-helper`, `tdd-workflow`, `webapp-testing`, `ui-ux-pro-max`, `pptx`, `ralph-loop`
    - review/release: `commit-message`, `code-simplifier`, `multi-agent-code-review`
- `AUTODEV_LOOP_MAX_RUNS`
  - max task attempts for one `/autodev run` loop execution (default `20`, `0` = unlimited)
- `AUTODEV_LOOP_MAX_MINUTES`
  - max wall-clock minutes for one `/autodev run` loop execution (default `120`, `0` = unlimited)
- `AUTODEV_AUTO_COMMIT=true|false`
  - enable/disable AutoDev git auto-commit after reviewer `APPROVED` (default `true`)
- `AUTODEV_GIT_AUTHOR_NAME`
  - git author name for AutoDev auto-commit/release commit (default `CodeHarbor AutoDev`; empty falls back to default)
- `AUTODEV_GIT_AUTHOR_EMAIL`
  - git author email for AutoDev auto-commit/release commit (default `autodev@codeharbor.local`; empty falls back to default)
- `AUTODEV_AUTO_RELEASE_ENABLED=true|false`
  - enable/disable AutoDev "big feature done -> release commit" flow (default `true`)
- `AUTODEV_AUTO_RELEASE_PUSH=true|false`
  - push release commit automatically after local release commit (default `false`)
- `AUTODEV_RUN_ARCHIVE_ENABLED=true|false`
  - persist each `/autodev run` execution archive as local JSON (default `true`)
- `AUTODEV_RUN_ARCHIVE_DIR`
  - archive directory (relative to workdir or absolute path, default `.codeharbor/autodev-runs`)
- `AUTODEV_STAGE_OUTPUT_ECHO_ENABLED=true|false`
  - echo planner/executor/reviewer full stage output to Matrix during `/autodev run` (default `true`)
- `AUTODEV_PREFLIGHT_AUTO_STASH=true|false`
  - when git preflight detects a dirty worktree, auto-stash (`git stash --include-untracked`) and continue run (default `false`)
- `AUTODEV_MAX_CONSECUTIVE_FAILURES`
  - when the same task fails repeatedly and reaches this threshold, mark it `🚫` blocked (default `3`)
- `AUTODEV_VALIDATION_STRICT=true|false`
  - fail closed on validation gate when structured evidence is missing (`VALIDATION_STATUS`/`__EXIT_CODES__`); default `false`

AutoDev (`/autodev`) conventions:

- Architecture, control-chain, and troubleshooting handbook: `docs/AUTODEV_OPERATIONS_ZH.md`.
- Workspace must contain `REQUIREMENTS.md` and `TASK_LIST.md`.
- `/autodev init|i [path] [--from file]` scaffolds missing AutoDev files and binds workdir override for current session.
  - when `--from` is omitted, CodeHarbor auto-discovers design/spec docs and uses them to generate initial REQUIREMENTS/TASK_LIST templates.
  - init uses a 3-stage flow: Stage-A deterministic scaffold, Stage-B AI enhancement, Stage-C hard validation with fallback to Stage-A baseline on invalid output.
  - Stage-B AI enhancement runs only when both `REQUIREMENTS.md` and `TASK_LIST.md` were generated in this init run (existing files are preserved).
  - if `path` is a project name (no `/`), CodeHarbor resolves both `<room_workdir>/<name>` and sibling `<parent>/<name>`.
  - when target path is missing/not-directory, init fails explicitly and keeps current workdir unchanged.
- `/autodev workdir|wd [path]|status|clear` inspects or changes session-level workdir override.
- `TASK_LIST.md` should include task IDs and status markers (`⬜`, `🔄`, `✅`, `❌`, `🚫`) in table rows or checklist rows.
- `TASK_LIST.md` task status is system-managed by orchestrator; avoid manual edits and use `/autodev reconcile` when drift needs healing.
- `/autodev run` (without task id) loops through task list: selects `🔄` first, then `⬜`, and keeps running until no executable task remains.
- `/autodev run` loop is guarded by `AUTODEV_LOOP_MAX_RUNS` and `AUTODEV_LOOP_MAX_MINUTES`; reaching either limit pauses safely with a summary notice, and you can resume with `/autodev run`.
- `/autodev run <taskId>` runs only the specified task.
- `/autodev stop` does not interrupt the current task; it stops loop scheduling after the current task completes.
- `/autodev reconcile` performs one-shot task-state reconciliation using recent AutoDev run records (useful after manual edits or interrupted sessions).
- Loop guardrail rules:
  - `AUTODEV_LOOP_MAX_RUNS=0` means unlimited loop rounds.
  - `AUTODEV_LOOP_MAX_MINUTES=0` means unlimited loop wall-clock time.
  - Hitting run/time limit is a safe **pause** (not hard failure): AutoDev prints remaining task summary and resume hint.
  - Resume command is always `/autodev run` (or `/autodev run <taskId>` for targeted rerun).
  - `/autodev run <taskId>` is single-task mode and does not consume loop run/time budgets.
  - Recommended for long roadmap execution: set both loop limits to `0`, and keep `AUTODEV_MAX_CONSECUTIVE_FAILURES` + no-progress detection enabled as safety rails.
- `/autodev skills ...` controls role-skill injection (`on|off`) and disclosure mode (`summary|progressive|full`) for current session.
- `/autodev content on|off|status` controls AutoDev stage output echo (planner/executor/reviewer content) for current session.
- Task closes to `✅` only when completion gate passes (reviewer approved + no explicit validation failure + auto-commit success when commit is required).
- In strict mode (`AUTODEV_VALIDATION_STRICT=true`), completion gate requires structured validation evidence (`VALIDATION_STATUS` and/or `__EXIT_CODES__`).
- When workflow/reviewer execution succeeds but completion gate fails, `/autodev status` reports `runState: completed_with_gate_failed` (instead of `succeeded`).
- `/autodev status` exposes validation observability fields: `runValidationFailureClass`, `runValidationEvidenceSource`, and `runValidationAt`.
- Validation fuse rule: if the same task hits the same `validationFailureClass` consecutively for `AUTODEV_MAX_CONSECUTIVE_FAILURES`, AutoDev stops and marks it `🚫` with next-action guidance.
- When reviewer verdict is `APPROVED` and the workdir is a clean Git repo, CodeHarbor auto-commits changes with a semantic subject: `<type>(<scope>): <business-summary> (<taskId>)`.
- AutoDev commit intent uses a hybrid strategy: prefer reviewer `SUMMARY` (role-skill output) when it matches the selected commit language; otherwise fall back to deterministic template inference.
- Commit language policy: for a brand-new project (no history) the first AutoDev commit defaults to English; for existing projects, AutoDev follows the recent repository commit language trend.
- AutoDev commit body includes `Task-ID`, `Changed-files`, and `Generated-by` for traceability.
- AutoDev result notice always includes git commit status and changed files (`git changed files`).
- If `TASK_LIST.md` has a dedicated `发布映射` section with rows like `| T8.4 | v0.1.55 | ... |`, AutoDev can create a follow-up release commit after task completion: `release: vX.Y.Z [publish-npm]` (updates `package.json`/`package-lock.json`/`CHANGELOG.md`).
- AutoDev release mapping parser only reads the `发布映射` section; keep community-priority/milestone tables in separate headings (for example `社区优先级 -> 可执行里程碑`) to avoid ambiguous version parsing.
- Current community roadmap milestones are aligned as: `T8.1~T8.3 -> v0.1.53~v0.1.54`, `T8.4~T8.5 -> v0.1.55~v0.1.56`, `T8.6 -> v0.1.57`, `T8.7~T8.8 -> v0.1.58~v0.1.59`.
- When CI detects that the target version already exists on npm, the release workflow skips publishing and prints `Suggested next version` to keep release flow idempotent.
- If the same task fails consecutively and reaches `AUTODEV_MAX_CONSECUTIVE_FAILURES`, CodeHarbor marks it as `🚫` and skips it in later loops.
- If the repo is missing or already dirty before run, AutoDev skips commit and reports the reason in the result notice.
- When `AUTODEV_PREFLIGHT_AUTO_STASH=true`, dirty git preflight is auto-stashed and the run continues (stash ref is reported in notices).
- If workflow attempts to edit `TASK_LIST.md`, AutoDev rolls it back and fails completion gate with `task-list-policy-violated`.
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
- `MATRIX_PROGRESS_DELIVERY_MODE=upsert|timeline`
  - `upsert` edits one progress notice in group chats; `timeline` appends progress notices
- `MATRIX_TYPING_TIMEOUT_MS=10000`
  - typing indicator timeout; CodeHarbor refreshes typing state while handling a request
- `MATRIX_NOTICE_BADGE_ENABLED=true|false`
  - enable/disable rich-message badge headers (`CodeHarbor 提示` / `CodeHarbor AI 回复`)
- Group rooms default to notice edit (`m.replace`) to coalesce progress and reduce spam (`MATRIX_PROGRESS_DELIVERY_MODE=upsert`).
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
