import type { BackendModelRouteProfile } from "../routing/backend-model-router";
import type { InboundMessage } from "../types";
import { isSameBackendProfile, parseBackendTarget } from "./command-routing";
import { describeBackendRouteReason, isBackendRouteFallbackReason } from "./diagnostic-formatters";

interface SessionBackendOverrideLike {
  profile: BackendModelRouteProfile;
  updatedAt: number;
}

interface SessionBackendDecisionLike {
  profile: BackendModelRouteProfile;
  source: "manual_override" | "rule" | "default";
  reasonCode: "manual_override" | "rule_match" | "default_fallback" | "factory_unavailable";
  ruleId: string | null;
}

interface StateStoreLike {
  clearCodexSessionId: (sessionKey: string) => void;
  activateSession: (sessionKey: string, activeWindowMs: number) => void;
}

interface HandleBackendCommandDeps {
  sessionActiveWindowMs: number;
  canCreateBackendRuntime: boolean;
  sessionBackendOverrides: Map<string, SessionBackendOverrideLike>;
  sessionBackendProfiles: Map<string, BackendModelRouteProfile>;
  sessionLastBackendDecisions: Map<string, SessionBackendDecisionLike>;
  workflowSnapshots: Map<string, unknown>;
  autoDevSnapshots: Map<string, unknown>;
  runningExecutions: Map<string, unknown>;
  stateStore: StateStoreLike;
  resolveSessionBackendStatusProfile: (sessionKey: string) => BackendModelRouteProfile;
  formatBackendToolLabel: (profile: BackendModelRouteProfile) => string;
  resolveManualBackendProfile: (input: {
    provider: "codex" | "claude";
    model?: string | null;
  }) => BackendModelRouteProfile;
  serializeBackendProfile: (profile: BackendModelRouteProfile) => string;
  hasBackendRuntime: (profile: BackendModelRouteProfile) => boolean;
  ensureBackendRuntime: (profile: BackendModelRouteProfile) => void;
  clearSessionFromAllRuntimes: (sessionKey: string) => void;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

interface HandleBackendCommandInput {
  sessionKey: string;
  message: InboundMessage;
}

export async function handleBackendCommand(
  deps: HandleBackendCommandDeps,
  input: HandleBackendCommandInput,
): Promise<void> {
  const target = parseBackendTarget(input.message.text);
  const manualOverride = deps.sessionBackendOverrides.get(input.sessionKey);
  const statusProfile = deps.resolveSessionBackendStatusProfile(input.sessionKey);
  if (!target || target.kind === "status") {
    const mode = manualOverride ? "manual" : "auto";
    const decision = deps.sessionLastBackendDecisions.get(input.sessionKey);
    const rawReason = manualOverride ? "manual_override" : decision?.reasonCode ?? "default_fallback";
    const reason = !manualOverride && rawReason === "manual_override" ? "default_fallback" : rawReason;
    const rule = !manualOverride && rawReason === "manual_override" ? "none" : decision?.ruleId ?? "none";
    const reasonDesc = describeBackendRouteReason(reason);
    const fallback = isBackendRouteFallbackReason(reason) ? "yes" : "no";
    await deps.sendNotice(
      input.message.conversationId,
      `[CodeHarbor] 当前后端工具: ${deps.formatBackendToolLabel(statusProfile)}\n路由模式: ${mode}\n命中原因: ${reason}\n原因说明: ${reasonDesc}\n命中规则: ${rule}\n是否回退: ${fallback}\n可用命令: /backend codex [model] | /backend claude [model] | /backend auto | /backend status`,
    );
    return;
  }

  if (target.kind === "auto") {
    if (!manualOverride) {
      await deps.sendNotice(input.message.conversationId, "[CodeHarbor] 当前已经处于自动路由模式。");
      return;
    }
    if (deps.runningExecutions.has(input.sessionKey)) {
      await deps.sendNotice(
        input.message.conversationId,
        "[CodeHarbor] 检测到当前会话仍有运行中任务，请等待任务完成后再切换后端工具。",
      );
      return;
    }
    deps.sessionBackendOverrides.delete(input.sessionKey);
    deps.sessionLastBackendDecisions.delete(input.sessionKey);
    deps.stateStore.clearCodexSessionId(input.sessionKey);
    deps.stateStore.activateSession(input.sessionKey, deps.sessionActiveWindowMs);
    deps.clearSessionFromAllRuntimes(input.sessionKey);
    deps.sessionBackendProfiles.delete(input.sessionKey);
    deps.workflowSnapshots.delete(input.sessionKey);
    deps.autoDevSnapshots.delete(input.sessionKey);
    await deps.sendNotice(
      input.message.conversationId,
      "[CodeHarbor] 已恢复自动路由模式。下一个请求会自动注入最近本地会话历史作为桥接上下文。",
    );
    return;
  }

  const targetProfile = deps.resolveManualBackendProfile(target.profile);
  if (
    manualOverride &&
    deps.serializeBackendProfile(manualOverride.profile) === deps.serializeBackendProfile(targetProfile)
  ) {
    await deps.sendNotice(
      input.message.conversationId,
      `[CodeHarbor] 后端工具已是 ${deps.formatBackendToolLabel(targetProfile)}（manual）。`,
    );
    return;
  }

  if (!manualOverride && isSameBackendProfile(statusProfile, targetProfile)) {
    deps.sessionBackendOverrides.set(input.sessionKey, {
      profile: targetProfile,
      updatedAt: Date.now(),
    });
    deps.sessionBackendProfiles.set(input.sessionKey, targetProfile);
    deps.sessionLastBackendDecisions.set(input.sessionKey, {
      profile: targetProfile,
      source: "manual_override",
      reasonCode: "manual_override",
      ruleId: null,
    });
    deps.stateStore.activateSession(input.sessionKey, deps.sessionActiveWindowMs);
    await deps.sendNotice(
      input.message.conversationId,
      `[CodeHarbor] 已固定当前后端工具为 ${deps.formatBackendToolLabel(targetProfile)}（manual）。当前会话保持不变。`,
    );
    return;
  }

  if (!deps.canCreateBackendRuntime && !deps.hasBackendRuntime(targetProfile)) {
    await deps.sendNotice(
      input.message.conversationId,
      "[CodeHarbor] 当前运行模式不支持会话内切换后端，请修改 .env 后重启服务。",
    );
    return;
  }
  if (deps.runningExecutions.has(input.sessionKey)) {
    await deps.sendNotice(
      input.message.conversationId,
      "[CodeHarbor] 检测到当前会话仍有运行中任务，请等待任务完成后再切换后端工具。",
    );
    return;
  }

  deps.ensureBackendRuntime(targetProfile);
  deps.sessionBackendOverrides.set(input.sessionKey, {
    profile: targetProfile,
    updatedAt: Date.now(),
  });
  deps.sessionBackendProfiles.set(input.sessionKey, targetProfile);
  deps.sessionLastBackendDecisions.set(input.sessionKey, {
    profile: targetProfile,
    source: "manual_override",
    reasonCode: "manual_override",
    ruleId: null,
  });
  deps.stateStore.clearCodexSessionId(input.sessionKey);
  deps.stateStore.activateSession(input.sessionKey, deps.sessionActiveWindowMs);
  deps.clearSessionFromAllRuntimes(input.sessionKey);
  deps.workflowSnapshots.delete(input.sessionKey);
  deps.autoDevSnapshots.delete(input.sessionKey);

  await deps.sendNotice(
    input.message.conversationId,
    `[CodeHarbor] 已切换后端工具为 ${deps.formatBackendToolLabel(targetProfile)}（manual）。下一个请求会自动注入最近本地会话历史作为桥接上下文。`,
  );
}
