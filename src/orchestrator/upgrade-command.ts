import type { Mutex } from "async-mutex";

import type { Logger } from "../logger";
import type { OutputLanguage } from "../config";
import type { InboundMessage } from "../types";
import { buildUpgradeRecoveryAdvice, type UpgradeRecoveryAdvice } from "../upgrade-platform";
import { parseUpgradeTarget } from "./command-routing";
import { formatDurationMs } from "./helpers";
import { byOutputLanguage } from "./output-language";
import {
  evaluateUpgradePostCheck,
  formatSelfUpdateError,
  type SelfUpdateResult,
  type UpgradeRestartPlan,
  type UpgradeVersionProbeResult,
} from "./upgrade-utils";

interface HandleUpgradeCommandDeps {
  logger: Logger;
  outputLanguage: OutputLanguage;
  botNoticePrefix: string;
  upgradeMutex: Mutex;
  authorizeUpgradeRequest: (message: InboundMessage) => { allowed: true } | { allowed: false; reason: string };
  acquireUpgradeExecutionLock: () => { acquired: boolean; owner: string | null; expiresAt: number | null };
  releaseUpgradeExecutionLock: () => void;
  createUpgradeRun: (requestedBy: string, targetVersion: string | null) => number | null;
  finishUpgradeRun: (
    runId: number | null,
    input: { status: "succeeded" | "failed"; installedVersion: string | null; error: string | null },
  ) => void;
  selfUpdateRunner: (input: { version: string | null }) => Promise<SelfUpdateResult>;
  upgradeRestartPlanner: () => Promise<UpgradeRestartPlan>;
  upgradeVersionProbe: () => Promise<UpgradeVersionProbeResult>;
  sendNotice: (conversationId: string, text: string) => Promise<void>;
}

export async function handleUpgradeCommand(
  deps: HandleUpgradeCommandDeps,
  message: InboundMessage,
): Promise<void> {
  const localize = (zh: string, en: string): string => byOutputLanguage(deps.outputLanguage, zh, en);
  const auth = deps.authorizeUpgradeRequest(message);
  if (!auth.allowed) {
    await deps.sendNotice(message.conversationId, `[CodeHarbor] ${localizeUpgradeAuthReason(auth.reason, deps.outputLanguage)}`);
    return;
  }

  const parsed = parseUpgradeTarget(message.text);
  if (!parsed.ok) {
    await deps.sendNotice(message.conversationId, `[CodeHarbor] ${localizeUpgradeParseReason(parsed.reason, deps.outputLanguage)}`);
    return;
  }

  if (deps.upgradeMutex.isLocked()) {
    await deps.sendNotice(
      message.conversationId,
      localize(
        "[CodeHarbor] 已有升级任务在执行中，请稍后发送 /diag version 或 /version 查看结果。",
        "[CodeHarbor] An upgrade task is already running. Use /diag version or /version later to check result.",
      ),
    );
    return;
  }
  const distributedLock = deps.acquireUpgradeExecutionLock();
  if (!distributedLock.acquired) {
    const lockUntil = distributedLock.expiresAt ? new Date(distributedLock.expiresAt).toISOString() : "unknown";
    await deps.sendNotice(
      message.conversationId,
      localize(
        `[CodeHarbor] 已有升级任务在其他实例执行中（owner=${distributedLock.owner ?? "unknown"}，lockUntil=${lockUntil}）。请稍后再试。`,
        `[CodeHarbor] An upgrade task is running on another instance (owner=${distributedLock.owner ?? "unknown"}, lockUntil=${lockUntil}). Please retry later.`,
      ),
    );
    return;
  }

  const targetLabel = parsed.version ? parsed.version : "latest";
  const upgradeRunId = deps.createUpgradeRun(message.senderId, parsed.version);
  const startedAt = Date.now();
  await deps.sendNotice(
    message.conversationId,
    localize(
      `${deps.botNoticePrefix} 已开始升级（目标: ${targetLabel}），将安装 npm 包并按平台策略重启（失败时给出回滚命令）。`,
      `${deps.botNoticePrefix} Upgrade started (target: ${targetLabel}). It will install npm package and restart by platform strategy (rollback command will be provided on failure).`,
    ),
  );

  try {
    await deps.upgradeMutex.runExclusive(async () => {
      const baselineVersionProbe = await safeProbeVersion(deps.upgradeVersionProbe);
      try {
        const result = await deps.selfUpdateRunner({
          version: parsed.version,
        });
        const restartPlan = await deps.upgradeRestartPlanner();
        const versionProbe = await safeProbeVersion(deps.upgradeVersionProbe);
        const postCheck = evaluateUpgradePostCheck({
          targetVersion: parsed.version,
          selfUpdateVersion: result.installedVersion,
          versionProbe,
        });
        const recoveryAdvice = buildUpgradeRecoveryAdvice({
          previousVersion: baselineVersionProbe.version,
          targetVersion: parsed.version,
          installedVersion: postCheck.installedVersion,
          includeAdminService: true,
          manualRestartCommands: restartPlan.manualCommands ?? null,
        });
        const elapsed = formatDurationMs(Date.now() - startedAt);
        if (postCheck.ok) {
          const installedVersion = postCheck.installedVersion ?? "unknown";
          await deps.sendNotice(
            message.conversationId,
            localize(
              `${deps.botNoticePrefix} 升级任务完成（耗时 ${elapsed}）
- 状态: success
- 目标版本: ${targetLabel}
- 已安装版本: ${installedVersion}
- 升级校验: 通过（${postCheck.checkDetail}）
- 服务重启: ${restartPlan.summary}
- 失败恢复命令: ${recoveryAdvice.rollbackCommand}
- 重启命令: ${formatRestartCommandSummary(recoveryAdvice)}
- 校验建议: 稍后发送 /diag version 或 /version`,
              `${deps.botNoticePrefix} Upgrade completed (${elapsed})
- status: success
- targetVersion: ${targetLabel}
- installedVersion: ${installedVersion}
- postCheck: pass (${postCheck.checkDetail})
- restartPlan: ${restartPlan.summary}
- rollbackCommand: ${recoveryAdvice.rollbackCommand}
- restartCommand: ${formatRestartCommandSummary(recoveryAdvice)}
- verifyHint: run /diag version or /version later`,
            ),
          );
          deps.finishUpgradeRun(upgradeRunId, {
            status: "succeeded",
            installedVersion,
            error: null,
          });
        } else {
          const observedVersion = postCheck.installedVersion ?? "unknown";
          await deps.sendNotice(
            message.conversationId,
            localize(
              `${deps.botNoticePrefix} 升级后校验失败（耗时 ${elapsed}）
- 状态: failed
- 目标版本: ${targetLabel}
- 观测版本: ${observedVersion}
- 失败原因: ${postCheck.checkDetail}
- 服务重启: ${restartPlan.summary}
- 回滚命令: ${recoveryAdvice.rollbackCommand}
- 重启命令: ${formatRestartCommandSummary(recoveryAdvice)}
- 诊断命令: /diag upgrade 5`,
              `${deps.botNoticePrefix} Upgrade post-check failed (${elapsed})
- status: failed
- targetVersion: ${targetLabel}
- observedVersion: ${observedVersion}
- reason: ${postCheck.checkDetail}
- restartPlan: ${restartPlan.summary}
- rollbackCommand: ${recoveryAdvice.rollbackCommand}
- restartCommand: ${formatRestartCommandSummary(recoveryAdvice)}
- diagnostics: /diag upgrade 5`,
            ),
          );
          deps.finishUpgradeRun(upgradeRunId, {
            status: "failed",
            installedVersion: postCheck.installedVersion,
            error: `post-check failed: ${postCheck.checkDetail}`,
          });
        }
        try {
          await restartPlan.apply();
        } catch (restartError) {
          deps.logger.warn("Failed to apply post-upgrade restart plan", { restartError });
        }
      } catch (error) {
        const errorText = formatSelfUpdateError(error);
        const elapsed = formatDurationMs(Date.now() - startedAt);
        const recoveryAdvice = buildUpgradeRecoveryAdvice({
          previousVersion: baselineVersionProbe.version,
          targetVersion: parsed.version,
          installedVersion: null,
          includeAdminService: true,
        });
        await deps.sendNotice(
          message.conversationId,
          localize(
            `${deps.botNoticePrefix} 升级失败（耗时 ${elapsed}）
- 错误: ${errorText}
- 回滚命令: ${recoveryAdvice.rollbackCommand}
- 重启命令: ${formatRestartCommandSummary(recoveryAdvice)}
- 诊断命令: /diag upgrade 5`,
            `${deps.botNoticePrefix} Upgrade failed (${elapsed})
- error: ${errorText}
- rollbackCommand: ${recoveryAdvice.rollbackCommand}
- restartCommand: ${formatRestartCommandSummary(recoveryAdvice)}
- diagnostics: /diag upgrade 5`,
          ),
        );
        deps.finishUpgradeRun(upgradeRunId, {
          status: "failed",
          installedVersion: null,
          error: errorText,
        });
      }
    });
  } finally {
    deps.releaseUpgradeExecutionLock();
  }
}

async function safeProbeVersion(
  probe: () => Promise<UpgradeVersionProbeResult>,
): Promise<UpgradeVersionProbeResult> {
  try {
    return await probe();
  } catch (error) {
    return {
      version: null,
      source: "probe-failed",
      error: formatSelfUpdateError(error),
    };
  }
}

function formatRestartCommandSummary(recoveryAdvice: UpgradeRecoveryAdvice): string {
  if (recoveryAdvice.restartCommands.length === 0) {
    return "N/A";
  }
  return recoveryAdvice.restartCommands.join(" || ");
}

function localizeUpgradeAuthReason(reason: string, outputLanguage: OutputLanguage): string {
  if (outputLanguage !== "en") {
    return reason;
  }
  if (reason.includes("仅支持私聊")) {
    return "For safety, /upgrade is allowed only in direct messages.";
  }
  if (reason.includes("MATRIX_UPGRADE_ALLOWED_USERS")) {
    return "This account is not allowed to run /upgrade. Ask admin to add it to MATRIX_UPGRADE_ALLOWED_USERS.";
  }
  if (reason.includes("MATRIX_ADMIN_USERS")) {
    return "This account is not in MATRIX_ADMIN_USERS and cannot run /upgrade.";
  }
  return reason;
}

function localizeUpgradeParseReason(reason: string, outputLanguage: OutputLanguage): string {
  if (outputLanguage !== "en") {
    return reason;
  }
  if (reason.includes("用法")) {
    return "Usage: /upgrade [version] (example: /upgrade or /upgrade 0.1.33)";
  }
  if (reason.includes("版本号格式无效")) {
    return "Invalid version format. Use x.y.z (for example: 0.1.33) or leave empty for latest.";
  }
  return reason;
}
