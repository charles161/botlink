/**
 * Client <-> real Go server integration (PLAN §2, §5.2 client-side rows). Skipped unless BOTLINK_IT_SERVER and
 * BOTLINK_IT_PG are set (scripts/run-it.sh sets them). Server on 127.0.0.1:8821, private PG 55432/botlink_test_client.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import * as c from "../src/crypto.js";
import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { tools } from "../src/mcp.js";
import { IT, RealServer, Browser, sql } from "./it/realserver.js";
import { assertIsolated, newHome, on, assertCopy } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const PORT = Number(process.env.BOTLINK_IT_PORT || 8821);
let srv: RealServer;
let adam: Browser;

const skip = !IT && "set BOTLINK_IT_SERVER + BOTLINK_IT_PG (scripts/run-it.sh)";

before(async () => {
  if (!IT) return;
  assertIsolated();
  await c.ready();
  const logs = join(process.env.BOTLINK_TEST_BASE!, "logs");
  mkdirSync(logs, { recursive: true });
  srv = await new RealServer(PORT).start(logs);
  process.env.BOTLINK_SERVER = srv.url;
  adam = await new Browser(srv.url).login("Adam");
});
after(async () => {
  if (srv) await srv.stop();
});

const state = (msg: string, member?: string) => sql(`select state from deliveries where message_id='${msg}'${member ? ` and member_id='${member}'` : ""} order by member_id`);

async function joinVia(b: Browser, room: { id: string }, home: string, name: string, app: st.App, session: string | null, turn: st.Turn = "wake") {
  const inv = await b.chatInvite(room.id);
  return on(home, async () => {
    const r = await core.joinCreate({ invite: inv, name, job: `${name} job`, app, turn, session, cwd: home, folder: "~", machine: "it-box" });
    const card = await b.card(r.req.id);
    assert.equal(card.match_code, r.req.match_code, "the dashboard shows the chat's code");
    assert.equal(c.memberFingerprint(card.ed25519_pk, card.x25519_pk), r.req.fingerprint, "browser-computed fingerprint = chat's key");
    await b.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 10_000 });
    assert.equal(w.status, "approved", w.text);
    return (w as any).member as st.MemberRec;
  });
}

let roomN = 0;
async function twoChats() {
  const room = await adam.createRoom(`it${Date.now() % 1e7}${roomN++}`, "integration");
  const hA = newHome("it-a"), hB = newHome("it-b");
  const SA = c.uuidv7(), SB = c.uuidv7();
  const mA = await joinVia(adam, room, hA, "alpha", "codex", SA);
  const mB = await joinVia(adam, room, hB, "bravo", "claude-code", SB);
  return { room, hA, hB, SA, SB, mA, mB };
}

test("M1: join -> code + key -> approve on the dashboard -> self-check -> Joined, room fingerprint pinned", { skip }, async () => {
  const room = await adam.createRoom(`m1${Date.now() % 1e7}`, "milestone one");
  const h = newHome("m1");
  const m = await joinVia(adam, room, h, "bugfix", "claude-code", c.uuidv7());
  const det = await adam.call("GET", `/app/v1/rooms/${room.id}`);
  await on(h, () => assert.equal(st.loadMember(m.id)!.pin.room_fp, det.room_fingerprint, "chat's pin = the room page's fingerprint"));
  assert.equal(det.members[0].name, "bugfix");
});

test("open invite preview against the real server: room name + member count, no names/jobs/inviter", { skip }, async () => {
  const room = await adam.createRoom(`pv${Date.now() % 1e7}`, "Purposesecret plan");
  await joinVia(adam, room, newHome("pv"), "membersecret", "codex", c.uuidv7());
  const inv = await adam.chatInvite(room.id);
  const { preview } = await core.previewInvite(inv);
  assert.deepEqual(Object.keys(preview).sort(), ["expires_at", "member_count", "room"]);
  assert.equal(preview.member_count, 1);
  const text = core.previewText(preview);
  assertCopy(text);
  assert.match(text, /1 AI chat is in this room\./);
  for (const leak of ["membersecret", "Purposesecret", "Adam", "membersecret job"]) assert.ok(!text.includes(leak), `preview shows ${leak}:\n${text}`);
});

test("T8 (client side): keys swapped in the DB before approve -> fingerprints differ, self-check fails, keys deleted", { skip }, async () => {
  const room = await adam.createRoom(`t8${Date.now() % 1e7}`);
  const inv = await adam.chatInvite(room.id);
  const h = newHome("t8");
  await on(h, async () => {
    const r = await core.joinCreate({ invite: inv, name: "victim", job: "", app: "codex", turn: "on_turn", session: null, cwd: h, folder: "~", machine: "m" });
    const evil = c.genKeys();
    sql(`update join_requests set ed25519_pk = decode('${evil.ed}','hex'), x25519_pk = decode('${evil.x}','hex') where id = '${r.req.id}'`);
    const card = await adam.card(r.req.id);
    assert.notEqual(c.memberFingerprint(card.ed25519_pk, card.x25519_pk), r.req.fingerprint, "W: the approve card shows a different fingerprint");
    await adam.approve(r.req.id); // a careless human approves anyway
    const w = await core.joinWait({ maxMs: 10_000 });
    assert.equal(w.status, "mismatch");
    // blocker 10: the same opening, then what was taken back and what to tell the human (joinend.test.ts)
    assert.match(w.text, /^(This approval does not match this chat's key|bot-link stopped waiting: the server no longer holds this chat's key)/);
    assert.match(w.text, /Nothing was joined/);
    assert.equal(st.liveMembers().length, 0);
    assert.equal(existsSync(join(process.env.BOTLINK_HOME!, "keys", `${r.req.key_id}.json`)), false);
  });
});

test("reject -> exit-4 state with the plain sentence", { skip }, async () => {
  const room = await adam.createRoom(`rj${Date.now() % 1e7}`);
  const inv = await adam.chatInvite(room.id);
  const h = newHome("rj");
  await on(h, async () => {
    const r = await core.joinCreate({ invite: inv, name: "nope", job: "", app: "codex", turn: "on_turn", session: null, cwd: h, folder: "~", machine: "m" });
    await adam.reject(r.req.id);
    const w = await core.joinWait({ maxMs: 10_000 });
    assert.equal(w.status, "rejected");
    assert.equal(w.text, `${adam.account.display_name} didn't approve this.`);
  });
});

test("send -> inbox -> reply against the real server (T6 client view: only my copy done)", { skip }, async () => {
  const { room, hA, hB, SA, SB, mA, mB } = await twoChats();
  const hC = newHome("it-c");
  const mC = await joinVia(adam, room, hC, "charlie", "cursor", null, "on_turn");
  const s = await on(hA, () => core.send(st.loadMember(mA.id)!, { to: "room", text: "BLTOK-it-room", intent: "question" }, SA));
  assertCopy(s.text);
  assert.equal(sql(`select count(*) from deliveries where message_id='${s.id}'`), "2");
  const got = await on(hB, () => tools({ app: "claude-code", session: () => SB }).inbox({}));
  assert.match(got, /BLTOK-it-room/);
  assert.match(got, /to: the room/);
  assert.equal(state(s.id, mB.id), "shown");
  await on(hB, () => tools({ app: "claude-code", session: () => SB }).reply({ message_id: s.id, text: "BLTOK-it-reply" }));
  assert.equal(state(s.id, mB.id), "done");
  assert.equal(state(s.id, mC.id), "queued", "the other recipient's copy is untouched");
  const back = await on(hA, () => tools({ app: "codex", session: () => SA }).inbox({}));
  assert.match(back, /BLTOK-it-reply/);
  assert.match(back, /from: bravo \(Claude Code · Adam's chat\)/);
});

test("hooks against the real server: SessionStart shows + acks shown; a dead stdout releases; Stop waiter rewakes", { skip }, async () => {
  const { hA, hB, SA, SB, mA, mB } = await twoChats();
  const run = (home: string, app: string, ev: string, input: any, closeStdout = false) =>
    new Promise<{ code: number | null; out: string; err: string }>((res) => {
      const ch = spawn(process.execPath, [CLI, "hook", app, ev], { cwd: home, env: { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: srv.url } });
      let out = "", err = "";
      ch.stdout.on("data", (b) => (out += b));
      ch.stderr.on("data", (b) => (err += b));
      if (closeStdout) ch.stdout.destroy();
      ch.stdin.end(JSON.stringify(input));
      ch.on("exit", (code) => res({ code, out, err }));
    });
  const send = (t: string) => on(hA, () => core.send(st.loadMember(mA.id)!, { to: "bravo", text: t, intent: "task" }, SA));
  const s1 = await send("BLTOK-it-hook-1");
  const dead = await run(hB, "claude-code", "session-start", { session_id: SB, cwd: hB }, true);
  assert.equal(dead.code, 0);
  assert.equal(state(s1.id), "queued");
  assert.equal(sql(`select lease_until is null from deliveries where message_id='${s1.id}'`), "t", "released");
  const ok = await run(hB, "claude-code", "session-start", { session_id: SB, cwd: hB });
  assert.equal(ok.code, 0);
  assert.match(JSON.parse(ok.out).hookSpecificOutput.additionalContext, /re-delivered: .*BLTOK-it-hook-1/s);
  assert.equal(state(s1.id), "shown");
  const waiter = run(hB, "claude-code", "stop", { session_id: SB, cwd: hB });
  await new Promise((r) => setTimeout(r, 1000));
  const t0 = Date.now();
  const s2 = await send("BLTOK-it-hook-2");
  const w = await waiter;
  assert.equal(w.code, 2);
  assert.match(w.err, /BLTOK-it-hook-2/);
  assert.ok(Date.now() - t0 < 5000, "woken within seconds");
  assert.equal(state(s2.id), "shown");
  // Codex Stop nudge (count, never content)
  // r2: an FYI never blocks a turn; a question does
  await on(hB, () => core.send(st.loadMember(mB.id)!, { to: "alpha", text: "BLTOK-it-codex-fyi", intent: "fyi" }, SB));
  const quiet = await run(hA, "codex", "stop", { session_id: SA, cwd: hA });
  assert.equal(quiet.out.trim(), "", "an FYI never blocks the turn");
  await on(hB, () => core.send(st.loadMember(mB.id)!, { to: "alpha", text: "BLTOK-it-codex", intent: "question" }, SB));
  const nudge = await run(hA, "codex", "stop", { session_id: SA, cwd: hA });
  assert.deepEqual(JSON.parse(nudge.out), { decision: "block", reason: "You have 1 new bot-link message. Call the bot-link inbox tool." });
});

function fakeHarness(dir: string): string {
  const p = join(dir, "fake-harness.mjs");
  writeFileSync(
    p,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
if (process.env.FAKE_MODE === "fail") process.exit(1);
const r = spawnSync(process.execPath, [process.env.FAKE_CLI, "hook", process.env.FAKE_APP, "session-start"], { input: JSON.stringify({ session_id: (() => { const a = process.argv.slice(2); const eq = a.find((x) => x.startsWith("--resume=")); return eq ? eq.slice(9) : a[a.indexOf(process.env.FAKE_APP === "codex" ? "resume" : "--resume") + 1]; })(), cwd: process.cwd(), source: "resume" }), encoding: "utf-8" });
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ hook_code: r.status, hook_out: r.stdout }) + "\\n");
`,
  );
  chmodSync(p, 0o755);
  return p;
}

function watch(home: string, mode: string, app: string, seconds: number) {
  const log = join(home, "fake.log");
  writeFileSync(log, "");
  const bin = fakeHarness(home);
  const ch = spawn(process.execPath, [CLI, "watch", "--run-s", String(seconds)], {
    cwd: home,
    env: { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: srv.url, BOTLINK_CLAUDE_BIN: bin, BOTLINK_CODEX_BIN: bin, FAKE_LOG: log, FAKE_CLI: CLI, FAKE_MODE: mode, FAKE_APP: app, BOTLINK_WAKE_GAP_MS: "300" },
    stdio: "ignore",
  });
  return { done: new Promise((r) => ch.on("exit", r)), entries: () => readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

test("T11 against the real server: failing resume path -> stuck after 5 wakes, exactly 1 attention item, <= 6 resumes", { skip }, async () => {
  const { hA, hB, SA, mA, mB } = await twoChats();
  const s = await on(hA, () => core.send(st.loadMember(mA.id)!, { to: "bravo", text: "BLTOK-it-t11", intent: "task" }, SA));
  const w = watch(hB, "fail", "claude-code", 14);
  await w.done;
  assert.equal(state(s.id), "stuck");
  assert.equal(sql(`select stuck_reason from deliveries where message_id='${s.id}'`), "wakes");
  assert.equal(sql(`select count(*) from attention where kind='stuck' and subject_id='${mB.id}'`), "1");
  const n = w.entries().filter((e) => e.argv).length;
  assert.ok(n >= 4 && n <= 6, `resumes ${n}`);
});

test("watch resume against the real server: listener on -> the resumed SessionStart shows the message -> wakes on its own (verified)", { skip }, async () => {
  const { hA, hB, SA, SB, mA } = await twoChats();
  const w = watch(hB, "hook", "claude-code", 8);
  await new Promise((r) => setTimeout(r, 2500));
  const ro = await on(hA, () => core.rosterText(st.loadMember(mA.id)!, SA));
  // r3 hotfix (SPEC §6.9): a listener alone is not proof; "answers on its next turn" until a woken run shows a message
  assert.match(ro, /bravo · Claude Code · Adam's chat · answers on its next turn/, "watch's wait alone: not verified");
  const s = await on(hA, () => core.send(st.loadMember(mA.id)!, { to: "bravo", text: "BLTOK-it-resume", intent: "task" }, SA));
  await w.done;
  const e = w.entries();
  const resume = e.find((x) => x.argv);
  assert.equal(resume.argv[2], `--resume=${SB}`);
  const hook = e.find((x) => "hook_code" in x);
  assert.match(JSON.parse(hook.hook_out).hookSpecificOutput.additionalContext, /BLTOK-it-resume/);
  assert.equal(state(s.id), "shown");
  assert.notEqual(sql(`select coalesce(wake_verified_at::text, '') from members where name='bravo' and removed_at is null order by joined_at desc limit 1`), "", "the woken run's ack verified the wake");
});

test("claim (same machine) + new-machine claim with auto re-send from the senders' outboxes (T15 client side)", { skip }, async () => {
  const { room, hA, hB, SA, SB, mA, mB } = await twoChats();
  // same machine: a new session takes bravo
  const S2 = c.uuidv7();
  await on(hB, () => tools({ app: "claude-code", session: () => SB }).handover({ text: "BLTOK-it-note" }));
  // H1: the holder's own chat continues at once (handover note); another chat only after the person approves
  const same = await on(hB, () => tools({ app: "claude-code", session: () => SB }).claim({ name: "bravo" }));
  assert.match(same, /This chat is already bravo/);
  assert.match(same, /BLTOK-it-note/);
  const cl = await on(hB, () => tools({ app: "claude-code", session: () => S2 }).claim({ name: "bravo" }));
  assert.match(cl, /Moving bravo \(#[^)]+\) to this chat needs Adam's OK in the browser/);
  assert.equal(sql(`select holder_session from members where id='${mB.id}'`), SB, "nothing moves before approval");
  const card = (await adam.needsYou()).join_requests.find((x: any) => x.kind === "claim" && x.name === "bravo");
  assert.equal(card.move_to, "chat");
  await adam.approve(card.id);
  const done = await on(hB, () => tools({ app: "claude-code", session: () => S2 }).claim({ wait: true }));
  assert.match(done, /This chat is now bravo .*\(Adam approved the move\)/);
  assert.equal(sql(`select holder_session from members where id='${mB.id}'`), S2);
  // new machine: 3 messages wait, then bravo moves
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await on(hA, () => core.send(st.loadMember(mA.id)!, { to: "bravo", text: `BLTOK-it-move-${i}`, intent: "fyi" }, SA))).id);
  const hN = newHome("it-new");
  const inv = await adam.chatInvite(room.id);
  const r = await on(hN, () => core.joinCreate({ kind: "claim", invite: inv, name: "bravo", job: "", app: "codex", turn: "wake", session: "new-machine-session", cwd: hN, folder: "~", machine: "laptop-2" }));
  await adam.approve(r.req.id);
  const w = await on(hN, () => core.joinWait({ maxMs: 10_000 }));
  assert.equal(w.status, "approved", w.text);
  for (const id of ids) assert.equal(state(id), "needs_resend");
  const senderView = await on(hA, () => tools({ app: "codex", session: () => SA }).inbox({}));
  assert.match(senderView, /3 messages to bravo were re-sent after it moved to a new chat\./);
  const got = await on(hN, () => tools({ app: "codex", session: () => "new-machine-session" }).inbox({}));
  for (let i = 0; i < 3; i++) assert.match(got, new RegExp(`BLTOK-it-move-${i}`));
  assert.equal(sql(`select count(*) from deliveries where member_id='${mB.id}' and state='shown'`), "3", "3 new messages, shown on the new machine");
});

test("listen + leave against the real server", { skip }, async () => {
  const { hA, hB, SA, mA, mB } = await twoChats();
  const ch = spawn(process.execPath, [CLI, "listen", "--member", "bravo", "--once", "--max-s", "20"], { cwd: hB, env: { ...process.env, HOME: hB, BOTLINK_HOME: join(hB, ".botlink"), BOTLINK_SERVER: srv.url } });
  let out = "";
  ch.stdout.on("data", (b) => (out += b));
  await new Promise((r) => setTimeout(r, 1000));
  const s = await on(hA, () => core.send(st.loadMember(mA.id)!, { to: "bravo", text: "BLTOK-it-listen", intent: "question" }, SA));
  assert.equal(await new Promise((r) => ch.on("exit", r)), 0);
  assert.match(out.trim(), /^1 new bot-link message for bravo\. Call the bot-link inbox tool \(or run: .* inbox --as bravo\)\.$/m);
  assert.equal(state(s.id), "queued");
  const left = await on(hA, () => tools({ app: "codex", session: () => SA }).leave({ confirm: true }));
  assert.match(left, /^Left #/);
  assert.notEqual(sql(`select removed_at from members where id='${mA.id}'`), "");
  void mB;
});

test("hotfix shared folder against the real server: Cursor MCP (no session) + Cursor CLI act as the Cursor member, never the Claude Code one; CLI fallback in join text", { skip }, async () => {
  const room = await adam.createRoom(`sf${Date.now() % 1e7}`, "shared folder");
  const home = newHome("it-mac"), hS = newHome("it-sd");
  const bunny = join(home, "mj", "bunny");
  mkdirSync(bunny, { recursive: true });
  const SMAC = c.uuidv7(), SSD = c.uuidv7();
  const joinAt = async (h: string, cwd: string, name: string, app: st.App, session: string | null) => {
    const inv = await adam.chatInvite(room.id);
    return on(h, async () => {
      const r = await core.joinCreate({ invite: inv, name, job: `${name} job`, app, turn: "on_turn", session, cwd, folder: "~/mj/bunny", machine: "it-mac" });
      await adam.approve(r.req.id);
      const w = await core.joinWait({ maxMs: 10_000 });
      assert.equal(w.status, "approved", w.text);
      return w as any;
    });
  };
  // the Cursor chat that joins from its own shell (CURSOR_CONVERSATION_ID) IS acme-cursor (H2)
  const CURCHAT = c.uuidv7();
  process.env.CURSOR_CONVERSATION_ID = CURCHAT;
  let wc: any;
  try {
    wc = await joinAt(home, bunny, "acme-cursor", "cursor", null);
  } finally {
    delete process.env.CURSOR_CONVERSATION_ID;
  }
  assert.match(wc.text, /use the command line as acme-cursor: `.+ inbox --as acme-cursor`/);
  const wm = await joinAt(home, bunny, "acme-mac", "claude-code", SMAC);
  const ws = await joinAt(hS, hS, "study-app", "claude-code", SSD);
  const sdTools = tools({ app: "claude-code", session: () => SSD });
  // 1. Cursor MCP server: no chat id -> it never guesses (H2); the chat names itself with `as`
  const cur = tools({ app: "cursor", session: () => null });
  const guess = await on(home, () => cur.send({ to: "study-app", text: "x", intent: "question" }).catch((e: Error) => e.message));
  assert.match(guess, /can't tell which Cursor chat this is/);
  const s1 = await on(home, () => cur.send({ to: "study-app", text: "BLTOK-sf-mcp", intent: "question", as: "acme-cursor" }));
  assert.match(s1, /^Passed to study-app/);
  const got = await on(hS, () => sdTools.inbox({}));
  assert.match(got, /from: acme-cursor \(Cursor/);
  assert.match(got, /BLTOK-sf-mcp/);
  const id = got.match(/id: ([0-9a-f-]{36})/)![1];
  assert.equal(sql(`select m.name from messages x join members m on m.id = x.from_member where x.id='${id}'`), "acme-cursor");
  // 2. CLI in Cursor's terminal in the shared folder: reply lands with acme-cursor, inbox/reply as it
  await on(hS, () => sdTools.reply({ message_id: id, text: "BLTOK-sf-answer" }));
  const env = { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: srv.url, CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: CURCHAT };
  for (const k of Object.keys(env)) if (/^(CLAUDE|CODEX)/.test(k)) delete (env as any)[k];
  const run = (...args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
      const ch = spawn(process.execPath, [CLI, ...args], { cwd: bunny, env });
      let stdout = "", stderr = "";
      ch.stdout.on("data", (b) => (stdout += b));
      ch.stderr.on("data", (b) => (stderr += b));
      ch.on("exit", (status) => res({ status, stdout, stderr }));
    });
  const status = await run("status");
  assert.match(status.stdout, /Acting as: acme-cursor in #/);
  assert.match(status.stdout, /^\* acme-cursor/m);
  const inb = await run("inbox");
  assert.equal(inb.status, 0, inb.stderr);
  assert.match(inb.stdout, /for acme-cursor[\s\S]*BLTOK-sf-answer/);
  const back = inb.stdout.match(/id: ([0-9a-f-]{36})/)![1];
  const rep = await run("reply", back, "--text", "BLTOK-sf-cli-reply");
  assert.equal(rep.status, 0, rep.stderr + rep.stdout);
  const fin = await on(hS, () => sdTools.inbox({}));
  assert.match(fin, /from: acme-cursor[\s\S]*BLTOK-sf-cli-reply/);
  // acme-mac (Claude Code, same folder) got nothing of this
  assert.equal(sql(`select count(*) from deliveries where member_id='${wm.member.id}'`), "0");
  void ws;
});

test("membership changes (SPEC §6.10a): a join wakes nobody; the next batch carries the fenced note once; a room send after it reaches the new member, shows the diff, and a removed member gets nothing; no history for newcomers", { skip }, async () => {
  const { room, hA, hB, SA, SB, mA, mB } = await twoChats();
  // history before charlie joins
  const early = await on(hA, () => core.send(st.loadMember(mA.id)!, { to: "room", text: "BLTOK-before-join", intent: "fyi" }, SA));
  const hC = newHome("it-c6");
  const SC = c.uuidv7();
  const mC = await joinVia(adam, room, hC, "charlie", "cursor", SC, "on_turn");
  // nobody is woken by a join: bravo's wait sees only the one message, and returns nothing new after draining it
  await on(hB, async () => {
    const b = await core.takeBatch([st.loadMember(mB.id)!], SB);
    assert.match(b.text, /BLTOK-before-join/);
    // charlie joined after bravo's last look, so this batch (the first with messages since) carries the note
    assert.match(b.text, /charlie joined \(Cursor · Adam's chat · job: charlie job · key [0-9a-f]{4}-/);
    assert.match(b.text, /BEGIN BOT-LINK ROOM CHANGES/);
    await b.commit();
    const w = await core.apiFor(srv.url).call<any>({ method: "POST", path: "/api/v1/me/wait", body: { wait_s: 1 }, signer: core.signerOf(st.loadMember(mB.id)!), session: SB, timeoutMs: 15_000 });
    assert.equal(w.json.count, 0, "a join alone never wakes a chat");
  });
  // newcomers never get history
  assert.equal(sql(`select count(*) from deliveries where message_id='${early.id}' and member_id='${mC.id}'`), "0");
  await on(hC, async () => {
    const r = await core.apiFor(srv.url).call<any>({ method: "GET", path: "/api/v1/me/inbox/recent?limit=20", signer: core.signerOf(st.loadMember(mC.id)!), session: SC });
    assert.equal(r.json.deliveries.length, 0, "no earlier messages for a new member");
  });
  // alpha's room-wide send after the join: sealed to charlie too, and alpha is shown who joined since it last spoke
  const s2 = await on(hA, () => core.send(st.loadMember(mA.id)!, { to: "room", text: "BLTOK-after-join", intent: "fyi" }, SA));
  assert.match(s2.text, /members of #\S+ changed since this chat last spoke/);
  assert.match(s2.text, /charlie joined/);
  assert.deepEqual([...s2.recipients].sort(), [mB.id, mC.id].sort());
  // the note is told once: bravo's next batch has no ROOM CHANGES block
  await on(hB, async () => {
    const b = await core.takeBatch([st.loadMember(mB.id)!], SB);
    assert.match(b.text, /BLTOK-after-join/);
    assert.doesNotMatch(b.text, /ROOM CHANGES/);
    await b.commit();
  });
  // bravo leaves; removal takes effect at once: alpha's next room send goes to charlie only and says bravo left
  await on(hB, () => core.leave(st.loadMember(mB.id)!, SB));
  const s3 = await on(hA, () => core.send(st.loadMember(mA.id)!, { to: "room", text: "BLTOK-after-leave", intent: "fyi" }, SA));
  assert.deepEqual(s3.recipients, [mC.id]);
  assert.match(s3.text, /bravo \(Claude Code\) left/);
  assert.equal(sql(`select count(*) from deliveries where message_id='${s3.id}' and member_id='${mB.id}'`), "0", "a removed member gets nothing");
});
