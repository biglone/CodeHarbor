export type AutoDevValidationFailureClass =
  | "strict_missing_structured_evidence"
  | "exit_codes_non_zero_unexpected"
  | "structured_status_fail"
  | "scoped_text_failure"
  | "fallback_text_failure";

export type AutoDevValidationEvidenceSource = "structured" | "scoped_text" | "fallback_text" | "none";

export interface AutoDevValidationInference {
  passed: boolean;
  failureClass: AutoDevValidationFailureClass | null;
  evidenceSource: AutoDevValidationEvidenceSource;
}

export interface AutoDevValidationInferenceInput {
  output: string;
  review: string;
  strictMode: boolean;
}

export function inferAutoDevValidation(input: AutoDevValidationInferenceInput): AutoDevValidationInference {
  const combined = `${input.output}\n${input.review}`;
  const structuredValidationStatus = parseStructuredValidationStatus(combined);
  const exitCodes = parseAutoDevExitCodes(combined);
  if (exitCodes.length > 0) {
    const nonZeroCodes = exitCodes.filter((code) => Number.isFinite(code) && code !== 0);
    if (nonZeroCodes.length === 0) {
      return {
        passed: true,
        failureClass: null,
        evidenceSource: "structured",
      };
    }
    if (structuredValidationStatus === true && hasExpectedNonZeroExitEvidence(combined, nonZeroCodes)) {
      return {
        passed: true,
        failureClass: null,
        evidenceSource: "structured",
      };
    }
    return {
      passed: false,
      failureClass: "exit_codes_non_zero_unexpected",
      evidenceSource: "structured",
    };
  }

  if (structuredValidationStatus !== null) {
    return {
      passed: structuredValidationStatus,
      failureClass: structuredValidationStatus ? null : "structured_status_fail",
      evidenceSource: "structured",
    };
  }

  if (input.strictMode) {
    return {
      passed: false,
      failureClass: "strict_missing_structured_evidence",
      evidenceSource: "none",
    };
  }

  const scopedValidationText = resolveValidationScopeText(input.output, input.review);
  const scopedVerdict = inferValidationVerdictByText(scopedValidationText);
  if (scopedVerdict !== null) {
    return {
      passed: scopedVerdict,
      failureClass: scopedVerdict ? null : "scoped_text_failure",
      evidenceSource: "scoped_text",
    };
  }

  const fallbackVerdict = inferValidationVerdictByText(combined);
  if (fallbackVerdict !== null) {
    return {
      passed: fallbackVerdict,
      failureClass: fallbackVerdict ? null : "fallback_text_failure",
      evidenceSource: "fallback_text",
    };
  }
  return {
    passed: true,
    failureClass: null,
    evidenceSource: "none",
  };
}

function resolveValidationScopeText(output: string, review: string): string {
  const sections = [extractValidationSection(output), extractValidationSection(review)].filter(
    (section) => section.length > 0,
  );
  if (sections.length === 0) {
    return `${output}\n${review}`;
  }
  return sections.join("\n");
}

function extractValidationSection(text: string): string {
  if (!text.trim()) {
    return "";
  }

  const lines = text.split(/\r?\n/);
  const startPattern = /^\s*(?:#+\s*)?(?:VALIDATION|Validation(?:\s+Results?)?|验证结果|验证命令|验证)\s*[:：]?\s*(.*)$/i;
  const stopPattern =
    /^\s*(?:#+\s*)?(?:RISKS?|风险(?:与后续|说明)?|NEXT_STEPS|STATUS|ISSUES|SUGGESTIONS|BLOCKERS?|SUMMARY|改动文件|落盘文件|任务|最终可执行结果)\s*[:：]?\s*$/i;

  const collected: string[] = [];
  let capturing = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const startMatch = line.match(startPattern);
    if (startMatch) {
      capturing = true;
      const inline = startMatch[1].trim();
      if (inline) {
        collected.push(inline);
      }
      continue;
    }

    if (!capturing) {
      continue;
    }
    if (stopPattern.test(line)) {
      capturing = false;
      continue;
    }
    collected.push(line);
  }

  return collected.join("\n").trim();
}

function inferValidationVerdictByText(text: string): boolean | null {
  if (!text.trim()) {
    return null;
  }

  const failedCountMatches = [...text.matchAll(/\b([1-9]\d*)\s+failed\b/gi)];
  if (failedCountMatches.length > 0) {
    return false;
  }

  const chineseFailedCountMatches = [...text.matchAll(/([1-9]\d*)\s*(?:项|个|例|次)?\s*失败/gi)];
  if (chineseFailedCountMatches.length > 0) {
    return false;
  }

  const normalized = text
    .replace(/\b0+\s+failed\b/gi, "")
    .replace(/0+\s*(?:项|个|例|次)?\s*失败/gi, "");
  const hasExplicitFailure =
    /(?:\b(?:tests?\s+failed|test\s+run\s+failed|command\s+failed|validation\s+failed|build\s+failed|lint\s+failed|typecheck\s+failed|failed\s+with|not\s+passed)\b|(?:测试|验证|命令|构建|编译|lint|typecheck)(?:未通过|失败)|未通过|❌|\[FAIL\])/i.test(
      normalized,
    );
  if (hasExplicitFailure) {
    return false;
  }

  const hasExplicitSuccess =
    /(?:\b0+\s+failed\b|\b\d+\s+passed\b|\ball\s+pass(?:ed)?\b|✅|\[PASS\]|验证通过|测试通过|全部通过|全部\s*\[PASS\]|通过)/i.test(
      text,
    );
  if (hasExplicitSuccess) {
    return true;
  }

  return null;
}

function parseStructuredValidationStatus(text: string): boolean | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!/^(?:validation[\s_-]*status|验证状态)\s*[:：]/i.test(line)) {
      continue;
    }
    const value = line.replace(/^(?:validation[\s_-]*status|验证状态)\s*[:：]/i, "").trim().toLowerCase();
    if (!value) {
      continue;
    }
    if (/\b(?:fail|failed|error|not[\s_-]*pass(?:ed)?)\b/.test(value) || /(失败|未通过)/.test(value)) {
      return false;
    }
    if (/\b(?:pass|passed|ok|success)\b/.test(value) || /(通过|成功)/.test(value)) {
      return true;
    }
  }
  return null;
}

function parseAutoDevExitCodes(text: string): number[] {
  const codes: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const markerMatch = line.match(/__EXIT_CODES__\s*[:：]?\s*(.*)$/i);
    if (!markerMatch) {
      continue;
    }
    const payload = markerMatch[1];
    if (!payload) {
      continue;
    }
    for (const match of payload.matchAll(/(?:^|\s)[A-Za-z0-9_.:/-]+\s*=\s*(-?\d+)/g)) {
      const code = Number.parseInt(match[1], 10);
      if (Number.isFinite(code)) {
        codes.push(code);
      }
    }
  }
  return codes;
}

function hasExpectedNonZeroExitEvidence(text: string, nonZeroCodes: number[]): boolean {
  const explicitExpectedCodes = new Set<number>();
  let hasGenericExpectedNonZero = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!/(?:按预期|预期|as expected|expected(?:ly)?)/i.test(line)) {
      continue;
    }
    const lineMentionsNonZeroExpectation = /(?:non[-\s]?zero|非零|reject|拒绝|fail(?:ed)?|失败|exit|退出码|返回码)/i.test(line);
    if (lineMentionsNonZeroExpectation) {
      hasGenericExpectedNonZero = true;
    }
    for (const match of line.matchAll(/(?:exit|退出码|返回码)\s*[:=]?\s*(-?\d+)/gi)) {
      const code = Number.parseInt(match[1], 10);
      if (Number.isFinite(code) && code !== 0) {
        explicitExpectedCodes.add(code);
      }
    }
  }

  if (nonZeroCodes.every((code) => explicitExpectedCodes.has(code))) {
    return true;
  }
  if (!hasGenericExpectedNonZero) {
    return false;
  }
  return new Set(nonZeroCodes).size === 1;
}
