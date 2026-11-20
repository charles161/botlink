// Release finding (rc 90bf231): the approval self-check (ENVELOPE §5.4) must find this chat's member_add signed by a
// device of the account the INVITE belongs to. The client only checked "a device of the account the member entry
// names", so a misbehaving server together with another person of the room could admit a chat as that person's chat:
// the other person's browser signs a perfectly valid member_add (their own account, their own device) for this chat's
// keys, and the chat that used Adam's invite silently becomes Eve's chat.
//
// The client now remembers whose invite it used (the request view's approver_account, at create, before anyone can
// approve) and requires the member's account to be that one. The only accepted change is security review item 11's
// self-heal: one takeover of a pending join by another person, which the chat sees and says out loud.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

// (blocker 10: the text goes on with what was taken back and what to tell the human; joinend.test.ts)
const MISMATCH = /^This approval does not match this chat's key, so bot-link did not use it\. Nothing was joined/;
let n = 0;
const roomName = (p: string) => `${p}${++n}${Math.floor(Math.random() * 1e5)}`;
const create = (invite: string, name: string, h: string) =>
  core.joinCreate({ invite, name, job: `job of ${name}`, app: "codex", turn: "on_turn", session: `sess-${name}-${n}`, cwd: h, folder: "~", machine: "m" });
const wait = (name: string) => core.joinWait({ maxMs: 3000, app: "codex", session: `sess-${name}-${n}`, cwd: undefined });
const keyGone = (keyId: string) => !existsSync(join(process.env.BOTLINK_HOME!, "keys", `${keyId}.json`));

async function people() {
  const adam = await f.account("Adam");
  const eve = await f.account("Eve");
  const room = await f.room(adam, roomName("sc"));
  f.addPerson(room, adam, eve);
  return { adam, eve, room };
}

test("attack: another person of the room signs a valid member_add for this chat as THEIR chat -> mismatch, keys deleted", async () => {
  const { adam, eve, room } = await people();
  const h = newHome("sc-attack");
  await on(h, async () => {
    const r = await create(f.invite(room, adam), "victim", h);
    assert.match(r.text, /Waiting for Adam to approve/);
    // the server keeps telling the chat "Adam", while Eve's browser signs member_add {account: Eve} with Eve's device
    f.approve(r.req.id, { asAccount: eve });
    const w = await wait("victim");
    assert.equal(w.status, "mismatch");
    assert.match(w.text, MISMATCH);
    assert.equal(st.liveMembers().length, 0, "the chat did not become Eve's chat");
    assert.ok(keyGone(r.req.key_id), "keys deleted");
  });
});

test("attack: the owner signs a member_add as the owner's chat for a person's invite -> mismatch", async () => {
  const { adam, eve, room } = await people();
  const h = newHome("sc-attack-owner");
  await on(h, async () => {
    const r = await create(f.invite(room, eve), "eves-bot", h);
    assert.match(r.text, /Waiting for Eve to approve/);
    f.approve(r.req.id, { asAccount: adam });
    const w = await wait("eves-bot");
    assert.equal(w.status, "mismatch");
    assert.equal(st.liveMembers().length, 0);
  });
});

test("normal join with the owner's invite and with a person's own invite still pass", async () => {
  const { adam, eve, room } = await people();
  for (const [who, inv, name] of [[adam, f.invite(room, adam), "owners-bot"], [eve, f.invite(room, eve), "persons-bot"]] as const) {
    const h = newHome(name);
    await on(h, async () => {
      const r = await create(inv, name, h);
      f.approve(r.req.id);
      const w = await wait(name);
      assert.equal(w.status, "approved", w.text);
      const m = (w as any).member as st.MemberRec;
      assert.equal(m.account, who.id);
      assert.match(w.text, new RegExp(`Joined #\\S+ as ${name}\\.`));
      assert.doesNotMatch(w.text, /made the request/);
    });
  }
});

test("self-heal (item 11): another person takes the request over, then approves -> approved as their chat, said out loud", async () => {
  const charles = await f.account("Charles");
  const victor = await f.account("Victor");
  const room = await f.room(charles, roomName("heal"));
  f.addPerson(room, charles, victor);
  const h = newHome("sc-heal");
  await on(h, async () => {
    const r = await create(f.invite(room, charles), "v2", h);
    assert.match(r.text, /Waiting for Charles to approve/);
    f.readdress(r.req.id, victor);
    const p = await core.joinWait({ maxMs: 1200, app: "codex", session: `sess-v2-${n}` });
    assert.equal(p.status, "pending");
    assert.match(p.text, /Still waiting for Victor to approve.*Victor made this request theirs; it used Charles's invite/s);
    f.approve(r.req.id);
    const w = await wait("v2");
    assert.equal(w.status, "approved", w.text);
    assert.equal(((w as any).member as st.MemberRec).account, victor.id);
    assert.match(w.text, /This chat is Victor's chat: it used Charles's invite, and Victor made the request theirs before approving\./);
  });
});

test("self-heal with this computer's other chats: stop as wrong person, take over, wait again -> approved", async () => {
  const charles = await f.account("Charles");
  const victor = await f.account("Victor");
  const room = await f.room(charles, roomName("heal2"));
  f.addPerson(room, charles, victor);
  const h = newHome("sc-heal2");
  await on(h, async () => {
    const r1 = await create(f.invite(room, victor), "v1", h);
    f.approve(r1.req.id);
    assert.equal((await wait("v1")).status, "approved");
    const r2 = await create(f.invite(room, charles), "v2", h);
    assert.equal(r2.stop, true, r2.text);
    assert.match(r2.text, /Not waiting for Charles/);
    // takeover and approval both happen before the chat's next wait: one view carries both
    f.readdress(r2.req.id, victor);
    f.approve(r2.req.id);
    const w = await wait("v2");
    assert.equal(w.status, "approved", w.text);
    assert.equal(((w as any).member as st.MemberRec).account, victor.id);
  });
});

test("after a takeover, an approval as yet another person -> mismatch", async () => {
  const charles = await f.account("Charles");
  const victor = await f.account("Victor");
  const eve = await f.account("Eve");
  const room = await f.room(charles, roomName("heal3"));
  f.addPerson(room, charles, victor);
  f.addPerson(room, charles, eve);
  const h = newHome("sc-heal3");
  await on(h, async () => {
    const r = await create(f.invite(room, charles), "v3", h);
    f.readdress(r.req.id, victor);
    f.approve(r.req.id, { asAccount: eve });
    const w = await wait("v3");
    assert.equal(w.status, "mismatch");
    assert.equal(st.liveMembers().length, 0);
  });
});

test("the addressee changes twice (a takeover happens once) -> mismatch before any approval", async () => {
  const charles = await f.account("Charles");
  const victor = await f.account("Victor");
  const eve = await f.account("Eve");
  const room = await f.room(charles, roomName("twice"));
  f.addPerson(room, charles, victor);
  f.addPerson(room, charles, eve);
  const h = newHome("sc-twice");
  await on(h, async () => {
    const r = await create(f.invite(room, charles), "v4", h);
    f.readdress(r.req.id, victor);
    assert.equal((await core.joinWait({ maxMs: 1200, app: "codex", session: `sess-v4-${n}` })).status, "pending");
    f.joins.get(r.req.id)!.account = eve.id; // a server that moves it again
    f.ring();
    const w = await core.joinWait({ maxMs: 1200, app: "codex", session: `sess-v4-${n}` });
    assert.equal(w.status, "mismatch");
    assert.ok(keyGone(r.req.key_id));
  });
});

test("a move (claim) never changes person: a claim view naming another person -> mismatch", async () => {
  const { adam, eve, room } = await people();
  const hA = newHome("sc-claim-a"), hB = newHome("sc-claim-b");
  await on(hA, async () => {
    const r = await create(f.invite(room, adam), "deployer", hA);
    f.approve(r.req.id);
    assert.equal((await wait("deployer")).status, "approved");
  });
  await on(hB, async () => {
    const r = await core.joinCreate({ kind: "claim", invite: f.invite(room, adam), name: "deployer", job: "", app: "codex", turn: "on_turn", session: "sess-claim-b", cwd: hB, folder: "~", machine: "laptop-2" } as any);
    f.joins.get(r.req.id)!.account = eve.id;
    f.ring();
    const w = await core.joinWait({ maxMs: 1200, app: "codex", session: "sess-claim-b" });
    assert.equal(w.status, "mismatch");
  });
});

test("a server that doesn't say whose invite it is: join refuses before anything can be approved", async () => {
  const { adam, room } = await people();
  const h = newHome("sc-old");
  f.noApproverAccount = true;
  try {
    await on(h, async () => {
      await assert.rejects(create(f.invite(room, adam), "oldsrv", h), /older than this client.*whose invite/s);
      assert.equal(st.allRequests().length, 0);
      assert.equal(readdirSync(join(process.env.BOTLINK_HOME!, "keys")).length, 0, "no keys left behind");
    });
  } finally {
    f.noApproverAccount = false;
  }
});
