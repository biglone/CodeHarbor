import { exec as execCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(execCallback);
const RETRYABLE_OPENAI_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly localWhisperCommand: string | null;
  private readonly localWhisperTimeoutMs: number;

  constructor(options: AudioTranscriberOptions) {
    this.enabled = options.enabled;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.maxChars = options.maxChars;
    this.maxRetries = options.maxRetries;
    this.retryDelayMs = options.retryDelayMs;
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
    let attempt = 0;
    while (true) {
      try {
        return await this.transcribeOneWithOpenAi(attachment);
      } catch (error) {
        if (!isRetryableOpenAiError(error) || attempt >= this.maxRetries) {
          throw error;
        }
        attempt += 1;
        await sleep(this.retryDelayMs * attempt);
      }
    }
  }

  private async transcribeOneWithLocalWhisperWithRetry(attachment: AudioAttachmentForTranscription): Promise<string> {
    let attempt = 0;
    while (true) {
      try {
        return await this.transcribeOneWithLocalWhisper(attachment);
      } catch (error) {
        if (attempt >= this.maxRetries) {
          throw error;
        }
        attempt += 1;
        await sleep(this.retryDelayMs * attempt);
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
      throw new OpenAiTranscriptionHttpError(response.status, `Audio transcription failed for ${attachment.name}: ${message}`);
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

function isRetryableOpenAiError(error: unknown): boolean {
  if (error instanceof OpenAiTranscriptionHttpError) {
    return RETRYABLE_OPENAI_STATUS.has(error.status);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return true;
}

async function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

class OpenAiTranscriptionHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenAiTranscriptionHttpError";
    this.status = status;
  }
}
