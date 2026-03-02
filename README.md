# CodeHarbor

CodeHarbor is an instant-messaging bridge for `codex CLI`.
Users send messages in Matrix, CodeHarbor routes each message to a Codex session, then sends the final result back to the same Matrix room.

## What It Does

- Matrix channel adapter (receive + reply)
- Session-to-Codex mapping via persistent local state
- Duplicate Matrix event protection
- Prefix-based trigger (default `!code`)
- NPM-distributed CLI (`codeharbor`)

## Architecture

```text
Matrix Room -> MatrixChannel -> Orchestrator -> CodexExecutor (codex exec/resume)
                                          |
                                          -> StateStore (state.json)
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

- `MATRIX_COMMAND_PREFIX=!code`
  - `!code fix this bug` -> processed
  - `hello` -> ignored
- `MATRIX_COMMAND_PREFIX=` (empty)
  - all text messages are processed
- `MAX_SESSION_AGE_DAYS=30`
  - session metadata older than this TTL is pruned from `state.json`
- `MAX_SESSIONS=5000`
  - when session count exceeds the limit, least-recently-updated sessions are pruned
- `MATRIX_PROGRESS_UPDATES=true`
  - emit stage progress updates as Matrix `m.notice` messages (for example reasoning/thinking snippets)
- `MATRIX_PROGRESS_MIN_INTERVAL_MS=2500`
  - minimum interval between progress updates to avoid room spam
- `MATRIX_TYPING_TIMEOUT_MS=10000`
  - typing indicator timeout; CodeHarbor refreshes typing state while handling a request

## Tests

```bash
npm run typecheck
npm test
```

Python legacy tests (optional, requires Python env + pytest):

```bash
./.venv/bin/python -m pytest -q tests
# or
python3 -m pytest -q tests
```

## Legacy Runtime

- Legacy Python runtime exists in `app/` and `tests/`.
- It is not part of default release/CI gates.
- Use `npm run test:legacy` for optional regression checks.
