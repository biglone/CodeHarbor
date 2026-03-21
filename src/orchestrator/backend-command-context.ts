import { sendBackendCommand as runSendBackendCommand } from "./backend-command-dispatch";

type BackendCommandDispatchContext = Parameters<typeof runSendBackendCommand>[0];

interface BackendCommandContextInput {
  sessionActiveWindowMs: number;
  canCreateBackendRuntime: boolean;
  sessionBackendOverrides: BackendCommandDispatchContext["sessionBackendOverrides"];
  sessionBackendProfiles: BackendCommandDispatchContext["sessionBackendProfiles"];
  sessionLastBackendDecisions: BackendCommandDispatchContext["sessionLastBackendDecisions"];
  workflowSnapshots: BackendCommandDispatchContext["workflowSnapshots"];
  autoDevSnapshots: BackendCommandDispatchContext["autoDevSnapshots"];
  runningExecutions: BackendCommandDispatchContext["runningExecutions"];
  stateStore: BackendCommandDispatchContext["stateStore"];
  resolveSessionBackendStatusProfile: BackendCommandDispatchContext["resolveSessionBackendStatusProfile"];
  formatBackendToolLabel: BackendCommandDispatchContext["formatBackendToolLabel"];
  resolveManualBackendProfile: BackendCommandDispatchContext["resolveManualBackendProfile"];
  serializeBackendProfile: BackendCommandDispatchContext["serializeBackendProfile"];
  hasBackendRuntime: BackendCommandDispatchContext["hasBackendRuntime"];
  ensureBackendRuntime: BackendCommandDispatchContext["ensureBackendRuntime"];
  clearSessionFromAllRuntimes: BackendCommandDispatchContext["clearSessionFromAllRuntimes"];
  sendNotice: BackendCommandDispatchContext["sendNotice"];
}

export function buildBackendCommandDispatchContext(
  input: BackendCommandContextInput,
): BackendCommandDispatchContext {
  return {
    sessionActiveWindowMs: input.sessionActiveWindowMs,
    canCreateBackendRuntime: input.canCreateBackendRuntime,
    sessionBackendOverrides: input.sessionBackendOverrides,
    sessionBackendProfiles: input.sessionBackendProfiles,
    sessionLastBackendDecisions: input.sessionLastBackendDecisions,
    workflowSnapshots: input.workflowSnapshots,
    autoDevSnapshots: input.autoDevSnapshots,
    runningExecutions: input.runningExecutions,
    stateStore: input.stateStore,
    resolveSessionBackendStatusProfile: input.resolveSessionBackendStatusProfile,
    formatBackendToolLabel: input.formatBackendToolLabel,
    resolveManualBackendProfile: input.resolveManualBackendProfile,
    serializeBackendProfile: input.serializeBackendProfile,
    hasBackendRuntime: input.hasBackendRuntime,
    ensureBackendRuntime: input.ensureBackendRuntime,
    clearSessionFromAllRuntimes: input.clearSessionFromAllRuntimes,
    sendNotice: input.sendNotice,
  };
}
