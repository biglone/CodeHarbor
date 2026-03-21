import type { CliCompatRecorder } from "../compat/cli-compat-recorder";
import type { Logger } from "../logger";

interface CliCompatPromptRecordInput {
  requestId: string;
  sessionKey: string;
  conversationId: string;
  senderId: string;
  prompt: string;
  imageCount: number;
}

export async function recordCliCompatPrompt(
  cliCompatRecorder: CliCompatRecorder | null,
  logger: Logger,
  entry: CliCompatPromptRecordInput,
): Promise<void> {
  if (!cliCompatRecorder) {
    return;
  }
  try {
    await cliCompatRecorder.append({
      timestamp: new Date().toISOString(),
      requestId: entry.requestId,
      sessionKey: entry.sessionKey,
      conversationId: entry.conversationId,
      senderId: entry.senderId,
      prompt: entry.prompt,
      imageCount: entry.imageCount,
    });
  } catch (error) {
    logger.warn("Failed to record cli compat prompt", {
      requestId: entry.requestId,
      error,
    });
  }
}
