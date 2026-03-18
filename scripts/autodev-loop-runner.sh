#!/usr/bin/env bash
set -euo pipefail

RUNTIME_HOME="${RUNTIME_HOME:-/home/Biglone/.codeharbor}"
PROJECT_DIR="${PROJECT_DIR:-/home/Biglone/workspace/CodeHarbor}"
TASK_LIST_PATH="${TASK_LIST_PATH:-${PROJECT_DIR}/TASK_LIST.md}"
SLEEP_SECONDS="${SLEEP_SECONDS:-720}"

ENV_PATH="${RUNTIME_HOME}/.env"

if [[ ! -f "${ENV_PATH}" ]]; then
  echo "[autodev-loop] missing env file: ${RUNTIME_HOME}/.env" >&2
  exit 1
fi

if [[ ! -f "${TASK_LIST_PATH}" ]]; then
  echo "[autodev-loop] missing task list: ${TASK_LIST_PATH}" >&2
  exit 1
fi

function read_env_value() {
  local key="$1"
  local raw
  raw="$(awk -F= -v k="${key}" '$1==k {sub(/^[^=]*=/, "", $0); print $0; exit}' "${ENV_PATH}")"
  raw="${raw%\"}"
  raw="${raw#\"}"
  printf "%s" "${raw}"
}

MATRIX_HOMESERVER="$(read_env_value MATRIX_HOMESERVER)"
MATRIX_ACCESS_TOKEN="$(read_env_value MATRIX_ACCESS_TOKEN)"

if [[ -z "${MATRIX_HOMESERVER}" || -z "${MATRIX_ACCESS_TOKEN}" ]]; then
  echo "[autodev-loop] MATRIX_HOMESERVER or MATRIX_ACCESS_TOKEN is empty" >&2
  exit 1
fi

function resolve_room_id() {
  node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/home/Biglone/.codeharbor/data/state.db", { readOnly: true });
const row = db.prepare("SELECT session_key FROM sessions ORDER BY updated_at DESC LIMIT 1").get();
if (!row || typeof row.session_key !== "string") {
  process.exit(1);
}
const key = row.session_key;
const first = key.indexOf(":");
const last = key.lastIndexOf(":@");
if (first < 0 || last <= first) {
  process.exit(1);
}
process.stdout.write(key.slice(first + 1, last));
NODE
}

function count_remaining_tasks() {
  python3 - "${TASK_LIST_PATH}" <<'PY'
import re
import sys

path = sys.argv[1]
pending = 0
in_progress = 0

for raw in open(path, "r", encoding="utf-8"):
    line = raw.strip()
    if not line.startswith("|") or line.startswith("|--------"):
        continue
    cells = [x.strip() for x in line.split("|")[1:-1]]
    if len(cells) < 6:
        continue
    status = cells[-1]
    if status == "⬜":
        pending += 1
    elif status == "🔄":
        in_progress += 1

print(f"{pending}:{in_progress}")
PY
}

echo "[autodev-loop] started at $(date '+%F %T')"
echo "[autodev-loop] task list: ${TASK_LIST_PATH}"
echo "[autodev-loop] interval: ${SLEEP_SECONDS}s"

while true; do
  stats="$(count_remaining_tasks)"
  pending_count="${stats%%:*}"
  in_progress_count="${stats##*:}"
  echo "[autodev-loop] pending=${pending_count} in_progress=${in_progress_count} at $(date '+%F %T')"

  if [[ "${pending_count}" == "0" && "${in_progress_count}" == "0" ]]; then
    echo "[autodev-loop] no remaining tasks, exit."
    break
  fi

  if [[ "${in_progress_count}" != "0" ]]; then
    echo "[autodev-loop] skip trigger: task still in_progress"
    sleep "${SLEEP_SECONDS}"
    continue
  fi

  room_id="$(resolve_room_id)"
  encoded_room_id="$(python3 - <<PY
import urllib.parse
print(urllib.parse.quote("""${room_id}""", safe=""))
PY
)"
  txn_id="autodev-loop-$(date +%s)-$RANDOM"
  url="${MATRIX_HOMESERVER}/_matrix/client/v3/rooms/${encoded_room_id}/send/m.room.message/${txn_id}"
  payload='{"msgtype":"m.text","body":"!code /autodev run"}'

  response="$(curl -sS -X PUT "${url}" \
    -H "Authorization: Bearer ${MATRIX_ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${payload}")"

  echo "[autodev-loop] trigger response: ${response}"
  sleep "${SLEEP_SECONDS}"
done
