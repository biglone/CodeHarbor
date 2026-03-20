interface ConversationMessageLike {
  role: "user" | "assistant";
  provider: string;
  content: string;
}

interface BuildConversationBridgeContextInput {
  messages: ConversationMessageLike[];
  maxChars: number;
}

export function buildConversationBridgeContext(input: BuildConversationBridgeContextInput): string | null {
  if (input.messages.length === 0) {
    return null;
  }

  const lines = input.messages
    .map((message) => {
      const role = message.role === "user" ? "user" : "assistant";
      const compact = message.content.replace(/\s+/g, " ").trim();
      const truncated = compact.length > 1_000 ? `${compact.slice(0, 1000)}...` : compact;
      return `- [${message.provider}] ${role}: ${truncated}`;
    })
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const selected: string[] = [];
  let usedChars = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (usedChars + line.length + 1 > input.maxChars) {
      continue;
    }
    selected.push(line);
    usedChars += line.length + 1;
  }
  if (selected.length === 0) {
    return null;
  }
  selected.reverse();

  return [
    "[conversation_bridge]",
    "The following local chat history is from the same conversation before backend switch. Use it as context.",
    "Do not reprint full history unless user asks.",
    ...selected,
    "[/conversation_bridge]",
  ].join("\n");
}
