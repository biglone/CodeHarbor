import { exec as execCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  classifyRetryDecision,
  classifyRetryableError,
  createRetryPolicy,
  DEFAULT_RETRYABLE_HTTP_STATUSES,
  DEFAULT_RETRYABLE_MESSAGE_PATTERNS,
  parseRetryAfterMs,
  sleep,
  type RetryClassification,
  type RetryPolicy,
} from "./reliability/retry-policy";

const execAsync = promisify(execCallback);
const LOCAL_WHISPER_RETRYABLE_MESSAGE_PATTERNS = [
  ...DEFAULT_RETRYABLE_MESSAGE_PATTERNS,
  "command failed",
  "resource temporarily unavailable",
  "killed",
  "terminated",
  "signal",
];

export interface AudioAttachmentForTranscription {
  name: string;
  mimeType: string | null;
  localPath: string;
}

export interface AudioTranscript {
  name: string;
  text: string;
}

export interface AudioTranscriberLike {
  isEnabled(): boolean;
  transcribeMany(attachments: AudioAttachmentForTranscription[]): Promise<AudioTranscript[]>;
}

interface AudioTranscriberOptions {
  enabled: boolean;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  maxChars: number;
  maxRetries: number;
  retryDelayMs: number;
  localWhisperCommand: string | null;
  localWhisperTimeoutMs: number;
}

export class AudioTranscriber implements AudioTranscriberLike {
  private readonly enabled: boolean;
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxChars: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly localWhisperCommand: string | null;
  private readonly localWhisperTimeoutMs: number;

  constructor(options: AudioTranscriberOptions) {
    this.enabled = options.enabled;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.maxChars = options.maxChars;
    const initialDelayMs = Math.max(0, options.retryDelayMs);
    this.retryPolicy = createRetryPolicy({
      maxAttempts: Math.max(1, options.maxRetries + 1),
      initialDelayMs,
      maxDelayMs: Math.max(initialDelayMs, initialDelayMs * 8),
      multiplier: 2,
      jitterRatio: 0.2,
    });
    this.localWhisperCommand = options.localWhisperCommand;
    this.localWhisperTimeoutMs = options.localWhisperTimeoutMs;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async transcribeMany(attachments: AudioAttachmentForTranscription[]): Promise<AudioTranscript[]> {
    if (!this.enabled || attachments.length === 0) {
      return [];
    }

    const hasLocalWhisper = Boolean(this.localWhisperCommand);
    const hasOpenAi = Boolean(this.apiKey);
    if (!hasLocalWhisper && !hasOpenAi) {
      throw new Error(
        "Audio transcription is enabled but no backend is configured. Set CLI_COMPAT_AUDIO_LOCAL_WHISPER_COMMAND or OPENAI_API_KEY.",
      );
    }

    const transcripts: AudioTranscript[] = [];
    const failures: string[] = [];
    for (const attachment of attachments) {
      const text = await this.transcribeWithFallback(attachment, hasLocalWhisper, hasOpenAi).catch((error) => {
        failures.push(formatError(error));
        return "";
      });
      if (!text) {
        continue;
      }
      transcripts.push({
        name: attachment.name,
        text,
      });
    }

    if (transcripts.length === 0 && failures.length > 0) {
      throw new Error(`Audio transcription failed: ${failures.join(" | ")}`);
    }
    return transcripts;
  }

  private async transcribeWithFallback(
    attachment: AudioAttachmentForTranscription,
    hasLocalWhisper: boolean,
    hasOpenAi: boolean,
  ): Promise<string> {
    let localError: unknown = null;
    if (hasLocalWhisper) {
      try {
        const localText = await this.transcribeOneWithLocalWhisperWithRetry(attachment);
        if (localText) {
          return localText;
        }
      } catch (error) {
        localError = error;
      }
    }

    if (hasOpenAi) {
      try {
        return await this.transcribeOneWithOpenAiWithRetry(attachment);
      } catch (error) {
        if (!localError) {
          throw error;
        }
        throw new Error(
          `local whisper failed (${formatError(localError)}), and OpenAI fallback also failed (${formatError(error)}).`,
          { cause: error },
        );
      }
    }

    if (localError) {
      throw localError;
    }
    return "";
  }

  private async transcribeOneWithOpenAiWithRetry(attachment: AudioAttachmentForTranscription): Promise<string> {
    let attempt = 1;
    while (true) {
      try {
        return await this.transcribeOneWithOpenAi(attachment);
      } catch (error) {
        const retryDecision = classifyOpenAiTranscriptionRetry(this.retryPolicy, attempt, error);
        if (!retryDecision.shouldRetry) {
          throw error;
        }
        await sleep(retryDecision.retryDelayMs ?? 0);
        attempt += 1;
      }
    }
  }

  private async transcribeOneWithLocalWhisperWithRetry(attachment: AudioAttachmentForTranscription): Promise<string> {
    let attempt = 1;
    while (true) {
      try {
        return await this.transcribeOneWithLocalWhisper(attachment);
      } catch (error) {
        const retryDecision = classifyLocalWhisperRetry(this.retryPolicy, attempt, error);
        if (!retryDecision.shouldRetry) {
          throw error;
        }
        await sleep(retryDecision.retryDelayMs ?? 0);
        attempt += 1;
      }
    }
  }

  private async transcribeOneWithOpenAi(attachment: AudioAttachmentForTranscription): Promise<string> {
    if (!this.apiKey) {
      return "";
    }

    const buffer = await fs.readFile(attachment.localPath);
    const formData = new FormData();
    formData.append("model", this.model);
    formData.append("response_format", "json");
    formData.append(
      "file",
      new Blob([buffer], { type: attachment.mimeType ?? "application/octet-stream" }),
      path.basename(attachment.localPath),
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const payload = (await response.json().catch(() => ({}))) as {
      text?: unknown;
      error?: {
        message?: unknown;
      };
    };

    if (!response.ok) {
      const message =
        typeof payload?.error?.message === "string"
          ? payload.error.message
          : `HTTP ${response.status} ${response.statusText}`;
      throw new OpenAiTranscriptionHttpError(
        response.status,
        `Audio transcription failed for ${attachment.name}: ${message}`,
        parseRetryAfterMs(readRetryAfterHeader(response)),
      );
    }

    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    return this.normalizeTranscriptText(text);
  }

  private async transcribeOneWithLocalWhisper(attachment: AudioAttachmentForTranscription): Promise<string> {
    if (!this.localWhisperCommand) {
      return "";
    }

    const command = buildLocalWhisperCommand(this.localWhisperCommand, attachment.localPath);
    const result = await execAsync(command, {
      timeout: this.localWhisperTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      shell: "/bin/bash",
    });

    const text = result.stdout.trim();
    if (!text) {
      const stderr = result.stderr.trim();
      throw new Error(
        stderr
          ? `Local whisper command produced empty output for ${attachment.name}: ${stderr}`
          : `Local whisper command produced empty output for ${attachment.name}.`,
      );
    }
    return this.normalizeTranscriptText(text);
  }

  private normalizeTranscriptText(rawText: string): string {
    const text = rawText.trim();
    if (!text) {
      return "";
    }
    if (text.length > this.maxChars) {
      return `${text.slice(0, this.maxChars)}...`;
    }
    return text;
  }
}

function buildLocalWhisperCommand(template: string, inputPath: string): string {
  const escapedInput = shellEscape(inputPath);
  if (template.includes("{input}")) {
    return template.replaceAll("{input}", escapedInput);
  }
  return `${template} ${escapedInput}`;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function classifyOpenAiTranscriptionError(error: unknown): RetryClassification {
  return classifyRetryableError(error, {
    retryableHttpStatuses: DEFAULT_RETRYABLE_HTTP_STATUSES,
  });
}

function classifyOpenAiTranscriptionRetry(policy: RetryPolicy, attempt: number, error: unknown) {
  return classifyRetryDecision({
    policy,
    attempt,
    error,
    classify: classifyOpenAiTranscriptionError,
  });
}

function classifyLocalWhisperError(error: unknown): RetryClassification {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("produced empty output")) {
      return {
        retryable: false,
        reason: "empty_output",
        retryAfterMs: null,
      };
    }
  }
  return classifyRetryableError(error, {
    retryableMessagePatterns: LOCAL_WHISPER_RETRYABLE_MESSAGE_PATTERNS,
  });
}

function classifyLocalWhisperRetry(policy: RetryPolicy, attempt: number, error: unknown) {
  return classifyRetryDecision({
    policy,
    attempt,
    error,
    classify: classifyLocalWhisperError,
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readRetryAfterHeader(response: Response): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const headers = response.headers as { get?: ((name: string) => string | null) | undefined } | undefined;
  if (!headers || typeof headers.get !== "function") {
    return null;
  }
  return headers.get("retry-after");
}

class OpenAiTranscriptionHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, retryAfterMs: number | null) {
    super(message);
    this.name = "OpenAiTranscriptionHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
