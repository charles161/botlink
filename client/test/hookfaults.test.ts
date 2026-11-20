/**
 * Fix-all CLIENTGLUE item 7 (live finding, prod 16 Nov 2026: a chat woken 4 times while the tunnel dropped): a hook
 * never blocks, fails or wakes a chat because the server or the network is unwell. On a 5xx, a stalled answer, a
 * refused connection or an answer that is not JSON, every hook ends with exit 0 and nothing the app reads as
 * "continue" (Claude Code: exit 2 / Codex: {"decision":"block"} / Cursor: {"followup_message"}), within its own short
 * time limit; the miss is recorded once for `botlink status`; and what waited is shown by the next healthy run.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { hookDeadlineMs } from "../src/hooks.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

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
  ms: number;
}
function hook(home: string, app: string, event: string, input: any, env: Record<string, string> = {}): Promise<Run> {
  const t0 = Date.now();
  const child = spawn(process.execPath, [CLI, "hook", app, event], { cwd: home, env: { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, BOTLINK_HOOK_DEADLINE_MS: "4000", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  child.stdin.end(JSON.stringify(input));
  return new Promise((res) => child.on("exit", (code) => res({ code, stdout, stderr, ms: Date.now() - t0 })));
}
const status = (home: string) => spawnSync(process.execPath, [CLI, "status"], { encoding: "utf-8", env: { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url }, timeout: 60_000 }).stdout;

let n = 0;
const sid = () => `88888888-1111-4222-8333-${String(++n).padStart(12, "0")}`;
/** a sender (Codex) and a receiving chat of `app`, one message waiting for the receiver */
async function waiting(app: st.App, label: string) {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `${label}${Math.floor(Math.random() * 1e6)}`);
  const inv = f.invite(room, adam);
  const hS = newHome(`${label}-s`), hR = newHome(`${label}-r`);
  const sS = sid(), sR = sid();
  const j = (h: string, name: string, a: st.App, s: string) =>
    on(h, async () => {
      if (a === "cursor") process.env.CURSOR_CONVERSATION_ID = s;
      try {
        const r = await core.joinCreate({ invite: inv, name, job: "", app: a, turn: "on_turn", session: a === "cursor" ? null : s, cwd: h, folder: "~", machine: "m" });
        f.approve(r.req.id);
        return ((await core.joinWait({ maxMs: 3000 })) as any).member as st.MemberRec;
      } finally {
        delete process.env.CURSOR_CONVERSATION_ID;
      }
    });
  const mS = await j(hS, "snd", "codex", sS);
  const mR = await j(hR, "rcv", app, sR);
  const send = (text: string) => on(hS, () => core.send(st.loadMember(mS.id)!, { to: "rcv", text, intent: "question" }, sS));
  return { hR, sR, mR, send };
}
const stopInput = (app: string, h: string, s: string) => (app === "cursor" ? { conversation_id: s, workspace_roots: [h], status: "completed" } : { session_id: s, cwd: h, hook_event_name: "Stop" });

test("the hooks' own time limits sit under the time each app gives them", () => {
  delete process.env.BOTLINK_HOOK_DEADLINE_MS;
  // the timeouts setup writes (harnesses.ts): Claude Code session-start 30 s, prompt 25 s; Codex 30 s; Cursor 15 s
  assert.ok(hookDeadlineMs("claude-code", "session-start") <= 20_000);
  assert.ok(hookDeadlineMs("claude-code", "prompt") <= 15_000);
  assert.ok(hookDeadlineMs("codex", "stop") <= 10_000);
  assert.ok(hookDeadlineMs("codex", "session-start") <= 20_000);
  assert.ok(hookDeadlineMs("cursor", "stop") <= 8_000);
  assert.ok(hookDeadlineMs("cursor", "session-start") <= 8_000);
});

for (const app of ["codex", "cursor"] as const) {
  test(`${app} Stop hook: 502, 503, refused, stalled, not JSON -> the stop is allowed (exit 0, no output), in its own time; the next healthy run nudges`, async () => {
    const { hR, sR, mR, send } = await waiting(app, `hf${app.slice(0, 2)}`);
    await send("BLTOK-hookfault waiting");
    const input = stopInput(app, hR, sR);
    for (const kind of ["502", "503", "stall", "garbage"] as const) {
      f.fault = { path: /\/api\/v1\/me\/inbox\/count$/, kind, times: 50 };
      const r = await hook(hR, app, "stop", input).finally(() => (f.fault = null));
      assert.equal(r.code, 0, `${kind}: ${r.stderr}`);
      assert.equal(r.stdout.trim(), "", `${kind}: nothing the app reads as "continue"`);
      assert.ok(r.ms < 12_000, `${kind}: ended in its own time (${r.ms} ms)`);
    }
    // connection refused
    await on(hR, () => {
      const m = st.loadMember(mR.id)!;
      m.server = "http://127.0.0.1:1";
      st.saveMember(m);
    });
    const refused = await hook(hR, app, "stop", input);
    assert.equal(refused.code, 0);
    assert.equal(refused.stdout.trim(), "");
    await on(hR, () => {
      const m = st.loadMember(mR.id)!;
      m.server = f.url;
      st.saveMember(m);
    });
    // `botlink status` says it once, with the time
    const s1 = status(hR);
    assert.equal(s1.match(/could not be reached at \d\d:\d\d UTC/g)?.length, 1, s1);
    // healthy again: the waiting message is not lost
    const ok = await hook(hR, app, "stop", input);
    assert.equal(ok.code, 0);
    assert.deepEqual(JSON.parse(ok.stdout), app === "cursor" ? { followup_message: "You have 1 new bot-link message. Call the bot-link inbox tool." } : { decision: "block", reason: "You have 1 new bot-link message. Call the bot-link inbox tool." });
    assert.doesNotMatch(status(hR), /could not be reached/, "a good run since: nothing to say");
  });
}

test("Claude Code SessionStart and prompt hooks: a stalled or broken server ends the hook in its own time, exit 0, nothing wrong said; the next run shows the message", async () => {
  const { hR, sR, send } = await waiting("claude-code", "hfss");
  await send("BLTOK-hookfault-cc waiting");
  for (const kind of ["stall", "502", "garbage"] as const) {
    for (const ev of ["session-start", "prompt"]) {
      f.fault = { path: /\/api\/v1\/me\/(inbox\/lease|roster)$/, kind, times: 50 };
      const r = await hook(hR, "claude-code", ev, { session_id: sR, cwd: hR, prompt: "hello", hook_event_name: ev === "prompt" ? "UserPromptSubmit" : "SessionStart" }).finally(() => (f.fault = null));
      assert.equal(r.code, 0, `${kind} ${ev}`);
      assert.ok(r.ms < 12_000, `${kind} ${ev}: ${r.ms} ms`);
      assert.doesNotMatch(r.stdout + r.stderr, /BLTOK|can't verify|don't trust|error/i, `${kind} ${ev}: ${r.stdout}`);
    }
  }
  const ok = await hook(hR, "claude-code", "session-start", { session_id: sR, cwd: hR, hook_event_name: "SessionStart", source: "startup" });
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, /BLTOK-hookfault-cc waiting/);
});

test("Claude Code Stop waiter: a 502 and an answer that is not JSON never wake the chat; the message that waited does, once the server is well", async () => {
  const { hR, sR, send } = await waiting("claude-code", "hfwt");
  const s = await send("BLTOK-hookfault-waiter");
  f.fault = { path: /\/api\/v1\/me\/inbox\/lease$/, kind: "502", times: 1 };
  // the lease works next, then the member list it needs comes back as HTML once
  const roster = { path: /\/api\/v1\/me\/roster$/, kind: "garbage" as const, times: 1 };
  const w = hook(hR, "claude-code", "stop", stopInput("claude-code", hR, sR));
  for (let i = 0; i < 100 && f.fault?.times; i++) await new Promise((r) => setTimeout(r, 50));
  f.fault = roster;
  const r = await w.finally(() => (f.fault = null));
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /BLTOK-hookfault-waiter/);
  assert.doesNotMatch(r.stderr, /can't verify|don't trust|error code/);
  assert.equal(f.copies(s.id)[0].state, "shown");
});

// Overseer, from the Claude Code hooks reference: a Stop hook continues the session only on exit 2, or JSON with
// `decision: "block"` or `hookSpecificOutput.additionalContext`; an asyncRewake hook wakes it only on exit 2; plain
// stdout of UserPromptSubmit and SessionStart goes into the model's context. So under every failure: never exit 2,
// nothing on stdout at all, and on a non-zero exit at most one short plain line on stderr.
test("every Claude Code hook under every failure: exit never 2, stdout empty, the failure is only in the local record", { timeout: 300_000 }, async () => {
  const { hR, sR, mR, send } = await waiting("claude-code", "hfmx");
  await send("BLTOK-hookfault-matrix waiting");
  const setServer = (url: string) => on(hR, () => {
    const m = st.loadMember(mR.id)!;
    m.server = url;
    st.saveMember(m);
  });
  const events: [string, any][] = [
    ["session-start", { session_id: sR, cwd: hR, hook_event_name: "SessionStart", source: "startup" }],
    ["prompt", { session_id: sR, cwd: hR, prompt: "hello there", hook_event_name: "UserPromptSubmit" }],
    ["stop", { session_id: sR, cwd: hR, hook_event_name: "Stop" }],
  ];
  for (const kind of ["502", "503", "403", "garbage", "refused", "stall"] as const) {
    for (const [ev, input] of events) {
      if (kind === "refused") await setServer("http://127.0.0.1:1");
      else f.fault = { path: /\/api\/v1\//, kind, times: 100_000 };
      // the Stop waiter is meant to wait in the background: give it a short life here (BOTLINK_WAIT_LIMIT_S)
      const r = await hook(hR, "claude-code", ev, input, { BOTLINK_WAIT_LIMIT_S: "3" }).finally(async () => {
        f.fault = null;
        if (kind === "refused") await setServer(f.url);
      });
      const what = `${kind} ${ev}`;
      assert.notEqual(r.code, 2, `${what}: exit 2 would wake or continue the chat: ${r.stderr}`);
      assert.equal(r.stdout, "", `${what}: nothing on stdout (no decision, continue or additionalContext): ${r.stdout}`);
      if (r.code !== 0) assert.ok(r.stderr.trim().split("\n").length === 1 && r.stderr.length < 200, `${what}: one short line: ${r.stderr}`);
      else assert.equal(r.stderr, "", `${what}: ${r.stderr}`);
    }
  }
  const s1 = status(hR);
  assert.equal(s1.match(/could not be reached at \d\d:\d\d UTC/g)?.length, 1, s1);
  // healthy again: the message that waited is shown by the next hook
  const ok = await hook(hR, "claude-code", "session-start", events[0][1]);
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, /BLTOK-hookfault-matrix waiting/);
});
