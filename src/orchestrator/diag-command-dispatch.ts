import type { InboundMessage } from "../types";
import { handleDiagCommand as runDiagCommand } from "./diag-command";

type DiagCommandDispatchContext = Parameters<typeof runDiagCommand>[0];

export async function sendDiagCommand(context: DiagCommandDispatchContext, message: InboundMessage): Promise<void> {
  await runDiagCommand(context, message);
}
