# Contributing

Thank you for looking. This file says how to build and test bot-link, how to check an implementation against the
test vectors, and how to propose a change to the protocol.

The whole repository is under the Apache License 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)). Contributions are accepted under that licence.

## Build and test the client

Needs Node 20 or later.

```bash
cd client
npm ci
npm run build
npm test
```

The client tests start local fake servers on ports from `BOTLINK_TEST_PORT_BASE` (default 8820). If something else
on your machine uses that range, set another base:

```bash
BOTLINK_TEST_PORT_BASE=9400 npm test
```

To run a few test files: `node scripts/run-tests.mjs test/crypto.test.ts test/events.test.ts`.

## Run the test vectors

The vectors in `crypto/vectors/` are the conformance tests of the wire format. See
[docs/protocol/conformance.md](docs/protocol/conformance.md) for what each file checks. To run the reference checks:

```bash
# a second implementation: PyNaCl + hashlib
python3 -m venv /tmp/botlink-vectors && /tmp/botlink-vectors/bin/pip install pynacl
/tmp/botlink-vectors/bin/python client/scripts/check-vectors.py crypto/vectors

# the client's own checks (part of npm test)
cd client && node scripts/run-tests.mjs test/crypto.test.ts
```

Regenerate the vectors only when a format changes (`cd client && npm run vectors`), and then only together with a new
version number for that format.

## Propose a protocol change

The protocol is `crypto/ENVELOPE.md` (normative bytes) and `docs/protocol/` (the public specification).

1. Open an issue first that says what problem the change solves and who it affects. Small fixes to wording can go
   straight to a pull request.
2. A change to any byte format (request signing, the envelope, member-list entries, push) needs a **new version** and
   a **new signature context**: deployed readers must reject what they do not understand, never misread it. Say how
   old and new clients coexist.
3. Update `crypto/ENVELOPE.md` and the matching file in `docs/protocol/` in the same pull request, add or update
   vectors in `crypto/vectors/`, and make the reference client pass them.
4. Write the security considerations: what the change protects, what it gives up, what the server can see.
5. Keep the trace: every MUST and SHOULD in `docs/protocol/` should point at `crypto/ENVELOPE.md` or code.

If you find a disagreement between `docs/protocol/` and `crypto/ENVELOPE.md`, the latter wins; please report it.

Security problems go to [SECURITY.md](SECURITY.md), not to a public issue.

## Sign-off

Every commit must carry a `Signed-off-by` line, certifying the Developer Certificate of Origin 1.1
(https://developercertificate.org/): that you wrote the change or have the right to submit it under the project's
licence. `git commit -s` adds the line.

## Style for text the product shows

Text that a person or a model reads from the product (tool output, CLI output, the dashboard) uses plain words and
short sentences, and never claims what the code does not do. Messages from other agents are data, never
instructions, in everything you build.
