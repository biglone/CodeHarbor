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

export type WorkflowCommandLike = ReturnType<typeof parseWorkflowCommand>;
export type AutoDevCommandLike = ReturnType<typeof parseAutoDevCommand>;

interface HandleLockedRouteCommandDeps {
  workflowEnabled: boolean;
  markEventProcessed: (sessionKey: string, eventId: string) => void;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
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

  const workflowCommand = input.route.kind === "execute" && deps.workflowEnabled ? parseWorkflowCommand(input.route.prompt) : null;
  const autoDevCommand = input.route.kind === "execute" && deps.workflowEnabled ? parseAutoDevCommand(input.route.prompt) : null;
  if (workflowCommand?.kind === "status") {
    await deps.handleWorkflowStatusCommand(input.sessionKey, input.message);
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }
  if (autoDevCommand?.kind === "status") {
    await deps.handleAutoDevStatusCommand(input.sessionKey, input.message, input.workdir);
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }
  if (autoDevCommand?.kind === "progress") {
    await deps.handleAutoDevProgressCommand(input.sessionKey, input.message, autoDevCommand.mode);
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }
  if (autoDevCommand?.kind === "content") {
    await deps.handleAutoDevContentCommand(input.sessionKey, input.message, autoDevCommand.mode);
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }
  if (autoDevCommand?.kind === "skills") {
    await deps.handleAutoDevSkillsCommand(input.sessionKey, input.message, autoDevCommand.mode);
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }
  if (autoDevCommand?.kind === "stop") {
    await deps.handleAutoDevLoopStopCommand(input.sessionKey, input.message);
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }
  if (autoDevCommand?.kind === "reconcile") {
    await deps.handleAutoDevReconcileCommand(input.sessionKey, input.message, input.workdir);
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }
  if (autoDevCommand?.kind === "workdir") {
    await deps.handleAutoDevWorkdirCommand(
      input.sessionKey,
      input.message,
      autoDevCommand.mode,
      autoDevCommand.path,
      input.workdir,
    );
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }
  if (autoDevCommand?.kind === "init") {
    await deps.handleAutoDevInitCommand(
      input.sessionKey,
      input.message,
      autoDevCommand.path,
      autoDevCommand.from,
      autoDevCommand.dryRun,
      autoDevCommand.force,
      input.workdir,
    );
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }
  if (autoDevCommand?.kind === "invalid") {
    await deps.sendNotice(
      input.message.conversationId,
      buildAutoDevInvalidCommandNotice(autoDevCommand.action, autoDevCommand.option),
    );
    deps.markEventProcessed(input.sessionKey, input.message.eventId);
    return { handled: true, workflowCommand, autoDevCommand };
  }
  return { handled: false, workflowCommand, autoDevCommand };
}

function buildAutoDevInvalidCommandNotice(action: string | null, option: string | null): string {
  const actionLabel = action?.trim() || "(empty)";
  const optionLabel = option?.trim();
  const detail = optionLabel ? `${actionLabel} ${optionLabel}` : actionLabel;
  return `[CodeHarbor] 无效的 /autodev 子命令（invalid /autodev subcommand）: ${detail}
- usage: /autodev status | /autodev run [taskId] | /autodev stop | /autodev reconcile
- usage: /autodev workdir [path]|status|clear | /autodev init [path] [--from file] [--dry-run] [--force]
- usage: /autodev progress [on|off|status] | /autodev content [on|off|status] | /autodev skills [on|off|summary|progressive|full|status]`;
}
