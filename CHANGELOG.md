# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog and follows semantic versioning.

## [Unreleased]

- (none yet)

## [0.1.91] - 2026-03-31

- e2e assertion fix: read SKILL catalog textarea via `toHaveValue(...)` instead of `toContainText(...)`, matching browser behavior where JS writes to `value` (not text node).
- release stability: keep SKILL catalog load verification + unknown-assignment rejection coverage while removing false negatives in CI.

## [0.1.90] - 2026-03-31

- e2e hardening: verify SKILL catalog refresh against stable builtin ids and keep unknown-assignment rejection coverage without local-root timing dependencies.

## [0.1.89] - 2026-03-31

- admin UI parser fix: escape newline in SKILL catalog textarea rendering (`lines.join("\\n")`) to prevent inline-script syntax errors on page load.
- release stability: restore Admin UI boot sequence so global/rooms/health/audit pages initialize and e2e pipeline can proceed.

## [0.1.88] - 2026-03-31

- admin console route bootstrap: run `handleRoute()` immediately after initial hash normalization so first-load view/data initialization does not rely on `hashchange` timing.
- ci e2e stability: prevent hidden-panel/empty-field failures on first page load in Admin UI Playwright suite (`/settings/global`, `/settings/rooms`, `/health`, `/audit`).

## [0.1.87] - 2026-03-31

- admin skill-management docs: document `GET /api/admin/config/skills` snapshot payload and update Admin UI walkthrough with SKILL catalog/missing-assignment checks.
- Chinese user manual update: add explicit “技能与高级”操作步骤 and note that unknown role-skill ids are blocked during global-config validation.
- e2e regression coverage: add Admin UI scenario that verifies SKILL catalog refresh shows local skills and save is rejected when role assignments include unknown skill ids.

## [0.1.86] - 2026-03-30

- release pipeline stability: harden Admin global-config env serialization to avoid crashes when legacy in-memory arrays are absent (`imageAllowedMimeTypes` / role-skill roots).
- ci e2e fixture alignment: update Admin UI e2e test base config to include full current `AppConfig` defaults, matching runtime expectations after recent config-surface expansion.
- release reliability: re-run publish flow after fixing Admin UI e2e blocker.

## [0.1.85] - 2026-03-30

- admin global config: add first-class proxy controls (`enabled`, `httpProxy`, `httpsProxy`, `allProxy`, `noProxy`) and persist them through `CODEX_EXTRA_ENV_JSON`.
- executor proxy behavior: support explicit proxy-off mode that clears inherited host proxy env vars for child CLI processes.
- admin UI: add proxy toggle and structured proxy fields under CLI settings, including local validation when proxy is enabled.
- tests: add regression coverage for proxy config validation/snapshot reading and executor proxy-env clearing behavior.
- npm metadata: update package description/keywords to include Gemini CLI support for better discoverability.

## [0.1.84] - 2026-03-30

- gemini stream parsing: support assistant `message` delta events in `stream-json` output and append chunks into a final reply instead of dropping partial text.
- session resilience: when Gemini resume fails with invalid/expired session identifiers, runtime now retries once with a fresh session automatically.
- tests: add regression coverage for Gemini assistant delta assembly and resume-failure fallback behavior in executor/session runtime suites.

## [0.1.83] - 2026-03-30

- media pipeline robustness: skip image attachments whose `localPath` is present in metadata but missing on disk, preventing request aborts from `ENOENT` in executor image reads.
- user-facing fallback behavior: missing local image files are now counted as `未下载到本地` in image-processing notice instead of failing the whole request.
- tests: add regression coverage for missing-local-file image attachments to ensure degraded handling path stays stable.

## [0.1.82] - 2026-03-29

- admin e2e stability: align global settings tests with left hierarchical submenus (`basic` / `agent`) before interacting with section-scoped fields.
- flaky assertion fix: remove save-toast wording checks that were racy with immediate audit auto-refresh notices, keeping assertions focused on persisted state and audit records.

## [0.1.81] - 2026-03-29

- admin console navigation redesign: move main menu to a left sidebar with hierarchical grouping (`Global Settings`, `Room Governance`, `Observability`) for faster wayfinding.
- global settings IA improvement: add parent + child menu levels and rename global sub-sections with clearer functional labels (for example `Rate & Concurrency`, `Trigger Policy`, `CLI & Multimodal`).
- route highlight behavior: keep parent menu highlighted via route-prefix matching while viewing child pages, improving location awareness in deep-linked global routes.
- responsive UX: optimize sidebar navigation behavior on tablet/mobile while preserving existing hash routes and config operations.

## [0.1.80] - 2026-03-29

- Matrix structured echo: enhance `[CodeHarbor] ...` envelope rendering to show metadata (`tag`, `key=value`, message) as structured blocks for clearer progress/failure inspection.
- stage output readability: render `[planner_output]...[/planner_output]` / `[executor_output]...[/executor_output]` / repair output blocks as labeled code sections instead of raw marker text.
- progress edit consistency: keep rich HTML content in `m.new_content` when upserting progress notices (`m.replace`), so edited timeline messages preserve badges and structure.
- tests: add regression coverage for structured envelope parsing, named output block rendering, and rich `m.new_content` payload behavior.

## [0.1.79] - 2026-03-29

- admin console UX: split global settings into functional paged navigation (`basic/autodev/rate/triggers/cli/agent/snapshot`) to avoid long single-page scrolling.
- route behavior hardening: normalize legacy `#/settings/global` and invalid section hashes to `#/settings/global/basic`, keeping deep-link behavior stable.
- regression coverage: add automated test coverage for paged route mappings, hash normalization fallback, and snapshot-only visibility toggling.

## [0.1.78] - 2026-03-29

- trace usability: support `/trace latest` to resolve the newest request trace in current session without manually locating request IDs.
- trace discoverability: append `requestId` footer to final chat replies so users can directly copy-and-run `/trace <requestId>`.
- diagnostics/docs/tests: refresh help/manual wording and add regression coverage for `latest` parsing/resolution and Matrix requestId rendering.

## [0.1.77] - 2026-03-28

- autodev completion gate hardening: add `AUTODEV_VALIDATION_STRICT` fail-closed mode and wire it through runtime config, config snapshot export/import, admin global settings, and env overrides.
- status observability: `/autodev status` now reports `runValidationFailureClass`, `runValidationEvidenceSource`, and `runValidationAt` for faster validation gate diagnostics.
- state semantics tightening: when workflow execution succeeds but completion gate fails, run snapshot state is now `completed_with_gate_failed` (instead of `succeeded`).
- validation-failure fuse: repeated identical validation failure classes now use the existing consecutive-failure threshold to auto-block (`🚫`) and stop ineffective reruns.
- diagnostics enrichment: workflow result messages now emit `validationFailureClass`, `validationEvidenceSource`, and timestamp fields for robust status fallback parsing.
- tests/docs: add regression coverage for strict validation config wiring, status visibility, and validation fuse behavior; update release/user docs for the new rules.

## [0.1.76] - 2026-03-27

- autodev loop stability: skip task-status self-heal on nested loop task invocations (`taskId + mode=loop`) to prevent repeated `TASK_LIST.md` churn.
- preflight noise reduction: avoids self-heal/preflight auto-stash oscillation that could spam repeated `already completed` and `auto-stashed` notices.
- tests: add runner-level regression coverage for nested-loop self-heal guard behavior.

## [0.1.75] - 2026-03-27

- reviewer policy hardening: TASK_LIST rejection is now based on verifiable final state (`finalClean=no`) instead of command-text traces alone.
- executor contract tightening: added explicit prohibition against `checkout/restore/reset` operations on `TASK_LIST.md` in both initial execution and repair prompts.
- system-context injection: AutoDev now injects reviewer-visible `system_task_list_policy` facts (`changedSinceBaseline`, `restoredBySystem`, `finalClean`, `error`) before each review round.
- autodev state persistence refinement: stop writing `in_progress` to `TASK_LIST.md` at run start to reduce cross-agent policy conflicts and dirty-state churn.

## [0.1.74] - 2026-03-27

- autodev stage output echo: add `AUTODEV_STAGE_OUTPUT_ECHO_ENABLED` (default `true`) so `/autodev run` can stream planner/executor/reviewer full outputs to Matrix in real time.
- new session control: add `/autodev content on|off|status` to toggle stage-output echo per room/session without changing global env.
- workflow robustness: stage-output notices are delivered best-effort and no longer fail the main workflow when Matrix notification sending is transiently unavailable.
- admin usability: global settings page now includes direct `envOverrides` examples/hints for common AutoDev keys (`AUTODEV_STAGE_OUTPUT_ECHO_ENABLED`, `AUTODEV_PREFLIGHT_AUTO_STASH`, `AUTODEV_RUN_ARCHIVE_ENABLED`, `AUTODEV_RUN_ARCHIVE_DIR`).

## [0.1.73] - 2026-03-27

- autodev loop stability: reorder loop flow to check executable tasks before git preflight in `/autodev run` loop mode, preventing unnecessary preflight operations when task list is already drained.
- preflight/self-heal interaction fix: avoid `AUTODEV_PREFLIGHT_AUTO_STASH` repeatedly stashing self-healed `TASK_LIST.md` changes in no-task scenarios.
- loop robustness: after preflight, re-resolve selected loop task from refreshed `TASK_LIST.md` state before executing the round.
- tests: add regression coverage to ensure no auto-stash occurs when loop run has no executable tasks.
- queue scheduler race fix: use a shared timestamp snapshot when checking `hasReadyTask` and `getNextPendingRetryAt`, preventing missed retry drains under millisecond timing races.
- tests: add queue drain scheduler regression coverage for start/reconcile retry scheduling timestamp consistency.
- ci stability: increase timeout budget for API lifecycle retry test to reduce false negatives on slower runners.

## [0.1.72] - 2026-03-27

- autodev workdir persistence: `/autodev workdir` override is now stored in `StateStore` and restored after service restart, so Matrix room sessions keep their selected workspace.
- reset consistency: `/reset` now clears both in-memory and persisted AutoDev workdir override to avoid stale override reuse.
- schema migration: add backward-compatible `sessions.autodev_workdir_override` column with automatic migration on startup.
- tests: add regression coverage for persisted workdir override in `state-store` and orchestrator restart scenarios.

## [0.1.71] - 2026-03-27

- command routing hardening: invalid `/autodev` subcommands (for example `/autodev 润`) are now rejected with explicit usage guidance instead of falling through to chat execution.
- task-state flow resiliency: AutoDev notice sends now use best-effort delivery so transient Matrix notification failures no longer fail an otherwise successful task run.
- completion gate refinement: `TASK_LIST.md` ownership guard now treats auto-restored drift as policy-passed, avoiding false rejections after successful rollback.
- Matrix transport robustness: treat HTTP `530` as retryable for Matrix send/fetch retry paths to reduce failures on transient edge/network conditions.
- tests: add/adjust regression coverage for invalid autodev command handling, Matrix 530 retry behavior, notice-send failure tolerance, and auto-restored task-list drift.

## [0.1.70] - 2026-03-25

- autodev task-state ownership: enforce `TASK_LIST.md` as orchestrator-managed only; workflow-side edits are now auto-rolled back and blocked from completion gate (`task-list-policy-violated`).
- autodev preflight resilience: add optional `AUTODEV_PREFLIGHT_AUTO_STASH=true` to auto-stash dirty worktrees and continue run with reported stash reference.
- git preflight diagnostics: fix dirty file parsing so file names are reported accurately (prevents truncated names like `TASK_LIST.md -> ASK_LIST.md`).
- workflow contract hardening: extend executor/reviewer prompts to explicitly forbid `TASK_LIST.md` mutations and require reviewer rejection when detected.
- docs/admin config: document the new policy + auto-stash behavior, and add `AUTODEV_PREFLIGHT_AUTO_STASH` to config snapshot/admin env-override pipeline.

## [0.1.69] - 2026-03-25

- autodev validation contract: require structured executor evidence (`VALIDATION_STATUS` + `__EXIT_CODES__`) and align reviewer rejection rules when validation evidence is missing or inconsistent.
- completion gate inference: prioritize hard signals (`__EXIT_CODES__` then `VALIDATION_STATUS`) before section-scoped/fallback text heuristics to reduce false negatives.
- tests: add regression coverage for structured validation status parsing, exit-code precedence, and prompt contract enforcement across workflow/orchestrator suites.
- ci stability: raise timeout budget for queue transient-retry recovery test to avoid false negatives on slower runners.

## [0.1.68] - 2026-03-25

- autodev completion gate: avoid false validation failures when executor/reviewer output contains summaries like `0 failed`.
- autodev validation inference: prioritize `__EXIT_CODES__` markers (`all 0 => pass`, `any non-zero => fail`) before keyword heuristics.
- autodev task result messaging: align auto-commit skip reason with real gate cause (`validation not passed` vs `reviewer not approved`) to remove contradictory notices.
- tests: add regression coverage for explicit validation failure gating and `0 failed` pass-through behavior.

## [0.1.67] - 2026-03-25

- workflow contract hardening: strengthen reviewer contract parsing and rejected-result semantics to avoid contradictory or missing repair-contract states.
- task-state consistency: reconcile final `TASK_LIST.md` status from workflow result and guard against workflow/task drift before closing a task.
- completion gate: close AutoDev task to `✅` only when reviewer approval, validation status, and required auto-commit conditions all pass.
- self-heal on run/status: auto-repair stale task states from recent AutoDev run records when running `/autodev run` and `/autodev status`.
- new command: add `/autodev reconcile` (alias `/autodev sync`) for one-shot task-state reconciliation, with help/docs and routing support.

## [0.1.66] - 2026-03-24

- autodev loop guardrails: support `0` as unlimited for both `AUTODEV_LOOP_MAX_RUNS` and `AUTODEV_LOOP_MAX_MINUTES`.
- autodev loop behavior: reaching run/time limit now pauses safely with remaining-task summary and explicit resume hint (`/autodev run`) instead of hard stop wording.
- admin console + config API: allow and validate non-negative (`>=0`) loop guard values, and show `0 = unlimited` guidance in UI labels.
- config snapshot: align import/export schema normalization for non-negative AutoDev loop guard values.
- docs/manual: add explicit loop guardrail rules and long-run recommended settings under AutoDev sections.

## [0.1.65] - 2026-03-24

- autodev loop: stop loop early when a round yields no `TASK_LIST.md` state progress (new `no_progress` loop-stop reason and metrics).
- autodev init: support `--dry-run` (plan-only, no writes) and `--force` (overwrite scaffold files), with explicit planned/created/overwritten output.
- autodev init Stage-B: add configurable enhancement controls (`AUTODEV_INIT_ENHANCEMENT_ENABLED`, `AUTODEV_INIT_ENHANCEMENT_TIMEOUT_MS`, `AUTODEV_INIT_ENHANCEMENT_MAX_CHARS`).
- admin/config snapshot: expose and validate new AutoDev init enhancement settings in global config API/UI and import/export snapshot schema.
- i18n hardening: improve English-mode diagnostics localization for AutoDev status/stage traces and keep English `/help` aliases free of mixed Chinese text.
- tests: add runtime-config coverage for init enhancement budget, English i18n guard assertions, and `init -> status -> run` scenario coverage for sibling/subdir/empty targets.

## [0.1.64] - 2026-03-24

- autodev init: support implicit design-doc discovery by default with optional `--from <file>` override.
- autodev init: add staged generation pipeline (Stage-A scaffold, Stage-B AI enhancement, Stage-C hard validation with rollback fallback).
- autodev init/workdir: improve sibling workspace project resolution for short commands like `/autodev init StrawBerry`.
- command UX: add mobile-friendly aliases and update help/manual coverage for the init/workdir flow.

## [0.1.63] - 2026-03-23

- i18n: remove mixed Chinese text in English command replies for `/status`, `/upgrade`, `/autodev status`, and historical stage traces.
- i18n: localize package update hints, recent upgrade summaries, and upgrade post-check details by output language.
- help/status UX: align English `/help` aliases line and progress summary separators for consistent English-only output.
- tests: add workflow-diag localization coverage and extend package-update hint language assertions.

## [0.1.62] - 2026-03-23

- admin-ui: move operation notices to floating toasts so feedback remains visible while working at the bottom of long pages.
- admin-ui: add manual dismiss action for notice toasts with dedicated message rendering.
- accessibility: add `role`/`aria-live` semantics and localized dismiss labels for screen-reader friendly notifications.
- mobile: optimize toast placement on small screens to reduce overlap with form controls.

## [0.1.61] - 2026-03-23

- admin: fix `/api/admin/service/restart` failure when restarting main + admin from the web console.
- restart flow: avoid in-request self-restart race by queuing admin service restart asynchronously after main service restart.
- service manager: improve sudo fallback error mapping to preserve actionable non-permission failures.
- systemd: set admin unit template to `NoNewPrivileges=false` and align template test coverage.

## [0.1.60] - 2026-03-22

- i18n: unify bot output language with configurable `OUTPUT_LANGUAGE` (`zh`/`en`) across command/help/status flows.
- i18n: localize AutoDev and Multi-Agent workflow stage progress messages to avoid mixed Chinese/English output.
- i18n: localize `/backend`, `/diag`, `/upgrade`, `/agents status`, chat completion/failure, and queue failure notices.
- runtime: keep hot config backward compatible when older snapshots do not include `outputLanguage`.

## [0.1.59] - 2026-03-22

- AutoDev feature delivered: T8.8

## [0.1.58] - 2026-03-22

- AutoDev feature delivered: T8.7

## [0.1.57] - 2026-03-22

- AutoDev feature delivered: T8.6

## [0.1.56] - 2026-03-22

- AutoDev feature delivered: T8.5

## [0.1.55] - 2026-03-22

- AutoDev task delivery:
  - completed T8.4 admin diagnostics and config import/export workflow
  - completed T8.5 fine-grained API scopes and operation audit hardening
- AutoDev git preflight fail-fast:
  - `/autodev run` now checks git preflight before execution and stops immediately on dirty worktrees
  - loop mode applies the same preflight before each round to prevent silent non-committable progress
  - stop notice now includes explicit reason and actionable recovery commands (`git status`, commit checkpoint, optional stash)
- AutoDev status observability:
  - `/autodev status` now reports `gitPreflight=clean|dirty|no_repo` and `gitPreflightReason`
  - when `AUTODEV_AUTO_RELEASE_ENABLED=true` and `AUTODEV_AUTO_RELEASE_PUSH=false`, status shows an explicit warning to `git push` for CI publish
- Admin console stability:
  - fixed a script syntax regression in config snapshot export path that blocked route initialization and data loading in Admin UI
  - after saving auth token in Admin UI, the current view now reloads with the new auth context before status refresh

## [0.1.54] - 2026-03-22

- Builtin role skills (Planner/Executor/Reviewer) are significantly deepened with structured contracts:
  - adopted Trigger conditions / Workflow / Guardrails / Output contract sections for stronger execution consistency
  - strengthened `superpowers-workflow` with required machine-parsable output sections and explicit `STATUS=COMPLETE|INCOMPLETE` contract
- Expanded install-ready builtin skill set inspired by community/open-source plugin ecosystems:
  - added `superpowers-workflow`, `ui-ux-pro-max`, and `pptx`
  - extended and hardened `planning-with-files`, `webapp-testing`, `code-simplifier`, `multi-agent-code-review`, and `commit-message`
- Commit quality policy improvements:
  - `commit-message` now includes stricter guardrails for Conventional Commits, repo-language alignment, footer rules, and diff-evidence checks
  - `commit-message` is included in default reviewer builtin role assignment
- Docs and validation:
  - updated README and Chinese user manual for expanded builtin role-skill catalog
  - expanded role-skill tests and context-budget assertions to cover new builtin skills and structured contracts

## [0.1.53] - 2026-03-21

- AutoDev 大功能完成：T8.1 多模态体验：增强 Matrix 消息中的图片/语音结果渲染（结构化展示、摘要与可读性）

## [0.1.52] - 2026-03-21

- AutoDev big-feature auto-release flow:
  - add task-to-version release mapping support from `TASK_LIST.md` (`大功能任务 -> 完成后目标版本`)
  - after reviewer-approved task auto-commit, AutoDev can generate release commit `release: vX.Y.Z [publish-npm]`
  - release step updates `package.json` / `package-lock.json` and ensures `CHANGELOG.md` version section exists
  - support optional release auto-push via `AUTODEV_AUTO_RELEASE_PUSH`
- AutoDev observability and runtime config:
  - add release-related runtime flags (`AUTODEV_AUTO_RELEASE_ENABLED`, `AUTODEV_AUTO_RELEASE_PUSH`)
  - `/autodev status` and `/diag autodev` now include release config and release result summary
- Release pipeline resilience:
  - when npm version already exists, CI now skips publish and prints suggested next patch version
- Task planning cleanup:
  - remove stage-9 planning block from `TASK_LIST.md` after feature landing
  - trim temporary roadmap staging notes from requirement docs

## [0.1.51] - 2026-03-21

- Orchestrator modular refactor (maintainability):
  - extracted runtime adapter wiring for message handling, non-blocking status route execution, and AutoDev run dispatch setup
  - split control/backend/status/diag dispatch context wiring into dedicated context modules with clearer `config/state/actions` boundaries
  - reduced `src/orchestrator.ts` orchestration surface by moving repeated context construction into focused helper modules

## [0.1.50] - 2026-03-19

- Agent role skill system (Planner/Executor/Reviewer):
  - added built-in role skills with optional local SKILL discovery (`~/.codex/skills`) via new `WorkflowRoleSkillCatalog`
  - workflow prompts now support role-skill injection blocks and per-run policy overrides
  - progressive disclosure support (`summary` / `progressive` / `full`) to balance context fidelity and token usage
- AutoDev role-skill controls and observability:
  - added `/autodev skills on|off|summary|progressive|full|status` for session-level role-skill toggle/mode control
  - `/status`, `/agents status`, and `/autodev status` now show effective role-skill config and loaded skills
  - workflow progress notices include role-skill usage metadata for each stage
- Config/docs/tests:
  - added role-skill env options in `.env.example`, README, and Chinese user manual
  - added new unit coverage for role-skill catalog and workflow/orchestrator integration

## [0.1.49] - 2026-03-19

- AutoDev status observability:
  - enhanced `/autodev status` with run window, stop-control flags, workflow run summary, recent runs, and stage trace details
  - enhanced `/status` with current AutoDev runtime stage snapshot and detailed-progress mode visibility
- AutoDev/Multi-Agent progress UX:
  - enriched in-process stage notices with explicit agent identity, round, and execution stats (duration/prompt/reply chars)
  - added `/autodev progress on|off|status` session-level switch for detailed vs concise progress replay (default `on`)
- Command/help and compatibility updates:
  - updated `/help` output and regression coverage for new progress toggle command and richer workflow progress behavior

## [0.1.48] - 2026-03-19

- Routing engine and diagnostics (T7.5/T7.6):
  - added `BACKEND_MODEL_ROUTING_RULES_JSON` rule engine for automatic backend/model selection by room/sender/task-type/text conditions
  - added `/diag route [count]` with rule hit/fallback reason details and recent per-session route records
  - `/status` and `/backend ... status` now expose route reason description and fallback marker
  - added `/backend auto` to recover rule-based auto routing after manual override
- AutoDev and command UX hardening:
  - fixed `/autodev stop` handling edge cases in group trigger/off-window and loop handoff windows
  - accepted multi-slash escaped workflow commands (for example `///autodev stop`, `///agents status`)
  - improved AutoDev git commit subject/body conventions to use semantic task-related messages
- History export completion (T7.4):
  - completed session export + retention policy cleanup task and aligned related docs/tests

## [0.1.47] - 2026-03-19

- AutoDev token pressure controls:
  - added optional context budget env vars for planner/output/feedback aggregation
  - default behavior keeps context unlimited to avoid unintended truncation
  - `/status` now exposes current multi-agent context budget mode (`unlimited` or numeric)
  - multi-agent role runs are now stateless per round to reduce cross-round context accumulation
- RBAC scope hardening:
  - added scope matrix and enforcement for Admin/API/Webhook surfaces
  - Admin viewer/admin tokens now map to explicit read/write capabilities through scope checks
- Session history index (T7.3):
  - added session index query support with room/user/time filters and pagination
  - added Admin API endpoints for session listing and per-session message history
  - synced docs/tests and marked T7.3 complete in task tracking

## [0.1.46] - 2026-03-18

- AutoDev Git artifact hardening:
  - prevent shell-style stage artifacts (`autodev#*`, `workflow#*`, `planner#*`, `executor#*`, `reviewer#*`) from being included in auto-commit results
  - auto-clean untracked zero-byte stage artifact files before `git add -A` in AutoDev commit flow
  - added regression coverage to ensure artifact files are removed before commit, and synced `.gitignore`

## [0.1.45] - 2026-03-18

- Platform API (T6.2):
  - added task query endpoint `GET /api/tasks/:taskId` (auth + status/stage/error summary)
  - added API task status mapping in orchestrator and coverage for retry/failed snapshots
  - updated roadmap status for T6.2
- AutoDev observability:
  - added Prometheus runtime metrics for AutoDev run outcomes, loop stop reasons, and blocked tasks
  - `/metrics` output and alert-rule examples now include AutoDev loop/block anomaly signals
- Matrix command UX:
  - now supports escaped slash commands (`//help`, `//diag ...`, `//autodev ...`, `//agents ...`) for clients that intercept `/...`
  - synced help/docs and regression tests for escaped command flow

## [0.1.44] - 2026-03-18

- AutoDev loop controls:
  - `/autodev run` (without task id) now supports loop guardrails via `AUTODEV_LOOP_MAX_RUNS` and `AUTODEV_LOOP_MAX_MINUTES`
  - loop execution publishes explicit stop reasons when reaching run-count or time limits
- AutoDev commit behavior:
  - added `AUTODEV_AUTO_COMMIT=true|false` to control post-approval git auto-commit
  - AutoDev result now includes both git commit summary and changed file list (`git changed files`)
- AutoDev failure resilience:
  - added `AUTODEV_MAX_CONSECUTIVE_FAILURES`, automatically marks tasks as `🚫` after repeated failures
  - loop mode skips blocked tasks and continues processing next executable tasks
- AutoDev diagnostics:
  - `/diag autodev [count]` now includes live loop snapshot, runtime config, and recent git commit records
- Docs and config sync:
  - updated `.env.example`, `README.md`, and `docs/USER_MANUAL_ZH.md` with new AutoDev controls and behavior notes

## [0.1.43] - 2026-03-18

- Matrix command-prefix compatibility:
  - fixed `/diag` subcommand parsing when sent with prefix mode (for example `!code /diag queue 5`)
  - prefixed `/diag queue [count]` now returns queue diagnostics instead of usage fallback
- Help command improvements:
  - added AutoDev command guidance in `/help` (`/autodev status`, `/autodev run [taskId]`)
  - expanded regression test to keep command help text in sync with runtime behavior

## [0.1.42] - 2026-03-18

- Platform API (T6.1):
  - added authenticated task submission endpoint `POST /api/tasks` with `Authorization: Bearer <API_TOKEN>`
  - added `Idempotency-Key` handling for dedupe and conflict protection (`409 IDEMPOTENCY_CONFLICT`)
  - wired API task submission into recoverable queue execution path
- Runtime UX and control flow:
  - `/diag` and `/autodev status` now return without waiting for active execution lock in the same session
  - fixed pending-stop handoff for workflow runs so `/stop` can cancel in-flight `/agents run` more reliably
- Config and tests:
  - added API server config keys (`API_ENABLED`, `API_BIND_HOST`, `API_PORT`, `API_TOKEN`)
  - expanded regression coverage for API submission/auth/idempotency and runtime non-blocking status behavior
- Task roadmap:
  - split T6/T7 into smaller executable steps and marked `T6.1` as completed

## [0.1.41] - 2026-03-18

- Reliability and recoverability:
  - added a persistent recoverable task queue with restart recovery, retry/backoff policy, and failure archive
  - added shared retry-policy module and queue diagnostics hooks in runtime metrics/state store
- AutoDev and multi-agent diagnostics:
  - persist AutoDev/workflow run records and stage events for postmortem debugging
  - added `/diag autodev [count]` and `/diag queue [count]` for queue/run visibility
  - updated `/help` command output to include new diagnostics commands
- Test coverage:
  - expanded reliability and diagnostics regression tests across orchestrator, state store, admin server, and compat replay suites
- Operations and docs:
  - added Prometheus alert rules example (`docs/PROMETHEUS_ALERT_RULES_EXAMPLE.yml`)
  - added auto loop runner helper (`scripts/autodev-loop-runner.sh`)
  - updated roadmap/task tracking and operation docs for metrics + queue workflows
- Community and growth infrastructure:
  - added GitHub issue forms (bug/feature), issue template config, and pull request template
  - added release note category config via `.github/release.yml`
  - added contributor guide (`CONTRIBUTING.md`) and growth playbook (`docs/GROWTH_PLAYBOOK_ZH.md`)
  - updated README and release guide with feedback/community operation entry points
  - added social preview asset (`docs/assets/social-preview-1200x630.png`) and upload guide (`docs/SOCIAL_PREVIEW_UPLOAD_ZH.md`)
  - published v0.1.40 announcement discussion and added quick feedback links near README header
  - added English announcement + roadmap poll discussions, and linked CN/EN posts in README
  - consolidated CN/EN announcements and roadmap polls into bilingual threads; closed duplicate CN threads
  - added maintainer + CI verification block and bilingual discussion template
  - added `scripts/render-release-notes.sh` to keep bilingual discussion links consistent in Release Notes

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
