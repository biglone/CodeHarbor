import { executeAgentRunRequest } from "./agent-run-request";
import { executeChatRequest } from "./chat-request";
import { executeLockedMessage } from "./locked-message-execution";

type LockedMessageDispatchContext = Parameters<typeof executeLockedMessage>[0];
type LockedWorkflowRunInput = Parameters<LockedMessageDispatchContext["executeWorkflowRun"]>[0];
type LockedAutoDevRunInput = Parameters<LockedMessageDispatchContext["executeAutoDevRun"]>[0];
type LockedChatRunInput = Parameters<LockedMessageDispatchContext["executeChatRun"]>[0];

interface LockedWorkflowRunExecutorDeps {
  buildAgentRunRequestContext: () => Parameters<typeof executeAgentRunRequest>[0];
  handleWorkflowRunCommand: (
    objective: string,
    sessionKey: string,
    message: LockedWorkflowRunInput["message"],
    requestId: string,
    workdir: string,
  ) => Promise<unknown>;
  sendWorkflowFailure: (conversationId: string, error: unknown) => Promise<number>;
}

interface LockedAutoDevRunExecutorDeps {
  buildAgentRunRequestContext: () => Parameters<typeof executeAgentRunRequest>[0];
  handleAutoDevRunCommand: (
    taskId: string | null,
    sessionKey: string,
    message: LockedAutoDevRunInput["message"],
    requestId: string,
    workdir: string,
  ) => Promise<void>;
  sendAutoDevFailure: (conversationId: string, error: unknown) => Promise<number>;
}

interface LockedChatRunExecutorDeps {
  buildChatRequestDispatchContext: () => Parameters<typeof executeChatRequest>[0];
}

export async function executeLockedWorkflowRun(
  deps: LockedWorkflowRunExecutorDeps,
  input: LockedWorkflowRunInput,
): Promise<void> {
  await executeAgentRunRequest(deps.buildAgentRunRequestContext(), {
    kind: "workflow",
    sessionKey: input.sessionKey,
    message: input.message,
    requestId: input.requestId,
    queueWaitMs: input.queueWaitMs,
    workdir: input.workdir,
    deferFailureHandlingToQueue: input.deferFailureHandlingToQueue,
    executor: input.executor,
    run: async () => {
      await deps.handleWorkflowRunCommand(
        input.objective,
        input.sessionKey,
        input.message,
        input.requestId,
        input.workdir,
      );
    },
    sendFailure: (conversationId, error) => deps.sendWorkflowFailure(conversationId, error),
    releaseRateLimit: () => {
      input.releaseRateLimit();
    },
  });
}

export async function executeLockedAutoDevRun(
  deps: LockedAutoDevRunExecutorDeps,
  input: LockedAutoDevRunInput,
): Promise<void> {
  await executeAgentRunRequest(deps.buildAgentRunRequestContext(), {
    kind: "autodev",
    sessionKey: input.sessionKey,
    message: input.message,
    requestId: input.requestId,
    queueWaitMs: input.queueWaitMs,
    workdir: input.workdir,
    deferFailureHandlingToQueue: input.deferFailureHandlingToQueue,
    executor: input.executor,
    run: async () => {
      await deps.handleAutoDevRunCommand(
        input.taskId,
        input.sessionKey,
        input.message,
        input.requestId,
        input.workdir,
      );
    },
    sendFailure: (conversationId, error) => deps.sendAutoDevFailure(conversationId, error),
    releaseRateLimit: () => {
      input.releaseRateLimit();
    },
  });
}

export function executeLockedChatRun(deps: LockedChatRunExecutorDeps, input: LockedChatRunInput): Promise<void> {
  return executeChatRequest(deps.buildChatRequestDispatchContext(), {
    message: input.message,
    receivedAt: input.receivedAt,
    queueWaitMs: input.queueWaitMs,
    routePrompt: input.routePrompt,
    sessionKey: input.sessionKey,
    requestId: input.requestId,
    roomWorkdir: input.roomWorkdir,
    roomConfigSource: input.roomConfigSource,
    backendProfile: input.backendProfile,
    backendRouteSource: input.backendRouteSource,
    backendRouteReason: input.backendRouteReason,
    backendRouteRuleId: input.backendRouteRuleId,
    sessionRuntime: input.sessionRuntime,
    deferFailureHandlingToQueue: input.deferFailureHandlingToQueue,
    releaseRateLimit: () => {
      input.releaseRateLimit();
    },
  });
}
