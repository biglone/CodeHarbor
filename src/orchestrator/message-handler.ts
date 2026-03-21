import type { InboundMessage } from "../types";
import { collectLocalAttachmentPaths } from "./media-progress";
import { cleanupAttachmentFiles } from "./misc-utils";
import type { ExecuteLockedMessageResult } from "./locked-message-execution";
import { executeMessageWithinSessionLock as runExecuteMessageWithinSessionLock } from "./execute-message-with-lock";

interface HandleMessageInternalInput {
  message: InboundMessage;
  receivedAt: number;
  options: {
    bypassQueue: boolean;
    forcedPrompt: string | null;
    deferFailureHandlingToQueue: boolean;
  };
}

interface HandleMessageInternalDeps {
  syncRuntimeHotConfig: () => void;
  buildSessionKey: (message: InboundMessage) => string;
  markSessionRequestStarted: (sessionKey: string) => void;
  markSessionRequestFinished: (sessionKey: string) => void;
  tryHandleDirectStopCommand: (input: {
    message: InboundMessage;
    requestId: string;
    sessionKey: string;
  }) => Promise<boolean>;
  tryHandleUnlockedStatusCommand: (input: {
    message: InboundMessage;
    requestId: string;
    sessionKey: string;
    receivedAt: number;
    options: {
      bypassQueue: boolean;
      forcedPrompt: string | null;
    };
  }) => Promise<boolean>;
  executeMessageWithinSessionLock: (input: {
    message: InboundMessage;
    requestId: string;
    sessionKey: string;
    receivedAt: number;
    options: {
      bypassQueue: boolean;
      forcedPrompt: string | null;
      deferFailureHandlingToQueue: boolean;
    };
  }) => Promise<ExecuteLockedMessageResult>;
  startSessionQueueDrain: (sessionKey: string) => void;
}

interface HandleMessageInternalRuntimeDepsInput extends Omit<HandleMessageInternalDeps, "executeMessageWithinSessionLock"> {
  getLock: Parameters<typeof runExecuteMessageWithinSessionLock>[0]["getLock"];
  buildLockedMessageDispatchContext: Parameters<
    typeof runExecuteMessageWithinSessionLock
  >[0]["buildLockedMessageDispatchContext"];
}

export function buildHandleMessageInternalDepsFromRuntime(
  input: HandleMessageInternalRuntimeDepsInput,
): HandleMessageInternalDeps {
  return {
    syncRuntimeHotConfig: input.syncRuntimeHotConfig,
    buildSessionKey: input.buildSessionKey,
    markSessionRequestStarted: input.markSessionRequestStarted,
    markSessionRequestFinished: input.markSessionRequestFinished,
    tryHandleDirectStopCommand: input.tryHandleDirectStopCommand,
    tryHandleUnlockedStatusCommand: input.tryHandleUnlockedStatusCommand,
    executeMessageWithinSessionLock: (executionInput) =>
      runExecuteMessageWithinSessionLock({
        getLock: input.getLock,
        buildLockedMessageDispatchContext: input.buildLockedMessageDispatchContext,
        message: executionInput.message,
        requestId: executionInput.requestId,
        sessionKey: executionInput.sessionKey,
        receivedAt: executionInput.receivedAt,
        options: executionInput.options,
      }),
    startSessionQueueDrain: input.startSessionQueueDrain,
  };
}

export async function handleMessageInternal(
  deps: HandleMessageInternalDeps,
  input: HandleMessageInternalInput,
): Promise<void> {
  const attachmentPaths = collectLocalAttachmentPaths(input.message);
  let deferAttachmentCleanup = false;
  let queueDrainSessionKey: string | null = null;
  let sessionKeyForLifecycle: string | null = null;

  try {
    const requestId = input.message.requestId || input.message.eventId;
    deps.syncRuntimeHotConfig();
    const sessionKey = deps.buildSessionKey(input.message);
    sessionKeyForLifecycle = sessionKey;
    deps.markSessionRequestStarted(sessionKey);

    if (
      await deps.tryHandleDirectStopCommand({
        message: input.message,
        requestId,
        sessionKey,
      })
    ) {
      return;
    }

    if (
      await deps.tryHandleUnlockedStatusCommand({
        message: input.message,
        requestId,
        sessionKey,
        receivedAt: input.receivedAt,
        options: {
          bypassQueue: input.options.bypassQueue,
          forcedPrompt: input.options.forcedPrompt,
        },
      })
    ) {
      return;
    }

    const lockedResult = await deps.executeMessageWithinSessionLock({
      message: input.message,
      requestId,
      sessionKey,
      receivedAt: input.receivedAt,
      options: input.options,
    });
    deferAttachmentCleanup = lockedResult.deferAttachmentCleanup;
    queueDrainSessionKey = lockedResult.queueDrainSessionKey;
  } finally {
    if (sessionKeyForLifecycle) {
      deps.markSessionRequestFinished(sessionKeyForLifecycle);
    }
    if (!deferAttachmentCleanup) {
      await cleanupAttachmentFiles(attachmentPaths);
    }
  }

  if (queueDrainSessionKey) {
    deps.startSessionQueueDrain(queueDrainSessionKey);
  }
}
