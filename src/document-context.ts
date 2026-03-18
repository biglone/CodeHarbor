import { type SupportedDocumentFormat } from "./document-extractor";

export interface DocumentContextItem {
  name: string;
  format: SupportedDocumentFormat;
  sizeBytes: number;
  text: string;
}

export interface DocumentContextPromptOptions {
  summaryMaxChars?: number;
  chunkMaxChars?: number;
  maxChunksPerDocument?: number;
  totalCharBudget?: number;
  maxDocuments?: number;
}

export interface DocumentContextPromptResult {
  content: string;
  includedDocuments: number;
  omittedDocuments: number;
  truncated: boolean;
}

interface ResolvedDocumentContextPromptOptions {
  summaryMaxChars: number;
  chunkMaxChars: number;
  maxChunksPerDocument: number;
  totalCharBudget: number;
  maxDocuments: number;
}

interface RenderedDocumentEntry {
  entry: string;
  truncated: boolean;
}

export const DEFAULT_DOCUMENT_CONTEXT_SUMMARY_MAX_CHARS = 320;
export const DEFAULT_DOCUMENT_CONTEXT_CHUNK_MAX_CHARS = 1_200;
export const DEFAULT_DOCUMENT_CONTEXT_MAX_CHUNKS_PER_DOCUMENT = 3;
export const DEFAULT_DOCUMENT_CONTEXT_TOTAL_CHAR_BUDGET = 6_000;
export const DEFAULT_DOCUMENT_CONTEXT_MAX_DOCUMENTS = 6;

const DOCUMENT_CONTEXT_MARKER_BUDGET_RESERVE = 96;
const DOCUMENT_NAME_MAX_CHARS = 120;
const MIN_BREAKPOINT_RATIO = 0.6;

export function buildDocumentContextPrompt(
  documents: readonly DocumentContextItem[],
  options: DocumentContextPromptOptions = {},
): DocumentContextPromptResult {
  if (documents.length === 0) {
    return {
      content: "",
      includedDocuments: 0,
      omittedDocuments: 0,
      truncated: false,
    };
  }

  const resolved = resolveOptions(options);
  const entries: string[] = [];
  const selectedDocuments = documents.slice(0, resolved.maxDocuments);
  let includedDocuments = 0;
  let omittedDocuments = Math.max(0, documents.length - selectedDocuments.length);
  let truncated = omittedDocuments > 0;
  const contentBudget = Math.max(1, resolved.totalCharBudget - DOCUMENT_CONTEXT_MARKER_BUDGET_RESERVE);

  for (let index = 0; index < selectedDocuments.length; index += 1) {
    const document = selectedDocuments[index];
    const rendered = renderDocumentEntry(document, resolved);
    if (appendWithinBudget(entries, rendered.entry, contentBudget)) {
      includedDocuments += 1;
      truncated = truncated || rendered.truncated;
      continue;
    }

    const fallback = renderDocumentEntry(document, {
      ...resolved,
      maxChunksPerDocument: 0,
    });

    if (appendWithinBudget(entries, fallback.entry, contentBudget)) {
      includedDocuments += 1;
      truncated = true;
    } else {
      omittedDocuments += 1;
      truncated = true;
    }

    omittedDocuments += Math.max(0, selectedDocuments.length - index - 1);
    truncated = true;
    break;
  }

  if (omittedDocuments > 0) {
    const marker = `- [truncated] omitted_documents=${omittedDocuments}`;
    if (!appendWithinBudget(entries, marker, resolved.totalCharBudget)) {
      const fallbackMarker = truncateWithEllipsis(marker, resolved.totalCharBudget);
      if (!appendWithinBudget(entries, fallbackMarker, resolved.totalCharBudget)) {
        return {
          content: fallbackMarker,
          includedDocuments: 0,
          omittedDocuments,
          truncated: true,
        };
      }
    }
    truncated = true;
  }

  return {
    content: entries.join("\n"),
    includedDocuments,
    omittedDocuments,
    truncated,
  };
}

function renderDocumentEntry(
  document: DocumentContextItem,
  options: ResolvedDocumentContextPromptOptions,
): RenderedDocumentEntry {
  const normalizedName = sanitizeDocumentName(document.name);
  const normalizedText = normalizeDocumentText(document.text);
  const summary = summarizeDocumentText(normalizedText, options.summaryMaxChars);
  const chunks = splitTextIntoChunks(normalizedText, options.chunkMaxChars);
  const displayedChunks = options.maxChunksPerDocument <= 0 ? [] : chunks.slice(0, options.maxChunksPerDocument);
  const omittedChunks = Math.max(0, chunks.length - displayedChunks.length);
  const lines = [
    `- name=${normalizedName} format=${document.format} size=${document.sizeBytes}`,
    `  summary=${summary.value}`,
  ];

  for (let index = 0; index < displayedChunks.length; index += 1) {
    lines.push(`  chunk_${index + 1}:`);
    lines.push(indentMultiline(displayedChunks[index], "    "));
  }

  if (omittedChunks > 0) {
    lines.push(`  [truncated] omitted_chunks=${omittedChunks}`);
  }

  return {
    entry: lines.join("\n"),
    truncated: summary.truncated || omittedChunks > 0,
  };
}

function resolveOptions(options: DocumentContextPromptOptions): ResolvedDocumentContextPromptOptions {
  return {
    summaryMaxChars: toPositiveInt(options.summaryMaxChars, DEFAULT_DOCUMENT_CONTEXT_SUMMARY_MAX_CHARS),
    chunkMaxChars: toPositiveInt(options.chunkMaxChars, DEFAULT_DOCUMENT_CONTEXT_CHUNK_MAX_CHARS),
    maxChunksPerDocument: toNonNegativeInt(
      options.maxChunksPerDocument,
      DEFAULT_DOCUMENT_CONTEXT_MAX_CHUNKS_PER_DOCUMENT,
    ),
    totalCharBudget: toPositiveInt(options.totalCharBudget, DEFAULT_DOCUMENT_CONTEXT_TOTAL_CHAR_BUDGET),
    maxDocuments: toPositiveInt(options.maxDocuments, DEFAULT_DOCUMENT_CONTEXT_MAX_DOCUMENTS),
  };
}

function normalizeDocumentText(value: string): string {
  const normalized = value.replaceAll("\u0000", "").replace(/\r\n/g, "\n").trim();
  return normalized || "(empty)";
}

function summarizeDocumentText(value: string, maxChars: number): { value: string; truncated: boolean } {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return { value: "(empty)", truncated: false };
  }
  if (compact.length <= maxChars) {
    return { value: compact, truncated: false };
  }
  return {
    value: truncateWithEllipsis(compact, maxChars),
    truncated: true,
  };
}

function splitTextIntoChunks(value: string, maxChars: number): string[] {
  if (!value || value === "(empty)") {
    return [];
  }

  const segments = value
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const sourceSegments = segments.length > 0 ? segments : [value];
  const chunks: string[] = [];
  let currentChunk = "";

  for (const segment of sourceSegments) {
    if (segment.length > maxChars) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = "";
      }
      chunks.push(...splitLargeSegment(segment, maxChars));
      continue;
    }

    if (!currentChunk) {
      currentChunk = segment;
      continue;
    }

    if (currentChunk.length + 2 + segment.length <= maxChars) {
      currentChunk = `${currentChunk}\n\n${segment}`;
      continue;
    }

    chunks.push(currentChunk);
    currentChunk = segment;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function splitLargeSegment(segment: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < segment.length) {
    let end = Math.min(cursor + maxChars, segment.length);
    if (end < segment.length) {
      const window = segment.slice(cursor, end);
      const minBreakIndex = Math.floor(maxChars * MIN_BREAKPOINT_RATIO);
      const lastNewline = window.lastIndexOf("\n");
      const lastSpace = window.lastIndexOf(" ");
      const breakpoint = Math.max(lastNewline, lastSpace);
      if (breakpoint > minBreakIndex) {
        end = cursor + breakpoint;
      }
    }

    if (end <= cursor) {
      end = Math.min(cursor + maxChars, segment.length);
    }

    const chunk = segment.slice(cursor, end).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    cursor = end;
    while (cursor < segment.length && /\s/.test(segment[cursor] ?? "")) {
      cursor += 1;
    }
  }

  return chunks;
}

function sanitizeDocumentName(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const normalized = compact || "(unnamed)";
  return truncateWithEllipsis(normalized, DOCUMENT_NAME_MAX_CHARS);
}

function truncateWithEllipsis(value: string, maxChars: number): string {
  const limit = Math.max(1, Math.floor(maxChars));
  if (value.length <= limit) {
    return value;
  }
  if (limit <= 3) {
    return value.slice(0, limit);
  }
  return `${value.slice(0, limit - 3).trimEnd()}...`;
}

function appendWithinBudget(entries: string[], addition: string, maxChars: number): boolean {
  if (maxChars <= 0) {
    return false;
  }
  const candidate = entries.length === 0 ? addition : `${entries.join("\n")}\n${addition}`;
  if (candidate.length > maxChars) {
    return false;
  }
  entries.push(addition);
  return true;
}

function indentMultiline(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function toPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function toNonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}
