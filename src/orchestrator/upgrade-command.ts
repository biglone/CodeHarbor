import type { Mutex } from "async-mutex";

import type { Logger } from "../logger";
import type { InboundMessage } from "../types";
import { parseUpgradeTarget } from "./command-routing";
import { formatDurationMs } from "./helpers";
import {
  evaluateUpgradePostCheck,
  formatSelfUpdateError,
  type SelfUpdateResult,
  type UpgradeRestartPlan,
  type UpgradeVersionProbeResult,
} from "./upgrade-utils";

interface HandleUpgradeCommandDeps {
  logger: Logger;
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
  const auth = deps.authorizeUpgradeRequest(message);
  if (!auth.allowed) {
    await deps.sendNotice(message.conversationId, `[CodeHarbor] ${auth.reason}`);
    return;
  }

  const parsed = parseUpgradeTarget(message.text);
  if (!parsed.ok) {
    await deps.sendNotice(message.conversationId, `[CodeHarbor] ${parsed.reason}`);
    return;
  }

  if (deps.upgradeMutex.isLocked()) {
    await deps.sendNotice(
      message.conversationId,
      "[CodeHarbor] 已有升级任务在执行中，请稍后发送 /diag version 或 /version 查看结果。",
    );
    return;
  }
  const distributedLock = deps.acquireUpgradeExecutionLock();
  if (!distributedLock.acquired) {
    const lockUntil = distributedLock.expiresAt ? new Date(distributedLock.expiresAt).toISOString() : "unknown";
    await deps.sendNotice(
      message.conversationId,
      `[CodeHarbor] 已有升级任务在其他实例执行中（owner=${distributedLock.owner ?? "unknown"}，lockUntil=${lockUntil}）。请稍后再试。`,
    );
    return;
  }

  const targetLabel = parsed.version ? parsed.version : "latest";
  const upgradeRunId = deps.createUpgradeRun(message.senderId, parsed.version);
  const startedAt = Date.now();
  await deps.sendNotice(
    message.conversationId,
    `${deps.botNoticePrefix} 已开始升级（目标: ${targetLabel}），将安装 npm 最新包并自动重启服务。`,
  );

  try {
    await deps.upgradeMutex.runExclusive(async () => {
      try {
        const result = await deps.selfUpdateRunner({
          version: parsed.version,
        });
        const restartPlan = await deps.upgradeRestartPlanner();
        const versionProbe = await deps.upgradeVersionProbe();
        const postCheck = evaluateUpgradePostCheck({
          targetVersion: parsed.version,
          selfUpdateVersion: result.installedVersion,
          versionProbe,
        });
        const elapsed = formatDurationMs(Date.now() - startedAt);
        if (postCheck.ok) {
          const installedVersion = postCheck.installedVersion ?? "unknown";
          await deps.sendNotice(
            message.conversationId,
            `${deps.botNoticePrefix} 升级任务完成（耗时 ${elapsed}）
- 目标版本: ${targetLabel}
- 已安装版本: ${installedVersion}
- 升级校验: 通过（${postCheck.checkDetail}）
- 服务重启: ${restartPlan.summary}
- 校验建议: 稍后发送 /diag version 或 /version`,
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
            `${deps.botNoticePrefix} 升级后校验失败（耗时 ${elapsed}）
- 目标版本: ${targetLabel}
- 观测版本: ${observedVersion}
- 失败原因: ${postCheck.checkDetail}
- 服务重启: ${restartPlan.summary}
- 恢复建议: 发送 /diag version 查看实例路径；必要时执行 codeharbor self-update --with-admin`,
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
        await deps.sendNotice(
          message.conversationId,
          `${deps.botNoticePrefix} 升级失败（耗时 ${elapsed}）
- 错误: ${errorText}
- 兜底命令: codeharbor self-update --with-admin`,
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
