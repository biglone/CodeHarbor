# CodeHarbor

CodeHarbor is an instant-messaging bridge for `codex CLI`.
Users send messages in Matrix, CodeHarbor routes each message to a Codex session, then sends the final result back to the same Matrix room.

## What It Does

- Matrix channel adapter (receive + reply)
- Session-to-Codex mapping via persistent SQLite state
- One-time migration import from legacy `state.json`
- Duplicate Matrix event protection
- Context-aware trigger (DM direct chat + group mention/reply + active session window)
- Room-level trigger policy overrides
- Real `/stop` cancellation (kills in-flight Codex process)
- Session runtime workers (logical worker per `channel:room:user`, with worker stats in `/status`)
- Rate limiting + concurrency guardrails (user/room/global)
- Progress + typing updates with group notice coalescing (`m.replace` edit)
- CLI-compat mode (`cli_compat_mode`) for minimal prompt rewriting + raw event passthrough
- Attachment metadata passthrough from Matrix events into prompt context
- Request observability (request_id, queue/exec/send durations, status counters)
- NPM-distributed CLI (`codeharbor`)

## Architecture

```text
Matrix Room -> MatrixChannel -> Orchestrator -> CodexExecutor (codex exec/resume)
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
- `codex` CLI installed and authenticated (`codex login`)
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
sudo codeharbor service install
```

Install + enable main and admin services:

```bash
sudo codeharbor service install --with-admin
```

Remove installed services:

```bash
sudo codeharbor service uninstall --with-admin
```

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
- `docs/CONFIG_UI_DESIGN.md`: configuration UI MVP design
- `docs/CONFIG_CATALOG.md`: consolidated configuration matrix (required/runtime/UI/effective timing)
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

It documents:

- which keys are required vs optional
- which keys can be edited in Admin UI
- whether changes are immediate or restart-scoped
- recommended profiles for local/internal/public deployment

## Commands

- `codeharbor init`: guided setup for `.env` (supports `--force` to overwrite directly)
- `codeharbor start`: start service
- `codeharbor doctor`: check `codex` and Matrix connectivity
- `codeharbor admin serve`: start admin UI + config API server
- `codeharbor config export`: export current config snapshot as JSON
- `codeharbor config import <file>`: import config snapshot JSON (supports `--dry-run`)
- `npm run changelog:check`: validate `CHANGELOG.md` has notes for current package version
- `scripts/install-linux.sh`: Linux bootstrap installer (creates runtime dir + installs npm package)
- `scripts/install-linux-easy.sh`: one-shot Linux install + config + systemd auto-start
- `scripts/backup-config.sh`: export timestamped snapshot and keep latest N backups
- `scripts/install-backup-timer.sh`: install/update user-level systemd timer for automatic backups
- `npm run test:e2e`: run Admin UI end-to-end tests (Playwright)

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

If you bind Admin to a non-loopback host and `ADMIN_TOKEN` is empty, startup is rejected by default.
Explicit bypass exists but is not recommended:

```bash
codeharbor admin serve --host 0.0.0.0 --allow-insecure-no-token
```

Open these UI routes in browser:

- `/` or `/settings/global`
- `/settings/rooms`
- `/health`
- `/audit`

Main endpoints:

- `GET /api/admin/config/global`
- `PUT /api/admin/config/global`
- `GET /api/admin/config/rooms`
- `GET /api/admin/config/rooms/:roomId`
- `PUT /api/admin/config/rooms/:roomId`
- `DELETE /api/admin/config/rooms/:roomId`
- `GET /api/admin/health`
- `GET /api/admin/audit?limit=50`

When `ADMIN_TOKEN` is set, requests must include:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

Access control options:

- `ADMIN_TOKEN`: require bearer token for `/api/admin/*`
- `ADMIN_IP_ALLOWLIST`: optional comma-separated client IP whitelist (for example `127.0.0.1,192.168.1.10`)
- `ADMIN_ALLOWED_ORIGINS`: optional CORS origin allowlist for browser-based cross-origin admin access

Note: `PUT /api/admin/config/global` writes to `.env` and marks changes as restart-required.

### Admin UI Quick Walkthrough

1. Start server: `codeharbor admin serve`.
2. Open `/settings/global`, set `Admin Token` (if enabled), then click `Save Auth`.
3. Adjust global fields and click `Save Global Config` (UI shows restart-required warning).
4. Open `/settings/rooms`, fill `Room ID + Workdir`, then `Save Room`.
5. Open `/health` to run connectivity checks (`codex` + Matrix).
6. Open `/audit` to verify config revisions (actor/summary/payload).

## Standalone Admin Deployment

`codeharbor admin serve` can run as an independent service on target servers without browser/desktop.
Access can come from your local browser through a gateway (for example Cloudflare Tunnel).

See:

- [`docs/ADMIN_STANDALONE_DEPLOY.md`](docs/ADMIN_STANDALONE_DEPLOY.md)

## Startup Preflight

Before `codeharbor start` and `codeharbor doctor`, CodeHarbor runs a preflight check for:

- required Matrix env vars
- `CODEX_BIN` availability
- `CODEX_WORKDIR` validity
- `.env` presence warning

If any check fails, it prints actionable fix commands (for example `codeharbor init`).

## Message Rules

- Direct Message (DM)
  - all text messages are processed by default (no prefix required)
- Group Room
  - processed when **any allowed trigger** matches:
    - message mentions bot user id
    - message replies to a bot message
    - sender has an active conversation window
    - optional explicit prefix match (`MATRIX_COMMAND_PREFIX`)
- Trigger Policy
  - global defaults via `GROUP_TRIGGER_ALLOW_*`
  - per-room overrides via `ROOM_TRIGGER_POLICY_JSON`
- Active Conversation Window
  - each accepted request activates the sender's conversation in that room
  - activation TTL: `SESSION_ACTIVE_WINDOW_MINUTES` (default: `20`)
- Control commands
  - `/status` show session + limiter + metrics + runtime worker status
  - `/reset` clear bound Codex session and keep conversation active
  - `/stop` cancel in-flight execution (if running) and reset session context

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
  - download Matrix `mxc://` media (image) to temp file and pass it to codex via `--image`
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
2. pass local file paths as `--image` to codex exec
3. best-effort cleanup temp files after the request
4. optional prompt record append (`CLI_COMPAT_RECORD_PATH`) for deterministic replay input

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

## Legacy Runtime

- Legacy Python runtime exists in `app/` and `tests/`.
- It is not part of default release/CI gates.
- Use `npm run test:legacy` for optional regression checks.
