#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/codeharbor}"
PACKAGE_SPEC="${PACKAGE_SPEC:-codeharbor@latest}"
RUN_USER="${RUN_USER:-${SUDO_USER:-${USER:-}}}"
CODEX_WORKDIR="${CODEX_WORKDIR:-${APP_DIR}}"
CODEX_BIN_VALUE="${CODEX_BIN_VALUE:-}"
MATRIX_COMMAND_PREFIX="${MATRIX_COMMAND_PREFIX:-!code}"
MATRIX_HOMESERVER="${MATRIX_HOMESERVER:-}"
MATRIX_USER_ID="${MATRIX_USER_ID:-}"
MATRIX_ACCESS_TOKEN="${MATRIX_ACCESS_TOKEN:-}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
INSTALL_SERVICE="true"
ENABLE_ADMIN_SERVICE="false"
START_NOW="true"
SKIP_CODEX_CHECK="false"
DRY_RUN="false"

usage() {
  cat <<'USAGE'
Usage: scripts/install-linux-easy.sh [options]

One-shot Linux installer for CodeHarbor:
1) install package globally
2) generate runtime .env
3) install and enable systemd service(s)

Options:
  -d, --app-dir <path>             Runtime directory (default: /opt/codeharbor)
  -p, --package <spec>             npm package spec (default: codeharbor@latest)
  -u, --run-user <user>            Service and runtime owner (default: SUDO_USER or current user)
      --codex-workdir <path>       Default CODEX_WORKDIR written to .env
      --codex-bin <path>           CODEX_BIN value written to .env (auto-detect by default)
      --matrix-homeserver <url>    MATRIX_HOMESERVER value
      --matrix-user-id <id>        MATRIX_USER_ID value
      --matrix-access-token <tok>  MATRIX_ACCESS_TOKEN value
      --matrix-command-prefix <p>  MATRIX_COMMAND_PREFIX value (default: !code)
      --admin-token <token>        ADMIN_TOKEN value
      --enable-admin-service       Install/start codeharbor-admin.service
      --no-service                 Skip systemd service installation
      --no-start                   Install services but do not start immediately
      --skip-codex-check           Skip `codex` executable check
      --dry-run                    Print planned actions without changes
  -h, --help                       Show this help message

Examples:
  scripts/install-linux-easy.sh \
    --matrix-homeserver https://matrix.example.com \
    --matrix-user-id @bot:example.com \
    --matrix-access-token 'xxx'

  scripts/install-linux-easy.sh \
    --app-dir /srv/codeharbor \
    --enable-admin-service \
    --admin-token 'strong-token' \
    --matrix-homeserver https://matrix.example.com \
    --matrix-user-id @bot:example.com \
    --matrix-access-token 'xxx'
USAGE
}

log() {
  echo "[install-easy] $*"
}

fail() {
  echo "[install-easy] ERROR: $*" >&2
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

quote_env_value() {
  local value="${1:-}"
  if [[ -z "${value}" ]]; then
    echo ""
    return 0
  fi
  if [[ "${value}" =~ ^[A-Za-z0-9_./:@+-]+$ ]]; then
    echo "${value}"
    return 0
  fi
  local escaped="${value//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  echo "\"${escaped}\""
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
      --codex-workdir)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        CODEX_WORKDIR="$2"
        shift 2
        ;;
      --codex-bin)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        CODEX_BIN_VALUE="$2"
        shift 2
        ;;
      --matrix-homeserver)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        MATRIX_HOMESERVER="$2"
        shift 2
        ;;
      --matrix-user-id)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        MATRIX_USER_ID="$2"
        shift 2
        ;;
      --matrix-access-token)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        MATRIX_ACCESS_TOKEN="$2"
        shift 2
        ;;
      --matrix-command-prefix)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        MATRIX_COMMAND_PREFIX="$2"
        shift 2
        ;;
      --admin-token)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        ADMIN_TOKEN="$2"
        shift 2
        ;;
      --enable-admin-service)
        ENABLE_ADMIN_SERVICE="true"
        shift
        ;;
      --no-service)
        INSTALL_SERVICE="false"
        shift
        ;;
      --no-start)
        START_NOW="false"
        shift
        ;;
      --skip-codex-check)
        SKIP_CODEX_CHECK="true"
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

  if [[ "${INSTALL_SERVICE}" == "true" ]] && ! command -v systemctl >/dev/null 2>&1; then
    fail "systemctl is required for service automation. Use --no-service to skip."
  fi

  if [[ -n "${CODEX_BIN_VALUE}" ]]; then
    if [[ "${SKIP_CODEX_CHECK}" != "true" ]] && ! "${CODEX_BIN_VALUE}" --version >/dev/null 2>&1; then
      fail "Configured --codex-bin is not executable: ${CODEX_BIN_VALUE}"
    fi
    return
  fi

  local detected_codex
  detected_codex="$(command -v codex || true)"
  if [[ -z "${detected_codex}" ]]; then
    if [[ "${SKIP_CODEX_CHECK}" != "true" ]]; then
      fail "Cannot find \`codex\` in PATH. Install Codex CLI first (or pass --skip-codex-check)."
    fi
    CODEX_BIN_VALUE="codex"
    return
  fi

  CODEX_BIN_VALUE="${detected_codex}"
}

prompt_if_missing() {
  if [[ -z "${MATRIX_HOMESERVER}" ]]; then
    read -r -p "Matrix homeserver URL (e.g. https://matrix.example.com): " MATRIX_HOMESERVER
  fi
  if [[ -z "${MATRIX_USER_ID}" ]]; then
    read -r -p "Matrix bot user id (e.g. @bot:example.com): " MATRIX_USER_ID
  fi
  if [[ -z "${MATRIX_ACCESS_TOKEN}" ]]; then
    read -r -s -p "Matrix access token: " MATRIX_ACCESS_TOKEN
    echo
  fi
}

validate_matrix_config() {
  [[ -n "${MATRIX_HOMESERVER}" ]] || fail "MATRIX_HOMESERVER is required."
  [[ -n "${MATRIX_USER_ID}" ]] || fail "MATRIX_USER_ID is required."
  [[ -n "${MATRIX_ACCESS_TOKEN}" ]] || fail "MATRIX_ACCESS_TOKEN is required."
}

ensure_directories() {
  local run_group
  run_group="$(id -gn "${RUN_USER}")"

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[dry-run] ensure runtime directory ${APP_DIR} owned by ${RUN_USER}:${run_group}"
    log "[dry-run] ensure CODEX_WORKDIR directory ${CODEX_WORKDIR} exists"
    return
  fi

  run_as_root install -d -m 755 -o "${RUN_USER}" -g "${run_group}" "${APP_DIR}" \
    || fail "Cannot create ${APP_DIR} with owner ${RUN_USER}:${run_group}."

  run_as_root install -d -m 755 -o "${RUN_USER}" -g "${run_group}" "${CODEX_WORKDIR}" \
    || fail "Cannot create ${CODEX_WORKDIR}."
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
  run_as_root npm install -g "${PACKAGE_SPEC}" || fail "Failed to install ${PACKAGE_SPEC} globally."
}

write_env_file() {
  local env_path="${APP_DIR}/.env"
  local tmp_file
  tmp_file="$(mktemp)"

  cat >"${tmp_file}" <<EOF
MATRIX_HOMESERVER=$(quote_env_value "${MATRIX_HOMESERVER}")
MATRIX_USER_ID=$(quote_env_value "${MATRIX_USER_ID}")
MATRIX_ACCESS_TOKEN=$(quote_env_value "${MATRIX_ACCESS_TOKEN}")
MATRIX_COMMAND_PREFIX=$(quote_env_value "${MATRIX_COMMAND_PREFIX}")
CODEX_WORKDIR=$(quote_env_value "${CODEX_WORKDIR}")
CODEX_BIN=$(quote_env_value "${CODEX_BIN_VALUE}")
ADMIN_BIND_HOST=127.0.0.1
ADMIN_PORT=8787
EOF

  if [[ -n "${ADMIN_TOKEN}" ]]; then
    echo "ADMIN_TOKEN=$(quote_env_value "${ADMIN_TOKEN}")" >>"${tmp_file}"
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[dry-run] write ${env_path} with generated config"
    sed -n '1,20p' "${tmp_file}"
    rm -f "${tmp_file}"
    return
  fi

  if [[ -f "${env_path}" ]]; then
    cp "${env_path}" "${env_path}.bak.$(date +%Y%m%d%H%M%S)"
  fi

  mv "${tmp_file}" "${env_path}"
  local run_group
  run_group="$(id -gn "${RUN_USER}")"
  run_as_root chown "${RUN_USER}:${run_group}" "${env_path}" || true
}

resolve_codeharbor_bin() {
  local bin
  bin="$(command -v codeharbor || true)"
  [[ -n "${bin}" ]] || fail "`codeharbor` command not found after install."
  echo "${bin}"
}

install_systemd_services() {
  local codeharbor_bin
  codeharbor_bin="$(resolve_codeharbor_bin)"
  local service_main="/etc/systemd/system/codeharbor.service"
  local service_admin="/etc/systemd/system/codeharbor-admin.service"
  local main_tmp
  local admin_tmp

  main_tmp="$(mktemp)"
  cat >"${main_tmp}" <<EOF
[Unit]
Description=CodeHarbor main service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=CODEHARBOR_HOME=${APP_DIR}
ExecStart=${codeharbor_bin} start
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

  if [[ "${ENABLE_ADMIN_SERVICE}" == "true" ]]; then
    admin_tmp="$(mktemp)"
    cat >"${admin_tmp}" <<EOF
[Unit]
Description=CodeHarbor admin service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=CODEHARBOR_HOME=${APP_DIR}
ExecStart=${codeharbor_bin} admin serve
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF
  fi

  if [[ "${ENABLE_ADMIN_SERVICE}" == "true" && "${RUN_USER}" != "root" ]]; then
    install_restart_sudoers_policy
  fi

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[dry-run] install ${service_main}"
    cat "${main_tmp}"
    if [[ "${ENABLE_ADMIN_SERVICE}" == "true" ]]; then
      log "[dry-run] install ${service_admin}"
      cat "${admin_tmp}"
    fi
    rm -f "${main_tmp}" "${admin_tmp:-}"
    return
  fi

  run_as_root install -m 644 "${main_tmp}" "${service_main}" || fail "Failed to install ${service_main}."
  if [[ "${ENABLE_ADMIN_SERVICE}" == "true" ]]; then
    run_as_root install -m 644 "${admin_tmp}" "${service_admin}" || fail "Failed to install ${service_admin}."
  fi

  rm -f "${main_tmp}" "${admin_tmp:-}"

  run_as_root systemctl daemon-reload

  if [[ "${START_NOW}" == "true" ]]; then
    run_as_root systemctl enable --now codeharbor.service
    if [[ "${ENABLE_ADMIN_SERVICE}" == "true" ]]; then
      run_as_root systemctl enable --now codeharbor-admin.service
    fi
    return
  fi

  run_as_root systemctl enable codeharbor.service
  if [[ "${ENABLE_ADMIN_SERVICE}" == "true" ]]; then
    run_as_root systemctl enable codeharbor-admin.service
  fi
}

install_restart_sudoers_policy() {
  local sudoers_file="/etc/sudoers.d/codeharbor-restart"
  local systemctl_bin
  systemctl_bin="$(command -v systemctl || true)"
  [[ -n "${systemctl_bin}" ]] || fail "Cannot resolve systemctl path for sudoers policy."

  local policy_tmp
  policy_tmp="$(mktemp)"
  cat >"${policy_tmp}" <<EOF
# Managed by CodeHarbor installer; do not edit manually.
Defaults:${RUN_USER} !requiretty
${RUN_USER} ALL=(root) NOPASSWD: ${systemctl_bin} restart codeharbor.service, ${systemctl_bin} restart codeharbor-admin.service
EOF

  if [[ "${DRY_RUN}" == "true" ]]; then
    log "[dry-run] install ${sudoers_file}"
    cat "${policy_tmp}"
    rm -f "${policy_tmp}"
    return
  fi

  run_as_root install -m 440 "${policy_tmp}" "${sudoers_file}" || fail "Failed to install ${sudoers_file}."
  rm -f "${policy_tmp}"
}

print_summary() {
  log "All done."
  log "Runtime home: ${APP_DIR}"
  log "Configured CODEX_BIN: ${CODEX_BIN_VALUE}"
  if [[ "${INSTALL_SERVICE}" == "true" ]]; then
    log "systemd service: codeharbor.service (enabled)"
    if [[ "${ENABLE_ADMIN_SERVICE}" == "true" ]]; then
      log "systemd service: codeharbor-admin.service (enabled)"
      if [[ "${RUN_USER}" != "root" ]]; then
        log "sudoers policy: /etc/sudoers.d/codeharbor-restart"
      fi
    fi
  fi

  cat <<EOF
Tips:
  1) Ensure Codex account is logged in:
     codex login
  2) Check service logs:
     journalctl -u codeharbor -f
EOF
}

main() {
  parse_args "$@"
  validate
  prompt_if_missing
  validate_matrix_config
  ensure_directories
  install_package
  write_env_file
  if [[ "${INSTALL_SERVICE}" == "true" ]]; then
    install_systemd_services
  fi
  print_summary
}

main "$@"
