import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mammothExtractRawTextMock = vi.hoisted(() => vi.fn());

vi.mock("mammoth", () => ({
  default: {
    extractRawText: mammothExtractRawTextMock,
  },
}));

import {
  DEFAULT_DOCUMENT_MAX_BYTES,
  extractDocumentText,
  isSupportedDocumentAttachment,
  resolveDocumentFormat,
} from "../src/document-extractor";

describe("document-extractor", () => {
  beforeEach(() => {
    mammothExtractRawTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts txt document into plain text", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-doc-txt-"));
    const filePath = path.join(tempRoot, "notes.txt");
    await fs.writeFile(filePath, "line 1\r\nline 2", "utf8");

    try {
      const result = await extractDocumentText({
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: null,
        localPath: filePath,
      });

      expect(result).toMatchObject({
        ok: true,
        format: "txt",
        name: "notes.txt",
        text: "line 1\nline 2",
      });
      expect(mammothExtractRawTextMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("extracts pdf document via PDF parser", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-doc-pdf-"));
    const filePath = path.join(tempRoot, "report.pdf");
    await fs.writeFile(filePath, createMinimalPdfBuffer("pdf extracted content"));

    try {
      const result = await extractDocumentText({
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: null,
        localPath: filePath,
      });

      expect(result).toMatchObject({
        ok: true,
        format: "pdf",
      });
      if (result.ok) {
        expect(result.text).toContain("pdf extracted content");
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("extracts docx document via mammoth", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-doc-docx-"));
    const filePath = path.join(tempRoot, "spec.docx");
    await fs.writeFile(filePath, "fake-docx", "utf8");
    mammothExtractRawTextMock.mockResolvedValueOnce({
      value: "docx extracted content",
      messages: [],
    });

    try {
      const result = await extractDocumentText({
        name: "spec.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: null,
        localPath: filePath,
      });

      expect(result).toMatchObject({
        ok: true,
        format: "docx",
        text: "docx extracted content",
      });
      expect(mammothExtractRawTextMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsupported document type", async () => {
    const result = await extractDocumentText({
      name: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: 1024,
      localPath: "/tmp/notes.md",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "unsupported_type",
      format: null,
    });
  });

  it("rejects oversized document before parsing", async () => {
    const result = await extractDocumentText({
      name: "large.pdf",
      mimeType: "application/pdf",
      sizeBytes: DEFAULT_DOCUMENT_MAX_BYTES + 1,
      localPath: null,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "file_too_large",
      format: "pdf",
    });
  });

  it("rejects document when declared size is smaller but actual local file exceeds limit", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-doc-size-mismatch-"));
    const filePath = path.join(tempRoot, "mismatch.txt");
    await fs.writeFile(filePath, "0123456789", "utf8");

    try {
      const result = await extractDocumentText({
        name: "mismatch.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        localPath: filePath,
        maxBytes: 5,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "file_too_large",
        format: "txt",
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns parse_failed when parser throws", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeharbor-doc-failed-"));
    const filePath = path.join(tempRoot, "broken.pdf");
    await fs.writeFile(filePath, "broken", "utf8");

    try {
      const result = await extractDocumentText({
        name: "broken.pdf",
        mimeType: "application/pdf",
        sizeBytes: null,
        localPath: filePath,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "parse_failed",
        format: "pdf",
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("detects supported types by extension and mime", () => {
    expect(resolveDocumentFormat({ name: "a.txt", mimeType: null })).toBe("txt");
    expect(resolveDocumentFormat({ name: "a", mimeType: "application/pdf; charset=utf-8" })).toBe("pdf");
    expect(resolveDocumentFormat({ name: "a.docx", mimeType: null })).toBe("docx");
    expect(isSupportedDocumentAttachment({ name: "a.md", mimeType: "text/markdown" })).toBe(false);
  });
});

function createMinimalPdfBuffer(text: string): Buffer {
  const escapedText = escapePdfText(text);
  const stream = `BT\n/F1 16 Tf\n72 110 Td\n(${escapedText}) Tj\nET`;

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, "utf8"));
    body += object;
  }

  const xrefOffset = Buffer.byteLength(body, "utf8");
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i += 1) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, "utf8");
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
