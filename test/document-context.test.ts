import { describe, expect, it } from "vitest";

import { buildDocumentContextPrompt } from "../src/document-context";

describe("document-context", () => {
  it("chunks long documents and emits truncation markers", () => {
    const tailMarker = "TAIL_MARKER_SHOULD_NOT_BE_INCLUDED";
    const longText = `${"段落A ".repeat(500)}\n\n${"段落B ".repeat(500)}\n\n${tailMarker}`;

    const result = buildDocumentContextPrompt(
      [
        {
          name: "long-plan.txt",
          format: "txt",
          sizeBytes: 4096,
          text: longText,
        },
      ],
      {
        summaryMaxChars: 120,
        chunkMaxChars: 200,
        maxChunksPerDocument: 2,
        totalCharBudget: 2000,
      },
    );

    expect(result.content).toContain("summary=");
    expect(result.content).toContain("chunk_1:");
    expect(result.content).toContain("chunk_2:");
    expect(result.content).toContain("[truncated] omitted_chunks=");
    expect(result.content).not.toContain(tailMarker);
    expect(result.truncated).toBe(true);
  });

  it("caps global budget and marks omitted documents", () => {
    const result = buildDocumentContextPrompt(
      [
        {
          name: "a.txt",
          format: "txt",
          sizeBytes: 1024,
          text: "A".repeat(800),
        },
        {
          name: "b.txt",
          format: "txt",
          sizeBytes: 1024,
          text: "B".repeat(800),
        },
        {
          name: "c.txt",
          format: "txt",
          sizeBytes: 1024,
          text: "C".repeat(800),
        },
      ],
      {
        summaryMaxChars: 120,
        chunkMaxChars: 300,
        maxChunksPerDocument: 2,
        totalCharBudget: 420,
      },
    );

    expect(result.content).toContain("[truncated] omitted_documents=");
    expect(result.omittedDocuments).toBeGreaterThan(0);
    expect(result.content.length).toBeLessThanOrEqual(420);
    expect(result.truncated).toBe(true);
  });

  it("keeps short documents readable", () => {
    const result = buildDocumentContextPrompt([
      {
        name: "brief.txt",
        format: "txt",
        sizeBytes: 64,
        text: "第一行\n第二行",
      },
    ]);

    expect(result.content).toContain("name=brief.txt format=txt size=64");
    expect(result.content).toContain("summary=第一行 第二行");
    expect(result.content).toContain("chunk_1:");
    expect(result.content).toContain("第一行");
    expect(result.content).toContain("第二行");
    expect(result.content).not.toContain("omitted_documents=");
    expect(result.truncated).toBe(false);
  });
});
