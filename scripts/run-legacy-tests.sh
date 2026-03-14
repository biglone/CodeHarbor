#!/usr/bin/env bash
set -euo pipefail

if [[ -x ".venv/bin/python" ]]; then
  PYTHON_BIN=".venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
else
  echo "Legacy tests require Python 3, but python3 was not found." >&2
  exit 1
fi

if ! "${PYTHON_BIN}" -c "import nio" >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Missing Python dependency: matrix-nio (import name: nio).
Install legacy runtime deps first:
  python3 -m pip install -r requirements.txt
EOF
  exit 1
fi

exec "${PYTHON_BIN}" -m pytest -q tests "$@"
