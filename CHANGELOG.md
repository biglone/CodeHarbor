# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and follows semantic versioning.

## [Unreleased]

- Community and growth infrastructure:
  - added GitHub issue forms (bug/feature), issue template config, and pull request template
  - added release note category config via `.github/release.yml`
  - added contributor guide (`CONTRIBUTING.md`) and growth playbook (`docs/GROWTH_PLAYBOOK_ZH.md`)
  - updated README and release guide with feedback/community operation entry points

## [0.1.40] - 2026-03-17

- Multimodal runtime diagnostics and UX:
  - `/help` now includes live multimodal status summary (image policy/audio status/backend image support)
  - new `/diag media [count]` for image/audio counters and recent media handling records
- Image guardrails for Matrix `m.image`:
  - added `CLI_COMPAT_IMAGE_MAX_BYTES`, `CLI_COMPAT_IMAGE_MAX_COUNT`, and `CLI_COMPAT_IMAGE_ALLOWED_MIME_TYPES`
  - enforce size/MIME/count policy before backend execution, with explicit in-chat skip notices
- Claude image resilience:
  - when Claude image input fails, CodeHarbor auto-retries once without image blocks and informs user
- Docs updates:
  - added `docs/MULTIMODAL_VERIFICATION_ZH.md` verification playbook
  - synced README + Chinese manuals/config guides/help references for new multimodal diagnostics and config keys

## [0.1.39] - 2026-03-17

- Image understanding parity:
  - Claude backend now supports Matrix `m.image` analysis via stream-json base64 image blocks
  - keeps existing Codex `--image` path and aligns multimodal behavior across both backends

## [0.1.38] - 2026-03-17

- Upgrade workflow hardening:
  - added post-upgrade verification (target/installed version check) and explicit pass/fail notices with recovery hints
  - filtered noisy SQLite ExperimentalWarning text from in-chat upgrade failure output
  - added distributed upgrade lock (SQLite lease) to prevent concurrent `/upgrade` across multi-instance deployments
  - added `/diag upgrade [count]` diagnostics (lock state, aggregate stats, recent records)
  - `/status` now includes upgrade metrics (total/succeeded/failed/running/avg) and upgrade lock state
- Upgrade permission model:
  - added `MATRIX_ADMIN_USERS` fallback auth for `/upgrade` when `MATRIX_UPGRADE_ALLOWED_USERS` is empty
  - `MATRIX_UPGRADE_ALLOWED_USERS` remains higher-priority explicit allowlist
- Docs/help/config sync:
  - updated CLI/in-chat command references, `.env.example`, and manuals for `/diag upgrade` and new upgrade auth precedence

## [0.1.37] - 2026-03-17

- Fixed in-chat `/upgrade` restart reliability under hardened systemd services:
  - `/upgrade` now installs with `--skip-restart` and performs service-context restart via process signal fallback
  - avoids sudo escalation failures when `NoNewPrivileges=true`

## [0.1.36] - 2026-03-17

- Enhanced `/status` upgrade observability:
  - latest-upgrade summary now includes upgrade task id
  - added recent upgrade run list (`#id:status@time`) for quick troubleshooting
- Updated docs for the `/status` upgrade-task-id output in README and Chinese user manual.

## [0.1.35] - 2026-03-16

- Improved `/status` observability:
  - now includes latest in-chat upgrade run result (target/installed version, time, and error summary when failed)

## [0.1.34] - 2026-03-16

- Added Matrix in-chat upgrade control command:
  - new `/upgrade [version]` (with `upgrade` / `升级` aliases) triggers `self-update` flow and service restart
  - supports optional `MATRIX_UPGRADE_ALLOWED_USERS` allowlist for command authorization in direct messages
- Updated docs/help for the new in-chat upgrade flow (`README`, `USER_MANUAL_ZH`, config guides, `.env.example`, CLI help).

## [0.1.33] - 2026-03-16

- Added in-chat help control command:
  - users can send `/help` to get a control-command cheatsheet directly in Matrix rooms
- Improved Matrix client compatibility for help commands:
  - added plain-text aliases `help`, `帮助`, and `菜单` for clients that intercept slash commands
- Updated CLI/docs command references to include in-chat help usage (`README`, `USER_MANUAL_ZH`, CLI help output).

## [0.1.32] - 2026-03-16

- Improved in-chat transparency and diagnostics:
  - completion progress notice now includes active backend tool/model label
  - `/status` now explicitly marks update check as cached TTL result and points users to `/version` for real-time refresh
  - added `/diag version` to inspect runtime process/version details (pid/start time/bin path/backend)
- Added one-command upgrade flow:
  - new `codeharbor self-update` command installs latest npm package and restarts installed services
- Strengthened release verification workflow:
  - release CI now performs post-publish npm latest checks, fresh global install verification, and registry endpoint consistency checks
- Updated docs/help for new commands and version-check behavior (`README`, `USER_MANUAL_ZH`, CLI help).

## [0.1.31] - 2026-03-16

- Hardened `/version` latest-version lookup to reduce stale npm results:
  - add no-store/no-cache request headers with cache-bust query for forced refresh checks
  - query both npm endpoints (`/<pkg>/latest` and `/-/package/<pkg>/dist-tags`) and prefer the higher semver
  - fallback gracefully when one endpoint is stale/unavailable
- Added regression coverage for dual-endpoint version resolution and stale-response fallback cases.

## [0.1.30] - 2026-03-16

- Added cross-backend context bridge:
  - persist recent local conversation turns (`user`/`assistant`) per Matrix session in SQLite
  - auto-inject `[conversation_bridge]` on the first request after `/backend codex|claude` switch
  - one-shot bridge suppression after `/reset` and `/stop` to support explicit fresh-start sessions
- Added regression coverage for history persistence, per-session trimming, and backend-switch bridge injection.
- Improved release/readability docs:
  - refreshed npm package metadata and discoverability keywords for Codex + Claude positioning
  - expanded CLI help/manual references for common CLI and in-chat control commands

## [0.1.29] - 2026-03-16

- Fixed version-check staleness experience:
  - `/version` now forces a real-time npm latest-version refresh (bypasses cache)
  - `/status` now includes update check timestamp (`checkedAt`) for observability
- Added configurable update-check cache TTL:
  - `PACKAGE_UPDATE_CHECK_TTL_MS` (default `21600000`, 6h)
- Added Admin Global Config support for update-check TTL (UI + API + `.env` persistence).
- Updated config snapshot import/export and docs for the new TTL and refresh behavior.

## [0.1.28] - 2026-03-16

- Added `/version` control command to return current package version and update hint in bot notice.
- Added configurable package update-check controls:
  - `PACKAGE_UPDATE_CHECK_ENABLED`
  - `PACKAGE_UPDATE_CHECK_TIMEOUT_MS`
- Enhanced Admin health API/UI:
  - `/api/admin/health` now includes app-level version/update status
  - health page now shows CodeHarbor current/latest version and update availability
- Added Admin global settings support for update-check switch and timeout persistence.
- Updated documentation and examples (`README`, config guides, `.env.example`) for `/version` and update-check behavior.

## [0.1.27] - 2026-03-15

- Improved bot notice visibility by adding version prefix to status/progress notices:
  - notice prefix format is now `CodeHarbor v<version>`
- Enhanced completion notice with update hint so users can directly see whether a newer npm version is available after each request.
- Added regression coverage for versioned progress/status notice output.

## [0.1.26] - 2026-03-15

- Added package author metadata for npm package attribution.
- Improved npm package discoverability:
  - updated package description with self-hosted Matrix bot / Codex CLI wording
  - expanded package keywords with bridge, chat, messaging, and Matrix-specific terms
- Updated README opening summary to better describe Matrix room routing and SQLite-backed session state.

## [0.1.25] - 2026-03-15

- Added bot `/status` message version visibility:
  - shows current running `codeharbor` version
  - shows npm update hint (`up-to-date`, `new version available`, or `check unavailable`)
- Added npm latest-version checker with cache and timeout guard for status reporting.
- Added regression/unit coverage for version comparison, update-check result formatting, and status message output.

## [0.1.24] - 2026-03-15

- Improved CLI help output with prerequisite guidance (`codex login`, Matrix credential requirements), runtime-home notes, and quick-start command hints.
- Added a Chinese user manual covering install, configuration, verification, security, and upgrade workflow:
  - `docs/USER_MANUAL_ZH.md`
- Added a complete configuration guide with end-to-end setup flow and full feature-to-config mapping:
  - `docs/COMPLETE_CONFIGURATION_GUIDE.md`
- Updated configuration documentation to include missing CLI audio transcription controls in config catalog:
  - `docs/CONFIG_CATALOG.md`
- Updated README documentation index to link new manuals and configuration guides.
- Clarified prerequisite requirements across docs: using CodeHarbor requires both Codex CLI availability and Matrix account credentials.

## [0.1.23] - 2026-03-15

- Added Admin Console runtime language switcher (`中文` / `English`) with default locale set to Chinese (`zh`).
- Localized major Admin Console UI surfaces (global settings, room config, health check, and audit page labels/buttons/placeholders).
- Localized dynamic notices, status text, and confirmation dialogs in the Admin Console.
- Persisted language preference via `localStorage` and auto-applied it on page reload.

## [0.1.22] - 2026-03-15

- Added audio transcription resilience controls:
  - `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_RETRIES`
  - `CLI_COMPAT_AUDIO_TRANSCRIBE_RETRY_DELAY_MS`
  - `CLI_COMPAT_AUDIO_TRANSCRIBE_MAX_BYTES`
- Added retry behavior for both local whisper and OpenAI fallback transcription flows.
- Added oversized-audio guard to skip transcription for files above configured byte limit.
- Added audio transcription timing logs (`durationMs`) and skipped-count telemetry for easier production diagnosis.
- Added regression tests for retry and size-limit behavior, and updated docs/config surfaces (Admin API/UI, snapshot, `.env.example`, README).

## [0.1.21] - 2026-03-15

- Added local Whisper-first audio transcription pipeline for Matrix `m.audio` attachments:
  - new optional local command config `CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND` and timeout control
  - fallback to OpenAI audio transcription when local command fails and `OPENAI_API_KEY` is available
  - clearer error behavior when no transcription backend is configured
- Added bundled helper command `codeharbor-whisper-transcribe` (Python `faster-whisper`) for quick local deployment.
- Extended config surfaces for local whisper options:
  - `.env` / config schema
  - config snapshot export/import
  - Admin API global config + Admin Console fields
- Added regression coverage for local whisper success, fallback, and backend-missing scenarios.
- Updated docs and examples for local whisper setup and runtime requirements.

## [0.1.20] - 2026-03-15

- Added Matrix voice understanding pipeline:
  - optional `m.audio` media hydration to local temp files
  - OpenAI-based transcription (`CLI_COMPAT_TRANSCRIBE_AUDIO`) with configurable model/timeout/max transcript length
  - transcript injection into codex prompt via `[audio_transcripts]` context block
- Extended CLI compat/global config surfaces for audio transcription:
  - `.env` keys, config snapshot import/export, Admin API global config, and Admin Console UI fields
- Improved orchestrator cancellation behavior by handling `/stop` requests that race with in-flight execution startup.
- Updated docs and tests for audio transcription flow and attachment lifecycle cleanup.

## [0.1.19] - 2026-03-15

- Added Linux postinstall auto-restart for global upgrades so active `codeharbor` services pick up new versions immediately after `npm install -g codeharbor@latest`.
- Added best-effort safeguards for postinstall restart flow:
  - only runs for global installs by default
  - supports non-interactive `sudo -n` fallback for non-root users
  - never fails package installation when restart is unavailable
  - allows opt-out via `CODEHARBOR_SKIP_POSTINSTALL_RESTART=1`
- Updated docs and lint configuration for packaged postinstall restart script.

## [0.1.18] - 2026-03-15

- Enhanced Matrix AI reply rendering with markdown-like rich text support (headings, lists, blockquotes, links, emphasis, inline code, and fenced code blocks) for better in-room readability.
- Improved rich-message badge copy to use cleaner text labels in formatted replies.

## [0.1.17] - 2026-03-14

- Hardened Admin API by enforcing a JSON payload size limit and extracting the embedded Admin Console HTML into a dedicated module for maintainability.
- Improved Matrix reliability with timeout/retry handling for outbound message sends and media downloads.
- Fixed attachment temp-file lifecycle so hydrated files are cleaned up even when requests are ignored or rate-limited.
- Added workflow/AutoDev snapshot pruning (TTL + capacity control) to keep long-running orchestrator memory bounded.
- Improved `CODEX_EXTRA_ARGS` parsing to support quoted/escaped arguments with validation for malformed inputs.
- Optimized rate-limit window pruning to reduce per-request allocations under load.
- Updated tooling and dependency health: upgraded lint toolchain, pinned patched `flatted`, and improved legacy test runner/docs.

## [0.1.16] - 2026-03-14

- Fixed Matrix reply send failures caused by SDK thread-relation assumptions by switching outbound message/notice/progress sends to raw Matrix client API calls.
- Fixed self-account deployments by only filtering local echo events (transaction-id based) instead of dropping all events from `MATRIX_USER_ID`.
- Added richer Matrix reply formatting (`formatted_body`) for text/code blocks to improve chat readability.
- Added `GROUP_DIRECT_MODE_ENABLED` (default `false`) to support default group pass-through mode without mention/reply/prefix triggers.
- Added Admin Global Config support for group direct mode and documented the new routing option in `.env.example`, README, and config catalog.

## [0.1.15] - 2026-03-12

- Added optional `ADMIN_TOKENS_JSON` with scoped Admin API RBAC (`admin`/`viewer`) while keeping `ADMIN_TOKEN` backward compatible.
- Enforced write protection for Admin API mutating endpoints (`PUT/POST/DELETE`) so `viewer` tokens are read-only.
- Hardened audit attribution for scoped tokens by deriving actor from token identity instead of trusting `x-admin-actor`.
- Updated config snapshot schema/export/import, CLI non-loopback auth guard, and admin startup logging to support multi-token auth.
- Added Admin API tests for scoped RBAC behavior and actor anti-spoofing coverage.
- Updated `.env.example`, README, and ops docs with RBAC configuration guidance.

## [0.1.14] - 2026-03-12

- Added Admin Console service control actions on Global settings page:
  - `Restart Main Service`
  - `Restart Main + Admin`
- Added Admin API endpoint `POST /api/admin/service/restart` (token/cors protected) to trigger managed service restart.
- Added Codex binary auto-detection helper and startup fallback probing when configured `CODEX_BIN` is stale.
- Updated startup config loading to use preflight-resolved `CODEX_BIN`, reducing ENOENT failures after Codex install path changes.
- Updated `codeharbor init` to prefill `CODEX_BIN` with detected executable path.
- Updated `scripts/install-linux-easy.sh` to write detected absolute `CODEX_BIN` by default and support `--codex-bin`.

## [0.1.13] - 2026-03-05

- Re-released packaging/runtime restart-permission improvements from `0.1.12` on a new version due npm version lock conflict.
- `codeharbor service install --with-admin` and Linux easy install now auto-configure
  `/etc/sudoers.d/codeharbor-restart` for non-root service users.
- Admin API service restart supports non-interactive sudo fallback, reducing target-machine post-install fixes.

## [0.1.12] - 2026-03-05

- Made packaged service installs restart-ready without target-machine manual fixes:
  - `codeharbor service install --with-admin` now writes `/etc/sudoers.d/codeharbor-restart` for non-root service users.
  - Admin API service restart now supports non-interactive sudo fallback (`sudo -n systemctl ...`) when service user is not root.
  - `codeharbor service uninstall --with-admin` now removes the managed sudoers policy file.
- Updated `install-linux-easy.sh` to install matching sudoers policy when `--enable-admin-service` is used.
- Updated docs and tests for the new restart-permission behavior.

## [0.1.11] - 2026-03-05

- Added dedicated workflow unit tests for Phase B multi-agent runner:
  - `/agents` command parsing
  - reviewer malformed verdict fallback behavior
  - auto-repair round cap and session reuse behavior
  - cancellation propagation from orchestrator to runner
- Added matrix regression coverage for multi-agent command flow:
  - `/agents run` execution path
  - `/agents status` snapshot reporting
  - `/stop` cancellation during in-flight workflow
- Added Admin UI Playwright coverage for global `agentWorkflow` controls:
  - default value rendering for enable toggle and repair rounds
  - save + reload consistency
  - `.env` persistence assertions for workflow settings

## [0.1.10] - 2026-03-05

- Added Phase B opt-in multi-agent workflow engine (`Planner -> Executor -> Reviewer`) with automatic repair rounds.
- Added workflow chat commands:
  - `/agents run <objective>` to execute multi-agent pipeline
  - `/agents status` to inspect latest workflow state for current session
- Added workflow cancellation compatibility so existing `/stop` can cancel active multi-agent runs.
- Added new runtime config:
  - `AGENT_WORKFLOW_ENABLED` (default `false`)
  - `AGENT_WORKFLOW_AUTO_REPAIR_MAX_ROUNDS` (default `1`)
- Added Admin global-config support for `agentWorkflow` settings (API + UI + `.env` persistence).
- Fixed Admin runtime compatibility when legacy config objects do not include `agentWorkflow` (defaults now auto-filled).
- Improved `service` UX with automatic sudo elevation:
  - `codeharbor service install|restart|uninstall` now auto re-executes via sudo when needed.
  - no more mandatory `sudo "$(command -v codeharbor)" ...` in normal interactive environments.
- Updated docs and config snapshot export/import schema to include the new workflow settings.
- Added regression tests to verify:
  - legacy behavior remains unchanged when workflow is disabled
  - workflow execution/status works when explicitly enabled

## [0.1.9] - 2026-03-04

- Fixed systemd unit defaults to avoid Codex session write failures under user-home runtime.
- Changed generated service hardening from `ProtectHome=read-only` to `ProtectHome=false` for both main and admin units.
- Updated Linux easy installer unit templates with the same fix.

## [0.1.8] - 2026-03-04

- Fixed systemd service hardening conflict for user-home runtime directories (`~/.codeharbor`).
- Changed generated unit files from `ProtectHome=true` to `ProtectHome=read-only` so service can `chdir` into runtime home.
- Updated Linux easy installer unit template with the same `ProtectHome=read-only` compatibility fix.

## [0.1.7] - 2026-03-04

- Added `codeharbor service restart` command for one-command restart of systemd-managed service.
- Added `--with-admin` support for restart to restart main + admin services together.
- Improved service command error hints to use `sudo "$(command -v codeharbor)" ...` to avoid sudo PATH issues.

## [0.1.6] - 2026-03-04

- Added built-in `codeharbor service install` command to install and enable systemd service after npm installation.
- Added `codeharbor service uninstall` command for one-command service removal.
- Added optional service flags for admin unit install, custom run user/runtime home, and deferred startup.
- Updated README with post-install service lifecycle commands.

## [0.1.5] - 2026-03-04

- Changed default runtime home from `/opt/codeharbor` to user directory `~/.codeharbor` for global npm installs.
- Added backward compatibility: if `/opt/codeharbor/.env` already exists, CodeHarbor keeps using legacy `/opt/codeharbor`.
- Fixed CLI version output to read from `package.json` instead of hardcoded `0.1.0`.
- Hardened npm release workflow auth mode: supports Trusted Publishing (OIDC) and `NPM_TOKEN` fallback.

## [0.1.4] - 2026-03-04

- Migrated GitHub npm publish workflow to Trusted Publishing (OIDC) with `id-token: write`.
- Updated publish command to include provenance: `npm publish --provenance --access public`.
- Updated release documentation to use Trusted Publishing setup and removed `NPM_TOKEN` requirement.

## [0.1.3] - 2026-03-04

- Added strict changelog enforcement for release flow via `npm run changelog:check`.
- Added release workflow gate to block publish when the current package version has no changelog section.
- Added release process documentation updates and packaged tarball ignore rule.

## [0.1.2] - 2026-03-04

- Added fixed runtime home behavior (`/opt/codeharbor` by default) so users no longer need manual `cd` before `init/start`.
- Added Linux easy installer script (`scripts/install-linux-easy.sh`) for install + config + systemd bootstrap in one run.
- Improved Linux bootstrap flow with packaged `.env.example` fallback during `codeharbor init`.

## [0.1.1] - 2026-03-03

- Added config snapshot export/import workflow with schema validation and dry-run support.
- Added Admin hardening: non-loopback token guard, CORS origin allowlist, and security headers.
- Added backup automation scripts and release quality gates (lint + coverage checks).

## [0.1.0] - 2026-03-02

- Initial npm release for CodeHarbor TypeScript runtime.
- Included Matrix channel integration, Codex session orchestration, state persistence, and admin console baseline.
