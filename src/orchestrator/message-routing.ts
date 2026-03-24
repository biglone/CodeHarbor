import type { TriggerPolicy } from "../config";
import type { InboundMessage } from "../types";
import { extractCommandText } from "../utils/message";
import { parseAutoDevCommand } from "../workflow/autodev";
import { parseControlCommand, type ControlCommand } from "./command-routing";
import { stripLeadingBotMention } from "./misc-utils";

export type RouteDecision =
  | { kind: "ignore" }
  | { kind: "execute"; prompt: string }
  | {
      kind: "command";
      command: ControlCommand;
    };

interface RoomRuntimeConfigLike {
  enabled: boolean;
  triggerPolicy: TriggerPolicy;
}

interface RouteMessageDeps {
  workflowEnabled: boolean;
  commandPrefix: string;
  cliCompatEnabled: boolean;
  cliPreserveWhitespace: boolean;
  groupDirectModeEnabled: boolean;
  matrixUserId: string;
  isSessionActive: (sessionKey: string) => boolean;
}

interface RouteMessageInput {
  message: InboundMessage;
  sessionKey: string;
  roomConfig: RoomRuntimeConfigLike;
}

export function routeMessage(
  deps: RouteMessageDeps,
  input: RouteMessageInput,
): RouteDecision {
  const incomingRaw = input.message.text;
  const incomingTrimmed = incomingRaw.trim();
  if (!incomingTrimmed && input.message.attachments.length === 0) {
    return { kind: "ignore" };
  }

  const rawAutoDevCommand = deps.workflowEnabled ? parseAutoDevCommand(incomingTrimmed) : null;
  if (
    rawAutoDevCommand?.kind === "status" ||
    rawAutoDevCommand?.kind === "stop" ||
    rawAutoDevCommand?.kind === "workdir" ||
    rawAutoDevCommand?.kind === "init" ||
    rawAutoDevCommand?.kind === "progress" ||
    rawAutoDevCommand?.kind === "skills"
  ) {
    return {
      kind: "execute",
      prompt: incomingTrimmed,
    };
  }

  if (!input.message.isDirectMessage && !input.roomConfig.enabled) {
    return { kind: "ignore" };
  }

  const groupPolicy = input.message.isDirectMessage ? null : input.roomConfig.triggerPolicy;
  const prefixAllowed = input.message.isDirectMessage || Boolean(groupPolicy?.allowPrefix);
  const prefixTriggered = prefixAllowed && deps.commandPrefix.length > 0;
  const prefixedText = prefixTriggered ? extractCommandText(incomingTrimmed, deps.commandPrefix) : null;

  const activeSession =
    input.message.isDirectMessage || groupPolicy?.allowActiveWindow
      ? deps.isSessionActive(input.sessionKey)
      : false;

  const conversationalTrigger =
    input.message.isDirectMessage ||
    deps.groupDirectModeEnabled ||
    (Boolean(groupPolicy?.allowMention) && input.message.mentionsBot) ||
    (Boolean(groupPolicy?.allowReply) && input.message.repliesToBot) ||
    activeSession;

  if (!conversationalTrigger && prefixedText === null) {
    return { kind: "ignore" };
  }

  let normalized = prefixedText ?? (deps.cliPreserveWhitespace ? incomingRaw : incomingTrimmed);
  if (prefixedText === null && input.message.mentionsBot && !deps.cliCompatEnabled) {
    normalized = stripLeadingBotMention(normalized, deps.matrixUserId);
  }
  const normalizedTrimmed = normalized.trim();
  if (!normalizedTrimmed && input.message.attachments.length === 0) {
    return { kind: "ignore" };
  }

  const command = parseControlCommand(normalizedTrimmed);
  if (command) {
    return { kind: "command", command };
  }

  if (!deps.cliPreserveWhitespace || prefixedText !== null) {
    normalized = normalizedTrimmed;
  }

  return { kind: "execute", prompt: normalized };
}
