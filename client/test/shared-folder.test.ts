/**
 * Hotfix (2026-11-06, live): a Cursor chat and a Claude Code chat joined from the SAME folder on one computer.
 *   1. Cursor's MCP server has no chat id: its tools find this chat's member by app + folder (never another app's).
 *   2. The CLI run from Cursor's terminal acts as the Cursor member, not the Claude Code one; status marks it.
 *   3. A chat whose app hasn't loaded the bot-link tools yet gets the exact CLI commands (join text, hooks, render).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { tools } from "../src/mcp.js";
import { appFromEnv } from "../src/session.js";
import { renderBatch } from "../src/render.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake, assertCopy } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let f: FakeServer;
before(async () => {
  assertIsolated();
  assert.ok(existsSync(CLI), "build first (npm test builds)");
  f = await startFake();
});
after(async () => f.stop());

const SMAC = "aaaaaaaa-2222-4333-8444-000000000001";
const SSD = "bbbbbbbb-2222-4333-8444-000000000002";
/** the Cursor chat that joined as acme-cursor (its shell had CURSOR_CONVERSATION_ID) */
const CUR_CHAT = "cccccccc-2222-4333-8444-000000000009";

/** Founder's Mac: acme-cursor (Cursor, holds no session) + acme-mac (Claude Code, holds SMAC), both in <home>/bunny. study-app elsewhere. */
async function mac() {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `mk${Math.floor(Math.random() * 1e6)}`);
  const home = newHome("mac");
  const bunny = join(home, "mj", "bunny");
  mkdirSync(bunny, { recursive: true });
  const other = newHome("sd");
  const join1 = async (h: string, cwd: string, name: string, app: st.App, session: string | null) =>
    on(h, async () => {
      const r = await core.joinCreate({ invite: f.invite(room, adam), name, job: `${name} job`, app, turn: "on_turn", session, cwd, folder: "~/mj/bunny", machine: "mac" });
      f.approve(r.req.id);
      return (await core.joinWait({ maxMs: 3000 })) as any;
    });
  process.env.CURSOR_CONVERSATION_ID = CUR_CHAT;
  let wc: any;
  try {
    wc = await join1(home, bunny, "acme-cursor", "cursor", null);
  } finally {
    delete process.env.CURSOR_CONVERSATION_ID;
  }
  const wm = await join1(home, bunny, "acme-mac", "claude-code", SMAC);
  const ws = await join1(other, other, "study-app", "claude-code", SSD);
  for (const w of [wc, wm, ws]) assert.equal(w.status, "approved", w.text);
  return { home, bunny, other, cursor: wc.member as st.MemberRec, macM: wm.member as st.MemberRec, sd: ws.member as st.MemberRec, joinText: wc.text as string };
}

function cli(home: string, cwd: string, env: Record<string, string>, ...args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (/^(CLAUDE|CODEX|CURSOR)/.test(k)) delete base[k];
    const ch = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...base, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, ...env } });
    let stdout = "", stderr = "";
    ch.stdout.on("data", (b) => (stdout += b));
    ch.stderr.on("data", (b) => (stderr += b));
    ch.on("exit", (status) => res({ status, stdout, stderr }));
  });
}

const inboxOf = (home: string, app: st.App, session: string) => on(home, () => tools({ app, session: () => session }).inbox({}));

test("H2: Cursor MCP tools can't tell which Cursor chat calls: they ask for `as` (no names); `as` or the chat's id picks it; never another app's", async () => {
  const { home, bunny, other } = await mac();
  // Cursor's MCP server: no chat id. It never assumes the folder's Cursor member (a field test T11)
  // (as the real server: the tool's own `session` argument wins, else Cursor's MCP server knows none)
  const t = tools({ app: "cursor", session: (x?: string | null) => x ?? null, roots: async () => [bunny] } as any);
  const why = await on(home, () => t.send({ to: "study-app", text: "hi from cursor", intent: "fyi" }).catch((e: Error) => e.message));
  assert.match(why, /bot-link can't tell which Cursor chat this is .* so it won't guess\. If this chat is a bot-link member, say which one with as: <its name>/);
  assert.doesNotMatch(why, /acme-cursor|acme-mac|study-app|#mk/, "no member names");
  const st0 = await on(home, () => t.status({}));
  assert.doesNotMatch(st0, /This chat is acme/, "status never claims a folder member as this chat");
  // explicit: as <name>
  const sent = await on(home, () => t.send({ to: "study-app", text: "hi from cursor", intent: "fyi", as: "acme-cursor" }));
  assertCopy(sent);
  assert.match(sent, /^Passed to study-app/);
  assert.match(await inboxOf(other, "claude-code", SSD), /from: acme-cursor \(Cursor/);
  // explicit: this chat's own id (the chat that joined)
  const viaId = await on(home, () => t.send({ to: "study-app", text: "via chat id", intent: "fyi", session: CUR_CHAT } as any));
  assert.match(viaId, /^Passed to study-app/);
  // another Cursor chat's id is not acme-cursor
  const notMe = await on(home, () => t.send({ to: "study-app", text: "x", intent: "fyi", session: "dddddddd-2222-4333-8444-00000000000e" } as any).catch((e: Error) => e.message));
  assert.match(notMe, /can't tell which Cursor chat this is/);
  // inbox with as: a message to acme-cursor lands there, not in acme-mac
  await on(other, () => core.send(st.liveMembers()[0], { to: "acme-cursor", text: "ping cursor", intent: "question" }, SSD));
  const cin = await on(home, () => t.inbox({ as: "acme-cursor" }));
  assert.match(cin, /1 new message for acme-cursor/);
  assert.match(cin, /ping cursor/);
  // never another app's member, even by name
  const bad = await on(home, () => t.send({ to: "study-app", text: "x", intent: "fyi", as: "acme-mac" }).catch((e: Error) => e.message));
  assert.match(bad, /acme-mac is a Claude Code member; this chat is Cursor/);
});

test("bug 1: several Cursor members in different folders and no folder info -> ask for `as`; `as` picks it", async () => {
  const { home, cursor } = await mac();
  // a second Cursor member on this computer, another folder
  const proj = join(home, "proj2");
  mkdirSync(proj, { recursive: true });
  const room2 = await f.room(await f.account("Adam"), `mk2${Math.floor(Math.random() * 1e6)}`);
  await on(home, async () => {
    const r = await core.joinCreate({ invite: f.invite(room2, f.accounts.get(room2.owner)!), name: "other-cursor", job: "", app: "cursor", turn: "on_turn", session: null, cwd: proj, folder: "~/proj2", machine: "mac" });
    f.approve(r.req.id);
    assert.equal((await core.joinWait({ maxMs: 3000 })).status, "approved");
  });
  const t = tools({ app: "cursor", session: () => null });
  const why = await on(home, () => t.roster({}).catch((e: Error) => e.message));
  assert.match(why, /can't tell which Cursor chat this is/);
  assert.doesNotMatch(why, /acme-cursor|other-cursor/, "M5: no member names");
  const r = await on(home, () => t.roster({ as: "acme-cursor" }));
  assert.match(r, /acme-cursor/);
  void cursor;
});

test("bug 2: CLI in Cursor's terminal (shared folder) acts as the Cursor member; status marks it; send/reply/inbox take --as", async () => {
  const { home, bunny, other } = await mac();
  const CUR = { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: CUR_CHAT };
  // H2: another Cursor chat in the same folder is not acme-cursor
  const s2 = await cli(home, bunny, { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "dddddddd-2222-4333-8444-00000000000e" }, "status");
  assert.match(s2.stdout, /Acting as: nobody/);
  const s = await cli(home, bunny, CUR, "status");
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /This chat: Cursor · .*bunny\nActing as: acme-cursor in #/);
  assert.match(s.stdout, /^\* acme-cursor in #mk\d+ · Cursor · ~\/mj\/bunny · used by this chat/m);
  assert.match(s.stdout, /^ {2}acme-mac in #mk\d+ · Claude Code \(another app: not this chat\) · ~\/mj\/bunny · used by another chat/m);
  // send without --as: the Cursor member
  const snd = await cli(home, bunny, CUR, "send", "--to", "study-app", "--text", "cli from cursor", "--intent", "question");
  assert.equal(snd.status, 0, snd.stderr);
  const got = await inboxOf(other, "claude-code", SSD);
  assert.match(got, /from: acme-cursor \(Cursor/);
  const id = got.match(/id: ([0-9a-f-]{36})/)![1];
  // study-app answers; the Cursor CLI reads its inbox and replies
  await on(other, () => core.reply(SSD, id, "answer for cursor"));
  const inb = await cli(home, bunny, CUR, "inbox");
  assert.equal(inb.status, 0, inb.stderr);
  assert.match(inb.stdout, /for acme-cursor/);
  assert.match(inb.stdout, /answer for cursor/);
  const back = inb.stdout.match(/id: ([0-9a-f-]{36})/)![1];
  const rep = await cli(home, bunny, CUR, "reply", back, "--text", "thanks");
  assert.equal(rep.status, 0, rep.stderr + rep.stdout);
  assert.match(await inboxOf(other, "claude-code", SSD), /from: acme-cursor[\s\S]*thanks/);
  // the Claude Code chat in the same folder still resolves to acme-mac (its session)
  const cc = await cli(home, bunny, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: SMAC }, "status");
  assert.match(cc.stdout, /Acting as: acme-mac in #/);
  assert.match(cc.stdout, /^\* acme-mac/m);
  // --as works the same on inbox / reply / send (study-app's case: tools not loaded)
  await on(home, () => core.send(st.liveMembers().find((m) => m.name === "acme-mac")!, { to: "study-app", text: "q for sd", intent: "question" }, SMAC));
  // r2: study-app's own chat (its session), not just any terminal
  const SDENV = { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: SSD };
  const sdIn = await cli(other, other, SDENV, "inbox", "--as", "study-app");
  assert.equal(sdIn.status, 0, sdIn.stderr);
  const qid = sdIn.stdout.match(/id: ([0-9a-f-]{36})/)![1];
  const sdRep = await cli(other, other, SDENV, "reply", qid, "--as", "study-app", "--text", "on it");
  assert.equal(sdRep.status, 0, sdRep.stderr + sdRep.stdout);
  assert.match(await inboxOf(home, "claude-code", SMAC), /from: study-app[\s\S]*on it/);
});

test("bug 2: appFromEnv precedence (Cursor agent > Claude Code > Codex; user settings are not signals)", () => {
  assert.equal(appFromEnv({ CURSOR_AGENT: "1", CURSOR_TRACE_ID: "x" }), "cursor");
  assert.equal(appFromEnv({ CURSOR_CONVERSATION_ID: "c" }), "cursor");
  assert.equal(appFromEnv({ CLAUDECODE: "1", CURSOR_TRACE_ID: "x" }), "claude-code", "Claude Code started inside Cursor's terminal");
  assert.equal(appFromEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" }), "claude-code");
  assert.equal(appFromEnv({ CODEX_THREAD_ID: "t" }), "codex");
  assert.equal(appFromEnv({ CODEX_SANDBOX: "seatbelt" }), "codex");
  assert.equal(appFromEnv({ CODEX_HOME: "/x", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_EFFORT_LEVEL: "high" }), null);
});

test("bug 3: join, the SessionStart line and every rendered batch give the exact CLI fallback (--as <name>)", async () => {
  const { home, bunny, joinText } = await mac();
  assertCopy(joinText);
  assert.match(joinText, /If this chat doesn't have the bot-link tools yet \(they load when the app restarts\), use the command line as acme-cursor: `.+ inbox --as acme-cursor` · `.+ send --as acme-cursor --to <member or room> --intent question --text "\.\.\."` · `.+ reply <message id> --as acme-cursor --text "\.\.\."`\./);
  const r = renderBatch({ room: "r", member: "acme-mac", person: "Adam", messages: [{ id: "0190b1a2-0000-7000-8000-000000000001", from: "x", from_name: "sd", from_app: "claude-code", from_account_name: "Adam", intent: "task", sent_at: 1, needed_by: null, in_reply_to: null, to_room: false, text: "t", redelivered: false, sender_moved: false } as any], notes: [], rules: [], unattended: false });
  assert.match(r, /if this chat has no bot-link tools yet, run `.+ reply <message id> --as acme-mac --text "\.\.\."`/);
  assertCopy(r);
  // SessionStart for the Claude Code chat: its identity line names the CLI fallback, and only acme-mac (not the Cursor member)
  const out = await new Promise<string>((res) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (/^(CLAUDE|CODEX|CURSOR)/.test(k)) delete base[k];
    const ch = spawn(process.execPath, [CLI, "hook", "claude-code", "session-start"], { cwd: bunny, env: { ...base, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url } });
    let o = "";
    ch.stdout.on("data", (b) => (o += b));
    ch.stdin.end(JSON.stringify({ session_id: SMAC, cwd: bunny, hook_event_name: "SessionStart" }));
    ch.on("exit", () => res(o));
  });
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
  assert.match(ctx, /this chat is acme-mac in #mk\d+\. No new messages\./);
  assert.ok(!ctx.includes("acme-cursor"), ctx);
  assert.match(ctx, /inbox --as acme-mac/);
});

test("bug 1/hooks: a NEW Claude Code session in the shared folder never takes the Cursor member's messages", async () => {
  const { home, bunny, other } = await mac();
  await on(other, () => core.send(st.liveMembers()[0], { to: "acme-cursor", text: "for cursor only", intent: "fyi" }, SSD));
  const out = await new Promise<string>((res) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (/^(CLAUDE|CODEX|CURSOR)/.test(k)) delete base[k];
    const ch = spawn(process.execPath, [CLI, "hook", "claude-code", "prompt"], { cwd: bunny, env: { ...base, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url } });
    let o = "";
    ch.stdout.on("data", (b) => (o += b));
    ch.stdin.end(JSON.stringify({ session_id: "dddddddd-2222-4333-8444-00000000000d", cwd: bunny, prompt: "hello" }));
    ch.on("exit", () => res(o));
  });
  assert.ok(!out.includes("for cursor only"), out);
  assert.ok(!out.includes("acme-cursor"), out);
  // still waiting for the Cursor chat
  const cin = await on(home, () => tools({ app: "cursor", session: () => null }).inbox({ as: "acme-cursor" }));
  assert.match(cin, /for cursor only/);
});
