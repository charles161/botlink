# web/ · bot-link dashboard (design C, "Meet in a Room")

Static app in `web/public`, embedded by the Go server (`web/embed.go`, `web.Public`; contract shim unchanged).
No bundler and no framework: plain ES modules + one stylesheet, so what's in git is what ships.

```
public/index.html            shell (CSP-clean: one module script, no inline JS)
public/assets/app.css        design system + every screen (light/dark, reduced motion, phone-first)
public/assets/fonts/         self-hosted Fraunces / Figtree / JetBrains Mono (CSP default-src 'self')
public/assets/js/theme-boot.js  classic <head> script: applies the remembered light/dark choice before first paint
public/assets/js/app.js      boot, session + device key, router, nav, SSE live updates
public/assets/js/crypto.js   encodings, fingerprints, UUIDv7, IndexedDB Ed25519 device key, roster sign + verify
public/assets/js/roster.js   fetch + verify the signed member list, sign at the verified head, retry on roster_conflict
public/assets/js/needs.js    "What needs you" cards + approve flows (join, move, person, new browser)
public/assets/js/humancheck.js  human-check dialog: stub / Turnstile + WebAuthn (register, assert, skip, no-biometrics fallback)
public/assets/apps/           real app icons for the landing + bot badges (sources and licences: apps/SOURCES.md)
public/assets/js/views/*     landing, login, rooms, new-room, room, person-invite, devices, docs, not-found, create (/create/<id>)
```

## Build (reproducible)
There is no compile step. Three scripts:
- `node web/scripts/fetch-fonts.mjs` re-downloads the latin woff2 subsets and regenerates `fonts.css` (only when changing fonts; output is committed).
- `node web/scripts/check.mjs` fails on inline handlers/scripts, innerHTML/eval, external URLs other than Turnstile, forbidden UI words, missing imports, and a trust page that no longer matches the code.
- `node web/scripts/trust-facts.mjs` reads the facts of `public/trust.html` (a draft, linked from the landing's security steps) and the landing's security claims (`public/assets/landing-claims.json`, each with the code it rests on) from the code and stamps the page and `public/assets/trust-facts.json`. Run it after a change the check reports (a new eval result, a new stored field, a changed key), read the diff, commit both. `--sources` prints each fact's file:line.

## Run + test
```
node web/test/fixtures/mock-server.mjs                     # :8829, in-memory /app/v1 per api/openapi.yaml, stub human check
MOCK_HC=real PORT=8827 node web/test/fixtures/mock-server.mjs   # Turnstile test key + WebAuthn
python3 web/test/test_vectors.py                           # crypto/vectors in the browser
python3 web/test/test_e2e.py                               # every page + flow, 390x844 and 1440x900, light + dark
python3 web/test/test_landing.py                           # landing: 390/1440 light+dark, contrast, icons, theme switch
python3 web/test/test_trust.py                             # trust page: 390/1440 light+dark, facts vs sources, its check commands, drift
python3 web/test/test_create.py                            # /create/<id>: a room a chat asked for (own mock on :9921; --real for the first passkey)
python3 web/test/test_humancheck_real.py --base http://localhost:8827
```
Against the real server: `--base http://localhost:<port>` for `test_vectors.py`; `test_e2e.py` uses the fixture
server's `/__mock/*` hooks to create join requests, so on the real server join requests come from the client CLI instead.
Screenshots land in `web/shots/`.

## Classes the server's `/i/{invite}` page may use
`.page .page-narrow .card .invite-card .kicker .h1 .lead .fine .btn .btn-primary .btn-ghost .room-title .hash
.invite-box .invite-line .kw .match-code .mc-char .fp .checklist` (load `/assets/fonts/fonts.css` then `/assets/app.css`).
