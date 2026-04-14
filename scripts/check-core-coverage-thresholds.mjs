#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const COVERAGE_METRIC_KEYS = ["statements", "branches", "functions", "lines"];
const CORE_MODULE_THRESHOLDS = [
  {
    file: "src/api-server.ts",
    thresholds: {
      statements: 75,
      branches: 60,
      functions: 95,
      lines: 75,
    },
  },
  {
    file: "src/orchestrator.ts",
    thresholds: {
      statements: 88,
      branches: 80,
      functions: 95,
      lines: 88,
    },
  },
  {
    file: "src/store/state-store.ts",
    thresholds: {
      statements: 82,
      branches: 68,
      functions: 95,
      lines: 82,
    },
  },
  {
    file: "src/rate-limiter.ts",
    thresholds: {
      statements: 86,
      branches: 80,
      functions: 95,
      lines: 86,
    },
  },
  {
    file: "src/metrics.ts",
    thresholds: {
      statements: 92,
      branches: 65,
      functions: 95,
      lines: 92,
    },
  },
  {
    file: "src/orchestrator/task-queue-recovery.ts",
    thresholds: {
      statements: 75,
      branches: 75,
      functions: 100,
      lines: 75,
    },
  },
];

function normalizePath(value) {
  return String(value).replaceAll("\\", "/");
}

function formatPct(value) {
  return `${value.toFixed(2)}%`;
}

function fail(messageLines) {
  const lines = Array.isArray(messageLines) ? messageLines : [String(messageLines)];
  process.stderr.write(`${lines.join("\n")}\n`);
  process.exit(1);
}

function readCoverageSummary(filePath) {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail([
      `Core coverage guard could not read coverage summary: ${filePath}`,
      `Error: ${error instanceof Error ? error.message : String(error)}`,
      "Run `npm run test:coverage` first.",
    ]);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    fail([
      `Core coverage guard found invalid JSON in: ${filePath}`,
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

function findModuleSummary(summary, targetFile) {
  const normalizedTarget = normalizePath(targetFile);
  if (summary[normalizedTarget]) {
    return summary[normalizedTarget];
  }

  const entries = Object.entries(summary);
  for (const [key, value] of entries) {
    const normalizedKey = normalizePath(key);
    if (normalizedKey === normalizedTarget || normalizedKey.endsWith(`/${normalizedTarget}`)) {
      return value;
    }
  }
  return null;
}

function extractPct(metric) {
  if (!metric || typeof metric !== "object") {
    return null;
  }
  const value = metric.pct;
  return Number.isFinite(value) ? Number(value) : null;
}

const summaryPath = path.resolve(process.cwd(), process.env.CORE_COVERAGE_SUMMARY_PATH ?? "coverage/coverage-summary.json");
const summary = readCoverageSummary(summaryPath);
const missingModules = [];
const violations = [];
const passSummaries = [];

for (const moduleRule of CORE_MODULE_THRESHOLDS) {
  const moduleSummary = findModuleSummary(summary, moduleRule.file);
  if (!moduleSummary) {
    missingModules.push(moduleRule.file);
    continue;
  }

  const metricsView = [];
  for (const metricKey of COVERAGE_METRIC_KEYS) {
    const expected = moduleRule.thresholds[metricKey];
    const actual = extractPct(moduleSummary[metricKey]);
    if (actual === null) {
      violations.push(`${moduleRule.file}: missing ${metricKey}.pct in coverage summary.`);
      continue;
    }
    metricsView.push(`${metricKey}=${formatPct(actual)} (>= ${formatPct(expected)})`);
    if (actual + 1e-9 < expected) {
      violations.push(
        `${moduleRule.file}: ${metricKey} ${formatPct(actual)} is below threshold ${formatPct(expected)}.`,
      );
    }
  }
  passSummaries.push(`- ${moduleRule.file}: ${metricsView.join(", ")}`);
}

if (missingModules.length > 0) {
  fail([
    "Core coverage guard could not find module entries in coverage summary:",
    ...missingModules.map((file) => `- ${file}`),
    `Summary file: ${summaryPath}`,
  ]);
}

if (violations.length > 0) {
  fail([
    "Core coverage guard failed:",
    ...violations.map((line) => `- ${line}`),
    `Summary file: ${summaryPath}`,
  ]);
}

process.stdout.write(`Core coverage guard passed for ${CORE_MODULE_THRESHOLDS.length} modules.\n`);
for (const line of passSummaries) {
  process.stdout.write(`${line}\n`);
}
