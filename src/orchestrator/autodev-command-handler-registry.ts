import type { InboundMessage } from "../types";
import type { AutoDevCommand } from "../workflow/autodev";

export interface AutoDevCommandDispatchContext {
  sessionKey: string;
  message: InboundMessage;
  workdir: string;
}

export type AutoDevCommandHandlerRegistry = {
  [K in AutoDevCommand["kind"]]?: (
    command: Extract<AutoDevCommand, { kind: K }>,
    context: AutoDevCommandDispatchContext,
  ) => Promise<void>;
};

export interface AutoDevCommandDispatchResult {
  handled: boolean;
  routeLabel: string | null;
}

export async function dispatchAutoDevCommandWithRegistry(
  command: AutoDevCommand | null,
  registry: AutoDevCommandHandlerRegistry,
  context: AutoDevCommandDispatchContext,
): Promise<AutoDevCommandDispatchResult> {
  if (!command) {
    return { handled: false, routeLabel: null };
  }

  const handler = registry[command.kind] as
    | ((value: AutoDevCommand, input: AutoDevCommandDispatchContext) => Promise<void>)
    | undefined;
  if (!handler) {
    return { handled: false, routeLabel: null };
  }

  await handler(command, context);
  return {
    handled: true,
    routeLabel: `autodev.${command.kind}`,
  };
}
