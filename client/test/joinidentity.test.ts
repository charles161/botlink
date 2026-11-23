// Charles, 16 Nov 2026 (twice, two apps): "I got 'X is trying to join' and approved. But the agent then tried Y and was
// waiting there, and I never got it as a request to join. I had to remove the old one and tell it to ask again."
// A chat's approved identity is the one it uses. A second identity for the same room is never made behind the human's
// back, and a wait never sits on one request while the human approved another.
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

const S = "33333333-aaaa-4bbb-8ccc-000000000001";
const S2 = "33333333-aaaa-4bbb-8ccc-000000000002";
async function room(label = "ident") {
  const adam = await f.account("Adam");
  const r = await f.room(adam, `${label}${Math.floor(Math.random() * 1e6)}`, "p");
  return `http://localhost:8811/i/${f.invite(r, adam)}`;
}
const args = (invite: string, home: string, session: string | null, name = "cc", app: st.App = "claude-code") => ({ invite, name, job: "answers", app, turn: "on_turn" as st.Turn, session, cwd: home, folder: "~", machine: "m" });
const pendingCards = () => [...f.joins.values()].filter((j) => j.status === "pending");

test("approved as X, the chat then asks again as Y: it becomes X (what the human approved); no request for Y is made", async () => {
  const inv = await room();
  const h = newHome("ident1");
  await on(h, async () => {
    const x = await core.joinCreate(args(inv, h, S, "cc"));
    f.approve(x.req.id); // the human approves X on the dashboard while the chat isn't waiting
    const before = f.joins.size;
    const y = await core.joinCreate(args(inv, h, S, "cc-two"));
    assert.equal(f.joins.size, before, "no second request reached the server");
    assert.ok(y.done && y.done.status === "approved", `the approved request was finished: ${y.text}`);
    assert.match(y.text, /Joined #ident\d+ as cc\b/);
    assert.equal(st.liveMembers().length, 1);
    assert.equal(st.liveMembers()[0].name, "cc");
    assert.equal(st.allRequests().length, 0, "nothing left waiting on this computer");
  });
});

test("the tools: approved as X, then join {invite, name: Y, wait: true}: joins as X, never waits on Y", async () => {
  const inv = await room();
  const h = newHome("ident2");
  await on(h, async () => {
    const t = tools({ app: "claude-code", session: () => S });
    await t.join({ invite: inv, name: "cc", job: "answers" });
    f.approve(st.allRequests()[0].id);
    const out = await t.join({ invite: inv, name: "cc-two", job: "answers", wait: true });
    assert.match(out, /Joined #ident\d+ as cc\b/);
    assert.doesNotMatch(out, /Still waiting/);
    const code = inv.split("/i/")[1];
    assert.equal([...f.joins.values()].filter((j) => code.endsWith(j.body.invite) && j.body.name === "cc-two").length, 0, "no card for Y was made");
    assert.equal(pendingCards().filter((j) => code.endsWith(j.body.invite)).length, 0, "nothing is left waiting on the dashboard");
  });
});

test("X still waits, the chat asks as Y: refused out loud with X's code and link; nothing new is sent", async () => {
  const inv = await room();
  const h = newHome("ident3");
  await on(h, async () => {
    const x = await core.joinCreate(args(inv, h, S, "cc"));
    const before = f.joins.size;
    await assert.rejects(core.joinCreate(args(inv, h, S, "cc-two")), (e: any) => {
      assert.ok(e instanceof core.UserError);
      assert.match(e.message, /already asked to join #ident\d+ as cc\b/);
      assert.ok(e.message.includes(`/approve/${x.req.id}`), "names the waiting request's approve link");
      assert.ok(e.message.includes(x.req.match_code.slice(0, 3)), "and its code");
      return true;
    });
    assert.equal(f.joins.size, before);
  });
});

test("rejected X: asking again as Y makes a new, visible request", async () => {
  const inv = await room();
  const h = newHome("ident4");
  await on(h, async () => {
    const x = await core.joinCreate(args(inv, h, S, "cc"));
    f.reject(x.req.id);
    const y = await core.joinCreate(args(inv, h, S, "cc-two"));
    assert.ok(!y.done && !y.resumed);
    assert.equal(f.joins.get(y.req.id)?.status, "pending", "Y's card is on the dashboard");
    assert.match(y.text, /Waiting for Adam to approve/);
  });
});

test("a bare wait with two requests (rooms A and B): the human approved A, the wait finishes A instead of sitting on B", async () => {
  const a = await room("rooma");
  const b = await room("roomb");
  const h = newHome("ident5");
  await on(h, async () => {
    const ra = await core.joinCreate(args(a, h, S, "cc"));
    await core.joinCreate(args(b, h, S, "cc"));
    f.approve(ra.req.id);
    const w = await core.joinWait({ maxMs: 4000, app: "claude-code", session: S, cwd: h });
    assert.equal(w.status, "approved", w.text);
    assert.match(w.text, /Joined #rooma\d+ as cc/);
  });
});

test("still waiting says WHICH request: its name, room, approve link, code and when it expires", async () => {
  const inv = await room();
  const h = newHome("ident6");
  await on(h, async () => {
    const x = await core.joinCreate(args(inv, h, S, "cc"));
    const w = await core.joinWait({ maxMs: 1500, app: "claude-code", session: S, cwd: h });
    assert.equal(w.status, "pending");
    assert.match(w.text, /\bcc\b/);
    assert.match(w.text, /#ident\d+/);
    assert.ok(w.text.includes(`/approve/${x.req.id}`), w.text);
    assert.match(w.text, /expires/i);
  });
});

test("the name is held by this computer's request from another session: no 'try <other name>', it says whose it is", async () => {
  const inv = await room();
  const h = newHome("ident7");
  await on(h, async () => {
    const x = await core.joinCreate(args(inv, h, S, "cc"));
    f.approve(x.req.id);
    await assert.rejects(core.joinCreate(args(inv, h, S2, "cc")), (e: any) => {
      assert.doesNotMatch(e.message, /Try "cc-2"/);
      assert.match(e.message, /this computer/i);
      assert.match(e.message, /don't (pick|ask under) another name/i);
      return true;
    });
  });
});

test("the chat's session id changed between asking and waiting: asking again continues ITS request, moved to the new session; it gets in as X", async () => {
  const inv = await room();
  const h = newHome("ident8");
  await on(h, async () => {
    const x = await core.joinCreate(args(inv, h, S, "cc"));
    const again = await core.joinCreate(args(inv, h, S2, "cc"));
    assert.equal(again.resumed, true, again.text);
    assert.equal(again.req.id, x.req.id);
    assert.equal(st.loadRequest(x.req.id)?.session_id, S2, "the request now belongs to the session that asked again");
    assert.equal(f.joins.get(x.req.id)?.body.session_id, S2, "and so does the server's");
    f.approve(x.req.id);
    const w = await core.joinWait({ maxMs: 4000, app: "claude-code", session: S2, cwd: h });
    assert.equal(w.status, "approved", w.text);
    assert.equal(st.liveMembers()[0].holder_session, S2);
  });
});

test("another app in the same folder never continues the request (it is another chat)", async () => {
  const inv = await room();
  const h = newHome("ident9");
  await on(h, async () => {
    await core.joinCreate(args(inv, h, S, "cc"));
    // (founder bug 21 Nov 2026: a name held by a waiting request is said to wait, not to be "taken"; the request is
    // another app's, so this chat needs its own name)
    await assert.rejects(core.joinCreate(args(inv, h, S2, "cc", "codex")), /belongs to another app's chat on this computer \(Claude Code\), and its request is waiting for approval\. This chat is another chat: ask your human which name to use/);
  });
});
