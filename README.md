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
- Rate limiting + concurrency guardrails (user/room/global)
- Progress + typing updates with group notice coalescing (`m.replace` edit)
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

- Node.js 20+
- `codex` CLI installed and authenticated (`codex login`)
- A Matrix bot user + access token

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

Required values:

- `MATRIX_HOMESERVER`
- `MATRIX_USER_ID`
- `MATRIX_ACCESS_TOKEN`

3. Run in dev mode:

```bash
npm run dev
```

4. Build and run as CLI:

```bash
npm run build
node dist/cli.js start
```

## Commands

- `codeharbor start`: start service
- `codeharbor doctor`: check `codex` and Matrix connectivity

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
  - `/status` show session + limiter + metrics status
  - `/reset` clear bound Codex session and keep conversation active
  - `/stop` cancel in-flight execution (if running) and reset session context

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
