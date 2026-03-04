# CodeHarbor Release Guide

## Scope

This document defines how CodeHarbor is packaged and published to npm with GitHub Actions.

## CI Baseline Checks

On `push` to `main` and pull requests, CI runs:

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm test`
5. `npm run test:coverage`
6. `npm run test:e2e`
7. `npm run build`
8. `node dist/cli.js --help` (CLI smoke check)
9. `npm pack --dry-run` (package integrity check)

On publish-intent runs, release workflow additionally enforces:

10. `npm run changelog:check` (must contain changelog notes for current package version)

## npm Publish Triggers

Workflow: `.github/workflows/release-npm.yml`

Publish runs when one of these is true:

1. Manual trigger: `workflow_dispatch`
2. Commit message contains `[publish-npm]`
3. Commit message contains both:
   - `release` keyword
   - semver version string (example: `release v0.2.0`)

If the version already exists on npm, publish is skipped.

## npm Publish Auth Modes

CodeHarbor release workflow supports two auth modes:

1. Preferred: npm Trusted Publishing (OIDC)
2. Fallback: repository secret `NPM_TOKEN`

### Preferred: Trusted Publishing (OIDC)

Configure once in npm package settings:

1. Open npm package settings -> Trusted publishing.
2. Add publisher with:
   - Provider: GitHub Actions
   - Repository: `biglone/CodeHarbor`
   - Workflow file: `.github/workflows/release-npm.yml`
3. Save and verify the publisher status is active.

### Fallback: `NPM_TOKEN` secret

If Trusted Publishing is not available yet, add repository secret `NPM_TOKEN` (npm automation token).
The workflow will automatically prefer token mode when this secret exists.

## Release Steps

1. Ensure working tree is clean and tests pass locally.
2. Export a pre-release config snapshot backup:
   - `./scripts/backup-config.sh`
3. Optionally validate latest snapshot:
   - `codeharbor config import <snapshot-file> --dry-run`
4. Update `CHANGELOG.md` with a new section for target version and notable bullet points.
5. Bump version:
   - `npm version patch` or `npm version minor` or `npm version major`
6. Validate changelog entry:
   - `npm run changelog:check`
7. Push commit to `main` with a publish-trigger message.
8. Wait for `Release NPM` workflow to finish.
9. Verify:
   - `npm view codeharbor version`
   - `npm install -g codeharbor@<version>`

## Rollback Playbook

If release regression impacts runtime behavior:

1. Revert to previous known-good package version or commit.
2. Restore config from snapshot:
   - `codeharbor config import <snapshot-file> --dry-run`
   - `codeharbor config import <snapshot-file>`
3. Restart services.
4. Confirm health:
   - Admin UI `/health`
   - `codeharbor doctor`
   - Matrix end-to-end smoke message

## Backup Automation

For periodic snapshot backups:

- Manual: `./scripts/backup-config.sh`
- Automated timer: `./scripts/install-backup-timer.sh`
- Full guide: `docs/BACKUP_AUTOMATION.md`

## Secret Requirement

`NPM_TOKEN` is optional and only needed as fallback when Trusted Publishing is not configured.
