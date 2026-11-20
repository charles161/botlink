#!/usr/bin/env bash
# Secret and internal-material scan of a tree that is (or will be) public.   scan.sh <dir>
# 1. scan.py next to this file (always; needs only python3): secrets, secret files, private email addresses, home paths,
#    chat-message ids, and the private names (hashed in scan-names.txt). Its reviewed exceptions: scan-allow.txt.
# 2. gitleaks (git history when <dir> is a repository, and the files), when found on PATH or in $SCAN_TOOLS.
# 3. trufflehog (files, --no-verification: nothing is sent anywhere), when found on PATH or in $SCAN_TOOLS.
# A tool that is not installed is named as skipped; SCAN_REQUIRE=gitleaks makes a missing gitleaks a failure (CI).
# Exit 1 on any finding.
set -uo pipefail
dir="${1:?usage: scan.sh <dir>}"
here="$(cd "$(dirname "$0")" && pwd)"
tools="${SCAN_TOOLS:-}"
find_tool() { command -v "$1" 2>/dev/null || { [ -n "$tools" ] && [ -x "$tools/$1" ] && echo "$tools/$1"; }; }
rc=0
echo "== scan.py (secrets, secret files, emails, home paths, message ids, private names)"
python3 -I "$here/scan.py" "$dir" || rc=1
if gl="$(find_tool gitleaks)"; then
  if git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
    echo "== gitleaks (git history)"; "$gl" detect --no-banner --redact -c "$here/gitleaks.toml" -s "$dir" || rc=1
  fi
  echo "== gitleaks (files)"; "$gl" detect --no-git --no-banner --redact -c "$here/gitleaks.toml" -s "$dir" || rc=1
else
  echo "== gitleaks: not installed (skipped)"
  case ",${SCAN_REQUIRE:-}," in *,gitleaks,*) echo "SCAN_REQUIRE names gitleaks"; rc=1 ;; esac
fi
if th="$(find_tool trufflehog)"; then
  echo "== trufflehog (files, no verification)"
  "$th" filesystem "$dir" --no-update --no-verification --fail --json 2>/dev/null | grep '"DetectorName"' && rc=1
else
  echo "== trufflehog: not installed (skipped)"
  case ",${SCAN_REQUIRE:-}," in *,trufflehog,*) echo "SCAN_REQUIRE names trufflehog"; rc=1 ;; esac
fi
[ $rc = 0 ] && echo "SCAN CLEAN" || echo "SCAN FOUND ISSUES (above)"
exit $rc
