# CodeHarbor Release Guide

## Scope

This document defines how CodeHarbor is packaged and published to npm with GitHub Actions.

## CI Baseline Checks

On `push` to `main` and pull requests, CI runs:

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run docs:check-release-index`
5. `npm run docs:check-consistency`
6. `npm test`
7. `npm run test:coverage` (includes core-module coverage guard)
8. `npm run test:e2e`
9. `npm run build`
10. `node dist/cli.js --help` (CLI smoke check)
11. `npm pack --dry-run` (package integrity check)

On publish-intent runs, release workflow additionally enforces:

12. `npm run changelog:check` (must contain changelog notes for current package version)

## npm Publish Triggers

Workflow: `.github/workflows/release-npm.yml`

Publish runs when one of these is true:

1. Manual trigger: `workflow_dispatch`
2. Commit message contains `[publish-npm]`
3. Commit message contains both:
   - `release` keyword
   - semver version string (example: `release v0.2.0`)

If the version already exists on npm, publish is skipped and workflow logs include a suggested next patch version (`Suggested next version`).

## Failed Publish Retry Policy (No Version Skip)

If a release run fails before npm publish, do not bump to the next version.

- Keep `package.json` + `CHANGELOG.md` at the failed target version.
- Fix CI/workflow blockers in follow-up commits without changing version.
- Re-run publish for the same version:
  - `workflow_dispatch`, or
  - push a commit with `[publish-npm]`.
- The `Release NPM` workflow now enforces no skipped version progression by default.

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
6. Run release verification:
   - `npm run release:verify`
7. Push commit to `main` with a publish-trigger message.
8. Wait for `Release NPM` workflow to finish.
9. Verify:
   - `npm view codeharbor version`
   - `npm install -g codeharbor@<version>`
10. Generate release notes from the bilingual template:
   - `ANNOUNCEMENT_URL=<link> POLL_URL=<link> ./scripts/render-release-notes.sh`
   - replace highlight bullets with the release summary
11. Update release notes links in `README.md`:
   - update `Latest release notes` and `Latest bilingual announcement`
   - append the new version entries under `Release Notes Index`
12. Publish community notes:
   - create GitHub Release notes (auto-generated + hand edits)
   - open/update a Discussions `Announcements` post and link feedback channels

If your machine has no system Chrome, run `npm run e2e:install` once before `npm run release:verify`.

## Release Notes Index Convention

When adding a new release under `docs/releases/`, keep `README.md` in sync in the same PR/commit:

1. Update `Latest release notes` link to current version.
2. Update `Latest bilingual announcement` link to current version.
3. Append both links to `Release Notes Index` (do not remove historical entries).

### AutoDev big-feature release flow

When AutoDev completes a mapped big-feature task (for example `T8.4`), it can generate:

- task commit (feature implementation)
- release commit: `release: vX.Y.Z [publish-npm]`

The release commit updates:

- `package.json`
- `package-lock.json` (if present)
- `CHANGELOG.md`

AutoDev release mapping parser only reads the dedicated section whose heading contains `发布映射` (or `release mapping`) in `TASK_LIST.md`.
This avoids accidentally reading community-priority/milestone tables that are not release contracts.

Recommended section template:

```md
## 大功能 -> 发布映射（执行约定）
| 大功能任务 | 完成后目标版本 | 发布提交示例 | 发布状态 |
|------------|----------------|--------------|----------|
| T8.7 | v0.1.58 | `release: v0.1.58 [publish-npm]` | ⬜ 待发布 |
```

Current roadmap-based release milestones (updated on 2026-03-22):

| Community priority | Executable milestone | Tasks | Version window |
|--------------------|----------------------|-------|----------------|
| Experience & delivery | M1: multimodal + install/upgrade | T8.1,T8.2,T8.3 | v0.1.53 ~ v0.1.54 |
| Governance & security | M2: admin + audit hardening | T8.4,T8.5 | v0.1.55 ~ v0.1.56 |
| Ecosystem integration | M3: Matrix workflow + external integrations | T8.6 | v0.1.57 |
| Release convergence | M4: mapping + docs acceptance | T8.7,T8.8 | v0.1.58 ~ v0.1.59 |

After pushing to `main`, `Release NPM` workflow is triggered by `[publish-npm]`.

## AutoDev Phase-10 Rollout Checklist

- For phased enablement by module boundary (control/policy/integration), use `docs/AUTODEV_ROLLOUT_ROLLBACK_CHECKLIST_ZH.md`.
- Includes first rehearsal record dated 2026-04-06 and rollback decision gates.

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
