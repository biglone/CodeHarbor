import type { AutoDevTaskStatus } from "../workflow/autodev";

export const AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG = "[AUTODEV_SECONDARY_REVIEW_RECEIPT]";
export const AUTODEV_SECONDARY_REVIEW_RECEIPT_CLOSE_TAG = "[/AUTODEV_SECONDARY_REVIEW_RECEIPT]";

export type AutoDevSecondaryReviewDecision = "approved" | "changes_requested" | "blocked";

export interface AutoDevSecondaryReviewReceipt {
  taskId: string;
  decision: AutoDevSecondaryReviewDecision;
  summary: string | null;
  risks: string | null;
  nextAction: string | null;
  requestId: string | null;
  workflowDiagRunId: string | null;
  workdir: string | null;
}

export function buildAutoDevSecondaryReviewReceiptTemplate(input: {
  outputLanguage: "zh" | "en";
  taskId: string;
  requestId: string;
  workflowDiagRunId: string;
  workdir: string;
}): string {
  if (input.outputLanguage === "zh") {
    return [
      "请按以下结构化协议回复（请保留标签与字段名）：",
      AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG,
      `- task: ${input.taskId}`,
      "- decision: approved | changes_requested | blocked",
      "- summary: <一句话结论>",
      "- risks: <关键风险或 none>",
      "- next: <可执行下一步>",
      `- requestId: ${input.requestId}`,
      `- workflowDiagRunId: ${input.workflowDiagRunId}`,
      `- workdir: ${input.workdir}`,
      AUTODEV_SECONDARY_REVIEW_RECEIPT_CLOSE_TAG,
    ].join("\n");
  }
  return [
    "Reply with the structured protocol below (keep the tags and field names):",
    AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG,
    `- task: ${input.taskId}`,
    "- decision: approved | changes_requested | blocked",
    "- summary: <one-line conclusion>",
    "- risks: <key risk or none>",
    "- next: <actionable next step>",
    `- requestId: ${input.requestId}`,
    `- workflowDiagRunId: ${input.workflowDiagRunId}`,
    `- workdir: ${input.workdir}`,
    AUTODEV_SECONDARY_REVIEW_RECEIPT_CLOSE_TAG,
  ].join("\n");
}

export function parseAutoDevSecondaryReviewReceipt(text: string): AutoDevSecondaryReviewReceipt | null {
  const block = extractReceiptBlock(text);
  if (!block) {
    return null;
  }

  const fields = parseKeyValueFields(block);
  const taskId = compactNullableText(fields.task);
  const decision = normalizeDecision(fields.decision);
  if (!taskId || !decision) {
    return null;
  }

  return {
    taskId,
    decision,
    summary: compactNullableText(fields.summary),
    risks: compactNullableText(fields.risks),
    nextAction: compactNullableText(fields.next),
    requestId: compactNullableText(fields.requestid),
    workflowDiagRunId: compactNullableText(fields.workflowdiagrunid),
    workdir: compactNullableText(fields.workdir),
  };
}

export function matchesSecondaryReviewSender(senderId: string, configuredTarget: string): boolean {
  const normalizedSender = senderId.trim().toLowerCase();
  const normalizedTarget = configuredTarget.trim().toLowerCase();
  if (!normalizedSender || !normalizedTarget) {
    return false;
  }

  if (normalizedSender === normalizedTarget) {
    return true;
  }

  const senderLocalPart = extractLocalPart(normalizedSender);
  const targetLocalPart = extractLocalPart(normalizedTarget);
  if (!senderLocalPart || !targetLocalPart) {
    return false;
  }
  return senderLocalPart === targetLocalPart;
}

export function mapSecondaryReviewDecisionToTaskStatus(decision: AutoDevSecondaryReviewDecision): AutoDevTaskStatus {
  if (decision === "approved") {
    return "completed";
  }
  if (decision === "blocked") {
    return "blocked";
  }
  return "pending";
}

function extractReceiptBlock(text: string): string | null {
  const normalized = String(text ?? "");
  const openIndex = normalized.toLowerCase().indexOf(AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG.toLowerCase());
  if (openIndex < 0) {
    return null;
  }
  const fromOpen = normalized.slice(openIndex + AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG.length);
  const closeIndex = fromOpen.toLowerCase().indexOf(AUTODEV_SECONDARY_REVIEW_RECEIPT_CLOSE_TAG.toLowerCase());
  const block = closeIndex >= 0 ? fromOpen.slice(0, closeIndex) : fromOpen;
  const trimmed = block.trim();
  return trimmed || null;
}

function parseKeyValueFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = line.match(/^(?:[-*]\s*)?([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
    if (!match) {
      continue;
    }
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    if (!key || !value) {
      continue;
    }
    fields[key] = value;
  }
  return fields;
}

function normalizeDecision(raw: string | undefined): AutoDevSecondaryReviewDecision | null {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "approved" || normalized === "approve" || normalized === "pass") {
    return "approved";
  }
  if (
    normalized === "changes_requested" ||
    normalized === "changes-requested" ||
    normalized === "changes" ||
    normalized === "rework"
  ) {
    return "changes_requested";
  }
  if (normalized === "blocked" || normalized === "block") {
    return "blocked";
  }
  return null;
}

function compactNullableText(raw: string | undefined): string | null {
  const normalized = (raw ?? "").trim();
  if (!normalized || normalized.toLowerCase() === "none" || normalized.toLowerCase() === "n/a") {
    return null;
  }
  return normalized;
}

function extractLocalPart(mxidLike: string): string | null {
  const normalized = mxidLike.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith("@")) {
    const atDomain = normalized.indexOf(":");
    if (atDomain > 1) {
      return normalized.slice(0, atDomain);
    }
    return normalized;
  }
  if (normalized.includes(":")) {
    return `@${normalized.split(":")[0]}`;
  }
  return normalized.startsWith("@") ? normalized : `@${normalized}`;
}
