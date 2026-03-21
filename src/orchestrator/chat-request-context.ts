import type { CliCompatRecorder } from "../compat/cli-compat-recorder";
import type { Logger } from "../logger";
import { executeChatRequest } from "./chat-request";
import { recordCliCompatPrompt as runRecordCliCompatPrompt } from "./cli-compat-prompt-recorder";
import { buildConversationBridgeContext as runBuildConversationBridgeContext } from "./conversation-bridge";
import { buildExecutionPrompt as runBuildExecutionPrompt } from "./execution-prompt";

type ChatRequestDispatchContext = Parameters<typeof executeChatRequest>[0];

interface ChatRequestContextInput {
  logger: ChatRequestDispatchContext["logger"];
  sessionActiveWindowMs: number;
  cliCompat: ChatRequestDispatchContext["cliCompat"];
  stateStore: ChatRequestDispatchContext["stateStore"];
  skipBridgeForNextPrompt: ChatRequestDispatchContext["skipBridgeForNextPrompt"];
  mediaMetrics: ChatRequestDispatchContext["mediaMetrics"];
  runningExecutions: ChatRequestDispatchContext["runningExecutions"];
  consumePendingStopRequest: ChatRequestDispatchContext["consumePendingStopRequest"];
  persistRuntimeMetricsSnapshot: ChatRequestDispatchContext["persistRuntimeMetricsSnapshot"];
  recordRequestMetrics: ChatRequestDispatchContext["recordRequestMetrics"];
  recordCliCompatPrompt: ChatRequestDispatchContext["recordCliCompatPrompt"];
  buildConversationBridgeContext: ChatRequestDispatchContext["buildConversationBridgeContext"];
  transcribeAudioAttachments: ChatRequestDispatchContext["transcribeAudioAttachments"];
  prepareImageAttachments: ChatRequestDispatchContext["prepareImageAttachments"];
  prepareDocumentAttachments: ChatRequestDispatchContext["prepareDocumentAttachments"];
  buildExecutionPrompt: ChatRequestDispatchContext["buildExecutionPrompt"];
  sendNotice: ChatRequestDispatchContext["sendNotice"];
  sendMessage: ChatRequestDispatchContext["sendMessage"];
  startTypingHeartbeat: ChatRequestDispatchContext["startTypingHeartbeat"];
  handleProgress: ChatRequestDispatchContext["handleProgress"];
  finishProgress: ChatRequestDispatchContext["finishProgress"];
  formatBackendToolLabel: ChatRequestDispatchContext["formatBackendToolLabel"];
}

export function buildChatRequestDispatchContext(input: ChatRequestContextInput): ChatRequestDispatchContext {
  return {
    logger: input.logger,
    sessionActiveWindowMs: input.sessionActiveWindowMs,
    cliCompat: input.cliCompat,
    stateStore: input.stateStore,
    skipBridgeForNextPrompt: input.skipBridgeForNextPrompt,
    mediaMetrics: input.mediaMetrics,
    runningExecutions: input.runningExecutions,
    consumePendingStopRequest: input.consumePendingStopRequest,
    persistRuntimeMetricsSnapshot: input.persistRuntimeMetricsSnapshot,
    recordRequestMetrics: input.recordRequestMetrics,
    recordCliCompatPrompt: input.recordCliCompatPrompt,
    buildConversationBridgeContext: input.buildConversationBridgeContext,
    transcribeAudioAttachments: input.transcribeAudioAttachments,
    prepareImageAttachments: input.prepareImageAttachments,
    prepareDocumentAttachments: input.prepareDocumentAttachments,
    buildExecutionPrompt: input.buildExecutionPrompt,
    sendNotice: input.sendNotice,
    sendMessage: input.sendMessage,
    startTypingHeartbeat: input.startTypingHeartbeat,
    handleProgress: input.handleProgress,
    finishProgress: input.finishProgress,
    formatBackendToolLabel: input.formatBackendToolLabel,
  };
}

interface ChatRequestRuntimeContextInput {
  logger: Logger;
  sessionActiveWindowMs: number;
  cliCompatEnabled: boolean;
  cliCompatPassThroughEvents: boolean;
  stateStore: ChatRequestDispatchContext["stateStore"] & {
    listRecentConversationMessages: (sessionKey: string, limit: number) => Array<{
      role: "user" | "assistant";
      provider: string;
      content: string;
    }>;
  };
  skipBridgeForNextPrompt: ChatRequestDispatchContext["skipBridgeForNextPrompt"];
  mediaMetrics: ChatRequestDispatchContext["mediaMetrics"];
  runningExecutions: ChatRequestDispatchContext["runningExecutions"];
  consumePendingStopRequest: ChatRequestDispatchContext["consumePendingStopRequest"];
  persistRuntimeMetricsSnapshot: ChatRequestDispatchContext["persistRuntimeMetricsSnapshot"];
  recordRequestMetrics: ChatRequestDispatchContext["recordRequestMetrics"];
  cliCompatRecorder: CliCompatRecorder | null;
  contextBridgeHistoryLimit: number;
  contextBridgeMaxChars: number;
  transcribeAudioAttachments: ChatRequestDispatchContext["transcribeAudioAttachments"];
  prepareImageAttachments: ChatRequestDispatchContext["prepareImageAttachments"];
  prepareDocumentAttachments: ChatRequestDispatchContext["prepareDocumentAttachments"];
  sendNotice: ChatRequestDispatchContext["sendNotice"];
  sendMessage: ChatRequestDispatchContext["sendMessage"];
  startTypingHeartbeat: ChatRequestDispatchContext["startTypingHeartbeat"];
  handleProgress: ChatRequestDispatchContext["handleProgress"];
  finishProgress: ChatRequestDispatchContext["finishProgress"];
  formatBackendToolLabel: ChatRequestDispatchContext["formatBackendToolLabel"];
}

export function buildChatRequestDispatchContextFromRuntime(
  input: ChatRequestRuntimeContextInput,
): ChatRequestDispatchContext {
  const contextBridgeHistoryLimit = Math.max(1, Math.floor(input.contextBridgeHistoryLimit));
  const contextBridgeMaxChars = Math.max(0, Math.floor(input.contextBridgeMaxChars));
  return buildChatRequestDispatchContext({
    logger: input.logger,
    sessionActiveWindowMs: input.sessionActiveWindowMs,
    cliCompat: {
      enabled: input.cliCompatEnabled,
      passThroughEvents: input.cliCompatPassThroughEvents,
    },
    stateStore: input.stateStore,
    skipBridgeForNextPrompt: input.skipBridgeForNextPrompt,
    mediaMetrics: input.mediaMetrics,
    runningExecutions: input.runningExecutions,
    consumePendingStopRequest: input.consumePendingStopRequest,
    persistRuntimeMetricsSnapshot: input.persistRuntimeMetricsSnapshot,
    recordRequestMetrics: input.recordRequestMetrics,
    recordCliCompatPrompt: (entry) => runRecordCliCompatPrompt(input.cliCompatRecorder, input.logger, entry),
    buildConversationBridgeContext: (sessionKey) =>
      runBuildConversationBridgeContext({
        messages: input.stateStore.listRecentConversationMessages(sessionKey, contextBridgeHistoryLimit),
        maxChars: contextBridgeMaxChars,
      }),
    transcribeAudioAttachments: input.transcribeAudioAttachments,
    prepareImageAttachments: input.prepareImageAttachments,
    prepareDocumentAttachments: input.prepareDocumentAttachments,
    buildExecutionPrompt: (prompt, message, audioTranscripts, extractedDocuments, bridgeContext) =>
      runBuildExecutionPrompt({
        prompt,
        message,
        audioTranscripts,
        extractedDocuments,
        bridgeContext,
      }),
    sendNotice: input.sendNotice,
    sendMessage: input.sendMessage,
    startTypingHeartbeat: input.startTypingHeartbeat,
    handleProgress: input.handleProgress,
    finishProgress: input.finishProgress,
    formatBackendToolLabel: input.formatBackendToolLabel,
  });
}
