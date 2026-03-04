#!/usr/bin/env bash
set -euo pipefail

CHANGELOG_FILE="${CHANGELOG_FILE:-CHANGELOG.md}"
VERSION="${VERSION:-}"

usage() {
  cat <<'USAGE'
Usage: scripts/check-changelog.sh [options]

Validate that CHANGELOG contains an entry for the target version and that
the version section includes at least one bullet item.

Options:
  -f, --file <path>       Changelog file path (default: CHANGELOG.md)
  -v, --version <x.y.z>   Version to verify (default: package.json version)
  -h, --help              Show this help message

Environment overrides:
  CHANGELOG_FILE
  VERSION
USAGE
}

fail() {
  echo "[check-changelog] ERROR: $*" >&2
  exit 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -f|--file)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        CHANGELOG_FILE="$2"
        shift 2
        ;;
      -v|--version)
        [[ $# -ge 2 ]] || fail "Missing value for $1"
        VERSION="$2"
        shift 2
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

resolve_version() {
  if [[ -n "${VERSION}" ]]; then
    return
  fi

  if ! command -v node >/dev/null 2>&1; then
    fail "node is required to resolve version from package.json."
  fi

  VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
  [[ -n "${VERSION}" ]] || fail "Unable to resolve version from package.json."
}

extract_section() {
  awk -v version="${VERSION}" '
    $0 ~ "^## \\[" version "\\]" {
      found = 1
      next
    }
    found && $0 ~ "^## \\[" {
      exit
    }
    found {
      print
    }
  ' "${CHANGELOG_FILE}"
}

validate() {
  [[ -f "${CHANGELOG_FILE}" ]] || fail "Changelog file not found: ${CHANGELOG_FILE}"

  if ! grep -Eq "^## \\[${VERSION//./\\.}\\]" "${CHANGELOG_FILE}"; then
    fail "Missing changelog entry for version ${VERSION} in ${CHANGELOG_FILE}."
  fi

  local section
  section="$(extract_section)"
  [[ -n "${section}" ]] || fail "Empty changelog section for version ${VERSION}."

  if ! grep -Eq '^[[:space:]]*[-*][[:space:]]+' <<<"${section}"; then
    fail "Changelog section ${VERSION} must include at least one bullet item."
  fi
}

main() {
  parse_args "$@"
  resolve_version
  validate
  echo "[check-changelog] OK: ${CHANGELOG_FILE} contains entry for ${VERSION}."
}

main "$@"
