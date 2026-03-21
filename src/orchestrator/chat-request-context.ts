import { executeChatRequest } from "./chat-request";

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
