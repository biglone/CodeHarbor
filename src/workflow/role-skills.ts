import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type WorkflowRole = "planner" | "executor" | "reviewer";
export type WorkflowRoleSkillDisclosureMode = "summary" | "progressive" | "full";
export type WorkflowRoleSkillDisclosureLevel = "summary" | "full";

export interface WorkflowRoleSkillPolicyOverride {
  enabled?: boolean;
  mode?: WorkflowRoleSkillDisclosureMode;
}

export interface WorkflowRoleSkillCatalogOptions {
  enabled?: boolean;
  mode?: WorkflowRoleSkillDisclosureMode;
  maxChars?: number;
  roots?: string[];
  roleAssignments?: Partial<Record<WorkflowRole, string[]>>;
}

export interface WorkflowRoleSkillPromptInput {
  role: WorkflowRole;
  stage: "planner" | "executor" | "reviewer" | "repair";
  round: number;
  policy?: WorkflowRoleSkillPolicyOverride;
}

export interface WorkflowRoleSkillPromptResult {
  text: string | null;
  enabled: boolean;
  mode: WorkflowRoleSkillDisclosureMode;
  disclosure: WorkflowRoleSkillDisclosureLevel | null;
  usedSkills: string[];
}

export interface WorkflowRoleSkillStatusSnapshot {
  enabled: boolean;
  mode: WorkflowRoleSkillDisclosureMode;
  maxChars: number;
  roots: string[];
  roleAssignments: Record<WorkflowRole, string[]>;
  loadedSkills: Record<WorkflowRole, string[]>;
}

interface WorkflowSkillEntry {
  id: string;
  title: string;
  summary: string;
  content: string;
  source: "builtin" | "local";
}

const DEFAULT_ROLE_SKILL_MAX_CHARS = 2_400;
const DEFAULT_ROLE_SKILL_ROOT = path.join(os.homedir(), ".codex", "skills");

const DEFAULT_ROLE_ASSIGNMENTS: Record<WorkflowRole, string[]> = {
  planner: ["task-planner", "requirements-doc", "builtin-planner-core", "dependency-analyzer"],
  executor: ["autonomous-dev", "bug-finder", "test-generator", "builtin-executor-core", "refactoring"],
  reviewer: [
    "code-reviewer",
    "security-audit",
    "review-repair-contract",
    "builtin-reviewer-core",
    "changelog-generator",
    "commit-message",
  ],
};

const BUILTIN_ROLE_SKILLS: WorkflowSkillEntry[] = [
  {
    id: "task-planner",
    title: "Task Planner",
    source: "builtin",
    summary: "Break goals into ordered milestones, dependencies, and risks.",
    content: [
      "You are the task-planner skill:",
      "1) Define in-scope and out-of-scope boundaries explicitly.",
      "2) Break work into ordered steps with inputs, outputs, and acceptance checks.",
      "3) Prioritize critical-path and high-risk tasks first.",
      "4) Mark blockers and identify tasks that can run in parallel.",
      "5) Include a lightweight estimate per step (S/M/L) and owner hint (planner/executor/reviewer).",
      "6) Highlight the earliest point where user-visible value is delivered.",
      "7) Avoid vague verbs; each step should be directly executable.",
      "8) Ask only blocking questions, and only after finishing non-blocked work.",
      "Output format:",
      "- Step N: goal | input | output | check | risk | rollback",
    ].join("\n"),
  },
  {
    id: "requirements-doc",
    title: "Requirements Doc",
    source: "builtin",
    summary: "Extract constraints from REQUIREMENTS.md/TASK_LIST.md and stay in scope.",
    content: [
      "You are the requirements-doc skill:",
      "1) Read REQUIREMENTS.md and TASK_LIST.md before planning implementation details.",
      "2) Extract hard constraints (compatibility, release policy, and edge-case rules).",
      "3) If code choices conflict with requirements, follow requirements and document trade-offs.",
      "4) Ensure delivered changes map back to explicit requirement items.",
      "5) Detect missing acceptance criteria and propose concrete testable checks.",
      "6) Call out hidden assumptions and list them as explicit implementation notes.",
      "7) Label each rule as hard constraint vs. soft preference.",
      "8) Flag missing observability, rollback, and compatibility requirements when absent.",
      "Output format:",
      "- Constraint: source | rule | impact | implementation note",
    ].join("\n"),
  },
  {
    id: "builtin-planner-core",
    title: "Planner Core",
    source: "builtin",
    summary: "Scope the objective, map dependencies, and prioritize risks.",
    content: [
      "You own the planning stage:",
      "1) Split the objective into 3-7 executable steps and label each step input/output.",
      "2) Identify blockers, unknowns, and external dependencies early.",
      "3) Add risk notes and rollback options to avoid all-at-once rewrites.",
      "4) Define validation paths (tests, lint, type checks, and manual verification).",
      "5) Keep each step independently reviewable and easy to revert.",
      "6) Prefer additive changes before destructive changes.",
      "7) End with a concise execution checklist for the executor.",
      "8) Suggest file/module ownership to reduce edit conflicts.",
    ].join("\n"),
  },
  {
    id: "dependency-analyzer",
    title: "Dependency Analyzer",
    source: "builtin",
    summary: "Surface dependency risks (security, breaking upgrades, and licensing) before implementation.",
    content: [
      "You are the dependency-analyzer skill:",
      "1) Inventory direct and transitive dependencies touched by the task.",
      "2) Flag security advisories, breaking upgrades, and end-of-life packages.",
      "3) Separate must-fix blockers from deferred improvements.",
      "4) Validate license and policy constraints for newly introduced packages.",
      "5) Prefer minimal safe version changes that satisfy requirements.",
      "6) Include validation evidence (lockfile diff, package tree, and tests).",
      "7) Provide rollback guidance for risky dependency updates.",
      "8) Classify impact by runtime, build-time, and test-time scopes.",
    ].join("\n"),
  },
  {
    id: "api-designer",
    title: "API Designer",
    source: "builtin",
    summary: "Design stable API contracts with explicit errors, versioning, and compatibility guarantees.",
    content: [
      "You are the api-designer skill:",
      "Trigger conditions:",
      "- Use when endpoints, schema contracts, or integration behavior are part of the task.",
      "Workflow:",
      "1) Define API boundaries, resources/actions, and ownership clearly.",
      "2) Specify request/response schema, validation, and error envelope.",
      "3) Keep backward compatibility as default; document breaking changes explicitly.",
      "4) Define idempotency, pagination, filtering, and rate-limit expectations when relevant.",
      "5) Include auth/permission requirements per endpoint or operation.",
      "6) Add concrete examples for success and failure responses.",
      "Guardrails:",
      "- Prefer additive versioning before introducing incompatible protocol changes.",
      "- Reject ambiguous contracts that cannot be validated in tests.",
      "Output contract:",
      "- Provide contract decisions with acceptance checks and observability requirements.",
    ].join("\n"),
  },
  {
    id: "superpowers-workflow",
    title: "Superpowers Workflow",
    source: "builtin",
    summary: "Orchestrate a plan-first development loop: clarify, spec, test, implement, and review.",
    content: [
      "You are the superpowers-workflow skill:",
      "Trigger conditions:",
      "- Use for non-trivial feature work that spans planning, implementation, and verification.",
      "Workflow:",
      "1) Start by clarifying goals, constraints, and success criteria before coding.",
      "2) Propose alternatives and converge on a concrete spec with explicit approvals/checks.",
      "3) Prefer test-first or test-early implementation slices.",
      "4) Implement in small increments and validate each increment with concrete evidence.",
      "5) Finish with review notes, residual risks, and next-step recommendations.",
      "Guardrails:",
      "- Do not skip planning for speed when requirements are ambiguous.",
      "- Do not claim completion without verification evidence.",
      "- If any required output section is missing, mark status as INCOMPLETE.",
      "Output contract:",
      "- Required sections: SPEC, PLAN, EVIDENCE, VALIDATION, RISKS, NEXT_STEPS, STATUS.",
      "- STATUS must be COMPLETE or INCOMPLETE.",
      "- Use INCOMPLETE when tests/checks are missing, failing, or not reproducible.",
      "- Deliver all sections in a machine-parsable block structure.",
    ].join("\n"),
  },
  {
    id: "brainstorming",
    title: "Brainstorming",
    source: "builtin",
    summary: "Explore solution options with trade-offs before implementation starts.",
    content: [
      "You are the brainstorming skill:",
      "Trigger conditions:",
      "- Use before implementation when requirements are ambiguous or there are multiple technical paths.",
      "Workflow:",
      "1) Clarify objective, constraints, and non-goals before proposing solutions.",
      "2) Ask high-leverage clarification questions first; avoid low-impact trivia.",
      "3) Propose at least two viable approaches and compare trade-offs.",
      "4) Identify key risks, unknowns, and failure modes early.",
      "5) Recommend one path with explicit rationale and rejection reasons for alternatives.",
      "Guardrails:",
      "- Avoid coding until decision points and acceptance checks are explicit.",
      "- Mark assumptions separately from confirmed facts.",
      "Output contract:",
      "- Produce a concise design note with scope, architecture, trade-offs, and rollout approach.",
    ].join("\n"),
  },
  {
    id: "planning-with-files",
    title: "Planning with Files",
    source: "builtin",
    summary: "Persist plan and progress in workspace files to survive context compression.",
    content: [
      "You are the planning-with-files skill:",
      "Trigger conditions:",
      "- Use when work requires many tool calls, multiple phases, or cross-turn continuity.",
      "Workflow:",
      "1) Persist planning artifacts in workspace markdown files before execution.",
      "2) Create and maintain `task_plan.md`, `progress.md`, and `findings.md` when absent.",
      "3) Keep a stable checklist of steps and status updates (pending/in-progress/done/blocked).",
      "4) Update progress files after each meaningful implementation milestone.",
      "5) On resume, read persisted files first and continue from last known state.",
      "Guardrails:",
      "- Keep notes concise and factual; avoid duplicating entire chat history.",
      "- Align plan files with REQUIREMENTS.md and TASK_LIST.md constraints.",
      "Output contract:",
      "- Record blockers, decisions, and evidence with timestamps in persistent files.",
    ].join("\n"),
  },
  {
    id: "ui-ux-pro-max",
    title: "UI UX Pro Max",
    source: "builtin",
    summary: "Produce intentional frontend design systems with style direction, accessibility, and implementation detail.",
    content: [
      "You are the ui-ux-pro-max skill:",
      "Trigger conditions:",
      "- Use for UI pages/components, design refreshes, or front-end UX quality improvements.",
      "Workflow:",
      "1) Choose a visual direction (typography, palette, spacing scale, and interaction style).",
      "2) Define design tokens/variables before implementing components.",
      "3) Build layouts with responsive behavior for desktop and mobile from the start.",
      "4) Add purposeful motion and interaction states (loading, hover, error, empty).",
      "5) Validate accessibility baseline (contrast, focus visibility, keyboard flow, semantics).",
      "Guardrails:",
      "- Avoid generic AI-looking defaults without project-specific intent.",
      "- Respect existing design systems when modifying established products.",
      "Output contract:",
      "- Deliver design rationale, token choices, and implementation-ready component guidance.",
    ].join("\n"),
  },
  {
    id: "autonomous-dev",
    title: "Autonomous Dev",
    source: "builtin",
    summary: "Drive delivery with small validated increments and minimal interruptions.",
    content: [
      "You are the autonomous-dev skill:",
      "1) Proceed by default when there is no material blocker.",
      "2) Deliver at least one verifiable increment each round.",
      "3) Finish the core path first, then handle boundaries and documentation.",
      "4) When failures occur, isolate root cause before proposing the next fix.",
      "5) Run the smallest relevant validation command after each code change cluster.",
      "6) Avoid broad refactors unless they directly unblock the target task.",
      "7) Report concrete evidence (files, commands, outcomes), not intent-only status.",
      "8) Read before write: inspect existing patterns before introducing new structures.",
    ].join("\n"),
  },
  {
    id: "bug-finder",
    title: "Bug Finder",
    source: "builtin",
    summary: "Find root causes quickly and propose minimal safe fixes.",
    content: [
      "You are the bug-finder skill:",
      "1) Reproduce and trace the first failing point using logs, tests, and call paths.",
      "2) Separate symptoms from root causes and fix the root cause first.",
      "3) Add focused regression tests after each fix.",
      "4) Report risks and side effects of the chosen fix.",
      "5) If uncertainty remains, compare at most two hypotheses and state disambiguation steps.",
      "6) Favor targeted instrumentation over noisy logging.",
      "7) Explicitly mark whether the fix is preventive, corrective, or both.",
      "8) Stop repeated blind retries and escalate with a concrete blocker summary.",
    ].join("\n"),
  },
  {
    id: "test-generator",
    title: "Test Generator",
    source: "builtin",
    summary: "Add regression tests for happy paths, boundaries, and failures.",
    content: [
      "You are the test-generator skill:",
      "1) Cover the most critical behavior and highest regression risk first.",
      "2) Include both success and failure scenarios.",
      "3) Use intention-revealing test names and readable assertions.",
      "4) Keep fixtures minimal and deterministic.",
      "5) Prefer black-box behavior assertions over implementation-coupled assertions.",
      "6) Add one negative test for malformed input or rejected state transitions.",
      "7) Keep test runtime lean and isolate flaky sources.",
      "8) Include retry/idempotency checks for async or queue-driven flows when relevant.",
    ].join("\n"),
  },
  {
    id: "builtin-executor-core",
    title: "Executor Core",
    source: "builtin",
    summary: "Prioritize runnable output, small changes, and continuous validation.",
    content: [
      "You own the execution stage:",
      "1) Implement the smallest end-to-end slice first, then improve incrementally.",
      "2) Follow existing style and avoid unrelated code churn.",
      "3) Produce at least one verifiable artifact per round.",
      "4) On failure, identify the cause and change strategy instead of repeating the same attempt.",
      "5) Preserve backward-compatible behavior unless requirements explicitly permit breaking changes.",
      "6) Keep commits cohesive: one business intent per commit.",
      "7) Maintain a short risk list for reviewer handoff.",
      "8) Never revert unrelated user changes while implementing the current task.",
    ].join("\n"),
  },
  {
    id: "refactoring",
    title: "Refactoring",
    source: "builtin",
    summary: "Reduce complexity with behavior-preserving, incremental refactors.",
    content: [
      "You are the refactoring skill:",
      "1) Identify concrete code smells (duplication, long functions, high coupling).",
      "2) Keep each refactor behavior-preserving and bounded in scope.",
      "3) Introduce tests or snapshots before high-risk structural changes.",
      "4) Prioritize extraction/composition over broad rewrites.",
      "5) Preserve public interfaces unless requirements explicitly allow breaks.",
      "6) Record before/after complexity signals (lines, branches, responsibilities).",
      "7) Stop and split when a refactor crosses multiple unrelated domains.",
      "8) Document migration notes for any renamed or moved modules.",
    ].join("\n"),
  },
  {
    id: "code-simplifier",
    title: "Code Simplifier",
    source: "builtin",
    summary: "Simplify changed code paths while preserving behavior and readability.",
    content: [
      "You are the code-simplifier skill:",
      "Trigger conditions:",
      "- Use after implementation for maintainability hardening or when complexity drifts upward.",
      "Workflow:",
      "1) Target recently changed code and high-churn files first.",
      "2) Remove duplication, dead branches, and unnecessary intermediate state.",
      "3) Preserve behavior; pair simplification with regression checks.",
      "4) Favor small extraction and naming improvements over broad rewrites.",
      "5) Reduce nesting and branch complexity where it improves maintainability.",
      "Guardrails:",
      "- Keep interfaces stable unless requirement-driven changes are approved.",
      "- Avoid cosmetic churn that does not improve clarity or reliability.",
      "Output contract:",
      "- Report concrete before/after improvements with file-level evidence.",
    ].join("\n"),
  },
  {
    id: "performance-optimizer",
    title: "Performance Optimizer",
    source: "builtin",
    summary: "Improve latency and resource usage through measurement-first optimization.",
    content: [
      "You are the performance-optimizer skill:",
      "1) Baseline current performance before changing code.",
      "2) Target the top bottleneck first (latency, throughput, memory, or CPU).",
      "3) Prefer algorithm/data-structure improvements over micro-optimizations.",
      "4) Keep behavior correct; add guard tests around optimized paths.",
      "5) Use realistic workload assumptions and call out benchmark limits.",
      "6) Validate p50/p95 impact when possible, not only single-run timing.",
      "7) Note trade-offs (memory vs CPU, latency vs consistency) explicitly.",
      "8) Include rollback criteria if optimization increases risk.",
    ].join("\n"),
  },
  {
    id: "tdd-workflow",
    title: "TDD Workflow",
    source: "builtin",
    summary: "Enforce red-green-refactor loops with test-first implementation discipline.",
    content: [
      "You are the tdd-workflow skill:",
      "Trigger conditions:",
      "- Use for new behavior, bug fixes, and regression-sensitive changes.",
      "Workflow:",
      "1) Start each behavior change by writing or updating a failing test first.",
      "2) Keep each red-green-refactor cycle small and focused.",
      "3) Make minimal implementation changes required to pass tests.",
      "4) Refactor only after tests are green and stable.",
      "5) Add boundary and negative tests for newly introduced behavior.",
      "Guardrails:",
      "- Prevent scope creep: no unrelated code changes in a TDD cycle.",
      "- If tests are flaky, stabilize test determinism before continuing.",
      "Output contract:",
      "- Keep test output as evidence for each completed cycle.",
    ].join("\n"),
  },
  {
    id: "webapp-testing",
    title: "Webapp Testing",
    source: "builtin",
    summary: "Drive browser-level scenario testing with deterministic automation and artifacts.",
    content: [
      "You are the webapp-testing skill:",
      "Trigger conditions:",
      "- Use for browser-level flows, UI regressions, and end-to-end verification.",
      "Workflow:",
      "1) Define user-critical scenarios before writing browser tests.",
      "2) Use deterministic selectors and avoid fragile timing assumptions.",
      "3) Capture screenshots and logs for failed steps.",
      "4) Cover at least one happy path and one failure path per core scenario.",
      "5) Prefer reusable setup/teardown helpers for browser state isolation.",
      "Guardrails:",
      "- Keep tests independent and safe for parallel execution when possible.",
      "- Document server startup prerequisites before execution.",
      "Output contract:",
      "- Emit concise failure diagnostics and include rerun command with environment assumptions.",
    ].join("\n"),
  },
  {
    id: "pptx",
    title: "PPTX",
    source: "builtin",
    summary: "Handle presentation workflows for creating, editing, and validating .pptx content.",
    content: [
      "You are the pptx skill:",
      "Trigger conditions:",
      "- Use whenever slides, decks, presentations, or `.pptx` files are involved.",
      "Workflow:",
      "1) Clarify target audience, objective, and expected slide count/structure.",
      "2) Build a slide outline before generating detailed content.",
      "3) Keep visual consistency across typography, spacing, and chart styles.",
      "4) Validate factual claims and source references before finalizing slides.",
      "5) Include speaker-note guidance when the task requires presentation support.",
      "Guardrails:",
      "- Avoid dense text blocks; prioritize scannable slide structure.",
      "- Preserve template and brand constraints when provided.",
      "Output contract:",
      "- Deliver slide outline, key messages per slide, and production checklist.",
    ].join("\n"),
  },
  {
    id: "ralph-loop",
    title: "Ralph Loop",
    source: "builtin",
    summary: "Prevent early stop by enforcing explicit completion criteria and bounded retry loops.",
    content: [
      "You are the ralph-loop skill:",
      "1) Require explicit completion criteria before execution starts.",
      "2) Reject intent-only 'done' claims without evidence from checks/tests/output.",
      "3) If completion criteria are not met, continue with the next concrete action.",
      "4) Re-evaluate completion after each iteration against a checklist.",
      "5) Keep retry loops bounded with max iterations and escalation conditions.",
      "6) Preserve incremental progress and avoid resetting successful work.",
      "7) Surface blockers with exact failing condition and proposed next action.",
      "8) End only when all criteria are satisfied or a hard blocker is declared.",
    ].join("\n"),
  },
  {
    id: "auto-code-pipeline",
    title: "Auto Code Pipeline",
    source: "builtin",
    summary: "Drive lint, test, and review checks in a minimal-fix loop after each change set.",
    content: [
      "You are the auto-code-pipeline skill:",
      "1) Run the smallest relevant lint/type/test suite after code changes.",
      "2) Fix issues in root-cause order instead of patching symptoms.",
      "3) Keep command outputs concise and evidence-based for handoff.",
      "4) Avoid long blind retry loops; change strategy when repeated failures occur.",
      "5) Separate functional fixes from formatting-only or tooling-only fixes.",
      "6) Re-run only affected checks after targeted fixes, then run full gate once.",
      "7) Capture stable reproduction commands for failures and regressions.",
      "8) Finish with a clear pass/fail checklist for reviewer verification.",
    ].join("\n"),
  },
  {
    id: "migration-helper",
    title: "Migration Helper",
    source: "builtin",
    summary: "Plan safe framework/dependency migrations with compatibility checkpoints and rollback paths.",
    content: [
      "You are the migration-helper skill:",
      "1) Define migration scope, compatibility matrix, and cutover constraints.",
      "2) Split migration into reversible phases with explicit checkpoints.",
      "3) Add temporary adapters where needed to preserve compatibility.",
      "4) Validate schema/data transitions and backward reads before cutover.",
      "5) Keep rollback scripts or downgrade paths ready for each phase.",
      "6) Gate rollout with smoke tests and high-signal regression checks.",
      "7) Document operational steps for deploy, monitor, and revert.",
      "8) Remove transitional code only after post-cutover stability confirmation.",
    ].join("\n"),
  },
  {
    id: "code-reviewer",
    title: "Code Reviewer",
    source: "builtin",
    summary: "Review requirement fit, quality, maintainability.",
    content: [
      "You are the code-reviewer skill:",
      "1) Verify the implementation actually satisfies the task objective.",
      "2) Check readability, duplication, and complexity hotspots.",
      "3) Identify likely regressions and behavior drift.",
      "4) Provide actionable, minimal fix suggestions for each issue.",
      "5) Classify findings by severity: critical, major, minor, info.",
      "6) Distinguish must-fix blockers from optional improvements.",
      "7) Prefer concrete evidence (file/path/behavior) over generic style comments.",
      "8) Explicitly verify requirement-to-diff traceability before approval.",
    ].join("\n"),
  },
  {
    id: "security-audit",
    title: "Security Audit",
    source: "builtin",
    summary: "Audit validation, auth boundaries, execution safety, and leaks.",
    content: [
      "You are the security-audit skill:",
      "1) Check validation and sanitization for external inputs.",
      "2) Check authentication/authorization controls and privilege boundaries.",
      "3) Review command execution and file-operation safety boundaries.",
      "4) Ensure logs do not expose secrets or sensitive data.",
      "5) Flag missing rate limits, abuse controls, or replay protections when relevant.",
      "6) Verify secure defaults for configuration and runtime switches.",
      "7) Provide remediation guidance with least-privilege and fail-closed principles.",
      "8) Classify findings by exploitability and blast radius.",
    ].join("\n"),
  },
  {
    id: "review-repair-contract",
    title: "Review Repair Contract",
    source: "builtin",
    summary: "Convert rejected reviews into actionable blocker contracts with explicit acceptance checks.",
    content: [
      "You are the review-repair-contract skill:",
      "1) For every REJECTED decision, produce explicit blocker boundaries executor can act on directly.",
      "2) Each blocker must include ID, severity, issue boundary, minimal fix path, and acceptance check.",
      "3) Prefer evidence-backed findings (file/behavior/repro) over abstract quality statements.",
      "4) Keep blockers minimal and non-overlapping; merge duplicates.",
      "5) Separate must-fix blockers from optional improvements.",
      "6) If blocker contract is incomplete, mark contract status as INCOMPLETE instead of vague rejection.",
      "7) Ensure repair instructions are implementable in one bounded execution round.",
      "8) Keep output machine-readable for downstream repair automation.",
      "Output contract:",
      "VERDICT: APPROVED | REJECTED",
      "SUMMARY: one-line rationale",
      "BLOCKERS:",
      "- [B1][critical] issue=<boundary>; evidence=<file/behavior>; fix=<minimal remediation>; accept=<verifiable check>",
      "REPAIR_CONTRACT_STATUS: COMPLETE | INCOMPLETE",
    ].join("\n"),
  },
  {
    id: "builtin-reviewer-core",
    title: "Reviewer Core",
    source: "builtin",
    summary: "Gate on requirements, correctness, stability, regressions.",
    content: [
      "You own the review stage:",
      "1) Compare objective and delivery first, and gate on requirement completion.",
      "2) Check boundary conditions, failure paths, and regression risk.",
      "3) Every issue must include a concrete, minimal remediation path.",
      "4) Final decision must include VERDICT: APPROVED or REJECTED.",
      "5) If rejected, include a compact SUMMARY and top issues in priority order.",
      "6) If approved, call out residual risks and monitoring suggestions.",
      "7) Keep findings precise enough for direct executor action.",
      "8) Keep output machine-readable with VERDICT/SUMMARY/ISSUES/SUGGESTIONS/BLOCKERS blocks.",
      "9) If REJECTED, include blocker IDs with fix + acceptance checks for each must-fix issue.",
    ].join("\n"),
  },
  {
    id: "changelog-generator",
    title: "Changelog Generator",
    source: "builtin",
    summary: "Produce release notes that map user-facing changes to verifiable evidence.",
    content: [
      "You are the changelog-generator skill:",
      "1) Group changes by Added, Changed, Fixed, Removed, Security when applicable.",
      "2) Include user-visible impact first; avoid internal-only noise.",
      "3) Link each changelog bullet to concrete evidence (task, commit, or file).",
      "4) Keep wording concise, outcome-focused, and compatible with semver intent.",
      "5) Flag breaking changes with explicit upgrade notes.",
      "6) Exclude speculative claims not verified by tests or runtime checks.",
      "7) Ensure release notes remain readable for both engineers and operators.",
      "8) Include follow-up actions when known risks remain after release.",
    ].join("\n"),
  },
  {
    id: "commit-message",
    title: "Commit Message",
    source: "builtin",
    summary: "Enforce clear Conventional Commit subjects that describe business intent and traceable scope.",
    content: [
      "You are the commit-message skill:",
      "Trigger conditions:",
      "- Use whenever AutoDev drafts commit subjects or release-adjacent commit text.",
      "Workflow:",
      "1) Use conventional format: type(scope): subject.",
      "2) Keep subject imperative, concise, and directly related to delivered behavior.",
      "3) Prefer business/domain scope over generic internal scope names.",
      "4) Keep language aligned with repository history when history exists; for a new repository, default to English.",
      "5) Keep one coherent business intent per commit whenever possible.",
      "Guardrails:",
      "- Avoid vague subjects like update/fix stuff/refine code.",
      "- Explicitly forbid AI signature trailers or generated-by vanity tags in commit footer.",
      "- Reject commit text that does not map to actual code changes.",
      "Output contract:",
      "- Use body for what/why context only when it adds review value.",
      "- Respect breaking-change and issue-closing footer conventions when relevant.",
      "- If generated summary conflicts with diff evidence, rewrite subject from verified diff intent.",
    ].join("\n"),
  },
  {
    id: "multi-agent-code-review",
    title: "Multi-Agent Code Review",
    source: "builtin",
    summary: "Review from multiple perspectives and prioritize high-confidence findings.",
    content: [
      "You are the multi-agent-code-review skill:",
      "Trigger conditions:",
      "- Use for review stages where false-positive reduction and issue prioritization matter.",
      "Workflow:",
      "1) Evaluate the diff through correctness, security, and maintainability lenses.",
      "2) Tag each finding with confidence and potential impact.",
      "3) Prioritize high-confidence, high-impact issues first.",
      "4) Separate actionable defects from speculative concerns.",
      "5) Include concrete reproduction or evidence for must-fix findings.",
      "Guardrails:",
      "- Avoid duplicate comments by merging equivalent findings.",
      "- Filter low-confidence noise unless explicitly requested.",
      "Output contract:",
      "- Provide minimal remediation steps and end with pass/fail recommendation plus residual risks.",
    ].join("\n"),
  },
];

export class WorkflowRoleSkillCatalog {
  private readonly enabled: boolean;
  private readonly mode: WorkflowRoleSkillDisclosureMode;
  private readonly maxChars: number;
  private readonly roots: string[];
  private readonly roleAssignments: Record<WorkflowRole, string[]>;
  private readonly allSkills = new Map<string, WorkflowSkillEntry>();

  constructor(options?: WorkflowRoleSkillCatalogOptions) {
    this.enabled = options?.enabled ?? true;
    this.mode = options?.mode ?? "progressive";
    this.maxChars = normalizeMaxChars(options?.maxChars);
    this.roots = normalizeRoots(options?.roots);
    this.roleAssignments = normalizeRoleAssignments(options?.roleAssignments);

    this.registerBuiltinSkills();
    this.registerLocalSkills();
  }

  getStatusSnapshot(): WorkflowRoleSkillStatusSnapshot {
    return {
      enabled: this.enabled,
      mode: this.mode,
      maxChars: this.maxChars,
      roots: [...this.roots],
      roleAssignments: cloneRoleAssignments(this.roleAssignments),
      loadedSkills: {
        planner: this.resolveRoleSkills("planner").map((skill) => `${skill.id}(${skill.source})`),
        executor: this.resolveRoleSkills("executor").map((skill) => `${skill.id}(${skill.source})`),
        reviewer: this.resolveRoleSkills("reviewer").map((skill) => `${skill.id}(${skill.source})`),
      },
    };
  }

  buildPrompt(input: WorkflowRoleSkillPromptInput): WorkflowRoleSkillPromptResult {
    const enabled = input.policy?.enabled ?? this.enabled;
    const mode = input.policy?.mode ?? this.mode;
    if (!enabled) {
      return {
        text: null,
        enabled: false,
        mode,
        disclosure: null,
        usedSkills: [],
      };
    }

    const skills = this.resolveRoleSkills(input.role);
    if (skills.length === 0) {
      return {
        text: null,
        enabled: true,
        mode,
        disclosure: null,
        usedSkills: [],
      };
    }

    const disclosure = resolveDisclosureLevel(mode, input.stage, input.round);
    const bodyChunks: string[] = [];
    const usedSkills: string[] = [];

    for (const skill of skills) {
      const blockContent = disclosure === "summary" ? skill.summary : skill.content;
      const normalizedContent = blockContent.trim();
      if (!normalizedContent) {
        continue;
      }
      usedSkills.push(skill.id);
      bodyChunks.push(
        [
          `[skill id="${skill.id}" source="${skill.source}" disclosure="${disclosure}"]`,
          normalizedContent,
          "[/skill]",
        ].join("\n"),
      );
    }

    if (bodyChunks.length === 0) {
      return {
        text: null,
        enabled: true,
        mode,
        disclosure: null,
        usedSkills: [],
      };
    }

    const rawBlock = [
      "[role_skills]",
      `role=${input.role}`,
      `mode=${mode}`,
      `stage=${input.stage}`,
      `round=${input.round}`,
      `disclosure=${disclosure}`,
      ...bodyChunks,
      "[/role_skills]",
    ].join("\n\n");

    return {
      text: trimToMaxChars(rawBlock, this.maxChars),
      enabled: true,
      mode,
      disclosure,
      usedSkills,
    };
  }

  private resolveRoleSkills(role: WorkflowRole): WorkflowSkillEntry[] {
    const selected = this.roleAssignments[role] ?? [];
    const unique = new Map<string, WorkflowSkillEntry>();
    for (const skillId of selected) {
      const skill = this.allSkills.get(skillId.trim().toLowerCase());
      if (!skill) {
        continue;
      }
      unique.set(skill.id, skill);
    }
    return [...unique.values()];
  }

  private registerBuiltinSkills(): void {
    for (const skill of BUILTIN_ROLE_SKILLS) {
      this.registerSkill(skill, [skill.id]);
    }
  }

  private registerLocalSkills(): void {
    for (const root of this.roots) {
      const files = listSkillFiles(root, 4);
      for (const filePath of files) {
        const content = readTextFile(filePath);
        if (!content) {
          continue;
        }
        const dirPath = path.dirname(filePath);
        const relativeDir = path.relative(root, dirPath).replace(/\\/g, "/");
        const baseName = path.basename(dirPath);
        const id = relativeDir && relativeDir !== "." ? relativeDir : baseName;
        const title = extractTitle(content, baseName || id || "skill");
        const summary = extractSummary(content, title);
        const skill: WorkflowSkillEntry = {
          id,
          title,
          summary,
          content: content.trim(),
          source: "local",
        };
        this.registerSkill(skill, [id, baseName, title]);
      }
    }
  }

  private registerSkill(skill: WorkflowSkillEntry, aliases: string[]): void {
    const normalized = {
      ...skill,
      id: skill.id.trim(),
      title: skill.title.trim() || skill.id.trim(),
      summary: skill.summary.trim(),
      content: skill.content.trim(),
    };
    if (!normalized.id || !normalized.content) {
      return;
    }
    for (const alias of aliases) {
      const key = alias.trim().toLowerCase();
      if (!key) {
        continue;
      }
      if (!this.allSkills.has(key)) {
        this.allSkills.set(key, normalized);
      }
    }
    const canonicalKey = normalized.id.toLowerCase();
    this.allSkills.set(canonicalKey, normalized);
  }
}

function resolveDisclosureLevel(
  mode: WorkflowRoleSkillDisclosureMode,
  stage: WorkflowRoleSkillPromptInput["stage"],
  round: number,
): WorkflowRoleSkillDisclosureLevel {
  if (mode === "full") {
    return "full";
  }
  if (mode === "summary") {
    return "summary";
  }
  if (stage === "repair") {
    return "full";
  }
  if (round > 0) {
    return "full";
  }
  return "summary";
}

function normalizeMaxChars(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value < 200) {
    return DEFAULT_ROLE_SKILL_MAX_CHARS;
  }
  return Math.floor(value);
}

function normalizeRoots(roots: string[] | undefined): string[] {
  const source = roots ?? (process.env.NODE_ENV === "test" ? [] : [DEFAULT_ROLE_SKILL_ROOT]);
  const unique = new Set<string>();
  for (const root of source) {
    if (!root.trim()) {
      continue;
    }
    const normalized = path.resolve(root);
    unique.add(normalized);
  }
  return [...unique];
}

function normalizeRoleAssignments(
  roleAssignments: Partial<Record<WorkflowRole, string[]>> | undefined,
): Record<WorkflowRole, string[]> {
  const next: Record<WorkflowRole, string[]> = {
    planner: [...DEFAULT_ROLE_ASSIGNMENTS.planner],
    executor: [...DEFAULT_ROLE_ASSIGNMENTS.executor],
    reviewer: [...DEFAULT_ROLE_ASSIGNMENTS.reviewer],
  };
  if (!roleAssignments) {
    return next;
  }
  for (const role of ["planner", "executor", "reviewer"] as WorkflowRole[]) {
    const list = roleAssignments[role];
    if (!list) {
      continue;
    }
    next[role] = dedupeSkillIds(list);
  }
  return next;
}

function dedupeSkillIds(items: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(trimmed);
  }
  return next;
}

function listSkillFiles(root: string, maxDepth: number): string[] {
  if (maxDepth < 0) {
    return [];
  }
  if (!fs.existsSync(root)) {
    return [];
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const results: string[] = [];
  walkSkillDir(root, 0, maxDepth, results);
  return results;
}

function walkSkillDir(current: string, depth: number, maxDepth: number, results: string[]): void {
  if (depth > maxDepth) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      results.push(fullPath);
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    walkSkillDir(fullPath, depth + 1, maxDepth, results);
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function extractTitle(content: string, fallback: string): string {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("#")) {
      return trimmed.replace(/^#+\s*/, "").trim() || fallback;
    }
  }
  return fallback;
}

function extractSummary(content: string, fallback: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) {
    return fallback;
  }
  return summarizeSingleLine(lines[0], 180);
}

function summarizeSingleLine(value: string, maxLen: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen)}...`;
}

function trimToMaxChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = "\n...[role_skills truncated]...\n";
  const headLen = Math.max(0, maxChars - marker.length);
  return `${value.slice(0, headLen)}${marker}`;
}

function cloneRoleAssignments(assignments: Record<WorkflowRole, string[]>): Record<WorkflowRole, string[]> {
  return {
    planner: [...assignments.planner],
    executor: [...assignments.executor],
    reviewer: [...assignments.reviewer],
  };
}
