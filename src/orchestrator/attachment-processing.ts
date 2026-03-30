import fs from "node:fs/promises";

import type { AudioTranscript, AudioTranscriberLike } from "../audio-transcriber";
import { DEFAULT_DOCUMENT_MAX_BYTES, extractDocumentText } from "../document-extractor";
import type { DocumentContextItem } from "../document-context";
import type { InboundMessage } from "../types";
import { formatError } from "./helpers";
import { normalizeImageMimeType } from "./media-progress";
import { formatByteSize } from "./misc-utils";

interface LoggerLike {
  info: (message: string, context?: unknown) => void;
  warn: (message: string, context?: unknown) => void;
}

interface CliCompatLike {
  fetchMedia: boolean;
  imageMaxBytes: number;
  imageMaxCount: number;
  imageAllowedMimeTypes: string[];
  audioTranscribeMaxBytes: number;
}

interface MediaMetricsLike {
  recordAudioTranscription: (input: {
    requestId: string;
    sessionKey: string;
    transcribedCount: number;
    failedCount: number;
    skippedTooLarge: number;
  }) => void;
}

export interface ImageSelectionResultLike {
  imagePaths: string[];
  acceptedCount: number;
  skippedMissingPath: number;
  skippedUnsupportedMime: number;
  skippedTooLarge: number;
  skippedOverLimit: number;
  notice: string | null;
}

export interface DocumentExtractionSummaryLike {
  documents: DocumentContextItem[];
  notice: string | null;
}

export async function prepareImageAttachments(
  deps: {
    cliCompat: CliCompatLike;
    logger: LoggerLike;
  },
  input: {
    message: InboundMessage;
    requestId: string;
    sessionKey: string;
  },
): Promise<ImageSelectionResultLike> {
  const result: ImageSelectionResultLike = {
    imagePaths: [],
    acceptedCount: 0,
    skippedMissingPath: 0,
    skippedUnsupportedMime: 0,
    skippedTooLarge: 0,
    skippedOverLimit: 0,
    notice: null,
  };

  const rawImageAttachments = input.message.attachments.filter((attachment) => attachment.kind === "image");
  if (rawImageAttachments.length === 0) {
    return result;
  }

  const maxBytes = deps.cliCompat.imageMaxBytes;
  const maxCount = deps.cliCompat.imageMaxCount;
  const allowlist = new Set(deps.cliCompat.imageAllowedMimeTypes.map((item) => item.toLowerCase()));
  const dedup = new Set<string>();

  const acceptedCandidates: string[] = [];
  for (const attachment of rawImageAttachments) {
    const localPath = attachment.localPath;
    if (!localPath) {
      if (deps.cliCompat.fetchMedia) {
        result.skippedMissingPath += 1;
      }
      continue;
    }
    const localFileExists = await hasLocalFile(localPath);
    if (!localFileExists) {
      if (deps.cliCompat.fetchMedia) {
        result.skippedMissingPath += 1;
      }
      deps.logger.warn("Skip image attachment due to missing local file", {
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        name: attachment.name,
        localPath,
      });
      continue;
    }
    if (dedup.has(localPath)) {
      continue;
    }
    dedup.add(localPath);

    const normalizedMimeType = normalizeImageMimeType(attachment.mimeType, localPath);
    if (!normalizedMimeType || !allowlist.has(normalizedMimeType)) {
      result.skippedUnsupportedMime += 1;
      deps.logger.warn("Skip image attachment due to unsupported mime type", {
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        name: attachment.name,
        mimeType: attachment.mimeType,
        normalizedMimeType,
        allowlist: [...allowlist],
      });
      continue;
    }

    const sizeBytes = await resolveAttachmentSizeBytes(attachment.sizeBytes, localPath);
    if (sizeBytes !== null && sizeBytes > maxBytes) {
      result.skippedTooLarge += 1;
      deps.logger.warn("Skip image attachment due to oversize", {
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        name: attachment.name,
        sizeBytes,
        maxBytes,
      });
      continue;
    }
    acceptedCandidates.push(localPath);
  }

  result.acceptedCount = acceptedCandidates.length;
  if (acceptedCandidates.length > maxCount) {
    result.imagePaths = acceptedCandidates.slice(0, maxCount);
    result.skippedOverLimit = acceptedCandidates.length - maxCount;
  } else {
    result.imagePaths = acceptedCandidates;
  }

  if (
    result.skippedMissingPath > 0 ||
    result.skippedUnsupportedMime > 0 ||
    result.skippedTooLarge > 0 ||
    result.skippedOverLimit > 0
  ) {
    const parts: string[] = [];
    if (result.skippedMissingPath > 0) {
      parts.push(`未下载到本地 ${result.skippedMissingPath} 张`);
    }
    if (result.skippedUnsupportedMime > 0) {
      parts.push(`格式不支持 ${result.skippedUnsupportedMime} 张（允许: ${deps.cliCompat.imageAllowedMimeTypes.join(", ")}）`);
    }
    if (result.skippedTooLarge > 0) {
      parts.push(`超过大小限制 ${result.skippedTooLarge} 张（上限 ${formatByteSize(maxBytes)}）`);
    }
    if (result.skippedOverLimit > 0) {
      parts.push(`超过数量上限 ${result.skippedOverLimit} 张（最多 ${maxCount} 张）`);
    }
    const acceptedText = result.imagePaths.length > 0 ? `已附带 ${result.imagePaths.length} 张图片` : "本次未附带图片";
    result.notice = `[CodeHarbor] 图片处理提示：${acceptedText}；${parts.join("；")}。`;
  }

  return result;
}

export async function transcribeAudioAttachments(
  deps: {
    audioTranscriber: AudioTranscriberLike;
    cliCompat: CliCompatLike;
    mediaMetrics: MediaMetricsLike;
    logger: LoggerLike;
  },
  input: {
    message: InboundMessage;
    requestId: string;
    sessionKey: string;
  },
): Promise<AudioTranscript[]> {
  if (!deps.audioTranscriber.isEnabled()) {
    return [];
  }

  const rawAudioAttachments = input.message.attachments.filter(
    (attachment) => attachment.kind === "audio" && Boolean(attachment.localPath),
  );
  if (rawAudioAttachments.length === 0) {
    return [];
  }

  const maxBytes = deps.cliCompat.audioTranscribeMaxBytes;
  const audioAttachments: Array<{ name: string; mimeType: string | null; localPath: string }> = [];
  let skippedTooLarge = 0;
  for (const attachment of rawAudioAttachments) {
    const localPath = attachment.localPath as string;
    const sizeBytes = await resolveAttachmentSizeBytes(attachment.sizeBytes, localPath);
    if (sizeBytes !== null && sizeBytes > maxBytes) {
      skippedTooLarge += 1;
      deps.logger.warn("Skip audio transcription for oversized attachment", {
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        name: attachment.name,
        sizeBytes,
        maxBytes,
      });
      continue;
    }
    audioAttachments.push({
      name: attachment.name,
      mimeType: attachment.mimeType,
      localPath,
    });
  }

  if (audioAttachments.length === 0) {
    if (skippedTooLarge > 0) {
      deps.mediaMetrics.recordAudioTranscription({
        requestId: input.requestId,
        sessionKey: input.sessionKey,
        transcribedCount: 0,
        failedCount: 0,
        skippedTooLarge,
      });
    }
    return [];
  }

  const startedAt = Date.now();
  try {
    const transcripts = await deps.audioTranscriber.transcribeMany(audioAttachments);
    deps.mediaMetrics.recordAudioTranscription({
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      transcribedCount: transcripts.length,
      failedCount: 0,
      skippedTooLarge,
    });
    deps.logger.info("Audio transcription completed", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      attachmentCount: audioAttachments.length,
      transcriptCount: transcripts.length,
      skippedTooLarge,
      durationMs: Date.now() - startedAt,
    });
    return transcripts;
  } catch (error) {
    deps.mediaMetrics.recordAudioTranscription({
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      transcribedCount: 0,
      failedCount: audioAttachments.length,
      skippedTooLarge,
    });
    deps.logger.warn("Audio transcription failed, continuing without transcripts", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      attachmentCount: audioAttachments.length,
      skippedTooLarge,
      durationMs: Date.now() - startedAt,
      error: formatError(error),
    });
    return [];
  }
}

export async function prepareDocumentAttachments(
  deps: { logger: LoggerLike },
  input: {
    message: InboundMessage;
    requestId: string;
    sessionKey: string;
  },
): Promise<DocumentExtractionSummaryLike> {
  const result: DocumentExtractionSummaryLike = {
    documents: [],
    notice: null,
  };

  const fileAttachments = input.message.attachments.filter((attachment) => attachment.kind === "file");
  if (fileAttachments.length === 0) {
    return result;
  }

  let skippedUnsupportedType = 0;
  let skippedTooLarge = 0;
  let skippedMissingLocalPath = 0;
  let failedExtraction = 0;

  for (const attachment of fileAttachments) {
    const extraction = await extractDocumentText({
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      localPath: attachment.localPath,
      maxBytes: DEFAULT_DOCUMENT_MAX_BYTES,
    });

    if (extraction.ok) {
      result.documents.push({
        name: extraction.name,
        format: extraction.format,
        sizeBytes: extraction.sizeBytes,
        text: extraction.text,
      });
      continue;
    }

    if (extraction.reason === "unsupported_type") {
      skippedUnsupportedType += 1;
      continue;
    }
    if (extraction.reason === "file_too_large") {
      skippedTooLarge += 1;
      continue;
    }
    if (extraction.reason === "missing_local_path") {
      skippedMissingLocalPath += 1;
      continue;
    }

    failedExtraction += 1;
    deps.logger.warn("Failed to extract document attachment", {
      requestId: input.requestId,
      sessionKey: input.sessionKey,
      name: attachment.name,
      mimeType: attachment.mimeType,
      reason: extraction.reason,
      message: extraction.message,
    });
  }

  if (
    skippedUnsupportedType === 0 &&
    skippedTooLarge === 0 &&
    skippedMissingLocalPath === 0 &&
    failedExtraction === 0
  ) {
    return result;
  }

  const parts: string[] = [];
  if (result.documents.length > 0) {
    parts.push(`已提取 ${result.documents.length} 份文档`);
  } else {
    parts.push("未提取到可用文档");
  }
  if (skippedUnsupportedType > 0) {
    parts.push(`类型不支持 ${skippedUnsupportedType} 份（仅支持 txt/pdf/docx）`);
  }
  if (skippedTooLarge > 0) {
    parts.push(`超过大小限制 ${skippedTooLarge} 份（上限 ${formatByteSize(DEFAULT_DOCUMENT_MAX_BYTES)}）`);
  }
  if (skippedMissingLocalPath > 0) {
    parts.push(`未下载到本地 ${skippedMissingLocalPath} 份`);
  }
  if (failedExtraction > 0) {
    parts.push(`解析失败 ${failedExtraction} 份`);
  }
  result.notice = `[CodeHarbor] 文档处理提示：${parts.join("；")}。`;
  return result;
}

async function resolveAttachmentSizeBytes(sizeBytes: number | null, localPath: string): Promise<number | null> {
  if (sizeBytes !== null) {
    return sizeBytes;
  }
  try {
    const stats = await fs.stat(localPath);
    return stats.size;
  } catch {
    return null;
  }
}

async function hasLocalFile(localPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(localPath);
    return stats.isFile();
  } catch {
    return false;
  }
}
