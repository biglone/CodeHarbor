import { formatPackageUpdateHint, type PackageUpdateStatus } from "../package-update-checker";
import type { InboundMessage } from "../types";
import type { OutputLanguage } from "../config";
import { buildHelpNotice } from "./control-text";
import { byOutputLanguage } from "./output-language";

export type ControlCommand = "status" | "version" | "backend" | "stop" | "reset" | "diag" | "help" | "upgrade";

interface MinimalStateStoreLike {
  clearCodexSessionId: (sessionKey: string) => void;
  activateSession: (sessionKey: string, activeWindowMs: number) => void;
}

interface HandleControlCommandDeps {
  sessionActiveWindowMs: number;
  botNoticePrefix: string;
  outputLanguage: OutputLanguage;
  stateStore: MinimalStateStoreLike;
  clearSessionFromAllRuntimes: (sessionKey: string) => void;
  sessionBackendOverrides: Map<string, unknown>;
  sessionBackendProfiles: Map<string, unknown>;
  sessionLastBackendDecisions: Map<string, unknown>;
  skipBridgeForNextPrompt: Set<string>;
  workflowSnapshots: Map<string, unknown>;
  autoDevSnapshots: Map<string, unknown>;
  autoDevWorkdirOverrides: Map<string, string>;
  autoDevDetailedProgressOverrides: Map<string, boolean>;
  workflowRoleSkillPolicyOverrides: Map<string, unknown>;
  pendingStopRequests: Set<string>;
  pendingAutoDevLoopStopRequests: Set<string>;
  activeAutoDevLoopSessions: Set<string>;
  getPackageUpdateStatus: (query?: { forceRefresh?: boolean }) => Promise<PackageUpdateStatus>;
  formatMultimodalHelpStatus: () => string;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
  handleStatusCommand: (sessionKey: string, message: InboundMessage) => Promise<void>;
  handleStopCommand: (sessionKey: string, message: InboundMessage, requestId: string) => Promise<void>;
  handleBackendCommand: (sessionKey: string, message: InboundMessage) => Promise<void>;
  handleDiagCommand: (message: InboundMessage) => Promise<void>;
  handleUpgradeCommand: (message: InboundMessage) => Promise<void>;
}

interface HandleControlCommandInput {
  command: ControlCommand;
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
}

export async function handleControlCommand(
  deps: HandleControlCommandDeps,
  input: HandleControlCommandInput,
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  if (input.command === "stop") {
    await deps.handleStopCommand(input.sessionKey, input.message, input.requestId);
    return;
  }

  if (input.command === "reset") {
    deps.stateStore.clearCodexSessionId(input.sessionKey);
    deps.stateStore.activateSession(input.sessionKey, deps.sessionActiveWindowMs);
    deps.clearSessionFromAllRuntimes(input.sessionKey);
    deps.sessionBackendOverrides.delete(input.sessionKey);
    deps.sessionBackendProfiles.delete(input.sessionKey);
    deps.sessionLastBackendDecisions.delete(input.sessionKey);
    deps.skipBridgeForNextPrompt.add(input.sessionKey);
    deps.workflowSnapshots.delete(input.sessionKey);
    deps.autoDevSnapshots.delete(input.sessionKey);
    deps.autoDevWorkdirOverrides.delete(input.sessionKey);
    deps.autoDevDetailedProgressOverrides.delete(input.sessionKey);
    deps.workflowRoleSkillPolicyOverrides.delete(input.sessionKey);
    deps.pendingStopRequests.delete(input.sessionKey);
    deps.pendingAutoDevLoopStopRequests.delete(input.sessionKey);
    deps.activeAutoDevLoopSessions.delete(input.sessionKey);
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        "[CodeHarbor] 上下文已重置。你可以继续直接发送新需求。",
        "[CodeHarbor] Context has been reset. You can send a new request now.",
      ),
    );
    return;
  }

  if (input.command === "version") {
    const packageUpdate = await deps.getPackageUpdateStatus({ forceRefresh: true });
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        `${deps.botNoticePrefix} 版本信息\n- 当前版本: ${packageUpdate.currentVersion}\n- 更新检查: ${formatPackageUpdateHint(packageUpdate, deps.outputLanguage)}\n- 检查时间: ${packageUpdate.checkedAt}`,
        `${deps.botNoticePrefix} Version\n- currentVersion: ${packageUpdate.currentVersion}\n- updateHint: ${formatPackageUpdateHint(packageUpdate, deps.outputLanguage)}\n- checkedAt: ${packageUpdate.checkedAt}`,
      ),
    );
    return;
  }

  if (input.command === "backend") {
    await deps.handleBackendCommand(input.sessionKey, input.message);
    return;
  }

  if (input.command === "diag") {
    await deps.handleDiagCommand(input.message);
    return;
  }

  if (input.command === "help") {
    await deps.sendNotice(
      input.message.conversationId,
      buildHelpNotice({
        botNoticePrefix: deps.botNoticePrefix,
        outputLanguage: deps.outputLanguage,
        multimodalHelpStatus: deps.formatMultimodalHelpStatus(),
      }),
    );
    return;
  }

  if (input.command === "upgrade") {
    await deps.handleUpgradeCommand(input.message);
    return;
  }

  await deps.handleStatusCommand(input.sessionKey, input.message);
}
