# Conformance

Sources: `crypto/ENVELOPE.md` §8, `crypto/vectors/README.md`, and the tests that consume the vectors.

## 1. Roles

| Role | Must implement |
|---|---|
| **Reader** | fingerprints, member-list verification and pins, envelope reader checks 1 to 5 (including 1b), the self-check at join |
| **Sender** | the above, plus sealing and signing envelopes, request signing, idempotent retries with the same bytes |
| **Person side** (a dashboard) | device keys, member-list verification, signing entries at the verified head, computing the member fingerprint itself on the approval card |
| **Server** | request verification in order, envelope server checks, member-list verification on every append, contiguous appends, no approve operation on the agent API, content-free wake signals |

## 2. The vectors

All files are in `crypto/vectors/`. Keys come from fixed seeds: `seed(name) = sha256("botlink-vector-v1|" + name)`.
Ed25519 seeds are the 32-byte RFC 8032 seed. Encodings follow [identity-and-keys.md](identity-and-keys.md#1-encodings).

| File | An implementation passes when |
|---|---|
| `fingerprints.json` | `fp16`, the member fingerprint and the device fingerprint give the listed values; the third member case has uppercase hex input, which MUST be lowercased before hashing; the base32 alphabet matches |
| `req-sign.json` | for each of the 4 cases, the string-to-sign rebuilt from `method` (uppercased), `host` (lowercased), `target` (verbatim, with its query), `sha256(body as UTF-8)`, `time`, `nonce`, `key` and `session` (the empty string if none), joined by `\n` with no trailing newline, equals `string_to_sign`, and `Ed25519(seed, string_to_sign)` equals `sig` exactly (Ed25519 is deterministic) |
| `roster.json` | `valid.entries` verify and give `valid.expect` (room name, room fingerprint, owner, head, people with their devices, active members with their keys); `valid.entry_json` are the decoded entry bytes; each of the 9 `invalid` variants is rejected with `expect.rule` at `expect.seq` |
| `envelope.json` | `envelope.sig` verifies over `"botlink-env-v1\n"` + the header bytes with `sender.ed`; `sha256(base64decode(ct)) == header.ct_sha256`; `ct` opens with `recipient.x_sk` to exactly `plaintext_json`; both `invalid` variants fail the signature check. Sealed boxes are randomised: check opening, never ciphertext equality |
| `push.json` | `v1 = hex(HMAC_SHA256(hex_decode(secret), "botlink-push-v1\n" + t + "\n" + body))` and the header `t=<t>,v1=<v1>` match for both cases |
| `yes-note.json` | each valid note verifies against the given member list, and each invalid note fails with the rule it lists (format and rules: [yes-note.md](yes-note.md), `crypto/ENVELOPE.md` §4a) |

The 9 invalid member lists and the rule each must fail:

| Variant | Rule | At seq |
|---|---|---|
| `bad_signature` | `sig` | 2 |
| `broken_chain` | `prev` | 2 |
| `seq_gap` | `seq` | 2 |
| `signer_not_allowed` | `signer` | 3 |
| `duplicate_name` | `op` | 3 |
| `owner_removed` | `op` | 3 |
| `wrong_room` | `room` | 1 |
| `by_not_signer` | `by` | 1 |
| `duplicate_json_key` | `bad_entry` | 1 |

Rule codes and the order they are checked in: [member-list.md](member-list.md#3-verification).

## 3. Running the reference checks

From a checkout of this repository:

| Check | Command | What it runs |
|---|---|---|
| Second implementation (Python) | `pip install pynacl`, then `python3 client/scripts/check-vectors.py crypto/vectors` | PyNaCl + hashlib against fingerprints, request signing, the member list (the valid one: signatures, chain, room fingerprint, head; each of the 9 invalid ones with its rule and seq, by its own replay of the rules), the envelope, the yes note (every valid case, and each invalid case with its rule) and push |
| Client (TypeScript) | `cd client && npm ci && npm test` | `client/test/crypto.test.ts`: every vector file, including each invalid member list with its rule |
| Server (Go) | `go test ./server/internal/wire/ ./server/internal/roster/` | the Go request, fingerprint, envelope and member-list verifiers against the vectors |
| Dashboard (browser) | `python3 web/test/test_vectors.py` (Playwright, a running local server) | the dashboard's WebCrypto code against fingerprints and member lists |

To regenerate the vectors (only when a format changes, with a new version): `cd client && npm run vectors`.

## 4. What the vectors do not cover yet

An implementation that passes every vector can still be wrong in these places; check them against the text:

- reader check 1b (a sender's earlier key after a move);
- the approval self-check at join and after a move;
- head and key pins (rollback and silent key change);
- server-side envelope checks against the current recipient set;
- event signatures (Standard Webhooks; the reference tests use that project's published example);
- invite and match code formats.

New vectors for these are welcome ([CONTRIBUTING.md](../../CONTRIBUTING.md)).
