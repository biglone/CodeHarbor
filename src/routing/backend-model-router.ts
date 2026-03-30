export type BackendModelRouteProvider = "codex" | "claude" | "gemini";

export type BackendModelRouteTaskType =
  | "chat"
  | "workflow_run"
  | "workflow_status"
  | "autodev_run"
  | "autodev_status"
  | "autodev_stop"
  | "control_command";

export interface BackendModelRouteMatchCondition {
  roomIds?: string[];
  senderIds?: string[];
  taskTypes?: BackendModelRouteTaskType[];
  directMessage?: boolean;
  textIncludes?: string[];
  textRegex?: string;
}

export interface BackendModelRouteTarget {
  provider?: BackendModelRouteProvider;
  model?: string | null;
}

export interface BackendModelRouteRule {
  id: string;
  enabled: boolean;
  priority: number;
  when: BackendModelRouteMatchCondition;
  target: BackendModelRouteTarget;
}

export interface BackendModelRouteProfile {
  provider: BackendModelRouteProvider;
  model: string | null;
}

export interface BackendModelRouteInput {
  roomId: string;
  senderId: string;
  taskType: BackendModelRouteTaskType;
  directMessage: boolean;
  text: string;
}

export interface BackendModelRouteDecision {
  profile: BackendModelRouteProfile;
  source: "rule" | "default";
  reasonCode: "rule_match" | "default_fallback";
  ruleId: string | null;
}

interface CompiledRule {
  index: number;
  id: string;
  enabled: boolean;
  priority: number;
  when: BackendModelRouteMatchCondition;
  target: BackendModelRouteTarget;
  textRegex: RegExp | null;
}

export class BackendModelRouter {
  private readonly rules: CompiledRule[];

  constructor(rules: BackendModelRouteRule[]) {
    this.rules = rules
      .map((rule, index) => ({
        index,
        id: rule.id,
        enabled: rule.enabled,
        priority: rule.priority,
        when: rule.when,
        target: rule.target,
        textRegex: compileTextRegex(rule.when.textRegex, rule.id),
      }))
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return right.priority - left.priority;
        }
        return left.index - right.index;
      });
  }

  hasRules(): boolean {
    return this.rules.some((rule) => rule.enabled);
  }

  getStats(): { total: number; enabled: number } {
    let enabled = 0;
    for (const rule of this.rules) {
      if (rule.enabled) {
        enabled += 1;
      }
    }
    return {
      total: this.rules.length,
      enabled,
    };
  }

  resolve(input: BackendModelRouteInput, fallback: BackendModelRouteProfile): BackendModelRouteDecision {
    const normalizedFallback = normalizeBackendModelRouteProfile(fallback);
    for (const rule of this.rules) {
      if (!rule.enabled) {
        continue;
      }
      if (!matchRule(rule, input)) {
        continue;
      }

      const provider = rule.target.provider ?? normalizedFallback.provider;
      let model: string | null;
      if (rule.target.model !== undefined) {
        model = normalizeModel(rule.target.model);
      } else if (provider === normalizedFallback.provider) {
        model = normalizedFallback.model;
      } else {
        model = null;
      }
      return {
        profile: { provider, model },
        source: "rule",
        reasonCode: "rule_match",
        ruleId: rule.id,
      };
    }

    return {
      profile: normalizedFallback,
      source: "default",
      reasonCode: "default_fallback",
      ruleId: null,
    };
  }
}

function compileTextRegex(raw: string | undefined, ruleId: string): RegExp | null {
  const normalized = raw?.trim();
  if (!normalized) {
    return null;
  }
  try {
    return new RegExp(normalized, "i");
  } catch {
    throw new Error(`BACKEND_MODEL_ROUTING_RULES_JSON[${ruleId}].when.textRegex must be a valid regex.`);
  }
}

function matchRule(rule: CompiledRule, input: BackendModelRouteInput): boolean {
  const { when } = rule;
  if (when.roomIds && when.roomIds.length > 0 && !when.roomIds.includes(input.roomId)) {
    return false;
  }
  if (when.senderIds && when.senderIds.length > 0 && !when.senderIds.includes(input.senderId)) {
    return false;
  }
  if (when.taskTypes && when.taskTypes.length > 0 && !when.taskTypes.includes(input.taskType)) {
    return false;
  }
  if (typeof when.directMessage === "boolean" && when.directMessage !== input.directMessage) {
    return false;
  }

  const normalizedText = input.text.toLowerCase();
  if (when.textIncludes && when.textIncludes.length > 0) {
    const matched = when.textIncludes.some((keyword) => normalizedText.includes(keyword.toLowerCase()));
    if (!matched) {
      return false;
    }
  }

  if (rule.textRegex && !rule.textRegex.test(input.text)) {
    return false;
  }

  return true;
}

function normalizeModel(model: string | null | undefined): string | null {
  if (typeof model !== "string") {
    return null;
  }
  const normalized = model.trim();
  return normalized ? normalized : null;
}

export function normalizeBackendModelRouteProfile(profile: BackendModelRouteProfile): BackendModelRouteProfile {
  return {
    provider: profile.provider,
    model: normalizeModel(profile.model),
  };
}
