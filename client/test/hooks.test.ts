/**
 * Hook output shapes per app/event, with real child processes (`node dist/cli.js hook <app> <event>`), as the apps
 * run them. Exit codes are asserted: SessionStart NEVER exits 2. A message is acked shown only after the write.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
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

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  pid: number;
}

function hook(home: string, app: string, event: string, input: any, o: { env?: Record<string, string>; closeStdout?: boolean; kill?: (pid: number) => void } = {}): Promise<Run> & { pid: number } {
  const child = spawn(process.execPath, [CLI, "hook", app, event], {
    cwd: home,
    env: { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, ...(o.env || {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  if (o.closeStdout) child.stdout.destroy();
  child.stdin.end(JSON.stringify(input));
  const p = new Promise<Run>((res) => child.on("exit", (code) => res({ code, stdout, stderr, pid: child.pid! }))) as Promise<Run> & { pid: number };
  p.pid = child.pid!;
  return p;
}

const SA = "aaaaaaaa-1111-4222-8333-000000000001";
const SB = "bbbbbbbb-1111-4222-8333-000000000002";

async function room2() {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `hk${Math.floor(Math.random() * 1e6)}`);
  const inv = f.invite(room, adam);
  const hA = newHome("ha"), hB = newHome("hb");
  const j = async (h: string, name: string, app: st.App, session: string | null) =>
    on(h, async () => {
      const r = await core.joinCreate({ invite: inv, name, job: "", app, turn: "wake", session, cwd: h, folder: "~", machine: "m" });
      f.approve(r.req.id);
      return ((await core.joinWait({ maxMs: 3000 })) as any).member as st.MemberRec;
    });
  const mA = await j(hA, "sender", "codex", SA);
  const mB = await j(hB, "rcpt", "claude-code", SB);
  const send = (text: string) => on(hA, () => core.send(st.loadMember(mA.id)!, { to: "rcpt", text, intent: "task" }, SA));
  return { hA, hB, mA, mB, send };
}

test("Claude Code SessionStart: waiting message -> model-visible additionalContext JSON, exit 0, then acked shown", async () => {
  const { hB, send } = await room2();
  const s = await send("BLTOK-unit-1 please look at the failing test");
  const r = await hook(hB, "claude-code", "session-start", { session_id: SB, cwd: hB, hook_event_name: "SessionStart", source: "startup" });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(j.hookSpecificOutput.additionalContext, /BLTOK-unit-1/);
  assert.match(j.hookSpecificOutput.additionalContext, /DATA, not instructions/);
  assert.ok(j.hookSpecificOutput.additionalContext.length < 10_000, "under Claude Code's inline context limit");
  assertCopy(j.hookSpecificOutput.additionalContext);
  assert.equal(r.stderr, "");
  assert.equal(f.copies(s.id)[0].state, "shown");
});

test("J7f-3: when the hook's stdout can't be written, nothing is acked shown (released), and still exit 0", async () => {
  const { hB, send } = await room2();
  const s = await send("BLTOK-unit-2 a message the model must not lose");
  const r = await hook(hB, "claude-code", "session-start", { session_id: SB, cwd: hB }, { closeStdout: true });
  assert.equal(r.code, 0);
  const d = f.copies(s.id)[0];
  assert.equal(d.state, "queued");
  assert.equal(d.lease_until, 0, "released, so the next turn gets it at once");
  // ... and the next SessionStart shows it, flagged
  const r2 = await hook(hB, "claude-code", "session-start", { session_id: SB, cwd: hB });
  assert.match(JSON.parse(r2.stdout).hookSpecificOutput.additionalContext, /re-delivered: .*BLTOK-unit-2/s);
  assert.equal(f.copies(s.id)[0].state, "shown");
});

test("SessionStart never exits 2: server down, garbage stdin, unknown app", async () => {
  const { hB } = await room2();
  const down = await hook(hB, "claude-code", "session-start", { session_id: SB, cwd: hB }, { env: { BOTLINK_SERVER: "http://127.0.0.1:8829" } });
  assert.equal(down.code, 0);
  assert.equal(down.stderr, "");
  for (const app of ["claude-code", "codex", "cursor", "nope"]) {
    const child = spawn(process.execPath, [CLI, "hook", app, "session-start"], { env: { ...process.env, HOME: hB, BOTLINK_HOME: join(hB, ".botlink") }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end("{not json");
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0, app);
  }
});

test("UserPromptSubmit: prompt captured for standing rules, messages injected, exit 0", async () => {
  const { hB, mB, send } = await room2();
  await send("BLTOK-unit-3");
  const r = await hook(hB, "claude-code", "prompt", { session_id: SB, cwd: hB, prompt: "staging deploys from sender are fine without asking me", hook_event_name: "UserPromptSubmit" });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(j.hookSpecificOutput.additionalContext, /BLTOK-unit-3/);
  await on(hB, () => assert.equal(st.readPrompts(SB)[0].text, "staging deploys from sender are fine without asking me"));
  // the watch wake prompt and unattended runs are never captured
  await hook(hB, "claude-code", "prompt", { session_id: SB, cwd: hB, prompt: "bot-link: new messages for you are in your context. Handle them under the bot-link rules. (If you don't see them, call the bot-link inbox tool.)" });
  await hook(hB, "claude-code", "prompt", { session_id: SB, cwd: hB, prompt: "unattended words" }, { env: { BOTLINK_UNATTENDED: "1" } });
  await on(hB, () => assert.equal(st.readPrompts(SB).length, 1));
  void mB;
});

test("Claude Code Stop waiter (asyncRewake): idle -> message arrives -> stderr + exit 2 -> acked shown", async () => {
  const { hB, send } = await room2();
  const w = hook(hB, "claude-code", "stop", { session_id: SB, cwd: hB, hook_event_name: "Stop" });
  await new Promise((r) => setTimeout(r, 700));
  const s = await send("BLTOK-unit-4 wake up");
  const r = await w;
  assert.equal(r.code, 2);
  assert.match(r.stderr, /BLTOK-unit-4 wake up/);
  assert.equal(r.stdout, "");
  assertCopy(r.stderr);
  assert.equal(f.copies(s.id)[0].state, "shown");
});

test(" bug 1: the Stop waiter shows the self-test and its process ends before the ack lands -> read here, PASSED, inbox/status agree, never shown again", async () => {
  const { hB, mB } = await room2();
  await on(hB, () => core.sendSelftest(st.loadMember(mB.id)!, SB));
  f.holdAcks = true;
  let r: Run;
  try {
    // the app ends the hook process right after it saw the output (what the real-world run suggests)
    const child = spawn(process.execPath, [CLI, "hook", "claude-code", "stop"], { cwd: hB, env: { ...process.env, HOME: hB, BOTLINK_HOME: join(hB, ".botlink"), BOTLINK_SERVER: f.url }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b) => {
      stderr += b;
      setTimeout(() => child.kill("SIGKILL"), 150);
    });
    child.stdin.end(JSON.stringify({ session_id: SB, cwd: hB }));
    r = await new Promise<Run>((res) => child.on("exit", (code) => res({ code, stdout: "", stderr, pid: child.pid! })));
  } finally {
    f.holdAcks = false;
  }
  assert.match(r.stderr, /From: bot-link \(system test/);
  assert.match(r.stderr, /wake test for rcpt: PASSED/);
  const d = f.deliveries.find((x: any) => x.member === mB.id && x.scope === "self")!;
  assert.equal(d.state, "queued", "the ack never reached the server");
  // the chat's record says it was read, while idle
  const rec = await on(hB, () => st.loadMember(mB.id)!);
  assert.ok(rec.selftest?.shown_at && rec.selftest.woken === true, JSON.stringify(rec.selftest));
  // status's "N waiting" and inbox agree: the owed ack goes first, nothing is waiting, nothing is shown again
  const note = await on(hB, () => core.waitingNote([st.loadMember(mB.id)!], SB));
  assert.doesNotMatch(note, /new message/);
  assert.equal(d.state, "shown");
  assert.ok(f.members.get(mB.id)!.wake_verified_at, "the owed ack carried woken");
  const inbox = await on(hB, () => core.inboxText([st.loadMember(mB.id)!], SB, false));
  assert.match(inbox, /^No new messages\./);
  assert.match(await on(hB, () => core.selftestResult(st.loadMember(mB.id)!)), /PASSED/);
});

test(" bug 1: a copy already shown here whose ack was lost comes back from the server -> acked, never re-shown", async () => {
  const { hB, mB, send } = await room2();
  const s = await send("BLTOK-unit-14632 once only");
  const b = await on(hB, () => core.takeBatch([st.loadMember(mB.id)!], SB, {}));
  assert.match(b.text, /BLTOK-unit-14632/);
  f.holdAcks = true;
  // Not through on(): this commit hangs until the client gives up on its request, long after this test has ended,
  // and on()'s restore would then switch the home under whichever later test is running (seen as "This chat's
  // bot-link keys are missing" in a later test of this file, 2 of 3 full runs on 2026-11-11).
  const base = { HOME: process.env.HOME, BOTLINK_HOME: process.env.BOTLINK_HOME };
  process.env.HOME = hB;
  process.env.BOTLINK_HOME = join(hB, ".botlink");
  const pending = b.commit().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  for (const [k, v] of Object.entries(base)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  f.holdAcks = false;
  // the owed-ack record is lost too (worst case); the lease lapses; the server hands it out again
  await on(hB, () => rmSync(join(hB, ".botlink", "ackq"), { recursive: true, force: true }));
  const d = f.copies(s.id)[0];
  assert.equal(d.state, "queued");
  d.lease_until = 0;
  const again = await on(hB, () => core.takeBatch([st.loadMember(mB.id)!], SB, {}));
  assert.doesNotMatch(again.text, /BLTOK-unit-14632/);
  assert.doesNotMatch(again.text, /re-delivered/);
  assert.equal(f.copies(s.id)[0].state, "shown");
  void pending;
});

test("a new turn retires the Stop waiter by its PID (no lost lease)", async () => {
  const { hB, send } = await room2();
  const w = hook(hB, "claude-code", "stop", { session_id: SB, cwd: hB });
  await new Promise((r) => setTimeout(r, 700));
  const p = await hook(hB, "claude-code", "prompt", { session_id: SB, cwd: hB, prompt: "hi" });
  assert.equal(p.code, 0);
  const r = await w;
  assert.equal(r.code, 0, "retired waiter exits 0 without output");
  const s = await send("after retire");
  assert.equal(f.copies(s.id)[0].lease_until, 0, "nobody holds a lease on it");
});

test("no Stop waiter in watch-resumed / unattended runs", async () => {
  const { hB } = await room2();
  const r = await hook(hB, "claude-code", "stop", { session_id: SB, cwd: hB }, { env: { BOTLINK_UNATTENDED: "1" } });
  assert.equal(r.code, 0);
});

test("Codex: SessionStart context JSON; Stop -> fixed block reason once per batch, never message text", async () => {
  const { hA, mA, hB, mB } = await room2();
  // rcpt -> sender (sender is a Codex chat, session SA)
  await on(hB, () => core.send(st.loadMember(mB.id)!, { to: "sender", text: "BLTOK-codex-secret-text", intent: "question" }, SB));
  const s1 = await hook(hA, "codex", "stop", { session_id: SA, cwd: hA, hook_event_name: "Stop" });
  assert.equal(s1.code, 0);
  assert.deepEqual(JSON.parse(s1.stdout), { decision: "block", reason: "You have 1 new bot-link message. Call the bot-link inbox tool." });
  assert.ok(!s1.stdout.includes("BLTOK"));
  const s2 = await hook(hA, "codex", "stop", { session_id: SA, cwd: hA });
  assert.equal(s2.stdout, "", "already nudged for this batch");
  const ss = await hook(hA, "codex", "session-start", { session_id: SA, cwd: hA, source: "resume" });
  assert.equal(ss.code, 0);
  assert.match(JSON.parse(ss.stdout).hookSpecificOutput.additionalContext, /BLTOK-codex-secret-text/);
  void mA;
});

test("Cursor: sessionStart additional_context; stop followup_message (fixed text)", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `cu${Math.floor(Math.random() * 1e6)}`);
  const inv = f.invite(room, adam);
  const hC = newHome("cursor"), hS = newHome("sender");
  const join = (h: string, name: string, app: st.App, session: string | null) =>
    on(h, async () => {
      const r = await core.joinCreate({ invite: inv, name, job: "", app, turn: "on_turn", session, cwd: h, folder: "~", machine: "m" });
      f.approve(r.req.id);
      return ((await core.joinWait({ maxMs: 3000 })) as any).member as st.MemberRec;
    });
  // the Cursor chat conv-1 joined from its own shell (CURSOR_CONVERSATION_ID): it IS the member (H2)
  process.env.CURSOR_CONVERSATION_ID = "conv-1";
  try {
    await join(hC, "cur", "cursor", null);
  } finally {
    delete process.env.CURSOR_CONVERSATION_ID;
  }
  const ms = await join(hS, "snd", "codex", SA);
  await on(hS, () => core.send(st.loadMember(ms.id)!, { to: "cur", text: "BLTOK-cursor", intent: "task" }, SA));
  // H2: another Cursor chat in the same folder is not the member: no nudge, no messages
  const other = await hook(hC, "cursor", "stop", { conversation_id: "conv-2", workspace_roots: [hC], status: "completed" });
  assert.equal(other.stdout.trim(), "");
  const otherSs = await hook(hC, "cursor", "session-start", { conversation_id: "conv-2", session_id: "conv-2", workspace_roots: [hC] });
  assert.doesNotMatch(otherSs.stdout, /BLTOK-cursor/);
  const stop = await hook(hC, "cursor", "stop", { conversation_id: "conv-1", workspace_roots: [hC], status: "completed" });
  assert.deepEqual(JSON.parse(stop.stdout), { followup_message: "You have 1 new bot-link message. Call the bot-link inbox tool." });
  const ss = await hook(hC, "cursor", "session-start", { conversation_id: "conv-1", session_id: "conv-1", workspace_roots: [hC] });
  assert.equal(ss.code, 0);
  assert.match(JSON.parse(ss.stdout).additional_context, /BLTOK-cursor/);
});

test("watch-resumed SessionStart (same session id: verified for claude -p --resume / codex exec resume); a NEW id never auto-claims (H1)", async () => {
  const { hB, mB, send } = await room2();
  await send("BLTOK-unit-5");
  // a resume keeps the session id: the resumed chat IS the holder
  const r = await hook(hB, "claude-code", "session-start", { session_id: SB, cwd: hB, source: "resume" }, { env: { BOTLINK_WAKE_MEMBER: mB.id, BOTLINK_UNATTENDED: "1" } });
  assert.equal(r.code, 0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /BLTOK-unit-5/);
  assert.match(ctx, /Unattended: no human is present in this run/);
  // a different session id is a different chat: no claim, nothing shown, the holder stays
  await send("BLTOK-unit-6");
  const NEW = "cccccccc-1111-4222-8333-000000000009";
  const r2 = await hook(hB, "claude-code", "session-start", { session_id: NEW, cwd: hB, source: "resume" }, { env: { BOTLINK_WAKE_MEMBER: mB.id, BOTLINK_UNATTENDED: "1" } });
  assert.equal(r2.code, 0);
  assert.doesNotMatch(r2.stdout, /BLTOK-unit-6/);
  assert.equal(f.members.get(mB.id)!.holder_session, SB);
});

test("a big batch stays under the context limit; the rest waits (released) with a pointer to the inbox tool", async () => {
  const { hB, send } = await room2();
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) ids.push((await send(`BLTOK-big-${i} ` + "x".repeat(2500))).id);
  const r = await hook(hB, "claude-code", "session-start", { session_id: SB, cwd: hB });
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.length < 10_000, `context ${ctx.length}`);
  assert.match(ctx, /more messages? (is|are) waiting\. Call the bot-link inbox tool/);
  const states = ids.map((id) => f.copies(id)[0]);
  const shown = states.filter((d) => d.state === "shown").length;
  assert.ok(shown >= 1 && shown < 6);
  for (const d of states.filter((x) => x.state === "queued")) assert.equal(d.lease_until, 0, "overflow released, not left leased");
});

test("Codex nudge text and Claude wake prompt are not captured as the human's words", async () => {
  const { hB } = await room2();
  await hook(hB, "codex", "prompt", { session_id: "cx-1", cwd: hB, prompt: "You have 3 new bot-link messages. Call the bot-link inbox tool." });
  await on(hB, () => assert.equal(st.readPrompts("cx-1").length, 0));
  assert.ok(!existsSync(join(hB, ".botlink", "prompts", "cx-1.jsonl")) || readFileSync(join(hB, ".botlink", "prompts", "cx-1.jsonl"), "utf-8").trim() === "");
});

// ------------------------------------------------------------------ privacy hotfix: prompts of non-member chats
const promptsDir = (h: string) => join(h, ".botlink", "prompts");
const promptFiles = (h: string) => (existsSync(promptsDir(h)) ? readdirSync(promptsDir(h)).filter((x) => !x.startsWith(".")) : []);

test("privacy: a chat that holds no member never has its prompt written (no member on this computer)", async () => {
  const h = newHome("nomember");
  const S = "eeeeeeee-1111-4222-8333-00000000000e";
  const r = await hook(h, "claude-code", "prompt", { session_id: S, cwd: h, prompt: "PRIVATE-nomember my bank password is hunter2", hook_event_name: "UserPromptSubmit" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
  assert.deepEqual(promptFiles(h), []);
  assert.ok(!existsSync(join(h, ".botlink", "waiters")), "no per-session waiter file for a non-member chat");
  for (const app of ["codex", "cursor"]) {
    const x = await hook(h, app, "prompt", { session_id: S, conversation_id: S, cwd: h, workspace_roots: [h], prompt: "PRIVATE-nomember other app" });
    assert.equal(x.code, 0);
    assert.equal(x.stdout, "");
  }
  assert.deepEqual(promptFiles(h), []);
});

test("privacy: another chat in the member's folder (member held by a different session) is not captured; the member chat is", async () => {
  const { hB } = await room2();
  const OTHER = "ffffffff-1111-4222-8333-00000000000f";
  const elsewhere = newHome("elsewhere");
  await hook(hB, "claude-code", "prompt", { session_id: OTHER, cwd: hB, prompt: "PRIVATE-samefolder not a member chat" });
  await hook(hB, "claude-code", "prompt", { session_id: OTHER, cwd: elsewhere, prompt: "PRIVATE-otherfolder not a member chat" });
  await hook(hB, "codex", "prompt", { session_id: OTHER, cwd: hB, prompt: "PRIVATE-otherapp not a member chat" });
  assert.deepEqual(promptFiles(hB), []);
  for (const fn of readdirSync(join(hB, ".botlink"), { recursive: true }) as string[]) {
    const fp = join(hB, ".botlink", fn);
    try {
      assert.ok(!readFileSync(fp, "utf-8").includes("PRIVATE-"), `prompt text leaked into ${fn}`);
    } catch (e: any) {
      if (e?.code !== "EISDIR") throw e;
    }
  }
  // the member chat: captured, 0600, in a 0700 dir
  await hook(hB, "claude-code", "prompt", { session_id: SB, cwd: hB, prompt: "staging deploys from sender are fine without asking me" });
  assert.deepEqual(promptFiles(hB), [`${SB}.jsonl`]);
  assert.equal(statSync(join(promptsDir(hB), `${SB}.jsonl`)).mode & 0o777, 0o600);
  assert.equal(statSync(promptsDir(hB)).mode & 0o777, 0o700);
});

test("privacy migration: prompt files stored by older versions for non-member chats are purged at hook start; stale ones too", async () => {
  const { hB } = await room2();
  mkdirSync(promptsDir(hB), { recursive: true, mode: 0o700 });
  const now = Date.now();
  const line = (at: number, text: string) => JSON.stringify({ at, text }) + "\n";
  // older versions: every chat's prompts, 24 h, no app/folder recorded
  writeFileSync(join(promptsDir(hB), "11111111-1111-4222-8333-000000000001.jsonl"), line(now - 60_000, "PRIVATE-old non-member chat"), { mode: 0o644 });
  writeFileSync(join(promptsDir(hB), "cx-old.jsonl"), line(now - 3600_000, "PRIVATE-old codex chat"), { mode: 0o644 });
  writeFileSync(join(promptsDir(hB), `${SB}.jsonl`), line(now - 60_000, "member words still in the window"), { mode: 0o644 });
  // any hook run (here: a non-member chat's prompt) purges
  const r = await hook(hB, "claude-code", "prompt", { session_id: "22222222-1111-4222-8333-000000000002", cwd: newHome("x"), prompt: "PRIVATE-new" });
  assert.equal(r.code, 0);
  assert.deepEqual(promptFiles(hB), [`${SB}.jsonl`], "only the member chat's file survives");
  assert.equal(statSync(join(promptsDir(hB), `${SB}.jsonl`)).mode & 0o777, 0o600, "kept files are tightened to 0600");
  // a member chat's prompts older than the 30-minute window are purged too
  writeFileSync(join(promptsDir(hB), `${SB}.jsonl`), line(now - 31 * 60_000, "member words too old"), { mode: 0o600 });
  await hook(hB, "codex", "stop", { session_id: "33333333-1111-4222-8333-000000000003", cwd: newHome("y") });
  assert.deepEqual(promptFiles(hB), []);
});

test("privacy: leaving purges the chat's stored prompts; captured prompts are bounded (30 min, last 20)", async () => {
  const { hB, mB } = await room2();
  await on(hB, () => {
    const t0 = Date.now() - 40 * 60_000;
    st.capturePrompt(SB, "too old to keep", t0);
    for (let i = 0; i < 25; i++) st.capturePrompt(SB, `prompt number ${i}`);
    const ps = st.readPrompts(SB);
    assert.equal(ps.length, 20);
    assert.ok(!ps.some((p) => p.text === "too old to keep"));
    const raw = readFileSync(join(promptsDir(hB), `${SB}.jsonl`), "utf-8");
    assert.ok(!raw.includes("too old to keep"), "expired prompts are not kept on disk");
    assert.equal(raw.trim().split("\n").length, 20);
  });
  await hook(hB, "claude-code", "prompt", { session_id: SB, cwd: hB, prompt: "a member prompt before leaving" });
  assert.deepEqual(promptFiles(hB), [`${SB}.jsonl`]);
  await on(hB, () => core.leave(st.loadMember(mB.id)!, SB));
  assert.deepEqual(promptFiles(hB), [], "leave purges this chat's prompts");
});

test("live bug B (2026-11-06, 1446 leases + 1445 rosters in 10 min): a Stop waiter facing leases that return at once with nothing to show backs off, and a notice is fetched once", async () => {
  const { hB, mB } = await room2();
  // an unacked notice that renders nothing (a roster change) + a server that answers every long-poll at once
  f.notice(mB.id, "roster_changed", { head_seq: 999 });
  f.leaseAtOnce = true;
  const k = (p: string) => f.hits.get(p) || 0;
  const l0 = k("POST /api/v1/me/inbox/lease"), r0 = k("GET /api/v1/me/roster");
  try {
    const r = await hook(hB, "claude-code", "stop", { session_id: SB, cwd: hB }, { env: { BOTLINK_WAIT_LIMIT_S: "20" } });
    assert.equal(r.code, 0);
  } finally {
    f.leaseAtOnce = false;
  }
  const leases = k("POST /api/v1/me/inbox/lease") - l0, rosters = k("GET /api/v1/me/roster") - r0;
  assert.ok(leases <= 6, `${leases} lease calls in 20 s (back off: at most 6)`);
  assert.ok(rosters <= 1, `${rosters} roster calls (the notice is handled once)`);
});
