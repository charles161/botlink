/**
 * Deterministic verification for Client 1.0.5:
 *   1. Same-folder multi-chat hesitation / isolation across OpenCode, Grok Bot, and folder-fallback apps (Hermes/other).
 *   2. Grok Bot 1.0.3 -> 1.0.4 legacy Cursor-joined member compatibility (the operator's live catch, 23 Nov 2026).
 *   3. Clear multi-room context: room purposes surfaced on join #2, status, severalRooms, roster, and inbox.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { startTag } from "../src/session.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");

const KEYS = [
  "OPENCODE",
  "OPENCODE_PID",
  "OPENCODE_SESSION_ID",
  "CURSOR_AGENT",
  "CURSOR_CONVERSATION_ID",
  "GROK_BOT_CLAIM_PRINCIPAL",
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_CONVERSATION_ID",
  "BOTLINK_APP",
  "BOTLINK_SESSION",
  "BOTLINK_WAKE_MEMBER",
  "BOTLINK_LISTEN_MEMBER",
];
const saved: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function setEnv(o: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, o);
}
afterEach(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

function cli(home: string, cwd: string, env: Record<string, string>, ...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const ch = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        BOTLINK_HOME: join(home, ".botlink"),
        BOTLINK_SERVER: f.url,
        BOTLINK_NO_UPDATE: "1",
        BOTLINK_NO_SELFTEST: "1",
        BOTLINK_DEV: "1",
        ...env,
      },
    });
    let out = "";
    ch.stdout.on("data", (b) => (out += b));
    ch.stderr.on("data", (b) => (out += b));
    ch.on("exit", (code) => res({ code, out }));
  });
}

test("OpenCode: 2nd chat in the same folder with a different OPENCODE_SESSION_ID does NOT silently reuse Chat 1's access", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `ociso${Math.floor(Math.random() * 1e4)}`);
  const inv = `${f.url}/i/${f.invite(room, adam)}`;
  const home = newHome("oc-iso");
  const shared = join(home, "shared-repo");
  mkdirSync(shared, { recursive: true });

  // Chat 1 joins with OPENCODE_SESSION_ID=oc-chat-1
  const j1 = await cli(home, shared, { OPENCODE: "1", OPENCODE_SESSION_ID: "oc-chat-1" }, "join", inv, "--name", "oc-alpha", "--job", "chat 1", "--no-setup");
  assert.equal(j1.code, 0, j1.out);
  const req = [...f.joins.values()].find((x) => x.body.name === "oc-alpha")!;
  f.approve(req.id);
  const w1 = await cli(home, shared, { OPENCODE: "1", OPENCODE_SESSION_ID: "oc-chat-1" }, "join", "--wait", "--max-s", "10");
  assert.equal(w1.code, 0, w1.out);

  // Chat 1 itself still resolves cleanly
  const st1 = await cli(home, shared, { OPENCODE: "1", OPENCODE_SESSION_ID: "oc-chat-1" }, "status");
  assert.match(st1.out, /Acting as: oc-alpha/);

  // Chat 2 in the SAME folder with a DIFFERENT OPENCODE_SESSION_ID must NOT reuse oc-alpha
  const st2 = await cli(home, shared, { OPENCODE: "1", OPENCODE_SESSION_ID: "oc-chat-2" }, "status");
  assert.match(st2.out, /Acting as: nobody/, st2.out);
  const in2 = await cli(home, shared, { OPENCODE: "1", OPENCODE_SESSION_ID: "oc-chat-2" }, "inbox");
  assert.notEqual(in2.code, 0, `Chat 2 must not silently read Chat 1's inbox:\n${in2.out}`);
});

test("Grok Bot: 2nd chat in the same folder with a different CURSOR_CONVERSATION_ID does NOT reuse Chat 1's access", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `gbiso${Math.floor(Math.random() * 1e4)}`);
  const inv = `${f.url}/i/${f.invite(room, adam)}`;
  const home = newHome("gb-iso");
  const shared = join(home, "workspace");
  mkdirSync(shared, { recursive: true });

  const env1 = { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "gb-conv-1", GROK_BOT_CLAIM_PRINCIPAL: "p1" };
  const env2 = { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "gb-conv-2", GROK_BOT_CLAIM_PRINCIPAL: "p1" };

  const j1 = await cli(home, shared, env1, "join", inv, "--name", "gb-alpha", "--job", "grok chat 1", "--no-setup");
  assert.equal(j1.code, 0, j1.out);
  const req = [...f.joins.values()].find((x) => x.body.name === "gb-alpha")!;
  f.approve(req.id);
  const w1 = await cli(home, shared, env1, "join", "--wait", "--max-s", "10");
  assert.equal(w1.code, 0, w1.out);

  // Chat 1 works
  assert.match((await cli(home, shared, env1, "status")).out, /Acting as: gb-alpha/);
  assert.equal((await cli(home, shared, env1, "inbox")).code, 0);

  // Chat 2 (different CURSOR_CONVERSATION_ID, same folder) must NOT silently act as gb-alpha
  const st2 = await cli(home, shared, env2, "status");
  assert.match(st2.out, /Acting as: nobody/, st2.out);
  const in2 = await cli(home, shared, env2, "inbox");
  assert.notEqual(in2.code, 0, `Grok Bot Chat 2 must not reuse Chat 1:\n${in2.out}`);
});

test("Grok Bot 1.0.3 -> 1.0.4 legacy upgrade: Cursor-joined member with matching CURSOR_CONVERSATION_ID still works, other chat refused", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `gbleg${Math.floor(Math.random() * 1e4)}`);
  const inv = `${f.url}/i/${f.invite(room, adam)}`;
  const home = newHome("gb-legacy");
  const shared = join(home, "workspace");
  mkdirSync(shared, { recursive: true });

  // Simulate 1.0.3 join as cursor with CURSOR_CONVERSATION_ID
  const oldEnv = { BOTLINK_APP: "cursor", CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "gb-legacy-conv-1" };
  const j = await cli(home, shared, oldEnv, "join", inv, "--name", "bob-old", "--job", "legacy grok", "--no-setup");
  assert.equal(j.code, 0, j.out);
  const req = [...f.joins.values()].find((x) => x.body.name === "bob-old")!;
  f.approve(req.id);
  assert.equal((await cli(home, shared, oldEnv, "join", "--wait", "--max-s", "10")).code, 0);

  // Upgrade to 1.0.4+ (detected grok-bot) with SAME CURSOR_CONVERSATION_ID -> still acts as bob-old!
  const newSame = { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "gb-legacy-conv-1", GROK_BOT_CLAIM_PRINCIPAL: "p1" };
  const stSame = await cli(home, shared, newSame, "status");
  assert.match(stSame.out, /This chat: Grok Bot/, stSame.out);
  assert.match(stSame.out, /Acting as: bob-old/, stSame.out);
  assert.equal((await cli(home, shared, newSame, "inbox")).code, 0);

  // Different CURSOR_CONVERSATION_ID on 1.0.4+ -> still refused!
  const newOther = { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "gb-legacy-conv-2", GROK_BOT_CLAIM_PRINCIPAL: "p1" };
  assert.match((await cli(home, shared, newOther, "status")).out, /Acting as: nobody/);
  assert.notEqual((await cli(home, shared, newOther, "inbox")).code, 0);
});

test("Folder-fallback app (Hermes / other without session): prints hesitation warning when matched by folder only, and refuses when another live process owns it", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `hfiso${Math.floor(Math.random() * 1e4)}`);
  const inv = `${f.url}/i/${f.invite(room, adam)}`;
  const home = newHome("hf-iso");
  const shared = join(home, "shared-repo");
  mkdirSync(shared, { recursive: true });

  const j = await cli(home, shared, { BOTLINK_APP: "other" }, "join", inv, "--name", "hermes-one", "--job", "helper", "--app-name", "Hermes", "--no-setup");
  assert.equal(j.code, 0, j.out);
  const req = [...f.joins.values()].find((x) => x.body.name === "hermes-one")!;
  f.approve(req.id);
  assert.equal((await cli(home, shared, { BOTLINK_APP: "other" }, "join", "--wait", "--max-s", "10")).code, 0);

  // Spawn a harmless live child process that is NOT an ancestor of the CLI process!
  const liveOwner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"]);
  try {
    await on(home, () => {
      const m = st.liveMembers().find((x) => x.name === "hermes-one")!;
      const tag = startTag(liveOwner.pid!);
      st.saveMember({ ...m, origin_pid: { pid: liveOwner.pid!, tag } });
    });

    // Another chat in the same folder while liveOwner is alive must NOT silently reuse hermes-one!
    const stBusy = await cli(home, shared, { BOTLINK_APP: "other" }, "status");
    assert.match(stBusy.out, /Acting as: nobody/, stBusy.out);
    const inBusy = await cli(home, shared, { BOTLINK_APP: "other" }, "inbox");
    assert.notEqual(inBusy.code, 0, `Must refuse silent reuse while another live chat owns it:\n${inBusy.out}`);
    assert.match(inBusy.out, /another running chat|hesitate|confirm with your human|invite/i, inBusy.out);
  } finally {
    liveOwner.kill("SIGTERM");
  }

  // Once origin_pid is dead (earlier chat closed), folder fallback still warns/hesitates clearly on status!
  await on(home, () => {
    const m = st.liveMembers().find((x) => x.name === "hermes-one")!;
    st.saveMember({ ...m, origin_pid: { pid: 99999999, tag: "deadtag" } });
  });
  const stAfter = await cli(home, shared, { BOTLINK_APP: "other" }, "status");
  assert.match(stAfter.out, /matched by folder|no chat id|confirm with your human/i, stAfter.out);
});

test("Multi-room context: join #2, status, severalRooms, roster, and inbox surface each room's purpose and keep contexts clear", async () => {
  const adam = await f.account("Adam");
  const billing = await f.room(adam, `bill${Math.floor(Math.random() * 1e4)}`, "Stripe invoices, refunds, and pricing");
  const infra = await f.room(adam, `infr${Math.floor(Math.random() * 1e4)}`, "Kubernetes clusters, DNS, and deploy rollbacks");
  const invB = `${f.url}/i/${f.invite(billing, adam)}`;
  const invI = `${f.url}/i/${f.invite(infra, adam)}`;
  const home = newHome("multi-ctx");
  const work = join(home, "app");
  mkdirSync(work, { recursive: true });
  const env = { ANTIGRAVITY_AGENT: "1", ANTIGRAVITY_CONVERSATION_ID: "multi-ctx-conv-1" };

  // Join room 1 (#billing)
  assert.equal((await cli(home, work, env, "join", invB, "--name", "ops-bot", "--job", "billing helper", "--no-setup")).code, 0);
  f.approve([...f.joins.values()].find((x) => x.body.name === "ops-bot" && x.room === billing.id)!.id);
  const w1 = await cli(home, work, env, "join", "--wait", "--max-s", "10");
  assert.equal(w1.code, 0, w1.out);
  assert.match(w1.out, /Stripe invoices, refunds, and pricing/, "join #1 should show room purpose");

  // Join room 2 (#infra)
  assert.equal((await cli(home, work, env, "join", invI, "--name", "ops-bot", "--job", "infra helper", "--no-setup")).code, 0);
  f.approve([...f.joins.values()].find((x) => x.body.name === "ops-bot" && x.room === infra.id)!.id);
  const w2 = await cli(home, work, env, "join", "--wait", "--max-s", "10");
  assert.equal(w2.code, 0, w2.out);
  assert.match(w2.out, /Kubernetes clusters, DNS, and deploy rollbacks/, "join #2 should show room purpose");
  assert.match(w2.out, /Stripe invoices, refunds, and pricing/, "join #2 should list the chat's other room with its purpose");
  assert.match(w2.out, /--room/, "join #2 should remind chat to pass --room");

  // status shows BOTH room purposes and names each room in "The room #... sees"
  const stOut = (await cli(home, work, env, "status")).out;
  assert.match(stOut, /Stripe invoices, refunds, and pricing/, stOut);
  assert.match(stOut, /Kubernetes clusters, DNS, and deploy rollbacks/, stOut);
  assert.match(stOut, new RegExp(`The room #${billing.name} sees ops-bot as:`), stOut);
  assert.match(stOut, new RegExp(`The room #${infra.name} sees ops-bot as:`), stOut);

  // send without --room shows BOTH rooms WITH purposes and says --room
  const sendAmb = await cli(home, work, env, "send", "--to", "room", "--text", "hi");
  assert.notEqual(sendAmb.code, 0);
  assert.match(sendAmb.out, /Stripe invoices, refunds, and pricing/, sendAmb.out);
  assert.match(sendAmb.out, /Kubernetes clusters, DNS, and deploy rollbacks/, sendAmb.out);
  assert.match(sendAmb.out, /--room/, sendAmb.out);

  // roster --room billing shows billing's purpose AND mentions the other room (#infra)
  const roB = (await cli(home, work, env, "roster", "--room", billing.name)).out;
  assert.match(roB, /Stripe invoices, refunds, and pricing/, roB);
  assert.match(roB, new RegExp(`#${infra.name}`), roB);
});

test("Property test: interleaved joins, sends, reads, leaves, and restarts across 3 rooms & 2 same-folder chats never leak messages or keys", async () => {
  const adam = await f.account("Adam");
  const rA = await f.room(adam, `pa${Math.floor(Math.random() * 1e4)}`, "Room A payments");
  const rB = await f.room(adam, `pb${Math.floor(Math.random() * 1e4)}`, "Room B infra");
  const rC = await f.room(adam, `pc${Math.floor(Math.random() * 1e4)}`, "Room C security");
  const invs = { A: `${f.url}/i/${f.invite(rA, adam)}`, B: `${f.url}/i/${f.invite(rB, adam)}`, C: `${f.url}/i/${f.invite(rC, adam)}` };
  const rooms = { A: rA, B: rB, C: rC };
  const home = newHome("prop-iso");
  const shared = join(home, "shared-monorepo");
  mkdirSync(shared, { recursive: true });

  // Two distinct chats in the SAME folder (chat1 in A+B, chat2 in B+C), plus 3 room-local peers (one per room)
  const S1 = "prop-chat-1-aaaa";
  const S2 = "prop-chat-2-bbbb";
  const joinOne = async (session: string, roomKey: "A" | "B" | "C", name: string) => {
    const r = await on(home, () => core.joinCreate({ invite: invs[roomKey], name, job: `job ${name}`, app: "antigravity", turn: "on_turn", session, cwd: shared, folder: "~/shared-monorepo", machine: "box" }));
    f.approve(r.req.id);
    const w = await on(home, () => core.joinWait({ id: r.req.id, maxMs: 5000, app: "antigravity", session, cwd: shared }));
    assert.equal(w.status, "approved", w.text);
    return (w as any).member as st.MemberRec;
  };

  const c1A = await joinOne(S1, "A", "c1-a");
  const c1B = await joinOne(S1, "B", "c1-b");
  const c2B = await joinOne(S2, "B", "c2-b");
  const c2C = await joinOne(S2, "C", "c2-c");
  const pA = await joinOne("peer-a-1111", "A", "peer-a");
  const pB = await joinOne("peer-b-2222", "B", "peer-b");
  const pC = await joinOne("peer-c-3333", "C", "peer-c");

  // Deterministic PRNG over 24 interleaved sends/reads/heldBy checks across all 3 rooms & 2 same-folder chats
  let seed = 0x5eed105;
  const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff);
  const canaries = { A: [] as string[], B1: [] as string[], B2: [] as string[], C: [] as string[] };

  for (let step = 0; step < 18; step++) {
    const pick = Math.floor(next() * 4);
    const tag = `PROP-CANARY-S${step}-${pick}`;
    if (pick === 0) {
      canaries.A.push(tag);
      await on(home, () => core.send(pA, { to: "c1-a", text: `for A only ${tag}`, intent: "fyi" }, "peer-a-1111"));
    } else if (pick === 1) {
      canaries.B1.push(tag);
      await on(home, () => core.send(pB, { to: "c1-b", text: `for B/c1 only ${tag}`, intent: "fyi" }, "peer-b-2222"));
    } else if (pick === 2) {
      canaries.B2.push(tag);
      await on(home, () => core.send(pB, { to: "c2-b", text: `for B/c2 only ${tag}`, intent: "fyi" }, "peer-b-2222"));
    } else {
      canaries.C.push(tag);
      await on(home, () => core.send(pC, { to: "c2-c", text: `for C only ${tag}`, intent: "fyi" }, "peer-c-3333"));
    }
  }

  // Verify heldBy strict separation in the SAME folder
  await on(home, () => {
    const h1 = core.heldBy(S1, { app: "antigravity", folders: [shared] });
    const h2 = core.heldBy(S2, { app: "antigravity", folders: [shared] });
    assert.deepEqual(h1.map((m) => m.name).sort(), ["c1-a", "c1-b"]);
    assert.deepEqual(h2.map((m) => m.name).sort(), ["c2-b", "c2-c"]);
    // Cross-chat action is strictly forbidden even in the same folder
    assert.equal(core.mayActAs(c2B, S1, "antigravity"), false);
    assert.equal(core.mayActAs(c1B, S2, "antigravity"), false);
    assert.equal(core.mayActAs(c2C, S1, "antigravity"), false);
  });

  // Read Chat 1's inbox across all its rooms: MUST contain A + B1 canaries, NEVER B2 or C!
  const in1 = await on(home, () => core.inboxText([c1A, c1B], S1, false));
  for (const t of [...canaries.A, ...canaries.B1]) assert.ok(in1.includes(t), `Chat 1 missed ${t}`);
  for (const t of [...canaries.B2, ...canaries.C]) assert.ok(!in1.includes(t), `Chat 1 leaked ${t}`);

  // Read Chat 2's inbox across all its rooms: MUST contain B2 + C canaries, NEVER A or B1!
  const in2 = await on(home, () => core.inboxText([c2B, c2C], S2, false));
  for (const t of [...canaries.B2, ...canaries.C]) assert.ok(in2.includes(t), `Chat 2 missed ${t}`);
  for (const t of [...canaries.A, ...canaries.B1]) assert.ok(!in2.includes(t), `Chat 2 leaked ${t}`);

  // Leave c1A from Room A, verify Chat 1 still holds ONLY Room B and Chat 2 is untouched
  await on(home, () => core.leave(c1A, S1));
  await on(home, () => {
    const h1After = core.heldBy(S1, { app: "antigravity", folders: [shared] });
    const h2After = core.heldBy(S2, { app: "antigravity", folders: [shared] });
    assert.deepEqual(h1After.map((m) => m.room.id), [rooms.B.id]);
    assert.deepEqual(h2After.map((m) => m.name).sort(), ["c2-b", "c2-c"]);
  });
});
