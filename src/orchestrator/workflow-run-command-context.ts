import { sendWorkflowRunRequest as runSendWorkflowRunRequest } from "./workflow-run-dispatch";

type WorkflowRunDispatchContext = Parameters<typeof runSendWorkflowRunRequest>[0];

interface WorkflowRunCommandContextInput {
  setWorkflowSnapshot: WorkflowRunDispatchContext["setWorkflowSnapshot"];
  beginWorkflowDiagRun: WorkflowRunDispatchContext["beginWorkflowDiagRun"];
  startTypingHeartbeat: WorkflowRunDispatchContext["startTypingHeartbeat"];
  consumePendingStopRequest: WorkflowRunDispatchContext["consumePendingStopRequest"];
  runningExecutions: WorkflowRunDispatchContext["runningExecutions"];
  persistRuntimeMetricsSnapshot: WorkflowRunDispatchContext["persistRuntimeMetricsSnapshot"];
  sendProgressUpdate: WorkflowRunDispatchContext["sendProgressUpdate"];
  appendWorkflowDiagEvent: WorkflowRunDispatchContext["appendWorkflowDiagEvent"];
  isAutoDevDetailedProgressEnabled: WorkflowRunDispatchContext["isAutoDevDetailedProgressEnabled"];
  resolveWorkflowRoleSkillPolicy: WorkflowRunDispatchContext["resolveWorkflowRoleSkillPolicy"];
  runWorkflow: WorkflowRunDispatchContext["runWorkflow"];
  sendMessage: WorkflowRunDispatchContext["sendMessage"];
  finishProgress: WorkflowRunDispatchContext["finishProgress"];
  finishWorkflowDiagRun: WorkflowRunDispatchContext["finishWorkflowDiagRun"];
  sendNotice: WorkflowRunDispatchContext["sendNotice"];
}

export function buildWorkflowRunCommandDispatchContext(
  input: WorkflowRunCommandContextInput,
): WorkflowRunDispatchContext {
  return {
    setWorkflowSnapshot: input.setWorkflowSnapshot,
    beginWorkflowDiagRun: input.beginWorkflowDiagRun,
    startTypingHeartbeat: input.startTypingHeartbeat,
    consumePendingStopRequest: input.consumePendingStopRequest,
    runningExecutions: input.runningExecutions,
    persistRuntimeMetricsSnapshot: input.persistRuntimeMetricsSnapshot,
    sendProgressUpdate: input.sendProgressUpdate,
    appendWorkflowDiagEvent: input.appendWorkflowDiagEvent,
    isAutoDevDetailedProgressEnabled: input.isAutoDevDetailedProgressEnabled,
    resolveWorkflowRoleSkillPolicy: input.resolveWorkflowRoleSkillPolicy,
    runWorkflow: input.runWorkflow,
    sendMessage: input.sendMessage,
    finishProgress: input.finishProgress,
    finishWorkflowDiagRun: input.finishWorkflowDiagRun,
    sendNotice: input.sendNotice,
  };
}
