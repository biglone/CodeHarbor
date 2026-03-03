export function extractCommandText(rawText: string, prefix: string): string | null {
  const incoming = rawText.trim();
  if (!incoming) {
    return null;
  }

  if (!prefix) {
    return incoming;
  }

  if (!incoming.startsWith(prefix)) {
    return null;
  }

  const nextChar = incoming.slice(prefix.length, prefix.length + 1);
  if (nextChar && !/\s/.test(nextChar)) {
    return null;
  }

  const stripped = incoming.slice(prefix.length).trim();
  return stripped.length > 0 ? stripped : null;
}

export function splitText(text: string, chunkSize: number): string[] {
  const clean = text.trim();
  if (!clean) {
    return [""];
  }
  if (chunkSize <= 0 || clean.length <= chunkSize) {
    return [clean];
  }

  const blocks = splitIntoBlocks(clean);
  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    if (block.length > chunkSize) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitOversizedBlock(block, chunkSize));
      continue;
    }

    if (!current) {
      current = block;
      continue;
    }

    const combined = `${current}\n\n${block}`;
    if (combined.length <= chunkSize) {
      current = combined;
      continue;
    }

    chunks.push(current);
    current = block;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitIntoBlocks(text: string): string[] {
  const blocks: string[] = [];
  const codeFenceRegex = /```[\s\S]*?```/g;
  let cursor = 0;

  for (const match of text.matchAll(codeFenceRegex)) {
    const index = match.index ?? 0;
    const before = text.slice(cursor, index);
    blocks.push(...splitParagraphs(before));

    const codeBlock = match[0]?.trim();
    if (codeBlock) {
      blocks.push(codeBlock);
    }

    cursor = index + (match[0]?.length ?? 0);
  }

  const remainder = text.slice(cursor);
  blocks.push(...splitParagraphs(remainder));

  return blocks.filter((entry) => entry.length > 0);
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function splitOversizedBlock(block: string, chunkSize: number): string[] {
  if (isFencedCodeBlock(block)) {
    return splitFencedCodeBlock(block, chunkSize);
  }
  return splitPlainText(block, chunkSize);
}

function isFencedCodeBlock(block: string): boolean {
  return block.startsWith("```") && block.endsWith("```");
}

function splitFencedCodeBlock(block: string, chunkSize: number): string[] {
  const lines = block.split("\n");
  if (lines.length < 2) {
    return splitPlainText(block, chunkSize);
  }

  const openingFence = lines[0];
  const closingFence = lines[lines.length - 1];
  if (!openingFence.startsWith("```") || closingFence !== "```") {
    return splitPlainText(block, chunkSize);
  }

  const maxBodySize = chunkSize - openingFence.length - closingFence.length - 2;
  if (maxBodySize <= 20) {
    return splitPlainText(block, chunkSize);
  }

  const body = lines.slice(1, -1).join("\n");
  const bodyParts = splitPlainText(body, maxBodySize);
  if (bodyParts.length === 0) {
    return [block];
  }

  return bodyParts.map((part) => `${openingFence}\n${part}\n${closingFence}`);
}

function splitPlainText(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > chunkSize) {
    const candidate = remaining.slice(0, chunkSize);
    const breakIndex = findBreakIndex(candidate);
    const splitAt = breakIndex > 0 ? breakIndex : chunkSize;
    const head = remaining.slice(0, splitAt).trim();
    if (head) {
      chunks.push(head);
    }
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [text.slice(0, chunkSize)];
}

function findBreakIndex(candidate: string): number {
  const newline = candidate.lastIndexOf("\n");
  if (newline >= Math.floor(candidate.length * 0.5)) {
    return newline;
  }

  const whitespace = candidate.search(/\s[^\s]*$/);
  if (whitespace >= Math.floor(candidate.length * 0.5)) {
    return whitespace;
  }

  return -1;
}
