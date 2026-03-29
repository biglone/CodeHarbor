import type { Channel } from "../channels/channel";
import type { CodexProgressEvent } from "../executor/codex-executor";
import type { Logger } from "../logger";
import { formatPackageUpdateHint, type PackageUpdateChecker } from "../package-update-checker";
import type { OutputLanguage } from "../config";
import { mapProgressText } from "./media-progress";

export interface SendProgressContext {
  conversationId: string;
  isDirectMessage: boolean;
  forceTimeline?: boolean;
  getProgressNoticeEventId: () => string | null;
  setProgressNoticeEventId: (next: string) => void;
}

export interface ProgressDispatchContext {
  outputLanguage: OutputLanguage;
  progressUpdatesEnabled: boolean;
  progressMinIntervalMs: number;
  progressDeliveryMode: "upsert" | "timeline";
  typingTimeoutMs: number;
  cliCompatEnabled: boolean;
  botNoticePrefix: string;
  packageUpdateChecker: PackageUpdateChecker;
  channel: Channel;
  logger: Logger;
}

interface HandleProgressInput {
  conversationId: string;
  isDirectMessage: boolean;
  progress: CodexProgressEvent;
  getLastProgressAt: () => number;
  setLastProgressAt: (next: number) => void;
  getLastProgressText: () => string;
  setLastProgressText: (next: string) => void;
  getProgressNoticeEventId: () => string | null;
  setProgressNoticeEventId: (next: string) => void;
}

export function startTypingHeartbeat(context: ProgressDispatchContext, conversationId: string): () => Promise<void> {
  let stopped = false;
  const refreshIntervalMs = Math.max(1_000, Math.floor(context.typingTimeoutMs / 2));

  const sendTyping = async (isTyping: boolean): Promise<void> => {
    try {
      await context.channel.setTyping(conversationId, isTyping, isTyping ? context.typingTimeoutMs : 0);
    } catch (error) {
      context.logger.debug("Failed to update typing state", { conversationId, isTyping, error });
    }
  };

  void sendTyping(true);
  const timer = setInterval(() => {
    if (stopped) {
      return;
    }
    void sendTyping(true);
  }, refreshIntervalMs);
  timer.unref?.();

  return async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
    await sendTyping(false);
  };
}

export async function handleProgress(context: ProgressDispatchContext, input: HandleProgressInput): Promise<void> {
  if (!context.progressUpdatesEnabled) {
    return;
  }

  const progressText = mapProgressText(input.progress, context.cliCompatEnabled);
  if (!progressText) {
    return;
  }

  const now = Date.now();
  if (now - input.getLastProgressAt() < context.progressMinIntervalMs && input.progress.stage !== "turn_started") {
    return;
  }
  if (progressText === input.getLastProgressText()) {
    return;
  }

  input.setLastProgressAt(now);
  input.setLastProgressText(progressText);

  await sendProgressUpdate(
    context,
    {
      conversationId: input.conversationId,
      isDirectMessage: input.isDirectMessage,
      getProgressNoticeEventId: input.getProgressNoticeEventId,
      setProgressNoticeEventId: input.setProgressNoticeEventId,
    },
    `${context.botNoticePrefix} ${progressText}`,
  );
}

export async function finishProgress(
  context: ProgressDispatchContext,
  progressContext: SendProgressContext,
  summary: string,
): Promise<void> {
  if (!context.progressUpdatesEnabled) {
    return;
  }
  let updateHint = "";
  try {
    const packageUpdate = await context.packageUpdateChecker.getStatus();
    const delimiter = context.outputLanguage === "en" ? "; " : "；";
    updateHint = `${delimiter}${formatPackageUpdateHint(packageUpdate, context.outputLanguage)}`;
  } catch (error) {
    context.logger.debug("Failed to resolve package update status for progress summary", { error });
  }
  await sendProgressUpdate(context, progressContext, `${context.botNoticePrefix} ${summary}${updateHint}`);
}

export async function sendProgressUpdate(
  context: ProgressDispatchContext,
  progressContext: SendProgressContext,
  text: string,
): Promise<void> {
  try {
    if (
      progressContext.isDirectMessage ||
      progressContext.forceTimeline === true ||
      context.progressDeliveryMode === "timeline"
    ) {
      await context.channel.sendNotice(progressContext.conversationId, text);
      return;
    }

    const eventId = await context.channel.upsertProgressNotice(
      progressContext.conversationId,
      text,
      progressContext.getProgressNoticeEventId(),
    );
    progressContext.setProgressNoticeEventId(eventId);
  } catch (error) {
    context.logger.debug("Failed to send progress update", {
      conversationId: progressContext.conversationId,
      text,
      error,
    });
  }
}
