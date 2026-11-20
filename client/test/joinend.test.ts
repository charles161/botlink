// Prod-readiness review, blocker 10: "waits that end in nothing". A join request lasts 15 minutes, its chat invite 24
// hours, yet a request that ran out told the chat to get "a fresh invite". A failed approval self-check dropped the
// chat's keys and left the card (or a member nobody holds) on the person's dashboard. `join --wait` waited 540 s by
// default, past the ~120 s most apps give a command. And a different chat of the same app in another folder that
// wanted a name this computer already held was told "don't pick another name".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { tools } from "../src/mcp.js";
import { main, joinWaitMaxMs } from "../src/cli.js";
import { FakeServer } from "./fake-server.js";
import { assertCopy, assertIsolated, newHome, on, startFake } from "./helpers.js";

let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

let n = 0;
const S = () => `44444444-aaaa-4bbb-8ccc-${String(++n).padStart(12, "0")}`;
async function people(label: string) {
  const adam = await f.account("Adam");
  const eve = await f.account("Eve");
  const room = await f.room(adam, `${label}${Math.floor(Math.random() * 1e6)}`, "p");
  f.addPerson(room, adam, eve);
  return { adam, eve, room, invite: `http://localhost:8811/i/${f.invite(room, adam)}` };
}
const args = (invite: string, cwd: string, session: string | null, name = "cc") => ({ invite, name, job: "answers", app: "claude-code" as st.App, turn: "on_turn" as st.Turn, session, cwd, folder: "~", machine: "m" });
const runOut = (id: string) => f.joins.get(id)!.expires = Date.now() - 1000; // the 15 minutes passed
const keyGone = (keyId: string) => !existsSync(join(process.env.BOTLINK_HOME!, "keys", `${keyId}.json`));

// ------------------------------------------------------------------ (1) how long, and what to do when it ran out
test("the first answer tells the human how long they have to approve, in plain words", async () => {
  const { invite } = await people("howlong");
  const h = newHome("howlong");
  await on(h, async () => {
    const r = await core.joinCreate(args(invite, h, S()));
    assert.match(r.text, /Adam has 15 minutes to approve this \(until \d\d:\d\d UTC\)\./);
    const t = tools({ app: "claude-code", session: () => "44444444-aaaa-4bbb-8ccc-0000000000ff" });
    const out = await t.join({ invite, name: "cc2", job: "answers" });
    assert.match(out, /Adam has 15 minutes to approve this/);
  });
});

test("ran out, invite still works: join again with the same invite and the same name; no new invite needed", async () => {
  const { invite } = await people("stillworks");
  const h = newHome("stillworks");
  await on(h, async () => {
    const s = S();
    const r = await core.joinCreate(args(invite, h, s));
    runOut(r.req.id);
    const w = await core.joinWait({ maxMs: 2000, app: "claude-code", session: s, cwd: h });
    assert.equal(w.status, "expired");
    assert.match(w.text, /The request to join as cc expired: Adam didn't approve it within 15 minutes\. Nothing was joined\./);
    assert.match(w.text, /The invite still works \(until \d\d:\d\d UTC/);
    assert.match(w.text, /join again with the same invite and the same name, cc\. No new invite is needed\./);
    assert.doesNotMatch(w.text, /fresh invite/);
    assertCopy(w.text);
    // and doing exactly that works: a new request, a new code, no "name taken"
    const again = await core.joinCreate(args(invite, h, s));
    assert.ok(!again.resumed);
    assert.notEqual(again.req.id, r.req.id);
  });
});

test("how long the request lasted is the server's own number, never this computer's clock (2 minutes on staging, a clock 40 s off)", async () => {
  const { invite } = await people("skew");
  const realNow = Date.now;
  try {
    for (const [ttl, skew, says] of [[120_000, 40_000, "within 2 minutes"], [120_000, -40_000, "within 2 minutes"], [60_000, 25_000, "within 1 minute"], [15 * 60_000, 45_000, "within 15 minutes"]] as const) {
      f.requestTtlMs = ttl;
      const h = newHome("skew");
      await on(h, async () => {
        const s = S();
        Date.now = () => realNow() + skew; // this computer's clock is off (less than the 60 s the server takes)
        const r = await core.joinCreate(args(invite, h, s));
        f.joins.get(r.req.id)!.expires = realNow() - 1000; // its time passed, on the server's clock
        const w = await core.joinWait({ maxMs: 2000, app: "claude-code", session: s, cwd: h });
        Date.now = realNow;
        assert.equal(w.status, "expired");
        assert.ok(w.text.includes(`didn't approve it ${says}. Nothing was joined.`), `ttl ${ttl} ms, clock ${skew} ms off: ${w.text}`);
        assert.doesNotMatch(w.text, /\b1 minutes\b/);
      });
    }
  } finally {
    Date.now = realNow;
    f.requestTtlMs = 15 * 60_000;
  }
});

test("ran out, and the invite was turned off: says so, and what the human does", async () => {
  const { adam, room, invite } = await people("off");
  const h = newHome("off");
  await on(h, async () => {
    const s = S();
    const r = await core.joinCreate(args(invite, h, s));
    f.inviteRow(room, adam)!.off = true;
    runOut(r.req.id);
    const w = await core.joinWait({ maxMs: 2000, app: "claude-code", session: s, cwd: h });
    assert.equal(w.status, "expired");
    assert.match(w.text, /Adam turned the invite off\. Ask your human to turn it on again on the room page, or for a fresh invite, then join again as cc\./);
    assert.doesNotMatch(w.text, /still works/);
  });
});

test("ran out, and the room was deleted or the inviter left (invite state closed): the invite no longer lets a chat in; ask your human", async () => {
  const { room, invite } = await people("closed");
  const h = newHome("closed");
  await on(h, async () => {
    const s = S();
    const r = await core.joinCreate(args(invite, h, s));
    f.closedRooms.add(room.id);
    runOut(r.req.id);
    const w = await core.joinWait({ maxMs: 2000, app: "claude-code", session: s, cwd: h });
    assert.equal(w.status, "expired");
    assert.match(w.text, /^The request to join as cc expired: Adam didn't approve it within 15 minutes\. Nothing was joined\./);
    assert.match(w.text, /The invite no longer lets a chat in: the room was deleted, or Adam is no longer in it\. Ask your human\.$/);
    assert.doesNotMatch(w.text, /still works|join again/);
    assertCopy(w.text);
  });
});

test("cancelled on the server (the room, its member or the person's place changed): says so, then what the invite allows", async () => {
  const { invite } = await people("cancelled");
  const h = newHome("cancelled");
  await on(h, async () => {
    const s = S();
    const r = await core.joinCreate(args(invite, h, s));
    f.joins.get(r.req.id)!.status = "cancelled";
    f.ring();
    const w = await core.joinWait({ maxMs: 2000, app: "claude-code", session: s, cwd: h });
    assert.equal(w.status, "expired");
    assert.match(w.text, /^The request to join as cc was cancelled on the server \(the room, its member or the person's place in it changed\)\. Nothing was joined\./);
    assert.match(w.text, /The invite still works .*So join again with the same invite and the same name, cc\. No new invite is needed\./);
    assert.doesNotMatch(w.text, /expired:/);
    assertCopy(w.text);
  });
});

test("ran out, and the invite was renewed since: the old link no longer works; ask for the new one", async () => {
  const { adam, room, invite } = await people("renewed");
  const h = newHome("renewed");
  await on(h, async () => {
    const s = S();
    const r = await core.joinCreate(args(invite, h, s));
    f.renewInvite(room, adam);
    runOut(r.req.id);
    const w = await core.joinWait({ maxMs: 2000, app: "claude-code", session: s, cwd: h });
    assert.match(w.text, /The invite was renewed since, so this link no longer works\. Ask your human for the new link \(the room page shows it\), then join again as cc\./);
    assert.doesNotMatch(w.text, /still works/);
  });
});

test("ran out, and the invite itself ran out too: a fresh invite is what is needed", async () => {
  const { adam, room, invite } = await people("inviteexp");
  const h = newHome("inviteexp");
  await on(h, async () => {
    const s = S();
    const r = await core.joinCreate(args(invite, h, s));
    f.inviteRow(room, adam)!.expires = Date.now() - 1000;
    runOut(r.req.id);
    const w = await core.joinWait({ maxMs: 2000, app: "claude-code", session: s, cwd: h });
    assert.match(w.text, /The invite has run out too \(an invite lasts 24 hours\)\. Ask your human for a fresh invite \(Renew on the room page\), then join again as cc\./);
  });
});

test("ran out on a server from before the invite state: the client asks for its own invite code", async () => {
  const { invite } = await people("oldsrv");
  const h = newHome("oldsrv");
  f.noInviteState = true;
  try {
    await on(h, async () => {
      const s = S();
      const r = await core.joinCreate(args(invite, h, s));
      runOut(r.req.id);
      const w = await core.joinWait({ maxMs: 2000, app: "claude-code", session: s, cwd: h });
      assert.match(w.text, /The invite still works/);
    });
  } finally {
    f.noInviteState = false;
  }
});

// ------------------------------------------------------------------ (2) a failed self-check takes the request back
test("self-check fails while pending (the addressee changed twice): the request is withdrawn, the card is gone, the chat is told plainly", async () => {
  const charles = await f.account("Charles");
  const victor = await f.account("Victor");
  const eve = await f.account("Eve");
  const room = await f.room(charles, `twice${Math.floor(Math.random() * 1e6)}`);
  f.addPerson(room, charles, victor);
  f.addPerson(room, charles, eve);
  const h = newHome("withdraw");
  await on(h, async () => {
    const s = S();
    const r = await core.joinCreate(args(`http://localhost:8811/i/${f.invite(room, charles)}`, h, s, "v4"));
    f.readdress(r.req.id, victor);
    assert.equal((await core.joinWait({ maxMs: 1200, app: "claude-code", session: s, cwd: h })).status, "pending");
    f.joins.get(r.req.id)!.account = eve.id; // a server that moves it again
    f.ring();
    const w = await core.joinWait({ maxMs: 1200, app: "claude-code", session: s, cwd: h });
    assert.equal(w.status, "mismatch");
    assert.equal(f.joins.get(r.req.id)!.status, "cancelled", "the request was taken back on the server");
    assert.equal(f.pending().filter((j) => j.id === r.req.id).length, 0, "no card is left on the dashboard");
    assert.ok(keyGone(r.req.key_id));
    assert.match(w.text, /^bot-link stopped waiting: the server's answer for this request no longer matches this chat's key or the person whose invite it used\./);
    assert.match(w.text, /Nothing was joined/);
    assert.match(w.text, /bot-link withdrew the request for v4, so its card is gone from the dashboard\./);
    assert.match(w.text, /Tell your human, in these words: "bot-link refused/);
    assert.match(w.text, /Don't join again, and don't try another name, until your human has looked at it\./);
    assertCopy(w.text);
  });
});

test("self-check fails after approval, the member has this chat's key: it leaves by its own key, so no member nobody holds stays", async () => {
  const { eve, room, invite } = await people("leave");
  const h = newHome("leave");
  await on(h, async () => {
    const s = S();
    const r = await core.joinCreate(args(invite, h, s, "victim"));
    // the server keeps telling the chat "Adam", while Eve's browser signs member_add {account: Eve}
    const m = f.approve(r.req.id, { asAccount: eve });
    const w = await core.joinWait({ maxMs: 3000, app: "claude-code", session: s, cwd: h });
    assert.equal(w.status, "mismatch");
    assert.match(w.text, /^This approval does not match this chat's key, so bot-link did not use it\./);
    assert.equal(f.members.get(m.id)!.removed, true, "the member was taken out of the room");
    const last = room.entries[room.entries.length - 1];
    assert.equal(JSON.parse(Buffer.from(last.entry, "base64url").toString()).op, "member_remove");
    assert.equal(last.signer, r.req.ed, "signed with this chat's own key (it leaves; nobody else's key is used)");
    assert.equal(st.liveMembers().length, 0);
    assert.ok(keyGone(r.req.key_id));
    assert.match(w.text, /Nothing was joined/);
    assert.match(w.text, /bot-link took victim out of #\S+ again, signed with this chat's key, so the room page shows that victim left\./);
    assertCopy(w.text);
  });
});

test("self-check fails and the server holds another key for the request: nothing to take back with this chat's key; the human is told what to remove", async () => {
  const { invite } = await people("swapped");
  const h = newHome("swapped");
  await on(h, async () => {
    const s = S();
    const r = await core.joinCreate(args(invite, h, s, "victim"));
    f.swapKeys(r.req.id);
    f.approve(r.req.id); // the browser signs whatever keys the server hands it
    const w = await core.joinWait({ maxMs: 3000, app: "claude-code", session: s, cwd: h });
    assert.equal(w.status, "mismatch");
    assert.equal(st.liveMembers().length, 0);
    assert.ok(keyGone(r.req.key_id));
    assert.match(w.text, /Nothing was joined/);
    assert.match(w.text, /bot-link could not take it back/);
    assert.ok(w.text.includes(`code ${r.req.match_code.slice(0, 3)}-${r.req.match_code.slice(3)}`), "names the card by its code");
    assert.match(w.text, /reject the request for victim .* on the dashboard, or remove victim on the room page if it was approved/);
  });
});

test("a server from before the cancel: the chat is told the card may still be there", async () => {
  const charles = await f.account("Charles");
  const victor = await f.account("Victor");
  const eve = await f.account("Eve");
  const room = await f.room(charles, `oldcancel${Math.floor(Math.random() * 1e6)}`);
  f.addPerson(room, charles, victor);
  f.addPerson(room, charles, eve);
  const h = newHome("oldcancel");
  f.noCancel = true;
  try {
    await on(h, async () => {
      const s = S();
      const r = await core.joinCreate(args(`http://localhost:8811/i/${f.invite(room, charles)}`, h, s, "v5"));
      f.readdress(r.req.id, victor);
      await core.joinWait({ maxMs: 1200, app: "claude-code", session: s, cwd: h });
      f.joins.get(r.req.id)!.account = eve.id;
      f.ring();
      const w = await core.joinWait({ maxMs: 1200, app: "claude-code", session: s, cwd: h });
      assert.equal(w.status, "mismatch");
      assert.match(w.text, /bot-link could not take it back/);
      assert.match(w.text, /Please reject the request for v5/);
    });
  } finally {
    f.noCancel = false;
  }
});

test("asking again with an earlier request whose key the server no longer holds: said loudly, not swapped for a new request", async () => {
  const { invite } = await people("again");
  const h = newHome("again");
  await on(h, async () => {
    const s = S();
    const r = await core.joinCreate(args(invite, h, s, "cc"));
    f.swapKeys(r.req.id);
    const before = f.joins.size;
    const again = await core.joinCreate(args(invite, h, s, "cc"));
    assert.equal(f.joins.size, before, "no second request");
    assert.ok(again.done && again.done.status === "mismatch", again.text);
    assert.match(again.text, /Nothing was joined/);
    assert.equal(st.allRequests().length, 0);
  });
});

// ------------------------------------------------------------------ (3) join --wait fits a command time limit
test("join --wait waits about 100 s by default (under the ~120 s most apps give a command); --max-s waits longer", () => {
  assert.equal(joinWaitMaxMs({ _: [] } as any), 100_000);
  assert.equal(joinWaitMaxMs({ _: [], "max-s": "300" } as any), 300_000);
});

test("a join --wait that ran out says exactly how to continue: the same request, nothing new sent", async () => {
  const { invite } = await people("cont");
  const h = newHome("cont");
  await on(h, async () => {
    const s = S();
    await core.joinCreate(args(invite, process.cwd(), s, "cc"));
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (c: any) => (chunks.push(String(c)), true);
    let code: number;
    try {
      code = await main(["join", "--wait", "--max-s", "1", "--app", "claude-code", "--session", s]);
    } finally {
      (process.stdout as any).write = write;
    }
    const text = chunks.join("");
    assert.equal(code, 3);
    assert.match(text, /Still waiting for Adam to approve cc/);
    assert.match(text, /This wait ended; the request still waits \(the same one: nothing new was sent\)\. To keep waiting, run `.*join --wait` again\./);
    assert.doesNotMatch(text, /9 minutes/);
  });
});

test("the join texts say ~100 s, not 9 minutes", async () => {
  assert.doesNotMatch(core.waitSameTurn("botlink join --wait"), /9 minutes/);
  assert.match(core.waitSameTurn("botlink join --wait"), /about 100 s/);
});

// ------------------------------------------------------------------ (4) name held from this computer: same folder or not
test("name held by a member of the same app in THIS folder (the chat whose session changed): don't pick another name", async () => {
  const { adam, room, invite } = await people("samefolder");
  const h = newHome("samefolder");
  await on(h, async () => {
    const s1 = S();
    const r = await core.joinCreate(args(invite, h, s1, "cc"));
    f.approve(r.req.id);
    assert.equal((await core.joinWait({ maxMs: 3000, app: "claude-code", session: s1, cwd: h })).status, "approved");
    f.renewInvite(room, adam); // a fresh link (the old request isn't the same invite any more)
    const fresh = `http://localhost:8811/i/${f.invite(room, adam)}`;
    await assert.rejects(core.joinCreate(args(fresh, h, S(), "cc")), (e: any) => {
      assert.match(e.message, /Don't pick another name/);
      return true;
    });
  });
});

test("name held by a member of the same app in ANOTHER folder: another chat; ask your human which name to use", async () => {
  const { invite } = await people("otherfolder");
  const h = newHome("otherfolder");
  const a = join(h, "proj-a"), b = join(h, "proj-b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  await on(h, async () => {
    const s1 = S();
    const r = await core.joinCreate(args(invite, a, s1, "cc"));
    f.approve(r.req.id);
    assert.equal((await core.joinWait({ maxMs: 3000, app: "claude-code", session: s1, cwd: a })).status, "approved");
    await assert.rejects(core.joinCreate(args(invite, b, S(), "cc")), (e: any) => {
      assert.ok(e instanceof core.UserError);
      assert.match(e.message, /The name "cc" in #otherfolder\d+ is taken by another Claude Code chat on this computer \(in another folder\)\. This chat needs its own name: ask your human which name to use \(for example "cc-2"\)\./);
      assert.doesNotMatch(e.message, /Don't pick another name/);
      return true;
    });
  });
});

test("name held by a waiting request of the same app in ANOTHER folder: the same answer", async () => {
  const { invite } = await people("otherreq");
  const h = newHome("otherreq");
  const a = join(h, "proj-a"), b = join(h, "proj-b");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  await on(h, async () => {
    await core.joinCreate(args(invite, a, S(), "cc"));
    await assert.rejects(core.joinCreate(args(invite, b, S(), "cc")), (e: any) => {
      assert.match(e.message, /is taken by another Claude Code chat on this computer \(in another folder\)/);
      assert.doesNotMatch(e.message, /Don't pick another name/);
      return true;
    });
  });
});

test("a bare wait that finds another of this chat's requests failing the check says so; it is not dropped quietly", async () => {
  const one = await people("roomone");
  const two = await people("roomtwo");
  const h = newHome("others");
  await on(h, async () => {
    const s = S();
    const a = await core.joinCreate(args(one.invite, h, s, "cc"));
    const b = await core.joinCreate(args(two.invite, h, s, "cc"));
    f.swapKeys(a.req.id); // the server no longer holds this chat's key for the first request
    const w = await core.joinWait({ maxMs: 1500, app: "claude-code", session: s, cwd: h });
    assert.equal(w.status, "mismatch", w.text);
    assert.match(w.text, new RegExp(`#${one.room.name}`));
    assert.match(w.text, /Nothing was joined/);
    assert.deepEqual(st.allRequests().map((r) => r.id), [b.req.id], "the other request still waits");
  });
});
