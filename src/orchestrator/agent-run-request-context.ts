import { executeAgentRunRequest } from "./agent-run-request";

type AgentRunRequestContext = Parameters<typeof executeAgentRunRequest>[0];

interface AgentRunRequestContextInput {
  logger: AgentRunRequestContext["logger"];
  sessionActiveWindowMs: number;
  stateStore: AgentRunRequestContext["stateStore"];
  workflowRunner: AgentRunRequestContext["workflowRunner"];
  recordRequestMetrics: AgentRunRequestContext["recordRequestMetrics"];
  persistRuntimeMetricsSnapshot: AgentRunRequestContext["persistRuntimeMetricsSnapshot"];
}

export function buildAgentRunRequestContext(input: AgentRunRequestContextInput): AgentRunRequestContext {
  return {
    logger: input.logger,
    sessionActiveWindowMs: input.sessionActiveWindowMs,
    stateStore: input.stateStore,
    workflowRunner: input.workflowRunner,
    recordRequestMetrics: input.recordRequestMetrics,
    persistRuntimeMetricsSnapshot: input.persistRuntimeMetricsSnapshot,
  };
}
