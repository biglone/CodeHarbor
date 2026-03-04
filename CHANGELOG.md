# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and follows semantic versioning.

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
