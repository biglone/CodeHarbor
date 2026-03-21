import { handleUpgradeCommand as runUpgradeCommand } from "./upgrade-command";

type UpgradeCommandDispatchContext = Parameters<typeof runUpgradeCommand>[0];

export async function sendUpgradeCommand(
  context: UpgradeCommandDispatchContext,
  message: Parameters<typeof runUpgradeCommand>[1],
): Promise<void> {
  await runUpgradeCommand(context, message);
}
