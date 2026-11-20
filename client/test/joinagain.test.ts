// Asking to join twice is asking once (FINDINGS F10, real Claude Code run 2026-11-11): a chat that calls join again
// with the same invite and name, while its request still waits, continues that request. Another chat never does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { tools } from "../src/mcp.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

const S = "22222222-aaaa-4bbb-8ccc-000000000001";
const S2 = "22222222-aaaa-4bbb-8ccc-000000000002";
async function room() {
  const adam = await f.account("Adam");
  const r = await f.room(adam, `again${Math.floor(Math.random() * 1e6)}`, "p");
  return `http://localhost:8811/i/${f.invite(r, adam)}`;
}
const args = (invite: string, home: string, session: string | null, name = "cc", app: st.App = "claude-code") => ({ invite, name, job: "answers", app, turn: "on_turn" as st.Turn, session, cwd: home, folder: "~", machine: "m" });

test("the same chat, invite and name: the second join is the first one (same id, key and code); it gets in", async () => {
  const inv = await room();
  const h = newHome("again1");
  await on(h, async () => {
    const a = await core.joinCreate(args(inv, h, S));
    assert.ok(!a.resumed);
    const b = await core.joinCreate(args(inv, h, S));
    assert.equal(b.resumed, true);
    assert.equal(b.req.id, a.req.id);
    assert.equal(b.req.fingerprint, a.req.fingerprint);
    assert.match(b.text, /this is the same request/);
    assert.ok(b.text.includes(a.req.match_code.slice(0, 3)), "the same code is shown again");
    assert.match(b.text, new RegExp(`/approve/${a.req.id}`));
    assert.equal(st.allRequests().length, 1, "one request on this computer, not two");
    f.approve(a.req.id);
    const w = await core.joinWait({ maxMs: 5000, app: "claude-code", session: S, cwd: h });
    assert.equal(w.status, "approved");
    // asking once more after it is in: told so, not "the name is taken"
    await assert.rejects(core.joinCreate(args(inv, h, S)), (e: any) => e instanceof core.AlreadyJoined && /already joined #again\d+ as cc/.test(e.message));
  });
});

test("the tools: join {invite, name, job} then join {wait: true, invite, name, job} waits for the same request", async () => {
  const inv = await room();
  const h = newHome("again2");
  await on(h, async () => {
    const t = tools({ app: "claude-code", session: () => S });
    const first = await t.join({ invite: inv, name: "cc", job: "answers" });
    assert.match(first, /call join again with only `wait: true`/);
    const id = st.allRequests()[0].id;
    f.approve(id);
    const second = await t.join({ wait: true, invite: inv, name: "cc", job: "answers" });
    assert.match(second, /Joined #again\d+ as cc/);
    assert.doesNotMatch(second, /already taken/);
    // and a third call, when it is in already, is an answer and not an error
    assert.match(await t.join({ invite: inv, name: "cc", job: "answers" }), /already joined/);
  });
});

test("another chat or another invite is a new request; the same chat under another name is told about its waiting one", async () => {
  const inv = await room();
  const h = newHome("again3");
  await on(h, async () => {
    const a = await core.joinCreate(args(inv, h, S));
    // the same app in the same folder under another session id, same invite and name: the same chat whose session id
    // changed (founder report 16 Nov 2026): it continues that request, never "try cc-2"
    const moved = await core.joinCreate(args(inv, h, S2));
    assert.equal(moved.resumed, true);
    assert.equal(moved.req.id, a.req.id);
    // the same chat, another name, while its first request waits: not a second, silent identity
    await assert.rejects(core.joinCreate(args(inv, h, S2, "cc-two")), (e: any) => e.message.includes(`/approve/${a.req.id}`) && /nothing new was sent for cc-two/.test(e.message));
    // the same chat and name, another room's invite: new
    const inv2 = await room();
    const d = await core.joinCreate(args(inv2, h, S2));
    assert.ok(!d.resumed);
    assert.notEqual(d.req.id, a.req.id);
    assert.equal(st.allRequests().length, 2);
  });
});
