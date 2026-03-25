import type { Logger } from "../logger";
import type { RequestOutcomeMetric } from "../metrics";
import type { InboundMessage } from "../types";
import { parseWorkflowCommand } from "../workflow/multi-agent-workflow";
import { parseAutoDevCommand } from "../workflow/autodev";

type RouteDecisionLike =
  | { kind: "ignore" }
  | { kind: "execute"; prompt: string }
  | {
      kind: "command";
      command: "status" | "version" | "backend" | "stop" | "reset" | "diag" | "help" | "upgrade";
    };

interface NonBlockingStatusRouteDeps {
  logger: Logger;
  workflowEnabled: boolean;
  hasProcessedEvent: (sessionKey: string, eventId: string) => boolean;
  markEventProcessed: (sessionKey: string, eventId: string) => void;
  recordRequestMetrics: (outcome: RequestOutcomeMetric, queueMs: number, execMs: number, sendMs: number) => void;
  handleControlCommand: (
    command: "status" | "version" | "backend" | "stop" | "reset" | "diag" | "help" | "upgrade",
    sessionKey: string,
    message: InboundMessage,
    requestId: string,
  ) => Promise<void>;
  handleWorkflowStatusCommand: (sessionKey: string, message: InboundMessage) => Promise<void>;
  handleAutoDevStatusCommand: (sessionKey: string, message: InboundMessage, workdir: string) => Promise<void>;
  handleAutoDevProgressCommand: (
    sessionKey: string,
    message: InboundMessage,
    mode: "status" | "on" | "off",
  ) => Promise<void>;
  handleAutoDevSkillsCommand: (
    sessionKey: string,
    message: InboundMessage,
    mode: "status" | "on" | "off" | "summary" | "progressive" | "full",
  ) => Promise<void>;
  handleAutoDevLoopStopCommand: (sessionKey: string, message: InboundMessage) => Promise<void>;
  handleAutoDevReconcileCommand: (sessionKey: string, message: InboundMessage, workdir: string) => Promise<void>;
}

interface NonBlockingStatusRouteInput {
  route: RouteDecisionLike;
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
  workdir: string;
  queueWaitMs: number;
}

export async function tryHandleNonBlockingStatusRoute(
  deps: NonBlockingStatusRouteDeps,
  input: NonBlockingStatusRouteInput,
): Promise<boolean> {
  const { route, sessionKey, message, requestId, workdir, queueWaitMs } = input;
  const isReadOnlyControlCommand =
    route.kind === "command" &&
    (route.command === "status" || route.command === "version" || route.command === "help" || route.command === "diag");
  const workflowCommand = route.kind === "execute" && deps.workflowEnabled ? parseWorkflowCommand(route.prompt) : null;
  const autoDevCommand = route.kind === "execute" && deps.workflowEnabled ? parseAutoDevCommand(route.prompt) : null;
  const isWorkflowStatus = workflowCommand?.kind === "status";
  const isAutoDevStatus = autoDevCommand?.kind === "status";
  const isAutoDevProgress = autoDevCommand?.kind === "progress";
  const isAutoDevSkills = autoDevCommand?.kind === "skills";
  const isAutoDevStop = autoDevCommand?.kind === "stop";
  const isAutoDevReconcile = autoDevCommand?.kind === "reconcile";

  if (
    !isReadOnlyControlCommand &&
    !isWorkflowStatus &&
    !isAutoDevStatus &&
    !isAutoDevProgress &&
    !isAutoDevSkills &&
    !isAutoDevStop &&
    !isAutoDevReconcile
  ) {
    return false;
  }

  if (deps.hasProcessedEvent(sessionKey, message.eventId)) {
    deps.recordRequestMetrics("duplicate", queueWaitMs, 0, 0);
    deps.logger.debug("Duplicate non-blocking status command ignored", {
      requestId,
      eventId: message.eventId,
      sessionKey,
      queueWaitMs,
    });
    return true;
  }

  if (isReadOnlyControlCommand) {
    await deps.handleControlCommand(route.command, sessionKey, message, requestId);
  } else if (isWorkflowStatus) {
    await deps.handleWorkflowStatusCommand(sessionKey, message);
  } else if (isAutoDevProgress) {
    await deps.handleAutoDevProgressCommand(sessionKey, message, autoDevCommand.mode);
  } else if (isAutoDevSkills) {
    await deps.handleAutoDevSkillsCommand(sessionKey, message, autoDevCommand.mode);
  } else if (isAutoDevStop) {
    await deps.handleAutoDevLoopStopCommand(sessionKey, message);
  } else if (isAutoDevReconcile) {
    await deps.handleAutoDevReconcileCommand(sessionKey, message, workdir);
  } else {
    await deps.handleAutoDevStatusCommand(sessionKey, message, workdir);
  }
  deps.markEventProcessed(sessionKey, message.eventId);
  deps.logger.debug("Handled non-blocking status command without waiting for session lock", {
    requestId,
    eventId: message.eventId,
    sessionKey,
    route:
      route.kind === "command"
        ? route.command
        : isWorkflowStatus
          ? "workflow.status"
          : isAutoDevProgress
            ? "autodev.progress"
            : isAutoDevSkills
              ? "autodev.skills"
              : isAutoDevStop
                ? "autodev.stop"
                : isAutoDevReconcile
                  ? "autodev.reconcile"
                : "autodev.status",
    queueWaitMs,
  });
  return true;
}
