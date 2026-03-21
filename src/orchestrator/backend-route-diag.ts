import type { BackendModelRouteProfile, BackendModelRouteTaskType } from "../routing/backend-model-router";
import type { InboundMessage } from "../types";

export interface BackendRouteDiagRecord {
  at: string;
  sessionKey: string;
  conversationId: string;
  senderId: string;
  taskType: BackendModelRouteTaskType;
  source: "manual_override" | "rule" | "default";
  reasonCode: "manual_override" | "rule_match" | "default_fallback" | "factory_unavailable";
  ruleId: string | null;
  profile: BackendModelRouteProfile;
}

interface RecordBackendRouteDecisionInput {
  sessionKey: string;
  message: InboundMessage;
  taskType: BackendModelRouteTaskType;
  decision: {
    source: BackendRouteDiagRecord["source"];
    reasonCode: BackendRouteDiagRecord["reasonCode"];
    ruleId: string | null;
    profile: BackendModelRouteProfile;
  };
}

export function recordBackendRouteDecision(
  records: BackendRouteDiagRecord[],
  input: RecordBackendRouteDecisionInput,
  maxEntries: number,
): void {
  records.push({
    at: new Date().toISOString(),
    sessionKey: input.sessionKey,
    conversationId: input.message.conversationId,
    senderId: input.message.senderId,
    taskType: input.taskType,
    source: input.decision.source,
    reasonCode: input.decision.reasonCode,
    ruleId: input.decision.ruleId,
    profile: input.decision.profile,
  });
  if (records.length > maxEntries) {
    records.splice(0, records.length - maxEntries);
  }
}

export function listBackendRouteDiagRecords(
  records: BackendRouteDiagRecord[],
  limit: number,
  sessionKey: string,
): BackendRouteDiagRecord[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  const scoped = records.filter((record) => record.sessionKey === sessionKey);
  return scoped.slice(Math.max(0, scoped.length - safeLimit)).reverse();
}
