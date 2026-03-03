# CodeHarbor Release Guide

## Scope

This document defines how CodeHarbor is packaged and published to npm with GitHub Actions.

## CI Baseline Checks

On `push` to `main` and pull requests, CI runs:

1. `npm ci`
2. `npm run typecheck`
3. `npm test`
4. `npm run test:e2e`
5. `npm run build`
6. `node dist/cli.js --help` (CLI smoke check)
7. `npm pack --dry-run` (package integrity check)

## npm Publish Triggers

Workflow: `.github/workflows/release-npm.yml`

Publish runs when one of these is true:

1. Manual trigger: `workflow_dispatch`
2. Commit message contains `[publish-npm]`
3. Commit message contains both:
   - `release` keyword
   - semver version string (example: `release v0.2.0`)

If the version already exists on npm, publish is skipped.

## Release Steps

1. Ensure working tree is clean and tests pass locally.
2. Bump version:
   - `npm version patch` or `npm version minor` or `npm version major`
3. Push commit to `main` with a publish-trigger message.
4. Wait for `Release NPM` workflow to finish.
5. Verify:
   - `npm view codeharbor version`
   - `npm install -g codeharbor@<version>`

## Required Secret

- `NPM_TOKEN`: npm access token with publish permission for `codeharbor`.
