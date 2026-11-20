# build_release <sha> <srcdir>: Go server + client tarball from a clean checkout into $PROD/bin/<sha>/ (sourced).
build_release() {
  local sha="$1" src="$2" rel="$PROD/bin/$1"
  local tmp="$PROD/bin/.$1.tmp"
  rm -rf "$tmp"; mkdir -p "$tmp/dl"
  log "build server $sha"
  ( cd "$src" && CGO_ENABLED=0 GOFLAGS=-mod=readonly "$GO" build -trimpath \
      -ldflags "-s -w" -o "$tmp/botlink" ./server/cmd/botlink ) || return 1
  if [ "${BL_ENV:-prod}" = staging ]; then pin_staging_key "$src" || return 1; fi
  log "build client tarball $sha"
  ( cd "$src/client" && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run -s build >/dev/null &&
    npm pack --silent --pack-destination "$tmp/dl" >/dev/null ) || return 1
  local tgz; tgz="$(ls "$tmp"/dl/*.tgz | head -1)"
  [ -n "$tgz" ] || return 1
  mv "$tgz" "$tmp/dl/botlink.tgz"
  tar -tzf "$tmp/dl/botlink.tgz" | grep -x "package/dist/cli.js" >/dev/null || { log "tarball has no dist/cli.js"; return 1; }
  # every dependency pinned with its integrity hash travels in the tarball (client/scripts/make-shrinkwrap.mjs, prepack)
  tar -tzf "$tmp/dl/botlink.tgz" | grep -x "package/npm-shrinkwrap.json" >/dev/null || { log "tarball has no npm-shrinkwrap.json"; return 1; }
  if [ "${BL_ENV:-prod}" = staging ]; then staging_client_pins_only "$tmp/dl/botlink.tgz" || return 1; fi
  if ! sign_release "$tmp" "$src"; then
    # BOTLINK_RELEASE_SIGNING=external only: keep the unsigned build so the tarball signed elsewhere is this exact one;
    # the deploy still stops here. Its next run finds the release built and takes the manifest (deploy.sh).
    if [ "${BOTLINK_RELEASE_SIGNING:-}" = external ]; then
      ( cd "$tmp" && sha256sum botlink dl/botlink.tgz > SHA256SUMS )
      printf 'sha=%s\nbuilt=%s\ngo=%s\nnode=%s\nsigned=waiting for an external manifest\n' "$sha" "$(date -u +%FT%TZ)" "$("$GO" version | awk '{print $3}')" "$(node -v)" > "$tmp/BUILDINFO"
      rm -rf "$rel"; mv "$tmp" "$rel"
      log "release $sha is built but NOT signed; it stays unpublished until its manifest is in place (deploy/RELEASE-KEY.md)"
    fi
    return 1
  fi
  ( cd "$tmp" && sha256sum botlink dl/botlink.tgz dl/botlink.manifest.json > SHA256SUMS )
  printf 'sha=%s\nbuilt=%s\ngo=%s\nnode=%s\n' "$sha" "$(date -u +%FT%TZ)" "$("$GO" version | awk '{print $3}')" "$(node -v)" > "$tmp/BUILDINFO"
  rm -rf "$rel"; mv "$tmp" "$rel"
}

# sign_release <dir holding dl/botlink.tgz> <srcdir>: write dl/botlink.manifest.json, signed with the release key
# (deploy/release-sign.mjs; key in ~/.botlink-release-key or $BOTLINK_RELEASE_KEY_DIR, never printed, never copied).
# Installed clients take no unsigned update (SPEC 7.6), so a release without a manifest must never go out: any failure
# here fails the build. Refuses when the key on this machine is not one the client being built pins: such a manifest
# would verify here and be refused by every installed client.
#
# BOTLINK_RELEASE_SIGNING=external (default: unset, sign here as above): this machine holds no release key and signs
# nothing. It takes a manifest made on the signing machine from BOTLINK_RELEASE_MANIFEST_DIR ($PROD/manifests) named
# <sha256 of this tarball>.manifest.json, checks it against the tarball with every public key the client pins, and
# copies it into the release. No manifest yet: it logs the tarball's sha256 and where the manifest goes, and fails.
sign_release() {
  [ "${BOTLINK_RELEASE_SIGNING:-}" = external ] && { take_external_manifest "$@"; return; }
  local dir="$1" src="$2" tool="$2/deploy/release-sign.mjs" pk
  pk="$(node "$tool" pubkey 2>/dev/null | sed -n 's/.*"pk":"\([0-9a-f]\{64\}\)".*/\1/p')"
  [ -n "$pk" ] || { log "no release key on this machine (see deploy/README.md, Signing a client release); not building an unsigned release"; return 1; }
  grep -q "$pk" "$src/client/src/release.ts" || { log "the release key on this machine is not pinned in client/src/release.ts of this commit; installed clients would refuse the release"; return 1; }
  log "sign client release"
  node "$tool" sign --tarball "$dir/dl/botlink.tgz" >/dev/null || { log "signing the release manifest failed"; return 1; }
  node "$tool" verify --manifest "$dir/dl/botlink.manifest.json" --tarball "$dir/dl/botlink.tgz" --pk "$pk" >/dev/null ||
    { log "the signed manifest does not verify against the tarball"; rm -f "$dir/dl/botlink.manifest.json"; return 1; }
}

take_external_manifest() {
  local dir="$1" src="$2" tool="$2/deploy/release-sign.mjs" tsha in pk
  tsha="$(sha256sum < "$dir/dl/botlink.tgz" | cut -d' ' -f1)"
  in="${BOTLINK_RELEASE_MANIFEST_DIR:-$PROD/manifests}/$tsha.manifest.json"
  if [ ! -f "$in" ]; then
    log "external signing: no manifest for this tarball yet. Tarball $dir/dl/botlink.tgz, sha256 $tsha."
    log "external signing: on the signing machine check that sha256, run: node deploy/release-sign.mjs sign --tarball botlink.tgz"
    log "external signing: then copy the botlink.manifest.json it writes to $in and deploy again"
    return 1
  fi
  for pk in $(sed -n 's/.*pk: *"\([0-9a-f]\{64\}\)".*/\1/p' "$src/client/src/release.ts"); do
    if node "$tool" verify --manifest "$in" --tarball "$dir/dl/botlink.tgz" --pk "$pk" >/dev/null 2>&1; then
      install -m 0644 "$in" "$dir/dl/botlink.manifest.json" || return 1
      log "external signing: manifest accepted for tarball $tsha (key pinned in client/src/release.ts)"
      return 0
    fi
  done
  log "external signing: $in does not verify against this tarball with any key pinned in client/src/release.ts; not using it"
  return 1
}

# ── staging (lib/common.sh --env staging): the client built for staging trusts the staging release key INSTEAD of the
# keys client/src/release.ts pins, so a staging client refuses a prod-signed manifest and a prod client refuses every
# staging-signed one. Done in the build's own throwaway checkout, never in a tracked file; the prod build never runs it.
# pin_staging_key <srcdir>: replace RELEASE_KEYS with the staging public key (from BOTLINK_RELEASE_KEY_DIR, which
# lib/common.sh points at the staging key dir); refuses unless exactly one RELEASE_KEYS list is there and no other key
# is left in the file afterwards.
pin_staging_key() {
  local src="$1" pk
  pk="$(node "$src/deploy/release-sign.mjs" pubkey 2>/dev/null | sed -n 's/.*"pk":"\([0-9a-f]\{64\}\)".*/\1/p')"
  [ -n "$pk" ] || { log "staging: no staging release key in $BOTLINK_RELEASE_KEY_DIR (deploy/install.sh --env staging makes it)"; return 1; }
  python3 -I - "$src/client/src/release.ts" "$pk" <<'PY2' || { log "staging: could not pin the staging key in client/src/release.ts"; return 1; }
import re, sys, hashlib
path, pk = sys.argv[1], sys.argv[2]
s = open(path).read()
pat = re.compile(r"(export const RELEASE_KEYS: \{ id: string; pk: string \}\[\] = \[)(.*?)(\n\];)", re.S)
if len(pat.findall(s)) != 1:
    sys.exit("RELEASE_KEYS not found exactly once")
kid = hashlib.sha256(bytes.fromhex(pk)).hexdigest()[:16]
s = pat.sub(lambda m: m.group(1) + '\n  { id: "%s", pk: "%s" },' % (kid, pk) + m.group(3), s)
if set(re.findall(r"[0-9a-f]{64}", s)) != {pk}:
    sys.exit("another key is still in release.ts")
open(path, "w").write(s)
PY2
  log "staging: the client of this build pins only the staging release key ${pk:0:16}"
}

# staging_client_pins_only <tarball>: the built client holds the staging key and no other (checked on the bytes that ship)
staging_client_pins_only() {
  local pk keys
  pk="$(node "$LIBDIR/../release-sign.mjs" pubkey 2>/dev/null | sed -n 's/.*"pk":"\([0-9a-f]\{64\}\)".*/\1/p')"
  keys="$(tar -xzOf "$1" package/dist/release.js 2>/dev/null | grep -oE '[0-9a-f]{64}' | sort -u)"
  [ -n "$pk" ] && [ "$keys" = "$pk" ] || { log "staging: the built client does not pin exactly the staging key; not releasing it"; return 1; }
}
