import { executeWorkflowRunRequest as runWorkflowRunRequest } from "./workflow-run-request";

type WorkflowRunDispatchContext = Parameters<typeof runWorkflowRunRequest>[0];
type WorkflowRunDispatchInput = Parameters<typeof runWorkflowRunRequest>[1];

export function sendWorkflowRunRequest(
  context: WorkflowRunDispatchContext,
  input: WorkflowRunDispatchInput,
): ReturnType<typeof runWorkflowRunRequest> {
  return runWorkflowRunRequest(context, input);
}
