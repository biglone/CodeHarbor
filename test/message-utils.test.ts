import { describe, expect, it } from "vitest";

import { extractCommandText, splitText } from "../src/utils/message";

describe("extractCommandText", () => {
  it("extracts command body when prefix matches", () => {
    expect(extractCommandText("!code explain this", "!code")).toBe("explain this");
  });

  it("returns null when prefix does not match", () => {
    expect(extractCommandText("hello", "!code")).toBeNull();
  });

  it("returns null when message only starts with prefix token", () => {
    expect(extractCommandText("!codefix this", "!code")).toBeNull();
  });

  it("accepts all text when prefix is empty", () => {
    expect(extractCommandText(" hello ", "")).toBe("hello");
  });
});

describe("splitText", () => {
  it("splits long plain text by chunk size", () => {
    expect(splitText("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });

  it("preserves fenced code block boundaries when possible", () => {
    const text = [
      "intro paragraph",
      "",
      "```ts",
      "console.log('hello')",
      "console.log('world')",
      "```",
      "",
      "tail paragraph",
    ].join("\n");

    const chunks = splitText(text, 80);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.some((chunk) => chunk.includes("```ts") && chunk.includes("console.log('world')"))).toBe(true);
    for (const chunk of chunks) {
      const fenceCount = (chunk.match(/```/g) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  it("splits oversized fenced code blocks into valid fenced chunks", () => {
    const lines = Array.from({ length: 20 }, (_, idx) => `line_${idx}`).join("\n");
    const text = `\`\`\`text\n${lines}\n\`\`\``;

    const chunks = splitText(text, 70);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith("```text\n")).toBe(true);
      expect(chunk.endsWith("\n```")).toBe(true);
    }
  });
});
