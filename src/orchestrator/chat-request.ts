import type { Logger } from "../logger";
import type { RequestOutcomeMetric } from "../metrics";
import type { BackendModelRouteProfile } from "../routing/backend-model-router";
import type { InboundMessage } from "../types";
import type { OutboundMultimodalSummary, SendMessageOptions } from "../channels/channel";
import type { DocumentContextItem } from "../document-context";
import type { AudioTranscript } from "../audio-transcriber";
import type { CodexExecutionHandle, CodexProgressEvent } from "../executor/codex-executor";
import type { CodexSessionRuntime } from "../executor/codex-session-runtime";
import type { OutputLanguage } from "../config";
import { formatDurationMs, formatError, summarizeSingleLine } from "./helpers";
import { shouldRetryClaudeImageFailure } from "./media-progress";
import { buildArtifactBatchFromSnapshots, type WorkspaceArtifactSnapshot } from "./session-artifact-registry";
import {
  buildRecentArtifactDeliveryContext,
  buildModelFileDeliveryHistoryEntry,
  buildModelFileDeliverySummary,
  parseModelFileDeliveryAction,
  resolveModelFileDeliveryAction,
} from "./model-file-delivery-action";
import type { RecentArtifactBatch } from "./file-send-intent";
import { buildFailureProgressSummary, classifyExecutionOutcome } from "./workflow-status";
import { byOutputLanguage } from "./output-language";

interface SendProgressContext {
  conversationId: string;
  isDirectMessage: boolean;
  getProgressNoticeEventId: () => string | null;
  setProgressNoticeEventId: (next: string) => void;
}

interface ImageSelectionResultLike {
  imagePaths: string[];
  acceptedCount: number;
  skippedMissingPath: number;
  skippedMissingLocalFile: number;
  skippedUnsupportedMime: number;
  skippedTooLarge: number;
  skippedOverLimit: number;
  notice: string | null;
}

interface DocumentExtractionSummaryLike {
  documents: DocumentContextItem[];
  notice: string | null;
}

interface RunningExecutionLike {
  requestId: string;
  startedAt: number;
  cancel: () => void;
}

interface StateStoreLike {
  activateSession: (sessionKey: string, activeWindowMs: number) => void;
  getCodexSessionId: (sessionKey: string) => string | null;
  appendConversationMessage: (
    sessionKey: string,
    role: "user" | "assistant",
    provider: "codex" | "claude" | "gemini",
    content: string,
  ) => void;
  commitExecutionSuccess: (sessionKey: string, eventId: string, sessionId: string) => void;
  commitExecutionHandled: (sessionKey: string, eventId: string) => void;
}

interface MediaMetricsLike {
  recordImageSelection: (input: { requestId: string; sessionKey: string; result: ImageSelectionResultLike }) => void;
  recordClaudeImageFallback: (
    status: "triggered" | "succeeded" | "failed",
    input: { requestId: string; sessionKey: string; detail: string },
  ) => void;
}

interface ExecuteChatRequestDeps {
  logger: Logger;
  outputLanguage: OutputLanguage;
  sessionActiveWindowMs: number;
  cliCompat: { enabled: boolean; passThroughEvents: boolean };
  stateStore: StateStoreLike;
  skipBridgeForNextPrompt: Set<string>;
  mediaMetrics: MediaMetricsLike;
  runningExecutions: Map<string, RunningExecutionLike>;
  consumePendingStopRequest: (sessionKey: string) => boolean;
  persistRuntimeMetricsSnapshot: () => void;
  recordRequestMetrics: (outcome: RequestOutcomeMetric, queueMs: number, execMs: number, sendMs: number) => void;
  captureArtifactSnapshot: (workdir: string) => Promise<WorkspaceArtifactSnapshot | null>;
  recordArtifactBatch: (sessionKey: string, batch: ReturnType<typeof buildArtifactBatchFromSnapshots>) => void;
  listRecentArtifactBatches: (sessionKey: string, workdir: string) => RecentArtifactBatch[];
  recordCliCompatPrompt: (entry: {
    requestId: string;
    sessionKey: string;
    conversationId: string;
    senderId: string;
    prompt: string;
    imageCount: number;
  }) => Promise<void>;
  buildConversationBridgeContext: (sessionKey: string) => string | null;
  transcribeAudioAttachments: (
    message: InboundMessage,
    requestId: string,
    sessionKey: string,
  ) => Promise<AudioTranscript[]>;
  prepareImageAttachments: (
    message: InboundMessage,
    requestId: string,
    sessionKey: string,
  ) => Promise<ImageSelectionResultLike>;
  prepareDocumentAttachments: (
    message: InboundMessage,
    requestId: string,
    sessionKey: string,
  ) => Promise<DocumentExtractionSummaryLike>;
  buildExecutionPrompt: (
    basePrompt: string,
    message: InboundMessage,
    audioTranscripts: AudioTranscript[],
    documents: DocumentContextItem[],
    bridgeContext: string | null,
    autoDevRuntimeContext: string | null,
    artifactDeliveryContext: string | null,
  ) => string;
  resolveAutoDevRuntimeContext: (sessionKey: string, workdir: string) => Promise<string | null>;
  recordRequestTraceStart: (input: {
    requestId: string;
    sessionKey: string;
    conversationId: string;
    provider: "codex" | "claude" | "gemini";
    model: string | null;
    prompt: string;
    executionPrompt: string;
  }) => void;
  recordRequestTraceProgress: (requestId: string, stage: string, message: string) => void;
  recordRequestTraceFinish: (
    requestId: string,
    status: "succeeded" | "failed" | "cancelled" | "timeout",
    error: string | null,
    reply: string | null,
    sessionId: string | null,
  ) => void;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
  sendMessage: (conversationId: string, text: string, options?: SendMessageOptions) => Promise<void>;
  sendFile: ((conversationId: string, filePath: string, options?: { fileName?: string; mimeType?: string | null }) => Promise<void>) | null;
  startTypingHeartbeat: (conversationId: string) => () => Promise<void>;
  handleProgress: (
    conversationId: string,
    isDirectMessage: boolean,
    progress: CodexProgressEvent,
    getLastProgressAt: () => number,
    setLastProgressAt: (next: number) => void,
    getLastProgressText: () => string,
    setLastProgressText: (next: string) => void,
    getProgressNoticeEventId: () => string | null,
    setProgressNoticeEventId: (next: string) => void,
  ) => Promise<void>;
  finishProgress: (ctx: SendProgressContext, summary: string) => Promise<void>;
  formatBackendToolLabel: (profile: BackendModelRouteProfile) => string;
}

interface ExecuteChatRequestInput {
  message: InboundMessage;
  receivedAt: number;
  queueWaitMs: number;
  routePrompt: string;
  sessionKey: string;
  requestId: string;
  roomWorkdir: string;
  roomConfigSource: "default" | "room";
  backendProfile: BackendModelRouteProfile;
  backendRouteSource: string;
  backendRouteReason: string;
  backendRouteRuleId: string | null;
  sessionRuntime: CodexSessionRuntime;
  deferFailureHandlingToQueue: boolean;
  releaseRateLimit: () => void;
}

export async function executeChatRequest(
  deps: ExecuteChatRequestDeps,
  input: ExecuteChatRequestInput,
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  deps.stateStore.activateSession(input.sessionKey, deps.sessionActiveWindowMs);
  const previousCodexSessionId = deps.stateStore.getCodexSessionId(input.sessionKey);
  const allowBridgeContext =
    previousCodexSessionId === null && !deps.skipBridgeForNextPrompt.delete(input.sessionKey);
  const bridgeContext = allowBridgeContext ? deps.buildConversationBridgeContext(input.sessionKey) : null;
  let autoDevRuntimeContext: string | null = null;
  try {
    autoDevRuntimeContext = await deps.resolveAutoDevRuntimeContext(input.sessionKey, input.roomWorkdir);
  } catch (error) {
    deps.logger.debug("Failed to resolve AutoDev runtime context for chat prompt", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      workdir: input.roomWorkdir,
      error: formatError(error),
    });
  }
  const audioTranscripts = await deps.transcribeAudioAttachments(input.message, input.requestId, input.sessionKey);
  const imageSelection = await deps.prepareImageAttachments(input.message, input.requestId, input.sessionKey);
  deps.mediaMetrics.recordImageSelection({
    requestId: input.requestId,
    sessionKey: input.sessionKey,
    result: imageSelection,
  });
  if (imageSelection.notice) {
    await deps.sendNotice(input.message.conversationId, imageSelection.notice);
  }
  const documentSummary = await deps.prepareDocumentAttachments(input.message, input.requestId, input.sessionKey);
  if (documentSummary.notice) {
    await deps.sendNotice(input.message.conversationId, documentSummary.notice);
  }
  const recentArtifactBatches = deps.listRecentArtifactBatches(input.sessionKey, input.roomWorkdir);
  const executionPrompt = deps.buildExecutionPrompt(
    input.routePrompt,
    input.message,
    audioTranscripts,
    documentSummary.documents,
    bridgeContext,
    autoDevRuntimeContext,
    buildRecentArtifactDeliveryContext(recentArtifactBatches),
  );
  const imagePaths = imageSelection.imagePaths;
  let lastProgressAt = 0;
  let lastProgressText = "";
  let progressNoticeEventId: string | null = null;
  let progressChain: Promise<void> = Promise.resolve();
  let executionHandle: CodexExecutionHandle | null = null;
  let executionDurationMs = 0;
  let sendDurationMs = 0;
  const requestStartedAt = Date.now();
  const artifactSnapshotBeforeRun = await deps.captureArtifactSnapshot(input.roomWorkdir);
  let cancelRequested = deps.consumePendingStopRequest(input.sessionKey);

  deps.runningExecutions.set(input.sessionKey, {
    requestId: input.requestId,
    startedAt: requestStartedAt,
    cancel: () => {
      cancelRequested = true;
      executionHandle?.cancel();
    },
  });
  deps.persistRuntimeMetricsSnapshot();

  await deps.recordCliCompatPrompt({
    requestId: input.requestId,
    sessionKey: input.sessionKey,
    conversationId: input.message.conversationId,
    senderId: input.message.senderId,
    prompt: executionPrompt,
    imageCount: imagePaths.length,
  });
  deps.recordRequestTraceStart({
    requestId: input.requestId,
    sessionKey: input.sessionKey,
    conversationId: input.message.conversationId,
    provider: input.backendProfile.provider,
    model: input.backendProfile.model ?? null,
    prompt: input.routePrompt,
    executionPrompt,
  });
  deps.stateStore.appendConversationMessage(input.sessionKey, "user", input.backendProfile.provider, input.routePrompt);
  deps.logger.info("Processing message", {
    requestId: input.requestId,
    sessionKey: input.sessionKey,
    hasCodexSession: Boolean(previousCodexSessionId),
    backend: deps.formatBackendToolLabel(input.backendProfile),
    backendRouteSource: input.backendRouteSource,
    backendRouteReason: input.backendRouteReason,
    backendRouteRuleId: input.backendRouteRuleId,
    queueWaitMs: input.queueWaitMs,
    attachmentCount: input.message.attachments.length,
    workdir: input.roomWorkdir,
    roomConfigSource: input.roomConfigSource,
    isDirectMessage: input.message.isDirectMessage,
    mentionsBot: input.message.mentionsBot,
    repliesToBot: input.message.repliesToBot,
  });

  const stopTyping = deps.startTypingHeartbeat(input.message.conversationId);

  try {
    const executionStartedAt = Date.now();
    const executeOnce = async (attemptImagePaths: string[]): Promise<{ sessionId: string; reply: string }> => {
      executionHandle = input.sessionRuntime.startExecution(
        input.sessionKey,
        executionPrompt,
        previousCodexSessionId,
        (progress) => {
          const progressText = summarizeSingleLine(
            `${progress.stage}${progress.message ? `: ${progress.message}` : ""}`,
            300,
          );
          deps.recordRequestTraceProgress(input.requestId, progress.stage, progressText);
          progressChain = progressChain
            .then(() =>
              deps.handleProgress(
                input.message.conversationId,
                input.message.isDirectMessage,
                progress,
                () => lastProgressAt,
                (next) => {
                  lastProgressAt = next;
                },
                () => lastProgressText,
                (next) => {
                  lastProgressText = next;
                },
                () => progressNoticeEventId,
                (next) => {
                  progressNoticeEventId = next;
                },
              ),
            )
            .catch((progressError) => {
              deps.logger.debug("Failed to process progress callback", { progressError });
            });
        },
        {
          passThroughRawEvents: deps.cliCompat.enabled && deps.cliCompat.passThroughEvents,
          imagePaths: attemptImagePaths,
          workdir: input.roomWorkdir,
        },
      );
      const running = deps.runningExecutions.get(input.sessionKey);
      if (running?.requestId === input.requestId) {
        running.startedAt = executionStartedAt;
        running.cancel = () => {
          cancelRequested = true;
          executionHandle?.cancel();
        };
      }
      if (cancelRequested) {
        executionHandle.cancel();
      }
      return executionHandle.result;
    };

    let result: { sessionId: string; reply: string };
    let successfulImagePaths = [...imagePaths];
    try {
      result = await executeOnce(imagePaths);
      successfulImagePaths = [...imagePaths];
    } catch (error) {
      if (!shouldRetryClaudeImageFailure(input.backendProfile.provider, imagePaths, error)) {
        throw error;
      }
      const reason = summarizeSingleLine(formatError(error), 220);
      deps.mediaMetrics.recordClaudeImageFallback("triggered", {
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        detail: reason,
      });
      await deps.sendNotice(
        input.message.conversationId,
        localize(
          `[CodeHarbor] 检测到 Claude 图片处理失败，已自动降级为纯文本重试。原因: ${reason}`,
          `[CodeHarbor] Claude image processing failed. Automatically retrying in text-only mode. Reason: ${reason}`,
        ),
      );
      deps.logger.warn("Claude image execution failed, retrying without image inputs", {
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        imageCount: imagePaths.length,
        reason: formatError(error),
      });
      try {
        result = await executeOnce([]);
        successfulImagePaths = [];
        deps.mediaMetrics.recordClaudeImageFallback("succeeded", {
          requestId: input.requestId,
          sessionKey: input.sessionKey,
          detail: "retry_without_images_ok",
        });
      } catch (retryError) {
        deps.mediaMetrics.recordClaudeImageFallback("failed", {
          requestId: input.requestId,
          sessionKey: input.sessionKey,
          detail: summarizeSingleLine(formatError(retryError), 220),
        });
        throw retryError;
      }
    }

    executionDurationMs = Date.now() - executionStartedAt;
    await progressChain;

    const parsedAction = parseModelFileDeliveryAction(result.reply);
    const sendStartedAt = Date.now();
    const messageOptions: SendMessageOptions = {
      multimodalSummary: buildMultimodalSummary(input.message, successfulImagePaths, audioTranscripts),
      requestId: input.requestId,
    };
    if (parsedAction.cleanReply) {
      await deps.sendMessage(input.message.conversationId, parsedAction.cleanReply, messageOptions);
    }

    let deliveredActionSummary: string | null = null;
    const resolvedAction = parsedAction.action
      ? resolveModelFileDeliveryAction({
          action: parsedAction.action,
          recentArtifactBatches,
        })
      : null;
    if (parsedAction.action) {
      if (!deps.sendFile) {
        await deps.sendNotice(
          input.message.conversationId,
          "[CodeHarbor] 已解析到模型文件发送动作，但当前通道未启用文件附件发送能力。",
        );
      } else {
        for (const file of resolvedAction?.files ?? []) {
          await deps.sendFile(input.message.conversationId, file.absolutePath, {
            fileName: file.relativePath.split("/").at(-1) ?? file.relativePath,
          });
        }
        if ((resolvedAction?.files.length ?? 0) > 0 && !parsedAction.cleanReply) {
          deliveredActionSummary = buildModelFileDeliverySummary(resolvedAction!);
          await deps.sendNotice(input.message.conversationId, deliveredActionSummary);
        } else if ((resolvedAction?.files.length ?? 0) === 0) {
          await deps.sendNotice(input.message.conversationId, buildModelFileDeliverySummary(resolvedAction!));
        }
      }
    }

    deps.stateStore.appendConversationMessage(
      input.sessionKey,
      "assistant",
      input.backendProfile.provider,
      buildModelFileDeliveryHistoryEntry({
        cleanReply: parsedAction.cleanReply || deliveredActionSummary || "",
        sentFiles: resolvedAction?.files ?? [],
      }),
    );
    const artifactSnapshotAfterRun = await deps.captureArtifactSnapshot(input.roomWorkdir);
    deps.recordArtifactBatch(
      input.sessionKey,
      buildArtifactBatchFromSnapshots({
        requestId: input.requestId,
        workdir: input.roomWorkdir,
        before: artifactSnapshotBeforeRun,
        after: artifactSnapshotAfterRun,
        replyText: result.reply,
      }),
    );
    await deps.finishProgress(
      {
        conversationId: input.message.conversationId,
        isDirectMessage: input.message.isDirectMessage,
        getProgressNoticeEventId: () => progressNoticeEventId,
        setProgressNoticeEventId: (next) => {
          progressNoticeEventId = next;
        },
      },
      `${localize(
        `处理完成（后端工具: ${deps.formatBackendToolLabel(input.backendProfile)}；耗时 ${formatDurationMs(Date.now() - requestStartedAt)}）`,
        `Completed (backend: ${deps.formatBackendToolLabel(input.backendProfile)}; elapsed: ${formatDurationMs(Date.now() - requestStartedAt)})`,
      )}\n- requestId: ${input.requestId}`,
    );
    sendDurationMs = Date.now() - sendStartedAt;

    deps.stateStore.commitExecutionSuccess(input.sessionKey, input.message.eventId, result.sessionId);
    deps.recordRequestTraceFinish(input.requestId, "succeeded", null, result.reply, result.sessionId);
    deps.recordRequestMetrics("success", input.queueWaitMs, executionDurationMs, sendDurationMs);
    deps.logger.info("Request completed", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      status: "success",
      queueWaitMs: input.queueWaitMs,
      executionDurationMs,
      sendDurationMs,
      totalDurationMs: Date.now() - input.receivedAt,
    });
  } catch (error) {
    const status = classifyExecutionOutcome(error);
    executionDurationMs = Date.now() - requestStartedAt;
    await progressChain;

    await deps.finishProgress(
      {
        conversationId: input.message.conversationId,
        isDirectMessage: input.message.isDirectMessage,
        getProgressNoticeEventId: () => progressNoticeEventId,
        setProgressNoticeEventId: (next) => {
          progressNoticeEventId = next;
        },
      },
      `${buildFailureProgressSummary(status, requestStartedAt, error, deps.outputLanguage)}\n- requestId: ${input.requestId}`,
    );

    const traceStatus = status === "timeout" ? "timeout" : status === "cancelled" ? "cancelled" : "failed";
    deps.recordRequestTraceFinish(input.requestId, traceStatus, formatError(error), null, null);
    if (status !== "cancelled" && !input.deferFailureHandlingToQueue) {
      try {
        await deps.sendMessage(
          input.message.conversationId,
          localize(
            `[CodeHarbor] 请求处理失败: ${formatError(error)}`,
            `[CodeHarbor] Failed to process request: ${formatError(error)}`,
          ),
          {
            requestId: input.requestId,
          },
        );
      } catch (sendError) {
        deps.logger.error("Failed to send error reply to Matrix", sendError);
      }
    }

    if (!input.deferFailureHandlingToQueue) {
      deps.stateStore.commitExecutionHandled(input.sessionKey, input.message.eventId);
    }
    deps.recordRequestMetrics(status, input.queueWaitMs, executionDurationMs, sendDurationMs);
    deps.logger.error("Request failed", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      status,
      queueWaitMs: input.queueWaitMs,
      executionDurationMs,
      totalDurationMs: Date.now() - input.receivedAt,
      error: formatError(error),
    });
    if (input.deferFailureHandlingToQueue) {
      throw error;
    }
  } finally {
    const running = deps.runningExecutions.get(input.sessionKey);
    if (running?.requestId === input.requestId) {
      deps.runningExecutions.delete(input.sessionKey);
    }
    input.releaseRateLimit();
    deps.persistRuntimeMetricsSnapshot();
    await stopTyping();
  }
}

function buildMultimodalSummary(
  message: InboundMessage,
  successfulImagePaths: string[],
  audioTranscripts: AudioTranscript[],
): OutboundMultimodalSummary | null {
  const imageSummary = buildImageSummary(message, successfulImagePaths);
  const audioSummary = buildAudioSummary(message, audioTranscripts);
  if (!imageSummary && !audioSummary) {
    return null;
  }
  return {
    images: imageSummary,
    audio: audioSummary,
  };
}

function buildImageSummary(
  message: InboundMessage,
  successfulImagePaths: string[],
): OutboundMultimodalSummary["images"] {
  const imageAttachments = message.attachments.filter((attachment) => attachment.kind === "image");
  if (imageAttachments.length === 0) {
    return null;
  }

  const includedNames: string[] = [];
  for (const localPath of successfulImagePaths) {
    const matched = imageAttachments.find((attachment) => attachment.localPath === localPath);
    const name = matched?.name?.trim();
    if (!name) {
      continue;
    }
    if (!includedNames.includes(name)) {
      includedNames.push(name);
    }
    if (includedNames.length >= 6) {
      break;
    }
  }

  return {
    total: imageAttachments.length,
    included: successfulImagePaths.length,
    names: includedNames,
  };
}

function buildAudioSummary(
  message: InboundMessage,
  audioTranscripts: AudioTranscript[],
): OutboundMultimodalSummary["audio"] {
  const audioAttachments = message.attachments.filter((attachment) => attachment.kind === "audio");
  if (audioAttachments.length === 0) {
    return null;
  }

  const items = audioTranscripts
    .map((transcript) => ({
      name: transcript.name.trim(),
      summary: summarizeSingleLine(transcript.text, 140),
    }))
    .filter((item) => item.name.length > 0 && item.summary.length > 0)
    .slice(0, 4);

  return {
    total: audioAttachments.length,
    transcribed: audioTranscripts.length,
    items,
  };
}
