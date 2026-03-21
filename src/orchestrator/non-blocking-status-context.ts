import { tryHandleNonBlockingStatusRoute as runNonBlockingStatusRoute } from "./non-blocking-status-route";

type NonBlockingStatusRouteContext = Parameters<typeof runNonBlockingStatusRoute>[0];

interface NonBlockingStatusContextInput {
  logger: NonBlockingStatusRouteContext["logger"];
  workflowEnabled: boolean;
  hasProcessedEvent: NonBlockingStatusRouteContext["hasProcessedEvent"];
  markEventProcessed: NonBlockingStatusRouteContext["markEventProcessed"];
  recordRequestMetrics: NonBlockingStatusRouteContext["recordRequestMetrics"];
  handleControlCommand: NonBlockingStatusRouteContext["handleControlCommand"];
  handleWorkflowStatusCommand: NonBlockingStatusRouteContext["handleWorkflowStatusCommand"];
  handleAutoDevStatusCommand: NonBlockingStatusRouteContext["handleAutoDevStatusCommand"];
  handleAutoDevProgressCommand: NonBlockingStatusRouteContext["handleAutoDevProgressCommand"];
  handleAutoDevSkillsCommand: NonBlockingStatusRouteContext["handleAutoDevSkillsCommand"];
  handleAutoDevLoopStopCommand: NonBlockingStatusRouteContext["handleAutoDevLoopStopCommand"];
}

export function buildNonBlockingStatusRouteContext(
  input: NonBlockingStatusContextInput,
): NonBlockingStatusRouteContext {
  return {
    logger: input.logger,
    workflowEnabled: input.workflowEnabled,
    hasProcessedEvent: input.hasProcessedEvent,
    markEventProcessed: input.markEventProcessed,
    recordRequestMetrics: input.recordRequestMetrics,
    handleControlCommand: input.handleControlCommand,
    handleWorkflowStatusCommand: input.handleWorkflowStatusCommand,
    handleAutoDevStatusCommand: input.handleAutoDevStatusCommand,
    handleAutoDevProgressCommand: input.handleAutoDevProgressCommand,
    handleAutoDevSkillsCommand: input.handleAutoDevSkillsCommand,
    handleAutoDevLoopStopCommand: input.handleAutoDevLoopStopCommand,
  };
}
