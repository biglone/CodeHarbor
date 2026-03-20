import type { Logger } from "../logger";
import type { InboundMessage } from "../types";

interface RunningExecutionLike {
  requestId: string;
  startedAt: number;
  cancel: () => void;
}

interface StateStoreLike {
  deactivateSession: (sessionKey: string) => void;
  clearCodexSessionId: (sessionKey: string) => void;
}

interface StopCommandDeps {
  logger: Logger;
  pendingAutoDevLoopStopRequests: Set<string>;
  activeAutoDevLoopSessions: Set<string>;
  autoDevDetailedProgressOverrides: Map<string, boolean>;
  stateStore: StateStoreLike;
  clearSessionFromAllRuntimes: (sessionKey: string) => void;
  sessionBackendProfiles: Map<string, unknown>;
  skipBridgeForNextPrompt: Set<string>;
  getTaskQueueStateStore: () => { clearPendingTasks: (sessionKey: string) => { cancelledPending: number } } | null;
  runningExecutions: Map<string, RunningExecutionLike>;
  pendingStopRequests: Set<string>;
  cancelRunningExecutionInAllRuntimes: (sessionKey: string) => void;
  isSessionBusy: (sessionKey: string) => boolean;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

interface StopCommandInput {
  sessionKey: string;
  message: InboundMessage;
  requestId: string;
}

export async function handleStopCommand(deps: StopCommandDeps, input: StopCommandInput): Promise<void> {
  deps.pendingAutoDevLoopStopRequests.delete(input.sessionKey);
  deps.activeAutoDevLoopSessions.delete(input.sessionKey);
  deps.autoDevDetailedProgressOverrides.delete(input.sessionKey);
  deps.stateStore.deactivateSession(input.sessionKey);
  deps.stateStore.clearCodexSessionId(input.sessionKey);
  deps.clearSessionFromAllRuntimes(input.sessionKey);
  deps.sessionBackendProfiles.delete(input.sessionKey);
  deps.skipBridgeForNextPrompt.add(input.sessionKey);

  const queueStore = deps.getTaskQueueStateStore();
  const cancelledPending = queueStore ? queueStore.clearPendingTasks(input.sessionKey).cancelledPending : 0;
  if (cancelledPending > 0) {
    deps.logger.info("Stop command cleared pending queued tasks", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      cancelledPending,
    });
  }

  const running = deps.runningExecutions.get(input.sessionKey);
  if (running) {
    deps.pendingStopRequests.delete(input.sessionKey);
    deps.cancelRunningExecutionInAllRuntimes(input.sessionKey);
    running.cancel();
    await deps.sendNotice(
      input.message.conversationId,
      "[CodeHarbor] 已请求停止当前任务，并已清理会话上下文。",
    );
    deps.logger.info("Stop command cancelled running execution", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      targetRequestId: running.requestId,
      runningForMs: Date.now() - running.startedAt,
    });
    return;
  }

  if (deps.isSessionBusy(input.sessionKey)) {
    deps.pendingStopRequests.add(input.sessionKey);
    deps.pendingAutoDevLoopStopRequests.delete(input.sessionKey);
    await deps.sendNotice(
      input.message.conversationId,
      "[CodeHarbor] 已请求停止当前任务，并已清理会话上下文。",
    );
    deps.logger.info("Stop command queued for pending execution", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
    });
    return;
  }

  deps.pendingStopRequests.delete(input.sessionKey);
  deps.pendingAutoDevLoopStopRequests.delete(input.sessionKey);
  await deps.sendNotice(
    input.message.conversationId,
    "[CodeHarbor] 会话已停止。后续在群聊中请提及/回复我，或在私聊直接发送消息。",
  );
}
