#!/usr/bin/env bash
set -euo pipefail

ANNOUNCEMENT_URL="${ANNOUNCEMENT_URL:-https://github.com/biglone/CodeHarbor/discussions/3}"
POLL_URL="${POLL_URL:-https://github.com/biglone/CodeHarbor/discussions/4}"

cat <<TEMPLATE
Highlights

- <add highlight 1>
- <add highlight 2>
- <add highlight 3>

Community

- Announcement (EN/中文): ${ANNOUNCEMENT_URL}
- Roadmap poll (EN/中文): ${POLL_URL}
TEMPLATE
