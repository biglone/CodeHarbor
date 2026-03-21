import { handleControlCommand as runControlCommand } from "./control-command-handler";

type ControlCommandDispatchContext = Parameters<typeof runControlCommand>[0];
type ControlCommandDispatchInput = Parameters<typeof runControlCommand>[1];

export async function sendControlCommand(
  context: ControlCommandDispatchContext,
  input: ControlCommandDispatchInput,
): Promise<void> {
  await runControlCommand(context, input);
}
