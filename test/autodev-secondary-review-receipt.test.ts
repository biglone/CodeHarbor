import { describe, expect, it } from "vitest";

import {
  AUTODEV_SECONDARY_REVIEW_RECEIPT_CLOSE_TAG,
  AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG,
  mapSecondaryReviewDecisionToTaskStatus,
  matchesSecondaryReviewSender,
  parseAutoDevSecondaryReviewReceipt,
} from "../src/orchestrator/autodev-secondary-review-receipt";

describe("autodev secondary review receipt", () => {
  it("parses structured receipt block", () => {
    const text = [
      "preface",
      AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG,
      "- task: T6.5",
      "- decision: approved",
      "- summary: looks good",
      "- risks: none",
      "- next: merge",
      "- requestId: req-123",
      "- workflowDiagRunId: run-abc",
      "- workdir: /home/biglone/workspace/StrawBerry",
      AUTODEV_SECONDARY_REVIEW_RECEIPT_CLOSE_TAG,
      "tail",
    ].join("\n");

    const parsed = parseAutoDevSecondaryReviewReceipt(text);

    expect(parsed).toEqual({
      taskId: "T6.5",
      decision: "approved",
      summary: "looks good",
      risks: null,
      nextAction: "merge",
      requestId: "req-123",
      workflowDiagRunId: "run-abc",
      workdir: "/home/biglone/workspace/StrawBerry",
    });
  });

  it("normalizes decision aliases and treats n/a fields as null", () => {
    const text = [
      AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG,
      "task: T7.1",
      "decision: changes-requested",
      "summary: N/A",
      "risks: none",
      "next: re-run tests",
      AUTODEV_SECONDARY_REVIEW_RECEIPT_CLOSE_TAG,
    ].join("\n");

    const parsed = parseAutoDevSecondaryReviewReceipt(text);

    expect(parsed?.decision).toBe("changes_requested");
    expect(parsed?.summary).toBeNull();
    expect(parsed?.risks).toBeNull();
    expect(parsed?.nextAction).toBe("re-run tests");
  });

  it("returns null when required fields are missing", () => {
    const missingDecision = [
      AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG,
      "task: T8.1",
      AUTODEV_SECONDARY_REVIEW_RECEIPT_CLOSE_TAG,
    ].join("\n");
    const missingTask = [
      AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG,
      "decision: blocked",
      AUTODEV_SECONDARY_REVIEW_RECEIPT_CLOSE_TAG,
    ].join("\n");

    expect(parseAutoDevSecondaryReviewReceipt(missingDecision)).toBeNull();
    expect(parseAutoDevSecondaryReviewReceipt(missingTask)).toBeNull();
  });

  it("matches sender by full mxid or localpart", () => {
    expect(matchesSecondaryReviewSender("@review-guard:matrix.biglone.tech", "@review-guard:matrix.biglone.tech")).toBe(true);
    expect(matchesSecondaryReviewSender("@review-guard:matrix.biglone.tech", "review-guard")).toBe(true);
    expect(matchesSecondaryReviewSender("@dev-main:matrix.biglone.tech", "@review-guard:matrix.biglone.tech")).toBe(false);
  });

  it("maps decision to task status", () => {
    expect(mapSecondaryReviewDecisionToTaskStatus("approved")).toBe("completed");
    expect(mapSecondaryReviewDecisionToTaskStatus("changes_requested")).toBe("pending");
    expect(mapSecondaryReviewDecisionToTaskStatus("blocked")).toBe("blocked");
  });
});
