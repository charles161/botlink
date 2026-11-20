/**
 * `botlink watch` as a real child process, with a fake `claude` / `codex` binary (BOTLINK_CLAUDE_BIN / BOTLINK_CODEX_BIN):
 *   T11  a resume path that always fails before any hook runs -> stuck after 5 wakes, 1 attention item, <= 6 resumes
 *   ok   the resumed run's SessionStart hook shows the message (exact session, unattended env, wake prompt)
 *   gone "session not found" -> ask-human cannot_wake once, no more resumes
 *   live a live holder session is never polled or resumed by watch
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as L from "../src/listen.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

function fakeBin(dir: string): string {
  const p = join(dir, "fake-harness.mjs");
  writeFileSync(
    p,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const log = process.env.FAKE_LOG;
appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), wake: process.env.BOTLINK_WAKE_MEMBER, unattended: process.env.BOTLINK_UNATTENDED }) + "\\n");
const mode = process.env.FAKE_MODE;
if (mode === "fail") { process.stderr.write("Error: API down\\n"); process.exit(1); }
if (mode === "notfound") { process.stderr.write("No conversation found with session ID: x\\n"); process.exit(1); }
if (mode === "writer") {
  // an OPEN Codex chat (TUI): resume is refused; codex queue puts a turn into the open chat, which reads its inbox
  const a = process.argv.slice(2);
  if (a[0] === "exec") { process.stderr.write("ERROR codex_core::session: Failed to create session: thread-store conflict: thread x already has an active writer\\n"); process.exit(1); }
  if (a[0] === "queue") {
    const r = spawnSync(process.execPath, [process.env.FAKE_CLI, "inbox"], { encoding: "utf-8", env: { ...process.env, BOTLINK_SESSION: a[a.indexOf("--thread") + 1], BOTLINK_APP: "codex" } });
    appendFileSync(log, JSON.stringify({ inbox_code: r.status, inbox_out: r.stdout }) + "\\n");
    process.exit(0);
  }
  process.exit(2);
}
if (mode === "cursor") {
  // cursor-agent -p --resume <chat> "<prompt>": no hook runs on resume; the model calls the bot-link inbox tool
  const r = spawnSync(process.execPath, [process.env.FAKE_CLI, "inbox"], { encoding: "utf-8" });
  appendFileSync(log, JSON.stringify({ inbox_code: r.status, inbox_out: r.stdout }) + "\\n");
  process.exit(0);
}
if (mode === "hook") {
  const app = process.env.FAKE_APP;
  const a = process.argv.slice(2); const eq = a.find((x) => x.startsWith("--resume=")); const sid = eq ? eq.slice(9) : a[a.indexOf(app === "codex" ? "resume" : "--resume") + 1];
  const r = spawnSync(process.execPath, [process.env.FAKE_CLI, "hook", app, "session-start"], { input: JSON.stringify({ session_id: sid, cwd: process.cwd(), source: "resume" }), encoding: "utf-8" });
  appendFileSync(log, JSON.stringify({ hook_code: r.status, hook_out: r.stdout }) + "\\n");
  process.exit(0);
}
`,
  );
  chmodSync(p, 0o755);
  return p;
}

const SID = "dddddddd-1111-4222-8333-000000000004";

async function setup(app: st.App) {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `w${Math.floor(Math.random() * 1e6)}`);
  const inv = f.invite(room, adam);
  const hR = newHome("watch-r"), hS = newHome("watch-s");
  const join2 = (h: string, name: string, a: st.App, session: string, turn: st.Turn) =>
    on(h, async () => {
      const r = await core.joinCreate({ invite: inv, name, job: "", app: a, turn, session, cwd: h, folder: "~", machine: "m" });
      f.approve(r.req.id);
      return ((await core.joinWait({ maxMs: 3000 })) as any).member as st.MemberRec;
    });
  const mR = await join2(hR, "sleeper", app, SID, "wake");
  const mS = await join2(hS, "pinger", "codex", "sender-session", "on_turn");
  const send = (text: string) => on(hS, () => core.send(st.loadMember(mS.id)!, { to: "sleeper", text, intent: "task" }, "sender-session"));
  return { hR, mR, send, adam };
}

function runWatch(home: string, env: Record<string, string>, seconds: number) {
  const log = join(home, "fake.log");
  writeFileSync(log, "");
  const bin = fakeBin(home);
  const child = spawn(process.execPath, [CLI, "watch", "--run-s", String(seconds)], {
    cwd: home,
    env: { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, BOTLINK_CLAUDE_BIN: bin, BOTLINK_CODEX_BIN: bin, BOTLINK_CURSOR_BIN: bin, FAKE_LOG: log, FAKE_CLI: CLI, BOTLINK_WAKE_GAP_MS: "300", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  const done = new Promise<number | null>((r) => child.on("exit", r));
  const entries = () => readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { child, done, entries, out: () => out };
}

test("T11: resume always fails before any hook -> stuck after 5 wakes, 1 attention, <= 6 resume attempts", async () => {
  const { hR, mR, send } = await setup("claude-code");
  const s = await send("BLTOK-t11");
  const w = runWatch(hR, { FAKE_MODE: "fail" }, 12);
  await w.done;
  const resumes = w.entries().filter((e) => e.argv);
  const d = f.copies(s.id)[0];
  assert.equal(d.state, "stuck", w.out());
  assert.ok(d.wakes >= 5);
  assert.ok(resumes.length >= 4 && resumes.length <= 6, `resumes ${resumes.length}`);
  assert.equal(f.attention.filter((a) => a.member === mR.id).length, 1);
  // every attempt resumed exactly the holder session, unattended, in its folder
  for (const r of resumes) {
    assert.equal(r.argv[0], "-p");
    assert.match(r.argv[1], /^bot-link: new messages for you are in your context\./);
    assert.equal(r.argv[2], `--resume=${SID}`);
    // nobody is here: the tools that run commands or change files are off for this run (safety.ts)
    assert.deepEqual(r.argv.slice(3, 5), ["--disallowedTools", "Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch"]);
    assert.equal(r.argv[r.argv.length - 2], "--allowedTools");
    assert.equal(r.wake, mR.id);
    assert.equal(r.unattended, "1");
    assert.equal(r.cwd, hR);
  }
});

test("resume: the resumed run's SessionStart hook shows the message; watch then goes quiet", async () => {
  const { hR, send } = await setup("claude-code");
  const s = await send("BLTOK-resume-ok");
  const w = runWatch(hR, { FAKE_MODE: "hook", FAKE_APP: "claude-code" }, 6);
  await w.done;
  const e = w.entries();
  const hookRun = e.find((x) => "hook_code" in x);
  assert.ok(hookRun, w.out());
  assert.equal(hookRun.hook_code, 0);
  assert.match(JSON.parse(hookRun.hook_out).hookSpecificOutput.additionalContext, /BLTOK-resume-ok/);
  assert.match(JSON.parse(hookRun.hook_out).hookSpecificOutput.additionalContext, /Unattended/);
  assert.equal(f.copies(s.id)[0].state, "shown");
  assert.equal(e.filter((x) => x.argv).length, 1, "one resume for one message");
});

test("resume (Codex): codex exec resume <sid> <prompt>", async () => {
  const { hR, send } = await setup("codex");
  const s = await send("BLTOK-codex-resume");
  const w = runWatch(hR, { FAKE_MODE: "hook", FAKE_APP: "codex" }, 6);
  await w.done;
  const r = w.entries().find((x) => x.argv)!;
  // nobody is here: Codex runs the woken chat in a read-only sandbox (safety.ts)
  assert.deepEqual(r.argv.slice(0, 5), ["exec", "--sandbox", "read-only", "resume", SID]);
  assert.equal(f.copies(s.id)[0].state, "shown");
});

test("session gone: ask-human cannot_wake once, then no more resumes for that holder", async () => {
  const { hR, mR, send } = await setup("claude-code");
  await send("BLTOK-gone");
  const w = runWatch(hR, { FAKE_MODE: "notfound" }, 6);
  await w.done;
  assert.equal(w.entries().filter((x) => x.argv).length, 1);
  assert.deepEqual(f.attention.filter((a) => a.member === mR.id).map((a) => a.reason), ["cannot_wake"]);
  await on(hR, () => assert.equal(st.loadMember(mR.id)!.cannot_wake_session, SID));
});

test("live holder session: watch never polls or resumes it (its own hooks handle it)", async () => {
  const { hR, mR, send } = await setup("claude-code");
  await on(hR, () => st.setLive({ session: SID, app: "claude-code", pid: process.pid, cwd: hR, at: Date.now() }));
  await send("BLTOK-live");
  const n0 = f.log.length;
  const w = runWatch(hR, { FAKE_MODE: "hook", FAKE_APP: "claude-code" }, 4);
  await w.done;
  assert.equal(w.entries().length, 0);
  assert.equal(f.log.slice(n0).filter((l) => l.path === "/api/v1/me/wait").length, 0);
  assert.ok(existsSync(join(hR, ".botlink", "live", `${SID}.json`)));
  void mR;
});

test("listen --once: non-leasing wait; prints the line and exits 0; the message stays for the inbox tool", async () => {
  const { hR, send } = await setup("cursor");
  const child = spawn(process.execPath, [CLI, "listen", "--member", "sleeper", "--once", "--max-s", "20"], { cwd: hR, env: { ...process.env, HOME: hR, BOTLINK_HOME: join(hR, ".botlink"), BOTLINK_SERVER: f.url }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  await new Promise((r) => setTimeout(r, 800));
  const s = await send("BLTOK-listen");
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0);
  assert.match(out.trim(), /^1 new bot-link message for sleeper\. Call the bot-link inbox tool \(or run: .* inbox --as sleeper\)\.\n\nbot-link: this listener stopped after waking this chat once\. Start it again NOW, as a background task, [^\n]* listen --once --member sleeper$/);
  const d = f.copies(s.id)[0];
  assert.equal(d.state, "queued");
  assert.equal(d.lease_until, 0, "listen never takes a lease");
});

test("listen keeps running (r2): one line per new batch, re-checks without counting wakes until read, then again for the next", async () => {
  const { hR, send } = await setup("cursor");
  const child = spawn(process.execPath, [CLI, "listen", "--member", "sleeper", "--max-s", "25"], { cwd: hR, env: { ...process.env, HOME: hR, BOTLINK_HOME: join(hR, ".botlink"), BOTLINK_SERVER: f.url }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  const ended = new Promise((r) => child.on("exit", r));
  await new Promise((r) => setTimeout(r, 800));
  const s1 = await send("BLTOK-loop-1");
  assert.ok(await until(() => /1 new bot-link message for sleeper/.test(out), 8000), out);
  await new Promise((r) => setTimeout(r, 6000)); // peeks meanwhile
  assert.equal(child.exitCode, null, "still running after the first batch");
  assert.ok(f.copies(s1.id)[0].wakes <= 1, `peeks don't count wakes (${f.copies(s1.id)[0].wakes})`);
  const s2 = await send("BLTOK-loop-2");
  assert.ok(await until(() => /2 new bot-link messages for sleeper/.test(out), 10_000), out);
  try {
    process.kill(child.pid!, "SIGTERM");
  } catch {
    /* gone */
  }
  await ended;
  void s2;
});

const CHAT = "c0c0c0c0-1111-4222-8333-000000000009";

async function setupCursor(chatEnv: string | undefined) {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `wc${Math.floor(Math.random() * 1e6)}`);
  const inv = f.invite(room, adam);
  const hR = newHome("watch-cr"), hS = newHome("watch-cs");
  // a Cursor chat runs join from its shell: no session (members act from their folder), CURSOR_CONVERSATION_ID set
  const mR = await on(hR, async () => {
    const r = await core.joinCreate({ invite: inv, name: "cursorbot", job: "", app: "cursor", turn: "wake", session: null, cwd: hR, folder: "~", machine: "m" });
    f.approve(r.req.id);
    return ((await core.joinWait({ maxMs: 3000 })) as any).member as st.MemberRec;
  }, { CURSOR_CONVERSATION_ID: chatEnv });
  const mS = await on(hS, async () => {
    const r = await core.joinCreate({ invite: inv, name: "pinger", job: "", app: "codex", turn: "on_turn", session: "sender-session", cwd: hS, folder: "~", machine: "m" });
    f.approve(r.req.id);
    return ((await core.joinWait({ maxMs: 3000 })) as any).member as st.MemberRec;
  });
  const send = (text: string) => on(hS, () => core.send(st.loadMember(mS.id)!, { to: "cursorbot", text, intent: "task" }, "sender-session"));
  return { hR, mR, send };
}

test("resume (Cursor): cursor-agent -p --resume <the chat that joined> <wake prompt>; the inbox tool shows the message; one resume", async () => {
  const { hR, mR, send } = await setupCursor(CHAT);
  assert.equal(mR.holder_session, null, "a Cursor member holds no session");
  assert.equal(mR.wake_chat, CHAT, "join records the Cursor chat it ran in");
  const s = await send("BLTOK-cursor-resume");
  const w = runWatch(hR, { FAKE_MODE: "cursor" }, 6);
  await w.done;
  const e = w.entries();
  const runs = e.filter((x) => x.argv);
  assert.equal(runs.length, 1, w.out());
  assert.deepEqual(runs[0].argv, ["-p", "--resume", CHAT, "bot-link: you have new messages. Call the bot-link inbox tool now to read them, then handle them under the bot-link rules. (Call it with as: cursorbot.)"]);
  assert.equal(runs[0].unattended, "1");
  assert.equal(runs[0].cwd, hR);
  const inbox = e.find((x) => "inbox_code" in x);
  assert.equal(inbox.inbox_code, 0);
  assert.match(inbox.inbox_out, /BLTOK-cursor-resume/);
  assert.equal(f.copies(s.id)[0].state, "shown");
});

test("Cursor: no known chat -> watch doesn't resume; a NEW chat in the folder never becomes the member (H2)", async () => {
  const { hR, mR, send } = await setupCursor(undefined);
  assert.equal(mR.wake_chat ?? null, null);
  const s = await send("BLTOK-cursor-nochat");
  const w = runWatch(hR, { FAKE_MODE: "cursor" }, 3);
  await w.done;
  assert.equal(w.entries().filter((x) => x.argv).length, 0, "nothing to resume");
  // a new Cursor chat in the member's folder: not the member (a field test T11): no messages, no wake binding
  // (async spawn: the fake server runs in this process)
  const hook = spawn(process.execPath, [CLI, "hook", "cursor", "session-start"], { cwd: hR, env: { ...process.env, HOME: hR, BOTLINK_HOME: join(hR, ".botlink"), BOTLINK_SERVER: f.url }, stdio: ["pipe", "pipe", "pipe"] });
  const r = { stdout: "", status: null as number | null };
  hook.stdout.on("data", (b) => (r.stdout += b));
  hook.stdin.end(JSON.stringify({ conversation_id: CHAT, workspace_roots: [hR] }));
  r.status = await new Promise((res) => hook.on("exit", res));
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /BLTOK-cursor-nochat/);
  assert.equal(f.copies(s.id)[0].state, "queued");
  await on(hR, () => assert.equal(st.loadMember(mR.id)!.wake_chat ?? null, null));
});

// ---------------------------------------------------------------- self-built ears: listen --on-message
const listeners: { pid?: number; exitCode: number | null }[] = [];
// a failed assertion must not leave a listener running (it would keep the test process alive): kill by our own PIDs,
// and any detached listener by the pid in its lock file
after(() => {
  for (const c of listeners) if (c.pid && c.exitCode === null) try { process.kill(c.pid, "SIGTERM"); } catch { /* gone */ }
});
function listenProc(home: string, args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [CLI, "listen", ...args], { cwd: home, env: { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, BOTLINK_LISTEN_GAP_MS: "300", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  listeners.push(child);
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (out += b));
  const done = new Promise<number | null>((r) => child.on("exit", r));
  return { child, done, out: () => out };
}
const until = async (pred: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !pred()) await new Promise((r) => setTimeout(r, 100));
  return pred();
};
const lines = (p: string) => (existsSync(p) ? readFileSync(p, "utf-8").split("\n").filter(Boolean) : []);

test("listen --on-message: shows the command, marks the member listening, runs the command (unattended env) once per arrival, never leases; --stop puts the turn back", async () => {
  const { hR, mR, send } = await setup("cursor");
  const runs = join(hR, "runs.log");
  // the human-approved command: here it reads the inbox the way a woken chat would (the inbox tool), and logs its env
  const cmd = `echo "$BOTLINK_LISTEN_MEMBER $BOTLINK_LISTEN_COUNT $BOTLINK_UNATTENDED $BOTLINK_SESSION" >> ${runs}; ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} inbox --as sleeper >> ${runs}`;
  const l = listenProc(hR, ["--member", "sleeper", "--on-message", cmd]);
  assert.ok(await until(() => /Show this command to your human/.test(l.out())), l.out());
  assert.ok(l.out().includes(cmd), "the exact command is shown at setup");
  assert.ok(await until(() => f.turnLog.some((t) => t.member === mR.id && t.turn === "listening")), "member marked listening on the server");
  assert.equal(f.members.get(mR.id)!.turn, "listening");
  // one listener per member: a second one refuses (exit 5)
  const second = listenProc(hR, ["--member", "sleeper", "--on-message", "true"]);
  assert.equal(await second.done, 5, second.out());
  assert.match(second.out(), /already running/);
  const s1 = await send("BLTOK-ears-1");
  assert.ok(await until(() => lines(runs).some((x) => x.includes("BLTOK-ears-1"))), l.out());
  assert.equal(lines(runs)[0], `sleeper 1 1 ${SID}`, "member name, waiting count, BOTLINK_UNATTENDED=1, BOTLINK_SESSION = the holder");
  assert.equal(f.copies(s1.id)[0].state, "shown", "the command's inbox call showed it");
  const s2 = await send("BLTOK-ears-2");
  assert.ok(await until(() => lines(runs).some((x) => x.includes("BLTOK-ears-2"))), l.out());
  assert.equal(f.copies(s2.id)[0].state, "shown");
  assert.equal(lines(runs).filter((x) => /^sleeper \d+ 1 /.test(x)).length, 2, "one run per arrival");
  // status shows it; --stop stops it (by its PID) and puts the turn back
  const st1 = listenProc(hR, ["--stop", "--member", "sleeper"]);
  assert.equal(await st1.done, 0);
  assert.match(st1.out(), /Stopped the listener for sleeper/);
  assert.equal(await l.done, 0);
  assert.equal(f.members.get(mR.id)!.turn, "wake", "turn put back to what it was");
  assert.ok(!existsSync(join(hR, ".botlink", "listen", `${mR.id}.json`)));
});

test("listen --on-message: single-flight + backoff when a run leaves messages waiting; stops when the member is removed", async () => {
  const { hR, mR, send, adam } = await setup("cursor");
  const runs = join(hR, "runs.log");
  // a command that does NOT read the inbox (slow, leaves the message waiting): runs must not overlap and must back off
  const cmd = `echo "start $(date +%s%N)" >> ${runs}; sleep 0.5; echo "end $(date +%s%N)" >> ${runs}`;
  const l = listenProc(hR, ["--member", "sleeper", "--on-message", cmd]);
  assert.ok(await until(() => /Show this command/.test(l.out())));
  await send("BLTOK-ears-stays");
  assert.ok(await until(() => lines(runs).filter((x) => x.startsWith("start")).length >= 3, 12_000), l.out());
  const ev = lines(runs).map((x) => ({ k: x.split(" ")[0], t: Number(x.split(" ")[1]) / 1e6 }));
  for (let i = 0; i + 1 < ev.length; i += 2) assert.deepEqual([ev[i].k, ev[i + 1]?.k ?? "end"], ["start", "end"], "never two runs at once");
  const starts = ev.filter((e) => e.k === "start").map((e) => e.t);
  const ends = ev.filter((e) => e.k === "end").map((e) => e.t);
  const gap1 = starts[1] - ends[0], gap2 = starts[2] - ends[1];
  assert.ok(gap1 >= 250, `>= the base gap between runs (${gap1} ms)`);
  assert.ok(gap2 > gap1 * 1.5, `the gap grows while messages stay waiting (${gap1} -> ${gap2} ms)`);
  // the member is removed from the room: the listener stops (exit 4)
  f.removeMember(mR.id, adam);
  assert.equal(await Promise.race([l.done, new Promise((r) => setTimeout(() => r("timeout"), 15_000))]), 4, l.out());
  assert.match(l.out(), /Listener stopped/);
});

test("listen --on-message --detach: returns at once with the command and pid; the background listener keeps running", async () => {
  const { hR, mR } = await setup("cursor");
  const d = listenProc(hR, ["--member", "sleeper", "--on-message", "true", "--detach"]);
  assert.equal(await d.done, 0, d.out());
  assert.match(d.out(), /Listening in the background \(pid (\d+)/);
  const pid = Number(d.out().match(/pid (\d+)/)![1]);
  listeners.push({ pid, exitCode: null });
  assert.ok(st.pidAlive(pid));
  const status = listenProc(hR, ["--stop", "--member", "sleeper"]);
  assert.equal(await status.done, 0);
  assert.ok(await until(() => !st.pidAlive(pid)), "stopped by its PID");
  void mR;
});

// Gate 16 Nov 2026 (every full run on a loaded box): `listen --detach` said "The listener didn't start" when two
// cold Node starts (its supervisor, then the listener) took longer than the 10 s it waited, and the listener then
// started anyway, behind the person's back. Each Node start here is made slow on purpose (a preload that blocks for
// SLOW_START_MS), the way a loaded computer makes it slow; nothing in the test waits on the clock of this box.
function slowStart(home: string, ms: number): Record<string, string> {
  const p = join(home, "slow-start.mjs");
  writeFileSync(p, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.SLOW_START_MS || 0));\n");
  return { NODE_OPTIONS: `--import ${pathToFileURL(p).href}`, SLOW_START_MS: String(ms) };
}
const memberProcs = (id: string) => (spawnSync("ps", ["-eo", "args"], { encoding: "utf-8" }).stdout || "").split("\n").filter((l) => l.includes(`--member-id ${id}`));

// Measured on the gate box (16 Nov 2026): the start of each listener process spawned about 22 `ps` processes (the
// session lookup walked every ancestor with `ps -o lstart` and `ps -o ppid`), 44 ms each on a quiet box and several
// hundred under load: 4 to 6 s before the listener took its lock, twice (supervisor and listener).
test("a listener's start spawns at most a couple of `ps` processes (process facts come from /proc)", { timeout: 60_000 }, async () => {
  const { hR, mR } = await setup("cursor");
  const bin = join(hR, "bin");
  const log = join(hR, "ps-calls.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ps"), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexec /usr/bin/ps "$@"\n`);
  chmodSync(join(bin, "ps"), 0o755);
  const l = listenProc(hR, ["--member-id", mR.id, "--on-message", "true", "--max-s", "1"], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(await l.done, 0, l.out());
  const calls = lines(log);
  assert.ok(calls.length <= 3, `${calls.length} ps processes for one listener start (read /proc instead: session.ts parentOf/commOf, and look up a session link only for an ancestor that has one): ${calls.join(" | ")}`);
});

test("listen --detach on a slow computer (each Node start takes 6 s): it waits for the listener and says it runs", { timeout: 120_000 }, async () => {
  const { hR, mR } = await setup("cursor");
  const d = listenProc(hR, ["--member", "sleeper", "--on-message", "true", "--detach"], slowStart(hR, 6000));
  assert.equal(await d.done, 0, d.out());
  const pid = Number(d.out().match(/Listening in the background \(pid (\d+)/)?.[1]);
  assert.ok(pid && st.pidAlive(pid), d.out());
  listeners.push({ pid, exitCode: null });
  const stop = listenProc(hR, ["--stop", "--member", "sleeper"]);
  assert.equal(await stop.done, 0);
  assert.ok(await until(() => !st.pidAlive(pid)), "stopped by its PID");
});

test("listen --detach whose listener does not start in time: it says so, and nothing is left running behind the person's back", { timeout: 120_000 }, async () => {
  const { hR, mR } = await setup("cursor");
  const d = listenProc(hR, ["--member", "sleeper", "--on-message", "true", "--detach"], { ...slowStart(hR, 3000), BOTLINK_LISTEN_START_MS: "2000" });
  assert.equal(await d.done, 1, d.out());
  assert.match(d.out(), /The listener didn't start within 2 s, so bot-link stopped it: nothing is listening for sleeper\./);
  // long enough for a listener that was left behind to have started (two slow starts)
  await new Promise((r) => setTimeout(r, 8000));
  await on(hR, () => assert.equal(L.runningListener(mR.id), null, "no listener started later"));
  assert.deepEqual(memberProcs(mR.id), [], "no supervisor or listener left running");
});

test("r3: an OPEN Codex chat refuses the resume (active writer): watch queues the wake into the open thread (codex queue); the chat's own inbox read counts as woken; nothing stuck", async () => {
  const { hR, mR, send } = await setup("codex");
  const s = await send("BLTOK-open-writer");
  const w = runWatch(hR, { FAKE_MODE: "writer" }, 8);
  await w.done;
  const e = w.entries();
  const resumes = e.filter((x) => x.argv && x.argv[0] === "exec");
  const queues = e.filter((x) => x.argv && x.argv[0] === "queue");
  assert.equal(resumes.length, 1, w.out());
  assert.equal(queues.length, 1, w.out());
  assert.deepEqual(queues[0].argv.slice(0, 3), ["queue", "--thread", SID]);
  assert.match(queues[0].argv[4], new RegExp(`session: ${SID}`));
  assert.match(e.find((x) => "inbox_out" in x)!.inbox_out, /BLTOK-open-writer/);
  assert.equal(f.copies(s.id)[0].state, "shown");
  assert.ok(f.ackLog.some((x) => x.member === mR.id && x.woken), "the open chat's own read after the nudge is its idle wake");
  assert.match(w.out(), /active writer/);
  assert.match(w.out(), /queued the wake into its open Codex chat/);
});
