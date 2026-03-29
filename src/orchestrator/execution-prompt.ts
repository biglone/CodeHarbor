import type { AudioTranscript } from "../audio-transcriber";
import { buildDocumentContextPrompt, type DocumentContextItem } from "../document-context";
import type { InboundMessage } from "../types";

interface BuildExecutionPromptInput {
  prompt: string;
  message: InboundMessage;
  audioTranscripts: AudioTranscript[];
  extractedDocuments: DocumentContextItem[];
  bridgeContext: string | null;
  autoDevRuntimeContext: string | null;
}

export function buildExecutionPrompt(input: BuildExecutionPromptInput): string {
  let composed: string;
  if (
    input.message.attachments.length === 0 &&
    input.audioTranscripts.length === 0 &&
    input.extractedDocuments.length === 0
  ) {
    composed = input.prompt;
  } else {
    const attachmentSummary = input.message.attachments
      .map((attachment) => {
        const size = attachment.sizeBytes === null ? "unknown" : `${attachment.sizeBytes}`;
        const mime = attachment.mimeType ?? "unknown";
        const source = attachment.mxcUrl ?? "none";
        const local = attachment.localPath ?? "none";
        return `- kind=${attachment.kind} name=${attachment.name} mime=${mime} size=${size} source=${source} local=${local}`;
      })
      .join("\n");

    const promptBody = input.prompt.trim() ? input.prompt : "(no text body)";
    const sections = [promptBody];
    if (attachmentSummary) {
      sections.push(`[attachments]\n${attachmentSummary}\n[/attachments]`);
    }

    if (input.audioTranscripts.length > 0) {
      const transcriptSummary = input.audioTranscripts
        .map((transcript) => `- name=${transcript.name} text=${transcript.text.replace(/\s+/g, " ").trim()}`)
        .join("\n");
      sections.push(`[audio_transcripts]\n${transcriptSummary}\n[/audio_transcripts]`);
    }

    if (input.extractedDocuments.length > 0) {
      const documentSummary = buildDocumentContextPrompt(input.extractedDocuments);
      if (documentSummary.content) {
        sections.push(`[documents]\n${documentSummary.content}\n[/documents]`);
      }
    }
    composed = sections.join("\n\n");
  }

  const currentRequestBody = input.autoDevRuntimeContext ? `${input.autoDevRuntimeContext}\n\n${composed}` : composed;
  if (!input.bridgeContext) {
    return currentRequestBody;
  }
  return `${input.bridgeContext}\n\n[current_request]\n${currentRequestBody}`;
}
