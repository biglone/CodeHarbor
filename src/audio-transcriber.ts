import fs from "node:fs/promises";
import path from "node:path";

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
}

export class AudioTranscriber implements AudioTranscriberLike {
  private readonly enabled: boolean;
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxChars: number;

  constructor(options: AudioTranscriberOptions) {
    this.enabled = options.enabled;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.maxChars = options.maxChars;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async transcribeMany(attachments: AudioAttachmentForTranscription[]): Promise<AudioTranscript[]> {
    if (!this.enabled || attachments.length === 0) {
      return [];
    }
    if (!this.apiKey) {
      throw new Error(
        "Audio transcription is enabled but OPENAI_API_KEY is missing. Set OPENAI_API_KEY or disable CLI_COMPAT_TRANSCRIBE_AUDIO.",
      );
    }

    const transcripts: AudioTranscript[] = [];
    for (const attachment of attachments) {
      const text = await this.transcribeOne(attachment);
      if (!text) {
        continue;
      }
      transcripts.push({
        name: attachment.name,
        text,
      });
    }
    return transcripts;
  }

  private async transcribeOne(attachment: AudioAttachmentForTranscription): Promise<string> {
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
      throw new Error(`Audio transcription failed for ${attachment.name}: ${message}`);
    }

    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) {
      return "";
    }
    if (text.length > this.maxChars) {
      return `${text.slice(0, this.maxChars)}...`;
    }
    return text;
  }
}
