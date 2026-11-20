/**
 * Launch blocker, staging c5b1c2f, 16 Nov 2026 (a real-user tester, one computer, the real CLI): chat `beta` joined
 * #t-dd2185, its person removed it on the dashboard, `beta` joined the SAME room again under the SAME name and was
 * approved, and then `botlink send --to alpha --as beta` exited 1 with
 *   "beta is a member of several rooms (#t-dd2185, #t-dd2185). Say which one with room."
 * The removed membership was kept on this computer next to the new one (marked `ended`, or never marked at all when
 * the client had not heard of the removal yet), and the name/room resolvers counted both.
 *
 * Rules pinned here: a removed (ended) membership never counts when a chat's member or room is resolved; a re-join of
 * the same room under the same name takes the old record out of the way in the same step (its keys deleted); two
 * records of ONE room never reach "a member of several rooms"; that sentence never lists a room twice.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as L from "../src/listen.js";
import * as W from "../src/watch.js";
import { revive } from "../src/memberend.js";
import * as perms from "../src/perms.js";
import { rulesOf } from "../src/rules.js";
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
const S = () => `77777777-aaaa-4bbb-8ccc-${String(++n).padStart(12, "0")}`;
type Room = Awaited<ReturnType<FakeServer["room"]>>;
type Acct = Awaited<ReturnType<FakeServer["account"]>>;

/** One computer (home h) with chat alpha and chat beta, both Claude Code chats (own sessions), in one room. */
async function world(label: string) {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `t-${label}${Math.floor(Math.random() * 1e6)}`, "p");
  const h = newHome(label);
  const sa = S(), sb = S();
  const alpha = await joinAs(h, room, adam, "alpha", sa);
  const beta = await joinAs(h, room, adam, "beta", sb);
  return { adam, room, h, sa, sb, alpha, beta };
}
async function joinAs(h: string, room: Room, adam: Acct, name: string, session: string): Promise<st.MemberRec> {
  return on(h, async () => {
    const r = await core.joinCreate({ invite: `http://localhost:8811/i/${f.invite(room, adam)}`, name, job: "answers", app: "claude-code", turn: "on_turn", session, cwd: h, folder: "~", machine: "m" });
    f.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 5000, app: "claude-code", session, cwd: h });
    assert.equal(w.status, "approved", w.text);
    return (w as any).member as st.MemberRec;
  });
}
/** the real command line, as the chat's shell runs it (async: the fake server answers from this process) */
function cli(h: string, session: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: h, BOTLINK_HOME: join(h, ".botlink"), BOTLINK_SERVER: f.url, BOTLINK_SESSION: session, BOTLINK_APP: "claude-code" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill("SIGTERM"), 60_000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}
const memberFiles = (h: string) => { try { return readdirSync(join(h, ".botlink", "members")).filter((x) => x.endsWith(".json")); } catch { return []; } };

/** ways the client hears that beta was removed (each marks the record ended), and "it never heard" (stale record) */
type Learn = "inbox" | "listener" | "background-wait" | "send" | "never";
async function learn(how: Learn, w: Awaited<ReturnType<typeof world>>) {
  const { h, sb, beta } = w;
  if (how === "inbox") {
    const r = await cli(h, sb, ["inbox", "--as", "beta"]);
    assert.match(r.out, /beta is no longer a member of #t-\S+: it was removed from the room/, r.out);
  } else if (how === "listener") {
    await on(h, async () => {
      assert.equal(await L.listenOnMessage(st.loadMember(beta.id)!, "true", { say: () => {}, maxMs: 8000, restartWhen: () => false }), 4);
    });
  } else if (how === "background-wait") {
    await on(h, async () => {
      assert.equal(await W.listen([st.loadMember(beta.id)!], { maxMs: 8000, say: () => {} }), 4);
    });
  } else if (how === "send") {
    const r = await cli(h, sb, ["send", "--to", "alpha", "--as", "beta", "--text", "am I still in?"]);
    assert.notEqual(r.code, 0, r.out);
  }
  if (how === "inbox" || how === "listener" || how === "background-wait") {
    assert.equal(await on(h, () => st.loadMember(beta.id)?.ended?.code), "gone", `${how}: the client recorded the removal`);
  }
}

async function rejoin(w: Awaited<ReturnType<typeof world>>): Promise<st.MemberRec> {
  const m = await joinAs(w.h, w.room, w.adam, "beta", w.sb);
  assert.notEqual(m.id, w.beta.id, "the server made a new member for the re-join");
  return m;
}

async function assertSendsAsBeta(w: Awaited<ReturnType<typeof world>>, nb: st.MemberRec, label: string) {
  const from = f.deliveries.length;
  const r = await cli(w.h, w.sb, ["send", "--to", "alpha", "--as", "beta", "--text", `hello again (${label})`]);
  assert.doesNotMatch(r.out, /several rooms/, `${label}: ${r.out}`);
  assert.equal(r.code, 0, `${label}: send --to alpha --as beta exits 0, got ${r.code}: ${r.out}`);
  assert.doesNotMatch(r.out, /no longer a member|Stop acting as beta/, `${label}: the re-joined chat is not told to stop being beta: ${r.out}`);
  assertCopy(r.out);
  const d = f.deliveries.slice(from).filter((x) => x.member === w.alpha.id);
  assert.equal(d.length, 1, `${label}: alpha got exactly one message`);
  assert.equal(d[0].from, nb.id, `${label}: sent as the NEW beta`);
  // no --as either: the chat's own session finds its one member
  const r2 = await cli(w.h, w.sb, ["send", "--to", "alpha", "--text", `and without --as (${label})`]);
  assert.equal(r2.code, 0, `${label}: send without --as: ${r2.out}`);
}

for (const how of ["inbox", "listener", "background-wait", "send", "never"] as Learn[]) {
  test(`removed, learned via ${how}, re-joined with the same name and room: send --to alpha --as beta works, one record, old keys gone`, async () => {
    const w = await world(`rj-${how}`);
    const r0 = await cli(w.h, w.sb, ["send", "--to", "alpha", "--as", "beta", "--text", "first"]);
    assert.equal(r0.code, 0, r0.out);
    f.removeMember(w.beta.id, w.adam);
    await learn(how, w);
    const nb = await rejoin(w);
    await assertSendsAsBeta(w, nb, how);
    await on(w.h, async () => {
      assert.deepEqual(memberFiles(w.h).sort(), [`${w.alpha.id}.json`, `${nb.id}.json`].sort(), "the old record is out of members/");
      assert.equal(existsSync(join(w.h, ".botlink", "keys", `${w.beta.key_id}.json`)), false, "the removed member's secret keys are deleted");
      assert.ok(existsSync(join(w.h, ".botlink", "keys", `${nb.key_id}.json`)), "the new member's keys are there");
      assert.equal(st.takeLost(w.sb).length, 0, "no 'no longer a member' line is left for the chat that joined again");
      assert.deepEqual(await revive(w.sb, [w.h], "claude-code"), [], "revive brings nothing back");
    });
    const status = await cli(w.h, w.sb, ["status"]);
    assert.equal((status.out.match(/^[* ] beta in #/gm) || []).length, 1, `status lists beta once: ${status.out}`);
    if (how !== "send" && how !== "never") assert.match(status.out, /beta in #t-\S+ was removed .* joined #t-\S+ again/, `status says once that the earlier membership was removed: ${status.out}`);
    const again = await cli(w.h, w.sb, ["status"]);
    assert.doesNotMatch(again.out, /was removed .* joined #t-\S+ again/, `said once: ${again.out}`);
  });
}

test("what a re-join keeps of the removed membership: its standing rules and its mutes; not its grants, its history or its files", async () => {
  const w = await world("rj-keep");
  assert.equal((await cli(w.h, w.sb, ["send", "--to", "alpha", "--as", "beta", "--text", "kept in the history"])).code, 0);
  const other = S();
  await on(w.h, () => {
    st.writeJson(st.p("rules", `${w.beta.id}.json`), [{ quote: "never share the staging password", said_by: "Adam", session: w.sb, at: Date.now() }]);
    perms.setPerm(w.beta.id, w.alpha.id, { level: "muted", set_at: Date.now(), how: "terminal" });
    perms.setPerm(w.beta.id, other, { level: "tasks", while_away: true, set_at: Date.now(), how: "terminal" });
    assert.ok(existsSync(join(w.h, ".botlink", "archive", w.beta.id)), "the first membership kept a history");
  });
  f.removeMember(w.beta.id, w.adam);
  await learn("inbox", w);
  const nb = await rejoin(w);
  await on(w.h, () => {
    assert.deepEqual(rulesOf(nb.id).map((r) => r.quote), ["never share the staging password"], "standing rules carry over: they only hold back");
    assert.deepEqual(Object.entries(perms.permsOf(nb.id)).map(([k, v]) => [k, v.level]), [[w.alpha.id, "muted"]], "a mute carries over; a grant (tasks while away) goes back to the default");
    for (const dir of ["archive", "perms", "rules", "rosters", "wakepath", "ledger"]) {
      const left = (() => { try { return readdirSync(join(w.h, ".botlink", dir)).filter((x) => x.startsWith(w.beta.id)); } catch { return []; } })();
      assert.deepEqual(left, [], `nothing under the removed member's id is left in ${dir}/`);
    }
  });
});

test("removed and re-joined twice under the same name: still one beta, send works", async () => {
  const w = await world("rj-twice");
  f.removeMember(w.beta.id, w.adam);
  await learn("inbox", w);
  const nb1 = await rejoin(w);
  f.removeMember(nb1.id, w.adam);
  await learn("listener", { ...w, beta: nb1 });
  const nb2 = await joinAs(w.h, w.room, w.adam, "beta", w.sb);
  assert.notEqual(nb2.id, nb1.id);
  await assertSendsAsBeta(w, nb2, "twice");
  assert.equal(memberFiles(w.h).length, 2, `alpha and the newest beta only: ${memberFiles(w.h)}`);
});

test("the tools (MCP) after a re-join: send, inbox and status with no `as` and no room", async () => {
  const w = await world("rj-mcp");
  f.removeMember(w.beta.id, w.adam);
  await learn("background-wait", w);
  const nb = await rejoin(w);
  await on(w.h, async () => {
    const t = tools({ app: "claude-code", session: () => w.sb });
    const from = f.deliveries.length;
    const s = await t.send({ to: "alpha", text: "via the tools", intent: "fyi" });
    assert.doesNotMatch(s, /several rooms|no longer a member/, s);
    assert.equal(f.deliveries.slice(from).filter((d) => d.member === w.alpha.id && d.from === nb.id).length, 1, s);
    const i = await t.inbox({});
    assert.doesNotMatch(i, /several rooms|no longer a member|Stop acting/, i);
    const stt = await t.status({});
    assert.doesNotMatch(stt, /several rooms/, stt);
    assert.equal((stt.match(/\bbeta in #t-/g) || []).length <= 1, true, stt);
  });
});

test("two records of ONE room and name left on a computer (an older client's leftovers) never reach 'several rooms': the newest one counts", async () => {
  const w = await world("rj-left");
  f.removeMember(w.beta.id, w.adam);
  const nb = await rejoin(w);
  // what a computer that hit the bug holds: the old record written back next to the new one, live-looking and ended
  for (const ended of [null, { at: Date.now() - 1000, code: "gone", text: "beta is no longer a member" }]) {
    await on(w.h, () => st.writeJson(st.memberPath(w.beta.id), { ...w.beta, joined_at: nb.joined_at - 60_000, ended }));
    const r = await cli(w.h, w.sb, ["send", "--to", "alpha", "--as", "beta", "--text", "leftovers"]);
    assert.doesNotMatch(r.out, /several rooms/, r.out);
    assert.equal(r.code, 0, r.out);
    await on(w.h, async () => {
      assert.deepEqual(core.pickMembers(w.sb, null, "beta", { app: "claude-code" }).map((m) => m.id), [nb.id]);
      assert.deepEqual(core.heldBy(w.sb, { app: "claude-code", folders: [w.h] }).map((m) => m.id), [nb.id]);
    });
  }
});

test("two rooms that really are different are still asked about, and the sentence never lists a room twice", async () => {
  const w = await world("rj-two");
  const room2 = await f.room(w.adam, `t-other${Math.floor(Math.random() * 1e6)}`, "p");
  await joinAs(w.h, room2, w.adam, "beta", w.sb);
  const r = await cli(w.h, w.sb, ["send", "--to", "alpha", "--as", "beta", "--text", "which room?"]);
  assert.equal(r.code, 1, r.out);
  const m = /beta is a member of several rooms \(([^)]*)\)/.exec(r.out);
  assert.ok(m, r.out);
  const rooms = m![1].split(", ");
  assert.equal(rooms.length, 2, r.out);
  assert.equal(new Set(rooms).size, rooms.length, `no room listed twice: ${r.out}`);
  assert.equal((await cli(w.h, w.sb, ["send", "--to", "alpha", "--as", "beta", "--room", w.room.name, "--text", "this one"])).code, 0);
});

test("revive never brings back an earlier record of a room and name once a newer membership exists, even when the server still took the old key", async () => {
  const w = await world("rj-revive");
  f.removeMember(w.beta.id, w.adam);
  await learn("inbox", w);
  const nb = await rejoin(w);
  // a wrong mark at its worst: the old record back on disk, ended, and a server that would still accept its key
  f.members.get(w.beta.id)!.removed = false;
  try {
    await on(w.h, async () => {
      st.writeJson(st.memberPath(w.beta.id), { ...w.beta, joined_at: nb.joined_at - 60_000, ended: { at: Date.now(), code: "gone", text: "beta is no longer a member" } });
      assert.deepEqual(await revive(w.sb, [w.h], "claude-code"), []);
      assert.deepEqual(st.liveMembers().filter((m) => m.name === "beta").map((m) => m.id), [nb.id]);
      assert.deepEqual(st.endedMembers().map((m) => m.id), [], "an earlier record of a room and name joined again is not even listed as ended");
    });
  } finally {
    f.members.get(w.beta.id)!.removed = true;
  }
});

test("after a removal, `join --wait` with nothing asked does not say 'already joined' about the membership that was removed", async () => {
  const w = await world("rj-done");
  f.removeMember(w.beta.id, w.adam);
  await learn("inbox", w);
  const r = await cli(w.h, w.sb, ["join", "--wait", "--max-s", "2"]);
  assert.doesNotMatch(r.out, /already joined #t-\S+ as beta/, r.out);
  assert.match(r.out, /no waiting bot-link request/, r.out);
});

// ------------------------------------------------------------------ the choke point, as a check on the sources
test("resolvers read st.liveMembers(): no source reads member records any other way, and ended ones only where the person is told", () => {
  const dir = join(import.meta.dirname, "..", "src");
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const lines = readFileSync(join(dir, f), "utf-8").split("\n");
    lines.forEach((l, i) => {
      const at = `src/${f}:${i + 1}`;
      if (/\ballMembers\b/.test(l)) bad.push(`${at} uses allMembers: use st.liveMembers() (it leaves out members the server ended and earlier records of a room and name joined again; launch blocker c5b1c2f)`);
      if (f !== "state.ts" && (/listJson<\s*(st\.)?MemberRec\s*>/.test(l) || /\bp\(\s*["']members["']/.test(l))) bad.push(`${at} reads members/ directly: use st.liveMembers(), or st.loadMember(id) for one known id`);
      if (f !== "state.ts" && f !== "memberend.ts" && /\b(endedMembers|earlierRecords)\s*\(/.test(l)) bad.push(`${at} lists ended or earlier records: only memberend.ts may (status, the one-time line, revive, replaceEarlier); resolve with st.liveMembers()`);
    });
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});

// The public export leaves evals/ out and says so in .public-export (deploy/public-repo/build-candidate.sh); only there
// is a missing evals/ skipped. In this repository a missing evals/ fails.
const repoRoot = join(import.meta.dirname, "..", "..");
const evalsLeftOut = !existsSync(join(repoRoot, "evals")) && existsSync(join(repoRoot, ".public-export")) &&
  readFileSync(join(repoRoot, ".public-export"), "utf-8").split("\n").some((l) => l.startsWith("evals/\t"));
test("the eval harness and the scenarios' inline scripts call the client's member lookups by names that exist (st.liveMembers())", { skip: evalsLeftOut ? "evals/ is left out of this public export (.public-export)" : false }, () => {
  const root = join(repoRoot, "evals");
  const bad: string[] = [];
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of [...walk(join(root, "harness")), ...walk(join(root, "scenarios"))].filter((x) => /\.(m?[jt]s|ya?ml)$/.test(x))) {
    readFileSync(f, "utf-8").split("\n").forEach((l, i) => {
      if (/\ballMembers\b/.test(l)) bad.push(`${f.slice(root.length - 5)}:${i + 1} uses allMembers, which no longer exists: use st.liveMembers() (members the server ended and earlier records of a room and name are left out; launch blocker c5b1c2f)`);
    });
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});
