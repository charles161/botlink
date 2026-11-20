/**
 * Kickoff 2 (2026-11-10): "agents are smart enough to pick their own listening".
 *   1. `wait` is the one signal: it blocks, ends when a message waits, never reads it; the chat's own inbox read right
 *      after it is the idle wake the server learns. Exit 3 on --max-s. Messages that were already there woke nobody.
 *   2. The wake test goes out with the first listen (not at join) for a chat with nothing set up; PASSED through `wait`.
 *   3. `send --wait-s`: ask and stay for the answer (the asker needs no listening).
 *   4. A wake nobody acted on is said plainly at the next inbox read.
 *   5. The listening block is the same for every app: no command picked per app.
 *   6. The `wait` tool for apps without a shell.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { tools } from "../src/mcp.js";
import { listeningMenu, listeningShort } from "../src/listening.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake, assertCopy } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let f: FakeServer;
before(async () => {
  process.env.BOTLINK_FAKE_DELAY = "1"; // the fake server holds a wake test back as the real one does
  assertIsolated();
  assert.ok(existsSync(CLI), "build first (npm test builds)");
  f = await startFake();
});
after(async () => f.stop());

const SA = "a1a1a1a1-2222-4222-8333-00000000000a";
const SP = "b2b2b2b2-2222-4222-8333-00000000000b";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start the CLI and resolve once its output matches `re` (the process keeps running; `done` resolves at its exit). */
function start(home: string, env: Record<string, string>, args: string[], re: RegExp) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(CLAUDE|CODEX|CURSOR|OPENCODE|T3CODE|TMUX)/.test(k)) delete base[k];
  const ch = spawn(process.execPath, [CLI, ...args], { cwd: home, env: { ...base, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, ...env } });
  let stdout = "", stderr = "";
  let seen: () => void = () => {};
  const ready = new Promise<void>((r) => (seen = r));
  ch.stdout.on("data", (b) => {
    stdout += b;
    if (re.test(stdout)) seen();
  });
  ch.stderr.on("data", (b) => (stderr += b));
  ch.stdin.end("");
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((res) => ch.on("exit", (code) => {
    seen();
    res({ code, stdout, stderr });
  }));
  return { ready, done };
}

function run(home: string, env: Record<string, string>, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((res) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (/^(CLAUDE|CODEX|CURSOR|OPENCODE|T3CODE|TMUX)/.test(k)) delete base[k];
    const t0 = Date.now();
    const ch = spawn(process.execPath, [CLI, ...args], { cwd: home, env: { ...base, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, ...env } });
    let stdout = "", stderr = "";
    ch.stdout.on("data", (b) => (stdout += b));
    ch.stderr.on("data", (b) => (stderr += b));
    ch.stdin.end("");
    ch.on("exit", (code) => res({ code, stdout, stderr, ms: Date.now() - t0 }));
  });
}

async function joinIn(home: string, room: any, adam: any, name: string, app: st.App, session: string, wakeReady?: boolean, env: Record<string, string | undefined> = {}) {
  return on(home, async () => {
    const r = await core.joinCreate({ invite: f.invite(room, adam), name, job: `${name} job`, app, turn: "on_turn", session, cwd: home, folder: "~/w", machine: "m" });
    f.approve(r.req.id);
    return (await core.joinWait({ maxMs: 3000, wakeReady })) as any;
  }, env);
}

async function pair(tag: string) {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `${tag}${Math.floor(Math.random() * 1e6)}`);
  const hA = newHome(`${tag}a`);
  const hP = newHome(`${tag}p`);
  const a = (await joinIn(hA, room, adam, "alpha", "codex", SA)).member as st.MemberRec;
  const p = (await joinIn(hP, room, adam, "peer", "codex", SP)).member as st.MemberRec;
  return { adam, room, hA, hP, a, p };
}
const A_ENV = { BOTLINK_APP: "codex", CODEX_THREAD_ID: SA };
const wakeFile = (home: string, id: string) => join(home, ".botlink", "wake", `${st.safeName(id)}.json`);

test("wait: blocks until a message waits, ends 0 and never reads it; a read after a wait held in the turn is no idle wake; exit 3 on --max-s", async () => {
  const { hA, hP, a, p } = await pair("wt");
  // (the message is sent once the wait says it is waiting, plus a moment for its first look: no race under load)
  const w = start(hA, A_ENV, ["wait", "--max-s", "40"], /waiting for messages for alpha/);
  await w.ready;
  await sleep(2500);
  await on(hP, () => core.send(st.loadMember(p.id)!, { to: "alpha", text: "BLTOK-wait hello", intent: "question" }, SP));
  const r = await w.done;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /waiting for messages for alpha \(up to 40 s\)\. This command ends when one waits\./);
  assert.match(r.stdout, /1 new message for alpha\. Read it now: \S.* inbox/);
  assert.match(r.stdout, /This wait has ended\. To keep listening, start it again right after you handled it, the same way as before: \S.* wait --max-s 40/);
  assert.doesNotMatch(r.stdout, /BLTOK-wait/, "the wait never shows message text");
  assertCopy(r.stdout);
  const d = f.deliveries.find((x: any) => x.member === a.id && x.scope !== "self" && !x.intro)!;
  assert.equal(d.state, "queued", "the wait read nothing");
  assert.ok(existsSync(wakeFile(hA, a.id)), "the wait left the wake marker for the chat's own read");
  // the chat's own read, right after. The chat was reached while it sat in a wait in its turn (--max-s): that shows
  // nothing about an idle chat, so the room is not told "wakes on its own" (SPEC §6.9, 2026-11-11: no woken ack)
  const i = await run(hA, A_ENV, ["inbox"]);
  assert.match(i.stdout, /BLTOK-wait hello/);
  assert.ok(!f.ackLog.some((x) => x.member === a.id && x.woken), "a read after a wait held in the turn is not an idle wake");
  assert.ok(!f.members.get(a.id)!.wake_verified_at);
  // the wait ended: the next bot-link call says nothing is listening (start it again), until listening is stopped
  assert.match(i.stdout, /nothing is listening for alpha right now: the last `wait` ended/);
  const stop = await run(hA, A_ENV, ["listen", "--stop"]);
  assert.equal(stop.code, 0, stop.stdout + stop.stderr);
  const i2 = await run(hA, A_ENV, ["inbox"]);
  assert.doesNotMatch(i2.stdout, /nothing is listening/);
  // nothing in --max-s: exit 3, plain words
  const t = await run(hA, A_ENV, ["wait", "--max-s", "1"]);
  assert.equal(t.code, 3, t.stdout + t.stderr);
  assert.match(t.stdout, /no new messages for alpha in 1 s\. This wait has ended; nothing is listening now\. To keep listening, start it again the same way/);
  const bad = await run(hA, A_ENV, ["wait", "--max-s", "0"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--max-s is a number of seconds/);
});

test("wait: messages that were already waiting woke nobody (said so, no wake marker, the read is an ordinary turn read)", async () => {
  const { hA, hP, a, p } = await pair("wa");
  await on(hP, () => core.send(st.loadMember(p.id)!, { to: "alpha", text: "BLTOK-early", intent: "question" }, SP));
  const r = await run(hA, A_ENV, ["wait", "--max-s", "10"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 new message for alpha \(already waiting when this wait started\)/);
  assert.ok(!existsSync(wakeFile(hA, a.id)));
  const i = await run(hA, A_ENV, ["inbox"]);
  assert.match(i.stdout, /BLTOK-early/);
  assert.ok(!f.ackLog.some((x) => x.member === a.id && x.woken));
});

test("the wake test goes out with the first listen: join sends none, `wait` announces it, the read after says PASSED through `wait`; no second test", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `fl${Math.floor(Math.random() * 1e6)}`);
  const hA = newHome("fla");
  const on2 = { BOTLINK_NO_SELFTEST: undefined, BOTLINK_TEST_DELAY_S: "3" } as Record<string, string | undefined>;
  const w = await joinIn(hA, room, adam, "alpha", "codex", SA, false, on2);
  const a = w.member as st.MemberRec;
  assert.match(w.text, /Wake test: not sent yet\. bot-link sends it the first time this chat starts listening/);
  assert.match(w.text, /LISTENING: set it up now, in this turn\. You choose how; don't ask your human to pick for you\./);
  assert.match(w.text, /Never tell your human that messages reach this chat while it's idle until the text of a wake test says an idle chat is reached/);
  assert.match(w.text, /The signal is one command: `\S.* wait`/);
  assert.match(w.text, /Ways 1 and 2 only wait, and stop at the first message: they need no yes from your human/);
  assert.match(w.text, /Ways 3, 4 and 5 run a command when you are not there, edit app config or open a port: show your human the exact command and wait for a yes/);
  assert.match(w.text, /What bot-link can tell from here \(facts, not advice\): app: Codex; this chat's id: /);
  assert.doesNotMatch(w.text, /codex-queue|listen --once --print/, "no command picked for the app");
  assertCopy(w.text);
  // (the join's own "you're in" round trip is a message to itself too: read back at once, never left waiting)
  const self = () => f.deliveries.filter((d: any) => d.member === a.id && d.scope === "self").length - 1;
  assert.equal(f.deliveries.filter((d: any) => d.member === a.id && d.scope === "self" && d.state === "queued").length, 0, "no wake test at join");
  assert.equal(self(), 0);
  const env = { ...A_ENV, BOTLINK_NO_SELFTEST: "", BOTLINK_TEST_DELAY_S: "3", BOTLINK_CONFIRM_DELAY_S: "3" };
  const r = await run(hA, env, ["wait"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /a wake test for alpha arrives in about 3 s \(no wake test has PASSED for this chat yet\)/);
  assert.match(r.stdout, /If your turn ends while it is still running, this chat is listening only if this app gives it a new turn when the command ends/);
  assert.ok(r.ms >= 2500, `the test was held back (${r.ms} ms)`);
  assert.equal(self(), 1);
  const i = await run(hA, env, ["inbox"]);
  assert.match(i.stdout, /From: bot-link \(system test for this chat only/);
  assert.match(i.stdout, /wake test for alpha: PASSED \(through `wait`\), the first of two\. The signal reached this chat without anyone typing, and this chat read it right away\./);
  assert.match(i.stdout, /If you were still in your turn \(sitting in the wait, or checking on it\), only that is shown/);
  assertCopy(i.stdout);
  const rec = () => st.readJson<any>(join(hA, ".botlink", "members", `${a.id}.json`), null).selftest;
  assert.equal(rec().woken, true);
  assert.equal(rec().round, 1);
  assert.equal(rec().how, "`wait`");
  const res = await run(hA, env, ["selftest", "--result"]);
  assert.match(res.stdout, /Last wake test for alpha: PASSED at \d\d:\d\d UTC through `wait`, the first of two\. The signal works; it is not yet shown that an idle chat is reached/);
  const stat = await run(hA, env, ["status"]);
  assert.match(stat.stdout, /wake test PASSED, the first of two \(an idle chat is not shown yet\)/);
  assert.doesNotMatch(stat.stdout, /an idle chat is reached ✓/);
  // the second test goes out with the next listen: it checks the way the chat was left
  const r2 = await run(hA, env, ["wait"]);
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /the second wake test for alpha arrives in about 3 s\. It checks that this chat is still reached the way you leave it now/);
  assert.equal(self(), 2);
  const i2 = await run(hA, env, ["inbox"]);
  assert.match(i2.stdout, /wake test for alpha: PASSED \(through `wait`\), the second of two, if the turn in which you read this started by itself\. Then this chat is reached the way it listens now: an idle chat is reached\. If your human typed to start this turn, or you were still in your turn/);
  assert.equal(rec().round, 2);
  const res2 = await run(hA, env, ["selftest", "--result"]);
  assert.match(res2.stdout, /Last wake test for alpha: PASSED at \d\d:\d\d UTC through `wait`, the second of two: an idle chat is reached, if that test was read in a turn that started by itself/);
  // both passed: no other test, in either mode, and the open wait no longer carries the caution
  const r3 = await run(hA, env, ["wait", "--max-s", "1"]);
  assert.equal(r3.code, 3);
  assert.doesNotMatch(r3.stdout, /wake test for alpha arrives/);
  assert.equal(self(), 2);
  const stat2 = await run(hA, env, ["status"]);
  assert.match(stat2.stdout, /wake test PASSED: an idle chat is reached ✓/);
  // a test that is still on its way is never sent twice
  const s1 = await run(hA, env, ["selftest"]);
  assert.match(s1.stdout, /New wake test sent from bot-link to alpha only/);
  const s2 = await run(hA, env, ["selftest"]);
  assert.match(s2.stdout, /That test is still on its way: no second one was sent/);
});

test("the second test catches a chat that passed in its turn and then left a wait nobody answers (the Codex trap): FAILED, the second of two", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `tr${Math.floor(Math.random() * 1e6)}`);
  const hA = newHome("tra");
  const a = (await joinIn(hA, room, adam, "alpha", "codex", SA, false, { BOTLINK_NO_SELFTEST: undefined })).member as st.MemberRec;
  const env = { ...A_ENV, BOTLINK_NO_SELFTEST: "", BOTLINK_TEST_DELAY_S: "2", BOTLINK_CONFIRM_DELAY_S: "2" };
  // in its turn (--max-s): the wait returns, the chat reads at once. That passes for a held wait only.
  const w1 = await run(hA, env, ["wait", "--max-s", "20"]);
  assert.equal(w1.code, 0, w1.stdout + w1.stderr);
  assert.match(w1.stdout, /Held in your turn: this chat is reachable only while a wait like this runs\./);
  const i1 = await run(hA, env, ["inbox"]);
  assert.match(i1.stdout, /wake test for alpha: PASSED for a wait held in your turn \(`wait --max-s`\)\. This chat is reached while it sits in such a wait, and only then/);
  assert.doesNotMatch(i1.stdout, /the first of two/);
  assertCopy(i1.stdout);
  assert.match((await run(hA, env, ["selftest", "--result"])).stdout, /PASSED at \d\d:\d\d UTC for a wait held in its turn .* an idle chat is not reached/);
  assert.match((await run(hA, env, ["status"])).stdout, /wake test PASSED for a wait held in its turn \(an idle chat is not reached\)/);
  // sitting in the wait again needs no other test
  const again = await run(hA, env, ["wait", "--max-s", "1"]);
  assert.equal(again.code, 3);
  assert.doesNotMatch(again.stdout, /wake test for alpha arrives/);
  // it then starts a wait without a limit and its turn ends: a different way, tested by itself. It fires, and
  // nothing reads it for minutes
  const w2 = await run(hA, env, ["wait"]);
  assert.equal(w2.code, 0, w2.stdout + w2.stderr);
  assert.match(w2.stdout, /the last wake test for alpha passed for a wait held in its turn \(--max-s\)\. What you started now keeps running after your turn, so it is a different way of listening: a wake test arrives in about 2 s/);
  assert.match(w2.stdout, /Until a wake test PASSED that way, don't tell your human this chat is reachable while idle\./);
  await on(hA, () => {
    st.markWake(a.id, "wait", Date.now() - 9 * 60_000);
    const m = st.loadMember(a.id)!;
    m.selftest = { ...m.selftest!, sent_at: Date.now() - 9 * 60_000, due_at: Date.now() - 9 * 60_000 };
    st.writeJson(st.memberPath(a.id), m);
  });
  // the human comes back and says "check botlink"
  const late = await run(hA, env, ["inbox"]);
  assert.match(late.stdout, /wake test for alpha: FAILED, the second of two \(a wait signalled \d+ s ago; a read counts as that wake for 90 s\. If this chat did get a turn by itself and was only slow, run the test again\)\. An earlier test passed, but this one reached this chat only on a turn/);
  assert.match(late.stdout, /ask Adam once: "May I keep one small bot-link listener running, so room messages reach me while you're away\? It runs: <the exact command>/);
  assert.match(late.stdout, /messages do NOT reach alpha while this chat is idle yet/);
  assert.match(late.stdout, /alpha was told that messages wait \(through `wait`\), and this chat reads them only now, 9 minutes later/);
  assertCopy(late.stdout);
  const res = await run(hA, env, ["selftest", "--result"]);
  assert.match(res.stdout, /Last wake test for alpha: FAILED/);
  assert.ok(!f.members.get(a.id)!.wake_verified_at || f.ackLog.filter((x) => x.member === a.id && x.woken).length === 1, "only the first read counted as a wake");
});

test("a chat that reads its inbox itself before anything woke it: no result within a minute of the test (any app), FAILED later", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `nr${Math.floor(Math.random() * 1e6)}`);
  const hA = newHome("nra");
  const a = (await joinIn(hA, room, adam, "alpha", "codex", SA, false)).member as st.MemberRec;
  await on(hA, () => core.sendSelftest(st.loadMember(a.id)!, SA));
  const t0 = await on(hA, () => tools({ app: "codex", session: () => SA }).inbox({}));
  assert.match(t0, /wake test for alpha: no result\. This chat picked it up itself during a turn/);
  assert.equal(st.readJson<any>(join(hA, ".botlink", "members", `${a.id}.json`), null).selftest.woken, null);
  // the same read long after the test arrived: nothing woke the chat
  await on(hA, () => core.sendSelftest(st.loadMember(a.id)!, SA));
  await on(hA, () => {
    const m = st.loadMember(a.id)!;
    m.selftest = { ...m.selftest!, sent_at: Date.now() - 5 * 60_000, due_at: Date.now() - 5 * 60_000 };
    st.writeJson(st.memberPath(a.id), m);
  });
  const t1 = await on(hA, () => tools({ app: "codex", session: () => SA }).inbox({}));
  assert.match(t1, /wake test for alpha: FAILED\. This test reached this chat only on a turn/);
  assert.match(t1, /The signal is `\S.* wait`/);
  assertCopy(t1);
});

test("send --wait-s: ask and stay for the answer (exit 0 with the answer in the same call; exit 3 when none came)", async () => {
  const { hA, hP, a, p } = await pair("sw");
  const asking = run(hA, A_ENV, ["send", "--to", "peer", "--intent", "question", "--text", "BLTOK-ask what is the build status?", "--wait-s", "20"]);
  // peer: reads the question, then answers it
  let asked: any = null;
  for (let i = 0; i < 50 && !asked; i++) {
    await sleep(200);
    asked = f.deliveries.find((d: any) => d.member === p.id && d.scope === "member" && d.state === "queued");
  }
  assert.ok(asked, "the question reached peer");
  await on(hP, async () => {
    const b = await core.takeBatch([st.loadMember(p.id)!], SP, { waitS: 0 });
    await b.commit();
    await core.reply(SP, asked.message_id, "BLTOK-answer green on main");
  });
  const r = await asking;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Waiting here up to 20 s for the answer/);
  assert.match(r.stdout, /BLTOK-answer green on main/);
  assert.match(r.stdout, /answers your message: "BLTOK-ask what is the build status\?"/);
  assert.match(r.stdout, /bot-link: the answer is above\./);
  assert.ok(r.ms < 15_000);
  assert.equal(f.deliveries.find((d: any) => d.member === a.id && d.in_reply_to === asked.message_id)!.state, "shown");
  // nobody answers: exit 3, and where the answer will show up
  const none = await run(hA, A_ENV, ["send", "--to", "peer", "--intent", "question", "--text", "BLTOK-ask2", "--wait-s", "1"]);
  assert.equal(none.code, 3, none.stdout + none.stderr);
  assert.match(none.stdout, /no answer within 1 s\. It will show up on this chat's next turn or when this chat listens/);
  // the tool does the same (here: nobody answers in time)
  const tr = await on(hA, () => tools({ app: "codex", session: () => SA }).send({ to: "peer", text: "BLTOK-ask3", intent: "question", wait_s: 1 }));
  assert.match(tr, /no answer within 1 s\. It will show up on this chat's next turn, or when this chat listens; the inbox tool checks now\./);
});

test("a wake nobody acted on: the next inbox read says the way this chat listens did not give it a turn", async () => {
  const { hA, hP, a, p } = await pair("uw");
  await on(hP, () => core.send(st.loadMember(p.id)!, { to: "alpha", text: "BLTOK-late", intent: "question" }, SP));
  await on(hA, () => st.markWake(a.id, "wait", Date.now() - 12 * 60_000));
  const i = await run(hA, A_ENV, ["inbox"]);
  assert.match(i.stdout, /BLTOK-late/);
  assert.match(i.stdout, /alpha was told that messages wait \(through `wait`\), and this chat reads them only now, 12 minutes later\. If this chat sat idle all that time, the way it listens did not give it a turn/);
  assertCopy(i.stdout.split("<<<BEGIN")[0] + i.stdout.split("<<<END")[1]);
  assert.ok(!existsSync(wakeFile(hA, a.id)));
  assert.ok(!f.ackLog.some((x) => x.member === a.id && x.woken), "a read that late is no idle wake");
  // a fresh wake answered at once says nothing of the kind
  await on(hP, () => core.send(st.loadMember(p.id)!, { to: "alpha", text: "BLTOK-fresh", intent: "question" }, SP));
  await on(hA, () => st.markWake(a.id, "wait"));
  const j = await run(hA, A_ENV, ["inbox"]);
  assert.doesNotMatch(j.stdout, /was told that messages wait/);
});

test("the listening block is the same for every app: one signal, five ways, the rules, the proof; nothing picked per app", () => {
  const body = (app: st.App) => listeningMenu({ name: "x", app }).split("\n").filter((l) => !l.startsWith("What bot-link can tell")).join("\n");
  const cc = body("claude-code");
  for (const app of ["codex", "cursor", "opencode", "other"] as st.App[]) assert.equal(body(app), cc, app);
  for (const s of ["The goal:", "The signal is one command:", "1. Background:", "2. In your turn:", "3. Listener:", "4. Something this app has:", "5. A URL bot-link's server can already reach:", "Pick the first that passes the wake test here", "Rules. Ways 1 and 2 only wait", "The proof, in two tests.", "bot-link reads --max-s as way 2 and no --max-s as way 1", "A wake command never loosens this app's permissions", "Report to your human in plain words"]) assert.ok(cc.includes(s), s);
  assert.doesNotMatch(cc, /codex-queue|claude -p|cursor-agent|Stop hook/);
  assertCopy(cc);
  assertCopy(listeningShort());
  // an app bot-link has no name for is shown the name it gave itself
  assert.match(listeningMenu({ name: "x", app: "other", app_name: "Hermes Agent" }), /app: Hermes Agent/);
});

test("the wait tool (apps without a shell): returns after max_s with plain words; says when a message waits", async () => {
  const { hA, hP, a, p } = await pair("mt");
  const t = tools({ app: "codex", session: () => SA });
  const none = await on(hA, () => t.wait({ max_s: 1 }));
  assert.match(none, /No new messages in 1 s\. This wait has ended; nothing is listening now\. To keep listening, call wait again\./);
  // (the sender is its own process: `on` switches this process's HOME, which a tool call in flight must not share)
  setTimeout(() => void run(hP, { BOTLINK_APP: "codex", CODEX_THREAD_ID: SP }, ["send", "--to", "alpha", "--intent", "question", "--text", "BLTOK-tool"]), 2500);
  const got = await on(hA, () => t.wait({ max_s: 20 }));
  assert.match(got, /1 new message for alpha\. Call the inbox tool now to read it\. This wait has ended: to keep listening, call wait again/);
  assert.doesNotMatch(got, /BLTOK-tool/);
  assert.equal(f.deliveries.find((x: any) => x.member === a.id && x.scope === "member")!.state, "queued");
  void p;
});

test("review 2026-11-10: a pass is labelled by what woke the chat; a human-turn read after a wait is no wake; --as is checked; --show starts nothing; --stop kills only a wait; a tool caller that gave up gets nothing acked", async () => {
  const { hA, hP, a, p } = await pair("rv");
  // (6 s: the wait must be running before the test arrives; one that finds it already there proves nothing)
  const env = { ...A_ENV, BOTLINK_NO_SELFTEST: "", BOTLINK_TEST_DELAY_S: "6", BOTLINK_CONFIRM_DELAY_S: "6" };
  const rec = () => st.readJson<any>(join(hA, ".botlink", "members", `${a.id}.json`), null).selftest;
  // (1) a test asked for with `selftest` and then met in a wait held in the turn: held, never "an idle chat is reached"
  assert.match((await run(hA, env, ["selftest"])).stdout, /New wake test sent from bot-link to alpha only/);
  assert.equal((await run(hA, env, ["wait", "--max-s", "20"])).code, 0);
  const i1 = await run(hA, env, ["inbox"]);
  assert.match(i1.stdout, /wake test for alpha: PASSED for a wait held in your turn/);
  assert.equal(rec().mode, "held");
  assert.doesNotMatch((await run(hA, env, ["status"])).stdout, /an idle chat is reached ✓/);
  // ... and asked for again while a pass for a held wait stands, met in a wait without a limit: a FIRST round, not a second
  await run(hA, env, ["selftest"]);
  assert.equal((await run(hA, { ...env, BOTLINK_NO_SELFTEST: "1" }, ["wait"])).code, 0);
  assert.match((await run(hA, env, ["inbox"])).stdout, /PASSED \(through `wait`\), the first of two/);
  assert.equal(rec().round, 1);
  // (2) the app's hook reads at the start of a human turn: a wait that ended before is no idle wake; a listener's nudge is
  const before = f.ackLog.filter((x) => x.member === a.id && x.woken).length;
  await on(hP, () => core.send(st.loadMember(p.id)!, { to: "alpha", text: "BLTOK-h1", intent: "question" }, SP));
  await on(hA, async () => {
    st.markWake(a.id, "wait");
    const b = await core.takeBatch([st.loadMember(a.id)!], SA, { waitS: 0, humanTurn: true });
    assert.match(b.text, /BLTOK-h1/);
    await b.commit();
  });
  assert.equal(f.ackLog.filter((x) => x.member === a.id && x.woken).length, before, "a human turn after a wait is not a wake");
  await on(hP, () => core.send(st.loadMember(p.id)!, { to: "alpha", text: "BLTOK-h2", intent: "question" }, SP));
  await on(hA, async () => {
    st.markWake(a.id, "listen");
    const b = await core.takeBatch([st.loadMember(a.id)!], SA, { waitS: 0, humanTurn: true });
    await b.commit();
  });
  assert.equal(f.ackLog.filter((x) => x.member === a.id && x.woken).length, before + 1, "a listener's nudge is");
  // (3) a wait's wake counts for 90 seconds, not 3 minutes
  await on(hP, () => core.send(st.loadMember(p.id)!, { to: "alpha", text: "BLTOK-h3", intent: "question" }, SP));
  await on(hA, () => st.markWake(a.id, "wait", Date.now() - 2 * 60_000));
  assert.match((await run(hA, { ...A_ENV }, ["inbox"])).stdout, /BLTOK-h3/);
  assert.equal(f.ackLog.filter((x) => x.member === a.id && x.woken).length, before + 1);
  // (4) another chat can't wait for alpha by name
  const other = await run(hA, { BOTLINK_APP: "codex", CODEX_THREAD_ID: "d4d4d4d4-2222-4222-8333-00000000000d" }, ["wait", "--as", "alpha", "--max-s", "2"]);
  assert.equal(other.code, 1, other.stdout + other.stderr);
  assert.doesNotMatch(other.stdout, /waiting for messages for alpha/);
  // (5) --show prints the exact command and starts nothing
  const show = await run(hA, A_ENV, ["listen", "--on-message", "echo hello-from-listener", "--detach", "--show"]);
  assert.equal(show.code, 0, show.stdout + show.stderr);
  assert.match(show.stdout, /echo hello-from-listener/);
  assert.match(show.stdout, /Not started \(--show\)\. With your human's yes, run the same command without --show\./);
  assert.ok(!existsSync(join(hA, ".botlink", "listen", `${st.safeName(a.id)}.json`)), "no listener was started");
  const none = await run(hA, A_ENV, ["listen", "--detach", "--show"]);
  assert.match(none.stdout, /bot-link has no ready-made command|bot-link listener for alpha/);
  // (6) --stop ends a wait this chat started, and never a process that is not a bot-link wait
  const L = await import("../src/listen.js");
  const { startTag } = await import("../src/session.js");
  const held = start(hA, A_ENV, ["wait"], /waiting for messages for alpha/);
  await held.ready;
  await sleep(1500); // its record is written with the first poll
  const stop1 = await run(hA, A_ENV, ["listen", "--stop"]);
  assert.match(stop1.stdout, /Stopped the `wait` that was listening for alpha\./);
  const ended = await Promise.race([held.done, sleep(8000).then(() => null)]);
  assert.ok(ended, "the wait process ended");
  const other2 = spawn("sleep", ["30"], { stdio: "ignore" });
  await sleep(300);
  await on(hA, () => L.recordWakePath(a.id, { kind: "once", pid: other2.pid!, tag: startTag(other2.pid!), at: Date.now() }));
  const stop2 = await run(hA, A_ENV, ["listen", "--stop"]);
  assert.match(stop2.stdout, /No listener is running for alpha\./);
  assert.equal(other2.exitCode, null, "a process that is not a bot-link wait is left alone");
  assert.ok(st.pidAlive(other2.pid!));
  other2.kill("SIGTERM");
  // (7) the send tool's stay-for-the-answer: a caller that gave up gets nothing acked (the copies go back)
  await on(hP, () => core.send(st.loadMember(p.id)!, { to: "alpha", text: "BLTOK-unrelated", intent: "fyi" }, SP));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1500);
  const r = await on(hA, () => core.awaitAnswer(st.loadMember(a.id)!, "01a1c6ff-0000-7000-8000-000000000000", 20_000, SA, { signal: ac.signal }));
  assert.equal(r.answered, false);
  const d = f.deliveries.filter((x: any) => x.member === a.id && x.scope === "member").pop()!;
  assert.match(r.text, /BLTOK-unrelated/, "it was read while staying");
  assert.equal(d.state, "queued", "read while staying, but the caller was gone: not acked");
});

test("a wait ends when the program that started it is gone (it must not keep a chat nobody is in looking as if it listens)", async () => {
  const { hA } = await pair("or");
  const { copyFileSync, chmodSync, readFileSync } = await import("node:fs");
  // a stand-in for the app: a program with its own name (a copy of sh) that starts the wait in the background and ends
  const app = join(hA, "fakeapp");
  copyFileSync("/bin/sh", app);
  chmodSync(app, 0o755);
  const errFile = join(hA, "wait.err");
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(CLAUDE|CODEX|CURSOR|OPENCODE|T3CODE|TMUX)/.test(k)) delete base[k];
  const ch = spawn(app, ["-c", `"${process.execPath}" "${CLI}" wait > "${join(hA, "wait.out")}" 2> "${errFile}" & sleep 3`], { cwd: hA, env: { ...base, HOME: hA, BOTLINK_HOME: join(hA, ".botlink"), BOTLINK_SERVER: f.url, ...A_ENV, BOTLINK_ORPHAN_CHECK_MS: "400" }, stdio: "ignore" });
  await new Promise((r) => ch.on("exit", r));
  // while the program lived the wait was waiting; now it must end by itself, and say why
  let said = "";
  for (let i = 0; i < 40 && !/has ended/.test(said); i++) {
    await sleep(250);
    said = existsSync(errFile) ? readFileSync(errFile, "utf-8") : "";
  }
  assert.match(said, /the program this wait was started from \(fakeapp, pid \d+\) has ended, so nothing would give its chat a turn: this wait ends\./);
  assert.match(readFileSync(join(hA, "wait.out"), "utf-8"), /waiting for messages for alpha/);
});

test("an app that runs as plain node is told from a package runner by its command line", async () => {
  const { nodeProgram } = await import("../src/listening.js");
  // Cursor's agent: its launcher runs its own node under the launcher's name (`exec -a "$0" node index.js`)
  assert.equal(nodeProgram("/home/u/.local/bin/cursor-agent --use-system-ca /home/u/.local/share/cursor-agent/versions/1/index.js"), "cursor-agent");
  assert.equal(nodeProgram("node /usr/lib/node_modules/@google/gemini-cli/dist/index.js"), "index");
  assert.equal(nodeProgram("/usr/bin/node /opt/myagent/index.js --flag"), "myagent");
  assert.equal(nodeProgram("node --import tsx /srv/agent/main.ts"), "agent");
  // package runners and test runners only start something else
  assert.equal(nodeProgram("npm exec botlink wait"), null);
  assert.equal(nodeProgram("node /usr/lib/node_modules/npm/bin/npx-cli.js -y botlink wait"), null);
  assert.equal(nodeProgram("node /usr/local/bin/npx -y botlink"), null);
  assert.equal(nodeProgram("node --import tsx --test test/a.test.ts"), null);
  assert.equal(nodeProgram("node"), null);
  assert.equal(nodeProgram(""), null);
});

test("a wait started inside an app that runs as plain node ends when that app is gone (the Cursor case in the demo recording)", async () => {
  const { hA } = await pair("on");
  const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  // a stand-in for such an app: a node script that starts the wait in the background through a shell, and ends
  // (the shell outlives the app, as a tool's shell does when its app is killed)
  const dir = join(hA, "coolagent");
  mkdirSync(dir);
  const errFile = join(hA, "wait.err");
  writeFileSync(join(dir, "index.mjs"), `import { spawn } from "node:child_process";
spawn("/bin/sh", ["-c", ${JSON.stringify(`"${process.execPath}" "${CLI}" wait > "${join(hA, "wait.out")}" 2> "${errFile}" & sleep 8`)}], { stdio: "ignore", detached: true }).unref();
setTimeout(() => process.exit(0), 3000);
`);
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (/^(CLAUDE|CODEX|CURSOR|OPENCODE|T3CODE|TMUX)/.test(k)) delete base[k];
  const ch = spawn(process.execPath, [join(dir, "index.mjs")], { cwd: hA, env: { ...base, HOME: hA, BOTLINK_HOME: join(hA, ".botlink"), BOTLINK_SERVER: f.url, ...A_ENV, BOTLINK_ORPHAN_CHECK_MS: "400" }, stdio: "ignore" });
  await new Promise((r) => ch.on("exit", r));
  let said = "";
  for (let i = 0; i < 40 && !/has ended/.test(said); i++) {
    await sleep(250);
    said = existsSync(errFile) ? readFileSync(errFile, "utf-8") : "";
  }
  assert.match(said, /the program this wait was started from \(coolagent, pid \d+\) has ended, so nothing would give its chat a turn: this wait ends\./);
  assert.match(readFileSync(join(hA, "wait.out"), "utf-8"), /waiting for messages for alpha/);
});
