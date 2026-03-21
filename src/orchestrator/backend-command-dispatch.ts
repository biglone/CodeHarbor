import { handleBackendCommand as runBackendCommand } from "./backend-command";

type BackendCommandDispatchContext = Parameters<typeof runBackendCommand>[0];
type BackendCommandDispatchInput = Parameters<typeof runBackendCommand>[1];

export async function sendBackendCommand(
  context: BackendCommandDispatchContext,
  input: BackendCommandDispatchInput,
): Promise<void> {
  await runBackendCommand(context, input);
}
