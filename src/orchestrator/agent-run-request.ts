import type { Logger } from "../logger";
import type { RequestOutcomeMetric } from "../metrics";
import type { CodexExecutor } from "../executor/codex-executor";
import type { InboundMessage } from "../types";
import { formatError } from "./helpers";
import { classifyExecutionOutcome } from "./workflow-status";

interface StateStoreLike {
  activateSession: (sessionKey: string, activeWindowMs: number) => void;
  markEventProcessed: (sessionKey: string, eventId: string) => void;
  commitExecutionHandled: (sessionKey: string, eventId: string) => void;
}

interface WorkflowRunnerLike {
  setExecutor: (executor: CodexExecutor) => void;
}

interface ExecuteAgentRunDeps {
  logger: Logger;
  sessionActiveWindowMs: number;
  stateStore: StateStoreLike;
  workflowRunner: WorkflowRunnerLike;
  recordRequestMetrics: (outcome: RequestOutcomeMetric, queueMs: number, execMs: number, sendMs: number) => void;
  persistRuntimeMetricsSnapshot: () => void;
}

interface ExecuteAgentRunInput {
  kind: "workflow" | "autodev";
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
  queueWaitMs: number;
  workdir: string;
  deferFailureHandlingToQueue: boolean;
  executor: CodexExecutor;
  run: () => Promise<void>;
  sendFailure: (conversationId: string, error: unknown) => Promise<number>;
  releaseRateLimit: () => void;
}

export async function executeAgentRunRequest(
  deps: ExecuteAgentRunDeps,
  input: ExecuteAgentRunInput,
): Promise<void> {
  const executionStartedAt = Date.now();
  let sendDurationMs = 0;
  deps.stateStore.activateSession(input.sessionKey, deps.sessionActiveWindowMs);
  deps.workflowRunner.setExecutor(input.executor);
  try {
    const sendStartedAt = Date.now();
    await input.run();
    sendDurationMs += Date.now() - sendStartedAt;
    deps.stateStore.markEventProcessed(input.sessionKey, input.message.eventId);
    deps.recordRequestMetrics("success", input.queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
  } catch (error) {
    if (!input.deferFailureHandlingToQueue) {
      sendDurationMs += await input.sendFailure(input.message.conversationId, error);
      deps.stateStore.commitExecutionHandled(input.sessionKey, input.message.eventId);
    }
    const status = classifyExecutionOutcome(error);
    deps.recordRequestMetrics(status, input.queueWaitMs, Date.now() - executionStartedAt, sendDurationMs);
    deps.logger.error(
      input.kind === "workflow" ? "Workflow request failed" : "AutoDev request failed",
      {
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        workdir: input.workdir,
        error: formatError(error),
      },
    );
    if (input.deferFailureHandlingToQueue) {
      throw error;
    }
  } finally {
    input.releaseRateLimit();
    deps.persistRuntimeMetricsSnapshot();
  }
}
