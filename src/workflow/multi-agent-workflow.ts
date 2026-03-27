import {
  CodexExecutionCancelledError,
  CodexExecutor,
  type CodexExecutionHandle,
} from "../executor/codex-executor";
import { Logger } from "../logger";
import {
  WorkflowRoleSkillCatalog,
  type WorkflowRoleSkillPolicyOverride,
  type WorkflowRoleSkillPromptInput,
  type WorkflowRoleSkillPromptResult,
} from "./role-skills";
import type { OutputLanguage } from "../config";
import { byOutputLanguage } from "../orchestrator/output-language";

export interface MultiAgentWorkflowConfig {
  enabled: boolean;
  autoRepairMaxRounds: number;
  outputLanguage?: OutputLanguage;
  executionTimeoutMs?: number;
  planContextMaxChars?: number | null;
  outputContextMaxChars?: number | null;
  feedbackContextMaxChars?: number | null;
  roleSkillCatalog?: WorkflowRoleSkillCatalog;
}

export interface MultiAgentWorkflowProgressEvent {
  stage: "planner" | "executor" | "reviewer" | "repair";
  round: number;
  message: string;
  stageOutput?: {
    role: "planner" | "executor" | "reviewer";
    source: "primary" | "repair" | "contract_repair";
    label: string;
    content: string;
  };
}

export interface MultiAgentWorkflowRunInput {
  objective: string;
  workdir: string;
  roleSkillPolicy?: WorkflowRoleSkillPolicyOverride;
  onProgress?: (event: MultiAgentWorkflowProgressEvent) => void | Promise<void>;
  onRegisterCancel?: (cancel: () => void) => void;
}

export interface MultiAgentWorkflowRunResult {
  objective: string;
  plan: string;
  output: string;
  review: string;
  approved: boolean;
  repairRounds: number;
  durationMs: number;
}

interface ExecuteRoleResult {
  sessionId: string;
  reply: string;
  durationMs: number;
  promptChars: number;
  replyChars: number;
}

interface ReviewerBlocker {
  id: string;
  severity: "critical" | "major" | "minor" | "info";
  issue: string;
  evidence: string | null;
  fix: string;
  accept: string;
  source: "section" | "issue_suggestion" | "fallback";
  issueProvided: boolean;
  fixProvided: boolean;
  acceptProvided: boolean;
}

interface ReviewerVerdict {
  verdict: "APPROVED" | "REJECTED" | "UNKNOWN";
  approved: boolean;
  summary: string;
  feedback: string;
  blockers: ReviewerBlocker[];
  contractComplete: boolean;
  contractActionable: boolean;
}

const DEFAULT_WORKFLOW_EXECUTION_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_REVIEWER_CONTRACT_REPAIR_ROUNDS = 2;

interface WorkflowPromptContextLimits {
  plan: number | null;
  output: number | null;
  feedback: number | null;
}

interface ReviewerContractRepairInput {
  objective: string;
  plan: string;
  output: string;
  round: number;
  workdir: string;
  roleTimeoutMs: number;
  roleSkillPolicy?: WorkflowRoleSkillPolicyOverride;
  onProgress?: (event: MultiAgentWorkflowProgressEvent) => void | Promise<void>;
  getCancelled: () => boolean;
  setActiveHandle: (handle: CodexExecutionHandle | null) => void;
  reviewReply: string;
  verdict: ReviewerVerdict;
}

interface ReviewerContractRepairResult {
  reviewReply: string;
  verdict: ReviewerVerdict;
}

export class MultiAgentWorkflowRunner {
  private executor: CodexExecutor;
  private readonly logger: Logger;
  private readonly config: MultiAgentWorkflowConfig;
  private readonly outputLanguage: OutputLanguage;
  private readonly promptContextLimits: WorkflowPromptContextLimits;
  private readonly roleSkillCatalog: WorkflowRoleSkillCatalog | null;

  constructor(executor: CodexExecutor, logger: Logger, config: MultiAgentWorkflowConfig) {
    this.executor = executor;
    this.logger = logger;
    this.config = config;
    this.outputLanguage = config.outputLanguage === "en" ? "en" : "zh";
    this.promptContextLimits = resolvePromptContextLimits(config);
    this.roleSkillCatalog = config.roleSkillCatalog ?? null;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  setExecutor(executor: CodexExecutor): void {
    this.executor = executor;
  }

  async run(input: MultiAgentWorkflowRunInput): Promise<MultiAgentWorkflowRunResult> {
    const localize = (zh: string, en: string): string => byOutputLanguage(this.outputLanguage, zh, en);
    const startedAt = Date.now();
    const objective = input.objective.trim();
    if (!objective) {
      throw new Error("workflow objective cannot be empty.");
    }

    const maxRepairRounds = Math.max(0, this.config.autoRepairMaxRounds);
    let activeHandle: CodexExecutionHandle | null = null;
    let cancelled = false;

    input.onRegisterCancel?.(() => {
      cancelled = true;
      activeHandle?.cancel();
    });

    const roleTimeoutMs = this.resolveRoleTimeoutMs();
    const plannerSkillPrompt = this.buildRoleSkillPrompt({
      role: "planner",
      stage: "planner",
      round: 0,
      policy: input.roleSkillPolicy,
    });
    await emitProgress(input, {
      stage: "planner",
      round: 0,
      message: localize(
        `规划代理开始生成执行计划（agent=planner, timeout=${formatDurationMs(roleTimeoutMs)}, ${formatRoleSkillProgress(
          plannerSkillPrompt,
        )}）`,
        `Planner started plan generation (agent=planner, timeout=${formatDurationMs(
          roleTimeoutMs,
        )}, ${formatRoleSkillProgress(plannerSkillPrompt)})`,
      ),
    });
    const planResult = await this.executeRole(
      "planner",
      buildPlannerPrompt(objective, plannerSkillPrompt.text),
      null,
      input.workdir,
      roleTimeoutMs,
      () => cancelled,
      (handle) => {
        activeHandle = handle;
      },
    );
    const plan = planResult.reply;
    await emitProgress(input, {
      stage: "planner",
      round: 0,
      message: localize(
        `规划代理执行完成（agent=planner, ${formatRoleExecutionStats(planResult)}）`,
        `Planner completed (agent=planner, ${formatRoleExecutionStats(planResult)})`,
      ),
      stageOutput: {
        role: "planner",
        source: "primary",
        label: "planner_output",
        content: plan,
      },
    });

    const executorSkillPrompt = this.buildRoleSkillPrompt({
      role: "executor",
      stage: "executor",
      round: 0,
      policy: input.roleSkillPolicy,
    });
    await emitProgress(input, {
      stage: "executor",
      round: 0,
      message: localize(
        `执行代理开始根据计划执行任务（agent=executor, timeout=${formatDurationMs(
          roleTimeoutMs,
        )}, ${formatRoleSkillProgress(executorSkillPrompt)}）`,
        `Executor started execution from plan (agent=executor, timeout=${formatDurationMs(
          roleTimeoutMs,
        )}, ${formatRoleSkillProgress(executorSkillPrompt)})`,
      ),
    });
    let outputResult = await this.executeRole(
      "executor",
      buildExecutorPrompt(objective, plan, this.promptContextLimits, executorSkillPrompt.text),
      null,
      input.workdir,
      roleTimeoutMs,
      () => cancelled,
      (handle) => {
        activeHandle = handle;
      },
    );
    await emitProgress(input, {
      stage: "executor",
      round: 0,
      message: localize(
        `执行代理初版交付完成（agent=executor, ${formatRoleExecutionStats(outputResult)}）`,
        `Executor initial delivery completed (agent=executor, ${formatRoleExecutionStats(outputResult)})`,
      ),
      stageOutput: {
        role: "executor",
        source: "primary",
        label: "executor_output",
        content: outputResult.reply,
      },
    });

    let finalReviewReply = "";
    let approved = false;
    let repairRounds = 0;

    for (let attempt = 0; attempt <= maxRepairRounds; attempt += 1) {
      const reviewerSkillPrompt = this.buildRoleSkillPrompt({
        role: "reviewer",
        stage: "reviewer",
        round: attempt,
        policy: input.roleSkillPolicy,
      });
      await emitProgress(input, {
        stage: "reviewer",
        round: attempt,
        message: localize(
          `审查代理开始质量审查（agent=reviewer, round=${attempt + 1}, timeout=${formatDurationMs(
            roleTimeoutMs,
          )}, ${formatRoleSkillProgress(reviewerSkillPrompt)}）`,
          `Reviewer started quality review (agent=reviewer, round=${attempt + 1}, timeout=${formatDurationMs(
            roleTimeoutMs,
          )}, ${formatRoleSkillProgress(reviewerSkillPrompt)})`,
        ),
      });
      const reviewResult = await this.executeRole(
        "reviewer",
        buildReviewerPrompt(objective, plan, outputResult.reply, this.promptContextLimits, reviewerSkillPrompt.text),
        null,
        input.workdir,
        roleTimeoutMs,
        () => cancelled,
        (handle) => {
          activeHandle = handle;
        },
      );
      finalReviewReply = reviewResult.reply;

      let verdict = parseReviewerVerdict(finalReviewReply);
      await emitProgress(input, {
        stage: "reviewer",
        round: attempt,
        message: localize(
          `审查代理审查完成（agent=reviewer, round=${attempt + 1}, verdict=${
            verdict.verdict
          }, ${formatRoleExecutionStats(reviewResult)}）${
            verdict.approved ? "" : `，summary=${verdict.summary}，contract=${formatReviewerContractStatus(verdict)}`
          }`,
          `Reviewer completed (agent=reviewer, round=${attempt + 1}, verdict=${
            verdict.verdict
          }, ${formatRoleExecutionStats(reviewResult)})${
            verdict.approved ? "" : `, summary=${verdict.summary}, contract=${formatReviewerContractStatus(verdict)}`
          }`,
        ),
        stageOutput: {
          role: "reviewer",
          source: "primary",
          label: "reviewer_output",
          content: finalReviewReply,
        },
      });

      const contractRepairResult = await this.ensureReviewerRepairContract({
        objective,
        plan,
        output: outputResult.reply,
        round: attempt,
        workdir: input.workdir,
        roleTimeoutMs,
        roleSkillPolicy: input.roleSkillPolicy,
        onProgress: input.onProgress,
        getCancelled: () => cancelled,
        setActiveHandle: (handle) => {
          activeHandle = handle;
        },
        reviewReply: finalReviewReply,
        verdict,
      });
      verdict = contractRepairResult.verdict;
      finalReviewReply = contractRepairResult.reviewReply;

      if (verdict.approved) {
        approved = true;
        break;
      }
      if (!hasActionableRepairContract(verdict)) {
        this.logger.warn("Reviewer failed to produce actionable repair contract; stop workflow repair loop.", {
          objective,
          round: attempt + 1,
          verdict: verdict.verdict,
          summary: verdict.summary,
          contractStatus: formatReviewerContractStatus(verdict),
          blockerCount: verdict.blockers.length,
        });
        await emitProgress(input, {
          stage: "reviewer",
          round: attempt,
          message: localize(
            `审查代理已拒绝但未提供可执行修复契约，已停止自动修复（round=${attempt + 1}, contract=${formatReviewerContractStatus(
              verdict,
            )}）`,
            `Reviewer REJECTED without actionable repair contract; auto-repair stopped (round=${attempt + 1}, contract=${formatReviewerContractStatus(
              verdict,
            )})`,
          ),
        });
        break;
      }

      if (attempt >= maxRepairRounds) {
        break;
      }

      repairRounds = attempt + 1;
      const repairSkillPrompt = this.buildRoleSkillPrompt({
        role: "executor",
        stage: "repair",
        round: repairRounds,
        policy: input.roleSkillPolicy,
      });
      await emitProgress(input, {
        stage: "repair",
        round: repairRounds,
        message: localize(
          `执行代理开始按审查反馈修复（agent=executor, repairRound=${repairRounds}, timeout=${formatDurationMs(
            roleTimeoutMs,
          )}, ${formatRoleSkillProgress(repairSkillPrompt)}）`,
          `Executor started repair from reviewer feedback (agent=executor, repairRound=${repairRounds}, timeout=${formatDurationMs(
            roleTimeoutMs,
          )}, ${formatRoleSkillProgress(repairSkillPrompt)})`,
        ),
      });

      outputResult = await this.executeRole(
        "executor",
        buildRepairPrompt(
          objective,
          plan,
          outputResult.reply,
          verdict.feedback,
          repairRounds,
          this.promptContextLimits,
          repairSkillPrompt.text,
        ),
        null,
        input.workdir,
        roleTimeoutMs,
        () => cancelled,
        (handle) => {
          activeHandle = handle;
        },
      );
      await emitProgress(input, {
        stage: "repair",
        round: repairRounds,
        message: localize(
          `执行代理修复轮次完成（agent=executor, repairRound=${repairRounds}, ${formatRoleExecutionStats(outputResult)}）`,
          `Executor repair round completed (agent=executor, repairRound=${repairRounds}, ${formatRoleExecutionStats(
            outputResult,
          )})`,
        ),
        stageOutput: {
          role: "executor",
          source: "repair",
          label: "executor_repair_output",
          content: outputResult.reply,
        },
      });
    }

    const durationMs = Date.now() - startedAt;
    this.logger.info("Multi-agent workflow finished", {
      objective,
      approved,
      repairRounds,
      durationMs,
    });

    return {
      objective,
      plan,
      output: outputResult.reply,
      review: finalReviewReply,
      approved,
      repairRounds,
      durationMs,
    };
  }

  private async executeRole(
    role: "planner" | "executor" | "reviewer",
    prompt: string,
    sessionId: string | null,
    workdir: string,
    timeoutMs: number,
    getCancelled: () => boolean,
    setActiveHandle: (handle: CodexExecutionHandle | null) => void,
  ): Promise<ExecuteRoleResult> {
    if (getCancelled()) {
      throw new CodexExecutionCancelledError("workflow cancelled");
    }

    const startedAt = Date.now();
    const promptChars = prompt.length;
    const handle = this.executor.startExecution(prompt, sessionId, undefined, { workdir, timeoutMs });
    setActiveHandle(handle);
    try {
      const result = await handle.result;
      const durationMs = Math.max(0, Date.now() - startedAt);
      return {
        sessionId: result.sessionId,
        reply: result.reply,
        durationMs,
        promptChars,
        replyChars: result.reply.length,
      };
    } finally {
      setActiveHandle(null);
    }
  }

  private buildRoleSkillPrompt(input: WorkflowRoleSkillPromptInput): WorkflowRoleSkillPromptResult {
    if (!this.roleSkillCatalog) {
      return {
        text: null,
        enabled: false,
        mode: input.policy?.mode ?? "progressive",
        disclosure: null,
        usedSkills: [],
      };
    }
    return this.roleSkillCatalog.buildPrompt(input);
  }

  private async ensureReviewerRepairContract(input: ReviewerContractRepairInput): Promise<ReviewerContractRepairResult> {
    const localize = (zh: string, en: string): string => byOutputLanguage(this.outputLanguage, zh, en);
    let reviewReply = input.reviewReply;
    let verdict = input.verdict;

    for (let repairRound = 1; repairRound <= DEFAULT_REVIEWER_CONTRACT_REPAIR_ROUNDS; repairRound += 1) {
      if (verdict.approved || hasActionableRepairContract(verdict)) {
        break;
      }

      this.logger.warn("Reviewer contract is not actionable, requesting contract repair.", {
        objective: input.objective,
        reviewRound: input.round + 1,
        contractRepairRound: repairRound,
        verdict: verdict.verdict,
        contractStatus: formatReviewerContractStatus(verdict),
        summary: verdict.summary,
        blockerCount: verdict.blockers.length,
      });
      await emitProgress(
        {
          objective: input.objective,
          workdir: input.workdir,
          onProgress: input.onProgress,
        },
        {
          stage: "reviewer",
          round: input.round,
          message: localize(
            `审查代理契约补全启动（reviewRound=${input.round + 1}, contractRound=${repairRound}/${
              DEFAULT_REVIEWER_CONTRACT_REPAIR_ROUNDS
            }, status=${formatReviewerContractStatus(verdict)}）`,
            `Reviewer contract repair started (reviewRound=${input.round + 1}, contractRound=${repairRound}/${
              DEFAULT_REVIEWER_CONTRACT_REPAIR_ROUNDS
            }, status=${formatReviewerContractStatus(verdict)})`,
          ),
        },
      );

      const reviewerSkillPrompt = this.buildRoleSkillPrompt({
        role: "reviewer",
        stage: "reviewer",
        round: input.round,
        policy: input.roleSkillPolicy,
      });
      const repairResult = await this.executeRole(
        "reviewer",
        buildReviewerContractRepairPrompt(
          input.objective,
          input.plan,
          input.output,
          reviewReply,
          verdict.feedback,
          repairRound,
          this.promptContextLimits,
          reviewerSkillPrompt.text,
        ),
        null,
        input.workdir,
        input.roleTimeoutMs,
        input.getCancelled,
        input.setActiveHandle,
      );
      reviewReply = repairResult.reply;
      verdict = parseReviewerVerdict(reviewReply);

      await emitProgress(
        {
          objective: input.objective,
          workdir: input.workdir,
          onProgress: input.onProgress,
        },
        {
          stage: "reviewer",
          round: input.round,
          message: localize(
            `审查代理契约补全完成（reviewRound=${input.round + 1}, contractRound=${repairRound}/${
              DEFAULT_REVIEWER_CONTRACT_REPAIR_ROUNDS
            }, verdict=${verdict.verdict}, status=${formatReviewerContractStatus(verdict)}, ${formatRoleExecutionStats(
              repairResult,
            )}）`,
            `Reviewer contract repair completed (reviewRound=${input.round + 1}, contractRound=${repairRound}/${
              DEFAULT_REVIEWER_CONTRACT_REPAIR_ROUNDS
            }, verdict=${verdict.verdict}, status=${formatReviewerContractStatus(verdict)}, ${formatRoleExecutionStats(
              repairResult,
            )})`,
          ),
          stageOutput: {
            role: "reviewer",
            source: "contract_repair",
            label: "reviewer_contract_repair_output",
            content: reviewReply,
          },
        },
      );
    }

    return {
      reviewReply,
      verdict,
    };
  }

  private resolveRoleTimeoutMs(): number {
    const configured = this.config.executionTimeoutMs;
    if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }
    return DEFAULT_WORKFLOW_EXECUTION_TIMEOUT_MS;
  }
}

async function emitProgress(input: MultiAgentWorkflowRunInput, event: MultiAgentWorkflowProgressEvent): Promise<void> {
  if (!input.onProgress) {
    return;
  }
  await input.onProgress(event);
}

function buildPlannerPrompt(objective: string, roleSkillBlock: string | null): string {
  const sections = ["[role:planner]"];
  if (roleSkillBlock) {
    sections.push(roleSkillBlock);
  }
  sections.push(
    "你是软件交付规划代理。请基于目标给出可执行计划。",
    "输出要求：",
    "1. 任务拆解（3-7 步）",
    "2. 每步输入/输出",
    "3. 风险与回退方案",
    "",
    `目标：${objective}`,
  );
  return sections.join("\n");
}

function buildExecutorPrompt(
  objective: string,
  plan: string,
  limits: WorkflowPromptContextLimits,
  roleSkillBlock: string | null,
): string {
  const planContext = clampPromptContext("planner_plan", plan, limits.plan);
  const sections = ["[role:executor]"];
  if (roleSkillBlock) {
    sections.push(roleSkillBlock);
  }
  sections.push(
    "你是软件执行代理。请根据计划完成交付内容。",
    "输出要求：",
    "1. 直接给出最终可执行结果",
    "2. 说明你实际完成了哪些步骤",
    "3. 如果需要文件落盘，请给出绝对路径",
    "4. 必须包含 VALIDATION_STATUS: PASS 或 FAIL（基于真实验证结果）",
    "5. 必须包含 __EXIT_CODES__（示例：__EXIT_CODES__ unit=0 lint=0）",
    "6. VALIDATION 段必须列出验证命令与结果，并与 VALIDATION_STATUS 一致",
    "",
    `目标：${objective}`,
    "",
    "[planner_plan]",
    planContext,
    "[/planner_plan]",
  );
  return sections.join("\n");
}

function buildReviewerPrompt(
  objective: string,
  plan: string,
  output: string,
  limits: WorkflowPromptContextLimits,
  roleSkillBlock: string | null,
): string {
  const planContext = clampPromptContext("planner_plan", plan, limits.plan);
  const outputContext = clampPromptContext("executor_output", output, limits.output);
  const sections = ["[role:reviewer]"];
  if (roleSkillBlock) {
    sections.push(roleSkillBlock);
  }
  sections.push(
    "你是质量审查代理。请严格审查执行结果是否达成目标。",
    "输出格式必须包含以下字段：",
    "VERDICT: APPROVED 或 REJECTED",
    "SUMMARY: 一句话总结",
    "ISSUES:",
    "- issue 1",
    "- issue 2",
    "SUGGESTIONS:",
    "- suggestion 1",
    "- suggestion 2",
    "BLOCKERS:",
    "- [B1][critical] issue=<边界>; fix=<可执行修复>; accept=<可验证验收>; evidence=<文件/行为>",
    "规则：",
    "1) 若 executor 输出缺失 VALIDATION_STATUS 或 __EXIT_CODES__，必须 REJECTED 并给出可执行 BLOCKERS。",
    "2) 若 VALIDATION_STATUS 与 VALIDATION/命令结果不一致，必须 REJECTED 并要求修正。",
    "3) REJECTED 时 BLOCKERS 至少 1 条，且 issue/fix/accept 不得为空。",
    "4) 仅当 executor 输出提供可验证证据显示 TASK_LIST.md 在最终工作区仍被改动（例如 git diff -- TASK_LIST.md 非空）时，才可因该项 REJECTED。",
    "",
    `目标：${objective}`,
    "",
    "[planner_plan]",
    planContext,
    "[/planner_plan]",
    "",
    "[executor_output]",
    outputContext,
    "[/executor_output]",
  );
  return sections.join("\n");
}

function buildReviewerContractRepairPrompt(
  objective: string,
  plan: string,
  output: string,
  previousReview: string,
  normalizedFeedback: string,
  round: number,
  limits: WorkflowPromptContextLimits,
  roleSkillBlock: string | null,
): string {
  const planContext = clampPromptContext("planner_plan", plan, limits.plan);
  const outputContext = clampPromptContext("executor_output", output, limits.output);
  const previousReviewContext = clampPromptContext("reviewer_previous_feedback", previousReview, limits.feedback);
  const normalizedFeedbackContext = clampPromptContext("reviewer_normalized_feedback", normalizedFeedback, limits.feedback);
  const sections = ["[role:reviewer]", "[reviewer_contract_repair_request]"];
  if (roleSkillBlock) {
    sections.push(roleSkillBlock);
  }
  sections.push(
    `你上一版审查在第 ${round} 轮未提供可执行 repair contract。请只修复审查契约，不要改目标范围。`,
    "硬性规则：",
    "1) 输出必须包含 VERDICT / SUMMARY / BLOCKERS / REPAIR_CONTRACT_STATUS。",
    "2) 若 VERDICT=REJECTED，则 BLOCKERS 至少一条，且每条都要有 issue/evidence/fix/accept。",
    "3) issue 必须描述问题边界（文件、行为或复现条件）。",
    "4) fix 必须是 executor 可直接执行的最小修复动作。",
    "5) accept 必须是可验证验收（测试命令、断言或行为对比）。",
    "6) 禁止占位词：TBD/TODO/N/A/待补充/同上/later。",
    "",
    "输出模板：",
    "VERDICT: APPROVED 或 REJECTED",
    "SUMMARY: 一句话总结",
    "BLOCKERS:",
    "- [B1][major] issue=<边界>; evidence=<文件/行为>; fix=<可执行修复>; accept=<可验证验收>",
    "REPAIR_CONTRACT_STATUS: COMPLETE 或 INCOMPLETE",
    "",
    `目标：${objective}`,
    "",
    "[planner_plan]",
    planContext,
    "[/planner_plan]",
    "",
    "[executor_output]",
    outputContext,
    "[/executor_output]",
    "",
    "[reviewer_previous_feedback]",
    previousReviewContext,
    "[/reviewer_previous_feedback]",
    "",
    "[reviewer_normalized_feedback]",
    normalizedFeedbackContext,
    "[/reviewer_normalized_feedback]",
  );
  return sections.join("\n");
}

function buildRepairPrompt(
  objective: string,
  plan: string,
  previousOutput: string,
  reviewerFeedback: string,
  round: number,
  limits: WorkflowPromptContextLimits,
  roleSkillBlock: string | null,
): string {
  const planContext = clampPromptContext("planner_plan", plan, limits.plan);
  const previousOutputContext = clampPromptContext("previous_output", previousOutput, limits.output);
  const reviewerFeedbackContext = clampPromptContext("reviewer_feedback", reviewerFeedback, limits.feedback);
  const sections = ["[role:executor]"];
  if (roleSkillBlock) {
    sections.push(roleSkillBlock);
  }
  sections.push(
    `你是软件执行代理。请根据审查反馈进行第 ${round} 轮修复并输出最终版本。`,
    "要求：保持正确内容，修复问题，不要丢失已完成部分。",
    "硬性约束：禁止修改 TASK_LIST.md（含任务状态与正文），任务状态由系统维护。",
    "必须优先按 [normalized_blockers] 逐条完成修复，每条都要有明确处理结果。",
    "输出必须包含：",
    "BLOCKER_STATUS:",
    "- B1: fixed|partial|not-fixed | evidence=<文件/命令/测试>",
    "- B2: ...",
    "DELIVERY_DIFF: 简要列出改动点",
    "VALIDATION: 列出验证命令与结果",
    "VALIDATION_STATUS: PASS 或 FAIL（必须与 VALIDATION 结果一致）",
    "__EXIT_CODES__: 以 key=code 列出验证命令退出码（例如 __EXIT_CODES__ unit=0 lint=0）",
    "",
    `目标：${objective}`,
    "",
    "[planner_plan]",
    planContext,
    "[/planner_plan]",
    "",
    "[previous_output]",
    previousOutputContext,
    "[/previous_output]",
    "",
    "[reviewer_feedback]",
    reviewerFeedbackContext,
    "[/reviewer_feedback]",
  );
  return sections.join("\n");
}

function parseReviewerVerdict(review: string): ReviewerVerdict {
  const verdict = parseReviewerVerdictToken(review);
  const summary = extractReviewSummary(review);
  if (verdict === "APPROVED") {
    return {
      verdict,
      approved: true,
      summary,
      feedback: review,
      blockers: [],
      contractComplete: true,
      contractActionable: true,
    };
  }

  const sections = parseReviewerSections(review);
  const blockersFromSection = sections.blockers.map((item, index) => parseBlockerItem(item, index));
  const blockersFromIssueSuggestion = pairIssuesWithSuggestions(sections.issues, sections.suggestions);
  const normalizedBlockers =
    blockersFromSection.length > 0
      ? blockersFromSection
      : blockersFromIssueSuggestion.length > 0
      ? blockersFromIssueSuggestion
      : [buildFallbackBlocker(summary || "Reviewer did not provide actionable blocker boundaries.")];

  const declaredContractStatus = parseReviewerContractStatusToken(review);
  const contractCompleteByFields =
    verdict === "REJECTED" &&
    blockersFromSection.length > 0 &&
    blockersFromSection.every((blocker) => blocker.issueProvided && blocker.fixProvided && blocker.acceptProvided);
  const contractComplete = contractCompleteByFields && declaredContractStatus !== "INCOMPLETE";
  const contractActionable = contractComplete && blockersFromSection.every(isActionableReviewerBlocker);
  const resolvedSummary = resolveReviewerSummary(verdict, summary);

  return {
    verdict,
    approved: false,
    summary: resolvedSummary,
    feedback: buildNormalizedReviewerFeedback(review, normalizedBlockers, verdict, contractComplete, contractActionable),
    blockers: normalizedBlockers,
    contractComplete,
    contractActionable,
  };
}

function parseReviewerVerdictToken(review: string): "APPROVED" | "REJECTED" | "UNKNOWN" {
  const verdictMatches = review
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^verdict\s*:/i.test(line))
    .map((line) => {
      const value = line.replace(/^verdict\s*:/i, "").trim().toUpperCase();
      const match = value.match(/\b(APPROVED|REJECTED)\b/);
      return match?.[1] ?? "UNKNOWN";
    });

  if (verdictMatches.length === 0) {
    const approved = /\bVERDICT\s*:\s*APPROVED\b/i.test(review);
    const rejected = /\bVERDICT\s*:\s*REJECTED\b/i.test(review);
    if (approved && !rejected) {
      return "APPROVED";
    }
    if (rejected && !approved) {
      return "REJECTED";
    }
    return "UNKNOWN";
  }

  const uniqueVerdicts = new Set(verdictMatches);
  if (uniqueVerdicts.size !== 1) {
    return "UNKNOWN";
  }
  const onlyVerdict = verdictMatches[0];
  if (onlyVerdict === "APPROVED" || onlyVerdict === "REJECTED") {
    return onlyVerdict;
  }
  return "UNKNOWN";
}

function parseReviewerContractStatusToken(review: string): "COMPLETE" | "INCOMPLETE" | "UNKNOWN" {
  const statusMatches = review
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^repair[\s_]*contract[\s_]*status\s*:/i.test(line))
    .map((line) => {
      const value = line.replace(/^repair[\s_]*contract[\s_]*status\s*:/i, "").trim().toUpperCase();
      if (/\bINCOMPLETE\b/.test(value)) {
        return "INCOMPLETE";
      }
      if (/\bCOMPLETE\b/.test(value)) {
        return "COMPLETE";
      }
      return "UNKNOWN";
    });

  if (statusMatches.length === 0) {
    return "UNKNOWN";
  }

  const uniqueStatuses = new Set(statusMatches);
  if (uniqueStatuses.size !== 1) {
    return "UNKNOWN";
  }
  const onlyStatus = statusMatches[0];
  if (onlyStatus === "COMPLETE" || onlyStatus === "INCOMPLETE") {
    return onlyStatus;
  }
  return "UNKNOWN";
}

function resolveReviewerSummary(verdict: "APPROVED" | "REJECTED" | "UNKNOWN", summary: string): string {
  if (verdict !== "UNKNOWN") {
    return summary;
  }
  const fallback = summary && summary !== "(no summary)" ? ` (${summary})` : "";
  return `Reviewer verdict missing or conflicting; default to REJECTED.${fallback}`;
}

function extractReviewSummary(review: string): string {
  const lines = review
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const summaryLine = lines.find((line) => /^summary\s*:/i.test(line));
  if (summaryLine) {
    return summarizeSingleLine(summaryLine.replace(/^summary\s*:/i, "").trim(), 120);
  }
  const verdictLine = lines.find((line) => /^verdict\s*:/i.test(line));
  if (verdictLine) {
    return summarizeSingleLine(verdictLine, 120);
  }
  return summarizeSingleLine(lines[0] ?? "(no summary)", 120);
}

function parseReviewerSections(review: string): { issues: string[]; suggestions: string[]; blockers: string[] } {
  const issues: string[] = [];
  const suggestions: string[] = [];
  const blockers: string[] = [];
  let active: "issues" | "suggestions" | "blockers" | null = null;

  for (const rawLine of review.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^issues?\s*:?\s*$/i.test(line) || /^问题\s*:?\s*$/.test(line)) {
      active = "issues";
      continue;
    }
    if (/^suggestions?\s*:?\s*$/i.test(line) || /^建议\s*:?\s*$/.test(line)) {
      active = "suggestions";
      continue;
    }
    if (/^blockers?\s*:?\s*$/i.test(line) || /^阻塞项\s*:?\s*$/.test(line) || /^修复清单\s*:?\s*$/.test(line)) {
      active = "blockers";
      continue;
    }
    if (isReviewerMetadataLine(line)) {
      active = null;
      continue;
    }
    const bullet = normalizeReviewerBullet(line);
    if (!bullet || !active) {
      continue;
    }
    if (active === "issues") {
      issues.push(bullet);
      continue;
    }
    if (active === "suggestions") {
      suggestions.push(bullet);
      continue;
    }
    blockers.push(bullet);
  }

  return {
    issues,
    suggestions,
    blockers,
  };
}

function normalizeReviewerBullet(line: string): string | null {
  const hasListMarker = /^[-*+•]\s+/.test(line) || /^\d+[.)]\s+/.test(line);
  const withoutMarker = line.replace(/^[-*+•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
  if (!hasListMarker && !/^\[\s*B\d+\s*]/i.test(withoutMarker)) {
    return null;
  }
  if (!withoutMarker) {
    return null;
  }
  if (/^(none|n\/a|无|没有)$/i.test(withoutMarker)) {
    return null;
  }
  return withoutMarker;
}

function isReviewerMetadataLine(line: string): boolean {
  return /^(verdict|summary|repair[\s_]*contract[\s_]*status)\s*:/i.test(line);
}

function parseBlockerItem(item: string, index: number): ReviewerBlocker {
  const idMatch = item.match(/\[\s*(B\d+)\s*]/i);
  const severityMatch = item.match(/\[\s*(critical|major|minor|info)\s*]/i);
  const issueField = matchNamedField(item, ["issue", "problem", "问题"]);
  const evidenceField = matchNamedField(item, ["evidence", "proof", "证据"]);
  const fixField = matchNamedField(item, ["fix", "remediation", "repair", "修复"]);
  const acceptField = matchNamedField(item, ["accept", "acceptance", "验收"]);
  const plainIssue = stripBracketTokens(item);
  const issue = issueField ?? plainIssue;
  return {
    id: (idMatch?.[1] ?? `B${index + 1}`).toUpperCase(),
    severity: normalizeSeverity(severityMatch?.[1] ?? issue),
    issue: issue || "问题边界未明确，需要补充。",
    evidence: evidenceField ?? null,
    fix: fixField ?? "给出最小可执行修复步骤并落到代码/配置。",
    accept: acceptField ?? "提供可验证证据（测试、命令或行为对比）。",
    source: "section",
    issueProvided: Boolean(issueField ?? plainIssue),
    fixProvided: Boolean(fixField),
    acceptProvided: Boolean(acceptField),
  };
}

function pairIssuesWithSuggestions(issues: string[], suggestions: string[]): ReviewerBlocker[] {
  return issues.map((issue, index) => {
    const suggestion = suggestions[index] ?? suggestions[0] ?? "补充最小可执行修复步骤并落地。";
    return {
      id: `B${index + 1}`,
      severity: normalizeSeverity(issue),
      issue,
      evidence: null,
      fix: suggestion,
      accept: "提供可验证证据（测试、命令或行为对比）。",
      source: "issue_suggestion",
      issueProvided: true,
      fixProvided: Boolean(suggestion),
      acceptProvided: false,
    };
  });
}

function buildFallbackBlocker(issue: string): ReviewerBlocker {
  return {
    id: "B1",
    severity: normalizeSeverity(issue),
    issue,
    evidence: null,
    fix: "请先明确问题边界（文件/行为/复现条件）并给出最小可执行修复方案，然后落实到交付物。",
    accept: "提交修复后给出验证命令、结果与风险说明。",
    source: "fallback",
    issueProvided: Boolean(issue),
    fixProvided: false,
    acceptProvided: false,
  };
}

function buildNormalizedReviewerFeedback(
  originalReview: string,
  blockers: ReviewerBlocker[],
  verdict: "APPROVED" | "REJECTED" | "UNKNOWN",
  contractComplete: boolean,
  contractActionable: boolean,
): string {
  const contractStatus = contractComplete ? (contractActionable ? "COMPLETE_ACTIONABLE" : "COMPLETE_NOT_ACTIONABLE") : "INCOMPLETE";
  const sections = [
    "[reviewer_raw_feedback]",
    originalReview.trim() || "(empty)",
    "[/reviewer_raw_feedback]",
    "",
    "[normalized_blockers]",
    ...blockers.map((blocker) =>
      `- [${blocker.id}][${blocker.severity}] issue=${blocker.issue}; evidence=${
        blocker.evidence ?? "n/a"
      }; fix=${blocker.fix}; accept=${blocker.accept}`,
    ),
    "[/normalized_blockers]",
    "",
    `VERDICT_NORMALIZED: ${verdict}`,
    `REPAIR_CONTRACT_STATUS: ${contractStatus}`,
  ];
  return sections.join("\n");
}

function isActionableReviewerBlocker(blocker: ReviewerBlocker): boolean {
  if (!blocker.issueProvided || !blocker.fixProvided || !blocker.acceptProvided) {
    return false;
  }
  return (
    isActionableContractField(blocker.issue) &&
    isActionableContractField(blocker.fix) &&
    isActionableContractField(blocker.accept)
  );
}

function isActionableContractField(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  if (/^(tbd|todo|n\/a|none|null|unknown|later|pending|待补充|待确认|同上|暂无)$/i.test(normalized)) {
    return false;
  }
  if (/\b(to be determined|to be confirmed|same as above)\b/i.test(normalized)) {
    return false;
  }
  return true;
}

function hasActionableRepairContract(verdict: ReviewerVerdict): boolean {
  return !verdict.approved && verdict.contractComplete && verdict.contractActionable && verdict.blockers.length > 0;
}

function formatReviewerContractStatus(verdict: ReviewerVerdict): string {
  if (verdict.approved) {
    return "approved";
  }
  if (!verdict.contractComplete) {
    return "incomplete";
  }
  if (!verdict.contractActionable) {
    return "complete_not_actionable";
  }
  return "actionable";
}

function normalizeSeverity(input: string): "critical" | "major" | "minor" | "info" {
  const lower = input.toLowerCase();
  if (
    lower.includes("critical") ||
    lower.includes("高危") ||
    lower.includes("严重") ||
    lower.includes("security") ||
    lower.includes("权限")
  ) {
    return "critical";
  }
  if (lower.includes("major") || lower.includes("high") || lower.includes("关键") || lower.includes("阻塞")) {
    return "major";
  }
  if (lower.includes("minor") || lower.includes("low") || lower.includes("次要")) {
    return "minor";
  }
  return "info";
}

function stripBracketTokens(value: string): string {
  return value
    .replace(/\[\s*B\d+\s*]/gi, "")
    .replace(/\[\s*(critical|major|minor|info)\s*]/gi, "")
    .replace(/^[:\-–—\s]+/, "")
    .trim();
}

function matchNamedField(text: string, names: string[]): string | null {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escaped}\\s*=\\s*([^;]+)`, "i");
    const match = text.match(regex);
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function summarizeSingleLine(value: string, maxLen: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen)}...`;
}

function formatRoleExecutionStats(result: ExecuteRoleResult): string {
  return `duration=${formatDurationMs(result.durationMs)}, promptChars=${result.promptChars}, replyChars=${result.replyChars}`;
}

function formatRoleSkillProgress(result: WorkflowRoleSkillPromptResult): string {
  if (!result.enabled) {
    return "roleSkills=off";
  }
  if (!result.disclosure || result.usedSkills.length === 0) {
    return `roleSkills=on(mode=${result.mode}, used=0)`;
  }
  const preview = result.usedSkills.slice(0, 3).join("|");
  const extra = result.usedSkills.length > 3 ? `+${result.usedSkills.length - 3}` : "";
  const ids = preview ? `, ids=${preview}${extra}` : "";
  return `roleSkills=on(mode=${result.mode}, disclosure=${result.disclosure}, used=${result.usedSkills.length}${ids})`;
}

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = ((durationMs % 60_000) / 1_000).toFixed(1);
  return `${minutes}m${seconds}s`;
}

function clampPromptContext(label: string, value: string, maxChars: number | null): string {
  const normalized = value.trim();
  if (!normalized) {
    return "(empty)";
  }
  if (typeof maxChars !== "number" || !Number.isFinite(maxChars) || maxChars < 1) {
    return normalized;
  }
  const resolvedMax = Math.floor(maxChars);
  if (normalized.length <= resolvedMax) {
    return normalized;
  }
  const marker = `\n...[${label} truncated: total=${normalized.length} chars]...\n`;
  const remaining = Math.max(0, resolvedMax - marker.length);
  const safeHeadLength = Math.min(Math.floor(remaining * 0.7), normalized.length);
  const tailLength = Math.max(0, remaining - safeHeadLength);
  return `${normalized.slice(0, safeHeadLength)}${marker}${tailLength > 0 ? normalized.slice(-tailLength) : ""}`;
}

function resolvePromptContextLimits(config: MultiAgentWorkflowConfig): WorkflowPromptContextLimits {
  const resolve = (value: number | null | undefined): number | null => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      return null;
    }
    return Math.floor(value);
  };
  return {
    plan: resolve(config.planContextMaxChars),
    output: resolve(config.outputContextMaxChars),
    feedback: resolve(config.feedbackContextMaxChars),
  };
}

export function parseWorkflowCommand(text: string): { kind: "status" } | { kind: "run"; objective: string } | null {
  const normalized = text.trim();
  if (!/^\/+agents(?:\s|$)/i.test(normalized)) {
    return null;
  }

  const normalizedCommand = normalized.replace(/^\/+/, "/");
  const parts = normalizedCommand.split(/\s+/);
  if (parts.length === 1 || parts[1]?.toLowerCase() === "status") {
    return { kind: "status" };
  }
  if (parts[1]?.toLowerCase() !== "run") {
    return null;
  }

  const objective = normalizedCommand.replace(/^\/agents\s+run\s*/i, "").trim();
  return {
    kind: "run",
    objective,
  };
}

export interface WorkflowRunSnapshot {
  state: "idle" | "running" | "succeeded" | "failed";
  startedAt: string | null;
  endedAt: string | null;
  objective: string | null;
  approved: boolean | null;
  repairRounds: number;
  error: string | null;
}

export function createIdleWorkflowSnapshot(): WorkflowRunSnapshot {
  return {
    state: "idle",
    startedAt: null,
    endedAt: null,
    objective: null,
    approved: null,
    repairRounds: 0,
    error: null,
  };
}
