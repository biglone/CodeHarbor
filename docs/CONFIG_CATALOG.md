# CodeHarbor Configuration Catalog

This catalog is a second-pass consolidation of all runtime settings.
It separates **boot-required** values from **runtime-tunable** values and marks whether each field is manageable in Admin UI.

## 1) Boot-Required Core

These must be valid before `codeharbor start`.

| Key | Required | Default | Admin UI | Effect Timing | Notes |
|---|---|---|---|---|---|
| `MATRIX_HOMESERVER` | Yes | - | No | Restart | Matrix server base URL |
| `MATRIX_USER_ID` | Yes | - | No | Restart | Bot user id |
| `MATRIX_ACCESS_TOKEN` | Yes | - | No | Restart | Bot access token |
| `CODEX_BIN` | No | `codex` | No | Restart | Codex executable path |
| `CODEX_MODEL` | No | empty | No | Restart | Optional model override |
| `CODEX_WORKDIR` | No | current cwd | Yes | Restart | Default workdir fallback |
| `CODEX_DANGEROUS_BYPASS` | No | `false` | No | Restart | Codex bypass flag |
| `CODEX_EXEC_TIMEOUT_MS` | No | `600000` | No | Restart | Execution timeout |
| `CODEX_SANDBOX_MODE` | No | empty | No | Restart | Codex sandbox mode |
| `CODEX_APPROVAL_POLICY` | No | empty | No | Restart | Codex approval policy |
| `CODEX_EXTRA_ARGS` | No | empty | No | Restart | Extra codex args |
| `CODEX_EXTRA_ENV_JSON` | No | empty | No | Restart | Extra child env map |
| `AGENT_WORKFLOW_ENABLED` | No | `false` | Yes | Restart | Enable Phase B multi-agent workflow commands |
| `AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS` | No | `1` | Yes | Restart | Max executor repair rounds after reviewer rejection |

## 2) State / Persistence

| Key | Required | Default | Admin UI | Effect Timing | Notes |
|---|---|---|---|---|---|
| `STATE_DB_PATH` | No | `data/state.db` | No | Restart | SQLite path |
| `STATE_PATH` | No | `data/state.json` | No | Restart | Legacy one-time import source |
| `MAX_PROCESSED_EVENTS_PER_SESSION` | No | `200` | No | Restart | Dedup history cap |
| `MAX_SESSION_AGE_DAYS` | No | `30` | No | Restart | Expired session cleanup |
| `MAX_SESSIONS` | No | `5000` | No | Restart | Total session cap |

## 3) Routing / Trigger / Runtime Controls

| Key | Required | Default | Admin UI | Effect Timing | Notes |
|---|---|---|---|---|---|
| `MATRIX_COMMAND_PREFIX` | No | `!code` | Yes | Restart | Group explicit trigger prefix |
| `SESSION_ACTIVE_WINDOW_MINUTES` | No | `20` | Yes | Restart | Active window for group follow-up |
| `GROUP_TRIGGER_ALLOW_MENTION` | No | `true` | Yes | Restart | Default group policy |
| `GROUP_TRIGGER_ALLOW_REPLY` | No | `true` | Yes | Restart | Default group policy |
| `GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW` | No | `true` | Yes | Restart | Default group policy |
| `GROUP_TRIGGER_ALLOW_PREFIX` | No | `true` | Yes | Restart | Default group policy |
| `ROOM_TRIGGER_POLICY_JSON` | No | empty | No | Restart | Legacy JSON override map |
| Room settings in DB (`room_settings`) | N/A | N/A | Yes | Immediate (new requests) | Room enable flags, per-room trigger policy, room workdir |

## 4) Rate Limiting / Concurrency

| Key | Required | Default | Admin UI | Effect Timing | Notes |
|---|---|---|---|---|---|
| `RATE_LIMIT_WINDOW_SECONDS` | No | `60` | Yes | Restart | Window size |
| `RATE_LIMIT_MAX_REQUESTS_PER_USER` | No | `20` | Yes | Restart | User request cap per window |
| `RATE_LIMIT_MAX_REQUESTS_PER_ROOM` | No | `120` | Yes | Restart | Room request cap per window |
| `RATE_LIMIT_MAX_CONCURRENT_GLOBAL` | No | `8` | Yes | Restart | Global concurrency cap |
| `RATE_LIMIT_MAX_CONCURRENT_PER_USER` | No | `1` | Yes | Restart | User concurrency cap |
| `RATE_LIMIT_MAX_CONCURRENT_PER_ROOM` | No | `4` | Yes | Restart | Room concurrency cap |

## 5) Progress / Response Behavior

| Key | Required | Default | Admin UI | Effect Timing | Notes |
|---|---|---|---|---|---|
| `REPLY_CHUNK_SIZE` | No | `3500` | No | Restart | Message split size |
| `MATRIX_PROGRESS_UPDATES` | No | `true` | Yes | Restart | Emit progress updates |
| `MATRIX_PROGRESS_MIN_INTERVAL_MS` | No | `2500` | Yes | Restart | Progress update interval |
| `MATRIX_TYPING_TIMEOUT_MS` | No | `10000` | Yes | Restart | Typing indicator timeout |

## 6) CLI Compatibility

| Key | Required | Default | Admin UI | Effect Timing | Notes |
|---|---|---|---|---|---|
| `CLI_COMPAT_MODE` | No | `false` | Yes | Restart | CLI-like mode master switch |
| `CLI_COMPAT_PASSTHROUGH_EVENTS` | No | `true` | Yes | Restart | Raw event passthrough summaries |
| `CLI_COMPAT_PRESERVE_WHITESPACE` | No | `true` | Yes | Restart | Preserve prompt whitespace |
| `CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT` | No | `false` | Yes | Restart | Disable chunk splitting |
| `CLI_COMPAT_PROGRESS_THROTTLE_MS` | No | `300` | Yes | Restart | Compatibility progress throttle |
| `CLI_COMPAT_FETCH_MEDIA` | No | `true` | Yes | Restart | Download media for prompts |
| `CLI_COMPAT_RECORD_PATH` | No | empty | No | Restart | JSONL replay record path |

## 7) Admin / Ops / Security

| Key | Required | Default | Admin UI | Effect Timing | Notes |
|---|---|---|---|---|---|
| `DOCTOR_HTTP_TIMEOUT_MS` | No | `10000` | No | Restart | Doctor timeout |
| `ADMIN_BIND_HOST` | No | `127.0.0.1` | No | Restart | Admin listener host |
| `ADMIN_PORT` | No | `8787` | No | Restart | Admin listener port |
| `ADMIN_TOKEN` | No (functional), **Yes (public exposure)** | empty | UI can set header only | Restart | API bearer auth. Required for non-loopback/public usage |
| `ADMIN_TOKENS_JSON` | No | empty | UI can set header only | Restart | Optional RBAC token list (`admin`/`viewer`) |
| `ADMIN_IP_ALLOWLIST` | No | empty | No | Restart | Optional client IP allowlist |
| `ADMIN_ALLOWED_ORIGINS` | No | empty | No | Restart | Optional browser origin allowlist for CORS (`https://admin.example.com`) |
| `LOG_LEVEL` | No | `info` | No | Restart | Logger level |

`ADMIN_TOKENS_JSON` example:

```json
[{"token":"admin-secret","role":"admin","actor":"ops-admin"},{"token":"viewer-secret","role":"viewer","actor":"ops-audit"}]
```

## Recommended Operating Profiles

1. Local single machine
- Keep `ADMIN_BIND_HOST=127.0.0.1`
- Optional `ADMIN_TOKEN`

2. Team internal network
- `ADMIN_BIND_HOST=0.0.0.0`
- Set strong `ADMIN_TOKEN` or `ADMIN_TOKENS_JSON`
- Prefer reverse proxy/TLS and optional `ADMIN_IP_ALLOWLIST`

3. Public domain via tunnel/reverse proxy
- Keep `ADMIN_BIND_HOST=127.0.0.1`
- Set strong `ADMIN_TOKEN` or `ADMIN_TOKENS_JSON`
- Expose only through trusted gateway (for example Cloudflare Tunnel)
- Do not use `--allow-insecure-no-token`
