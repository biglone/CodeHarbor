import { describe, expect, it } from "vitest";

import {
  buildAutoDevSecondaryReviewHandoffNotice,
  buildAutoDevTaskResultDiagMessage,
  buildAutoDevTaskResultNotice,
} from "../src/orchestrator/autodev-result-reporter";
import {
  AUTODEV_SECONDARY_REVIEW_RECEIPT_CLOSE_TAG,
  AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG,
} from "../src/orchestrator/autodev-secondary-review-receipt";

describe("AutoDev result reporter", () => {
  it("builds task result notice and diag message", () => {
    const notice = buildAutoDevTaskResultNotice({
      outputLanguage: "en",
      task: {
        id: "T10.5",
        description: "result reporter",
        status: "completed",
        lineIndex: 12,
      },
      reviewerApproved: true,
      completionGatePassed: true,
      completionGateReasonsText: "N/A",
      completionGateReasonCodes: "none",
      validationFailureClass: null,
      validationEvidenceSource: "structured",
      validationAt: "2026-04-06T12:00:00.000Z",
      taskStatusSymbol: "✅",
      gitCommitSummary: "committed abc123",
      gitChangedFiles: "src/a.ts, src/b.ts",
      releaseSummary: "skipped",
      nextTaskDisplay: "N/A",
    });

    const diag = buildAutoDevTaskResultDiagMessage({
      outputLanguage: "en",
      taskId: "T10.5",
      reviewerApproved: true,
      completionGatePassed: true,
      completionGateReasonCodes: "none",
      validationFailureClass: null,
      validationEvidenceSource: "structured",
      validationAt: "2026-04-06T12:00:00.000Z",
      taskStatusSymbol: "✅",
      gitCommitSummary: "committed abc123",
      releaseSummary: "skipped",
    });

    expect(notice).toContain("[CodeHarbor] AutoDev task result");
    expect(notice).toContain("task: T10.5");
    expect(notice).toContain("completionGate: passed");
    expect(diag).toContain("AutoDev task result: task=T10.5");
    expect(diag).toContain("completionGate=passed");
  });

  it("returns null when secondary review is disabled or gate not passed", () => {
    const disabled = buildAutoDevSecondaryReviewHandoffNotice({
      outputLanguage: "en",
      enabled: false,
      target: "@review-guard",
      requireGatePassed: true,
      completionGatePassed: true,
      task: {
        id: "T1",
        description: "test",
        status: "completed",
        lineIndex: 1,
      },
      reviewerApproved: true,
      validationFailureClass: null,
      validationEvidenceSource: "structured",
      validationAt: "2026-04-06T12:00:00.000Z",
      gitCommitSummary: "committed",
      gitChangedFiles: "a.ts",
      releaseSummary: "skipped",
      requestId: "request-1",
      workflowDiagRunId: "run-1",
      workdir: "/tmp/codeharbor",
    });
    expect(disabled).toBeNull();

    const gateFailed = buildAutoDevSecondaryReviewHandoffNotice({
      outputLanguage: "en",
      enabled: true,
      target: "@review-guard",
      requireGatePassed: true,
      completionGatePassed: false,
      task: {
        id: "T1",
        description: "test",
        status: "in_progress",
        lineIndex: 1,
      },
      reviewerApproved: false,
      validationFailureClass: "structured_status_fail",
      validationEvidenceSource: "structured",
      validationAt: "2026-04-06T12:00:00.000Z",
      gitCommitSummary: "skipped",
      gitChangedFiles: "none",
      releaseSummary: "skipped",
      requestId: "request-2",
      workflowDiagRunId: "run-2",
      workdir: "/tmp/codeharbor",
    });
    expect(gateFailed).toBeNull();
  });

  it("builds secondary review handoff when enabled", () => {
    const handoff = buildAutoDevSecondaryReviewHandoffNotice({
      outputLanguage: "en",
      enabled: true,
      target: "@review-guard",
      requireGatePassed: false,
      completionGatePassed: false,
      task: {
        id: "T10.5",
        description: "result reporter",
        status: "in_progress",
        lineIndex: 2,
      },
      reviewerApproved: false,
      validationFailureClass: "structured_status_fail",
      validationEvidenceSource: "structured",
      validationAt: "2026-04-06T12:00:00.000Z",
      gitCommitSummary: "skipped",
      gitChangedFiles: "none",
      releaseSummary: "skipped",
      requestId: "request-3",
      workflowDiagRunId: "run-3",
      workdir: "/workspace/codeharbor",
    });

    expect(handoff).not.toBeNull();
    expect(handoff?.notice).toContain("AutoDev secondary review handoff");
    expect(handoff?.notice).toContain("target: @review-guard");
    expect(handoff?.notice).toContain("protocol: AUTODEV_SECONDARY_REVIEW_RECEIPT/v1");
    expect(handoff?.notice).toContain(AUTODEV_SECONDARY_REVIEW_RECEIPT_OPEN_TAG);
    expect(handoff?.notice).toContain(AUTODEV_SECONDARY_REVIEW_RECEIPT_CLOSE_TAG);
    expect(handoff?.notice).toContain("- workdir: /workspace/codeharbor");
    expect(handoff?.diagMessage).toContain("secondaryReview target=@review-guard");
    expect(handoff?.diagMessage).toContain("protocol=receipt_v1");
  });
});
