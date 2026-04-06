import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { handleAutoDevStatusCommand } from "../src/orchestrator/autodev-status-command";
import type { InboundMessage } from "../src/types";

const execFileAsync = promisify(execFile);

function makeInbound(text = "/autodev status"): InboundMessage {
  return {
    requestId: "request-status-baseline",
    channel: "matrix",
    conversationId: "conversation-status-baseline",
    senderId: "user-status-baseline",
    eventId: "$event-status-baseline",
    text,
    attachments: [],
    isDirectMessage: true,
    mentionsBot: false,
    repliesToBot: false,
  };
}

describe("AutoDev status command", () => {
  it("captures status output baseline", async () => {
    const workdir = path.join(os.tmpdir(), "codeharbor-autodev-status-baseline");
    await fs.rm(workdir, { recursive: true, force: true });
    await fs.mkdir(workdir, { recursive: true });

    await fs.writeFile(path.join(workdir, "REQUIREMENTS.md"), "# REQUIREMENTS\n", "utf8");
    await fs.writeFile(
      path.join(workdir, "TASK_LIST.md"),
      [
        "| 任务ID | 任务描述 | 状态 |",
        "|--------|----------|------|",
        "| T10.1 | status baseline | ⬜ |",
      ].join("\n"),
      "utf8",
    );

    await execFileAsync("git", ["init", "-q"], { cwd: workdir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workdir });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: workdir });
    await execFileAsync("git", ["add", "REQUIREMENTS.md", "TASK_LIST.md"], { cwd: workdir });
    await execFileAsync("git", ["commit", "-m", "test: status baseline"], { cwd: workdir });

    const notices: string[] = [];
    const deps: Parameters<typeof handleAutoDevStatusCommand>[0] = {
      outputLanguage: "en",
      autoDevLoopMaxRuns: 5,
      autoDevLoopMaxMinutes: 60,
      autoDevAutoCommit: true,
      autoDevAutoReleaseEnabled: false,
      autoDevAutoReleasePush: true,
      autoDevMaxConsecutiveFailures: 3,
      autoDevRunArchiveEnabled: false,
      autoDevRunArchiveDir: ".codeharbor/autodev-runs",
      autoDevValidationStrict: false,
      autoDevSecondaryReviewEnabled: false,
      autoDevSecondaryReviewTarget: "@review-guard",
      autoDevSecondaryReviewRequireGatePassed: true,
      autoDevDetailedProgressDefaultEnabled: true,
      autoDevStageOutputEchoDefaultEnabled: true,
      autoDevInitEnhancementEnabled: true,
      autoDevInitEnhancementTimeoutMs: 60_000,
      autoDevInitEnhancementMaxChars: 12_000,
      getAutoDevSnapshot: () => null,
      hasActiveAutoDevLoopSession: () => false,
      hasPendingAutoDevLoopStopRequest: () => false,
      hasPendingStopRequest: () => false,
      isAutoDevDetailedProgressEnabled: () => true,
      isAutoDevStageOutputEchoEnabled: () => true,
      buildWorkflowRoleSkillStatus: () => ({
        enabled: true,
        mode: "progressive",
        maxChars: 2400,
        override: "none",
        loaded: "planner=builtin-planner-core",
      }),
      listWorkflowDiagRunsBySession: () => [],
      listWorkflowDiagEvents: () => [],
      sendNotice: async (_conversationId, text) => {
        notices.push(text);
      },
    };

    try {
      await handleAutoDevStatusCommand(deps, {
        sessionKey: "session-status-baseline",
        message: makeInbound(),
        workdir,
      });

      expect(notices).toHaveLength(1);
      const normalized = notices[0].replaceAll(workdir, "<WORKDIR>");
      expect(normalized).toMatchInlineSnapshot(`
        "[CodeHarbor] AutoDev status
        - workdir: <WORKDIR>
        - REQUIREMENTS.md: found
        - TASK_LIST.md: found
        - tasks: total=1, pending=1, in_progress=0, completed=0, blocked=0, cancelled=0
        - taskAutoHeal: none
        - gitPreflight: clean
        - config: loopMaxRuns=5, loopMaxMinutes=60, autoCommit=on, autoRelease=off, autoReleasePush=on, maxConsecutiveFailures=3, runArchive=off, runArchiveDir=.codeharbor/autodev-runs, validationStrict=off, secondaryReview=off, secondaryReviewTarget=@review-guard, secondaryReviewRequireGatePassed=on, initEnhancement=on, initEnhancementTimeoutMs=60000, initEnhancementMaxChars=12000, detailedProgress=on (default=on), stageOutputEcho=on (default=on)
        - gitPreflightReason: N/A
        - roleSkills: enabled=on, mode=progressive, maxChars=2400, override=none
        - roleSkillsLoaded: planner=builtin-planner-core
        - runState: idle
        - currentTask: N/A
        - runWindow: startedAt=N/A, endedAt=N/A, duration=N/A
        - runMode: idle
        - runLoop: round=0, completed=0/0, deadline=N/A
        - runControl: loopActive=no, loopStopRequested=no, stopRequested=no
        - runApproved: N/A
        - runError: N/A
        - runValidationFailureClass: N/A
        - runValidationEvidenceSource: N/A
        - runValidationAt: N/A
        - runGitCommit: N/A
        - runGitCommitAt: N/A
        - runRelease: N/A
        - runReleaseAt: N/A
        - workflowDiag: runId=N/A, status=N/A, startedAt=N/A, updatedAt=N/A, duration=N/A
        - workflowDiagLastStage: N/A
        - workflowStage: N/A
        - recentRuns:
        - (empty)
        - stageTrace:
        - (empty)"
      `);
    } finally {
      await fs.rm(workdir, { recursive: true, force: true });
    }
  });
});
