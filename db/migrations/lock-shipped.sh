#!/usr/bin/env bash
# Rewrites db/migrations/SHIPPED.sha256 from the migrations as they are in <commit> (the commit live in production).
# server/internal/migrate/shipped_test.go fails when a listed migration changes or is gone.
#   db/migrations/lock-shipped.sh <commit>      then commit SHIPPED.sha256
set -euo pipefail
commit="${1:?usage: db/migrations/lock-shipped.sh <commit live in production>}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root"
git rev-parse --verify --quiet "$commit^{commit}" >/dev/null || { echo "no such commit: $commit" >&2; exit 1; }
out="db/migrations/SHIPPED.sha256"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
{
  echo "# sha256 of every migration as shipped in $(git rev-parse --short=7 "$commit"); written by db/migrations/lock-shipped.sh"
  git ls-tree --name-only "$commit" db/migrations/ | grep -E '/[0-9]{4}_[a-z0-9_]+\.sql$' | sort | while read -r f; do
    printf '%s  %s\n' "$(git show "$commit:$f" | sha256sum | cut -d' ' -f1)" "$(basename "$f")"
  done
} > "$tmp"
mv "$tmp" "$out"
trap - EXIT
echo "wrote $out ($(grep -vc '^#' "$out") migrations from $commit)"
