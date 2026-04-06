import { describe, expect, it } from "vitest";

import { inferAutoDevValidation } from "../src/orchestrator/autodev-validation-policy";

describe("autodev validation policy", () => {
  it("fails in strict mode when structured evidence is missing", () => {
    const result = inferAutoDevValidation({
      output: "No validation marker here",
      review: "Looks good",
      strictMode: true,
    });

    expect(result).toEqual({
      passed: false,
      failureClass: "strict_missing_structured_evidence",
      evidenceSource: "none",
    });
  });

  it("passes structured non-zero exit when explicitly expected", () => {
    const result = inferAutoDevValidation({
      output: [
        "validation_status: passed",
        "__EXIT_CODES__: npm_test=1",
        "expected exit: 1",
      ].join("\n"),
      review: "validated",
      strictMode: false,
    });

    expect(result).toEqual({
      passed: true,
      failureClass: null,
      evidenceSource: "structured",
    });
  });

  it("fails structured status when validation_status says failed", () => {
    const result = inferAutoDevValidation({
      output: "validation_status: failed",
      review: "",
      strictMode: false,
    });

    expect(result).toEqual({
      passed: false,
      failureClass: "structured_status_fail",
      evidenceSource: "structured",
    });
  });

  it("uses scoped validation text before fallback text", () => {
    const result = inferAutoDevValidation({
      output: [
        "VALIDATION:",
        "tests failed in gateway suite",
        "SUMMARY:",
        "all passed (non-validation note)",
      ].join("\n"),
      review: "",
      strictMode: false,
    });

    expect(result).toEqual({
      passed: false,
      failureClass: "scoped_text_failure",
      evidenceSource: "scoped_text",
    });
  });
});
