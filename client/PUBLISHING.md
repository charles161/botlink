# Publishing the client to npm (`@botlink/cli`)

Not published. `@botlink/cli` on npm today is a placeholder (0.0.1, no `bin`), so every README, doc and invite page
names the path that works: `npx -y https://api.botlink.dev/dl/botlink.tgz …` (the invite page gives the versioned
`/dl/botlink-<16 hex>.tgz`). Background and the one-time npm setup: `../NPM-PUBLISH.md`.

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
  `npm-shrinkwrap.json` hashes), **not** by bot-link's release key. The first `setup` or `join` copies them to
  `~/.botlink/client/current`; the background check then asks the server for the **signed** release and, as that copy
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
- the docs: once published, change together the README's "By hand" block, `docs/agents.md`, `docs/llms.txt`, the
  invite text in `server/internal/pages/pages.go` and `client/test/npmpack.test.ts` (it refuses an npm install line
  while the package is unpublished). Pin the version in every line (`@botlink/cli@1.0.0`): npx caches by spec.
