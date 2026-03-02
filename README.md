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

## Tests

```bash
npm test
```
