import { describe, expect, it } from "vitest";

import type { InboundMessage } from "../src/types";
import { handleWorkflowStatusCommand } from "../src/orchestrator/workflow-status-command";
import { buildWorkflowResultReply } from "../src/orchestrator/workflow-status";

function buildMessage(text: string): InboundMessage {
  return {
    requestId: "req-1",
    channel: "matrix",
    conversationId: "!room:example.com",
    senderId: "@user:example.com",
    eventId: "$evt-1",
    text,
    attachments: [],
    isDirectMessage: true,
    mentionsBot: true,
    repliesToBot: false,
  };
}

describe("workflow status semantics", () => {
  it("marks rejected result clearly in workflow result reply", () => {
    const reply = buildWorkflowResultReply(
      {
        objective: "demo objective",
        plan: "plan",
        output: "output",
        review: "review",
        approved: false,
        repairRounds: 1,
        durationMs: 9_000,
      },
      "en",
    );

    expect(reply).toContain("Multi-Agent workflow completed (reviewer rejected)");
    expect(reply).toContain("finalVerdict: REJECTED");
    expect(reply).toContain("approved: no");
  });

  it("reports outcome field in /agents status output", async () => {
    const notices: string[] = [];

    await handleWorkflowStatusCommand(
      {
        outputLanguage: "en",
        workflowPlanContextMaxChars: null,
        workflowOutputContextMaxChars: null,
        workflowFeedbackContextMaxChars: null,
        getWorkflowSnapshot: () => ({
          state: "succeeded",
          startedAt: "2026-03-25T00:00:00.000Z",
          endedAt: "2026-03-25T00:01:00.000Z",
          objective: "demo objective",
          approved: false,
          repairRounds: 1,
          error: null,
        }),
        buildWorkflowRoleSkillStatus: () => ({
          enabled: true,
          mode: "progressive",
          maxChars: 2400,
          override: "none",
          loaded: "planner=builtin-planner-core",
        }),
        formatWorkflowContextBudget: () => "unlimited",
        sendNotice: async (_conversationId, text) => {
          notices.push(text);
        },
      },
      {
        sessionKey: "session-1",
        message: buildMessage("/agents status"),
      },
    );

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("state: succeeded");
    expect(notices[0]).toContain("outcome: rejected");
    expect(notices[0]).toContain("approved: no");
  });
});
