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
  handleAutoDevReconcileCommand: NonBlockingStatusRouteContext["handleAutoDevReconcileCommand"];
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
    handleAutoDevReconcileCommand: input.handleAutoDevReconcileCommand,
  };
}

interface NonBlockingStatusRuntimeContextInput {
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
  handleAutoDevReconcileCommand: NonBlockingStatusRouteContext["handleAutoDevReconcileCommand"];
}

export function buildNonBlockingStatusRouteContextFromRuntime(
  input: NonBlockingStatusRuntimeContextInput,
): NonBlockingStatusRouteContext {
  return buildNonBlockingStatusRouteContext({
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
    handleAutoDevReconcileCommand: input.handleAutoDevReconcileCommand,
  });
}

type NonBlockingStatusRouteInput = Parameters<typeof runNonBlockingStatusRoute>[1];

interface NonBlockingStatusRouteRuntimeExecutionInput {
  route: NonBlockingStatusRouteInput["route"];
  sessionKey: string;
  message: NonBlockingStatusRouteInput["message"];
  requestId: string;
  workdir: string;
  queueWaitMs: number;
}

export async function executeNonBlockingStatusRouteFromRuntime(
  deps: NonBlockingStatusRuntimeContextInput,
  input: NonBlockingStatusRouteRuntimeExecutionInput,
): Promise<boolean> {
  return runNonBlockingStatusRoute(
    buildNonBlockingStatusRouteContextFromRuntime(deps),
    {
      route: input.route,
      sessionKey: input.sessionKey,
      message: input.message,
      requestId: input.requestId,
      workdir: input.workdir,
      queueWaitMs: input.queueWaitMs,
    },
  );
}
