/**
 * Fix-all CLIENTGLUE item 8 (live finding, prod 16 Nov 2026: POST /api/v1/me/wait answered 403 about every 10 s, 457
 * times in a few hours): an answer that means "this member is gone or not yours" (410, 403, 401 unknown_key or
 * bad_signature) is final. The loop stops, the member record is marked (not deleted) with the reason, the chat is
 * told once and `botlink status` says it, and a listener for that member stops instead of being started again.
 * Lanes RECOVER (remove a browser) and ACCOUNT (delete an account) remove members in normal use.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as L from "../src/listen.js";
import * as W from "../src/watch.js";
import { ApiError } from "../src/api.js";
import { endMember } from "../src/memberend.js";
import { tools } from "../src/mcp.js";
import { FakeServer } from "./fake-server.js";
import { assertCopy, assertIsolated, newHome, on, startFake } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

let n = 0;
const S = () => `99999999-aaaa-4bbb-8ccc-${String(++n).padStart(12, "0")}`;
async function member(label: string) {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `${label}${Math.floor(Math.random() * 1e6)}`, "p");
  const h = newHome(label);
  const s = S();
  const m = await on(h, async () => {
    const r = await core.joinCreate({ invite: `http://localhost:8811/i/${f.invite(room, adam)}`, name: "cc", job: "answers", app: "claude-code", turn: "on_turn", session: s, cwd: h, folder: "~", machine: "m" });
    f.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 5000, app: "claude-code", session: s, cwd: h });
    return (w as any).member as st.MemberRec;
  });
  return { adam, h, s, m };
}
const waits = (from: number) => f.log.slice(from).filter((l) => l.path === "/api/v1/me/wait");
const statusOut = (h: string) => spawnSync(process.execPath, [CLI, "status"], { encoding: "utf-8", env: { ...process.env, HOME: h, BOTLINK_HOME: join(h, ".botlink"), BOTLINK_SERVER: f.url }, timeout: 60_000 }).stdout;

test("removed while a listener waits: it stops for good, is not started again, the record says why, the chat is told once", async () => {
  const { adam, h, s, m } = await member("rmlisten");
  await on(h, async () => {
    L.recordWakePath(m.id, { kind: "detached", command: "true", at: Date.now() }); // as --detach records it
    const lines: string[] = [];
    const run = L.listenOnMessage(st.loadMember(m.id)!, "true", { say: (x) => lines.push(x), maxMs: 30_000, restartWhen: () => false });
    await new Promise((r) => setTimeout(r, 800));
    const from = f.log.length;
    f.removeMember(m.id, adam);
    const code = await run;
    assert.equal(code, 4, "exit 4: final, the supervisor does not start it again");
    assert.ok(waits(from).length <= 1, `no polling after the final answer: ${JSON.stringify(waits(from))}`);
    // kept, marked with the reason (the human can see what happened)
    const rec = st.loadMember(m.id);
    assert.ok(rec, "the member record is kept");
    assert.equal(rec!.ended?.code, "gone");
    assert.equal(L.wakePathOf(m.id), null, "its wake path is forgotten");
    assert.deepEqual(await L.healWakePaths([rec!]), [], "nothing restarts it on the next call");
    assert.ok(lines.some((l) => /no longer a member of #\S+: it was removed from the room/.test(l)), JSON.stringify(lines));
    // the chat: told once, at its next call or turn
    const told = st.takeLost(s).map(st.lostText);
    assert.equal(told.length, 1);
    assert.match(told[0], /cc is no longer a member of #\S+: it was removed from the room\. Nothing is being received for it\./);
    assertCopy(told[0]);
    assert.equal(st.takeLost(s).length, 0, "once");
    // this chat no longer acts as it; a new loop never polls for it
    assert.deepEqual(core.heldBy(s, { app: "claude-code", folders: [h] }), []);
    const from2 = f.log.length;
    assert.equal(await W.listen(() => core.heldBy(s, { app: "claude-code", folders: [h] }), { maxMs: 1500, say: () => {} }), 1);
    assert.equal(waits(from2).length, 0);
  });
  const out = statusOut(h);
  assert.match(out, /cc is no longer a member of #\S+: it was removed from the room/);
});

test("a 403 for the member's waits is final too: a background wait stops at once instead of asking every few seconds", async () => {
  const { h, s, m } = await member("forbid");
  await on(h, async () => {
    const from = f.log.length;
    f.failNext = { path: /\/api\/v1\/me\/wait$/, status: 403, code: "not_holder", times: 1000 };
    try {
      const lines: string[] = [];
      const rc = await W.listen([st.loadMember(m.id)!], { maxMs: 8000, say: (x) => lines.push(x) });
      assert.equal(rc, 4);
      assert.equal(waits(from).length, 1, JSON.stringify(waits(from)));
      assert.equal(st.loadMember(m.id)?.ended?.code, "not_holder");
      assert.ok(lines.some((l) => /another chat holds it now/.test(l)), JSON.stringify(lines));
    } finally {
      f.failNext = null;
    }
    void s;
  });
});

test("watch: a final answer stops waking that member; a 5xx keeps trying with a growing pause", async () => {
  const { adam, h, m } = await member("rmwatch");
  await on(h, async () => {
    const rec = st.loadMember(m.id)!;
    rec.turn = "wake";
    st.saveMember(rec);
    // 5xx: retried, with pauses that grow (not a fixed 5-10 s)
    f.failNext = { path: /\/api\/v1\/me\/wait$/, status: 502, code: "bad_gateway", times: 1000 };
    let from = f.log.length;
    const w1 = new W.Watcher({ say: () => {}, tickMs: 100, runForMs: 9000 });
    await w1.run();
    f.failNext = null;
    const tries = waits(from).length;
    assert.ok(tries >= 3 && tries <= 5, `growing pause from 2 s: ${tries} tries in 9 s`);
    // removed: final
    f.removeMember(m.id, adam);
    from = f.log.length;
    const w2 = new W.Watcher({ say: () => {}, tickMs: 100, runForMs: 4000 });
    await w2.run();
    assert.equal(waits(from).length, 1, JSON.stringify(waits(from)));
    assert.equal(st.loadMember(m.id)?.ended?.code, "gone");
    assert.equal(new W.Watcher({ say: () => {} }).candidates().length, 0);
  });
});

// ------------------------------------------------------------------ only bot-link's own answer is final (overseer review)
test("an HTML 403 (a proxy, a firewall, a sign-in page) is not final: the member stays, the loop keeps trying, the chat is told once after a while", async () => {
  const { h, s, m } = await member("html403");
  await on(h, async () => {
    L.recordWakePath(m.id, { kind: "detached", command: "true", at: Date.now() });
    const from = f.log.length;
    f.fault = { path: /\/api\/v1\/me\/wait$/, kind: "403", times: 1000 };
    try {
      const lines: string[] = [];
      const code = await L.listenOnMessage(st.loadMember(m.id)!, "true", { say: (x) => lines.push(x), maxMs: 7000, restartWhen: () => false });
      assert.equal(code, 0, "ran until its time was up: never stopped as if removed");
      assert.ok(waits(from).length >= 2, `kept trying: ${waits(from).length}`);
      assert.equal(st.loadMember(m.id)?.ended ?? null, null, "not marked ended");
      assert.ok(L.wakePathOf(m.id), "its wake path is kept");
      const told = st.takeLost(s).map(st.lostText);
      assert.equal(told.length, 1, JSON.stringify(told));
      assert.match(told[0], /Something between this computer and bot-link's server is refusing its requests \(status 403\)/);
      assert.match(told[0], /cc is still a member/);
      assertCopy(told[0]);
    } finally {
      f.fault = null;
    }
  }, { BOTLINK_REFUSED_TELL_MS: "1500" });
});

test("a JSON 403 with a code bot-link's server never sends, and an HTML 410, are not final", async () => {
  const { h, m } = await member("unknown403");
  await on(h, async () => {
    f.failNext = { path: /\/api\/v1\/me\/wait$/, status: 403, code: "cf_blocked", times: 1000 };
    try {
      assert.equal(await W.listen([st.loadMember(m.id)!], { maxMs: 2500, say: () => {} }), 3);
    } finally {
      f.failNext = null;
    }
    assert.equal(st.loadMember(m.id)?.ended ?? null, null, "unknown code: not ended");
    f.fault = { path: /\/api\/v1\/me\/wait$/, kind: "410", times: 1000 };
    try {
      assert.equal(await W.listen([st.loadMember(m.id)!], { maxMs: 2500, say: () => {} }), 3);
    } finally {
      f.fault = null;
    }
    assert.equal(st.loadMember(m.id)?.ended ?? null, null, "HTML 410: not ended");
    // an HTML 403 on the read a hook makes is a missed read, never text for the model
    f.fault = { path: /\/api\/v1\/me\/inbox\/lease$/, kind: "403", times: 1 };
    try {
      const b = await core.takeBatch([st.loadMember(m.id)!], st.loadMember(m.id)!.holder_session);
      assert.equal(b.failed, 1);
      assert.equal(b.text, "");
    } finally {
      f.fault = null;
    }
  });
});

test("a wrong clock never ends a member: the client corrects for it, and the sentence says the clock is off", async () => {
  const { h, m } = await member("clock");
  await on(h, async () => {
    f.clockSkewS = 7200; // the server's clock is two hours ahead of this computer's (it answers stale_timestamp + server_time)
    try {
      const from = f.log.length;
      assert.equal(await W.listen([st.loadMember(m.id)!], { maxMs: 2500, say: () => {} }), 3);
      assert.ok(f.log.slice(from).some((l) => l.path === "/api/v1/me/wait" && l.status === 200), "it corrected and waited");
      assert.equal(st.loadMember(m.id)?.ended ?? null, null);
    } finally {
      f.clockSkewS = 0;
      st.saveConfig({ ...st.loadConfig(), clock_offset_s: 0 });
    }
  });
  const t = core.explain(new ApiError(401, "stale_timestamp", "The request time is too far from the server's clock.", null, null, Math.floor(Date.now() / 1000) + 7200));
  assert.match(t, /This computer's clock is off by about 2 hours/);
  assert.doesNotMatch(t, /no longer a member|removed/);
  assertCopy(t);
});

test("a wrong 'ended' mark is undone by the next inbox or status: the server still takes the key, so the member is back with its wake path", async () => {
  const { h, s, m } = await member("revive");
  await on(h, async () => {
    L.recordWakePath(m.id, { kind: "once", at: Date.now() });
    const fake = new ApiError(410, "gone", "This member was removed from the room.", null, null, null, true);
    assert.ok(endMember(st.loadMember(m.id)!, fake));
    assert.ok(st.loadMember(m.id)!.ended);
    assert.equal(L.wakePathOf(m.id), null);
    st.takeLost(s); // the "no longer a member" line was said
    const out = await tools({ app: "claude-code", session: () => s }).inbox({});
    assert.match(out, /cc in #\S+ is back: bot-link's server still accepts this chat as cc/);
    assert.equal(st.loadMember(m.id)!.ended ?? null, null, "the mark is cleared");
    assert.equal(L.wakePathOf(m.id)?.kind, "once", "the wake path is as it was");
    assert.equal(core.heldBy(s, { app: "claude-code", folders: [h] }).length, 1);
    // a member that really is gone stays ended: one look, no change
    const t2 = await member("revive2");
    await on(t2.h, async () => {
      f.removeMember(t2.m.id, t2.adam);
      endMember(st.loadMember(t2.m.id)!, fake);
      const from = f.log.length;
      const st2 = await tools({ app: "claude-code", session: () => t2.s }).status({});
      assert.match(st2, /not a bot-link member here/);
      assert.ok(st.loadMember(t2.m.id)!.ended);
      assert.ok(f.log.slice(from).length <= 2, JSON.stringify(f.log.slice(from)));
    });
  });
});

// fix-all review (16 Nov 2026): every bot-link process saves member records from copies it loaded earlier (a roster
// refresh saves the whole copy, core.ts acceptRoster). A copy loaded before the member ended must never wipe the mark,
// or a removed member shows as someone else's chat again and its loops start polling. The bad order, forced:
test("a stale copy saved after the member ended keeps the 'ended' mark (only revive clears it)", async () => {
  const { h, m } = await member("stale");
  await on(h, async () => {
    const stale = st.loadMember(m.id)!; // e.g. the MCP server's copy, loaded before the final answer
    const fake = new ApiError(410, "gone", "This member was removed from the room.", null, null, null, true);
    assert.ok(endMember(st.loadMember(m.id)!, fake));
    stale.pin = { ...stale.pin }; // what a roster refresh changes, then saves the whole copy
    st.saveMember(stale);
    assert.equal(st.loadMember(m.id)!.ended?.code, "gone", "the stale save lost the mark");
    assert.deepEqual(core.heldBy(stale.holder_session, { app: "claude-code", folders: [h] }), []);
  });
});
