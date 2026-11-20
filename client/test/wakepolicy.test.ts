/**
 * Held while away, on the server too (lane F, wakepolicy.ts): the client declares its wake policy and its mutes to
 * the server, says to a sender which recipients were not woken, and does not tell a sender twice. An old server
 * (no route) changes nothing.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { tools } from "../src/mcp.js";
import * as asks from "../src/asks.js";
import * as archive from "../src/archive.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake, assertCopy } from "./helpers.js";

let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

const SA = "aaaaaaaa-2222-4222-8333-0000000000a1";
const SB = "bbbbbbbb-2222-4222-8333-0000000000b2";
const SP = "cccccccc-2222-4222-8333-0000000000c3";

/** The real server's lane-F routes, on the fake (switched on per test: off = an older server, 404). */
interface WP {
  on: boolean;
  /** the lease says wake_held per copy (the server since the follow-up); off = a server that only has not_woken */
  flag: boolean;
  held: Set<string>; // "<message>:<member>" copies held by policy
  notWokenOf: Map<string, string[]>; // message id -> the send answer's not_woken
  policies: Map<string, { except: string[]; since: string }>;
  mutes: Map<string, Set<string>>; // account -> muted member ids
  calls: { member: string; method: string; path: string; body: any }[];
}
const wp: WP = { on: false, flag: true, held: new Set(), notWokenOf: new Map(), policies: new Map(), mutes: new Map(), calls: [] };
function wireRoutes(fs: FakeServer) {
  const F = fs as any;
  const orig = F.route.bind(fs);
  F.route = async (req: any, url: URL, raw: Buffer, session: string | null) => {
    const M = req.method, P = url.pathname;
    const mine = wp.on && ((M === "PUT" && (P === "/api/v1/me/wake-policy" || P.startsWith("/api/v1/me/mutes/"))) || (M === "GET" && P === "/api/v1/me/mutes"));
    if (mine) {
      const a = F.auth(req, url, raw);
      const m = F.memberByKey(a.key);
      F.holder(m, a.session);
      const body = raw.length ? JSON.parse(raw.toString("utf-8")) : {};
      wp.calls.push({ member: m.id, method: M, path: P, body });
      if (P === "/api/v1/me/wake-policy") {
        if (body.hold_others) {
          const prev = wp.policies.get(m.id);
          wp.policies.set(m.id, { except: [...(body.except || [])].sort(), since: prev?.since || new Date().toISOString() });
        } else wp.policies.delete(m.id);
        const p = wp.policies.get(m.id);
        return { status: 200, body: { hold_others: !!body.hold_others, except: p?.except || [], ...(p ? { since: p.since } : {}) } };
      }
      if (M === "GET") return { status: 200, body: { mutes: [...(wp.mutes.get(m.account) || [])].map((id) => ({ member_id: id, name: fs.members.get(id)?.name || "" })) } };
      const id = P.split("/").pop()!;
      const target = fs.members.get(id);
      if (!target) return { status: 404, body: { error: { code: "not_found", message: "Not found." } } };
      if (target.account === m.account) return { status: 403, body: { error: { code: "own_member", message: "own" } } };
      (wp.mutes.get(m.account) || wp.mutes.set(m.account, new Set()).get(m.account)!).add(id);
      return { status: 200, body: { member_id: id, muted: true } };
    }
    const r = await orig(req, url, raw, session);
    if (wp.on && M === "POST" && P === "/api/v1/messages" && (r.status === 201 || r.status === 200)) {
      // quietFor as the real server: another person's chat, recipient declared, sender not let through
      const notWoken: string[] = [];
      for (const d of fs.copies(r.body.id)) {
        const to = fs.members.get(d.member)!, from = fs.members.get(d.from)!;
        const p = wp.policies.get(to.id);
        if (!p || to.account === from.account || p.except.includes(from.id)) continue;
        if (d.quiet) {
          wp.held.add(`${d.message_id}:${to.id}`);
          continue;
        }
        wp.held.add(`${d.message_id}:${to.id}`);
        notWoken.push(to.id);
        if (r.status === 201 && !(wp.mutes.get(to.account) || new Set()).has(from.id)) fs.attention.push({ member: to.id, reason: "needs_ok" });
      }
      wp.notWokenOf.set(r.body.id, notWoken);
      r.body = { ...r.body, not_woken: notWoken };
    }
    if (wp.on && wp.flag && M === "POST" && P === "/api/v1/me/inbox/lease" && r.status === 200 && Array.isArray(r.body?.deliveries)) {
      r.body = { ...r.body, deliveries: r.body.deliveries.map((d: any) => ({ ...d, wake_held: wp.held.has(`${d.message_id}:${fs.deliveries.find((x: any) => x.seq === d.seq)?.member}`) })) };
    }
    return r;
  };
}

async function world(opts: { routes: boolean; flag?: boolean }) {
  if (!(f as any).__wp) {
    wireRoutes(f);
    (f as any).__wp = true;
  }
  wp.on = opts.routes;
  wp.flag = opts.flag ?? true;
  wp.calls = [];
  const adam = await f.account("Adam");
  const priya = await f.account("Priya");
  const room = await f.room(adam, `wp${Math.floor(Math.random() * 1e6)}`);
  f.addPerson(room, adam, priya);
  const hA = newHome("wa"), hB = newHome("wb"), hP = newHome("wp");
  const j = async (h: string, who: typeof adam, name: string, app: st.App, session: string) =>
    on(h, async () => {
      const r = await core.joinCreate({ invite: `http://localhost:8811/i/${f.invite(room, who)}`, name, job: "", app, turn: "wake", session, cwd: h, folder: "~", machine: "m" });
      f.approve(r.req.id, { signer: who });
      return ((await core.joinWait({ maxMs: 3000 })) as any).member as st.MemberRec;
    });
  const mA = await j(hA, adam, "bugfix", "claude-code", SA);
  const mB = await j(hB, adam, "deployer", "codex", SB);
  const mP = await j(hP, priya, "helper", "codex", SP);
  for (const [h, m, s] of [[hA, mA, SA], [hB, mB, SB], [hP, mP, SP]] as const) await on(h, async () => (await core.takeBatch([st.loadMember(m.id)!], s, { humanTurn: true })).commit());
  return { adam, priya, room, hA, hB, hP, mA, mB, mP };
}
const send = (h: string, m: st.MemberRec, s: string, to: string, text: string, intent: any = "question") => on(h, () => core.send(st.loadMember(m.id)!, { to, text, intent }, s));
const AWAY = { BOTLINK_UNATTENDED: "1" };
const policyCalls = (member: string) => wp.calls.filter((x) => x.member === member && x.path === "/api/v1/me/wake-policy");
const recFile = (h: string, member: string) => join(h, ".botlink", "wakepolicy", `${member}.json`);

test("the policy is declared right after join: other people's chats do not wake this member", async () => {
  const w = await world({ routes: true });
  for (const m of [w.mA, w.mB, w.mP]) {
    const c = policyCalls(m.id);
    assert.equal(c.length, 1, `one declaration for ${m.name}: ${JSON.stringify(wp.calls)}`);
    assert.deepEqual(c[0].body, { hold_others: true, except: [] });
    assert.equal(c[0].method, "PUT");
  }
  // reads and sends afterwards do not repeat it (nothing changed)
  await send(w.hP, w.mP, SP, "deployer", "Is the build green?");
  await on(w.hB, async () => (await core.takeBatch([st.loadMember(w.mB.id)!], SB, { humanTurn: true })).commit());
  assert.equal(policyCalls(w.mB.id).length, 1);
  assert.equal(policyCalls(w.mP.id).length, 1);
});

test("each change of a setting declares it again: 'while away' adds the member to the exceptions, muted takes it out and mutes it on the server", async () => {
  const w = await world({ routes: true });
  const out1 = await on(w.hA, () => core.setPermission(st.loadMember(w.mA.id)!, SA, { member: "helper", level: "answer", whileAway: true, how: "terminal" }));
  assert.match(out1, /Its messages also reach this chat while no human is here/);
  assert.deepEqual(policyCalls(w.mA.id).at(-1)!.body, { hold_others: true, except: [w.mP.id] });
  // the human's own chats are never listed (they always wake it)
  await on(w.hA, () => core.setPermission(st.loadMember(w.mA.id)!, SA, { member: "deployer", level: "tasks", how: "terminal" }));
  assert.deepEqual(policyCalls(w.mA.id).at(-1)!.body, { hold_others: true, except: [w.mP.id] });
  // the chat itself may give less: muted. The server is told (a chat may mute) and the exception goes
  const out2 = await on(w.hA, () => core.setPermission(st.loadMember(w.mA.id)!, SA, { member: "helper", level: "muted", how: "chat" }));
  assert.ok(wp.calls.some((x) => x.member === w.mA.id && x.method === "PUT" && x.path === `/api/v1/me/mutes/${w.mP.id}`), JSON.stringify(wp.calls));
  assert.deepEqual(policyCalls(w.mA.id).at(-1)!.body, { hold_others: true, except: [] });
  assert.match(out2, /It also no longer wakes Adam's chats; only Adam can turn that back on, on the room page\./);
  assertCopy(out2);
  // muting the human's own chat is local only (the server refuses that, and it is not asked)
  const n = wp.calls.length;
  await on(w.hA, () => core.setPermission(st.loadMember(w.mA.id)!, SA, { member: "deployer", level: "muted", how: "chat" }));
  assert.ok(!wp.calls.slice(n).some((x) => x.path.startsWith("/api/v1/me/mutes/")));
  // the human raises helper again in their terminal: waking stays off until they un-mute it on the room page
  const out3 = await on(w.hA, () => core.setPermission(st.loadMember(w.mA.id)!, SA, { member: "helper", level: "answer", how: "terminal" }));
  assert.match(out3, /Its messages still do not wake Adam's chats until Adam un-mutes helper on the room page; until then they show up at this chat's next turn\./);
  assertCopy(out3);
  assert.ok(wp.mutes.get(w.adam.id)?.has(w.mP.id), "the client never un-mutes on the server");
  // a mute set on this computer by an earlier client version (no server mute yet) reaches the server at the next read
  const pf = join(w.hB, ".botlink", "perms", `${w.mB.id}.json`);
  mkdirSync(join(w.hB, ".botlink", "perms"), { recursive: true, mode: 0o700 });
  writeFileSync(pf, JSON.stringify({ [w.mP.id]: { level: "muted", set_at: Date.now(), how: "terminal", name: "helper" } }));
  await on(w.hB, async () => (await core.takeBatch([st.loadMember(w.mB.id)!], SB, { humanTurn: true })).commit());
  assert.ok(wp.calls.some((x) => x.member === w.mB.id && x.path === `/api/v1/me/mutes/${w.mP.id}`), "an earlier local mute is sent too");
});

test("a failed declaration never breaks a send and is tried again later; an old server (no route) is left alone", async () => {
  // an old server: 404, quietly
  const old = await world({ routes: false });
  const r = await send(old.hP, old.mP, SP, "bugfix", "Still there?");
  assert.match(r.text, /Passed to bugfix/);
  assert.doesNotMatch(r.text, /not woken/);
  const rec0 = JSON.parse(readFileSync(recFile(old.hA, old.mA.id), "utf-8"));
  assert.ok(rec0.old_server_at > 0 && !rec0.hold, JSON.stringify(rec0));
  const hits = () => (f.hits.get("PUT /api/v1/me/wake-policy") || 0);
  const h0 = hits();
  await on(old.hA, async () => (await core.takeBatch([st.loadMember(old.mA.id)!], SA, { humanTurn: true })).commit());
  assert.equal(hits(), h0, "an old server is not asked again for 6 hours");

  // a server that fails: the send still goes, the record says so, the next due call succeeds
  const w = await world({ routes: true });
  const file = recFile(w.hP, w.mP.id);
  writeFileSync(file, JSON.stringify({ key_id: w.mP.key_id }));
  f.failNext = { path: /\/api\/v1\/me\/wake-policy$/, status: 503, code: "unavailable", times: 1 };
  const s = await send(w.hP, w.mP, SP, "deployer", "One more thing?");
  assert.match(s.text, /Passed to deployer/);
  const rec1 = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(rec1.fails, 1, JSON.stringify(rec1));
  // within the pause: not tried
  const before = policyCalls(w.mP.id).length;
  await send(w.hP, w.mP, SP, "deployer", "And another?");
  assert.equal(policyCalls(w.mP.id).length, before);
  // after it: tried, accepted
  writeFileSync(file, JSON.stringify({ ...rec1, fail_at: Date.now() - 10 * 60_000 }));
  await on(w.hP, async () => (await core.takeBatch([st.loadMember(w.mP.id)!], SP, { humanTurn: true })).commit());
  assert.equal(policyCalls(w.mP.id).length, before + 1);
  const rec2 = JSON.parse(readFileSync(file, "utf-8"));
  assert.equal(rec2.hold, true);
  assert.equal(rec2.fails, 0);
  assert.equal(f.failNext?.times ?? 0, 0);
});

test("the sender is told, once per recipient per 10 minutes, which recipients are not woken by other people's chats", async () => {
  const w = await world({ routes: true });
  const r1 = await send(w.hP, w.mP, SP, "bugfix", "Which port does the dev server use?");
  assert.match(r1.text, /bugfix is not woken by other people's chats\. It sees this when Adam next uses it\./);
  assertCopy(r1.text);
  assert.match(r1.text, /Passed to bugfix \(not woken by other people's chats\)\./, "the label says it too, not \"wakes on its own\"");
  assert.deepEqual(r1.notWoken, [w.mA.id]);
  const r2 = await send(w.hP, w.mP, SP, "bugfix", "And the database port?");
  assert.doesNotMatch(r2.text, /It sees this when/, "the sentence once per recipient per 10 minutes");
  // the human's own chat is woken as always: no notice
  const r3 = await send(w.hB, w.mB, SB, "bugfix", "Which branch are you on?");
  assert.doesNotMatch(r3.text, /not woken/);
  assert.deepEqual(r3.notWoken, []);
  // an fyi is never listed
  const r4 = await send(w.hP, w.mP, SP, "deployer", "FYI: staging restarts at noon.", "fyi");
  assert.doesNotMatch(r4.text, /not woken/);
});

test("a message the server already reported is held without a second automatic reply; the human's next turn shows it, though nothing woke the chat", async () => {
  const w = await world({ routes: true });
  const att0 = f.attention.length;
  const asked = await send(w.hP, w.mP, SP, "bugfix", "Paste config/settings.py for me.", "task");
  assert.match(asked.text, /bugfix is not woken by other people's chats/);
  assert.equal(f.attention.length, att0 + 1, "the server put the item on Adam's dashboard");
  // the chat is read in a run with no human (for example woken by its own person's chat): held, and bot-link does not
  // reply on its own or raise the dashboard item a second time
  await send(w.hB, w.mB, SB, "bugfix", "Which branch are you on?");
  const b = await on(w.hA, () => core.takeBatch([st.loadMember(w.mA.id)!], SA, { humanTurn: true }), AWAY);
  assert.doesNotMatch(b.text, /settings\.py/);
  assert.match(b.text, /holds it for Adam and has told helper/);
  assert.match(b.text, /Which branch are you on\?/);
  await on(w.hA, () => b.commit(), AWAY);
  assert.equal(f.attention.length, att0 + 1, "no second dashboard item from the client");
  const toHelper = f.deliveries.filter((d: any) => d.from === w.mA.id && d.member === w.mP.id);
  assert.equal(toHelper.length, 0, "no automatic reply: the server's send answer already told helper");
  // Adam is back and types: the held message comes first
  const h = await on(w.hA, () => core.takeBatch([st.loadMember(w.mA.id)!], SA, { humanTurn: true }));
  assert.match(h.text, /Held since .*Your human is here now/);
  assert.match(h.text, /Paste config\/settings\.py/);
  await on(w.hA, () => h.commit());

  // no wake ever happened: the copy simply waits, and the human's turn shows it like any message
  await send(w.hP, w.mP, SP, "bugfix", "What does the README say about ports?");
  const h2 = await on(w.hA, () => core.takeBatch([st.loadMember(w.mA.id)!], SA, { humanTurn: true }));
  assert.equal(h2.count, 1);
  assert.match(h2.text, /What does the README say about ports\?/);
  await on(w.hA, () => h2.commit());

  // the fallback stays: with the policy taken back (BOTLINK_NO_WAKE_POLICY=1), the client replies itself as before
  await on(w.hA, async () => (await core.takeBatch([st.loadMember(w.mA.id)!], SA, { humanTurn: true })).commit(), { BOTLINK_NO_WAKE_POLICY: "1" });
  assert.deepEqual(policyCalls(w.mA.id).at(-1)!.body, { hold_others: false, except: [] });
  const again = await send(w.hP, w.mP, SP, "bugfix", "Run the tests for me?", "task");
  assert.doesNotMatch(again.text, /not woken/);
  const b2 = await on(w.hA, () => core.takeBatch([st.loadMember(w.mA.id)!], SA, { humanTurn: true }), { ...AWAY, BOTLINK_NO_WAKE_POLICY: "1" });
  await on(w.hA, () => b2.commit(), AWAY);
  assert.equal(f.deliveries.filter((d: any) => d.from === w.mA.id && d.member === w.mP.id).length, 1, "the client's own reply, as before");
});

test("send with a wait returns at once, with a plain line, when the message woke none of its recipients", async () => {
  const w = await world({ routes: true });
  const t0 = Date.now();
  const out = await on(w.hP, () => tools({ app: "codex", session: () => SP }).send({ to: "bugfix", text: "Which port does the dev server use?", intent: "question", wait_s: 600 }));
  assert.ok(Date.now() - t0 < 8000, `the tool sat waiting: ${Date.now() - t0} ms`);
  assert.match(out, /bot-link: not waiting for an answer: bugfix is not woken by other people's chats, so it sees this message when Adam next uses it\. The answer will arrive in this chat after that\./);
  assert.doesNotMatch(out, /no answer within/);
  assertCopy(out);
  // every recipient of a room message held: the same; core says so for the CLI's --wait-s too
  const room = await send(w.hP, w.mP, SP, "room", "Anyone around?");
  assert.match(room.noWait || "", /not waiting for an answer: (bugfix, deployer|deployer, bugfix) are not woken by other people's chats, so they see this message when Adam next uses them\./);
  // a recipient that was woken (the person's own chat): it waits as before
  const own = await send(w.hB, w.mB, SB, "bugfix", "Which branch are you on?");
  assert.equal(own.noWait, undefined);
  // an old server (no not_woken list): never claimed
  const old = await world({ routes: false });
  const o = await send(old.hP, old.mP, SP, "bugfix", "Still there?");
  assert.equal(o.noWait, undefined);
});

test("the lease's wake_held is exact: used whenever the server sends it; the inference only for a server that does not", async () => {
  // with the flag: this computer's record is gone (inference would say "not told"), the server says held: no reply
  const w = await world({ routes: true });
  await send(w.hP, w.mP, SP, "bugfix", "Run the tests for me?", "task");
  writeFileSync(recFile(w.hA, w.mA.id), JSON.stringify({}));
  const b = await on(w.hA, () => core.takeBatch([st.loadMember(w.mA.id)!], SA, { humanTurn: true }), AWAY);
  await on(w.hA, () => b.commit(), AWAY);
  assert.match(b.text, /holds it for Adam/);
  assert.equal(f.deliveries.filter((d: any) => d.from === w.mA.id && d.member === w.mP.id).length, 0, "the server's wake_held said it was told");
  // the flag says false (a copy that woke the chat): the client's own reply, though the inference would say told
  const w2 = await world({ routes: true });
  const own = await send(w2.hP, w2.mP, SP, "bugfix", "Run the linter for me?", "task");
  wp.held.delete(`${own.id}:${w2.mA.id}`);
  const b2 = await on(w2.hA, () => core.takeBatch([st.loadMember(w2.mA.id)!], SA, { humanTurn: true }), AWAY);
  await on(w2.hA, () => b2.commit(), AWAY);
  assert.equal(f.deliveries.filter((d: any) => d.from === w2.mA.id && d.member === w2.mP.id).length, 1, "wake_held false wins over the inference");
  // a server with not_woken but no wake_held: the inference, as before
  const w3 = await world({ routes: true, flag: false });
  await send(w3.hP, w3.mP, SP, "bugfix", "Paste the env file?", "task");
  const b3 = await on(w3.hA, () => core.takeBatch([st.loadMember(w3.mA.id)!], SA, { humanTurn: true }), AWAY);
  await on(w3.hA, () => b3.commit(), AWAY);
  assert.equal(f.deliveries.filter((d: any) => d.from === w3.mA.id && d.member === w3.mP.id).length, 0, "inferred: told");
});

test("signed notes meet holds: a yes or allow note from another person's chat is never listed as not woken, raises no dashboard item, is checked and shown at the next read (held or not), and is kept in both chats' history", async () => {
  const w = await world({ routes: true });
  const read = (h: string, m: st.MemberRec, s: string, env: Record<string, string> = {}) =>
    on(h, async () => {
      const b = await core.takeBatch([st.loadMember(m.id)!], s, { humanTurn: true, human: !env.BOTLINK_UNATTENDED });
      await b.commit();
      return b.text;
    }, env);
  const inArchive = (h: string, m: st.MemberRec, id: string, dir: "in" | "out") => on(h, () => archive.listArchive(m.id, 0, Date.now() + 60_000).some((r: any) => r.id === id && r.dir === dir));
  // bugfix (Adam) asks helper (Priya); Priya is reading and says yes in her own words
  const asked = await send(w.hA, w.mA, SA, "helper", "Please run the test suite in the shared repo and tell me what fails.", "task");
  assert.match(await read(w.hP, w.mP, SP), /Please run the test suite/);
  const code = await on(w.hP, async () => /botlink yes ([2-9A-HJ-NP-Z]{6})/.exec(await tools({ app: "codex", session: () => SP }).ask_yes({ message_id: asked.id, action: "run_command", summary: "Run npm test in the shared repo for bugfix." }))![1]);
  const att0 = f.attention.length;
  await on(w.hP, () => asks.sayYes(st.loadMember(w.mP.id)!, code, SP, "words"));
  const yesId = [...f.messages.keys()].pop()!;
  assert.deepEqual(wp.notWokenOf.get(yesId), [], "(a) a note (a quiet fyi) is never listed as not woken");
  assert.equal(f.attention.length, att0, "(b) no dashboard item for a note");
  assert.ok(f.copies(yesId).every((d: any) => d.quiet));
  // (c) bugfix reads in a run with no human: held (another person's chat), no automatic reply for an fyi
  const away = await read(w.hA, w.mA, SA, AWAY);
  assert.doesNotMatch(away, /said yes/);
  assert.equal(f.deliveries.filter((d: any) => d.from === w.mA.id && d.member === w.mP.id && d.message_id !== asked.id).length, 0);
  // ... and at Adam's next turn it is checked and shown
  const back = await read(w.hA, w.mA, SA);
  assert.match(back, new RegExp(`bot-link: Priya said yes to your request \\(…${asked.id.slice(-8)}\\): run a command\\. Checked by bot-link`));
  // deployer reads it straight at its human's turn, checked too
  assert.match(await read(w.hB, w.mB, SB), /Priya said yes to bugfix's request .*Checked by bot-link/);
  // (d) kept in both chats' history for the room report: sent by helper, received by bugfix (held or not)
  assert.ok(await inArchive(w.hP, w.mP, yesId, "out"), "helper's own history has the note it sent");
  assert.ok(await inArchive(w.hA, w.mA, yesId, "in"), "bugfix's history has the note, though it was held first");

  // an allow note: Priya, in her own terminal, lets bugfix have files read by helper; it goes to bugfix
  const att1 = f.attention.length;
  await on(w.hP, () => core.setPermission(st.loadMember(w.mP.id)!, SP, { member: "bugfix", level: "files", how: "terminal" }));
  const allowId = [...f.messages.keys()].pop()!;
  assert.notEqual(allowId, yesId);
  assert.deepEqual(wp.notWokenOf.get(allowId), [], "(a) allow note");
  assert.equal(f.attention.length, att1, "(b) allow note");
  assert.match(await read(w.hA, w.mA, SA), /Priya let this chat have files read by helper to answer it, set in Priya's own terminal\. Checked by bot-link\./);
  assert.ok(await inArchive(w.hP, w.mP, allowId, "out"));
  assert.ok(await inArchive(w.hA, w.mA, allowId, "in"));
});
