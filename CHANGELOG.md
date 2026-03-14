# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and follows semantic versioning.

## [Unreleased]

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
