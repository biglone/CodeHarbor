import type { Logger } from "../logger";
import type { RequestOutcomeMetric } from "../metrics";
import type { InboundMessage } from "../types";
import { parseWorkflowCommand } from "../workflow/multi-agent-workflow";
import { parseAutoDevCommand } from "../workflow/autodev";
import {
  dispatchAutoDevCommandWithRegistry,
  type AutoDevCommandHandlerRegistry,
} from "./autodev-command-handler-registry";

type RouteDecisionLike =
  | { kind: "ignore" }
  | { kind: "execute"; prompt: string }
  | {
      kind: "command";
      command: "status" | "version" | "backend" | "stop" | "reset" | "diag" | "trace" | "help" | "upgrade";
    };

interface NonBlockingStatusRouteDeps {
  logger: Logger;
  workflowEnabled: boolean;
  hasProcessedEvent: (sessionKey: string, eventId: string) => boolean;
  markEventProcessed: (sessionKey: string, eventId: string) => void;
  recordRequestMetrics: (outcome: RequestOutcomeMetric, queueMs: number, execMs: number, sendMs: number) => void;
  handleControlCommand: (
    command: "status" | "version" | "backend" | "stop" | "reset" | "diag" | "trace" | "help" | "upgrade",
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
  handleAutoDevContentCommand: (
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
    (route.command === "status" ||
      route.command === "version" ||
      route.command === "help" ||
      route.command === "diag" ||
      route.command === "trace");
  const workflowCommand = route.kind === "execute" && deps.workflowEnabled ? parseWorkflowCommand(route.prompt) : null;
  const autoDevCommand = route.kind === "execute" && deps.workflowEnabled ? parseAutoDevCommand(route.prompt) : null;
  const isWorkflowStatus = workflowCommand?.kind === "status";

  const autoDevRegistry: AutoDevCommandHandlerRegistry = {
    status: async (_command, context) => {
      await deps.handleAutoDevStatusCommand(context.sessionKey, context.message, context.workdir);
    },
    progress: async (command, context) => {
      await deps.handleAutoDevProgressCommand(context.sessionKey, context.message, command.mode);
    },
    content: async (command, context) => {
      await deps.handleAutoDevContentCommand(context.sessionKey, context.message, command.mode);
    },
    skills: async (command, context) => {
      await deps.handleAutoDevSkillsCommand(context.sessionKey, context.message, command.mode);
    },
    stop: async (_command, context) => {
      await deps.handleAutoDevLoopStopCommand(context.sessionKey, context.message);
    },
    reconcile: async (_command, context) => {
      await deps.handleAutoDevReconcileCommand(context.sessionKey, context.message, context.workdir);
    },
  };
  const hasNonBlockingAutoDevHandler = autoDevCommand ? Boolean(autoDevRegistry[autoDevCommand.kind]) : false;

  if (!isReadOnlyControlCommand && !isWorkflowStatus && !hasNonBlockingAutoDevHandler) {
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

  let handledRoute = "autodev.unknown";
  if (isReadOnlyControlCommand) {
    await deps.handleControlCommand(route.command, sessionKey, message, requestId);
    handledRoute = route.command;
  } else if (isWorkflowStatus) {
    await deps.handleWorkflowStatusCommand(sessionKey, message);
    handledRoute = "workflow.status";
  } else {
    const dispatched = await dispatchAutoDevCommandWithRegistry(autoDevCommand, autoDevRegistry, {
      sessionKey,
      message,
      workdir,
    });
    if (!dispatched.handled) {
      return false;
    }
    handledRoute = dispatched.routeLabel ?? handledRoute;
  }

  deps.markEventProcessed(sessionKey, message.eventId);
  deps.logger.debug("Handled non-blocking status command without waiting for session lock", {
    requestId,
    eventId: message.eventId,
    sessionKey,
    route: handledRoute,
    queueWaitMs,
  });
  return true;
}
