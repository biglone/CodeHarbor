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

export interface MultiAgentWorkflowConfig {
  enabled: boolean;
  autoRepairMaxRounds: number;
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

const DEFAULT_WORKFLOW_EXECUTION_TIMEOUT_MS = 30 * 60 * 1_000;

interface WorkflowPromptContextLimits {
  plan: number | null;
  output: number | null;
  feedback: number | null;
}

export class MultiAgentWorkflowRunner {
  private executor: CodexExecutor;
  private readonly logger: Logger;
  private readonly config: MultiAgentWorkflowConfig;
  private readonly promptContextLimits: WorkflowPromptContextLimits;
  private readonly roleSkillCatalog: WorkflowRoleSkillCatalog | null;

  constructor(executor: CodexExecutor, logger: Logger, config: MultiAgentWorkflowConfig) {
    this.executor = executor;
    this.logger = logger;
    this.config = config;
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
      message: `Planner 开始生成执行计划（agent=planner, timeout=${formatDurationMs(
        roleTimeoutMs,
      )}, ${formatRoleSkillProgress(plannerSkillPrompt)}）`,
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
      message: `Planner 执行完成（agent=planner, ${formatRoleExecutionStats(planResult)}）`,
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
      message: `Executor 开始根据计划执行任务（agent=executor, timeout=${formatDurationMs(
        roleTimeoutMs,
      )}, ${formatRoleSkillProgress(executorSkillPrompt)}）`,
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
      message: `Executor 初版交付完成（agent=executor, ${formatRoleExecutionStats(outputResult)}）`,
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
        message: `Reviewer 开始质量审查（agent=reviewer, round=${attempt + 1}, timeout=${formatDurationMs(
          roleTimeoutMs,
        )}, ${formatRoleSkillProgress(reviewerSkillPrompt)}）`,
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

      const verdict = parseReviewerVerdict(finalReviewReply);
      await emitProgress(input, {
        stage: "reviewer",
        round: attempt,
        message: `Reviewer 审查完成（agent=reviewer, round=${attempt + 1}, verdict=${
          verdict.approved ? "APPROVED" : "REJECTED"
        }, ${formatRoleExecutionStats(reviewResult)}）${verdict.approved ? "" : `，summary=${extractReviewSummary(finalReviewReply)}`}`,
      });
      if (verdict.approved) {
        approved = true;
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
        message: `Executor 开始按 Reviewer 反馈修复（agent=executor, repairRound=${repairRounds}, timeout=${formatDurationMs(
          roleTimeoutMs,
        )}, ${formatRoleSkillProgress(repairSkillPrompt)}）`,
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
        message: `Executor 修复轮次完成（agent=executor, repairRound=${repairRounds}, ${formatRoleExecutionStats(outputResult)}）`,
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

function parseReviewerVerdict(review: string): { approved: boolean; feedback: string } {
  const approved = /\bVERDICT\s*:\s*APPROVED\b/i.test(review);
  const rejected = /\bVERDICT\s*:\s*REJECTED\b/i.test(review);
  if (approved) {
    return { approved: true, feedback: review };
  }
  if (rejected) {
    return { approved: false, feedback: review };
  }

  return {
    approved: false,
    feedback: review.trim() || "Reviewer 未返回规范 verdict，默认按 REJECTED 处理。",
  };
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
