#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SERVICE_NAME="${SERVICE_NAME:-codeharbor-config-backup}"
ON_CALENDAR="${ON_CALENDAR:-daily}"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/backups/config}"
KEEP_COUNT="${KEEP_COUNT:-30}"
DRY_RUN="false"

usage() {
  cat <<'USAGE'
Usage: scripts/install-backup-timer.sh [options]

Install or update a user-level systemd timer for automatic config snapshot backups.

Options:
  -n, --name <service-name>   systemd unit base name (default: codeharbor-config-backup)
  -s, --schedule <OnCalendar> systemd OnCalendar expression (default: daily)
  -d, --dir <path>            backup output directory
  -k, --keep <count>          number of latest backups to keep
      --dry-run               print generated unit files without writing/applying
      --print-cron            print a cron fallback line and exit
  -h, --help                  show this help message

Environment overrides:
  SERVICE_NAME
  ON_CALENDAR
  BACKUP_DIR
  KEEP_COUNT
USAGE
}

print_cron_line() {
  local cron_expr="0 3 * * *"
  local backup_cmd="cd ${REPO_ROOT} && ${REPO_ROOT}/scripts/backup-config.sh --dir ${BACKUP_DIR} --keep ${KEEP_COUNT}"
  echo "# Cron fallback (runs at 03:00 local time):"
  echo "${cron_expr} ${backup_cmd}"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -n|--name)
        [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
        SERVICE_NAME="$2"
        shift 2
        ;;
      -s|--schedule)
        [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
        ON_CALENDAR="$2"
        shift 2
        ;;
      -d|--dir)
        [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
        BACKUP_DIR="$2"
        shift 2
        ;;
      -k|--keep)
        [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 1; }
        KEEP_COUNT="$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN="true"
        shift
        ;;
      --print-cron)
        print_cron_line
        exit 0
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

validate_inputs() {
  if ! [[ "${KEEP_COUNT}" =~ ^[0-9]+$ ]]; then
    echo "KEEP_COUNT must be a non-negative integer: ${KEEP_COUNT}" >&2
    exit 1
  fi

  if [[ -z "${SERVICE_NAME}" ]]; then
    echo "SERVICE_NAME cannot be empty." >&2
    exit 1
  fi

  if [[ ! -x "${REPO_ROOT}/scripts/backup-config.sh" ]]; then
    echo "Missing executable backup script: ${REPO_ROOT}/scripts/backup-config.sh" >&2
    exit 1
  fi
}

write_unit_files() {
  local unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
  local service_file="${unit_dir}/${SERVICE_NAME}.service"
  local timer_file="${unit_dir}/${SERVICE_NAME}.timer"
  local service_content
  local timer_content

  service_content="$(cat <<SERVICE
[Unit]
Description=CodeHarbor config snapshot backup
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${REPO_ROOT}
ExecStart=${REPO_ROOT}/scripts/backup-config.sh --dir ${BACKUP_DIR} --keep ${KEEP_COUNT}
SERVICE
)"

  timer_content="$(cat <<TIMER
[Unit]
Description=CodeHarbor config backup schedule (${ON_CALENDAR})

[Timer]
OnCalendar=${ON_CALENDAR}
Persistent=true
RandomizedDelaySec=300
Unit=${SERVICE_NAME}.service

[Install]
WantedBy=timers.target
TIMER
)"

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[dry-run] service file: ${service_file}"
    echo "${service_content}"
    echo
    echo "[dry-run] timer file: ${timer_file}"
    echo "${timer_content}"
    return
  fi

  mkdir -p "${unit_dir}" "${BACKUP_DIR}"
  printf "%s\n" "${service_content}" > "${service_file}"
  printf "%s\n" "${timer_content}" > "${timer_file}"

  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl not found. Use cron fallback instead:" >&2
    print_cron_line >&2
    exit 1
  fi

  systemctl --user daemon-reload
  systemctl --user enable --now "${SERVICE_NAME}.timer"

  echo "Installed timer units:"
  echo "- ${service_file}"
  echo "- ${timer_file}"
  echo "Active timer status:"
  systemctl --user status "${SERVICE_NAME}.timer" --no-pager || true
}

main() {
  parse_args "$@"
  validate_inputs
  write_unit_files
}

main "$@"
