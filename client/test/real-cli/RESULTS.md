# Real-CLI matrix results (PLAN §5.3)

## Status 2026-11-05 19:10 UTC: all cells run for real at N=20 — Claude Code idle/session-start/resume/restart/cross-person, Codex idle/session-start/resume/restart, Cursor session-start/resume/restart: all PASS (latest run of each below; Codex idle = one typed prompt by design)

## (history) Status earlier on 2026-11-05: real matrix NOT RUN (no auth available in an isolated HOME)

The builder's rules require running every client test with `CLAUDE_CONFIG_DIR` and `CODEX_HOME` unset, a temp `HOME`,
and never touching the real `~/.claude`, `~/.codex` or any real profile. Probed on this box (Claude Code 2.1.318, codex-cli 0.162.1):

| CLI, isolated HOME | Result |
|---|---|
| `env -u CLAUDE_CONFIG_DIR HOME=<tmp> claude -p "reply AUTH_OK"` | exit 1, `Not logged in · Please run /login` |
| `env -u CODEX_HOME HOME=<tmp> codex exec --skip-git-repo-check "reply AUTH_OK"` | exit 1, `401 Unauthorized: Missing bearer or basic authentication` |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in this environment | not set |

Using the real logins would mean reading/copying credentials out of real profiles (OAuth refresh-token rotation can log
the live sessions out), so it was not done. The harness is built and its plumbing is verified (below); it runs the real
cells as soon as it is given logged-in profiles:

```bash
cd client && npm run build
# a built server + the private dev Postgres (repo root: make db-up)
(cd .. && ~/.local/go/bin/go build -o /tmp/botlink-server ./server/cmd/botlink)
# Claude Code: an already logged-in profile. bot-link's hooks + MCP server are passed with --settings / --mcp-config,
# so the profile's own config files are NOT edited (Claude still writes its session transcripts there).
# Codex: a DEDICATED CODEX_HOME, logged in once (CODEX_HOME=<dir> codex login); `botlink up --app codex` writes there.
env -u CODEX_HOME BOTLINK_IT_SERVER=/tmp/botlink-server BOTLINK_IT_PG=postgres://botlink@127.0.0.1:55432 \
  node --import tsx test/real-cli/matrix.ts --claude-config <logged-in CLAUDE_CONFIG_DIR> --codex-home <dedicated CODEX_HOME> --n 20 --gap-s 3
```

Cells per PLAN §5.3: `idle` (Claude: Stop waiter rewakes an idle tmux session with no human input; Codex: one typed
prompt after the 20 sends), `session-start`, `resume` (watch → `claude -p "<wake>" --resume <id>` /
`codex exec resume <id> "<wake>"`), `restart` (watch killed by PID, 20 sends, watch started), `cross-person` (Claude
only; the sender belongs to a second account added through a person invite). A token counts only if it is in the
session transcript's model-visible text AND the server shows the copy `shown`/`done`; duplicates must carry the
"re-delivered" flag. The runner appends a dated per-cell table to this file. Cursor: real cells since 2026-11-05 (see the Cursor run below).

Unverified until the real run: whether `codex exec resume` accepts `--dangerously-bypass-hook-trust` before
`resume` (the matrix passes it there; `codex exec --help` lists it), and whether Codex writes hook context into
`$CODEX_HOME/sessions/**.jsonl` (where the scorer looks).

## Run 2026-11-05T16:12:08Z · STUB harness (no model: plumbing check only, NOT the real matrix) · N=5, gap 0.5 s

`--stub` swaps both CLIs for `stub-harness.mjs`, which runs bot-link's real SessionStart hook / inbox the way the CLI
would and writes a transcript. It proves the harness, the real Go server, watch resume and the scoring work together;
it says nothing about the real CLIs.

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| claude-code | idle | 0 | - | - | - | - | n/a | needs an interactive CLI in tmux |
| claude-code | session-start | 5 | 5/5 | 5/5 | 0 | 0 | PASS (stub) | |
| claude-code | resume | 5 | 5/5 | 5/5 | 0 | 0 | PASS (stub) | holder unchanged |
| claude-code | restart | 5 | 5/5 | 5/5 | 0 | 0 | PASS (stub) | holder unchanged |
| claude-code | cross-person | 5 | 5/5 | 5/5 | 0 | 0 | PASS (stub) | person invite + person_add on the real server |
| codex | idle | 0 | - | - | - | - | n/a | needs an interactive CLI in tmux |
| codex | session-start | 5 | 5/5 | 5/5 | 0 | 0 | PASS (stub) | |
| codex | resume | 5 | 5/5 | 5/5 | 0 | 0 | PASS (stub) | holder unchanged |
| codex | restart | 5 | 5/5 | 5/5 | 0 | 0 | PASS (stub) | holder unchanged |

## Run 2026-11-05T16:45:42.065Z · real CLIs · N=20, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| claude-code | session-start | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: Cannot create a string longer than 0x1fffffe8 characters |
| claude-code | resume | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: Cannot create a string longer than 0x1fffffe8 characters |
| claude-code | restart | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: Cannot create a string longer than 0x1fffffe8 characters |
| claude-code | cross-person | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: Cannot create a string longer than 0x1fffffe8 characters |

## Run 2026-11-05T16:51:44.623Z · real CLIs · N=20, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| claude-code | session-start | 20 | 20/20 | 20/20 | 0 | 60 | FAIL | resume run exit 0 |
| claude-code | resume | 20 | 20/20 | 20/20 | 0 | 60 | FAIL | holder after: same session |
| claude-code | restart | 20 | 20/20 | 20/20 | 0 | 60 | FAIL | holder after: same session |
| claude-code | cross-person | 20 | 20/20 | 20/20 | 0 | 58 | FAIL | holder after: same session |

## Run 2026-11-05T16:57:55.266Z · real CLIs · N=20, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| claude-code | session-start | 20 | 20/20 | 20/20 | 0 | 20 | FAIL | resume run exit 0 |
| claude-code | resume | 20 | 20/20 | 20/20 | 0 | 20 | FAIL | holder after: same session |
| claude-code | restart | 20 | 20/20 | 20/20 | 0 | 20 | FAIL | holder after: same session |
| claude-code | cross-person | 20 | 20/20 | 20/20 | 0 | 20 | FAIL | holder after: same session |

## Run 2026-11-05T17:04:36.285Z · real CLIs · N=20, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| claude-code | session-start | 20 | 20/20 | 20/20 | 0 | 0 | PASS | resume run exit 0 |
| claude-code | resume | 20 | 20/20 | 20/20 | 0 | 0 | PASS | holder after: same session |
| claude-code | restart | 20 | 20/20 | 20/20 | 0 | 0 | PASS | holder after: same session |
| claude-code | cross-person | 20 | 20/20 | 20/20 | 0 | 0 | PASS | holder after: same session |

## Run 2026-11-05T17:11:47.766Z · real CLIs · N=20, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| codex | session-start | 20 | 20/20 | 20/20 | 0 | 0 | PASS | resume run exit 0 |
| codex | resume | 20 | 20/20 | 20/20 | 0 | 0 | PASS | holder after: same session |
| codex | restart | 20 | 20/20 | 20/20 | 0 | 0 | PASS | holder after: same session |

## Run 2026-11-05T18:04:00.578Z · real CLIs · N=20, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| cursor | session-start | 20 | 20/20 | 20/20 | 0 | 0 | PASS | new chat a4e2d595 exit 0; MCP send back: received by sender |
| cursor | resume | 20 | 20/20 | 20/20 | 0 | 0 | PASS | 20 resumes of chat 11c4230f (Cursor runs no sessionStart hook on --resume: delivery is the inbox tool) |

Cursor run notes (cursor-agent 2026.11.05-86047df, headless `-p --trust --approve-mcps --output-format json`, dedicated
logged-in HOME passed as `--cursor-home`; `botlink up --app cursor` wrote `~/.cursor/mcp.json` + `hooks.json` there and
`botlink uninstall cursor` removed both at the end):

- `session-start`: 20 sends, then a NEW chat in the member's folder. All 20 arrived in the sessionStart hook's
  `additional_context` (Cursor stores it as `<hooks_context>` in the prompt; read from the chat's `store.db`, assistant
  blobs excluded). The chat then sent a message back through the bot-link MCP `send` tool; the sender received it.
- `resume`: an existing chat resumed with `--resume <id>` and the watch wake prompt after every send (20 resumes).
  Cursor does **not** run sessionStart on `--resume` (probed: also not for a `create-chat` id), and no `stop` hook fired
  in `-p` mode, so all 20 arrived through the model calling the bot-link `inbox` tool (20 tokens in tool results, 0 in
  hook context). `botlink watch` had no Cursor resume path, so the matrix did the resuming itself (fixed 18:50: watch resumes Cursor; see the 18:57 run).
- Headless Cursor rejects every MCP tool call ("User rejected MCP: botlink-inbox") unless it is permitted: the matrix
  writes `Mcp(botlink:*)` into each test workspace's `.cursor/cli.json`. `botlink up` does not add that permission
  (interactive Cursor asks the user), so an unattended Cursor wake would need it (fixed 18:50: `up` adds six per-tool rules to cli-config.json; see the 18:57 run).
- Cursor keeps chats in `$XDG_CONFIG_HOME/cursor/chats/<ws>/<id>/store.db` (else `~/.cursor/chats`); a tool result is
  stored twice in one record (`result` + `experimental_content`), and the scorer counts it once.

## Run 2026-11-05T18:57:06.896Z · real CLIs · N=20, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| cursor | session-start | 20 | 20/20 | 20/20 | 0 | 0 | PASS | new chat 37299de7 exit 0; MCP send back: received by sender |
| cursor | resume | 20 | 20/20 | 20/20 | 0 | 0 | PASS | watch resumed chat 2a34b9dd 1x (cursor-agent -p --resume; no sessionStart on resume: delivery is the inbox tool); chats seen: 1 |
| cursor | restart | 20 | 20/20 | 20/20 | 0 | 0 | PASS | watch resumed chat 9be1b831 1x (cursor-agent -p --resume; no sessionStart on resume: delivery is the inbox tool); chats seen: 1 |

Cursor run notes (2026-11-05 18:50, cursor-agent 2026.11.05-86047df, client with the Cursor fixes): `botlink up --app
cursor` now adds `Mcp(botlink:send|reply|inbox|roster|ask_human|handover)` to cursor-agent's `cli-config.json`
(`$XDG_CONFIG_HOME/cursor` here) and the matrix no longer writes a per-workspace `.cursor/cli.json`; every headless MCP
call in the three cells (the session-start chat's `send`, each resumed run's `inbox`) passed on those rules alone.
`resume` / `restart` are now the real `botlink watch`: the chat joins from its shell (`CURSOR_CONVERSATION_ID` names it,
so `wake_chat` = that chat), and watch runs `cursor-agent -p --resume <chat> "<wake prompt>"` with no extra flags (no
`--trust` / `--approve-mcps`: the chat's first run had approved both). One resume per cell covered all 20: in `resume`
the run started on message 1 and the model kept calling `inbox` while the other 19 arrived (watch's single-flight held
off a second resume); in `restart` all 20 were waiting when watch came back. `botlink uninstall cursor` then removed
mcp.json, hooks.json and exactly the six rules (cli-config.json identical to before except cursor-agent's own
`privacyCache.updatedAt`).

Idle notes (interactive CLIs in dedicated tmux sessions `botlink-idle-*`, killed by name; `botlink watch` running the
whole time and it started 0 resumes for either live session, as SPEC §6.9 says):
- Run 19:04 `claude-code idle` 7/20 is a SCORER bug, not a delivery failure: the server showed 20/20 shown and the chat
  printed all 20, but the scorer (1) didn't count the asyncRewake turn (Claude Code logs the waiter's stderr as a
  `user` record "Stop hook blocking error from command …" inside a `<task-notification>`), and (2) scanned every small
  transcript that mentioned the session id, which picked up an operator session that had printed 7 tokens. Fixed in
  matrix.ts (count the rewake user turn; only the chat's own project folder); re-run 19:09: 20/20.
- Claude Code: one typed prompt ("Say READY"), then no input; each message woke the idle chat through the Stop
  waiter (exit 2, stderr → new turn, "Stop hook feedback" in the TUI); 20/20 with no human input.
- Codex (codex-cli 0.162.1, throwaway CODEX_HOME with a copy of the logged-in auth.json; `last_refresh`
  2026-10-30T04:00:29Z before and after on both, copy deleted): an idle Codex TUI gets NOTHING by itself: 0/20 shown 90 s
  after the 20 sends (its Stop hook only runs at the end of a turn and there is no idle waiter; watch skips the live
  session). After ONE typed prompt ("Anything new from bot-link?") the UserPromptSubmit hook put all 20 in
  `additionalContext` (no tool call needed): 20/20. So Codex's idle behaviour is "next turn", as SPEC §7.2 has it.

## Run 2026-11-05T19:04:43.442Z · real CLIs · N=20, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| claude-code | idle | 20 | 7/20 | 20/20 | 0 | 0 | FAIL | no human input after the first prompt (Stop hook asyncRewake waiter); watch running, resumes it started: 0 |
| codex | idle | 20 | 20/20 | 20/20 | 0 | 0 | PASS | idle with no input for 90 s after the 20 sends: 0/20 shown; after ONE typed prompt: 20/20 shown; watch running, resumes it started: 0 |

## Run 2026-11-05T19:09:00.839Z · real CLIs · N=20, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| claude-code | idle | 20 | 20/20 | 20/20 | 0 | 0 | PASS | no human input after the first prompt (Stop hook asyncRewake waiter); watch running, resumes it started: 0 |

## Run 2026-11-05T21:36:29.630Z · real CLIs · N=10, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| codex | reply | 3 | 3/3 | 3/3 | 0 | 0 | PASS | save_rule in an attended run: saved; watch resumes 2; replies received by sender (reply tool, in_reply_to + token): 3/3; tool calls refused for approval: 0 |
| codex | resume | 10 | 10/10 | 10/10 | 0 | 8 | FAIL | holder after: same session |
| claude-code | reply | 3 | 3/3 | 3/3 | 0 | 0 | PASS | save_rule in an attended run: saved; watch resumes 3; replies received by sender (reply tool, in_reply_to + token): 3/3; tool calls refused for approval: 0 |
| claude-code | resume | 10 | 10/10 | 10/10 | 0 | 0 | PASS | holder after: same session |

## Run 2026-11-05T21:39:26.771Z · real CLIs · N=10, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| codex | resume | 10 | 10/10 | 10/10 | 0 | 0 | PASS | holder after: same session |
| codex | reply | 3 | 3/3 | 3/3 | 0 | 0 | PASS | save_rule in an attended run: saved; watch resumes 2; replies received by sender (reply tool, in_reply_to + token): 3/3; tool calls refused for approval: 0 |
| codex | session-start | 10 | 10/10 | 10/10 | 0 | 0 | PASS | resume run exit 0 |

Fix-round notes (2026-11-05, FINDINGS F1; codex-cli 0.162.1, throwaway CODEX_HOME with a copy of auth.json, `last_refresh`
2026-10-30T04:00:29Z before and after, copy deleted; Claude via the profile with bot-link only through flags,
`--setting-sources project,local`):
- New cell `reply`: the chat's human saves a standing rule (`save_rule`, attended `exec resume`), then `botlink watch`
  wakes the chat for each of 3 messages and the model must CALL the bot-link `reply` tool. Pass = 3/3 replies reach the
  sender (in_reply_to + token), the rule saved, 0 tool calls refused for approval.
- RED check (dist patched to write `default_tools_approval_mode = "prompt"`, 1 message): FAIL, `save_rule` refused
  ("the tool requires approval, but approvals are disabled"), 0/1 replies, 8 tool calls refused. GREEN with the fix
  (`"approve"`): codex reply 3/3 and claude-code reply 3/3.
- The first run's `codex resume` showed 8 "unflagged duplicates": a scorer artifact. Codex logs every finished tool call
  twice (the `response_item` the model is given + an `event_msg item_completed` copy); before F1 the woken run's `inbox`
  calls were refused, so this never showed. The scorer now counts only the model's copy; re-run 10/10, 0 duplicates.

## Run 2026-11-06T08:30:44.437Z · real CLIs · N=5, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| claude-code | session-start | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: join --wait failed: This chat has no join request waiting. (Another chat on this computer has one; it finishes in that chat, never here.) To join, run join with the invite and this chat's own name.
 |
| claude-code | resume | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: join --wait failed: This chat has no join request waiting. (Another chat on this computer has one; it finishes in that chat, never here.) To join, run join with the invite and this chat's own name.
 |
| claude-code | reply | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: join --wait failed: This chat has no join request waiting. (Another chat on this computer has one; it finishes in that chat, never here.) To join, run join with the invite and this chat's own name.
 |
| codex | session-start | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: join --wait failed: This chat has no join request waiting. (Another chat on this computer has one; it finishes in that chat, never here.) To join, run join with the invite and this chat's own name.
 |
| codex | resume | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: join --wait failed: This chat has no join request waiting. (Another chat on this computer has one; it finishes in that chat, never here.) To join, run join with the invite and this chat's own name.
 |
| codex | reply | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: join --wait failed: This chat has no join request waiting. (Another chat on this computer has one; it finishes in that chat, never here.) To join, run join with the invite and this chat's own name.
 |
| cursor | session-start | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: join --wait failed: This chat has no join request waiting. (Another chat on this computer has one; it finishes in that chat, never here.) To join, run join with the invite and this chat's own name.
 |
| cursor | resume | 0 | 0/0 | 0/0 | 0 | 0 | FAIL | ERROR: join --wait failed: This chat has no join request waiting. (Another chat on this computer has one; it finishes in that chat, never here.) To join, run join with the invite and this chat's own name.
 |

## Run 2026-11-06T08:46:33.251Z · real CLIs · N=5, gap 3s

| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |
|---|---|---|---|---|---|---|---|---|
| claude-code | session-start | 5 | 5/5 | 5/5 | 0 | 0 | PASS | resume run exit 0 |
| claude-code | resume | 5 | 5/5 | 5/5 | 0 | 0 | PASS | holder after: same session |
| claude-code | reply | 2 | 0/2 | 2/2 | 0 | 0 | FAIL | save_rule in an attended run: saved; watch resumes 2; replies received by sender (reply tool, in_reply_to + token): 0/2; tool calls refused for approval: 0 |
| codex | session-start | 5 | 5/5 | 5/5 | 0 | 0 | PASS | resume run exit 0 |
| codex | resume | 5 | 5/5 | 5/5 | 0 | 0 | PASS | holder after: same session |
| codex | reply | 2 | 0/2 | 2/2 | 0 | 0 | FAIL | save_rule in an attended run: saved; watch resumes 2; replies received by sender (reply tool, in_reply_to + token): 0/2; tool calls refused for approval: 0 |
| cursor | session-start | 5 | 5/5 | 5/5 | 0 | 5 | FAIL | new chat b193813f exit 0; MCP send back: NOT received (FAIL: send back) |
| cursor | resume | 5 | 5/5 | 5/5 | 0 | 0 | PASS | watch resumed chat 99d1c79c 2x (cursor-agent -p --resume; no sessionStart on resume: delivery is the inbox tool); chats seen: 1 |
