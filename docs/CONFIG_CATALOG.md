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
| `AI_CLI_PROVIDER` | No | `codex` | No | Restart | AI CLI provider (`codex` or `claude`) |
| `CODEX_BIN` | No | `codex` | No | Restart | Executable path for selected AI CLI provider |
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
| `AGENT_WORKFLOW_PLAN_CONTEXT_MAX_CHARS` | No | empty | No | Restart | Optional max planner-plan context chars injected into role prompts (`<=0`/empty means unlimited) |
| `AGENT_WORKFLOW_OUTPUT_CONTEXT_MAX_CHARS` | No | empty | No | Restart | Optional max executor output chars injected into reviewer/repair prompts (`<=0`/empty means unlimited) |
| `AGENT_WORKFLOW_FEEDBACK_CONTEXT_MAX_CHARS` | No | empty | No | Restart | Optional max reviewer feedback chars injected into repair prompts (`<=0`/empty means unlimited) |

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
| `SESSION_ACTIVE_WINDOW_MINUTES` | No | `20` | Yes | Hot (new requests) | Active window for group follow-up |
| `MATRIX_ADMIN_USERS` | No | empty | No | Restart | Optional Matrix admin mxid list used as `/upgrade` auth fallback |
| `MATRIX_UPGRADE_ALLOWED_USERS` | No | empty | No | Restart | Optional explicit mxid allowlist for in-chat `/upgrade` (higher priority than `MATRIX_ADMIN_USERS`) |
| `GROUP_DIRECT_MODE_ENABLED` | No | `false` | Yes | Hot (new requests) | Process all group messages without trigger matching |
| `GROUP_TRIGGER_ALLOW_MENTION` | No | `true` | Yes | Hot (new requests) | Default group policy |
| `GROUP_TRIGGER_ALLOW_REPLY` | No | `true` | Yes | Hot (new requests) | Default group policy |
| `GROUP_TRIGGER_ALLOW_ACTIVE_WINDOW` | No | `true` | Yes | Hot (new requests) | Default group policy |
| `GROUP_TRIGGER_ALLOW_PREFIX` | No | `true` | Yes | Hot (new requests) | Default group policy |
| `ROOM_TRIGGER_POLICY_JSON` | No | empty | No | Restart | Legacy JSON override map |
| Room settings in DB (`room_settings`) | N/A | N/A | Yes | Immediate (new requests) | Room enable flags, per-room trigger policy, room workdir |

## 4) Rate Limiting / Concurrency

| Key | Required | Default | Admin UI | Effect Timing | Notes |
|---|---|---|---|---|---|
| `RATE_LIMIT_WINDOW_SECONDS` | No | `60` | Yes | Hot (new requests) | Window size |
| `RATE_LIMIT_MAX_REQUESTS_PER_USER` | No | `20` | Yes | Hot (new requests) | User request cap per window |
| `RATE_LIMIT_MAX_REQUESTS_PER_ROOM` | No | `120` | Yes | Hot (new requests) | Room request cap per window |
| `RATE_LIMIT_MAX_CONCURRENT_GLOBAL` | No | `8` | Yes | Hot (new requests) | Global concurrency cap |
| `RATE_LIMIT_MAX_CONCURRENT_PER_USER` | No | `1` | Yes | Hot (new requests) | User concurrency cap |
| `RATE_LIMIT_MAX_CONCURRENT_PER_ROOM` | No | `4` | Yes | Hot (new requests) | Room concurrency cap |

## 5) Progress / Response Behavior

| Key | Required | Default | Admin UI | Effect Timing | Notes |
|---|---|---|---|---|---|
| `REPLY_CHUNK_SIZE` | No | `3500` | No | Restart | Message split size |
| `MATRIX_PROGRESS_UPDATES` | No | `true` | Yes | Hot (new requests) | Emit progress updates |
| `MATRIX_PROGRESS_MIN_INTERVAL_MS` | No | `2500` | Yes | Hot (new requests) | Progress update interval |
| `MATRIX_TYPING_TIMEOUT_MS` | No | `10000` | Yes | Hot (new requests) | Typing indicator timeout |
| `PACKAGE_UPDATE_CHECK_ENABLED` | No | `true` | Yes | Restart | Enable npm latest-version lookup for `/status`, `/version`, and Admin health app row |
| `PACKAGE_UPDATE_CHECK_TIMEOUT_MS` | No | `3000` | Yes | Restart | Timeout (ms) for npm latest-version lookup |
| `PACKAGE_UPDATE_CHECK_TTL_MS` | No | `21600000` | Yes | Restart | Cache TTL (ms) for npm latest-version lookup results |

## 6) CLI Compatibility

| Key | Required | Default | Admin UI | Effect Timing | Notes |
|---|---|---|---|---|---|
| `CLI_COMPAT_MODE` | No | `false` | Yes | Restart | CLI-like mode master switch |
| `CLI_COMPAT_PASSTHROUGH_EVENTS` | No | `true` | Yes | Restart | Raw event passthrough summaries |
| `CLI_COMPAT_PRESERVE_WHITESPACE` | No | `true` | Yes | Restart | Preserve prompt whitespace |
| `CLI_COMPAT_DISABLE_REPLY_CHUNK_SPLIT` | No | `false` | Yes | Restart | Disable chunk splitting |
| `CLI_COMPAT_PROGRESS_THROTTLE_MS` | No | `300` | Yes | Restart | Compatibility progress throttle |
| `CLI_COMPAT_FETCH_MEDIA` | No | `true` | Yes | Restart | Download media for prompts |
| `CLI_COMPAT_IMAGE_MAX_BYTES` | No | `10485760` | No | Restart | Skip oversized image attachments before backend execution |
| `CLI_COMPAT_IMAGE_MAX_COUNT` | No | `4` | No | Restart | Max image count passed to backend per request |
| `CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES` | No | `image/png,image/jpeg,image/webp,image/gif` | No | Restart | Comma-separated image MIME allowlist |
| `CLI_COMPAT_TRANSCRIBE_AUDIO` | No | `false` | Yes | Restart | Enable transcription for Matrix `m.audio` attachments |
| `CLI_COMPAT_AUDIO_TRANSCRIBE_MODEL` | No | `gpt-4o-mini-transcribe` | Yes | Restart | OpenAI transcription model |
| `CLI_COMPAT_AUDIO_TRANSCRIBE_TIMEOUT_MS` | No | `120000` | Yes | Restart | Timeout per transcription request |
| `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_CHARS` | No | `6000` | Yes | Restart | Max characters appended from one transcript |
| `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES` | No | `1` | Yes | Restart | Retry count for local/OpenAI transcription failures |
| `CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS` | No | `800` | Yes | Restart | Base delay between retries |
| `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES` | No | `26214400` | Yes | Restart | Skip transcription for oversized audio files |
| `CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND` | No | empty | Yes | Restart | Optional local whisper command template (use `{input}` placeholder) |
| `CLI_COMPAT_AUDIO_LOCAL_WHISPER_TIMEOUT_MS` | No | `180000` | Yes | Restart | Timeout for local whisper command execution |
| `CLI_COMPAT_RECORD_PATH` | No | empty | No | Restart | JSONL replay record path |

## 7) Admin / Ops / Security

| Key | Required | Default | Admin UI | Effect Timing | Notes |
|---|---|---|---|---|---|
| `DOCTOR_HTTP_TIMEOUT_MS` | No | `10000` | No | Restart | Doctor timeout |
| `API_ENABLED` | No | `false` | No | Restart | Enable task API server (`/api/tasks`, `/api/webhooks/:source`) |
| `API_BIND_HOST` | No | `127.0.0.1` | No | Restart | Task API listener host |
| `API_PORT` | No | `8788` | No | Restart | Task API listener port |
| `API_TOKEN` | No (functional), **Yes (`API_ENABLED=true`)** | empty | No | Restart | Bearer token for `/api/tasks*` |
| `API_TOKEN_SCOPES_JSON` | No | empty | No | Restart | Optional API token scope override JSON array (for example `["tasks.submit.api"]` or `["tasks.read.api"]`) |
| `API_WEBHOOK_SECRET` | No | empty | No | Restart | Enables webhook signature validation when set |
| `API_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` | No | `300` | No | Restart | Allowed webhook timestamp skew window |
| `ADMIN_BIND_HOST` | No | `127.0.0.1` | No | Restart | Admin listener host |
| `ADMIN_PORT` | No | `8787` | No | Restart | Admin listener port |
| `ADMIN_TOKEN` | No (functional), **Yes (public exposure)** | empty | UI can set header only | Restart | API bearer auth. Required for non-loopback/public usage |
| `ADMIN_TOKENS_JSON` | No | empty | UI can set header only | Restart | Optional RBAC token list (`admin`/`viewer` defaults, optional custom `scopes`) |
| `ADMIN_IP_ALLOWLIST` | No | empty | No | Restart | Optional client IP allowlist |
| `ADMIN_ALLOWED_ORIGINS` | No | empty | No | Restart | Optional browser origin allowlist for CORS (`https://admin.example.com`) |
| `LOG_LEVEL` | No | `info` | No | Restart | Logger level |

`ADMIN_TOKENS_JSON` example:

```json
[{"token":"admin-secret","role":"admin","actor":"ops-admin"},{"token":"viewer-secret","role":"viewer","actor":"ops-audit","scopes":["admin.read.auth","admin.read.audit"]}]
```

`scopes` is optional. When present, it overrides role defaults for that token and supports wildcard patterns (for example `admin.read.*` or `*`).

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

## Hot Update Rollback (Ops)

1. Create a snapshot before changing config:
   - `codeharbor config export -o backups/pre-hot-update.json`
2. For a bad hot update (whitelist keys), write back the previous value from Admin UI/API:
   - `PUT /api/admin/config/global`
   - verify response has `restartRequired=false` and expected `hotAppliedKeys`
3. For full rollback (includes restart-required keys), import snapshot and restart service:
   - `codeharbor config import backups/pre-hot-update.json --dry-run`
   - `codeharbor config import backups/pre-hot-update.json`
   - `codeharbor service restart` (or `codeharbor service restart --with-admin`)
4. Verify and audit:
   - `GET /api/admin/audit?limit=20&kind=config`
   - `GET /api/admin/audit?limit=20&kind=operations`
   - `GET /api/admin/health`
   - send a Matrix smoke request in one room

Boundary: hot updates affect new requests only; in-flight requests continue with their existing execution state.
