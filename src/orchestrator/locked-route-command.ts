import type { InboundMessage } from "../types";
import { parseWorkflowCommand } from "../workflow/multi-agent-workflow";
import { parseAutoDevCommand } from "../workflow/autodev";
import {
  dispatchAutoDevCommandWithRegistry,
  type AutoDevCommandHandlerRegistry,
} from "./autodev-command-handler-registry";
import { withAutoDevControlEnvelope } from "./autodev-control-response";

type RouteDecisionLike =
  | { kind: "ignore" }
  | { kind: "execute"; prompt: string }
  | {
      kind: "command";
      command: "status" | "version" | "backend" | "stop" | "reset" | "diag" | "trace" | "help" | "upgrade";
    };

export type WorkflowCommandLike = ReturnType<typeof parseWorkflowCommand>;
export type AutoDevCommandLike = ReturnType<typeof parseAutoDevCommand>;

interface HandleLockedRouteCommandDeps {
  workflowEnabled: boolean;
  markEventProcessed: (sessionKey: string, eventId: string) => void;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
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
  handleAutoDevWorkdirCommand: (
    sessionKey: string,
    message: InboundMessage,
    mode: "status" | "set" | "clear",
    path: string | null,
    roomWorkdir: string,
  ) => Promise<void>;
  handleAutoDevInitCommand: (
    sessionKey: string,
    message: InboundMessage,
    path: string | null,
    from: string | null,
    dryRun: boolean,
    force: boolean,
    roomWorkdir: string,
  ) => Promise<void>;
  tryHandleAutoDevSecondaryReviewReceipt: (
    sessionKey: string,
    message: InboundMessage,
    prompt: string,
    workdir: string,
  ) => Promise<boolean>;
}

interface HandleLockedRouteCommandInput {
  route: RouteDecisionLike;
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
  workdir: string;
}

export interface HandleLockedRouteCommandResult {
  handled: boolean;
  workflowCommand: WorkflowCommandLike;
  autoDevCommand: AutoDevCommandLike;
}

export async function handleLockedRouteCommand(
  deps: HandleLockedRouteCommandDeps,
  input: HandleLockedRouteCommandInput,
): Promise<HandleLockedRouteCommandResult> {
  if (input.route.kind === "command") {
    await deps.handleControlCommand(input.route.command, input.sessionKey, input.message, input.requestId);
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand: null, autoDevCommand: null };
  }

  if (input.route.kind === "execute" && deps.workflowEnabled) {
    const secondaryReviewHandled = await deps.tryHandleAutoDevSecondaryReviewReceipt(
      input.sessionKey,
      input.message,
      input.route.prompt,
      input.workdir,
    );
    if (secondaryReviewHandled) {
      deps.markEventProcessed(input.sessionKey, input.message.eventId);
      return { handled: true, workflowCommand: null, autoDevCommand: null };
    }
  }

  const workflowCommand = input.route.kind === "execute" && deps.workflowEnabled ? parseWorkflowCommand(input.route.prompt) : null;
  const autoDevCommand = input.route.kind === "execute" && deps.workflowEnabled ? parseAutoDevCommand(input.route.prompt) : null;

  if (workflowCommand?.kind === "status") {
    await deps.handleWorkflowStatusCommand(input.sessionKey, input.message);
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }

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
    workdir: async (command, context) => {
      await deps.handleAutoDevWorkdirCommand(context.sessionKey, context.message, command.mode, command.path, context.workdir);
    },
    init: async (command, context) => {
      await deps.handleAutoDevInitCommand(
        context.sessionKey,
        context.message,
        command.path,
        command.from,
        command.dryRun,
        command.force,
        context.workdir,
      );
    },
    invalid: async (command, context) => {
      await deps.sendNotice(
        context.message.conversationId,
        buildAutoDevInvalidCommandNotice(command.action, command.option),
      );
    },
  };
  const dispatched = await dispatchAutoDevCommandWithRegistry(autoDevCommand, autoDevRegistry, {
    sessionKey: input.sessionKey,
    message: input.message,
    workdir: input.workdir,
  });
  if (dispatched.handled) {
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }

  return { handled: false, workflowCommand, autoDevCommand };
}

function buildAutoDevInvalidCommandNotice(action: string | null, option: string | null): string {
  const actionLabel = action?.trim() || "(empty)";
  const optionLabel = option?.trim();
  const detail = optionLabel ? `${actionLabel} ${optionLabel}` : actionLabel;
  return withAutoDevControlEnvelope({
    kind: "validation_error",
    code: "AUTODEV_CONTROL_INVALID_SUBCOMMAND",
    text: `[CodeHarbor] 无效的 /autodev 子命令（invalid /autodev subcommand）: ${detail}
- usage: /autodev status | /autodev run [taskId] | /autodev stop | /autodev reconcile
- usage: /autodev workdir [path]|status|clear | /autodev init [path] [--from file] [--dry-run] [--force]
- usage: /autodev progress [on|off|status] | /autodev content [on|off|status] | /autodev skills [on|off|summary|progressive|full|status]`,
    next: "Use /autodev status to inspect runtime state, then retry with a valid subcommand.",
  });
}
