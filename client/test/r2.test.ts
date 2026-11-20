/**
 * Release r2 ("after the join, it just works"; onboarding feedback 2026-11-06):
 *   1. per-chat identity by session: a second chat in the same folder (or a fork) is not the member, --as can't borrow it
 *   2. CLI fallback: roster/send/inbox/reply/status/label in help and per-command help; unknown command shows help
 *   3. consent: setup previews (no write) and defaults to project scope; --yes writes the project files; old v3 entries
 *   4. verified delivery: the self-test proves idle delivery only when a woken run shows it
 *   5. honest inbox: FYIs are quiet (no Stop nudge, no idle wake), same text to room + member shown once, 502s quiet
 *   6. own label next to the measured one
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as h from "../src/harnesses.js";
import { tools } from "../src/mcp.js";
import { applySetup, previewSetup, uninstallAll } from "../src/setup.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake, assertCopy } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let f: FakeServer;
before(async () => {
  assertIsolated();
  assert.ok(existsSync(CLI), "build first (npm test builds)");
  f = await startFake();
});
after(async () => f.stop());

const S1 = "a1a1a1a1-1111-4222-8333-000000000001";
const S2 = "b2b2b2b2-1111-4222-8333-000000000002";
const SX = "c3c3c3c3-1111-4222-8333-000000000003";

function run(home: string, cwd: string, env: Record<string, string>, args: string[], stdin?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (/^(CLAUDE|CODEX|CURSOR|OPENCODE|T3CODE)/.test(k)) delete base[k];
    const ch = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...base, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, ...env } });
    let stdout = "", stderr = "";
    ch.stdout.on("data", (b) => (stdout += b));
    ch.stderr.on("data", (b) => (stderr += b));
    if (stdin !== undefined) ch.stdin.end(stdin);
    ch.on("exit", (code) => res({ code, stdout, stderr }));
  });
}

async function joinIn(home: string, cwd: string, room: any, adam: any, name: string, app: st.App, session: string | null, env: Record<string, string | undefined> = {}) {
  return on(home, async () => {
    const r = await core.joinCreate({ invite: f.invite(room, adam), name, job: `${name} job`, app, turn: "on_turn", session, cwd, folder: "~/w", machine: "m" });
    f.approve(r.req.id);
    return (await core.joinWait({ maxMs: 3000 })) as any;
  }, env);
}

async function twoInOneFolder() {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `id${Math.floor(Math.random() * 1e6)}`);
  const home = newHome("r2id");
  const w = join(home, "w");
  mkdirSync(w, { recursive: true });
  const a = (await joinIn(home, w, room, adam, "alpha", "claude-code", S1)).member as st.MemberRec;
  const peerHome = newHome("r2peer");
  const peer = (await joinIn(peerHome, peerHome, room, adam, "peer", "codex", SX)).member as st.MemberRec;
  return { adam, room, home, w, a, peerHome, peer };
}

test("identity: a second Claude Code chat in the same folder is not the member; --as can't borrow it; the holder can", async () => {
  const { home, w, a, peerHome, peer } = await twoInOneFolder();
  await on(peerHome, () => core.send(st.loadMember(peer.id)!, { to: "alpha", text: "BLTOK-id ping", intent: "question" }, SX));
  // chat 2 (another session, same folder, same app): not a member, and --as alpha is refused with the claim hint
  const other = await run(home, w, { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: S2 }, ["inbox", "--as", "alpha"]);
  assert.notEqual(other.code, 0);
  assert.match(other.stderr, /alpha in #id\d+ belongs to another chat .*use bot-link as alpha/);
  const viaMcp = await on(home, () => { const c = process.cwd(); process.chdir(w); return tools({ app: "claude-code", session: () => S2 }).inbox({}).catch((e: Error) => e.message).finally(() => process.chdir(c)); });
  assert.match(viaMcp, /isn't a bot-link member yet/);
  assert.doesNotMatch(viaMcp, /BLTOK-id/);
  // the holder chat reads it
  const mine = await run(home, w, { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: S1 }, ["inbox"]);
  assert.equal(mine.code, 0, mine.stderr);
  assert.match(mine.stdout, /BLTOK-id ping/);
  // an explicit --session wins over the app's env (apps bot-link can't detect pass it themselves)
  const st1 = await run(home, w, { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: S2 }, ["status", "--session", S1]);
  assert.match(st1.stdout, /session a1a1a1a1-1111-4222-8333-000000000001 \(from --session\)[\s\S]*Acting as: alpha in #/);
  // founder: a terminal or another app's chat (no session of alpha's) can't name it either
  const term = await run(home, w, { BOTLINK_APP: "other" }, ["roster", "--as", "alpha"]);
  assert.notEqual(term.code, 0);
  const cur = await run(home, w, { BOTLINK_APP: "cursor", CURSOR_CONVERSATION_ID: "c0c0c0c0-9999-4222-8333-000000000001" }, ["send", "--as", "alpha", "--to", "peer", "--intent", "fyi", "--text", "TAKEOVER"]);
  assert.notEqual(cur.code, 0);
  assert.match(cur.stderr, /alpha is a Claude Code member; this chat is Cursor/);
  void a;
});

test("identity: a fork (new session id, same folder) starts as a non-member with a claim prompt; claim moves it", async () => {
  const { home, w, a } = await twoInOneFolder();
  const child = spawn(process.execPath, [CLI, "hook", "claude-code", "session-start"], { cwd: w, env: { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stdin.end(JSON.stringify({ session_id: S2, cwd: w, source: "resume" }));
  await new Promise((r) => child.on("exit", r));
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
  assert.match(ctx, /this chat is NOT a bot-link member/);
  assert.match(ctx, /copy \(fork\)[\s\S]*use bot-link as alpha/);
  assert.match(ctx, /don't act as alpha, even if earlier messages in this chat did/);
  assertCopy(ctx);
  // the human says "use bot-link as alpha" in the fork: claim asks the person (H1); after approval the fork is alpha
  const cl = await on(home, () => core.claim("alpha", S2));
  assert.match(cl.text, /Moving alpha \(#[^)]+\) to this chat needs .+'s OK in the browser/);
  assert.equal(f.members.get(a.id)!.holder_session, S1);
  f.approve(f.lastMove!);
  const w2 = await on(home, () => core.joinWait({ maxMs: 3000, app: "claude-code", session: S2, cwd: w }));
  assert.equal(w2.status, "approved");
  assert.match(w2.text, /This chat is now alpha/);
  assert.equal(f.members.get(a.id)!.holder_session, S2);
});

test("CLI fallback: help lists roster/send/inbox/reply/status; per-command help; unknown command prints the help", async () => {
  const home = newHome("r2help");
  const hlp = await run(home, home, {}, ["--help"]);
  for (const c of ["roster", "send --to", "inbox", "reply <message id>", "status", "setup", "wait [--max-s", "listen --on-message", "listen --tmux", "send --to <member> --intent question --text \"<text>\" --wait-s", "label"]) assert.ok(hlp.stdout.includes(c), c);
  const lh = await run(home, home, {}, ["listen", "--help"]);
  for (const c of ["listen --via codex-queue|opencode|t3", "listen … --show", "1. Background:", "2. In your turn:", "3. Listener:", "Ways 1 and 2 only wait", "Pick the first that passes the wake test here"]) assert.ok(lh.stdout.includes(c), c);
  for (const c of ["roster", "send", "inbox", "reply", "status", "setup", "listen", "label", "join"]) {
    const r = await run(home, home, {}, [c, "--help"]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.split("\n")[0].includes(` ${c}`), `${c}: ${r.stdout}`);
  }
  const bad = await run(home, home, {}, ["frobnicate"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Unknown command frobnicate[\s\S]*roster[\s\S]*send/);
});

test("CLI: roster, send --intent check, label and status work as the member before any setup", async () => {
  const { home, w, peerHome, peer } = await twoInOneFolder();
  const env = { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: S1 };
  const r = await run(home, w, env, ["roster"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /alpha \(this chat\)/);
  assert.match(r.stdout, /peer · Codex/);
  const bad = await run(home, w, env, ["send", "--to", "peer", "--intent", "whatever", "--text", "x"]);
  assert.notEqual(bad.code, 0);
  const s = await run(home, w, env, ["send", "--to", "peer", "--intent", "question", "--text", "BLTOK-cli-send", "--json"]);
  assert.equal(s.code, 0, s.stderr);
  const id = JSON.parse(s.stdout).id;
  assert.equal(f.copies(id)[0].quiet, false);
  const l = await run(home, w, env, ["label", "always on, server chat"]);
  assert.equal(l.code, 0, l.stderr);
  const pr = await on(peerHome, () => core.rosterText(st.loadMember(peer.id)!, SX));
  assert.ok([...f.members.values()].some((m: any) => m.self_label === "always on, server chat"));
  void pr;
  const stt = await run(home, w, env, ["status"]);
  assert.match(stt.stdout, /This chat: Claude Code · session a1a1a1a1-1111-4222-8333-000000000001 \(from the app's environment\)/);
  assert.match(stt.stdout, /Acting as: alpha in #/);
  assert.match(stt.stdout, /Tools: not set up in Claude Code/);
  assert.match(stt.stdout, /its own words: "always on, server chat"/);
});

test("consent: setup previews exact lines and writes nothing; project scope by default; --yes writes .mcp.json + settings.local.json; uninstall cleans", async () => {
  const home = newHome("r2setup");
  const proj = join(home, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  const pv = await run(home, proj, {}, ["setup", "claude-code", "--no-watch"]);
  assert.equal(pv.code, 2, pv.stdout + pv.stderr);
  assert.match(pv.stdout, /project scope: only chats started in .*proj get bot-link/);
  assert.match(pv.stdout, /create .*proj\/\.mcp\.json/);
  assert.match(pv.stdout, /\+ +"botlink": \{/);
  assert.match(pv.stdout, /create .*proj\/\.claude\/settings\.local\.json/);
  assert.match(pv.stdout, /enabledMcpjsonServers/);
  assert.match(pv.stdout, /launcher: create ~\/\.local\/bin\/botlink/);
  assert.match(pv.stdout, /Nothing was changed yet[\s\S]*setup claude-code --no-watch --yes/);
  assert.ok(!existsSync(join(proj, ".mcp.json")) && !existsSync(join(proj, ".claude")), "the preview wrote nothing");
  assert.ok(!existsSync(join(home, ".claude.json")) && !existsSync(join(home, ".local", "bin", "botlink")));
  const ap = await run(home, proj, {}, ["setup", "claude-code", "--no-watch", "--yes"]);
  assert.equal(ap.code, 0, ap.stdout + ap.stderr);
  const mcp = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf-8"));
  assert.ok(mcp.mcpServers.botlink.args.includes("mcp"));
  const loc = JSON.parse(readFileSync(join(proj, ".claude", "settings.local.json"), "utf-8"));
  assert.deepEqual(loc.enabledMcpjsonServers, ["botlink"]);
  assert.equal(Object.keys(loc.hooks).sort().join(","), "SessionStart,Stop,UserPromptSubmit");
  assert.ok(!existsSync(join(home, ".claude.json")) && !existsSync(join(home, ".claude", "settings.json")), "profile files untouched");
  const shim = readFileSync(join(home, ".local", "bin", "botlink"), "utf-8");
  assert.match(shim, /# bot-link launcher/);
  // running it again is a no-op preview
  const again = await run(home, proj, {}, ["setup", "claude-code", "--no-watch"]);
  assert.equal(again.code, 0, again.stdout);
  assert.match(again.stdout, /already set up/);
  // uninstall takes it all out again (project files bot-link created are removed, the launcher too)
  const un = await run(home, proj, {}, ["uninstall"]);
  assert.equal(un.code, 0, un.stdout + un.stderr);
  assert.ok(!existsSync(join(proj, ".mcp.json")), un.stdout);
  assert.ok(!existsSync(join(proj, ".claude", "settings.local.json")), un.stdout);
  assert.ok(!existsSync(join(home, ".local", "bin", "botlink")));
});

test("consent: an existing project settings.local.json keeps the user's keys; user scope writes the profile only with --scope user", async () => {
  const home = newHome("r2setup2");
  const proj = join(home, "proj");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(proj, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, enabledMcpjsonServers: ["mine"] }, null, 2) + "\n");
  const r = await on(home, () => { const c = process.cwd(); process.chdir(proj); try { return applySetup({ apps: ["claude-code"], watch: false, shim: false }); } finally { process.chdir(c); } });
  assert.ok(r.ok, r.lines.join("\n"));
  const loc = JSON.parse(readFileSync(join(proj, ".claude", "settings.local.json"), "utf-8"));
  assert.deepEqual(loc.permissions.allow, ["Bash(ls:*)"]);
  assert.deepEqual(loc.enabledMcpjsonServers, ["mine", "botlink"]);
  await on(home, () => { const c = process.cwd(); process.chdir(proj); try { uninstallAll({ scope: "project" }); } finally { process.chdir(c); } });
  const after1 = JSON.parse(readFileSync(join(proj, ".claude", "settings.local.json"), "utf-8"));
  assert.deepEqual(after1, { permissions: { allow: ["Bash(ls:*)"] }, enabledMcpjsonServers: ["mine"] }, "exactly the user's file again");
  const u = await on(home, () => applySetup({ apps: ["claude-code"], scope: "user", watch: false, shim: false }));
  assert.ok(u.ok);
  assert.ok(existsSync(join(home, ".claude.json")) && existsSync(join(home, ".claude", "settings.json")));
});

test("consent: old bot-link v3 servers are found and removed only with --remove-old (backup first)", async () => {
  const home = newHome("r2old");
  const proj = join(home, "proj");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  const old = { mcpServers: { "botlink-cloud": { command: "npx", args: ["-y", "botlink-mcp", "serve", "--cloud"] }, keepme: { command: "x" } } };
  writeFileSync(join(home, ".claude.json"), JSON.stringify(old, null, 2));
  const pv = await on(home, () => { const c = process.cwd(); process.chdir(proj); try { return previewSetup({ apps: ["claude-code"], watch: false, shim: false }); } finally { process.chdir(c); } });
  assert.match(pv.lines.join("\n"), /Old bot-link servers found[\s\S]*"botlink-cloud"[\s\S]*add --remove-old/);
  assert.equal(pv.old.length, 1);
  assert.ok(JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8")).mcpServers["botlink-cloud"], "untouched by the preview");
  const ap = await run(home, proj, {}, ["setup", "claude-code", "--no-watch", "--no-shim", "--remove-old", "--yes"]);
  assert.equal(ap.code, 0, ap.stdout + ap.stderr);
  assert.match(ap.stdout, /removed the old "botlink-cloud" server .*backup: /);
  const now = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
  assert.ok(!now.mcpServers["botlink-cloud"] && now.mcpServers.keepme);
});

test("join edits no config, lists the talk-now commands and the restart answer before the code, and the approve link", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `jn${Math.floor(Math.random() * 1e6)}`);
  const home = newHome("r2join");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const r = await run(home, home, { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: S1 }, ["join", f.invite(room, adam), "--name", "jj", "--job", "j"]);
  assert.equal(r.code, 0, r.stderr);
  // r3: the session is known (CLAUDE_CODE_SESSION_ID), so the talk-now commands need no --as
  assert.doesNotMatch(r.stdout, /roster --as jj/);
  const iTalk = r.stdout.indexOf(" roster\n"), iRestart = r.stdout.indexOf("not set up in Claude Code here"), iLink = r.stdout.indexOf("/approve/"), iCode = r.stdout.indexOf("\nCode ");
  assert.ok(iTalk >= 0 && iRestart > iTalk && iLink > iRestart && iCode > iLink, r.stdout);
  assert.match(r.stdout, /Code [2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3} · key/);
  assert.ok(!existsSync(join(home, ".claude.json")) && !existsSync(join(home, ".claude", "settings.json")));
});

test("verified delivery: the join's self-test is queued; shown at a turn it proves nothing; shown by a woken run it PASSES", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `st${Math.floor(Math.random() * 1e6)}`);
  const home = newHome("r2st");
  const w = await joinIn(home, home, room, adam, "tester", "claude-code", S1, { BOTLINK_NO_SELFTEST: undefined });
  assert.equal(w.status, "approved");
  assert.match(w.text, /Wake test: bot-link's hooks \(or watch\) are already set up for this app here, so something may already wake this chat\. In about \d+ s bot-link \(a system sender, not a member\) sends this chat a test message: end your turn now/);
  assert.match(w.text, /Round trip: .*"you're in" received ✓/);
  assert.doesNotMatch(w.text, /even when this chat is idle\./);
  const m = w.member as st.MemberRec;
  assert.equal(f.deliveries.filter((d: any) => d.member === m.id && d.scope === "self" && d.state === "queued").length, 1);
  // M2: a Claude Code chat's own inbox read happens inside a turn: the test proves nothing either way (no FAILED)
  const t0 = await on(home, () => tools({ app: "claude-code", session: () => S1 }).inbox({}));
  assert.match(t0, /From: bot-link \(system test/);
  assert.match(t0, /wake test for tester: no result\. This chat picked it up itself during a turn/);
  assert.doesNotMatch(t0, /FAILED/);
  assert.equal(st.readJson<any>(join(home, ".botlink", "members", `${m.id}.json`), null).selftest.woken, null);
  // shown at a human turn (the prompt hook): nothing woke the idle chat -> FAILED + the next command
  await on(home, () => core.sendSelftest(st.loadMember(m.id)!, S1));
  const pb = await on(home, () => core.takeBatch([st.loadMember(m.id)!], S1, { waitS: 0 }));
  const t1 = pb.text;
  await on(home, () => pb.commit());
  assert.match(t1, /From: bot-link \(system test/);
  assert.match(t1, /wake test for tester: FAILED\. This test reached this chat only on a turn/);
  // Kickoff 2: no command picked for the app; the same short list for every app
  assert.match(t1, /doesn't work here: stop it, try another, and test again with `[^`]*selftest`\. The signal is `[^`]*wait`/);
  assert.doesNotMatch(t1, /codex-queue|listen --once --print/);
  assert.doesNotMatch(t1, /<<<BEGIN/, "our words, not a fenced agent message");
  assertCopy(t1);
  assert.equal(st.readJson<any>(join(home, ".botlink", "members", `${m.id}.json`), null).selftest.woken, false);
  assert.ok(!f.members.get(m.id)!.wake_verified_at);
  // a woken run (watch / listener / Claude Code's idle waiter) shows the next one: PASSED, and the server learns it
  await on(home, () => core.sendSelftest(st.loadMember(m.id)!, S1));
  const b = await on(home, () => core.takeBatch([st.loadMember(m.id)!], S1, { woken: true }));
  assert.match(b.text, /wake test for tester: PASSED\. Something outside this chat gave it a turn, without anyone typing, and this chat read the test right away: an idle chat is reached/);
  await on(home, () => b.commit());
  assert.ok(f.members.get(m.id)!.wake_verified_at, "ack woken -> wake verified");
  assert.ok(f.ackLog.some((x) => x.member === m.id && x.woken));
  const rec = st.readJson<any>(join(home, ".botlink", "members", `${m.id}.json`), null);
  assert.equal(rec.selftest.woken, true);
  const s = await run(home, home, { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: S1 }, ["status"]);
  assert.match(s.stdout, /wake test PASSED: an idle chat is reached ✓/);
  // M2: a stale copy of the member record saved by another process never wipes the result
  await on(home, () => {
    const stale = st.loadMember(m.id)!;
    stale.selftest = { ...stale.selftest!, shown_at: null, woken: null };
    st.saveMember(stale);
    assert.equal(st.loadMember(m.id)!.selftest!.woken, true);
  });
  // M2: history shows what the test proved when it arrived, never a new FAILED
  const hist = await on(home, () => tools({ app: "claude-code", session: () => S1 }).inbox({ history: true }));
  assert.match(hist, /wake test for tester \(earlier\): PASSED/);
  assert.doesNotMatch(hist, /FAILED \(wake test failed/);
  // with a listener holding the wait, the room now sees "wakes on its own"
  f.members.get(m.id)!.last_wait_at = Date.now();
  const v = await on(home, () => core.refreshRoster(st.loadMember(m.id)!, S1));
  assert.equal(v.display.get(m.id)!.turn_label, "wakes on its own");
});

test("honest inbox: an FYI is quiet (no Codex Stop nudge, no idle wake); a question nudges; same text to room + member shown once", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `q${Math.floor(Math.random() * 1e6)}`);
  const hA = newHome("r2qa"), hB = newHome("r2qb");
  const a = (await joinIn(hA, hA, room, adam, "sender", "claude-code", S1)).member as st.MemberRec;
  const b = (await joinIn(hB, hB, room, adam, "codexy", "codex", SX)).member as st.MemberRec;
  const send = (to: string, text: string, intent: any) => on(hA, () => core.send(st.loadMember(a.id)!, { to, text, intent }, S1));
  const intro = await send("room", "BLTOK-intro hi, I'm sender", "fyi");
  assert.equal(f.copies(intro.id)[0].quiet, true);
  const stop = (sess: string) => new Promise<string>((res) => {
    const ch = spawn(process.execPath, [CLI, "hook", "codex", "stop"], { cwd: hB, env: { ...process.env, HOME: hB, BOTLINK_HOME: join(hB, ".botlink"), BOTLINK_SERVER: f.url }, stdio: ["pipe", "pipe", "pipe"] });
    let o = "";
    ch.stdout.on("data", (x) => (o += x));
    ch.stdin.end(JSON.stringify({ session_id: sess, cwd: hB }));
    ch.on("exit", () => res(o));
  });
  assert.equal((await stop(SX)).trim(), "", "an FYI never blocks the turn");
  // the watch/listener wait (urgent_only) doesn't count it either
  const wq = await on(hB, () => core.apiFor(f.url).call<any>({ method: "POST", path: "/api/v1/me/wait", body: { wait_s: 0, urgent_only: true }, signer: core.signerOf(b), retryForMs: 0 }));
  assert.equal(wq.json.count, 0);
  await send("codexy", "BLTOK-q what's the build status?", "question");
  assert.match(await stop(SX), /"decision":"block".*1 new bot-link message/);
  // the same text to the room and to codexy: one copy shown, both acked
  const r1 = await send("room", "BLTOK-dup deploy window is 3pm", "task");
  const r2 = await send("codexy", "BLTOK-dup deploy window is 3pm", "task");
  const box = await on(hB, () => tools({ app: "codex", session: () => SX }).inbox({}));
  assert.equal(box.split("BLTOK-dup deploy window is 3pm").length - 1, 1, box);
  assert.match(box, /sent this to (the room|you) and to (you|the room) too; shown once/);
  assert.match(box, /BLTOK-intro/, "the quiet FYI rides along with this batch");
  assert.equal(f.copies(r1.id).find((d: any) => d.member === b.id)!.state, "shown");
  assert.equal(f.copies(r2.id)[0].state, "shown");
});

test("a 502 from the server never becomes text for the model; takeBatch says it failed quietly", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `e${Math.floor(Math.random() * 1e6)}`);
  const home = newHome("r2err");
  const m = (await joinIn(home, home, room, adam, "flaky", "claude-code", S1)).member as st.MemberRec;
  f.failNext = { path: /\/me\/inbox\/lease$/, status: 502, code: "bad_gateway", times: 1 };
  const b = await on(home, () => core.takeBatch([st.loadMember(m.id)!], S1, { waitS: 1 }));
  assert.equal(b.text, "");
  assert.equal(b.failed, 1);
});

test("MCP: every tool takes session; join text says the tools are here and shows the approve link + 6-character code", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `mj${Math.floor(Math.random() * 1e6)}`);
  const home = newHome("r2mcp");
  const t = tools({ app: "opencode", session: () => null });
  const out = await on(home, () => t.join({ invite: f.invite(room, adam), name: "oc-one", job: "x", session: "ses_abc123" } as any));
  assert.match(out, /This chat has the bot-link tools now[\s\S]*Approve in the browser: http:\/\/localhost:8811\/approve\/[0-9a-f-]{36}\nCode [2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}/);
  const req = await on(home, () => st.allRequests()[0]);
  assert.deepEqual(req.wake, { via: "opencode", id: "ses_abc123" }, "OpenCode's session is kept to wake it (listen --via opencode)");
  assert.equal(req.session_id, null, "never a holder: OpenCode's tools carry no session");
});

test("founder: another app's `join --wait` never finishes this chat's approved request; the own wait does; a second wait says 'already joined'", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `tk${Math.floor(Math.random() * 1e6)}`);
  const home = newHome("r2take");
  const mac = { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: S1 };
  const cur = { BOTLINK_APP: "cursor", CURSOR_CONVERSATION_ID: "c0c0c0c0-9999-4222-8333-000000000002" };
  const j = await run(home, home, mac, ["join", f.invite(room, adam), "--name", "acme-mac", "--job", "mac", "--no-setup"]);
  assert.equal(j.code, 0, j.stderr);
  f.approve([...f.joins.values()].find((x) => x.body.name === "acme-mac")!.id);
  const steal = await run(home, home, cur, ["join", "--wait", "--max-s", "3"]);
  assert.doesNotMatch(steal.stdout, /Joined #/, steal.stdout);
  assert.match(steal.stderr, /This chat has no join request waiting/);
  const asMac = await run(home, home, cur, ["inbox", "--as", "acme-mac"]);
  assert.notEqual(asMac.code, 0);
  const own = await run(home, home, mac, ["join", "--wait", "--max-s", "5"]);
  assert.equal(own.code, 0, own.stderr);
  assert.match(own.stdout, /Joined #tk\d+ as acme-mac/);
  const again = await run(home, home, mac, ["join", "--wait", "--max-s", "3"]);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already joined #tk\d+ as acme-mac/);
  // the Cursor chat's own join is its own request with its own key
  const cj = await run(home, home, cur, ["join", f.invite(room, adam), "--name", "cursor", "--job", "cursor chat", "--no-setup"]);
  assert.equal(cj.code, 0, cj.stderr);
  const reqs = [...f.joins.values()].filter((x) => x.room === room.id);
  const mk = reqs.find((x) => x.body.name === "acme-mac")!, cu = reqs.find((x) => x.body.name === "cursor")!;
  assert.equal(cu.status, "pending");
  assert.notEqual(cu.body.ed25519_pk, mk.body.ed25519_pk);
  // and a cross-app claim of acme-mac is refused (it needs the dashboard)
  const cl = await run(home, home, cur, ["claim", "acme-mac"]);
  assert.notEqual(cl.code, 0);
  assert.match(cl.stderr, /needs your human's approval on the dashboard/);
});

test("dedupe across batches: the same text again within 10 minutes is acked shown at once, never rendered, never left leased (eval s10 2026-11-06)", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `dd${Math.floor(Math.random() * 1e6)}`);
  const hA = newHome("r2dda"), hB = newHome("r2ddb");
  const a = (await joinIn(hA, hA, room, adam, "rev", "codex", SX)).member as st.MemberRec;
  const b = (await joinIn(hB, hB, room, adam, "lead", "claude-code", S1)).member as st.MemberRec;
  const send = () => on(hA, () => core.send(st.loadMember(a.id)!, { to: "lead", text: "BLTOK-dd status: free today", intent: "answer" as any }, SX));
  const s1 = await send();
  const first = await on(hB, () => tools({ app: "claude-code", session: () => S1 }).inbox({}));
  assert.match(first, /BLTOK-dd status/);
  const s2 = await send();
  const b2 = await on(hB, () => core.takeBatch([st.loadMember(b.id)!], S1, { waitS: 0 }));
  assert.equal(b2.text, "", "not rendered again");
  await on(hB, () => b2.release()); // a hook that showed nothing releases: the duplicate is already acked
  assert.equal(f.copies(s2.id)[0].state, "shown");
  assert.equal(f.copies(s1.id)[0].state, "shown");
});
