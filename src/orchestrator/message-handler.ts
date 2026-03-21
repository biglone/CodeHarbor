import type { InboundMessage } from "../types";
import { collectLocalAttachmentPaths } from "./media-progress";
import { cleanupAttachmentFiles } from "./misc-utils";
import type { ExecuteLockedMessageResult } from "./locked-message-execution";

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
