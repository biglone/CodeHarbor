import { handleStopCommand as runStopCommand } from "./stop-command";

type StopCommandDispatchContext = Parameters<typeof runStopCommand>[0];
type StopCommandDispatchInput = Parameters<typeof runStopCommand>[1];

export async function sendStopCommand(
  context: StopCommandDispatchContext,
  input: StopCommandDispatchInput,
): Promise<void> {
  await runStopCommand(context, input);
}
