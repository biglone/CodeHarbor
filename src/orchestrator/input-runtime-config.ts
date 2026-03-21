import { AudioTranscriber, type AudioTranscriberLike } from "../audio-transcriber";
import { CliCompatRecorder } from "../compat/cli-compat-recorder";
import type { CliCompatConfig } from "../config";
import type { OrchestratorOptions } from "./orchestrator-config-types";

export interface InputRuntimeConfig {
  cliCompat: CliCompatConfig;
  cliCompatRecorder: CliCompatRecorder | null;
  audioTranscriber: AudioTranscriberLike;
  progressMinIntervalMs: number;
  typingTimeoutMs: number;
}

function buildDefaultCliCompatConfig(): CliCompatConfig {
  return {
    enabled: false,
    passThroughEvents: false,
    preserveWhitespace: false,
    disableReplyChunkSplit: false,
    progressThrottleMs: 300,
    fetchMedia: false,
    imageMaxBytes: 10_485_760,
    imageMaxCount: 4,
    imageAllowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    transcribeAudio: false,
    audioTranscribeModel: "gpt-4o-mini-transcribe",
    audioTranscribeTimeoutMs: 120_000,
    audioTranscribeMaxChars: 6_000,
    audioTranscribeMaxRetries: 1,
    audioTranscribeRetryDelayMs: 800,
    audioTranscribeMaxBytes: 26_214_400,
    audioLocalWhisperCommand: null,
    audioLocalWhisperTimeoutMs: 180_000,
    recordPath: null,
  };
}

export function resolveInputRuntimeConfig(input: { options: OrchestratorOptions | undefined }): InputRuntimeConfig {
  const cliCompat = input.options?.cliCompat ?? buildDefaultCliCompatConfig();
  const cliCompatRecorder = cliCompat.recordPath ? new CliCompatRecorder(cliCompat.recordPath) : null;
  const audioTranscriber =
    input.options?.audioTranscriber ??
    new AudioTranscriber({
      enabled: cliCompat.transcribeAudio,
      apiKey: process.env.OPENAI_API_KEY?.trim() || null,
      model: cliCompat.audioTranscribeModel,
      timeoutMs: cliCompat.audioTranscribeTimeoutMs,
      maxChars: cliCompat.audioTranscribeMaxChars,
      maxRetries: cliCompat.audioTranscribeMaxRetries,
      retryDelayMs: cliCompat.audioTranscribeRetryDelayMs,
      localWhisperCommand: cliCompat.audioLocalWhisperCommand,
      localWhisperTimeoutMs: cliCompat.audioLocalWhisperTimeoutMs,
    });
  const defaultProgressInterval = input.options?.progressMinIntervalMs ?? 2_500;
  const progressMinIntervalMs = cliCompat.enabled ? cliCompat.progressThrottleMs : defaultProgressInterval;
  const typingTimeoutMs = input.options?.typingTimeoutMs ?? 10_000;

  return {
    cliCompat,
    cliCompatRecorder,
    audioTranscriber,
    progressMinIntervalMs,
    typingTimeoutMs,
  };
}
