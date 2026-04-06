export type AutoDevControlResponseKind = "success" | "error" | "validation_error";

interface AutoDevControlEnvelopeInput {
  text: string;
  kind: AutoDevControlResponseKind;
  code: string;
  next?: string | null;
}

export function withAutoDevControlEnvelope(input: AutoDevControlEnvelopeInput): string {
  const normalized = input.text.trim();
  if (!normalized) {
    return [
      "[CodeHarbor] AutoDev control response",
      `- status: ${input.kind}`,
      `- code: ${input.code}`,
      ...(input.next ? [`- next: ${input.next}`] : []),
    ].join("\n");
  }

  const lines = normalized.split(/\r?\n/);
  const firstLine = lines[0] ?? "[CodeHarbor] AutoDev control response";
  const rest = lines.slice(1);
  const envelope = [firstLine, `- status: ${input.kind}`, `- code: ${input.code}`, ...rest];
  if (input.next) {
    envelope.push(`- next: ${input.next}`);
  }
  return envelope.join("\n");
}
