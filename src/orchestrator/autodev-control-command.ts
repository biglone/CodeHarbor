import type { InboundMessage } from "../types";
import type { OutputLanguage } from "../config";
import { byOutputLanguage } from "./output-language";

interface RoleSkillStatusLike {
  enabled: boolean;
  mode: string;
  maxChars: number;
  roots: string;
  override: string;
  loaded: string;
}

export interface AutoDevControlCommandDeps {
  autoDevDetailedProgressDefaultEnabled: boolean;
  outputLanguage: OutputLanguage;
  pendingAutoDevLoopStopRequests: Set<string>;
  activeAutoDevLoopSessions: Set<string>;
  isAutoDevDetailedProgressEnabled: (sessionKey: string) => boolean;
  setAutoDevDetailedProgressEnabled: (sessionKey: string, enabled: boolean) => void;
  setWorkflowRoleSkillPolicyOverride: (
    sessionKey: string,
    next: { enabled?: boolean; mode?: "summary" | "progressive" | "full" },
  ) => void;
  buildWorkflowRoleSkillStatus: (sessionKey: string) => RoleSkillStatusLike;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

interface AutoDevControlCommandInput {
  sessionKey: string;
  message: InboundMessage;
}

export async function handleAutoDevProgressCommand(
  deps: AutoDevControlCommandDeps,
  input: AutoDevControlCommandInput & { mode: "status" | "on" | "off" },
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  const current = deps.isAutoDevDetailedProgressEnabled(input.sessionKey) ? "on" : "off";
  const defaultMode = deps.autoDevDetailedProgressDefaultEnabled ? "on" : "off";
  if (input.mode === "status") {
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        `[CodeHarbor] AutoDev 过程回显设置
- detailedProgress: ${current}
- default: ${defaultMode}
- usage: /autodev progress on|off|status`,
        `[CodeHarbor] AutoDev progress echo settings
- detailedProgress: ${current}
- default: ${defaultMode}
- usage: /autodev progress on|off|status`,
      ),
    );
    return;
  }

  const enabled = input.mode === "on";
  deps.setAutoDevDetailedProgressEnabled(input.sessionKey, enabled);
  await deps.sendNotice(
    input.message.conversationId,
    localize(
      `[CodeHarbor] AutoDev 过程回显已更新
- detailedProgress: ${enabled ? "on" : "off"}
- default: ${defaultMode}
- session: ${input.sessionKey}`,
      `[CodeHarbor] AutoDev progress echo updated
- detailedProgress: ${enabled ? "on" : "off"}
- default: ${defaultMode}
- session: ${input.sessionKey}`,
    ),
  );
}

export async function handleAutoDevSkillsCommand(
  deps: AutoDevControlCommandDeps,
  input: AutoDevControlCommandInput & { mode: "status" | "on" | "off" | "summary" | "progressive" | "full" },
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  if (input.mode !== "status") {
    if (input.mode === "on") {
      deps.setWorkflowRoleSkillPolicyOverride(input.sessionKey, {
        enabled: true,
      });
    } else if (input.mode === "off") {
      deps.setWorkflowRoleSkillPolicyOverride(input.sessionKey, {
        enabled: false,
      });
    } else {
      deps.setWorkflowRoleSkillPolicyOverride(input.sessionKey, {
        enabled: true,
        mode: input.mode,
      });
    }
  }

  const roleSkillStatus = deps.buildWorkflowRoleSkillStatus(input.sessionKey);
  await deps.sendNotice(
    input.message.conversationId,
    localize(
      `[CodeHarbor] AutoDev 角色技能设置
- enabled: ${roleSkillStatus.enabled ? "on" : "off"}
- mode: ${roleSkillStatus.mode}
- maxChars: ${roleSkillStatus.maxChars}
- roots: ${roleSkillStatus.roots}
- override: ${roleSkillStatus.override}
- loaded: ${roleSkillStatus.loaded}
- usage: /autodev skills on|off|summary|progressive|full|status`,
      `[CodeHarbor] AutoDev role skill settings
- enabled: ${roleSkillStatus.enabled ? "on" : "off"}
- mode: ${roleSkillStatus.mode}
- maxChars: ${roleSkillStatus.maxChars}
- roots: ${roleSkillStatus.roots}
- override: ${roleSkillStatus.override}
- loaded: ${roleSkillStatus.loaded}
- usage: /autodev skills on|off|summary|progressive|full|status`,
    ),
  );
}

export async function handleAutoDevLoopStopCommand(
  deps: AutoDevControlCommandDeps,
  input: AutoDevControlCommandInput,
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  if (!deps.activeAutoDevLoopSessions.has(input.sessionKey)) {
    await deps.sendNotice(
      input.message.conversationId,
      localize("[CodeHarbor] 当前没有运行中的 AutoDev 循环任务。", "[CodeHarbor] No running AutoDev loop task."),
    );
    return;
  }
  if (deps.pendingAutoDevLoopStopRequests.has(input.sessionKey)) {
    await deps.sendNotice(
      input.message.conversationId,
      localize(
        "[CodeHarbor] 已收到停止请求：当前任务完成后会停止循环，不会启动下一任务。",
        "[CodeHarbor] Stop request already received: loop will stop after current task and will not start next task.",
      ),
    );
    return;
  }

  deps.pendingAutoDevLoopStopRequests.add(input.sessionKey);
  await deps.sendNotice(
    input.message.conversationId,
    localize(
      "[CodeHarbor] 已收到停止请求：将等待当前任务执行完成后停止 AutoDev 循环。",
      "[CodeHarbor] Stop request received: AutoDev loop will stop after current task completes.",
    ),
  );
}
