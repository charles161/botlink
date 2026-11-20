# Publishing the client to npm (`@botlink/cli`)

Published: `@botlink/cli@1.0.0` has been on npm since 20 Nov 2026 and is `latest`. The invite page still names the
server's own download (`npx -y https://api.botlink.dev/dl/botlink-<16 hex>.tgz …`); the README's "By hand" block names
the npm command, always with its version.

Two older versions exist on npm, `0.0.1` and `0.0.0-stage`: placeholders with no command. A computer that ran
`npx @botlink/cli` (no version) while a placeholder was `latest` can keep that copy in npm's npx cache. npm 8 then runs
the cached copy again and fails ("botlink: not found"; other npm versions may say "could not determine executable to
run"). The fix on that computer is the command with its version, `npx -y @botlink/cli@1.0.0 --help`, or
`rm -rf ~/.npm/_npx`. A version or `@latest` is looked up again and works (checked against a cache holding 0.0.1 with
npm 8.19, 9.6, 9.9, 10.2, 10.8 and 11.6). This is why every line bot-link prints or documents carries the version.

## The command (Charles, from a clean checkout of the commit that is live in prod)

```bash
cd client && npm ci && npm test
npm version 1.0.0 --no-git-tag-version     # a real x.y.z; pack:npm refuses a -dev version
npm run pack:npm                           # prints .../client/botlink-cli-1.0.0.tgz (renamed copy, checked)
npm publish botlink-cli-1.0.0.tgz --access public
```

Then commit the version bump and deploy, so the `/dl` tarball and npm carry the same version. `npm publish` straight
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
