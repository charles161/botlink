# Publishing the client to npm (`@botlink/cli`)

Published: `@botlink/cli@1.0.0` has been on npm since 20 Nov 2026 and is `latest`; `1.0.2` (the stale-client fix and the
npm 12 flag on every printed URL command) is published from the commit that goes live with it. `1.0.1` was recorded for
the stale-client fix but never released anywhere; it is skipped. The invite page still names the
server's own download (`npx -y --allow-remote=all https://api.botlink.dev/dl/botlink-<16 hex>.tgz …`); the README's "By hand" block names
the npm command, always with its version.

Two older versions exist on npm, `0.0.1` and `0.0.0-stage`: placeholders with no command. A computer that ran
`npx @botlink/cli` (no version) while a placeholder was `latest` can keep that copy in npm's npx cache. npm 8 then runs
the cached copy again and fails ("botlink: not found"; other npm versions may say "could not determine executable to
run"). The fix on that computer is the command with its version, `npx -y @botlink/cli@1.0.0 --help`, or
`rm -rf ~/.npm/_npx`. A version or `@latest` is looked up again and works (checked against a cache holding 0.0.1 with
npm 8.19, 9.6, 9.9, 10.2, 10.8 and 11.6). This is why every line bot-link prints or documents carries the version.

## Every client release has its own version (from 1.0.1, incident 21 Nov 2026)

1.0.0 shipped several different clients under one version, and a chat kept running an old one from npx's cache with
nothing to tell them apart. Now a client that changes gets a new version, enforced three times:
`client/release-fingerprint.json` records the version released last and a fingerprint of the client's files; the client
test `test/releaseversion.test.ts` and `evals/gate.sh` fail with "client changed since <v> was released: bump the
version in package.json and run `cd client && npm run release:bump`"; and `deploy/deploy.sh` compares the new tarball
with the live one (`deploy/lib/build.sh check_client_version`) and refuses a changed client under the live version
before anything is switched. `npm run release:bump` sets the next patch version in `package.json`, `package-lock.json`
and the README's pinned lines and records the fingerprint; commit those four files. The repo carries the version: there
is no `npm version` step at publish time.

## The command (Charles, from a clean checkout of the commit that is live in prod)

```bash
cd client && npm ci && npm test
npm run release:check                       # "client 1.0.2: unchanged since it was recorded"
npm run pack:npm                           # prints .../client/botlink-cli-1.0.2.tgz (renamed copy, checked)
npm publish botlink-cli-1.0.2.tgz --access public
```

The `/dl` tarball of that commit and npm then carry the same version and the same files. `npm publish` straight
from `client/` is refused on purpose (`prepublishOnly`): the repo package is named `botlink`, which installed clients
check before they take an update.

`client/test/npmpack.test.ts` checks the package on every test run: `bin`, the `files` allow-list, and an
`npm pack --dry-run` listing with only `dist/*.js`, `README.md`, `LICENSE`, `package.json` (and the shrinkwrap at pack
time); no tests, no sources, no private keys, size under 3 MB.

## What the npm copy does on first run

- `npx -y @botlink/cli@1.0.0 …`: npm's bytes run first. They are checked only by npm (registry plus the
  `npm-shrinkwrap.json` hashes), **not** by bot-link's release key. `setup` copies them to `~/.botlink/client/current` (a `join` alone does not);
  the background check then asks the server for the **signed** release and, as that copy
  has no recorded release, installs it. From then on every update is signed, exactly as with the `/dl` tarball.
- `npm install -g @botlink/cli`: does **not** go through the signed-update check. bot-link never updates a global npm
  install (it runs as a checkout would); it stays at the version npm installed until
  `npm install -g @botlink/cli@<new>`. `botlink update` says so.

## The risk of two install paths drifting

The `/dl` tarball is built and signed by every deploy; npm gets a version only when someone publishes. If they drift:
- an npx user gets an older npm copy, then the signed update replaces it (harmless, one extra step);
- a global npm install stays old, and it has no release number (only an install made by a signed update has one). With
  a server minimum release (`BOTLINK_MIN_CLIENT_RELEASE`) set on a server that is not a dev server, every global npm
  install is refused with "too old", whatever its version, until it is replaced by the `/dl` install.
- the docs: the README's "By hand" block, `docs/agents.md` and `docs/llms.txt` name `@botlink/cli`, and
  `client/test/npmpack.test.ts` holds the README's lines to the package version. The invite text in
  `server/internal/pages/pages.go` names only the server's download; if the invite page is to name npm, change it
  together with these. Pin the version in every line (`@botlink/cli@1.0.0`): npx caches by spec.
