# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and follows semantic versioning.

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
