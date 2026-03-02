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

  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += chunkSize) {
    chunks.push(clean.slice(i, i + chunkSize));
  }
  return chunks;
}
