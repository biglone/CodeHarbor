#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/codeharbor}"
PACKAGE_SPEC="${PACKAGE_SPEC:-codeharbor@latest}"
RUN_USER="${RUN_USER:-${SUDO_USER:-${USER:-}}}"
RUN_INIT="false"
DRY_RUN="false"

usage() {
  cat <<'USAGE'
Usage: scripts/install-linux.sh [options]

Install CodeHarbor on Linux, create runtime directory, and set ownership.

Options:
  -d, --app-dir <path>      Runtime directory for .env and state (default: /opt/codeharbor)
  -p, --package <spec>      npm package spec to install globally (default: codeharbor@latest)
  -u, --run-user <user>     Owner of app directory (default: SUDO_USER or current user)
      --init                Run `codeharbor init` in app directory after install
      --dry-run             Print actions without making changes
  -h, --help                Show this help message

Environment overrides:
  APP_DIR
  PACKAGE_SPEC
  RUN_USER
USAGE
}

log() {
  echo "[install-linux] $*"
}

fail() {
  echo "[install-linux] ERROR: $*" >&2
  exit 1
}

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return 0
  fi

  return 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -d|--app-dir)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        APP_DIR="$2"
        shift 2
        ;;
      -p|--package)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        PACKAGE_SPEC="$2"
        shift 2
        ;;
      -u|--run-user)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        RUN_USER="$2"
        shift 2
        ;;
      --init)
        RUN_INIT="true"
        shift
        ;;
      --dry-run)
        DRY_RUN="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown option: $1"
        ;;
    esac
  done
}

validate() {
  [[ "$(uname -s)" == "Linux" ]] || fail "This script only supports Linux."
  command -v npm >/dev/null 2>&1 || fail "npm is required. Install Node.js 22+ first."
  [[ -n "${RUN_USER}" ]] || fail "Cannot resolve run user."
  id "${RUN_USER}" >/dev/null 2>&1 || fail "User not found: ${RUN_USER}"
}

ensure_app_dir() {
  local run_group
  run_group="$(id -gn "${RUN_USER}")"

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[dry-run] ensure directory ${APP_DIR} owned by ${RUN_USER}:${run_group}"
    return
  fi

  if ! run_as_root install -d -m 755 -o "${RUN_USER}" -g "${run_group}" "${APP_DIR}"; then
    fail "Cannot create ${APP_DIR} with target ownership ${RUN_USER}:${run_group}."
  fi
}

install_package() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[dry-run] npm install -g ${PACKAGE_SPEC}"
    return
  fi

  if npm install -g "${PACKAGE_SPEC}"; then
    return
  fi

  log "Global install without elevation failed, retrying with sudo/root."
  if ! run_as_root npm install -g "${PACKAGE_SPEC}"; then
    fail "Failed to install ${PACKAGE_SPEC} globally."
  fi
}

run_init_if_requested() {
  if [[ "${RUN_INIT}" != "true" ]]; then
    return
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[dry-run] cd ${APP_DIR} && codeharbor init"
    return
  fi

  if ! command -v codeharbor >/dev/null 2>&1; then
    fail "`codeharbor` command not found after install. Check npm global PATH."
  fi

  log "Running init wizard in ${APP_DIR}"
  (
    cd "${APP_DIR}"
    codeharbor init
  )
}

print_summary() {
  local resolved_bin
  resolved_bin="$(command -v codeharbor || true)"

  log "Install complete."
  log "App directory: ${APP_DIR}"
  if [[ -n "${resolved_bin}" ]]; then
    log "CLI binary: ${resolved_bin}"
  else
    log "CLI binary not found in current PATH (you may need a new shell session)."
  fi

  cat <<EOF
Next steps:
  cd ${APP_DIR}
  codex login
  codeharbor init
  codeharbor doctor
  codeharbor start
EOF
}

main() {
  parse_args "$@"
  validate
  ensure_app_dir
  install_package
  run_init_if_requested
  print_summary
}

main "$@"
