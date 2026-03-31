#!/usr/bin/env node
import process from "node:process";

function parseSemver(input) {
  const match = String(input ?? "")
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function isNextSemverStep(from, to) {
  const patchStep = to.major === from.major && to.minor === from.minor && to.patch === from.patch + 1;
  const minorStep = to.major === from.major && to.minor === from.minor + 1 && to.patch === 0;
  const majorStep = to.major === from.major + 1 && to.minor === 0 && to.patch === 0;
  return patchStep || minorStep || majorStep;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const latest = String(process.env.LATEST_VERSION ?? "").trim();
const target = String(process.env.TARGET_VERSION ?? "").trim();

if (!target) {
  fail("TARGET_VERSION is required.");
}

if (!latest) {
  process.stdout.write("No published npm version found. Skip progression check.\n");
  process.exit(0);
}

const latestParsed = parseSemver(latest);
const targetParsed = parseSemver(target);
if (!latestParsed || !targetParsed) {
  fail(`Invalid semver input: latest=${latest}, target=${target}`);
}

if (target === latest) {
  process.stdout.write(`Target ${target} equals npm latest ${latest}; publish step will handle duplicate version.\n`);
  process.exit(0);
}

if (!isNextSemverStep(latestParsed, targetParsed)) {
  fail(
    [
      `Release version jump detected: npm latest=${latest}, target=${target}.`,
      "Policy: do not skip versions. If last release CI failed pre-publish, fix CI and retry the same version.",
    ].join("\n"),
  );
}

process.stdout.write(`Version progression OK: ${latest} -> ${target}\n`);
