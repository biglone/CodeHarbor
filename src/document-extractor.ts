import fs from "node:fs/promises";
import path from "node:path";

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export type SupportedDocumentFormat = "txt" | "pdf" | "docx";

export type DocumentExtractFailureReason =
  | "unsupported_type"
  | "file_too_large"
  | "missing_local_path"
  | "read_failed"
  | "parse_failed";

export interface DocumentExtractInput {
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  localPath: string | null;
  maxBytes?: number;
}

export interface DocumentExtractSuccess {
  ok: true;
  format: SupportedDocumentFormat;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  text: string;
}

export interface DocumentExtractFailure {
  ok: false;
  reason: DocumentExtractFailureReason;
  format: SupportedDocumentFormat | null;
  name: string;
  message: string;
}

export type DocumentExtractResult = DocumentExtractSuccess | DocumentExtractFailure;

export const DEFAULT_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_ALLOWED_EXTENSIONS = [".txt", ".pdf", ".docx"] as const;
export const DOCUMENT_ALLOWED_MIME_TYPES = [
  "text/plain",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

const EXTENSION_TO_FORMAT: Readonly<Record<string, SupportedDocumentFormat>> = {
  ".txt": "txt",
  ".pdf": "pdf",
  ".docx": "docx",
};

const MIME_TO_FORMAT: Readonly<Record<string, SupportedDocumentFormat>> = {
  "text/plain": "txt",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

export function resolveDocumentFormat(input: { name: string; mimeType: string | null }): SupportedDocumentFormat | null {
  const normalizedMimeType = normalizeMimeType(input.mimeType);
  if (normalizedMimeType && MIME_TO_FORMAT[normalizedMimeType]) {
    return MIME_TO_FORMAT[normalizedMimeType];
  }

  const extension = path.extname(input.name).trim().toLowerCase();
  if (extension && EXTENSION_TO_FORMAT[extension]) {
    return EXTENSION_TO_FORMAT[extension];
  }
  return null;
}

export function isSupportedDocumentAttachment(input: { name: string; mimeType: string | null }): boolean {
  return resolveDocumentFormat(input) !== null;
}

export async function extractDocumentText(input: DocumentExtractInput): Promise<DocumentExtractResult> {
  const format = resolveDocumentFormat({
    name: input.name,
    mimeType: input.mimeType,
  });
  if (!format) {
    return {
      ok: false,
      reason: "unsupported_type",
      format: null,
      name: input.name,
      message: "Unsupported document type.",
    };
  }

  const maxBytes = Math.max(1, input.maxBytes ?? DEFAULT_DOCUMENT_MAX_BYTES);
  if (input.sizeBytes !== null && input.sizeBytes > maxBytes) {
    return {
      ok: false,
      reason: "file_too_large",
      format,
      name: input.name,
      message: `File exceeds max bytes limit (${maxBytes}).`,
    };
  }

  const localPath = input.localPath?.trim() ?? "";
  if (!localPath) {
    return {
      ok: false,
      reason: "missing_local_path",
      format,
      name: input.name,
      message: "Attachment was not downloaded to local path.",
    };
  }

  const sizeBytesResult = await resolveFileSizeBytes(input.sizeBytes, localPath);
  if (!sizeBytesResult.ok) {
    return {
      ok: false,
      reason: "read_failed",
      format,
      name: input.name,
      message: sizeBytesResult.message,
    };
  }
  if (sizeBytesResult.effectiveSizeBytes > maxBytes) {
    return {
      ok: false,
      reason: "file_too_large",
      format,
      name: input.name,
      message: `File exceeds max bytes limit (${maxBytes}).`,
    };
  }

  try {
    const rawText = await readDocumentAsText(format, localPath);
    const normalizedText = normalizeExtractedText(rawText);
    if (!normalizedText) {
      return {
        ok: false,
        reason: "parse_failed",
        format,
        name: input.name,
        message: "Document content is empty after extraction.",
      };
    }
    return {
      ok: true,
      format,
      name: input.name,
      mimeType: normalizeMimeType(input.mimeType),
      sizeBytes: sizeBytesResult.actualSizeBytes,
      text: normalizedText,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "parse_failed",
      format,
      name: input.name,
      message: formatError(error),
    };
  }
}

function normalizeMimeType(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || null;
}

async function resolveFileSizeBytes(
  declaredSizeBytes: number | null,
  localPath: string,
): Promise<
  | { ok: true; actualSizeBytes: number; effectiveSizeBytes: number }
  | { ok: false; message: string }
> {
  try {
    const stat = await fs.stat(localPath);
    const actualSizeBytes = stat.size;
    const effectiveSizeBytes = declaredSizeBytes === null ? actualSizeBytes : Math.max(declaredSizeBytes, actualSizeBytes);
    return { ok: true, actualSizeBytes, effectiveSizeBytes };
  } catch (error) {
    return {
      ok: false,
      message: `Failed to read file metadata: ${formatError(error)}`,
    };
  }
}

async function readDocumentAsText(format: SupportedDocumentFormat, localPath: string): Promise<string> {
  if (format === "txt") {
    return fs.readFile(localPath, "utf8");
  }

  if (format === "pdf") {
    const fileBytes = await fs.readFile(localPath);
    const parser = new PDFParse({ data: fileBytes });
    try {
      const result = await parser.getText();
      return result.text ?? "";
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  const result = await mammoth.extractRawText({ path: localPath });
  return result.value;
}

function normalizeExtractedText(value: string): string {
  return value.replaceAll("\u0000", "").replace(/\r\n/g, "\n").trim();
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
