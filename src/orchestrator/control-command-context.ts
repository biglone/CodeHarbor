import { sendControlCommand as runSendControlCommand } from "./control-command-dispatch";

type ControlCommandDispatchContext = Parameters<typeof runSendControlCommand>[0];

interface ControlCommandContextInput {
  sessionActiveWindowMs: number;
  botNoticePrefix: string;
  stateStore: ControlCommandDispatchContext["stateStore"];
  clearSessionFromAllRuntimes: ControlCommandDispatchContext["clearSessionFromAllRuntimes"];
  sessionBackendOverrides: ControlCommandDispatchContext["sessionBackendOverrides"];
  sessionBackendProfiles: ControlCommandDispatchContext["sessionBackendProfiles"];
  sessionLastBackendDecisions: ControlCommandDispatchContext["sessionLastBackendDecisions"];
  skipBridgeForNextPrompt: ControlCommandDispatchContext["skipBridgeForNextPrompt"];
  workflowSnapshots: ControlCommandDispatchContext["workflowSnapshots"];
  autoDevSnapshots: ControlCommandDispatchContext["autoDevSnapshots"];
  autoDevDetailedProgressOverrides: ControlCommandDispatchContext["autoDevDetailedProgressOverrides"];
  workflowRoleSkillPolicyOverrides: ControlCommandDispatchContext["workflowRoleSkillPolicyOverrides"];
  pendingStopRequests: ControlCommandDispatchContext["pendingStopRequests"];
  pendingAutoDevLoopStopRequests: ControlCommandDispatchContext["pendingAutoDevLoopStopRequests"];
  activeAutoDevLoopSessions: ControlCommandDispatchContext["activeAutoDevLoopSessions"];
  getPackageUpdateStatus: ControlCommandDispatchContext["getPackageUpdateStatus"];
  formatMultimodalHelpStatus: ControlCommandDispatchContext["formatMultimodalHelpStatus"];
  sendNotice: ControlCommandDispatchContext["sendNotice"];
  handleStatusCommand: ControlCommandDispatchContext["handleStatusCommand"];
  handleStopCommand: ControlCommandDispatchContext["handleStopCommand"];
  handleBackendCommand: ControlCommandDispatchContext["handleBackendCommand"];
  handleDiagCommand: ControlCommandDispatchContext["handleDiagCommand"];
  handleUpgradeCommand: ControlCommandDispatchContext["handleUpgradeCommand"];
}

export function buildControlCommandDispatchContext(
  input: ControlCommandContextInput,
): ControlCommandDispatchContext {
  return {
    sessionActiveWindowMs: input.sessionActiveWindowMs,
    botNoticePrefix: input.botNoticePrefix,
    stateStore: input.stateStore,
    clearSessionFromAllRuntimes: input.clearSessionFromAllRuntimes,
    sessionBackendOverrides: input.sessionBackendOverrides,
    sessionBackendProfiles: input.sessionBackendProfiles,
    sessionLastBackendDecisions: input.sessionLastBackendDecisions,
    skipBridgeForNextPrompt: input.skipBridgeForNextPrompt,
    workflowSnapshots: input.workflowSnapshots,
    autoDevSnapshots: input.autoDevSnapshots,
    autoDevDetailedProgressOverrides: input.autoDevDetailedProgressOverrides,
    workflowRoleSkillPolicyOverrides: input.workflowRoleSkillPolicyOverrides,
    pendingStopRequests: input.pendingStopRequests,
    pendingAutoDevLoopStopRequests: input.pendingAutoDevLoopStopRequests,
    activeAutoDevLoopSessions: input.activeAutoDevLoopSessions,
    getPackageUpdateStatus: input.getPackageUpdateStatus,
    formatMultimodalHelpStatus: input.formatMultimodalHelpStatus,
    sendNotice: input.sendNotice,
    handleStatusCommand: input.handleStatusCommand,
    handleStopCommand: input.handleStopCommand,
    handleBackendCommand: input.handleBackendCommand,
    handleDiagCommand: input.handleDiagCommand,
    handleUpgradeCommand: input.handleUpgradeCommand,
  };
}
