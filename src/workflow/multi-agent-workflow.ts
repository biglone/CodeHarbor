import {
  CodexExecutionCancelledError,
  CodexExecutor,
  type CodexExecutionHandle,
} from "../executor/codex-executor";
import { Logger } from "../logger";

export interface MultiAgentWorkflowConfig {
  enabled: boolean;
  autoRepairMaxRounds: number;
  executionTimeoutMs?: number;
  planContextMaxChars?: number | null;
  outputContextMaxChars?: number | null;
  feedbackContextMaxChars?: number | null;
}

export interface MultiAgentWorkflowProgressEvent {
  stage: "planner" | "executor" | "reviewer" | "repair";
  round: number;
  message: string;
}

export interface MultiAgentWorkflowRunInput {
  objective: string;
  workdir: string;
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
}

const DEFAULT_WORKFLOW_EXECUTION_TIMEOUT_MS = 30 * 60 * 1_000;

interface WorkflowPromptContextLimits {
  plan: number | null;
  output: number | null;
  feedback: number | null;
}

export class MultiAgentWorkflowRunner {
  private readonly executor: CodexExecutor;
  private readonly logger: Logger;
  private readonly config: MultiAgentWorkflowConfig;
  private readonly promptContextLimits: WorkflowPromptContextLimits;

  constructor(executor: CodexExecutor, logger: Logger, config: MultiAgentWorkflowConfig) {
    this.executor = executor;
    this.logger = logger;
    this.config = config;
    this.promptContextLimits = resolvePromptContextLimits(config);
  }

  isEnabled(): boolean {
    return this.config.enabled;
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

    await emitProgress(input, {
      stage: "planner",
      round: 0,
      message: "Planner 正在生成执行计划",
    });
    const roleTimeoutMs = this.resolveRoleTimeoutMs();
    const planResult = await this.executeRole(
      "planner",
      buildPlannerPrompt(objective),
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
      stage: "executor",
      round: 0,
      message: "Executor 正在根据计划执行任务",
    });
    let outputResult = await this.executeRole(
      "executor",
      buildExecutorPrompt(objective, plan, this.promptContextLimits),
      null,
      input.workdir,
      roleTimeoutMs,
      () => cancelled,
      (handle) => {
        activeHandle = handle;
      },
    );

    let finalReviewReply = "";
    let approved = false;
    let repairRounds = 0;

    for (let attempt = 0; attempt <= maxRepairRounds; attempt += 1) {
      await emitProgress(input, {
        stage: "reviewer",
        round: attempt,
        message: `Reviewer 正在进行质量审查（round ${attempt + 1}）`,
      });
      const reviewResult = await this.executeRole(
        "reviewer",
        buildReviewerPrompt(objective, plan, outputResult.reply, this.promptContextLimits),
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
      if (verdict.approved) {
        approved = true;
        break;
      }

      if (attempt >= maxRepairRounds) {
        break;
      }

      repairRounds = attempt + 1;
      await emitProgress(input, {
        stage: "repair",
        round: repairRounds,
        message: `Executor 正在按 Reviewer 反馈进行修复（round ${repairRounds}）`,
      });

      outputResult = await this.executeRole(
        "executor",
        buildRepairPrompt(objective, plan, outputResult.reply, verdict.feedback, repairRounds, this.promptContextLimits),
        null,
        input.workdir,
        roleTimeoutMs,
        () => cancelled,
        (handle) => {
          activeHandle = handle;
        },
      );
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

    const handle = this.executor.startExecution(prompt, sessionId, undefined, { workdir, timeoutMs });
    setActiveHandle(handle);
    try {
      const result = await handle.result;
      return {
        sessionId: result.sessionId,
        reply: result.reply,
      };
    } finally {
      setActiveHandle(null);
    }
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

function buildPlannerPrompt(objective: string): string {
  return [
    "[role:planner]",
    "你是软件交付规划代理。请基于目标给出可执行计划。",
    "输出要求：",
    "1. 任务拆解（3-7 步）",
    "2. 每步输入/输出",
    "3. 风险与回退方案",
    "",
    `目标：${objective}`,
  ].join("\n");
}

function buildExecutorPrompt(objective: string, plan: string, limits: WorkflowPromptContextLimits): string {
  const planContext = clampPromptContext("planner_plan", plan, limits.plan);
  return [
    "[role:executor]",
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
  ].join("\n");
}

function buildReviewerPrompt(
  objective: string,
  plan: string,
  output: string,
  limits: WorkflowPromptContextLimits,
): string {
  const planContext = clampPromptContext("planner_plan", plan, limits.plan);
  const outputContext = clampPromptContext("executor_output", output, limits.output);
  return [
    "[role:reviewer]",
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
  ].join("\n");
}

function buildRepairPrompt(
  objective: string,
  plan: string,
  previousOutput: string,
  reviewerFeedback: string,
  round: number,
  limits: WorkflowPromptContextLimits,
): string {
  const planContext = clampPromptContext("planner_plan", plan, limits.plan);
  const previousOutputContext = clampPromptContext("previous_output", previousOutput, limits.output);
  const reviewerFeedbackContext = clampPromptContext("reviewer_feedback", reviewerFeedback, limits.feedback);
  return [
    "[role:executor]",
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
  ].join("\n");
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
