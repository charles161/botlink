# Contract change requests

Append-only. A builder who finds the contract (SPEC.md, crypto/ENVELOPE.md, api/openapi.yaml,
db/migrations/0001_init.sql, docs/agents.md) wrong or incomplete adds an entry here and tells the orchestrator.

Format: `## <date> · <workstream> · <short title>` then what, why, which files, and the workaround in use.

## 2026-11-05 · C · Copy test vs the mandated "re-delivered" flag
What: PLAN §5.5 fails the build on the whole word `delivered`; SPEC §7.2 / ENVELOPE §4 / docs/agents.md mandate the flag text "re-delivered: you may have handled this already — check before acting again." (`\bdelivered\b` matches inside "re-delivered").
Resolution in use: the client copy test exempts exactly the hyphenated `re-delivered` (client/test/helpers.ts `assertCopy`). Proposed: PLAN §5.5 adds that exemption (W's copy test should do the same if the dashboard ever shows it).
Files: PLAN.md §5.5.

## 2026-11-05 · C · Hook context size caps (Claude Code 10,000 chars, Codex ~2,500 tokens)
What: official docs (code.claude.com/docs/en/hooks; developers.openai.com/codex/hooks): Claude Code moves `additionalContext` over 10,000 chars to a file and gives the model only a 2,000-char preview + path; Codex caps it at ~2,500 tokens and does the same. A big batch acked `shown` after such a hook would break the J7f-3 rule (text not actually in the model's context).
Resolution in use: hooks render at most 9,000 chars; the overflow is `release`d (not acked) and the batch ends with "N more messages are waiting. Call the bot-link inbox tool." The MCP `inbox` tool has no such cap. Proposed: add this to SPEC §7.2.
Files: SPEC.md §7.2.

## 2026-11-05 · C · WAKE_PROMPT gets a fallback clause (Codex hook trust)
What: Codex runs a new/changed hook only after the user trusts it in `/hooks` (developers.openai.com/codex/hooks); untrusted hooks are skipped, also in `codex exec resume`. Then a watch-resumed Codex run would get the wake prompt "…are in your context" with nothing in its context.
Resolution in use: WAKE_PROMPT = "bot-link: new messages for you are in your context. Handle them under the bot-link rules. (If you don't see them, call the bot-link inbox tool.)" The MCP tool works without hook trust. Proposed: SPEC §6.9 uses this text. `up` already tells Codex users to trust the 3 hooks.
Files: SPEC.md §6.9.

## 2026-11-05 · C · Unattended Claude Code resumes need bot-link's own tools pre-allowed
What: `claude -p --resume <sid> "<prompt>"` runs with no one to answer permission prompts, so the model could not call `reply` / `ask_human` (which SPEC §7.3 tells it to do when unattended).
Resolution in use: watch runs `claude -p --resume <sid> --allowedTools mcp__botlink__{send,reply,inbox,roster,ask_human,handover},mcp__botlink-v1__{…} "<WAKE_PROMPT>"` (`leave`, `claim`, `save_rule`, `join` are NOT pre-allowed). Codex: `codex exec resume <sid> "<WAKE_PROMPT>"` unchanged (both verified against the installed CLIs' --help and the official CLI references on 2026-11-05). Proposed: SPEC §6.9 lists the flag.
Files: SPEC.md §6.9.

## 2026-11-05 · C · UserPromptSubmit also fires for prompts the human did not type (P0-6 residual risk)
What: Claude Code docs say UserPromptSubmit fires on "scheduled task firing… background subagent reporting back… a message another session sends", and the hook input does not say which. A standing rule could then be saved from text the human never typed.
Resolution in use: the prompt hook never captures the watch wake prompt, the client's own Codex/Cursor nudge text, or anything in an unattended run; `save_rule` still needs a verbatim ≥12-char substring from this session in the last 30 min. Residual risk remains for the three sources above. Proposed: SPEC §7.4 / SPEC §11 state it; revisit if the hook input gains a source field.
Files: SPEC.md §7.4, §11.

## 2026-11-05 · C · `claude -p` kills async hooks; Stop waiter never runs in print mode
What: docs: "In non-interactive mode with the -p flag, Claude Code kills any async hook still running at teardown." A Stop waiter in a watch-resumed (`-p`) run would only take leases it can never show.
Resolution in use: the Stop waiter exits 0 at once when BOTLINK_WAKE_MEMBER / BOTLINK_UNATTENDED is set or the harness was started with -p/--print; watch covers those members after the run exits. No contract text change needed beyond a note in SPEC §7.2.

## 2026-11-05 · C · Join wait refused (403) after a key swap = loud failure, not "expired"
What: the real server signs-checks `/join-requests/{id}/wait` against the request's key in the DB; after a DB key swap (T8) the chat's own wait gets 403 and never sees the approval.
Resolution in use: the client treats 403 on wait (and `unknown_key` on the first `/me/roster` after approval) like a failed self-check: keys + request deleted, prints "This approval does not match this chat's key. Don't use it; tell your human." Exit 4. No contract change; noting for the T8 row so S/W expect this path.

## 2026-11-05 · C · Roster rule codes for `roster_invalid` details.rule
What: SPEC/ENVELOPE name the checks but not the codes. The client vectors (crypto/vectors/roster.json) use: bad_wire, bad_entry, seq, room, by, prev, sig, signer, op, with the exact check order in crypto/vectors/README.md.
Resolution in use: proposed as the `details.rule` vocabulary for the server and the web verifier.
Files: crypto/ENVELOPE.md §5.3, api/openapi.yaml ErrorCode roster_invalid.

## 2026-11-05 · C · Session id discovery order (CLAUDE_CODE_SESSION_ID is official)
What: Claude Code documents `CLAUDE_CODE_SESSION_ID` for hooks, Bash tools and stdio MCP servers, but an MCP server "retains the ID it was spawned with" (stale after /clear). Codex's `CODEX_THREAD_ID` exists in source only, not in docs.
Resolution in use: hook stdin `session_id` > the harness-pid link written by the latest SessionStart hook (follows /clear) > env (BOTLINK_SESSION, CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, …). PLAN §3.2 lists env before the link; proposed to swap them.
Files: PLAN.md §3.2.

## 2026-11-05 · C · Known gaps (no contract change, documenting)
- A live Claude Code session that has never finished a turn has no Stop waiter yet, and watch skips live sessions, so a message waits for the first prompt there. (A SessionStart asyncRewake waiter would fix it but SPEC §7.2 says rewake is Stop-only, which matches the J7f-3 history.)
- Cursor `sessionStart` is fire-and-forget (cursor.com/docs/hooks): its `additional_context` may race the first request; Cursor has no prompt hook that can add context, so Cursor chats rely on `stop` -> followup_message + the `inbox` tool, and cannot save standing rules (as SPEC §7.4 already says).
- `needs_resend` notices are processed on the sender's next turn (hook or `inbox`); an idle sender re-sends only then.

## 2026-11-05 · W · `/docs` page route (rendered agent docs for people)
What: the SPA fallback list (PLAN §3.5) has no route for a human-readable rendering of `/agents.md`; `/agents.md` itself must stay raw Markdown for agents.
Resolution in use: the web app renders `/agents.md` at `/docs` (fetches the raw file, safe DOM renderer, no innerHTML). In-app navigation works today; a direct load of `/docs` needs S to add `/docs` to the SPA fallback list (returns `index.html`, `X-Robots-Tag` may be omitted since it is open docs). Proposed: PLAN §3.5 adds `/docs`.
Files: PLAN.md §3.5.

## 2026-11-05 · W · Human check fallback when the browser has no platform authenticator
What: SPEC §4.1 requires WebAuthn user verification (register first time, assert when `uv_at` > 60 min) and the brief asks for "Turnstile + fresh re-login" when there are no biometrics. The contract has no way to express that path: `HumanCheckChallenge.webauthn.step` is only register/assert/skip, and `POST /app/v1/human-check` has `additionalProperties: false`, so the browser can't say "no platform authenticator".
Resolution in use: when `step` is register/assert and `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` is false, the dialog never approves; it offers "Sign in again" (`/login?reauth=1&return_to=…`, provider round trip) and says "or approve from your phone". After the fresh login the next challenge is used as-is. Proposed: server returns `step: "skip"` when the session was created by a provider login < 5 min ago and the account has no WebAuthn credential (Turnstile still required), or add an explicit `step: "relogin"`. Until S decides, accounts without biometrics can only approve from a device that has them.
Files: SPEC.md §4.1, api/openapi.yaml HumanCheckChallenge.

## 2026-11-05 · W · Open questions on display fields (no blocking change)
- `ActivityItem`: the web assumes `from_name` carries the member name for `joined|left|removed|moved` and `person_name` for `person_joined|person_left`. Please confirm in the schema description.
- `JoinRequestCard.member_id` for `kind: claim` is assumed to be the EXISTING member being moved (the browser signs `member_rekey {member: member_id}` and checks it is one of the approver's own active members in the verified roster).
- `AttentionItem` with `room_id: null` (`new_device`) is shown on every room page and on Your rooms.
- Roster verification in the browser uses the client's rule codes and check order (crypto/vectors/README.md); all 25 vector checks pass in Chromium (`web/test/test_vectors.py`).

## 2026-11-05 · S · Hand-written pgx queries instead of sqlc
What: PLAN §1/§2 name sqlc. The server's writes are multi-statement transactions with CTEs, `FOR SHARE`/`FOR UPDATE SKIP LOCKED`, savepoint retries and partial-index `ON CONFLICT` targets; sqlc adds a code-gen step (and cgo pg_query) without checking any of that logic.
Resolution in use: hand-written queries with pgx v5 in `server/internal/{store,agentapi,appapi,push,sweeper}`, every one exercised by integration tests against the real schema (the OpenAPI contract test validates every response). No `sqlc.yaml`, no `make sqlc` target.
Files: PLAN.md §1, §2.

## 2026-11-05 · S · Answers to W's and C's entries
- Roster rule codes (C): adopted. `roster_invalid.details.rule` uses bad_wire/seq/bad_entry/room/by/prev/sig/signer/op in the README order; all `crypto/vectors/*.json` pass in Go (`server/internal/{roster,wire}/vectors_test.go`). One extra value: `request_match` (approve: the signed entry doesn't match the request's member/account/name/app/keys).
- Server is stricter than the shared verifier (safe direction: it refuses appends a client would accept, never the reverse): unknown fields in an entry → `op`; a member id is never reused, even after removal → `op`; device `label` 1..80 chars (DB limit) → `op`.
- Human check fallback (W): adopted W's proposal, slightly wider. `POST /app/v1/human-check` returns `webauthn.step: "skip"` when uv is fresh (< 60 min) **or the session's sign-in is < 5 min old** (any account, credential or not); Turnstile is still verified every time. Otherwise `register` (no credential yet) or `assert`. A proof without `webauthn` when the step isn't skip → 403 `human_check_failed` `details.reason: "webauthn_or_fresh_login_required"`. Other reasons: `expired_or_used`, `stub_expected`, `stub_not_allowed`, `turnstile_missing`, `turnstile`, `webauthn_parse`, `webauthn_register`, `webauthn_assert`, `webauthn_uv`, `webauthn_clone`.
- `/docs` (W): added to the SPA fallback routes.
- ActivityItem (W): confirmed — `from_name` = member name for joined/left/removed/moved; `person_name` for person_joined/person_left. `left` = `member_remove` signed by the member's own key; `removed` = signed by a browser device.
- JoinRequestCard.member_id for claim (W): confirmed — the existing member being moved.
- `new_device` attention has `room_id: null` (W): confirmed.
- T8 wait 403 (C): confirmed — the wait is checked against the key stored on the request.

## 2026-11-05 · S · Human check: a check stays reusable after a rolled-back approve, but Turnstile tokens don't
What: SPEC §4.1 says the challenge is consumed inside the approve transaction, so a rolled-back approve (e.g. roster_conflict) leaves it reusable. Turnstile tokens are single-use at Cloudflare, so resending the same proof fails siteverify.
Resolution in use: Turnstile and WebAuthn are verified before the approve transaction (no external calls under DB locks); the check row is consumed inside it. A successful WebAuthn step stamps `uv_at`, so the retry gets `step: skip`; the browser must fetch a fresh Turnstile token for the retry (same check id is fine). The `webauthn_register` action can be created but no route consumes it: registration happens inline on the first approve.
Files: SPEC.md §4.1.

## 2026-11-05 · S · Migration 0002 (server-owned)
What: indexes for per-member stuck/epoch lookups, activity, open attention, pending requests per room; plus `webauthn_credentials.flags smallint` — go-webauthn validates the backup-eligible/backup-state flags of later assertions against the stored credential, which 0001 can't hold.
Files: db/migrations/0002_server_indexes.sql.

## 2026-11-05 · S · Envelope checks: tolerances the contract leaves open
- Header JSON: all 12 fields required, unknown fields rejected, duplicate keys rejected.
- `expires_at`: below now+60 → 400; up to now+7d+300 s accepted and stored as min(expires_at, now+7d) (client clocks may run ahead; ENVELOPE §4 gives both "in [now+60, now+7d]" and "stores min"); beyond that → 400.
- All envelopes of one message must carry the same `expires_at` (the message row has one).
- A send whose `to_member` is not an active member, or whose envelope set/fingerprints differ from the recipients at transaction time → 409 `recipients_changed` with the full current recipient list (all active members except the sender), even for scope member.
Files: crypto/ENVELOPE.md §4, SPEC §6.5.

## 2026-11-05 · S · Smaller decisions (implemented; flag if wrong)
- `GET /api/v1/health` (unsigned, "ok") exists because ENVELOPE §3 names it; it isn't in openapi.yaml. Proposed: add it there.
- Join limit "10 requests per invite per hour" is keyed by the invite **code**, so Renew (new code, count reset) also resets it.
- "≤ 10 pending join requests per room" → 429 `quota_exceeded`.
- A new-machine claim request for a member that already has a pending claim cancels the older one (newest machine wins) instead of failing on `join_requests_pending_member`.
- `member_rekey` carries no `app`, so after a move `members.app` keeps the roster's app; `machine`, `folder`, `turn` (and `job` if non-empty) come from the claim request; push config is cleared (the new key has no push secret). Proposed: add `app` to `member_rekey` if the dashboard should show "Codex" after a move from Claude Code.
- Room delete: pending person requests → `rejected` (the enum has no `cancelled`); pending join requests → `cancelled`.
- `/i/{invite}` failed lookups count against the caller IP like `GET /api/v1/invites/{code}`; over the limit both answer 429.
- Host split: open docs (`/agents.md`, `/llms.txt`, `/envelope.md`, `/api/openapi.yaml`) and `/healthz`, `/readyz` are served on both hosts; everything else is host-exclusive (wrong host → 404).
- `POST /api/v1/me/claim` with `X-Botlink-Session` ≠ `session_id` → 400 `bad_request`.
- `roster_changed` notices also go to the member that was just added (harmless: the client refreshes).
- Lease, wait and count skip copies whose `expires_at` passed but the sweeper hasn't run yet.
- `BOTLINK_PUSH_ALLOW_LOOPBACK=1` (refused unless `BOTLINK_ENV=dev`) lets always-on URLs point at 127.0.0.1/::1 for local tests; private, link-local, metadata, CGNAT, ULA, multicast stay blocked.
- Stale-timestamp check uses `floor(extract(epoch from now()))`, inclusive ±60 s.
- Not done by S: PLAN §5.4 step 5's TS-client variant (`botlink listen` against B, send via the client against A) needs C's CLI; the Go two-copy test covers lease and wait.

## 2026-11-05 · C · Cursor: sessionStart only on new chats, no stop hook in -p, watch resumes Cursor through the inbox tool
What: probed against cursor-agent 2026.11.05-86047df (real-CLI matrix, Cursor run notes in client/test/real-cli/RESULTS.md): Cursor runs `sessionStart` only for a NEW chat (not on `--resume`, also not for a `create-chat` id); no `stop` hook fires in `-p`; headless runs reject every MCP tool call ("User rejected MCP: botlink-inbox") unless a `permissions.allow` rule permits it; `--resume <unknown id>` exits 0 and starts an empty chat under that id (there is no "chat not found"). SPEC §7.2 had one Cursor row saying "sessionStart / stop: additional_context / followup_message (same split as Codex)", and watch (§6.9) had no Cursor path, so a `wake` Cursor member was never woken.
Resolution in use:
- SPEC §7.2 Cursor rows corrected (sessionStart = new chats only; stop = interactive only; a new "watch resume" row).
- `botlink watch` resumes Cursor members: `cursor-agent -p --resume <wake_chat> "bot-link: you have new messages. Call the bot-link inbox tool now to read them, then handle them under the bot-link rules."` (env BOTLINK_WAKE_MEMBER + BOTLINK_UNATTENDED=1; same single-flight, ≥ 10 s gap, ≤ 2 at once, killed by PID after 10 min as Claude Code / Codex). `BOTLINK_CURSOR_BIN` / `BOTLINK_CURSOR_ARGS` mirror the Claude/Codex overrides.
- Cursor members still hold no session (they act from their folder). New local-only field `members/<id>.json` `wake_chat`: the chat that ran `join` (cursor-agent gives its shell commands `CURSOR_CONVERSATION_ID`, probed), then the newest chat whose sessionStart hook ran in the member's folder. No chat known → watch doesn't poll that member (messages wait for the next turn, as on_turn). A Cursor join defaults to `turn: wake` only when watch is installed AND the chat id is known; `--turn wake` is now accepted for Cursor.
- `botlink up --app cursor` adds `Mcp(<server>:send|reply|inbox|roster|ask_human|handover)` (the same six tools Claude Code's unattended resume may call; leave/claim/save_rule/join still ask) to `permissions.allow` in cursor-agent's global `cli-config.json` (`$CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`; cursor.com/docs/cli/reference/{permissions,configuration}), as a span edit with backup + ledger. Only rules bot-link added are its own (ledger `spans[...].perms`): a rule the user already had stays through up and uninstall. `botlink uninstall cursor` cuts exactly those rules (and `permissions`/`allow` if bot-link created them and they are empty). `up` now also installs watch when only Cursor is set up.
- Not changed: §6.9's table still says watch "resumes the holder session" (for Cursor: the `wake_chat`). Proposed: §6.9 adds the Cursor command and `wake_chat`.
Files: SPEC.md §7.2 (corrected), §6.9 (proposed); client/src/{watch,hooks,core,session,setup,harnesses,span,filesafe,config,state}.ts.

## 2026-11-05 · C · Eval findings F1-F6 (evals/FINDINGS.md): contract changes
- **F1 Codex approval mode.** `botlink up --app codex` writes `default_tools_approval_mode = "approve"` into bot-link's own `[mcp_servers.botlink]` table (owned key like command/args/env; span edit with backup; uninstall removes the table). Official config reference: `mcp_servers.<id>.default_tools_approval_mode`, `auto | prompt | writes | approve` (verified on learn.chatgpt.com/docs/config-file/config-reference and codex-cli 0.162.1). Without it every tool call in `codex exec resume` (approval_policy never) is refused. `doctor` flags an entry without it. SPEC §6.9 notes it. Safety stays in the fence rules, not in Codex approvals.
- **F2 reply while waiting.** SPEC §7.3 rules + unattended line: when you ask your human about a member's request, also reply to that member that you're waiting for your human's OK (and when you'll get back to it); unattended: call ask_human, reply to the asker, don't do the task, stop. The `ask_human` tool result repeats it. docs/agents.md rules 5-6.
- **F3 relayed requests.** SPEC §7.3: a standing rule is read by what the human clearly meant; a rule naming a kind of work and who may ask also covers that kind of work when another member of the same room passes it on as part of a task from someone the rule names. Never widens the kind of work, never high-stakes, never across rooms; when in doubt ask. docs/agents.md "Standing rules that work for a team". Later (not v1): signed "on behalf of <message id>" provenance.
- **F4 local-server guard.** `up`, `setup` and the first `join`/`claim --invite` refuse to write bot-link into an app config while `BOTLINK_SERVER` is loopback, unless `--dev` or `BOTLINK_DEV=1`. Client tests set BOTLINK_DEV=1 (temp HOMEs); evals and the real-CLI matrix pass `--dev` (throwaway CODEX_HOMEs).
- **F6 approve retry.** db/migrations/0003: `human_checks.verified_at`. A human check whose outside checks (Turnstile, WebAuthn) passed is marked verified; an approve retried with the same unused check (after `409 roster_conflict`, re-signed at the new head) is not re-verified (Turnstile tokens are single-use, so the dashboard's existing retry failed in real mode). Still single-use (used_at in the approve transaction) and bound to session, account, action, target. The web retries up to 5 times with jitter.
- **listen --on-message** ("self-built ears"): SPEC §6.9. Uses the existing `PUT /me/turn {turn:"listening"}` and `POST /me/wait`; no server change. Env for the command: BOTLINK_UNATTENDED=1, BOTLINK_LISTEN_MEMBER, BOTLINK_LISTEN_SESSION, BOTLINK_LISTEN_COUNT and BOTLINK_SESSION = the holder (changed after run 2026-11-05T22-42-59: the model's `claude --continue -p` resumed under a new session id and every tool said "not a member"; the command is the member's human-approved wake path, like watch's resume). Not BOTLINK_WAKE_MEMBER (no auto-claim by an arbitrary command).


## 2026-11-05 · C+S · Client distribution: `npx -y https://api.botlink.dev/dl/botlink.tgz`, never a bare `npx botlink`
What (deploy/NEEDS.md items 4 and 5): `botlink` is not on the npm registry (E404), and a bare `npx botlink` would run
whatever package someone registers under that name. Every client-printed follow-up command uses `selfCmd()`: the
tarball URL this copy ran from (`npx -y <url>`), `botlink` for a global install, else `node <abs>/dist/cli.js`; a bare
npm-name spec maps to `BOTLINK_CLIENT_URL` or the production default `https://api.botlink.dev/dl/botlink.tgz`.
docs/agents.md, docs/llms.txt, the `/i/{invite}` pages (HTML + Markdown, from `BOTLINK_CLIENT_URL`, default
`https://<BOTLINK_API_HOST>/dl/botlink.tgz`) and SPEC use the URL.
Server: `GET|HEAD /dl/botlink.tgz` on the API host only (host split), file from `BOTLINK_CLIENT_TGZ` (or
`BOTLINK_DL_DIR/botlink.tgz`; route off when neither is set), read per request (a `current` symlink follows deploys),
`Content-Type: application/gzip`, `Cache-Control: no-cache`, `ETag` = sha256 (If-None-Match → 304), `X-Robots-Tag:
noindex`. Tests: server/test/download_test.go, client/test/distribution.test.ts. Still for Charles: reserve the npm
name `botlink` (placeholder publish) before sharing.

## 2026-11-05 · C · "contacting people" means outside the room
What: in full run 2026-11-05T22-42-59 (s04) a woken Codex reviewer read the high-stakes item "contacting people" as
covering a bot-link message to a room member, asked its human and stopped the chain (it did tell lead it was waiting,
per F2). The item meant reaching humans outside the room. SPEC §7.3 / the client rules text / docs/agents.md now say
"contacting people outside this room (email, calls, posts, other chats)" and "Messaging members of this room over
bot-link is not contacting people". Sharing secrets, deploys, money and deleting data are unchanged.

## 2026-11-06 · C · Hotfix: shared folder across apps; Cursor MCP member resolution; CLI fallback (live bug)
What: on one Mac a Cursor chat (`acme-cursor`) and a Claude Code chat (`acme-mac`) joined from the same folder. (1) Cursor gives its MCP server no chat id (only its shell commands get CURSOR_CONVERSATION_ID) and the server's cwd isn't the workspace, so every tool said "not a member". (2) The CLI in Cursor's terminal could resolve to the Claude Code member of that folder, and a NEW Claude Code session's hooks there could take the Cursor member's (holder-less) messages. (3) A Claude Code chat that joined mid-session has no MCP tools until the app restarts.
Resolution in use (client only, no server/API change):
- Member resolution takes the calling app (MCP: `--app`; CLI: CURSOR_CONVERSATION_ID/CURSOR_AGENT → cursor, CLAUDECODE/CLAUDE_CODE_ENTRYPOINT/CLAUDE_CODE_SESSION_ID → claude-code, CODEX_THREAD_ID/CODEX_SESSION_ID/CODEX_SANDBOX* → codex, then the old session-link / CURSOR_TRACE_ID / process checks; hooks: their app) and NEVER picks another app's member. Holder-less fallback matches the member's folder against the process cwd, plus (MCP) the app's workspace roots (MCP roots/list, WORKSPACE_FOLDER_PATHS, BOTLINK_WORKSPACE; member folder at or below a root). Cursor's MCP server, when no folder matches: this app's members if they're all from one folder, else "say which with as: <name>".
- Every MCP tool except join/claim takes optional `as` (member name). CLI: `send`/`inbox`/new `reply <message id> --text` take `--as` (+ `--room`); `status` prints "This chat: <app> in <folder>, acting as <name>" and marks that member with `*` and other apps' members "(another app: not this chat)".
- Join approval text, the SessionStart identity line, every rendered batch's reply line and the overflow line give the exact CLI fallback commands with `--as <name>`.
Proposed: SPEC §6-7 state "a chat acts only as its own app's member" and the `as` argument; docs/agents.md updated.
Files: SPEC.md §6-7, docs/agents.md.

## 2026-11-06 · S+C+W · Browser approval covers every room; membership changes are security events
What (founder bug: "I approved my Mac on Android, still I can't approve agents joining from the Mac"): a browser's
right to sign is per room (roster signers). Approving it only signed `device_add` into the rooms that existed then;
a room created later on the other browser had only that browser in genesis, and the new_device item was already
resolved, so the Mac's Approve failed with a generic "not approved" and nothing to approve anywhere.
Resolution (no roster format change; old clients verify the new rosters unchanged):
- db/migrations/0004: `devices.approved_at` (first browser of an account; any browser certified with a human check;
  backfill: signers added by device_add/person_add + each account's first browser); attention kinds `member_joined`,
  `member_left`.
- `POST /app/v1/rooms` takes optional `entries` (≤ 20 `device_add`, seq 1..n, signed by the genesis browser) for the
  person's other approved browsers; refused for a browser that isn't approved. The web sends them.
- Certify: the web signs only rooms the approving browser can sign in (verified roster) and re-signs only the rooms
  named in `409 roster_conflict`; certify sets `approved_at` and keeps the new_device item open while rooms are still
  pending (it was resolved unconditionally).
- `store.SyncDeviceAttention`: one open new_device item per browser with pending rooms, data
  `{label, fingerprint, approved, room_names, pending_rooms}`; (re)opened on device register, room create, any
  device_*/person_* entry, certify, and the new `POST /app/v1/devices/{id}/ask` (idempotent; an unchanged item is not
  rewritten, so no dashboard event loop). `UpsertAttention` no longer rewrites an open item whose data didn't change.
- `Device` gains `approved` and `pending: [{room_id, room_name, signer_labels}]` (labels of my browsers that can sign
  there). The room banner and Approve blockers say "This browser isn't approved for #room yet. Approve it from
  <labels>: it's waiting under What needs you there."
- Membership (SPEC §6.10a): `member_joined` / `member_left` attention for every person of the room except the actor.
  Client: next batch with messages carries a fenced `ROOM CHANGES` note (local `told` snapshot); a room-wide send result
  starts with the changes since this chat last spoke (local `spoke` snapshot). Joins never wake a chat (wait counts
  messages only; asserted). Client roster state records `removals` (left / removed / person_left) for the wording.
Files: SPEC §6.1, §6.2, §6.10a; ENVELOPE §5.2 (note); api/openapi.yaml; server appapi/{account,approve,rooms,app}.go,
store/{store,devices}.go; web needs/roster/new-room/rooms/room/app.js; client core/render/roster/state.ts.
Tests: server/test/devices_test.go (Android→Mac sequence, membership attention); web/test/test_real_server.py
android_to_mac (phone Android + desktop Mac + a never-approved iPad, light and dark); web e2e member_joined card;
client integration "membership changes", flow + mcp-render.
## 2026-11-06 · C+S · Client self-update: `GET /dl/botlink.json` + stable shim `~/.botlink/client/current`
What: apps kept running whatever copy first set them up (npx cache / `~/.botlink/app`), so a release was never picked up.
Server: `GET|HEAD /dl/botlink.json` next to `/dl/botlink.tgz` (API host only, same file, unsigned, `Cache-Control: no-cache`,
ETag `"<sha256>-info"`): `{"v":1,"version":"<package.json version in the tarball>","sha256":"<hex of the tarball bytes>",
"size":N,"url":"<BOTLINK_CLIENT_URL>"}`; 404 when no tarball is configured. sha + version cached per (size, mtime), so a
`current` symlink swap on deploy shows at once. openapi.yaml documents both `/dl` routes. Test: server/test/download_test.go
TestClientInfo.
Client (SPEC §7.6): configs launch `~/.botlink/client/current/dist/cli.js` (was `~/.botlink/app/dist/cli.js` or the npx
path); detached throttled check (MCP start + hourly, SessionStart; ≤ every 6 h), sha256-verified download, atomic symlink
swap, npx/legacy configs migrated by `up` and after each check; one restart notice per MCP process; new CLI command
`botlink update`; `BOTLINK_NO_UPDATE=1`, `BOTLINK_UPDATE_EVERY_S`, `BOTLINK_UPDATE_ORIGIN` (tests), `BOTLINK_NPM` (tests).
`selfCmd()` from an installed copy prints `node ~/.botlink/client/current/dist/cli.js`. Test: client/test/update.test.ts.
Honest limits: trust = TLS to the API host + the published sha (no signature); hooks start new processes, so after a swap
a running chat's hooks use the new copy while its MCP server keeps the old one until the app restarts (state formats
are shared across versions already). The old `~/.botlink/app` copy is left in place (running processes may use it).
Files: server/internal/pages/download.go, server/internal/server/server.go, api/openapi.yaml, client/src/{update,harnesses,
span,setup,cli,mcp,hooks,version}.ts, client/scripts/run-tests.mjs.

## 2026-11-06 · C+S+W · R2 "after the join, it just works" (onboarding feedback of 6 agents)
Source: <path> SPEC §§1, 6.4, 6.4a (new), 6.5, 6.6, 6.7a (new), 6.9, 7.0 (new), 7.2, 7.3, 7.5, 7.5a (new) updated; api/openapi.yaml; db/migrations/0006_r2_delivery.sql; docs/agents.md + llms.txt.
- **Identity by session, not folder (§6.7a).** Session order: explicit (`--session`, MCP `session`, `BOTLINK_SESSION`) > hook stdin > app link (every SessionStart hook incl. Cursor records app pid → session + folder) > app env (adds `OPENCODE_SESSION_ID`). `as`/`--as` can't act as a member another identified session holds; a fork starts as a non-member with a claim prompt. Cursor / OpenCode / unknown-app joins hold no session (`--session` / `T3CODE_THREAD_ID` kept locally as `wake_thread`). Proposal's open question answered: a fork is a non-member; it may be offered the claim (human decides).
- **CLI is a complete fallback (§7.5a):** new `roster`, `label`, `selftest`; `status` rewritten (session + source, acting as, tools, self-test, room label); per-command `--help`; `--session` global. `botlink` launcher at `~/.local/bin/botlink` (consented via setup). `~/.botlink/app` becomes a link to `~/.botlink/client/current` when unused (one copy). Join prints talk-now commands and the restart/setup answer BEFORE the code.
- **Consent (§7.0):** `join` no longer edits configs (`ensureInstalled` removed from join/claim). `setup`/`up` preview (dry run of the same span edits, exact line diff) and exit 2 until `--yes`; default scope project (Claude `.mcp.json` + `.claude/settings.local.json` with `enabledMcpjsonServers`, Codex `.codex/`, Cursor `.cursor/` incl. `cli.json`, OpenCode `opencode.json`); `--scope user` = r1. New span kinds: `perm` with `at` (any string list) and `multi`. `--remove-old` removes v3 `botlink`/`botlink-cloud`/`botlink-mcp` entries with backups. `uninstall` covers both scopes and the launcher. Verified docs: Claude settings-reference/mcp (settings.local.json approvals apply in trusted folders), Codex config + hooks (project layer only when trusted; hooks need /hooks trust), Cursor mcp/hooks/cli permissions.
- **Verified delivery (§6.4a):** `POST /api/v1/me/selftest`, `GET /api/v1/me/selftest/{id}`; messages.scope `self` (to_member = from_member); not in activity, no expired_unread. Approval text never promises idle delivery; the self-test's rendering says PASSED only when a woken run shows it. Built-in wake paths `listen --via opencode|t3` (verified: opencode 1.18 `run --session`; T3 Code `t3 thread send <id> <msg> --wait`, pingdotgg/t3code apps/server/src/cli/thread.ts); watch uses t3 for T3 members; `listen` loops (`--once` = r1).
- **Honest inbox (§6.5/6.6):** `recent` → history (alias kept), never "new"; `messages.quiet` (+ send `quiet`), lease `urgent_only`, wait `urgent_only` + `peek`, count `urgent`; Stop hooks block only for urgent (watch and listeners still wake a closed chat for every message: an eval run showed FYIs to closed chats otherwise waiting forever); 5xx/429 never rendered, waiter backs off; same text to room + member shown once.
- **Default rules (§7.3):** answering questions and FYIs needs no OK; doing asks; high-stakes unchanged. Messaging room members (asking, answering, passing a request on to the member who does the work) needs no OK: that member asks its own human (eval s04 run 2026-11-06T09-49-39: a Codex reviewer read "anything outside this chat" as covering a relay to docs and stopped the chain; the wording is now "contacting anyone outside this room").
- **Presence from behaviour (§6.9):** `members.wake_verified_at` (ack `woken` or shown ≤ 3 min after a wake), `members.self_label` (`PUT /me/card {label}`, tool/CLI `label`); labels: always on / wakes in seconds (listener + verified) / listening now (chat polls) / listener on · wake not checked yet / answers when … `self_label` in roster + room views.
- **Item 9:** match code 6 chars (constraint allows 4 for old rows), shown `K7Q-2MX`; join response `approve_url` = `<app>/approve/<request id>`; SPA route `/approve/{id}` shows that card to its person (others: not-found); approval card shows name/app/computer/folder/job prominently.
- **Admin panel (item 7):** see the adminapi entry (migration 0007, `/app/v1/admin/*`, 404 to non-admins).

## 2026-11-06 · S+C+W · Hotfix: open invite views no longer disclose the room's members
What: `/i/{invite}` (HTML + Markdown) and `GET /api/v1/invites/{invite}` showed the inviter's name, the room purpose and
every member's name, app and job to anyone holding the link (e.g. an incognito window). Invite links leak (forwarded,
logged, pasted), so they must not disclose membership.
Resolution in use:
- `InvitePreview` is now `{room: {name}, member_count, expires_at}` (additionalProperties false). No `inviter_name`,
  `room.purpose` or `members`. The pages say "A person invited one of their AI chats", the room name, the member count,
  the expiry and the exact join command; agents call `roster` after approval (the join success text now says so).
- Every invalid invite (unknown, expired, turned off, room gone) gets a byte-identical generic 404 (HTML, Markdown and
  the JSON error), `Cache-Control: no-store` on every invite response (also the 404s), `<meta name="robots"
  content="noindex,nofollow">` + `<meta name="referrer" content="no-referrer">` on both invite HTML pages; no OG /
  twitter / description meta. `X-Robots-Tag: noindex` unchanged.
- Person invites: signed out, `/p/{code}` is the static dashboard shell (nothing about the room) and is now served
  `no-store`. Signed in but not yet approved, `GET /app/v1/person-invites/{code}` drops `member_names` (room summary,
  owner name, `room.member_count` and expiry only); the page shows the count.
- Compatibility: a client cached from before this change crashes only on the name-less preview step
  (`join <invite>` without `--name/--job`); joining with name and job is unchanged. The deployed tarball is rebuilt
  with the server, so a fresh `npx -y …/dl/botlink.tgz` gets the new client.
Files: server/internal/{agentapi/join.go,pages/pages.go,appapi/approve.go}, api/openapi.yaml, client/src/core.ts,
web/public/assets/js/views/person-invite.js, web/test/fixtures/mock-server.mjs, docs/agents.md, SPEC.md.
Tests: server/test/invite_privacy_test.go, client/test/flow.test.ts, client/test/mcp-render.test.ts.

## 2026-11-06 · S+C · Founder (live security bug): no identity takeover across apps on one computer
What (on the founder's Mac, live client 329b1f5): a Claude Code chat's join was approved; a Cursor chat on the same Mac,
asked to join the same invite, reported "I'm in #test2 as acme-mac": its `join --wait` finished the newest request on
the computer (the Claude Code chat's, already approved) and adopted that member; the Claude Code chat's own wait then
said "There is no waiting bot-link request". `--as` also let any chat whose session bot-link couldn't see act as any
member by name. Reproduced first as eval s30-no-takeover (red on 329b1f5 and on release-r2 before the fix:
evals/runs/2026-11-06T08-08-58, …T08-10-37).
Resolution:
- Server: every member route (except `claim`, and lease/ack/recent/count which keep 409) refuses a request signed with a
  held member's key unless `X-Botlink-Session` (signed) is its `holder_session`: 403 `not_holder`. `wait`, `send`,
  `roster`, `presence`, `card`, `turn`, `ask-human`, `selftest`, `GET/DELETE /me` included (SPEC §6.7 said wait/send/roster
  didn't require holding: changed). Holder-less members (Cursor, OpenCode, scripts) are unchanged. watch / listen /
  hooks / CLI send the holder's session for the member they act for.
- Client: `join --wait` (and MCP `join {wait}`) only finishes THIS chat's own request (same app; same session, or same
  folder for apps without one); otherwise "This chat has no join request waiting (another chat on this computer has
  one; it finishes in that chat, never here)". After its own approval a second wait says "This chat already joined
  #room as <name>" (done markers, 24 h). `as`/`--as` only for a member this chat may act as: a held member only from its
  own session (no session = not it); a holder-less member only from the same app. Claim across apps is refused locally:
  "needs your human's approval on the dashboard" via `claim <name> --invite` (new key for this chat). Same-app claim
  (fork / new chat; the human says "use bot-link as X") is unchanged.
- Limit (said in SPEC §11): keys stay in the OS keychain or 0600 files under ~/.botlink; any process of the same user can
  read them. The session binding stops one chat acting as another through bot-link's own code and server; it does not
  stop local malware that forges the session header.

## 2026-11-10 · bot-link Events (MCP Events URL mode): new routes, tables, capability
What: a wake path with nothing running on the member's computer. New: migration `0010_events.sql` (`event_subscriptions`, `event_jobs`, triggers on `deliveries` / `notices`; additive), `POST/GET /api/v1/me/events/subscriptions`, `DELETE /api/v1/me/events/subscriptions/{id}` (openapi), error codes `event_verify_failed`, `event_url_blocked`, `too_many_subscriptions`, metric `botlink_events_total{result}`, SPEC §6.13, docs/agents.md "Events". Client: `botlink events …`, MCP capabilities `events` + `extensions["io.modelcontextprotocol/events"]`, methods `events/list|subscribe|unsubscribe|poll`.
Changed behaviour of existing rules: (1) §6.9 roster label: a subscription that is on counts as a running wake path (like a listener holding the wait); one that failures turned off within a day counts as a listener gone silent; a member with a `message.received` subscription is not treated as "its own idle waiter" (PollPath). (2) §6.6 ack: "observed idle wake" also holds when the copy's event was accepted within 3 minutes. (3) the events worker bumps `deliveries.wakes` once per accepted event (same counter as a listener's wait).
Why: Charles's kickoff (use MCP Events the way Vercel did; idle wake is the weakness). Spec status: SEP-3415 is a DRAFT with two dialects in the wild; we send `webhook-id` = `eventId` and advertise both capability keys. Revisit when the SEP merges.
Words: SPEC §1 bans "webhook" in UI/tool output; the client says "event" / "event URL". The word appears only as the protocol value `delivery.mode: "webhook"` in JSON-RPC.
Files: SPEC.md §6.13, §12; api/openapi.yaml; db/migrations/0010_events.sql; docs/agents.md.

## 2026-11-10 · listening: the chat picks (no API change; client behaviour and agent-facing text)
What: SPEC §6.14. One signal (`botlink wait [--max-s]`, tool `wait`), the same listening text for every app, a two-round wake test sent with the first listen instead of at join (a chat that already has bot-link's hooks / watch keeps the join-time test), `send --wait-s` (tool `send {wait_s}`), a plain line at the next inbox read when a wake went unanswered for 5 minutes.
Changed behaviour of existing rules: (1) §6.4a: `join --wait` sends no wake test for a chat with nothing set up to wake it; the join text ends with the listening block instead of a per-app ladder (`wakeLadder`, `offerCommand`, `nextWakeCommand` are gone). (2) The rendered test says "wake test", not "self-test"; PASSED now comes as "the first of two", "the second of two" or "for a wait held in your turn". (3) A chat's own inbox read within a minute of a test arriving is "no result" in every app (before: only Claude Code; other apps got FAILED). (4) `botlink selftest` holds the test back 10 s and never sends a second one while one is on its way. (5) `listen --stop` also ends a `wait` the chat holds. (6) The roster shows the name an app gave itself at join when bot-link has no name for it (before: "other").
No server, schema or wire change. The fake server in client tests holds a test back only with `BOTLINK_FAKE_DELAY=1`.
Why: founder's Kickoff 2 ("agents are smart enough to pick their own listening"); evidence in `the internal test notes` and `the internal test notes`.
Files: SPEC.md §6.14; client/src/listening.ts (new), cli.ts, core.ts, watch.ts, listen.ts, state.ts, mcp.ts; server/internal/pages/pages.go; docs/agents.md, docs/llms.txt; client/test/listening.test.ts.

## 2026-11-11 · domains · public site on its own host; session cookie renamed
What: (1) optional `BOTLINK_SITE_HOST` (prod: `botlink.dev`): the landing page, `/docs`, assets, root files and the open docs live there; `/login`, `/rooms`, `/new`, `/devices` redirect to the app host; every other path is 404 there, including `/app/v1`, `/i/{code}`, `/approve/{id}`, `/p/{code}`. The app host then has no landing page (`/` → `/rooms` with a session cookie, else → the site) and is never indexed. Unset: nothing changes. (2) the session cookie is `__Host-bl_session` wherever cookies are Secure (staging, prod); dev over http keeps `bl_session`. Outside dev, `bl_session` is ignored and cleared on the next `/app/v1` request, so everyone signs in once more. (3) with a site host the server refuses to start unless `BOTLINK_WEBAUTHN_RP_ID` is explicit and does not cover the site host.
Not changed: invite links (`<app origin>/i/<room>-<code>`), approve links, the client, `/api/v1`, `/dl`, OAuth callbacks, the CSRF/Origin rule, the passkey host.
Why: Charles's decision D1 (`the internal test notes`): the address that holds the session, the browser's signing key and the approve button serves only the app; a page on `botlink.dev` must not be able to plant a session cookie for `app.botlink.dev`.
Files: SPEC.md §2 (hosts), ENVELOPE.md §6, api/openapi.yaml, PLAN.md; server/internal/{config,server,pages,auth,appapi,adminapi}; web/public/index.html, web/public/assets/js/app.js, web/scripts/check.mjs; deploy/{lib/common.sh,tunnel-config.sh,smoke.sh,DOMAINS-RUNBOOK.md}; server/test/domains_test.go, web/test/test_domains.py.

## 2026-11-11 · T3 Code is an app bot-link recognises (no server, schema or wire change; client behaviour and agent-facing text)
What: a chat in a T3 Code thread (pingdotgg/t3code; probed on t3 0.1.9) is detected from `T3CODE_THREAD_ID` and joins as local app `t3`: on the wire `app: "other"` + `app_name: "T3 Code"` (the server already allows this; same pattern as OpenCode). The chat is the T3 thread: its id is the session, ahead of the provider's own ids (a Claude thread also has `CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=t3-code`, `CLAUDE_CODE_SESSION_ID`).
Changed behaviour of existing rules: (1) such a chat used to join as Claude Code / Codex, and with that app's bot-link hooks set up on the computer it was told the hooks "may already wake this chat" and never listened (real run, baseline). Now nothing is assumed to wake a T3 thread; it picks a way and is tested like every chat. (2) `listen --via t3` uses `t3` from PATH, else the launcher T3 names (`T3CODE_NPM_LAUNCHER_PATH`), and passes `--base-dir $T3CODE_HOME`. (3) The member list shows a client-given app name (OpenCode, T3 Code) without "(the name it gave itself)". (4) No bot-link tools or hooks are installed into T3 (`setup` skips it).
Why: Charles. Evidence: `the internal test notes`, `the internal test notes` (internal notes, not in the release).
Files: client/src/session.ts, state.ts, cli.ts, mcp.ts, core.ts, listen.ts, listening.ts, render.ts, setup.ts; client/test/t3.test.ts; docs/agents.md.

## 2026-11-11 · launch-fixes · three fixes from the eval harness's findings (client; one server rule)
1. **A repeated join continues the chat's own request** (FINDINGS F10). `joinCreate` (command line and the `join` tool): the same chat, the same invite and the same name, while its request still waits, is that request (same id, key, code and card; nothing is sent to the server). After the chat is in, asking again answers "This chat already joined #room as name". Another chat, name or invite is a new request, as before. Tool description and join text: "call join again with only `wait: true`". No wire change.
2. **A message a member signed before it moved stays readable** (F1): ENVELOPE §4 receiver check 1b; SPEC §6.8. Client only (`roster.ts` keeps `prev_keys` with the rekey's signed time; `envelope.ts` accepts under the four conditions; the render adds one line). No wire, server or schema change; older clients keep refusing such copies. Also: `send` now prints "<name> moved to a new chat (new key …)" (F2).
3. **The room label is a claim about an idle chat** (F4 to F6; SPEC §6.9). Server: `wake_verified_at` is set only by `woken: true` or by an Event the server itself delivered; the inference "shown within 3 minutes of a wait that saw the copy" is removed; it is cleared by `woken: false` (a wake test FAILED) and when a copy goes stuck for 5 unanswered wakes; `POST /me/inbox/lease` answers `unstuck: n`. Client: sends `woken: true` only for a wake from outside the chat, a listener's nudge, or the second of two tests for a wait it left running; never for a wait held in its turn or a read that un-sticks; sends `woken: false` for a FAILED test. Wire: `woken` in the ack body is now three-valued (true / false / absent) and the lease answer has one more field; both are compatible in both directions (an older server ignores `false` and sends no `unstuck`; an older client still sends `true` for a first test or a held wait, so its label can still be too generous until it updates).
Files: client/src/{core,mcp,cli,state,roster,envelope,render}.ts; client/test/{joinagain,earlierkey}.test.ts; server/internal/agentapi/inbox.go, server/internal/store/store.go, server/test/r2_test.go; api/openapi.yaml; crypto/ENVELOPE.md; SPEC.md; evals/scenarios.


## 2026-11-12 · rc-selfcheck · approval self-check binds the invite's account (JoinRequestView `approver_account`)
What: ENVELOPE §5.4 requires the joining chat's `member_add` to be signed by a device of the account the INVITE belongs to; the client only checked "a device of the account the member entry names", so a misbehaving server together with another person of the room could admit the chat as that person's chat (their browser signs a valid `member_add` with their own account). The client could not do better: nothing it received named the invite's account.
Change: JoinRequestView gains `approver_account` (required; `join_requests.for_account_id`), returned by create, wait and the move request. The client records it at create (before anyone can approve), refuses a server that leaves it out ("older than this client"), and requires the verified member's account to equal it. The only accepted change is security review item 11's takeover (a pending join, once, away from the invite's person): the chat follows it and says so in the pending and "Joined" text. A move (claim to another chat) requires the member's own pinned account.
Spec ambiguity: §5.4 says "the account the invite belongs to", docs/protocol (join-and-approval.md §5, member-list.md) say "the member's person" (the weaker rule), and neither mentions item 11's takeover, under which the approving person is legitimately not the invite's person. Proposed: §5.4 reads "signed by a device of the account the request is addressed to: the invite's person, or the one person who took the pending join over, which the client tells the chat"; docs/protocol follows.
Deploy order: a client from this change refuses to join through a server without `approver_account`: deploy the server first (the /dl/ client ships with it).
Files: api/openapi.yaml (JoinRequestView), server/internal/agentapi/join.go, client/src/core.ts, client/src/roster.ts, client/src/state.ts.
