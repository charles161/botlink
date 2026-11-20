#!/usr/bin/env bash
# Client <-> real server integration tests. Builds the Go server from ../server into a temp dir and runs
# test/integration.test.ts against the private dev Postgres (PLAN §2: 127.0.0.1:55432, db botlink_test_client).
# Never the shared Postgres on 5432; the server binds only 127.0.0.1:8821.
set -euo pipefail
cd "$(dirname "$0")/.."
GO="${GO:-$HOME/.local/go/bin/go}"
PG="${BOTLINK_IT_PG:-postgres://botlink@127.0.0.1:55432}"
/usr/lib/postgresql/16/bin/pg_isready -h 127.0.0.1 -p 55432 >/dev/null || { echo "private dev Postgres is not up (make db-up in the repo root)"; exit 2; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
(cd .. && "$GO" build -o "$TMP/botlink-server" ./server/cmd/botlink)
npm run build >/dev/null
BOTLINK_IT_SERVER="$TMP/botlink-server" BOTLINK_IT_PG="$PG" node scripts/run-tests.mjs test/integration.test.ts "$@"
