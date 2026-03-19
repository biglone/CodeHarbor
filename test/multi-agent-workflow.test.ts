import { describe, expect, it, vi } from "vitest";

import { CodexExecutionCancelledError } from "../src/executor/codex-executor";
import { MultiAgentWorkflowRunner, parseWorkflowCommand } from "../src/workflow/multi-agent-workflow";

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
    expect(executor.calls).toHaveLength(3);
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
            reply: `VERDICT: REJECTED\nSUMMARY: round ${reviewCount} rejected`,
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
});
