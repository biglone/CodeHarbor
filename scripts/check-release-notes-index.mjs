#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const README_PATH = path.resolve(ROOT, "README.md");
const RELEASES_DIR = path.resolve(ROOT, "docs/releases");

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
      `Release index check failed: cannot read file ${filePath}`,
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

function readReleaseDocs(dirPath) {
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    fail([
      `Release index check failed: cannot read directory ${dirPath}`,
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const releaseNotes = [];
  const announcements = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (/^v\d+\.\d+\.\d+-release-notes\.md$/.test(entry.name)) {
      releaseNotes.push(entry.name);
      continue;
    }
    if (/^v\d+\.\d+\.\d+-announcement-bilingual\.md$/.test(entry.name)) {
      announcements.push(entry.name);
    }
  }
  releaseNotes.sort(compareVersionFileAsc);
  announcements.sort(compareVersionFileAsc);
  return { releaseNotes, announcements };
}

function parseVersionTriple(fileName) {
  const match = /^v(\d+)\.(\d+)\.(\d+)-/.exec(fileName);
  if (!match) {
    return null;
  }
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
}

function compareVersionFileAsc(left, right) {
  const l = parseVersionTriple(left);
  const r = parseVersionTriple(right);
  if (!l || !r) {
    return left.localeCompare(right);
  }
  if (l[0] !== r[0]) {
    return l[0] - r[0];
  }
  if (l[1] !== r[1]) {
    return l[1] - r[1];
  }
  return l[2] - r[2];
}

function extractReleaseIndexSection(readmeText) {
  const startMarker = "## Release Notes Index";
  const start = readmeText.indexOf(startMarker);
  if (start < 0) {
    fail(`Release index check failed: missing section heading "${startMarker}" in README.md`);
  }
  const rest = readmeText.slice(start + startMarker.length);
  const nextHeadingPos = rest.search(/\n##\s+/);
  if (nextHeadingPos < 0) {
    return rest;
  }
  return rest.slice(0, nextHeadingPos);
}

function requirePathInText(pathText, text, label) {
  if (!text.includes(pathText)) {
    fail(`Release index check failed: missing ${label} path in README: ${pathText}`);
  }
}

const readme = readFile(README_PATH);
const { releaseNotes, announcements } = readReleaseDocs(RELEASES_DIR);
if (releaseNotes.length === 0) {
  fail("Release index check failed: no release notes files found under docs/releases.");
}
if (announcements.length === 0) {
  fail("Release index check failed: no bilingual announcement files found under docs/releases.");
}

const releaseIndexSection = extractReleaseIndexSection(readme);
for (const fileName of releaseNotes) {
  requirePathInText(`docs/releases/${fileName}`, releaseIndexSection, "release notes index");
}
for (const fileName of announcements) {
  requirePathInText(`docs/releases/${fileName}`, releaseIndexSection, "release notes index");
}

const latestReleaseNotesFile = releaseNotes[releaseNotes.length - 1];
const latestAnnouncementFile = announcements[announcements.length - 1];
requirePathInText(`docs/releases/${latestReleaseNotesFile}`, readme, "latest release notes");
requirePathInText(`docs/releases/${latestAnnouncementFile}`, readme, "latest bilingual announcement");

process.stdout.write(
  [
    "Release notes index check passed.",
    `- indexed release notes files: ${releaseNotes.length}`,
    `- indexed announcement files: ${announcements.length}`,
    `- latest release notes: docs/releases/${latestReleaseNotesFile}`,
    `- latest bilingual announcement: docs/releases/${latestAnnouncementFile}`,
  ].join("\n"),
);
process.stdout.write("\n");
