#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const PACKAGE_JSON_PATH = path.resolve(ROOT, "package.json");
const README_PATH = path.resolve(ROOT, "README.md");
const REQUIREMENTS_PATH = path.resolve(ROOT, "REQUIREMENTS.md");
const TASK_LIST_PATH = path.resolve(ROOT, "TASK_LIST.md");

function fail(lines) {
  const text = Array.isArray(lines) ? lines.join("\n") : String(lines);
  process.stderr.write(`${text}\n`);
  process.exit(1);
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail([
      `Docs consistency check failed: cannot read file ${filePath}`,
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readFile(filePath));
  } catch (error) {
    fail([
      `Docs consistency check failed: invalid JSON in ${filePath}`,
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

function extractNodeMajor(nodeRange) {
  const match = String(nodeRange ?? "")
    .trim()
    .match(/^>=\s*(\d+)$/);
  if (!match) {
    fail(`Docs consistency check failed: unsupported package.json engines.node range: ${nodeRange}`);
  }
  return Number.parseInt(match[1], 10);
}

function requireMatch(text, regex, label, expected) {
  if (!regex.test(text)) {
    fail([
      `Docs consistency check failed: ${label} is out of sync.`,
      `- expected: ${expected}`,
    ]);
  }
}

const packageJson = readJson(PACKAGE_JSON_PATH);
const readme = readFile(README_PATH);
const requirements = readFile(REQUIREMENTS_PATH);
const taskList = readFile(TASK_LIST_PATH);

const packageVersion = String(packageJson.version ?? "").trim();
if (!packageVersion) {
  fail("Docs consistency check failed: package.json version is missing.");
}

const nodeMajor = extractNodeMajor(packageJson.engines?.node);
requireMatch(readme, new RegExp(`Node\\.js\\s+${nodeMajor}\\+`), "README Node.js prerequisite", `Node.js ${nodeMajor}+`);
requireMatch(
  requirements,
  new RegExp(`Node\\.js\\s*>=\\s*${nodeMajor}(?!\\d)`),
  "REQUIREMENTS Node.js compatibility requirement",
  `Node.js >= ${nodeMajor}`,
);

const taskListVersionMatch = taskList.match(/当前版本[：:]\s*v(\d+\.\d+\.\d+)/);
if (!taskListVersionMatch) {
  fail('Docs consistency check failed: missing "当前版本：vX.Y.Z" in TASK_LIST.md.');
}
if (taskListVersionMatch[1] !== packageVersion) {
  fail([
    "Docs consistency check failed: TASK_LIST current version is out of sync.",
    `- expected: v${packageVersion}`,
    `- actual: v${taskListVersionMatch[1]}`,
  ]);
}

process.stdout.write(
  [
    "Docs consistency check passed.",
    `- package version: ${packageVersion}`,
    `- Node.js requirement: >=${nodeMajor}`,
    `- TASK_LIST current version: v${taskListVersionMatch[1]}`,
  ].join("\n"),
);
process.stdout.write("\n");
