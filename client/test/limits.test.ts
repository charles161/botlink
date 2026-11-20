/**
 * Fix-all CLIENTGLUE item 3: the server's new answers get one plain sentence each (what happened, what to do), and
 * the client behaves:
 *   - 503 high_load (a server copy at its cap on open waits, with retry_after_s): a long wait backs off for the time
 *     the server says (jittered, capped) and retries quietly: one calm line, never a failure line per retry
 *     (the client half of scale prep 2cab158, ported to today's client)
 *   - 409 storage_full / server_full / plan_limit (storage_mb) on send: not retried, the chat is told plainly that
 *     nothing was sent, and to tell its human where that helps
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as L from "../src/listen.js";
import * as W from "../src/watch.js";
import { tools } from "../src/mcp.js";
import { ApiError, highLoadDelayMs, HIGH_LOAD_MAX_MS } from "../src/api.js";
import { FakeServer } from "./fake-server.js";
import { assertCopy, assertIsolated, newHome, on, startFake } from "./helpers.js";

let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

let n = 0;
const S = () => `77777777-aaaa-4bbb-8ccc-${String(++n).padStart(12, "0")}`;
/** Adam's chat "cc" and Eve's chat "ev" in one room. */
async function pair(label: string) {
  const adam = await f.account("Adam");
  const eve = await f.account("Eve");
  const room = await f.room(adam, `${label}${Math.floor(Math.random() * 1e6)}`, "p");
  f.addPerson(room, adam, eve);
  const join = async (name: string, who: any) => {
    const h = newHome(`${label}-${name}`);
    const s = S();
    const m = await on(h, async () => {
      const r = await core.joinCreate({ invite: `http://localhost:8811/i/${f.invite(room, who)}`, name, job: "answers", app: "claude-code", turn: "on_turn", session: s, cwd: h, folder: "~", machine: "m" });
      f.approve(r.req.id);
      const w = await core.joinWait({ maxMs: 5000, app: "claude-code", session: s, cwd: h });
      return (w as any).member as st.MemberRec;
    });
    return { h, s, m };
  };
  return { a: await join("cc", adam), e: await join("ev", eve) };
}
const plainOne = (t: string) => {
  assertCopy(t);
  assert.doesNotMatch(t, /—/);
  assert.doesNotMatch(t, /Its words, quoted/, "our own sentence, not the server's words");
};

// ------------------------------------------------------------------ the sentences
test("explain: each new server answer is one plain sentence that says what happened and what to do", () => {
  const busy = core.explain(new ApiError(503, "high_load", "server text", null, 30));
  assert.match(busy, /busier than usual/);
  assert.match(busy, /messages are safe/);
  assert.match(busy, /30 s/);
  plainOne(busy);

  const full = core.explain(new ApiError(409, "storage_full", "server text", { limit: "storage_ceiling", value: 256 }));
  assert.match(full, /not sent/i);
  assert.match(full, /256 MB/);
  assert.match(full, /read|expire/);
  assert.match(full, /tell your human/i);
  plainOne(full);

  const srv = core.explain(new ApiError(409, "server_full", "server text"));
  assert.match(srv, /not sent/i);
  assert.match(srv, /server is full/);
  assert.match(srv, /later/);
  assert.match(srv, /tell your human/i);
  plainOne(srv);

  const plan = core.explain(new ApiError(409, "plan_limit", "server text", { limit: "storage_mb", value: 256 }));
  assert.match(plan, /not sent/i);
  assert.match(plan, /plan allows 256 MB/);
  assert.match(plan, /upgrade/);
  assert.match(plan, /tell your human/i);
  plainOne(plan);

  const members = core.explain(new ApiError(409, "plan_limit", "server text", { limit: "agents_per_room", value: 5 }));
  assert.match(members, /5 members, the most its plan allows/);
  assert.match(members, /human/);
  plainOne(members);

  // a limit this client does not know yet: still our sentence, not the server's words
  const other = core.explain(new ApiError(409, "plan_limit", "server text", { limit: "something_new", value: 3 }));
  assert.match(other, /plan/);
  plainOne(other);
});

test("high_load backoff: the server's Retry-After with up to 20 % jitter, never zero, capped", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 40; i++) {
    const d = highLoadDelayMs(new ApiError(503, "high_load", "x", null, 30))!;
    assert.ok(d >= 30_000 && d <= 36_000, `delay ${d}`);
    seen.add(d);
  }
  assert.ok(seen.size > 10, "jittered");
  assert.equal(highLoadDelayMs(new ApiError(503, "unavailable", "x", null, 2)), null);
  assert.ok(highLoadDelayMs(new ApiError(503, "high_load", "x", null, null))! >= 30_000, "no Retry-After: 30 s");
  assert.ok(highLoadDelayMs(new ApiError(503, "high_load", "x", null, 3600))! <= HIGH_LOAD_MAX_MS, "capped");
});

// ------------------------------------------------------------------ high_load on long waits
test("wait loop at the cap: backs off, says one calm line, then listens normally", async () => {
  const { a } = await pair("hlw");
  f.failNext = { path: /\/api\/v1\/me\/wait$/, status: 503, code: "high_load", times: 3 };
  f.log.length = 0;
  const lines: string[] = [];
  const t0 = Date.now();
  await on(a.h, () => W.listen([st.loadMember(a.m.id)!], { maxMs: 6000, say: (s) => lines.push(s) }));
  const waits = f.log.filter((l) => l.path === "/api/v1/me/wait");
  assert.equal(waits.filter((l) => l.status === 503).length, 3, JSON.stringify(waits));
  assert.ok(waits.some((l) => l.status === 200), "listened normally after the busy answers");
  assert.equal(lines.filter((l) => /busier than usual/.test(l)).length, 1, `one calm line, got: ${JSON.stringify(lines)}`);
  assert.ok(!lines.some((l) => /failed|error|can't reach/i.test(l)), JSON.stringify(lines));
  for (const l of lines) assertCopy(l);
  assert.ok(Date.now() - t0 >= 2000, "backed off between tries (Retry-After 1 s each)");
});

test("a listener at the cap: one calm line, no failure lines, keeps listening", async () => {
  const { a } = await pair("hll");
  f.failNext = { path: /\/api\/v1\/me\/wait$/, status: 503, code: "high_load", times: 3 };
  const lines: string[] = [];
  const code = await on(a.h, () => L.listenOnMessage(st.loadMember(a.m.id)!, "true", { say: (s) => lines.push(s), maxMs: 6000, restartWhen: () => false }));
  assert.equal(code, 0);
  assert.equal(f.failNext?.times, 0, "the busy answers were used up");
  assert.ok(!lines.some((l) => /wait failed/.test(l)), JSON.stringify(lines));
});

test("watch at the cap: no failure line per retry", async () => {
  const { a } = await pair("hlwatch");
  await on(a.h, async () => {
    const m = st.loadMember(a.m.id)!;
    m.turn = "wake";
    st.saveMember(m);
    f.failNext = { path: /\/api\/v1\/me\/wait$/, status: 503, code: "high_load", times: 3 };
    const lines: string[] = [];
    const w = new W.Watcher({ say: (s) => lines.push(s), tickMs: 100, runForMs: 6000 });
    await w.run();
    assert.equal(f.failNext?.times, 0, "the busy answers were used up");
    assert.ok(!lines.some((l) => /wait failed/.test(l)), JSON.stringify(lines));
  });
});

test("the wait tool when the server is busy the whole time: a calm line that says nothing is listening yet", async () => {
  const { a } = await pair("hltool");
  f.failNext = { path: /\/api\/v1\/me\/wait$/, status: 503, code: "high_load", times: 1000 };
  try {
    const t = tools({ app: "claude-code", session: () => a.s });
    const e = await on(a.h, () => t.wait({ max_s: 3 }).then(() => null, (x) => x));
    assert.ok(e, "an error: the wait never started");
    const msg = core.explain(e);
    assert.match(msg, /busier than usual/);
    assert.match(msg, /nothing is listening yet/);
    assertCopy(msg);
  } finally {
    f.failNext = null;
  }
});

// ------------------------------------------------------------------ storage refusals on send
for (const c of [
  { code: "storage_full", details: { limit: "storage_ceiling", value: 256 }, says: /256 MB/ },
  { code: "server_full", details: undefined, says: /server is full/ },
  { code: "plan_limit", details: { limit: "storage_mb", value: 256 }, says: /plan allows 256 MB/ },
]) {
  test(`send refused with ${c.code}: not retried, the chat is told nothing was sent and what to do`, async () => {
    const { a } = await pair(`sf${c.code.slice(0, 4)}`);
    f.failNext = { path: /\/api\/v1\/messages$/, status: 409, code: c.code, times: 5, message: "server text", ...(c.details ? { details: c.details } : {}) };
    f.log.length = 0;
    try {
      const t = tools({ app: "claude-code", session: () => a.s });
      const e = await on(a.h, () => t.send({ to: "ev", text: "the build is green", intent: "fyi" }).then(() => null, (x) => x));
      assert.ok(e, "the send failed");
      const posts = f.log.filter((l) => l.method === "POST" && l.path === "/api/v1/messages");
      assert.equal(posts.length, 1, `not retried: ${JSON.stringify(posts)}`);
      const msg = core.explain(e);
      assert.match(msg, /not sent/i);
      assert.match(msg, c.says);
      assert.match(msg, /tell your human/i);
      plainOne(msg);
    } finally {
      f.failNext = null;
    }
  });
}
