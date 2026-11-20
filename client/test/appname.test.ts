// A chat may name its own app, and that name wins (founder's decision, 17 Nov 2026). A Grok Bot chat carries Cursor's
// marks, so bot-link detects it as Cursor and the dashboard showed "Cursor". There is no Grok Bot-only mark to detect,
// so the chat (or its person) says which app it is: `--app-name "Grok Bot"` / `app_name`. The request then goes out as
// app "other" with that name (ENVELOPE §5.2), and the chat is never offered the detected app's own wake paths (watch's
// cursor-agent resume, "bot-link's hooks are set up for this app"). Its name equal to the detected app's own name
// changes nothing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { tools } from "../src/mcp.js";
import { restartLine } from "../src/cli.js";
import { wakeTarget } from "../src/watch.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

let n = 0;
const rn = (p: string) => `${p}${++n}${Math.floor(Math.random() * 1e4)}`;
async function invite(label: string) {
  const adam = await f.account("Adam");
  const room = await f.room(adam, rn(label));
  return { adam, room, url: `http://localhost:8811/i/${f.invite(room, adam)}` };
}
const lastJoin = (name: string) => [...f.joins.values()].filter((j) => j.body.name === name).pop()!;

test("detected Cursor + app name \"Grok Bot\": the join goes out as app other with that name; the chat is never offered Cursor's wake paths", async () => {
  const { url } = await invite("grok");
  const h = newHome("an-grok");
  await on(h, async () => {
    // (wakeReady and turn as the surfaces compute them for a Cursor chat with watch installed: the claim must undo both)
    const r = await core.joinCreate({ invite: url, name: "grokker", job: "answers", app: "cursor", app_name: "Grok Bot", turn: "wake", session: null, cwd: h, folder: "~", machine: "m", wakeReady: true });
    const j = lastJoin("grokker");
    assert.equal(j.body.app, "other");
    assert.equal(j.body.app_name, "Grok Bot");
    assert.equal(j.body.turn, "on_turn", "not resumed by watch as a Cursor chat");
    assert.equal(r.req.app, "cursor", "locally it stays the chat bot-link found (its commands find it by that)");
    f.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 3000, app: "cursor", session: null, cwd: h, wakeReady: true });
    assert.equal(w.status, "approved", w.text);
    const m = (w as any).member as st.MemberRec;
    assert.equal(m.app_name, "Grok Bot");
    assert.equal(m.turn, "on_turn");
    assert.equal(wakeTarget(m), null, "watch never resumes it with cursor-agent");
    assert.match(w.text, /app: Grok Bot/);
    assert.doesNotMatch(w.text, /app: Cursor|cursor-agent|bot-link's own hooks \(or its watch service\) are already set up/);
    assert.doesNotMatch(w.text, /Wake test: bot-link's hooks \(or watch\) are already set up/);
    // the roster says what the chat claimed
    const ro = await core.rosterText(m, null);
    assert.match(ro, /grokker \(this chat\) · Grok Bot/);
    // its commands still find it as this Cursor-detected chat
    assert.equal(core.pickMember(null, null, "grokker", { app: "cursor" }).id, m.id);
  });
});

test("the detected app's own name (any case, spaces, dashes) changes nothing; no app name changes nothing", async () => {
  const { url } = await invite("same");
  const h = newHome("an-same");
  await on(h, async () => {
    await core.joinCreate({ invite: url, name: "cc-one", job: "j", app: "claude-code", app_name: "claude code", turn: "on_turn", session: "aaaaaaaa-1111-4222-8333-0000000000a1", cwd: h, folder: "~", machine: "m" });
    assert.equal(lastJoin("cc-one").body.app, "claude-code");
    assert.equal("app_name" in lastJoin("cc-one").body, false);
    await core.joinCreate({ invite: url, name: "cc-two", job: "j", app: "claude-code", app_name: "Claude-Code", turn: "on_turn", session: "aaaaaaaa-1111-4222-8333-0000000000a2", cwd: h, folder: "~", machine: "m" });
    assert.equal(lastJoin("cc-two").body.app, "claude-code");
    await core.joinCreate({ invite: url, name: "cur-one", job: "j", app: "cursor", turn: "wake", session: null, cwd: join(h, "c1"), folder: "~", machine: "m" });
    assert.equal(lastJoin("cur-one").body.app, "cursor");
    assert.equal(lastJoin("cur-one").body.turn, "wake");
  });
});

test("MCP join and create_room carry the claimed name the same way; create-room on core too", async () => {
  const { url } = await invite("mcpgrok");
  const h = newHome("an-mcp");
  await on(h, async () => {
    const t = tools({ app: "cursor", session: () => null });
    await t.join({ invite: url, name: "mcpgrok", job: "answers", app_name: "Grok Bot" });
    assert.equal(lastJoin("mcpgrok").body.app, "other");
    assert.equal(lastJoin("mcpgrok").body.app_name, "Grok Bot");
    const out = await t.create_room({ name: rn("grokroom"), purpose: "p", as: "grokroom", job: "j", app_name: "Grok Bot" });
    const id = /\/create\/([0-9a-f-]{36})/.exec(out)![1];
    assert.equal(f.drafts.get(id)!.body.app, "other");
    assert.equal(f.drafts.get(id)!.body.app_name, "Grok Bot");
    assert.equal(f.drafts.get(id)!.body.turn, "on_turn");
    const r = await core.createRoom({ room: rn("same"), purpose: "p", name: "samecc", job: "j", app: "claude-code", app_name: "CLAUDE CODE", turn: "on_turn", session: "aaaaaaaa-1111-4222-8333-0000000000b1", cwd: h, folder: "~", machine: "m" });
    assert.equal(f.drafts.get(r.req.id)!.body.app, "claude-code");
  });
});

test("the command line after such a join: no Cursor set-up line, no Cursor-only path", async () => {
  assert.doesNotMatch(restartLine("cursor", "Grok Bot"), /Cursor/);
  assert.match(restartLine("cursor"), /Cursor/, "a plain Cursor chat keeps its line");
  const { url } = await invite("cligrok");
  const home = newHome("an-cli");
  const { spawn } = await import("node:child_process");
  const r = await new Promise<{ code: number | null; out: string }>((res) => {
    const ch = spawn(process.execPath, [CLI, "join", url, "--name", "cligrok", "--job", "answers", "--app", "cursor", "--app-name", "Grok Bot"], { cwd: home, env: { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink") } });
    let out = "";
    ch.stdout.on("data", (b) => (out += b));
    ch.stderr.on("data", (b) => (out += b));
    ch.on("exit", (code) => res({ code, out }));
  });
  assert.equal(r.code, 0, r.out);
  assert.equal(lastJoin("cligrok").body.app, "other");
  assert.doesNotMatch(r.out, /Cursor/, r.out);
});

// ------------------------------------------------------------------ the claim follows (overseer, 17 Nov 2026)
/** A Claude Code chat that named itself "Hermes", approved, on computer `h`. */
async function labelled(h: string, name: string, label: string | null) {
  const { adam, room, url } = await invite("mv");
  const s = `bbbbbbbb-1111-4222-8333-${String(++n).padStart(12, "0")}`;
  return on(h, async () => {
    const r = await core.joinCreate({ invite: url, name, job: "moves", app: "claude-code", ...(label ? { app_name: label } : {}), turn: "on_turn", session: s, cwd: h, folder: "~", machine: "m" });
    f.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 3000, app: "claude-code", session: s, cwd: h });
    assert.equal(w.status, "approved", w.text);
    return { adam, room, url, s, m: (w as any).member as st.MemberRec };
  });
}

test("a member that named its own app keeps the name when it moves to another chat: the move request and the roster after it", async () => {
  const h = newHome("an-move");
  const { m } = await labelled(h, "hermy", "Hermes");
  const S2 = `bbbbbbbb-1111-4222-8333-${String(++n).padStart(12, "0")}`;
  await on(h, async () => {
    await core.claim("hermy", S2, null, "claude-code", { cwd: h });
    const j = f.joins.get(f.lastMove!)!;
    assert.equal(j.body.app, "other", "the approval card shows the chat's own name");
    assert.equal(j.body.app_name, "Hermes");
    f.approve(f.lastMove!);
    const w = await core.joinWait({ maxMs: 3000, app: "claude-code", session: S2, cwd: h });
    assert.equal(w.status, "approved", w.text);
    const after = st.loadMember(m.id)!;
    assert.equal(after.app_name, "Hermes");
    assert.match(await core.rosterText(after, S2), /hermy \(this chat\) · Hermes/);
  });
});

test("a move to a new computer (claim --invite) keeps the name: from --app-name, or from the room once approved; an unlabelled member is unchanged", async () => {
  const h1 = newHome("an-mv-old");
  const { url } = await labelled(h1, "hermes-two", "Hermes");
  // the new computer passes the name itself
  const h2 = newHome("an-mv-new");
  await on(h2, async () => {
    const r = await core.joinCreate({ kind: "claim", invite: url, name: "hermes-two", job: "", app: "claude-code", app_name: "Hermes", turn: "on_turn", session: "cccccccc-1111-4222-8333-000000000001", cwd: h2, folder: "~", machine: "new" });
    assert.equal(f.joins.get(r.req.id)!.body.app, "other");
    assert.equal(f.joins.get(r.req.id)!.body.app_name, "Hermes");
  });
  // the new computer passes nothing: once approved it takes the name the room shows (it knew none before)
  const h3 = newHome("an-mv-new2");
  const { url: url3, m: m3 } = await labelled(newHome("an-mv-old2"), "hermes-three", "Hermes");
  await on(h3, async () => {
    const r = await core.joinCreate({ kind: "claim", invite: url3, name: "hermes-three", job: "", app: "claude-code", turn: "on_turn", session: "cccccccc-1111-4222-8333-000000000002", cwd: h3, folder: "~", machine: "new" });
    f.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 3000, app: "claude-code", session: "cccccccc-1111-4222-8333-000000000002", cwd: h3 });
    assert.equal(w.status, "approved", w.text);
    assert.equal(st.loadMember(m3.id)!.app_name, "Hermes");
    assert.equal(wakeTarget(st.loadMember(m3.id)!), null);
  });
  // unlabelled: the move request carries the app as before
  const h4 = newHome("an-mv-plain");
  const { m: m4 } = await labelled(h4, "plain", null);
  const S4 = `bbbbbbbb-1111-4222-8333-${String(++n).padStart(12, "0")}`;
  await on(h4, async () => {
    await core.claim("plain", S4, null, "claude-code", { cwd: h4 });
    const j = f.joins.get(f.lastMove!)!;
    assert.equal(j.body.app, "claude-code");
    assert.equal("app_name" in j.body, false);
    void m4;
  });
});
