#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env}"
TARGET="${TARGET:-rbac}"
ROLE="${ROLE:-admin}"
ACTOR="${ACTOR:-}"
TOKEN_BYTES="${TOKEN_BYTES:-24}"
APPEND_MODE="false"
PRINT_ONLY="false"

usage() {
  cat <<'USAGE'
Usage: scripts/rotate-admin-token.sh [options]

Generate and rotate CodeHarbor admin auth token values in .env.

Options:
  -e, --env <path>            Env file path (default: .env)
  -t, --target <rbac|legacy>  Rotate ADMIN_TOKENS_JSON or ADMIN_TOKEN (default: rbac)
  -r, --role <admin|viewer>   Role for RBAC token (default: admin)
  -a, --actor <name>          Actor tag for RBAC token entry (optional)
  -b, --bytes <N>             Random bytes for token generation (default: 24)
      --append                Keep same role/actor entries and append new one
      --print-only            Print result without writing file
  -h, --help                  Show this help message

Examples:
  scripts/rotate-admin-token.sh --target rbac --role admin --actor ops-admin
  scripts/rotate-admin-token.sh --target rbac --role viewer --actor ops-audit
  scripts/rotate-admin-token.sh --target legacy
USAGE
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -e|--env)
        [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
        ENV_FILE="$2"
        shift 2
        ;;
      -t|--target)
        [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
        TARGET="$2"
        shift 2
        ;;
      -r|--role)
        [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
        ROLE="$2"
        shift 2
        ;;
      -a|--actor)
        [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
        ACTOR="$2"
        shift 2
        ;;
      -b|--bytes)
        [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
        TOKEN_BYTES="$2"
        shift 2
        ;;
      --append)
        APPEND_MODE="true"
        shift
        ;;
      --print-only)
        PRINT_ONLY="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done
}

validate_args() {
  if [[ "${TARGET}" != "rbac" && "${TARGET}" != "legacy" ]]; then
    echo "--target must be rbac or legacy" >&2
    exit 1
  fi

  if [[ "${ROLE}" != "admin" && "${ROLE}" != "viewer" ]]; then
    echo "--role must be admin or viewer" >&2
    exit 1
  fi

  if ! [[ "${TOKEN_BYTES}" =~ ^[0-9]+$ ]]; then
    echo "--bytes must be a positive integer" >&2
    exit 1
  fi

  if (( TOKEN_BYTES < 8 )); then
    echo "--bytes must be >= 8" >&2
    exit 1
  fi
}

main() {
  parse_args "$@"
  validate_args

  ROTATE_ENV_FILE="${ENV_FILE}" \
  ROTATE_TARGET="${TARGET}" \
  ROTATE_ROLE="${ROLE}" \
  ROTATE_ACTOR="${ACTOR}" \
  ROTATE_TOKEN_BYTES="${TOKEN_BYTES}" \
  ROTATE_APPEND_MODE="${APPEND_MODE}" \
  ROTATE_PRINT_ONLY="${PRINT_ONLY}" \
  node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const envPath = path.resolve(process.cwd(), process.env.ROTATE_ENV_FILE || ".env");
const target = process.env.ROTATE_TARGET || "rbac";
const role = process.env.ROTATE_ROLE || "admin";
const actorRaw = (process.env.ROTATE_ACTOR || "").trim();
const actor = actorRaw || null;
const tokenBytes = Number.parseInt(process.env.ROTATE_TOKEN_BYTES || "24", 10);
const appendMode = process.env.ROTATE_APPEND_MODE === "true";
const printOnly = process.env.ROTATE_PRINT_ONLY === "true";

if (!fs.existsSync(envPath)) {
  throw new Error(`Env file not found: ${envPath}`);
}

const source = fs.readFileSync(envPath, "utf8");
const current = parseEnv(source);
const nextToken = crypto.randomBytes(tokenBytes).toString("base64url");
const updates = {};

if (target === "legacy") {
  updates.ADMIN_TOKEN = nextToken;
} else {
  const tokens = parseTokenList(current.ADMIN_TOKENS_JSON || "");
  const filtered = appendMode
    ? tokens
    : tokens.filter((entry) => !(entry.role === role && normalizeActor(entry.actor) === normalizeActor(actor)));

  filtered.push({
    token: nextToken,
    role,
    actor,
  });

  updates.ADMIN_TOKENS_JSON = JSON.stringify(filtered);
}

const nextContent = applyEnvOverrides(source, updates);

if (!printOnly) {
  fs.writeFileSync(envPath, nextContent, "utf8");
}

process.stdout.write(`Target: ${target}\n`);
if (target === "rbac") {
  process.stdout.write(`Role: ${role}\n`);
  process.stdout.write(`Actor: ${actor || "<none>"}\n`);
  process.stdout.write(`Mode: ${appendMode ? "append" : "replace-same-role-actor"}\n`);
}
process.stdout.write(`Token: ${nextToken}\n`);
process.stdout.write(`Env file: ${envPath}\n`);
process.stdout.write(`Written: ${printOnly ? "no (print-only)" : "yes"}\n`);
process.stdout.write("Restart required: yes\n");

function parseTokenList(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Existing ADMIN_TOKENS_JSON is not valid JSON.");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Existing ADMIN_TOKENS_JSON is not a JSON array.");
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`ADMIN_TOKENS_JSON[${index}] must be an object.`);
    }
    const token = String(entry.token || "").trim();
    const itemRole = entry.role === "viewer" ? "viewer" : "admin";
    const itemActor = typeof entry.actor === "string" ? entry.actor.trim() || null : null;

    if (!token) {
      throw new Error(`ADMIN_TOKENS_JSON[${index}].token must be non-empty.`);
    }

    return {
      token,
      role: itemRole,
      actor: itemActor,
    };
  });
}

function parseEnv(content) {
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    env[match[1]] = parseEnvValue(match[2]);
  }
  return env;
}

function parseEnvValue(raw) {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function applyEnvOverrides(template, overrides) {
  const lines = template.split(/\r?\n/);
  const seen = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(lines[index].trim());
    if (!match) {
      continue;
    }
    const key = match[1];
    if (!(key in overrides)) {
      continue;
    }
    lines[index] = `${key}=${formatEnvValue(String(overrides[key] ?? ""))}`;
    seen.add(key);
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (seen.has(key)) {
      continue;
    }
    lines.push(`${key}=${formatEnvValue(String(value ?? ""))}`);
  }

  const content = lines.join("\n");
  return content.endsWith("\n") ? content : `${content}\n`;
}

function formatEnvValue(value) {
  if (!value) {
    return "";
  }
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function normalizeActor(value) {
  return (value || "").trim().toLowerCase();
}
NODE
}

main "$@"
