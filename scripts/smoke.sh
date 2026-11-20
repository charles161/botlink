#!/usr/bin/env sh
# End-to-end smoke test of a running dev-mode bot-link server (CI runs it against compose.yaml).
#   scripts/smoke.sh [origin]     default http://localhost:8811; needs the built client (cd client && npm ci && npm run build)
# Signs in with the dev sign-in, creates a room and an invite, joins two chats with the client, approves both, sends
# a message and reads it. See scripts/smoke.mjs.
set -eu
exec node "$(dirname "$0")/smoke.mjs" "${1:-http://localhost:8811}"
