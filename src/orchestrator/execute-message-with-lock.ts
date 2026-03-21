import type { Mutex } from "async-mutex";

import type { InboundMessage } from "../types";
import {
  executeLockedMessage,
  type ExecuteLockedMessageResult,
} from "./locked-message-execution";

interface ExecuteMessageWithLockInput {
  getLock: (sessionKey: string) => Mutex;
  buildLockedMessageDispatchContext: () => Parameters<typeof executeLockedMessage>[0];
  message: InboundMessage;
  requestId: string;
  sessionKey: string;
  receivedAt: number;
  options: {
    bypassQueue: boolean;
    forcedPrompt: string | null;
    deferFailureHandlingToQueue: boolean;
  };
}

export async function executeMessageWithinSessionLock(
  input: ExecuteMessageWithLockInput,
): Promise<ExecuteLockedMessageResult> {
  const lock = input.getLock(input.sessionKey);
  let lockedResult: ExecuteLockedMessageResult = {
    deferAttachmentCleanup: false,
    queueDrainSessionKey: null,
  };
  await lock.runExclusive(async () => {
    lockedResult = await executeLockedMessage(
      input.buildLockedMessageDispatchContext(),
      {
        message: input.message,
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        receivedAt: input.receivedAt,
        bypassQueue: input.options.bypassQueue,
        forcedPrompt: input.options.forcedPrompt,
        deferFailureHandlingToQueue: input.options.deferFailureHandlingToQueue,
      },
    );
  });
  return lockedResult;
}
