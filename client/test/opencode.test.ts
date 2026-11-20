/**
 * Live bug (2026-11-06): an OpenCode chat joined as `sec-research` (app "other", turn listening, no holder). Its
 * listener woke it 5 times but it never read its inbox (server: last_poll_at null, copy stuck "wakes").
 * Cause: bot-link didn't know OpenCode. The chat was recorded as "other", and since 1e337df a CLI / MCP call resolves
 * only the CALLING app's members: the woken OpenCode run inherited a weaker app signal (here: Cursor's terminal,
 * CURSOR_TRACE_ID) and was taken for Cursor, so sec-research ("other") was never "this chat".
 * Fix: (a) OpenCode is detected (OPENCODE=1 / OPENCODE_PID, set by opencode for everything it starts; probed on
 * opencode 1.19.5) and joins as app "opencode" locally (wire: "other" + app_name "OpenCode"); (b) "other" / OpenCode
 * callers resolve by folder (single match), never as a Claude Code / Codex / Cursor member; `--as` overrides;
 * (c) `up --app opencode` writes OpenCode's MCP entry.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as h from "../src/harnesses.js";
import { tools } from "../src/mcp.js";
import { appFromEnv, appsFromEnv, appOfComm } from "../src/session.js";
import { up, uninstallAll } from "../src/setup.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
let f: FakeServer;
before(async () => {
  assertIsolated();
  assert.ok(existsSync(CLI), "build first (npm test builds)");
  f = await startFake();
});
after(async () => f.stop());

const SCC = "dddddddd-2222-4333-8444-000000000001";
const OC = { OPENCODE: "1", OPENCODE_PID: "4242" };

function cli(home: string, cwd: string, env: Record<string, string>, ...args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (/^(CLAUDE|CODEX|CURSOR|OPENCODE|BOTLINK_APP)/.test(k)) delete base[k];
    const ch = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...base, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, ...env } });
    let stdout = "", stderr = "";
    ch.stdout.on("data", (b) => (stdout += b));
    ch.stderr.on("data", (b) => (stderr += b));
    ch.on("exit", (status) => res({ status, stdout, stderr }));
  });
}

async function joinAs(home: string, room: any, owner: any, cwd: string, name: string, app: st.App, session: string | null) {
  return on(home, async () => {
    const r = await core.joinCreate({ invite: f.invite(room, owner), name, job: `${name} job`, app, app_name: app === "other" ? "Some App" : null, turn: app === "claude-code" ? "on_turn" : "listening", session, cwd, folder: cwd.replace(home, "~"), machine: "mac" });
    f.approve(r.req.id);
    const w: any = await core.joinWait({ maxMs: 3000 });
    assert.equal(w.status, "approved", w.text);
    return { member: w.member as st.MemberRec, req: r.req };
  });
}

/** The founder's Mac: sec-research (an OpenCode chat recorded as "other", holder-less) in ~/sec; a Claude Code
 *  chat `lead` in ~/lead sends it a question. */
async function founder(legacyApp: st.App = "other") {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `oc${Math.floor(Math.random() * 1e6)}`);
  const home = newHome("oc");
  const sec = join(home, "sec");
  const leadDir = join(home, "lead");
  mkdirSync(sec, { recursive: true });
  mkdirSync(leadDir, { recursive: true });
  const s = await joinAs(home, room, adam, sec, "sec-research", legacyApp, null);
  const l = await joinAs(home, room, adam, leadDir, "lead", "claude-code", SCC);
  return { adam, room, home, sec, leadDir, secM: s.member, secReq: s.req, lead: l.member };
}

test("OpenCode is detected from the env it gives its commands and MCP servers; nesting picks the app, user settings aren't signals", () => {
  assert.equal(appFromEnv({ OPENCODE: "1", OPENCODE_PID: "123" }), "opencode");
  assert.equal(appFromEnv({ OPENCODE_PID: "123" }), "opencode");
  assert.equal(appFromEnv({ OPENCODE: "1", CURSOR_TRACE_ID: "x", TERM_PROGRAM: "vscode" }), "opencode", "OpenCode run in Cursor's terminal");
  assert.equal(appFromEnv({ OPENCODE_CONFIG: "/x/opencode.json", OPENCODE_CONFIG_DIR: "/x", OPENCODE_DISABLE_AUTOUPDATE: "1" }), null);
  assert.equal(appFromEnv({ OPENCODE: "0" }), null);
  assert.deepEqual(appsFromEnv({ OPENCODE: "1", CLAUDECODE: "1" }), ["claude-code", "opencode"]);
  assert.equal(appFromEnv({ OPENCODE: "1", CLAUDECODE: "1" }), "claude-code", "env alone: OpenCode only when it's the only signal (detectApp checks OPENCODE_PID's ancestry)");
  assert.equal(appOfComm("opencode"), "opencode");
  assert.equal(appOfComm(".opencode-linux-x64"), "opencode");
  assert.equal(appOfComm("claude"), "claude-code");
  assert.equal(appOfComm("cursor-agent"), "cursor");
  assert.equal(appOfComm("node"), null);
});

test("live bug: the woken OpenCode run (Cursor's CURSOR_TRACE_ID inherited) reads sec-research's inbox (legacy 'other' member)", async () => {
  const { home, sec, secM, lead } = await founder("other");
  assert.equal(secM.app, "other");
  await on(home, () => core.send(lead, { to: "sec-research", text: "please review the threat model", intent: "question" }, SCC));
  // what the listener ran: `opencode run --continue …` in sec-research's folder; OpenCode's shell gives the CLI
  // OPENCODE=1 / OPENCODE_PID, plus whatever the terminal had (Cursor's CURSOR_TRACE_ID on the founder's Mac)
  const env = { ...OC, CURSOR_TRACE_ID: "trace", BOTLINK_UNATTENDED: "1", BOTLINK_LISTEN_MEMBER: "sec-research" };
  const inb = await cli(home, sec, env, "inbox");
  assert.equal(inb.status, 0, inb.stderr + inb.stdout);
  assert.match(inb.stdout, /1 new message for sec-research/);
  assert.match(inb.stdout, /please review the threat model/);
  const poll = [...f.members.values()].find((m) => m.id === secM.id)!.last_poll_at;
  assert.ok(poll > 0, "the server saw sec-research poll (was null in the live bug)");
  // and replies as sec-research
  const id = inb.stdout.match(/id: ([0-9a-f-]{36})/)![1];
  const rep = await cli(home, sec, env, "reply", id, "--text", "on it");
  assert.equal(rep.status, 0, rep.stderr + rep.stdout);
  assert.match(await on(home, () => tools({ app: "claude-code", session: () => SCC }).inbox({})), /from: sec-research[\s\S]*on it/);
});

test("before the fix the same call was taken for Cursor: a Cursor chat in that terminal still never acts as sec-research", async () => {
  const { home, sec } = await founder("other");
  const cur = await cli(home, sec, { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "cccccccc-2222-4333-8444-00000000000a" }, "inbox");
  assert.notEqual(cur.status, 0);
  assert.match(cur.stdout + cur.stderr, /isn't a bot-link member yet/);
});

test("a new OpenCode join is recorded as opencode locally, sent as other + app_name OpenCode; MCP + CLI resolve it", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `oc2${Math.floor(Math.random() * 1e6)}`);
  const home = newHome("oc2");
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  // the join itself runs through the CLI from OpenCode's shell
  const j = await cli(home, proj, OC, "join", f.invite(room, adam), "--name", "sec2", "--job", "security research", "--turn", "listening");
  assert.equal(j.status, 0, j.stderr + j.stdout);
  const pend = [...f.joins.values()].find((x) => x.body.name === "sec2")!;
  assert.equal(pend.body.app, "other", "the signed roster stays other");
  assert.equal(pend.body.app_name, "OpenCode");
  f.approve(pend.id);
  const w = await cli(home, proj, OC, "join", "--wait");
  assert.equal(w.status, 0, w.stderr + w.stdout);
  const m = await on(home, () => st.liveMembers().find((x) => x.name === "sec2")!);
  assert.equal(m.app, "opencode");
  assert.equal(m.app_name, "OpenCode");
  assert.match(w.stdout, /LISTENING: set it up now, in this turn\. You choose how[\s\S]*app: OpenCode[\s\S]*inbox --as sec2/, "the same listening block as every app, with the facts bot-link can tell");
  assert.equal(m.holder_session, null);
  // a Claude Code chat joins in the SAME folder
  const cc = await joinAs(home, room, adam, proj, "cc-same", "claude-code", SCC);
  // OpenCode's MCP server (no session id; cwd = the project) is sec2, never cc-same
  const t = tools({ app: "opencode", session: () => null });
  await on(home, () => core.send(cc.member, { to: "sec2", text: "hello opencode", intent: "fyi" }, SCC));
  const viaMcp = await on(home, () => { const cwd = process.cwd(); process.chdir(proj); return t.inbox({}).finally(() => process.chdir(cwd)); });
  assert.match(viaMcp, /for sec2/);
  assert.match(viaMcp, /hello opencode/);
  const bad = await on(home, () => t.send({ to: "cc-same", text: "x", intent: "fyi", as: "cc-same" }).catch((e: Error) => e.message));
  assert.match(bad, /cc-same is a Claude Code member; this chat is OpenCode/);
  // the Claude Code chat's hooks/tools never take sec2 (it holds no session, same folder)
  const ccIn = await on(home, () => { const cwd = process.cwd(); process.chdir(proj); return tools({ app: "claude-code", session: () => "eeeeeeee-2222-4333-8444-000000000009" }).inbox({}).catch((e: Error) => e.message).finally(() => process.chdir(cwd)); });
  assert.doesNotMatch(ccIn, /sec2/);
  // status from OpenCode's shell
  const s = await cli(home, proj, OC, "status");
  assert.match(s.stdout, /This chat: OpenCode · .*proj\nActing as: sec2 in #/);
});

test("undetected app ('other'): resolves only an 'other' member by folder (single match), never a known app's; --as overrides", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `ot${Math.floor(Math.random() * 1e6)}`);
  const home = newHome("ot");
  const dir = join(home, "w");
  mkdirSync(dir, { recursive: true });
  await joinAs(home, room, adam, dir, "cc-here", "claude-code", null); // holder-less Claude Code member in the folder
  const none = await cli(home, dir, { BOTLINK_APP: "other" }, "inbox");
  assert.notEqual(none.status, 0, "an unknown app never guesses the Claude Code member: " + none.stdout + none.stderr);
  assert.match(none.stdout + none.stderr, /isn't a bot-link member yet/);
  await joinAs(home, room, adam, dir, "x-one", "other", null);
  const one = await cli(home, dir, { BOTLINK_APP: "other" }, "status");
  assert.match(one.stdout, /Acting as: x-one in #/);
  await joinAs(home, room, adam, dir, "x-two", "other", null);
  const two = await cli(home, dir, { BOTLINK_APP: "other" }, "inbox");
  assert.notEqual(two.status, 0);
  assert.match(two.stdout + two.stderr, /Several bot-link members could be this chat \(x-one in #ot\d+, x-two in #ot\d+\)\. Say which with --as/);
  const named = await cli(home, dir, { BOTLINK_APP: "other" }, "inbox", "--as", "x-two");
  assert.equal(named.status, 0, named.stderr + named.stdout);
  // an OpenCode chat with TWO legacy "other" members in its folder asks too (single match only)
  const oc = await cli(home, dir, OC, "inbox");
  assert.notEqual(oc.status, 0);
  assert.match(oc.stdout + oc.stderr, /Several bot-link members could be this chat \(x-one in #ot\d+, x-two in #ot\d+\)/);
  // …unless its own listener started this run for one of them
  const viaListener = await cli(home, dir, { ...OC, BOTLINK_LISTEN_MEMBER: "x-one" }, "status");
  assert.match(viaListener.stdout, /Acting as: x-one in #/);
});

test("up --app opencode: OpenCode's MCP entry (type local, command array, enabled) in $XDG_CONFIG_HOME/opencode/opencode.json; no watch; idempotent; uninstall", async () => {
  const home = newHome("ocup");
  const xdg = join(home, ".config");
  await on(home, async () => {
    const p = h.opencodePath();
    assert.equal(p, join(xdg, "opencode", "opencode.json"));
    const r = up({ apps: ["opencode"] });
    assert.ok(r.ok, r.lines.join("\n"));
    assert.ok(!r.lines.some((l) => /watch is on/.test(l)), "OpenCode has no chat id: watch isn't installed for it");
    const j = JSON.parse(readFileSync(p, "utf-8"));
    const e = j.mcp.botlink;
    assert.equal(e.type, "local");
    assert.ok(Array.isArray(e.command));
    assert.deepEqual(e.command.slice(-3), ["mcp", "--app", "opencode"]);
    assert.ok(/dist[\\/]cli\.js$/.test(e.command[e.command.length - 4]));
    assert.equal(e.enabled, true);
    assert.ok(h.configured("opencode"));
    const before = readFileSync(p, "utf-8");
    assert.ok(up({ apps: ["opencode"] }).ok);
    assert.equal(readFileSync(p, "utf-8"), before, "idempotent");
    const u = uninstallAll({ apps: ["opencode"] });
    assert.ok(u.ok, u.lines.join("\n"));
    assert.ok(!existsSync(p) || !JSON.parse(readFileSync(p, "utf-8")).mcp?.botlink);
  }, { XDG_CONFIG_HOME: xdg });
});

test("item 7: an app bot-link can't detect must name itself at join (CLI --app-name / MCP app_name); the name is sanitised and shown", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `un${Math.floor(Math.random() * 1e6)}`);
  const home = newHome("un");
  const dir = join(home, "t3");
  mkdirSync(dir, { recursive: true });
  const ask = await cli(home, dir, { BOTLINK_APP: "other" }, "join", f.invite(room, adam), "--name", "t3bot", "--job", "helper");
  assert.notEqual(ask.status, 0);
  assert.match(ask.stdout + ask.stderr, /can't tell which app this chat runs in[\s\S]*--app-name "<app name>"/);
  assert.equal([...f.joins.values()].filter((x) => x.body.name === "t3bot").length, 0, "nothing sent before it names itself");
  const ok = await cli(home, dir, { BOTLINK_APP: "other" }, "join", f.invite(room, adam), "--name", "t3bot", "--job", "helper", "--app-name", "  T3\u202e Code <<<x  ");
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const pend = [...f.joins.values()].find((x) => x.body.name === "t3bot")!;
  assert.equal(pend.body.app, "other");
  assert.equal(pend.body.app_name, "T3 Code x");
  // MCP: join without app_name asks; with it, joins
  const t = tools({ app: "other", session: () => null });
  const d2 = join(home, "t3b");
  mkdirSync(d2, { recursive: true });
  const cwd = process.cwd();
  process.chdir(d2);
  try {
    const why = await on(home, () => t.join({ invite: f.invite(room, adam), name: "t3mcp", job: "x" }).catch((e: Error) => e.message));
    assert.match(why, /call join again with app_name: "<app name>"/);
    const r = await on(home, () => t.join({ invite: f.invite(room, adam), name: "t3mcp", job: "x", app_name: "T3 Code" }));
    assert.match(r, /show your human the approve link and the code/);
  } finally {
    process.chdir(cwd);
  }
  assert.equal([...f.joins.values()].find((x) => x.body.name === "t3mcp")!.body.app_name, "T3 Code");
});

test("item 7 (hotfix 2026-11-06): presence (CLI + MCP) is recorded but never makes a member look fast", async () => {
  const { home, sec, secM } = await founder("other");
  const m = [...f.members.values()].find((x) => x.id === secM.id)!;
  m.turn = "on_turn";
  m.last_poll_at = 0;
  const r = await cli(home, sec, { ...OC }, "presence");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /sec-research in #oc\d+ shows as "answers on its next turn"/);
  assert.ok(f.presenceLog.some((p) => p.member === secM.id));
  m.last_seen_at = Date.now() - 100_000;
  const t = tools({ app: "opencode", session: () => null });
  const cwd = process.cwd();
  process.chdir(sec);
  try {
    assert.match(await on(home, () => t.presence({})), /shows as "answers on its next turn"/);
  } finally {
    process.chdir(cwd);
  }
});
