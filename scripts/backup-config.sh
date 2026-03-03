#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups/config}"
KEEP_COUNT="${KEEP_COUNT:-20}"

usage() {
  cat <<'USAGE'
Usage: scripts/backup-config.sh [options]

Export a CodeHarbor config snapshot with timestamp, then keep only the latest N files.

Options:
  -d, --dir <path>     Backup directory (default: backups/config)
  -k, --keep <count>   Number of latest backups to keep (default: 20)
  -h, --help           Show this help message

Environment overrides:
  BACKUP_DIR
  KEEP_COUNT
USAGE
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -d|--dir)
        if [[ $# -lt 2 ]]; then
          echo "Missing value for $1" >&2
          exit 1
        fi
        BACKUP_DIR="$2"
        shift 2
        ;;
      -k|--keep)
        if [[ $# -lt 2 ]]; then
          echo "Missing value for $1" >&2
          exit 1
        fi
        KEEP_COUNT="$2"
        shift 2
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

validate_keep_count() {
  if ! [[ "${KEEP_COUNT}" =~ ^[0-9]+$ ]]; then
    echo "KEEP_COUNT must be a non-negative integer: ${KEEP_COUNT}" >&2
    exit 1
  fi
}

resolve_cli() {
  if command -v codeharbor >/dev/null 2>&1; then
    CLI=(codeharbor)
    return
  fi

  if [[ -f "${REPO_ROOT}/dist/cli.js" ]]; then
    CLI=(node "${REPO_ROOT}/dist/cli.js")
    return
  fi

  if command -v npx >/dev/null 2>&1 && [[ -f "${REPO_ROOT}/src/cli.ts" ]]; then
    CLI=(npx tsx "${REPO_ROOT}/src/cli.ts")
    return
  fi

  echo "Cannot locate CodeHarbor CLI. Install 'codeharbor' or build the project first." >&2
  exit 1
}

trim_old_backups() {
  local backups=()
  while IFS= read -r file; do
    backups+=("${file}")
  done < <(ls -1t "${BACKUP_DIR}"/config-snapshot-*.json 2>/dev/null || true)

  if (( ${#backups[@]} <= KEEP_COUNT )); then
    return
  fi

  local index
  for (( index = KEEP_COUNT; index < ${#backups[@]}; index += 1 )); do
    rm -f "${backups[index]}"
  done
}

main() {
  parse_args "$@"
  validate_keep_count

  mkdir -p "${BACKUP_DIR}"

  BACKUP_DIR="$(cd "${BACKUP_DIR}" && pwd)"
  local timestamp
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local output_file="${BACKUP_DIR}/config-snapshot-${timestamp}.json"

  cd "${REPO_ROOT}"
  resolve_cli

  "${CLI[@]}" config export -o "${output_file}"
  trim_old_backups

  echo "Backup created: ${output_file}"
  echo "Retention keep count: ${KEEP_COUNT}"
}

main "$@"
