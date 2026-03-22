import { sendUpgradeCommand as runSendUpgradeCommand } from "./upgrade-command-dispatch";

type UpgradeCommandDispatchContext = Parameters<typeof runSendUpgradeCommand>[0];

interface UpgradeCommandContextInput {
  logger: UpgradeCommandDispatchContext["logger"];
  outputLanguage: UpgradeCommandDispatchContext["outputLanguage"];
  botNoticePrefix: string;
  upgradeMutex: UpgradeCommandDispatchContext["upgradeMutex"];
  authorizeUpgradeRequest: UpgradeCommandDispatchContext["authorizeUpgradeRequest"];
  acquireUpgradeExecutionLock: UpgradeCommandDispatchContext["acquireUpgradeExecutionLock"];
  releaseUpgradeExecutionLock: UpgradeCommandDispatchContext["releaseUpgradeExecutionLock"];
  createUpgradeRun: UpgradeCommandDispatchContext["createUpgradeRun"];
  finishUpgradeRun: UpgradeCommandDispatchContext["finishUpgradeRun"];
  selfUpdateRunner: UpgradeCommandDispatchContext["selfUpdateRunner"];
  upgradeRestartPlanner: UpgradeCommandDispatchContext["upgradeRestartPlanner"];
  upgradeVersionProbe: UpgradeCommandDispatchContext["upgradeVersionProbe"];
  sendNotice: UpgradeCommandDispatchContext["sendNotice"];
}

export function buildUpgradeCommandDispatchContext(
  input: UpgradeCommandContextInput,
): UpgradeCommandDispatchContext {
  return {
    logger: input.logger,
    outputLanguage: input.outputLanguage,
    botNoticePrefix: input.botNoticePrefix,
    upgradeMutex: input.upgradeMutex,
    authorizeUpgradeRequest: input.authorizeUpgradeRequest,
    acquireUpgradeExecutionLock: input.acquireUpgradeExecutionLock,
    releaseUpgradeExecutionLock: input.releaseUpgradeExecutionLock,
    createUpgradeRun: input.createUpgradeRun,
    finishUpgradeRun: input.finishUpgradeRun,
    selfUpdateRunner: input.selfUpdateRunner,
    upgradeRestartPlanner: input.upgradeRestartPlanner,
    upgradeVersionProbe: input.upgradeVersionProbe,
    sendNotice: input.sendNotice,
  };
}
