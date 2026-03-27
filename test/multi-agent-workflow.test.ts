import { describe, expect, it, vi } from "vitest";

import { CodexExecutionCancelledError } from "../src/executor/codex-executor";
import { MultiAgentWorkflowRunner, parseWorkflowCommand } from "../src/workflow/multi-agent-workflow";
import { WorkflowRoleSkillCatalog } from "../src/workflow/role-skills";

type ScenarioInput = {
  prompt: string;
  sessionId: string | null;
  workdir: string | null;
  timeoutMs: number | null;
};

type ScenarioOutput = {
  result: Promise<{ sessionId: string; reply: string }>;
  cancel: () => void;
};

class ScenarioExecutor {
  calls: ScenarioInput[] = [];
  private readonly scenario: (input: ScenarioInput) => ScenarioOutput;

  constructor(scenario: (input: ScenarioInput) => ScenarioOutput) {
    this.scenario = scenario;
  }

  startExecution(
    prompt: string,
    sessionId: string | null,
    _onProgress?: (event: unknown) => void,
    startOptions?: { workdir?: string; timeoutMs?: number | null },
  ): ScenarioOutput {
    const input = {
      prompt,
      sessionId,
      workdir: startOptions?.workdir ?? null,
      timeoutMs: startOptions?.timeoutMs ?? null,
    };
    this.calls.push(input);
    return this.scenario(input);
  }
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("MultiAgentWorkflowRunner", () => {
  it("parses /agents commands", () => {
    expect(parseWorkflowCommand("/agents")).toEqual({ kind: "status" });
    expect(parseWorkflowCommand(" /agents status ")).toEqual({ kind: "status" });
    expect(parseWorkflowCommand("//agents status")).toEqual({ kind: "status" });
    expect(parseWorkflowCommand("///agents status")).toEqual({ kind: "status" });
    expect(parseWorkflowCommand("/agents run   build release package")).toEqual({
      kind: "run",
      objective: "build release package",
    });
    expect(parseWorkflowCommand("//agents run fix flaky tests")).toEqual({
      kind: "run",
      objective: "fix flaky tests",
    });
    expect(parseWorkflowCommand("///agents run build ui")).toEqual({
      kind: "run",
      objective: "build ui",
    });
    expect(parseWorkflowCommand("/agents unknown")).toBeNull();
    expect(parseWorkflowCommand("/agent run x")).toBeNull();
  });

  it("treats malformed reviewer verdict as rejected without repair when max rounds is zero", async () => {
    const executor = new ScenarioExecutor((input) => {
      let reply = "ok";
      if (input.prompt.includes("[role:planner]")) {
        reply = "1) plan";
      } else if (input.prompt.includes("[role:executor]")) {
        reply = "delivery output";
      } else if (input.prompt.includes("[role:reviewer]")) {
        reply = "SUMMARY: missing verdict field";
      }
      return {
        result: Promise.resolve({
          sessionId: input.sessionId ?? `thread-${Math.random().toString(36).slice(2, 8)}`,
          reply,
        }),
        cancel: () => {},
      };
    });

    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 0,
    });

    const progress: string[] = [];
    const result = await runner.run({
      objective: "  deliver summary  ",
      workdir: "/tmp/workflow-unit",
      onProgress: (event) => {
        progress.push(`${event.stage}:${event.round}`);
      },
    });

    expect(result.objective).toBe("deliver summary");
    expect(result.approved).toBe(false);
    expect(result.repairRounds).toBe(0);
    expect(result.review).toContain("missing verdict");
    expect(progress).toEqual(expect.arrayContaining(["planner:0", "executor:0", "reviewer:0"]));
    expect(progress.filter((entry) => entry === "planner:0").length).toBeGreaterThanOrEqual(2);
    expect(progress.filter((entry) => entry === "executor:0").length).toBeGreaterThanOrEqual(2);
    expect(progress.filter((entry) => entry === "reviewer:0").length).toBeGreaterThanOrEqual(2);
    expect(executor.calls).toHaveLength(5);
    expect(executor.calls.filter((call) => call.prompt.includes("[reviewer_contract_repair_request]"))).toHaveLength(2);
    expect(executor.calls.some((call) => call.prompt.includes("[reviewer_feedback]"))).toBe(false);
    expect(executor.calls.every((call) => call.workdir === "/tmp/workflow-unit")).toBe(true);
  });

  it("caps repair rounds and keeps each role call stateless across rounds", async () => {
    let reviewCount = 0;
    const executor = new ScenarioExecutor((input) => {
      if (input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({ sessionId: input.sessionId ?? "planner-thread", reply: "plan-v1" }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[role:reviewer]")) {
        reviewCount += 1;
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "reviewer-thread",
            reply: [
              "VERDICT: REJECTED",
              `SUMMARY: round ${reviewCount} rejected`,
              "BLOCKERS:",
              `- [B1][major] issue=missing validation guard in round ${reviewCount}; evidence=src/workflow.ts; fix=add guard branch for round ${reviewCount}; accept=run unit workflow tests`,
            ].join("\n"),
          }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[reviewer_feedback]")) {
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "executor-thread",
            reply: "repaired-output",
          }),
          cancel: () => {},
        };
      }
      return {
        result: Promise.resolve({
          sessionId: input.sessionId ?? "executor-thread",
          reply: "initial-output",
        }),
        cancel: () => {},
      };
    });

    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 2,
    });

    const result = await runner.run({
      objective: "produce delivery",
      workdir: "/tmp/workflow-unit",
    });

    expect(result.approved).toBe(false);
    expect(result.repairRounds).toBe(2);
    expect(reviewCount).toBe(3);
    expect(executor.calls).toHaveLength(7);
    expect(executor.calls.every((call) => call.sessionId === null)).toBe(true);
    const repairPrompt = executor.calls.find((call) => call.prompt.includes("[reviewer_feedback]"))?.prompt ?? "";
    expect(repairPrompt).toContain("[normalized_blockers]");
    expect(repairPrompt).toContain("REPAIR_CONTRACT_STATUS");
    expect(repairPrompt).toContain("[B1]");
  });

  it("requests reviewer contract repair before executor repair", async () => {
    let reviewerCount = 0;
    let contractRepairCount = 0;
    let executorRepairCount = 0;
    const executor = new ScenarioExecutor((input) => {
      if (input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({ sessionId: input.sessionId ?? "planner-thread", reply: "plan-v1" }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[reviewer_contract_repair_request]")) {
        contractRepairCount += 1;
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "reviewer-thread",
            reply: [
              "VERDICT: REJECTED",
              "SUMMARY: blocker contract repaired",
              "BLOCKERS:",
              "- [B1][major] issue=matrix image summary misses alt text; evidence=src/channels/matrix-channel.ts; fix=render text fallback when media summary exists; accept=matrix channel test covers media summary text",
            ].join("\n"),
          }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[role:reviewer]")) {
        reviewerCount += 1;
        if (reviewerCount === 1) {
          return {
            result: Promise.resolve({
              sessionId: input.sessionId ?? "reviewer-thread",
              reply: "VERDICT: REJECTED\nSUMMARY: missing actionable blockers\nISSUES:\n- media summary not verifiable",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "reviewer-thread",
            reply: "VERDICT: APPROVED\nSUMMARY: repaired output accepted",
          }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[reviewer_feedback]")) {
        executorRepairCount += 1;
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "executor-thread",
            reply: "repaired-output",
          }),
          cancel: () => {},
        };
      }
      return {
        result: Promise.resolve({
          sessionId: input.sessionId ?? "executor-thread",
          reply: "initial-output",
        }),
        cancel: () => {},
      };
    });

    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 1,
    });

    const result = await runner.run({
      objective: "repair reviewer contract",
      workdir: "/tmp/workflow-unit",
    });

    expect(result.approved).toBe(true);
    expect(result.repairRounds).toBe(1);
    expect(contractRepairCount).toBe(1);
    expect(executorRepairCount).toBe(1);

    const contractRepairIndex = executor.calls.findIndex((call) =>
      call.prompt.includes("[reviewer_contract_repair_request]"),
    );
    const executorRepairIndex = executor.calls.findIndex((call) => call.prompt.includes("[reviewer_feedback]"));
    expect(contractRepairIndex).toBeGreaterThanOrEqual(0);
    expect(executorRepairIndex).toBeGreaterThan(contractRepairIndex);

    const repairPrompt = executor.calls.find((call) => call.prompt.includes("[reviewer_feedback]"))?.prompt ?? "";
    expect(repairPrompt).toContain("REPAIR_CONTRACT_STATUS: COMPLETE_ACTIONABLE");
  });

  it("does not count reviewer contract repair rounds as executor repair rounds", async () => {
    let reviewerCount = 0;
    let contractRepairCount = 0;
    const executor = new ScenarioExecutor((input) => {
      if (input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({ sessionId: input.sessionId ?? "planner-thread", reply: "plan-v1" }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[reviewer_contract_repair_request]")) {
        contractRepairCount += 1;
        if (contractRepairCount === 1) {
          return {
            result: Promise.resolve({
              sessionId: input.sessionId ?? "reviewer-thread",
              reply: [
                "VERDICT: REJECTED",
                "SUMMARY: still incomplete contract",
                "BLOCKERS:",
                "- [B1][major] issue=missing release guard; fix=add release guard in publish flow",
              ].join("\n"),
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "reviewer-thread",
            reply: [
              "VERDICT: REJECTED",
              "SUMMARY: contract complete now",
              "BLOCKERS:",
              "- [B1][major] issue=missing release guard in publish workflow; evidence=src/orchestrator/autodev-release.ts; fix=block release when reviewer approval is false; accept=autodev release unit tests cover approval false path",
            ].join("\n"),
          }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[role:reviewer]")) {
        reviewerCount += 1;
        if (reviewerCount === 1) {
          return {
            result: Promise.resolve({
              sessionId: input.sessionId ?? "reviewer-thread",
              reply: "VERDICT: REJECTED\nSUMMARY: first review without blocker contract",
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "reviewer-thread",
            reply: "VERDICT: APPROVED\nSUMMARY: all fixed",
          }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[reviewer_feedback]")) {
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "executor-thread",
            reply: "repaired-output",
          }),
          cancel: () => {},
        };
      }
      return {
        result: Promise.resolve({
          sessionId: input.sessionId ?? "executor-thread",
          reply: "initial-output",
        }),
        cancel: () => {},
      };
    });

    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 1,
    });

    const result = await runner.run({
      objective: "do not count contract rounds as repair rounds",
      workdir: "/tmp/workflow-unit",
    });

    expect(result.approved).toBe(true);
    expect(result.repairRounds).toBe(1);
    expect(contractRepairCount).toBe(2);
  });

  it("ignores REPAIRCONTRACTSTATUS metadata line in blocker section parsing", async () => {
    let reviewerCount = 0;
    let contractRepairCount = 0;
    let executorRepairCount = 0;
    const executor = new ScenarioExecutor((input) => {
      if (input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({ sessionId: input.sessionId ?? "planner-thread", reply: "plan-v1" }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[reviewer_contract_repair_request]")) {
        contractRepairCount += 1;
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "reviewer-thread",
            reply: "VERDICT: REJECTED\nSUMMARY: should not be called",
          }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[role:reviewer]")) {
        reviewerCount += 1;
        if (reviewerCount === 1) {
          return {
            result: Promise.resolve({
              sessionId: input.sessionId ?? "reviewer-thread",
              reply: [
                "VERDICT: REJECTED",
                "SUMMARY: needs one repair",
                "BLOCKERS:",
                "- [B1][major] issue=missing timeout guard in workflow loop; evidence=src/orchestrator/autodev-runner.ts; fix=add timeout guard before next round; accept=workflow unit tests include timeout guard path",
                "REPAIRCONTRACTSTATUS: COMPLETE",
              ].join("\n"),
            }),
            cancel: () => {},
          };
        }
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "reviewer-thread",
            reply: "VERDICT: APPROVED\nSUMMARY: repaired",
          }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[reviewer_feedback]")) {
        executorRepairCount += 1;
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "executor-thread",
            reply: "repaired-output",
          }),
          cancel: () => {},
        };
      }
      return {
        result: Promise.resolve({
          sessionId: input.sessionId ?? "executor-thread",
          reply: "initial-output",
        }),
        cancel: () => {},
      };
    });

    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 1,
    });

    const result = await runner.run({
      objective: "ignore repair contract metadata line",
      workdir: "/tmp/workflow-unit",
    });

    expect(result.approved).toBe(true);
    expect(result.repairRounds).toBe(1);
    expect(executorRepairCount).toBe(1);
    expect(contractRepairCount).toBe(0);
  });

  it("stops workflow repair when reviewer contract remains non-actionable", async () => {
    let contractRepairCount = 0;
    const executor = new ScenarioExecutor((input) => {
      if (input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({ sessionId: input.sessionId ?? "planner-thread", reply: "plan-v1" }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[reviewer_contract_repair_request]")) {
        contractRepairCount += 1;
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "reviewer-thread",
            reply: [
              "VERDICT: REJECTED",
              "SUMMARY: still no actionable contract",
              "BLOCKERS:",
              "- [B1][major] issue=TBD; evidence=n/a; fix=TODO; accept=TBD",
            ].join("\n"),
          }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[role:reviewer]")) {
        return {
          result: Promise.resolve({
            sessionId: input.sessionId ?? "reviewer-thread",
            reply: "VERDICT: REJECTED\nSUMMARY: contract missing",
          }),
          cancel: () => {},
        };
      }
      return {
        result: Promise.resolve({
          sessionId: input.sessionId ?? "executor-thread",
          reply: "initial-output",
        }),
        cancel: () => {},
      };
    });

    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 2,
    });

    const progressMessages: string[] = [];
    const result = await runner.run({
      objective: "hard stop on non actionable reviewer contract",
      workdir: "/tmp/workflow-unit",
      onProgress: (event) => {
        progressMessages.push(event.message);
      },
    });

    expect(result.approved).toBe(false);
    expect(result.repairRounds).toBe(0);
    expect(contractRepairCount).toBe(2);
    expect(executor.calls.some((call) => call.prompt.includes("[reviewer_feedback]"))).toBe(false);
    expect(progressMessages.some((line) => line.includes("已停止自动修复"))).toBe(true);
  });

  it("cancels active role execution when registered cancel callback is invoked", async () => {
    let rejectRunning: ((error: unknown) => void) | null = null;
    let cancelCount = 0;
    const executor = new ScenarioExecutor(() => {
      const result = new Promise<{ sessionId: string; reply: string }>((_resolve, reject) => {
        rejectRunning = reject;
      });
      return {
        result,
        cancel: () => {
          cancelCount += 1;
          rejectRunning?.(new CodexExecutionCancelledError("cancelled by unit test"));
        },
      };
    });

    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 1,
    });

    let cancelWorkflow: (() => void) | undefined;
    const running = runner.run({
      objective: "cancel me",
      workdir: "/tmp/workflow-unit",
      onRegisterCancel: (next) => {
        cancelWorkflow = next;
      },
    });

    await Promise.resolve();
    if (!cancelWorkflow) {
      throw new Error("cancel callback not registered");
    }
    cancelWorkflow();

    await expect(running).rejects.toBeInstanceOf(CodexExecutionCancelledError);
    expect(cancelCount).toBe(1);
  });

  it("uses a higher default timeout per workflow role and allows override", async () => {
    const executor = new ScenarioExecutor((input) => {
      let reply = "ok";
      if (input.prompt.includes("[role:planner]")) {
        reply = "plan";
      } else if (input.prompt.includes("[role:executor]")) {
        reply = "output";
      } else if (input.prompt.includes("[role:reviewer]")) {
        reply = "VERDICT: APPROVED\nSUMMARY: done";
      }
      return {
        result: Promise.resolve({
          sessionId: input.sessionId ?? "s",
          reply,
        }),
        cancel: () => {},
      };
    });

    const defaultRunner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 0,
    });
    await defaultRunner.run({
      objective: "default timeout",
      workdir: "/tmp/workflow-unit",
    });
    expect(executor.calls[0]?.timeoutMs).toBe(30 * 60 * 1000);

    executor.calls.length = 0;

    const customRunner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 0,
      executionTimeoutMs: 42_000,
    });
    await customRunner.run({
      objective: "custom timeout",
      workdir: "/tmp/workflow-unit",
    });
    expect(executor.calls[0]?.timeoutMs).toBe(42_000);
  });

  it("enforces structured validation contract in executor and reviewer prompts", async () => {
    const executor = new ScenarioExecutor((input) => {
      if (input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({ sessionId: "planner-thread", reply: "plan" }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[role:reviewer]")) {
        return {
          result: Promise.resolve({ sessionId: "reviewer-thread", reply: "VERDICT: APPROVED\nSUMMARY: done" }),
          cancel: () => {},
        };
      }
      return {
        result: Promise.resolve({ sessionId: "executor-thread", reply: "output" }),
        cancel: () => {},
      };
    });

    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 0,
    });
    await runner.run({
      objective: "structured validation contract",
      workdir: "/tmp/workflow-unit",
    });

    const executorPrompt = executor.calls.find((call) => call.prompt.includes("[role:executor]"))?.prompt ?? "";
    const reviewerPrompt = executor.calls.find((call) => call.prompt.includes("[role:reviewer]"))?.prompt ?? "";

    expect(executorPrompt).toContain("VALIDATION_STATUS: PASS 或 FAIL");
    expect(executorPrompt).toContain("__EXIT_CODES__");
    expect(reviewerPrompt).toContain("缺失 VALIDATION_STATUS 或 __EXIT_CODES__，必须 REJECTED");
  });

  it("truncates oversized role context before passing it to the next stage", async () => {
    const oversizedOutput = "x".repeat(30_000);
    const executor = new ScenarioExecutor((input) => {
      if (input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({ sessionId: "planner-thread", reply: "plan" }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[role:reviewer]")) {
        return {
          result: Promise.resolve({ sessionId: "reviewer-thread", reply: "VERDICT: APPROVED\nSUMMARY: done" }),
          cancel: () => {},
        };
      }
      return {
        result: Promise.resolve({ sessionId: "executor-thread", reply: oversizedOutput }),
        cancel: () => {},
      };
    });

    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 0,
      outputContextMaxChars: 1_200,
    });
    await runner.run({
      objective: "keep prompt budget stable",
      workdir: "/tmp/workflow-unit",
    });

    const reviewerPrompt = executor.calls.find((call) => call.prompt.includes("[role:reviewer]"))?.prompt ?? "";
    expect(reviewerPrompt).toContain("executor_output truncated");
    expect(reviewerPrompt).not.toContain(oversizedOutput);
    expect(reviewerPrompt.length).toBeLessThan(2_000);
  });

  it("injects role skill blocks into role prompts when catalog is configured", async () => {
    const executor = new ScenarioExecutor((input) => {
      if (input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({ sessionId: "planner-thread", reply: "plan" }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[role:reviewer]")) {
        return {
          result: Promise.resolve({ sessionId: "reviewer-thread", reply: "VERDICT: APPROVED\nSUMMARY: done" }),
          cancel: () => {},
        };
      }
      return {
        result: Promise.resolve({ sessionId: "executor-thread", reply: "output" }),
        cancel: () => {},
      };
    });

    const roleSkillCatalog = new WorkflowRoleSkillCatalog({
      enabled: true,
      mode: "summary",
      roots: [],
      roleAssignments: {
        planner: ["builtin-planner-core"],
        executor: ["builtin-executor-core"],
        reviewer: ["builtin-reviewer-core"],
      },
    });
    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 0,
      roleSkillCatalog,
    });

    await runner.run({
      objective: "inject role skills",
      workdir: "/tmp/workflow-unit",
    });

    const plannerPrompt = executor.calls.find((call) => call.prompt.includes("[role:planner]"))?.prompt ?? "";
    const reviewerPrompt = executor.calls.find((call) => call.prompt.includes("[role:reviewer]"))?.prompt ?? "";
    expect(plannerPrompt).toContain("[role_skills]");
    expect(plannerPrompt).toContain("role=planner");
    expect(reviewerPrompt).toContain("role=reviewer");
  });

  it("supports per-run role skill disable override", async () => {
    const executor = new ScenarioExecutor((input) => {
      if (input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({ sessionId: "planner-thread", reply: "plan" }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[role:reviewer]")) {
        return {
          result: Promise.resolve({ sessionId: "reviewer-thread", reply: "VERDICT: APPROVED\nSUMMARY: done" }),
          cancel: () => {},
        };
      }
      return {
        result: Promise.resolve({ sessionId: "executor-thread", reply: "output" }),
        cancel: () => {},
      };
    });

    const roleSkillCatalog = new WorkflowRoleSkillCatalog({
      enabled: true,
      mode: "full",
      roots: [],
      roleAssignments: {
        planner: ["builtin-planner-core"],
      },
    });
    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 0,
      roleSkillCatalog,
    });

    await runner.run({
      objective: "disable role skills",
      workdir: "/tmp/workflow-unit",
      roleSkillPolicy: {
        enabled: false,
      },
    });

    const plannerPrompt = executor.calls.find((call) => call.prompt.includes("[role:planner]"))?.prompt ?? "";
    expect(plannerPrompt).not.toContain("[role_skills]");
  });

  it("injects system task-list policy context into reviewer prompt when resolver is provided", async () => {
    const resolverCalls: number[] = [];
    const executor = new ScenarioExecutor((input) => {
      if (input.prompt.includes("[role:planner]")) {
        return {
          result: Promise.resolve({ sessionId: "planner-thread", reply: "plan" }),
          cancel: () => {},
        };
      }
      if (input.prompt.includes("[role:reviewer]")) {
        return {
          result: Promise.resolve({ sessionId: "reviewer-thread", reply: "VERDICT: APPROVED\nSUMMARY: done" }),
          cancel: () => {},
        };
      }
      return {
        result: Promise.resolve({ sessionId: "executor-thread", reply: "output" }),
        cancel: () => {},
      };
    });

    const runner = new MultiAgentWorkflowRunner(executor as never, logger as never, {
      enabled: true,
      autoRepairMaxRounds: 0,
    });

    await runner.run({
      objective: "inject policy context",
      workdir: "/tmp/workflow-unit",
      resolveReviewerTaskListPolicyContext: ({ round }) => {
        resolverCalls.push(round);
        return ["changedSinceBaseline=no", "restoredBySystem=yes", "finalClean=yes"].join("\n");
      },
    });

    expect(resolverCalls).toEqual([1]);
    const reviewerPrompt = executor.calls.find((call) => call.prompt.includes("[role:reviewer]"))?.prompt ?? "";
    expect(reviewerPrompt).toContain("[system_task_list_policy]");
    expect(reviewerPrompt).toContain("changedSinceBaseline=no");
    expect(reviewerPrompt).toContain("finalClean=yes");
    expect(reviewerPrompt).toContain("[/system_task_list_policy]");
  });
});
