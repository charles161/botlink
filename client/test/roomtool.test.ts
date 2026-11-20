// Rooms started by a chat (docs/protocol/room-drafts.md §6, founder's order 17 Nov 2026): a chat asks for a room
// (create_room / `botlink create-room`), a person confirms it on /create/<id> with the code and a passkey, and the
// chat's wait finishes exactly like a join (roster verified from genesis, the self-check, pin, "Joined …"). An owner's
// chat can hand its human the room's invite link (invite_link / `botlink invite-link`). The server endpoints are
// faked in fake-server.ts exactly as the contract's §2 defines them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { draftLinkIn } from "../src/outscan.js";
import { tools, ROOM_TOOL_TEXT } from "../src/mcp.js";
import { decodeEntry } from "../src/roster.js";
import { selfCmd } from "../src/version.js";
import { FakeServer } from "./fake-server.js";
import { assertCopy, assertIsolated, newHome, on, startFake } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const REPO = join(import.meta.dirname, "..", "..");
let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

let n = 0;
const S = () => `55555555-aaaa-4bbb-8ccc-${String(++n).padStart(12, "0")}`;
const roomName = (p: string) => `${p}${++n}${Math.floor(Math.random() * 1e4)}`;
const args = (room: string, session: string | null, cwd: string, name = "planner") => ({ room, purpose: "Plan the launch together", name, job: "plans the launch", app: "claude-code" as st.App, turn: "on_turn" as st.Turn, session, cwd, folder: "~", machine: "m" });
const keyGone = (keyId: string) => !existsSync(join(process.env.BOTLINK_HOME!, "keys", `${keyId}.json`));
/** The block a chat repeats to its human, for one draft (exact): the link and the code, nothing else. */
const tellBlock = (rn: string, link: string, code: string, fp: string) => `Tell your human:\n  Open this link to make the room #${rn}: ${link}\n  Type the code ${code} on that page (key ${fp}), then confirm with your passkey.`;
const SAME_TURN = /same turn|Don't end your turn|right away/;
const wait = (session: string, cwd: string, maxMs = 2000) => core.joinWait({ maxMs, app: "claude-code", session, cwd });

/** The command line as its own process (as a chat runs it), with this test's computer (HOME, BOTLINK_HOME) and server.
 *  (A stdout swap in this process would also swallow the test runner's own report lines.) */
async function cli(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; text: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((res) => {
    const ch = spawn(process.execPath, [CLI, ...argv], { cwd: process.env.HOME, env: { ...process.env, ...env } });
    let text = "", err = "";
    ch.stdout.on("data", (b) => (text += b));
    ch.stderr.on("data", (b) => (err += b));
    ch.on("exit", (code) => res({ code: code ?? -1, text: text + err }));
  });
}

// ------------------------------------------------------------------ create_room: what it sends, records and says
test("create-room: a signed draft with the join's fields, a pending record of kind create, and the link, code and key for the human", async () => {
  const h = newHome("rt-create");
  await on(h, async () => {
    const s = S();
    const rn = roomName("launch");
    const r = await core.createRoom(args(rn, s, h));
    const d = f.drafts.get(r.req.id)!;
    assert.ok(d, "POST /api/v1/room-drafts with the client's id");
    assert.equal(d.body.room_name, rn);
    assert.equal(d.body.room_purpose, "Plan the launch together");
    assert.equal(d.body.name, "planner");
    assert.equal(d.body.job, "plans the launch");
    assert.equal(d.body.session_id, s);
    assert.ok(!("invite" in d.body) && !("kind" in d.body), "the join body without invite and kind");
    // the pending record: kind create, the draft's key, code, member id and link
    const rec = st.loadRequest(r.req.id)!;
    assert.equal(rec.kind, "create");
    assert.equal(rec.ed, d.body.ed25519_pk);
    assert.equal(rec.match_code, d.match_code);
    assert.equal(rec.member_id, d.member_id);
    assert.equal(rec.room.name, rn);
    assert.equal(rec.approve_url, `http://localhost:8811/create/${r.req.id}`);
    // the text, in order: what happened, the link, the code and key, that the human types the code there, how long
    const lines = r.text.split("\n");
    assert.equal(lines[0], `This chat asked for a new room, #${rn}, with this chat in it as planner. Nothing is made yet: your human makes the room in the browser.`);
    assert.equal(lines[1], `Link for your human: http://localhost:8811/create/${r.req.id}`);
    assert.equal(lines[2], `Code ${core.groupCode(d.match_code)} · key ${rec.fingerprint}. Your human types the code on that page, then confirms with their passkey.`);
    assert.match(lines[3], /^Your human has 15 minutes to confirm it \(until \d\d:\d\d UTC\)\.$/);
    assert.equal(lines[4], core.DRAFT_ONLY_HUMAN);
    assertCopy(r.text);
  });
});

test("create-room on the command line: the commands first, then the link, the code and the key, then: tell your human (exact block), end your turn; never a same-turn wait", async () => {
  const h = newHome("rt-cli");
  await on(h, async () => {
    const s = S();
    const rn = roomName("clir");
    const { code, text } = await cli(["create-room", "--room", rn, "--purpose", "--planning-- for the launch", "--name", "clichat", "--job", "plans", "--app", "claude-code", "--session", s]);
    assert.equal(code, 0, text);
    const d = [...f.drafts.values()].find((x) => x.body.room_name === rn)!;
    assert.equal(d.body.room_purpose, "--planning-- for the launch", "--purpose is free text, even when it starts with --");
    const rec = st.loadRequest(d.id)!;
    const iCmds = text.indexOf("Use bot-link from the command line right now"), iLink = text.indexOf("Link for your human: "), iCode = text.indexOf("Your human types the code on that page"), iTell = text.indexOf("Tell your human:");
    assert.ok(iCmds >= 0 && iLink > iCmds && iCode > iLink && iTell > iCode, text);
    assert.match(text, new RegExp(`Code ${core.groupCode(d.match_code)} · key [0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}\\.`));
    // the real-app failure (17 Nov): the model kept the wait and never showed the link. Now: reply, then end the turn
    assert.ok(text.trimEnd().endsWith(core.draftNextStep(rec, "cli")), text);
    assert.equal(core.draftNextStep(rec, "cli"), `Reply to your human now, in your own message, with the link and the code exactly as below:\n${tellBlock(rn, `http://localhost:8811/create/${d.id}`, core.groupCode(d.match_code), rec.fingerprint)}\nThen stop and end your turn. Do not run join --wait in this turn: only your reply shows your human the link. When your human says they confirmed it, run \`${selfCmd()} join --wait\`; it returns at once if they did.`);
    assert.match(text.trimEnd().split("\n").pop()!, /^Then stop and end your turn\./);
    assert.doesNotMatch(text, SAME_TURN);
    assertCopy(text);
  });
});

test("create-room refuses bad input before anything is sent: room name, member name, purpose, job", async () => {
  const h = newHome("rt-bad");
  await on(h, async () => {
    const before = f.drafts.size;
    await assert.rejects(core.createRoom({ ...args("Launch Room", S(), h) }), /Room names are lowercase letters, digits and dashes, up to 32 characters\. Try: launch-room/);
    await assert.rejects(core.createRoom({ ...args(roomName("ok"), S(), h, "Bad Name") }), /Names are lowercase letters, digits and dashes/);
    await assert.rejects(core.createRoom({ ...args(roomName("ok"), S(), h), purpose: "" }), /Say in one line what the room is for/);
    await assert.rejects(core.createRoom({ ...args(roomName("ok"), S(), h), purpose: "x".repeat(141) }), /The purpose is too long/);
    await assert.rejects(core.createRoom({ ...args(roomName("ok"), S(), h), job: "x".repeat(141) }), /The job is too long/);
    assert.equal(f.drafts.size, before);
    // a name the server keeps for itself: 409 name_taken with a suggestion, said plainly, keys deleted
    await assert.rejects(core.createRoom(args("bot-link", S(), h)), /^Error: The server says a name in this request is taken: bot-link keeps some room and chat names for itself\. Nothing was made\. It suggests "planner-2"\. Ask your human which names to use\.$/);
    assert.equal(st.allRequests().length, 0);
  });
});

test("an app bot-link can't tell: create-room asks for the app's name and says to run create-room (or call create_room) again, never join", async () => {
  const h = newHome("rt-appname");
  await on(h, async () => {
    const before = f.drafts.size;
    const e = await core.createRoom({ ...args(roomName("nameless"), null, h), app: "other", appNameWord: "--app-name" }).then(() => null, (x) => x);
    assert.ok(e instanceof core.UserError, String(e));
    assert.match(e.message, /bot-link can't tell which app this chat runs in\./);
    assert.match(e.message, /Then run the same create-room command again with --app-name "<app name>"\./);
    assert.doesNotMatch(e.message, /join/);
    const t = tools({ app: "other", session: () => null });
    await assert.rejects(t.create_room({ name: roomName("nameless"), purpose: "p", as: "tools", job: "j" }), (x: any) => {
      assert.match(x.message, /Then call create_room again with app_name: "<app name>"\./);
      assert.doesNotMatch(x.message, /join/);
      return true;
    });
    assert.equal(f.drafts.size, before, "nothing was sent");
    // join's own question is unchanged
    assert.match(core.askAppName("--app-name"), /Then run the same join command again with --app-name "<app name>"\./);
    assert.match(core.askAppName("app_name"), /Then call join again with app_name: "<app name>"\./);
  });
});

test("with no BOTLINK_SERVER, create-room asks the server this computer's members talk to, not production (staging tester, 17 Nov)", async () => {
  const adam = await f.account("Adam");
  const h = newHome("rt-server");
  const other = await f.room(adam, roomName("srv"));
  await joined(adam, other, adam, "planner", h);
  await on(h, async () => {
    const before = f.drafts.size;
    const r = await core.createRoom(args(roomName("nosrv"), S(), h));
    assert.equal(r.req.server, f.url);
    assert.equal(f.drafts.size, before + 1);
  }, { BOTLINK_SERVER: undefined });
});

test("too many drafts: a plain refusal with when to try again, at once (no minute of retries), keys deleted, nothing recorded", async () => {
  const h = newHome("rt-full");
  await on(h, async () => {
    f.draftsFull = 600;
    try {
      const t0 = Date.now();
      const e = await core.createRoom(args(roomName("full"), S(), h)).then(() => null, (x) => x);
      assert.ok(Date.now() - t0 < 5000, "a 429 too_many_drafts is not retried for a minute");
      assert.ok(e instanceof core.UserError, String(e));
      assert.match(e.message, /^There are too many rooms started by chats waiting for a person right now, so nothing was made\. Try again in about 10 minutes \(after \d\d:\d\d UTC\)\. A draft nobody confirms is gone after 15 minutes\.$/);
      assert.equal(st.allRequests().length, 0);
    } finally {
      f.draftsFull = null;
    }
  });
});

// ------------------------------------------------------------------ resume: asking twice is asking once
test("asking again for the same room as the same name is the same draft; another name for it is refused, nothing new sent", async () => {
  const h = newHome("rt-again");
  await on(h, async () => {
    const s = S();
    const rn = roomName("again");
    const r1 = await core.createRoom(args(rn, s, h));
    const count = f.drafts.size;
    const r2 = await core.createRoom(args(rn, s, h));
    assert.equal(r2.resumed, true);
    assert.equal(r2.req.id, r1.req.id);
    assert.equal(f.drafts.size, count, "nothing new was sent");
    assert.match(r2.text, new RegExp(`^This chat already asked for the room #${rn} as planner: this is the same draft \\(nothing new was sent\\)\\.\\nLink for your human: http://localhost:8811/create/${r1.req.id}\\n`));
    await assert.rejects(core.createRoom(args(rn, s, h, "other")), new RegExp(`This chat already asked for the room #${rn} as planner, and that draft still waits for your human`));
    assert.equal(f.drafts.size, count);
    // a confirmed earlier draft is finished, not asked again
    f.confirmDraft(r1.req.id, await f.account("Adam"));
    const r3 = await core.createRoom(args(rn, s, h));
    assert.equal(r3.done?.status, "approved", r3.text);
    assert.match(r3.text, new RegExp(`Joined #${rn} as planner\\.`));
    assert.equal(f.drafts.size, count);
  });
});

// ------------------------------------------------------------------ join --wait: the same exit codes as a join
test("join --wait on a draft: exit 3 while open (resumable), 0 once confirmed with Joined …; the wait uses /room-drafts/{id}/wait", async () => {
  const adam = await f.account("Adam");
  const h = newHome("rt-wait");
  await on(h, async () => {
    const s = S();
    const rn = roomName("waitr");
    const r = await core.createRoom(args(rn, s, h));
    const p = await cli(["join", "--wait", "--max-s", "1", "--app", "claude-code", "--session", s]);
    assert.equal(p.code, 3, p.text);
    // still waiting: the block once more and "don't call wait again": a pending draft never invites a loop
    const block = tellBlock(rn, `http://localhost:8811/create/${r.req.id}`, core.groupCode(r.req.match_code), r.req.fingerprint);
    assert.match(p.text, new RegExp(`^Still waiting for your human to confirm the new room #${rn} \\(this chat as planner\\): it is not made yet\\. This draft expires at \\d\\d:\\d\\d UTC \\(in \\d+ min\\); once it has expired, nothing is made\\.\\nIf your human has not had the link and the code from you yet, reply with them now:\\n`));
    assert.ok(p.text.includes(`${block}\nDo not call wait again until your human says they confirmed it; end your turn now.`), p.text);
    assert.equal(p.text.trimEnd().split("\n").pop(), "Do not call wait again until your human says they confirmed it; end your turn now.");
    assert.doesNotMatch(p.text, /To keep waiting|run it again|call join again/);
    assert.ok(f.log.some((x) => x.path === `/api/v1/room-drafts/${r.req.id}/wait`));
    assert.ok(!f.log.some((x) => x.path === `/api/v1/join-requests/${r.req.id}/wait`));
    // a new run (another process, a client update): the record on disk is all it needs
    assert.equal(st.loadRequest(r.req.id)?.kind, "create");
    f.confirmDraft(r.req.id, adam);
    const ok = await cli(["join", "--wait", "--max-s", "5", "--app", "claude-code", "--session", s]);
    assert.equal(ok.code, 0, ok.text);
    assert.match(ok.text, new RegExp(`^Joined #${rn} as planner\\. Adam confirmed the new room: it is Adam's, and this chat is in it\\. To bring in another of Adam's chats when they ask, use invite_link \\(\`.*invite-link\`\\)\\. Room fingerprint `));
    const m = st.liveMembers().find((x) => x.name === "planner" && x.room.name === rn)!;
    assert.ok(m, "the member is saved");
    assert.equal(m.person_name, "Adam");
    assert.equal(m.id, f.drafts.get(r.req.id)!.member_id);
    assert.equal(m.pin.room_fp.length > 0, true, "the room fingerprint is pinned");
    assert.equal(st.loadRequest(r.req.id), null, "the request is finished");
    assertCopy(ok.text);
  });
});

test("the MCP path that waits: join {wait: true} finishes a draft; create_room tells the chat to show the link and code, then wait", async () => {
  const adam = await f.account("Adam");
  const h = newHome("rt-mcp");
  const s = S();
  await on(h, async () => {
    const t = tools({ app: "claude-code", session: () => s });
    const rn = roomName("mcpr");
    const out = await t.create_room({ name: rn, purpose: "Plan it", as: "mcpchat", job: "plans" });
    assert.match(out, /Link for your human: http:\/\/localhost:8811\/create\/[0-9a-f-]{36}\n/);
    const id = /\/create\/([0-9a-f-]{36})/.exec(out)![1];
    const rec = st.loadRequest(id)!;
    assert.ok(out.trimEnd().endsWith(core.draftNextStep(rec, "mcp")), out);
    assert.equal(core.draftNextStep(rec, "mcp"), `Reply to your human now, in your own message, with the link and the code exactly as below:\n${tellBlock(rn, `http://localhost:8811/create/${id}`, core.groupCode(rec.match_code), rec.fingerprint)}\nThen stop and end your turn. Do not call join or wait in this turn: only your reply shows your human the link. When your human says they confirmed it, call join with only wait: true (command line: \`${selfCmd()} join --wait\`); it returns at once if they did.`);
    assert.doesNotMatch(out, SAME_TURN);
    // a wait while the draft is still open returns soon with the block and no invitation to call again
    const t0 = Date.now();
    const p = await t.join({ wait: true });
    assert.ok(Date.now() - t0 < 15_000, "a draft's wait does not hold the turn for 50 s");
    assert.ok(p.includes(tellBlock(rn, `http://localhost:8811/create/${id}`, core.groupCode(rec.match_code), rec.fingerprint)), p);
    assert.match(p, /Do not call wait again until your human says they confirmed it; end your turn now\.$/);
    assert.doesNotMatch(p, /call join again|To keep waiting/);
    f.confirmDraft(id, adam);
    const w = await t.join({ wait: true });
    assert.match(w, new RegExp(`^Joined #${rn} as mcpchat\\.`));
  });
});

test("a draft finishes only in the chat session that asked for it; create_room and invite_link need the human (never in an unattended run)", async () => {
  const h = newHome("rt-sess");
  await on(h, async () => {
    const s1 = S(), s2 = S();
    const rn = roomName("sess");
    await core.createRoom(args(rn, s1, h));
    await assert.rejects(wait(s2, h), new RegExp(`This computer has a draft for the new room #${rn} as planner .*It finishes in that chat, never here\\.`));
    const t = tools({ app: "claude-code", session: () => s2 });
    await assert.rejects(t.create_room({ name: roomName("x"), purpose: "p", as: "a", job: "j" }), /No human is here in this run, and create_room always needs your human/);
  }, { BOTLINK_UNATTENDED: "1" });
});

test("the eval scenarios' cases (overseer, 17 Nov): the room's final name after a rename at confirm, drafts of several sessions on one computer, a chat that is already a member elsewhere, a refused invite-link prints no link", async () => {
  const adam = await f.account("Adam");
  const h = newHome("rt-evals");
  // a member of another room already (this chat), on a computer where another session has a draft open
  const other = await f.room(adam, roomName("elsewhere"));
  const { s } = await joined(adam, other, adam, "planner", h);
  await on(h, async () => {
    const s2 = S();
    const rn = roomName("multi");
    const a = await core.createRoom(args(rn, s, h));
    const b = await core.createRoom(args(rn, s2, h, "second"));
    assert.notEqual(a.req.id, b.req.id);
    assert.deepEqual([a.req.kind, b.req.kind], ["create", "create"]);
    const final = roomName("renamed");
    f.confirmDraft(a.req.id, adam, { roomName: final });
    const w = await cli(["join", "--wait", "--max-s", "5", "--app", "claude-code", "--session", s]);
    assert.equal(w.code, 0, w.text);
    assert.match(w.text, new RegExp(`^Joined #${final} as planner\\.`), "the room's name from its signed genesis, not the proposed one");
    assert.equal(st.loadRequest(b.req.id)?.kind, "create", "the other session's draft still waits");
  });
  // a refused invite-link on the command line: exit non-zero, says owner, no link
  const eve = await f.account("Eve");
  const room = await f.room(adam, roomName("noinv"));
  f.addPerson(room, adam, eve);
  const he = newHome("rt-evals-eve");
  const { s: es } = await joined(adam, room, eve, "evebot", he);
  await on(he, async () => {
    const c = await cli(["invite-link", "--as", "evebot", "--session", es]);
    assert.notEqual(c.code, 0, c.text);
    assert.match(c.text, /owner/);
    assert.doesNotMatch(c.text, /\/i\//);
  }, { BOTLINK_APP: "claude-code" });
});

for (const [label, end, says] of [
  ["rejected", (id: string) => f.rejectDraft(id), (rn: string) => `Your human said no to #${rn} (Don't make it). Nothing was made, and this chat is in no new room. Don't ask for the room again unless your human asks.`],
  ["expired", (id: string) => (f.drafts.get(id)!.expires = Date.now() - 1000), (rn: string) => `The draft for #${rn} expired: your human didn't confirm it within 15 minutes. Nothing was made. If your human still wants the room, ask for it again: that gives a new link and a new code.`],
  ["gone (swept)", (id: string) => f.sweepDraft(id), (rn: string) => `The draft for #${rn} is gone: it expired, or a wrong code was typed 5 times, which closes it. Nothing was made. Tell your human; if they still want the room, ask for it again: that gives a new link and a new code.`],
  ["closed after wrong codes", (id: string) => f.closeDraft(id), (rn: string) => `The draft for #${rn} is gone: it expired, or a wrong code was typed 5 times, which closes it. Nothing was made. Tell your human; if they still want the room, ask for it again: that gives a new link and a new code.`],
] as const) {
  test(`join --wait on a draft that was ${label}: exit 4, a plain text, keys deleted, the record gone`, async () => {
    const h = newHome("rt-end");
    await on(h, async () => {
      const s = S();
      const rn = roomName("end");
      const r = await core.createRoom(args(rn, s, h));
      end(r.req.id);
      const x = await cli(["join", "--wait", "--max-s", "2", "--app", "claude-code", "--session", s]);
      assert.equal(x.code, 4, x.text);
      assert.equal(x.text.trim(), says(rn));
      assert.ok(keyGone(r.req.key_id));
      assert.equal(st.loadRequest(r.req.id), null);
      assertCopy(x.text);
    });
  });
}

// ------------------------------------------------------------------ the self-check for a created room
test("self-check passes only for this chat's own member_add (its keys, the draft's member id and name) signed by the owner's device, in a roster from genesis", async () => {
  const adam = await f.account("Adam");
  const h = newHome("rt-sc-ok");
  await on(h, async () => {
    const s = S();
    const rn = roomName("scok");
    const r = await core.createRoom(args(rn, s, h));
    const room = f.confirmDraft(r.req.id, adam);
    const w = await wait(s, h);
    assert.equal(w.status, "approved", w.text);
    const e = decodeEntry(room.entries[1]);
    assert.equal(e.op, "member_add");
    assert.equal(e.by, adam.device.pk);
  });
});

const TOOK_BACK_LEFT = /This approval does not match this chat's key, so bot-link did not use it\. Nothing was joined: this chat is not a member of #[a-z0-9-]+, and its keys for this request were deleted\. bot-link took planner out of #[a-z0-9-]+ again, signed with this chat's key/;
for (const [label, confirm, took] of [
  ["another person of the room signs the member_add for their own account (signer not a device of the owner)", async (id: string, adam: any) => f.confirmDraft(id, adam, { by: await f.account("Eve") }), "left"],
  ["the member_add has another name than the draft's", async (id: string, adam: any) => f.confirmDraft(id, adam, { name: "someone" }), "left"],
  ["the roster does not verify from genesis", async (id: string, adam: any) => f.brokenRoster.add(f.confirmDraft(id, adam).id), "left"],
  ["the member_add carries other keys", async (id: string, adam: any) => {
    const k = (await import("../src/crypto.js")).genKeys();
    return f.confirmDraft(id, adam, { keys: { ed: k.ed, x: k.x } });
  }, "not_ours"],
] as const) {
  test(`self-check fails: ${label} -> refused, taken back, keys deleted, said so`, async () => {
    const adam = await f.account("Adam");
    const h = newHome("rt-sc-bad");
    await on(h, async () => {
      const s = S();
      const r = await core.createRoom(args(roomName("scbad"), s, h));
      await confirm(r.req.id, adam);
      const w = await wait(s, h);
      assert.equal(w.status, "mismatch", w.text);
      assert.equal(st.liveMembers().length, 0, "the chat did not become a member");
      assert.ok(keyGone(r.req.key_id), "keys deleted");
      assert.equal(st.loadRequest(r.req.id), null);
      const mem = f.members.get(f.drafts.get(r.req.id)!.member_id)!;
      if (took === "left") {
        assert.match(w.text, TOOK_BACK_LEFT);
        assert.equal(mem.removed, true, "the member made with this chat's key left again");
      } else {
        assert.match(w.text, /bot-link could not take it back \(the server holds another key for it\)/);
      }
      assert.match(w.text, /Don't join again, and don't try another name, until your human has looked at it\./);
      assertCopy(w.text);
    });
  });
}

test("take-back of a draft: cancel deletes it while open (204); confirmed meanwhile (409 already_decided) it leaves with DELETE /api/v1/me", async () => {
  const { takeBack } = await import("../src/joinend.js");
  const adam = await f.account("Adam");
  const h = newHome("rt-takeback");
  await on(h, async () => {
    const open = await core.createRoom(args(roomName("tbo"), S(), h));
    assert.equal(await takeBack(open.req, core.apiFor(open.req.server), core.signerOf(open.req), { approved: false, ourKey: true }), "withdrawn");
    assert.equal(f.drafts.has(open.req.id), false, "the open draft is gone");
    const done = await core.createRoom(args(roomName("tbc"), S(), h));
    f.confirmDraft(done.req.id, adam);
    assert.equal(await takeBack(done.req, core.apiFor(done.req.server), core.signerOf(done.req), { approved: false, ourKey: true }), "left");
    assert.equal(f.members.get(f.drafts.get(done.req.id)!.member_id)!.removed, true);
  });
});

// ------------------------------------------------------------------ invite_link
async function joined(owner: any, room: any, who: any, name: string, h: string) {
  return on(h, async () => {
    const s = S();
    const r = await core.joinCreate({ invite: `http://localhost:8811/i/${f.invite(room, who)}`, name, job: "helps", app: "claude-code", turn: "on_turn", session: s, cwd: h, folder: "~", machine: "m" });
    f.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 3000, app: "claude-code", session: s, cwd: h });
    assert.equal(w.status, "approved", w.text);
    return { m: (w as any).member as st.MemberRec, s };
  });
}

test("invite-link: the owner's chat gets the room's chat invite and one line saying the owner approves each chat that uses it", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, roomName("inv"));
  const h = newHome("rt-inv");
  const { m, s } = await joined(adam, room, adam, "lead", h);
  await on(h, async () => {
    const code = f.inviteRow(room, adam)!.code;
    const out = await core.inviteLink(m, s);
    const lines = out.split("\n");
    assert.match(lines[0], new RegExp(`^Invite link for #${room.name} \\(works until \\d\\d:\\d\\d UTC on \\d{1,2} [A-Z][a-z]{2}\\): http://localhost:8811/i/${room.name}-${code}$`));
    assert.equal(lines[1], `This link lets a chat ask to join #${room.name}; Adam approves each one on the dashboard.`);
    assert.equal(lines.length, 2);
    const c = await cli(["invite-link", "--as", "lead", "--session", s]);
    assert.equal(c.code, 0, c.text);
    assert.ok(c.text.startsWith(`Invite link for #${room.name}`), c.text);
    assertCopy(out);
  }, { BOTLINK_APP: "claude-code" });
});

test("invite-link refusals: not the owner's chat, the invite turned off, the invite expired, asked too often", async () => {
  const adam = await f.account("Adam");
  const eve = await f.account("Eve");
  const room = await f.room(adam, roomName("invno"));
  f.addPerson(room, adam, eve);
  const he = newHome("rt-inv-eve");
  const { m: em, s: es } = await joined(adam, room, eve, "evebot", he);
  await on(he, async () => {
    await assert.rejects(core.inviteLink(em, es), (e: any) => {
      assert.equal(e.message, `Only the room owner's chats get the invite link of #${room.name}. evebot is Eve's chat, and Eve doesn't own #${room.name}, so there is no link for it. To bring in another chat, ask the room's owner for an invite.`);
      return true;
    });
  });
  const ha = newHome("rt-inv-adam");
  const { m, s } = await joined(adam, room, adam, "lead", ha);
  await on(ha, async () => {
    const row = f.inviteRow(room, adam)!;
    row.off = true;
    await assert.rejects(core.inviteLink(m, s), (e: any) => {
      assert.equal(e.message, `The chat invite of #${room.name} is turned off, so bot-link has no link to give. Adam turns it on again on the room page of the dashboard; then ask again.`);
      return true;
    });
    row.off = false;
    row.expires = Date.now() - 1000;
    await assert.rejects(core.inviteLink(m, s), (e: any) => {
      assert.equal(e.message, `The chat invite of #${room.name} has expired (an invite lasts 24 hours). Adam renews it on the room page of the dashboard (Renew); then ask again.`);
      return true;
    });
    row.expires = Date.now() + 3600_000;
    for (let i = 0; i < 6; i++) await core.inviteLink(m, s).catch(() => "");
    const t0 = Date.now();
    await assert.rejects(core.inviteLink(m, s), (e: any) => {
      assert.match(e.message, /^This chat asked for the invite link too often \(6 times an hour per chat, 20 per room\)\. Try again in about 30 minutes \(after \d\d:\d\d UTC\)\.$/);
      return true;
    });
    assert.ok(Date.now() - t0 < 5000, "not retried for a minute");
  });
});

// ------------------------------------------------------------------ the outgoing check: a draft link never goes to a room
test("outgoing check: a room message that carries a draft link (or a local draft's code) is stopped with a plain reason; nothing leaves", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, roomName("leak"));
  const h = newHome("rt-leak");
  const { m: other } = await joined(adam, room, adam, "other", newHome("rt-leak-o"));
  void other;
  const { m, s } = await joined(adam, room, adam, "talker", h);
  await on(h, async () => {
    const id = "0193b2c4-1111-7222-8333-444455556666";
    assert.equal(draftLinkIn(`please open https://app.botlink.dev/create/${id} and type the code`), `https://app.botlink.dev/create/${id}`);
    assert.equal(draftLinkIn(`see app.botlink.dev/create/${id.toUpperCase()}`), `app.botlink.dev/create/${id.toUpperCase()}`);
    assert.equal(draftLinkIn("the create/ folder and https://app.botlink.dev/approve/" + id), null);
    const sent = f.messages.size;
    for (const text of [`Confirm it here: http://localhost:8811/create/${id}`, `link: https://app.botlink.dev/create/${id}`]) {
      await assert.rejects(core.send(m, { to: "room", text, intent: "fyi" }, s), (e: any) => {
        assert.equal(e.message, core.DRAFT_STOPPED);
        return true;
      });
    }
    // the code of a draft this computer has open
    const r = await core.createRoom(args(roomName("leakd"), S(), h, "drafter"));
    await assert.rejects(core.send(m, { to: "room", text: `the code is ${core.groupCode(r.req.match_code)}`, intent: "fyi" }, s), (e: any) => e.message === core.DRAFT_STOPPED);
    await assert.rejects(core.send(m, { to: "room", text: `code ${r.req.match_code.toLowerCase()}`, intent: "fyi" }, s), (e: any) => e.message === core.DRAFT_STOPPED);
    assert.equal(f.messages.size, sent, "nothing left this computer");
    assert.match(core.DRAFT_STOPPED, /^bot-link did not send this: it carries the link or the code for confirming a new room\. They are only for your human, in this chat; never put them in a room message\. Nothing left this computer\. Send it again without them\.$/);
    // an ordinary message still goes
    await core.send(m, { to: "room", text: "the approve page is at /approve/ and the create/ folder is new", intent: "fyi" }, s);
    assert.equal(f.messages.size, sent + 1);
  });
});

// ------------------------------------------------------------------ the tools as the model sees them; the docs list them
test("MCP: create_room and invite_link with their schemas; the descriptions carry the rules (only when asked, only to your human, never in a room message)", async () => {
  const home = newHome("rt-mcp-list");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp", "--app", "claude-code"],
    cwd: home,
    env: { ...(process.env as Record<string, string>), HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, CLAUDE_CODE_SESSION_ID: S() },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  let list: any[];
  try {
    list = (await client.listTools()).tools;
  } finally {
    await client.close();
  }
  const cr = list.find((t) => t.name === "create_room")!;
  const il = list.find((t) => t.name === "invite_link")!;
  assert.ok(cr && il, list.map((t) => t.name).join(", "));
  assert.deepEqual(Object.keys(cr.inputSchema.properties).sort(), ["app_name", "as", "job", "name", "purpose", "session"]);
  assert.deepEqual([...(cr.inputSchema.required || [])].sort(), ["as", "job", "name", "purpose"]);
  assert.deepEqual(Object.keys(il.inputSchema.properties).sort(), ["as", "room", "session"]);
  assert.deepEqual(il.inputSchema.required ?? [], []);
  assert.equal(cr.description, ROOM_TOOL_TEXT.create_room);
  assert.equal(il.description, ROOM_TOOL_TEXT.invite_link);
  for (const d of [cr.description, il.description]) {
    assert.match(d, /only to your human/);
    assert.match(d, /never put (them|it) in a room message/);
  }
  assert.match(cr.description, /only when your human asked for a room/);
  assert.match(cr.description, /get your human's yes in words first/);
  assert.match(cr.description, /propose the room name, its purpose, this chat's name and its job/);
  // the order (real-app failure 17 Nov): ask, reply with the link and code, end the turn, wait when told it is done
  const order = ["call create_room", "reply to your human with the link and the code", "end your turn", "when your human says they confirmed it, call join with only wait: true"].map((x) => cr.description.indexOf(x));
  assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), `${order} in: ${cr.description}`);
  assert.doesNotMatch(cr.description, SAME_TURN);
  assert.match(il.description, /only when your human asked to bring another of their chats in/);
  // the eval scenarios' words (overseer, 17 Nov): each description has all three
  for (const d of [cr.description, il.description]) assert.ok(/only when your human ask/.test(d) && /only to your human/.test(d) && /never[^.]*room message/.test(d), d);
  assertCopy(cr.description + il.description);
  // the docs a chat reads list every tool the server has, and SPEC §7.5 names each (a new tool without docs fails here)
  const agents = readFileSync(join(REPO, "docs", "agents.md"), "utf-8");
  const spec = readFileSync(join(REPO, "SPEC.md"), "utf-8");
  const s75 = spec.slice(spec.indexOf("### 7.5 MCP tools"), spec.indexOf("### 7.5a"));
  for (const t of list.map((x) => x.name)) {
    assert.match(agents, new RegExp(`^\\| \`${t}[ \`]`, "m"), `docs/agents.md's Tools table has no row for ${t}`);
    assert.ok(s75.includes(`\`${t}\``), `SPEC §7.5 does not name ${t}`);
  }
  for (const cmd of ["botlink create-room", "botlink invite-link"]) assert.ok(agents.includes(cmd), `docs/agents.md shows ${cmd}`);
});
