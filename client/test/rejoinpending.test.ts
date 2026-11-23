// Founder bug, 21 Nov 2026. An OpenCode chat on the founder's Mac (no session id
// at join, ~/Documents/Default Project) asked to join #neon as opencode, ran join again and was told "opencode is
// already taken ... opencode-2" (symptom 1). After its person approved opencode, the chat still was not opencode:
// `roster --room neon` said "This chat isn't a bot-link member yet", `status --room neon --session ses_…` said
// "Acting as: sec-research in #test1" (its member in another room), and it asked again as opencode-2, opencode-mj
// and sec-research, all waiting at once (symptom 2).
//
// The rule these tests pin: a chat without a session id is its app (OpenCode detected, or an undetected app that
// names itself OpenCode: the same app as the room sees it) in its folder on this computer. Its own request or member
// for a room is found before anything is sent, whatever name it asks for; it is never told its own request's name is
// "taken"; nothing on this computer is told to pick another name for a request it may have made itself.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import { tools } from "../src/mcp.js";
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

const OC = { OPENCODE: "1", OPENCODE_PID: "4242" };
const SES = "ses_e03d71949ffeiY6pNFm9SQVLIr";
/** today's words for a name held by a waiting request or by this chat: none of them may come back */
const TAKEN = /already taken|is taken by|Try "|for example "|opencode-2"/;

type Out = { status: number | null; out: string };
function cli(home: string, cwd: string, env: Record<string, string>, ...args: string[]): Promise<Out> {
  return new Promise((res) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (/^(CLAUDE|CODEX|CURSOR|OPENCODE|BOTLINK_APP|BOTLINK_HOME)/.test(k)) delete base[k];
    const ch = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...base, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, ...env } });
    let out = "";
    ch.stdout.on("data", (b) => (out += b));
    ch.stderr.on("data", (b) => (out += b));
    ch.on("exit", (status) => res({ status, out }));
  });
}

async function world(label: string) {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `neon${Math.floor(Math.random() * 1e6)}`, "p");
  const inv = `http://localhost:8811/i/${f.invite(room, adam)}`;
  const home = newHome(label);
  const proj = join(home, "Documents", "Default Project");
  mkdirSync(join(proj, "src"), { recursive: true });
  const waiting = () => [...f.joins.values()].filter((x) => x.room === room.id && x.status === "pending");
  return { adam, room, inv, home, proj, waiting };
}
const joinCmd = (inv: string, name: string, ...extra: string[]) => ["join", inv, "--name", name, "--job", "coding agent", "--turn", "on_turn", ...extra];
const approveLinkIn = (s: string) => /\/approve\/([0-9a-f-]{36})/.exec(s)?.[1];
const codeIn = (s: string) => /Code ([2-9A-Z]{3}-[2-9A-Z]{3})/.exec(s)?.[1];

// ---------------------------------------------------------------- symptom 1: asking twice is asking once

for (const [first, second, why] of [
  [{ env: OC, extra: [] }, { env: {}, extra: ["--app-name", "OpenCode"] }, "OpenCode detected, then undetected naming itself OpenCode"],
  [{ env: {}, extra: ["--app-name", "OpenCode"] }, { env: OC, extra: [] }, "undetected naming itself OpenCode, then OpenCode detected"],
  [{ env: {}, extra: ["--app-name", "OpenCode"] }, { env: {}, extra: ["--app", "opencode"] }, "undetected naming itself OpenCode, then --app opencode"],
  [{ env: {}, extra: ["--app-name", "OpenCode"] }, { env: {}, extra: [] }, "undetected naming itself OpenCode, then undetected without --app-name"],
  [{ env: OC, extra: [] }, { env: OC, extra: ["--session", SES] }, "no session at join, then --session (the founder's chat)"],
] as const) {
  test(`symptom 1: ${why}, same folder: the second join is the first request (same link and code), one request on the server`, async () => {
    const w = await world("twice");
    const a = await cli(w.home, w.proj, first.env, ...joinCmd(w.inv, "opencode", ...first.extra));
    assert.equal(a.status, 0, a.out);
    const b = await cli(w.home, w.proj, second.env, ...joinCmd(w.inv, "opencode", ...second.extra));
    assert.doesNotMatch(b.out, TAKEN);
    assert.match(b.out, /same request \(nothing new was sent\)/, b.out);
    assert.equal(approveLinkIn(b.out), approveLinkIn(a.out), "the same approve link");
    assert.equal(codeIn(b.out), codeIn(a.out), "the same code");
    assert.equal(w.waiting().length, 1, "one request on the server");
  });
}

test("symptom 1: the bot-link tools (OpenCode's MCP server) after a command-line join that named itself OpenCode: the same request", async () => {
  const w = await world("mcp");
  const a = await cli(w.home, w.proj, {}, ...joinCmd(w.inv, "opencode", "--app-name", "OpenCode"));
  assert.equal(a.status, 0, a.out);
  const t = tools({ app: "opencode", session: () => null });
  const cwd = process.cwd();
  process.chdir(w.proj);
  try {
    const b = await on(w.home, () => t.join({ invite: w.inv, name: "opencode", job: "coding agent" }).catch((e: Error) => e.message));
    assert.doesNotMatch(b, TAKEN);
    assert.match(b, /same request/);
    assert.equal(approveLinkIn(b), approveLinkIn(a.out));
  } finally {
    process.chdir(cwd);
  }
  assert.equal(w.waiting().length, 1);
});

test("symptom 1: a folder with a space, reached through a symlink, is the same folder", async () => {
  const w = await world("link");
  const alias = join(w.home, "dp-link");
  symlinkSync(w.proj, alias);
  const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
  assert.equal(a.status, 0, a.out);
  const b = await cli(w.home, alias, OC, ...joinCmd(w.inv, "opencode"));
  assert.match(b.out, /same request/, b.out);
  assert.equal(w.waiting().length, 1);
});

test("sameOrUnder: spaces, trailing slashes, symlinks; macOS and Windows compare without case, Linux with it", () => {
  const home = newHome("paths");
  const d = join(home, "Documents", "Default Project");
  mkdirSync(d, { recursive: true });
  symlinkSync(d, join(home, "alias"));
  assert.ok(core.sameOrUnder(d, d + "/", false));
  assert.ok(core.sameOrUnder(join(home, "alias"), d, false));
  assert.ok(core.sameOrUnder(join(d, "src"), d, true));
  assert.ok(!core.sameOrUnder(join(d, "src"), d, false));
  assert.ok(!core.sameOrUnder(d.toLowerCase(), d, false, "linux"));
  assert.ok(core.sameOrUnder(d.toLowerCase(), d, false, "darwin"));
  assert.ok(core.sameOrUnder(d.toUpperCase(), d, false, "win32"));
});

for (const where of ["src", "..", "../Other Project"] as const) {
  test(`symptom 1: the same app from another folder (${where}): nothing new is sent, it is told which folder asked and never told the name is taken or to pick another`, async () => {
    const w = await world("folder");
    const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
    assert.equal(a.status, 0, a.out);
    const dir = join(w.proj, where);
    mkdirSync(dir, { recursive: true });
    const b = await cli(w.home, dir, OC, ...joinCmd(w.inv, "opencode"));
    assert.notEqual(b.status, 0);
    assert.doesNotMatch(b.out, TAKEN);
    assert.match(b.out, /waiting for Adam to approve/);
    assert.match(b.out, /Default Project/, "it names the folder the waiting request was asked from");
    assert.match(b.out, /run the same join from that folder/);
    assert.match(b.out, /don't pick another name/i);
    assert.equal(w.waiting().length, 1, "no second request");
  });
}

test("symptom 1, no local record (another bot-link folder on the same computer): waiting for approval, made from this computer; no second identity offered", async () => {
  const w = await world("home1");
  const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
  assert.equal(a.status, 0, a.out);
  const other = { ...OC, BOTLINK_HOME: join(newHome("home2"), ".botlink") };
  const b = await cli(w.home, w.proj, other, ...joinCmd(w.inv, "opencode"));
  assert.notEqual(b.status, 0);
  assert.doesNotMatch(b.out, TAKEN);
  assert.match(b.out, /A request to join #neon\d+ as opencode, asked from this computer, is waiting for approval/);
  assert.match(b.out, /Don't ask under another name/);
  assert.equal(w.waiting().length, 1);
});

test("a waiting request from another computer: waiting for approval, never 'taken'; that is another chat, so this one asks its human for its own name", async () => {
  const w = await world("elsewhere");
  await on(w.home, () => core.joinCreate({ invite: w.inv, name: "opencode", job: "x", app: "opencode", turn: "on_turn", session: null, cwd: w.proj, folder: "~/p", machine: "bob-pc" }));
  const other = newHome("mine");
  const r = await on(other, () => core.joinCreate({ invite: w.inv, name: "opencode", job: "x", app: "opencode", turn: "on_turn", session: null, cwd: other, folder: "~", machine: "my-mac" }).then(() => "joined", (e: Error) => e.message));
  assert.doesNotMatch(r, /already taken/);
  assert.match(r, /A chat on another computer asked to join #neon\d+ as opencode, and that request is waiting for approval/);
  assert.match(r, /ask your human which name to use/);
});

test("a name a member holds (another computer's chat) is still 'already taken' (unchanged)", async () => {
  const w = await world("member");
  const r1 = await on(w.home, () => core.joinCreate({ invite: w.inv, name: "opencode", job: "x", app: "opencode", turn: "on_turn", session: null, cwd: w.proj, folder: "~/p", machine: "bob-pc" }));
  f.approve(r1.req.id);
  const other = newHome("mine2");
  const r = await on(other, () => core.joinCreate({ invite: w.inv, name: "opencode", job: "x", app: "opencode", turn: "on_turn", session: null, cwd: other, folder: "~", machine: "my-mac" }).then(() => "joined", (e: Error) => e.message));
  assert.match(r, /The name "opencode" is already taken in that room\. Try "opencode-2"\./);
});

// ---------------------------------------------------------------- symptom 2: one chat, one identity per room

test("symptom 2: while its request waits, the same chat asking under new names (and with the app flipping) sends nothing new", async () => {
  const w = await world("names");
  const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
  assert.equal(a.status, 0, a.out);
  for (const [name, env, extra] of [["opencode-2", OC, []], ["opencode-mj", {}, ["--app-name", "OpenCode"]], ["sec-research", OC, ["--session", SES]]] as const) {
    const b = await cli(w.home, w.proj, env, ...joinCmd(w.inv, name, ...extra));
    assert.notEqual(b.status, 0, b.out);
    assert.match(b.out, /This chat already asked to join #neon\d+ as opencode/, b.out);
    assert.match(b.out, /Do not join again and do not pick another name/);
    assert.equal(approveLinkIn(b.out), approveLinkIn(a.out));
  }
  assert.equal(w.waiting().length, 1, "the person sees one card");
});

test("symptom 2: approved but the chat never ran join --wait: its next call (roster --room) finishes it; every later join says it already is that member", async () => {
  const w = await world("unfinished");
  const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
  assert.equal(a.status, 0, a.out);
  f.approve(approveLinkIn(a.out)!);
  const room = w.room.name;
  const r = await cli(w.home, w.proj, OC, "roster", "--room", room, "--session", SES);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /isn't a bot-link member/);
  assert.match(r.out, new RegExp(`Adam approved this chat's request to join #${room} as opencode: finished here, this chat is opencode`));
  for (const [name, env, extra] of [["opencode", OC, []], ["opencode-2", OC, ["--session", SES]], ["opencode-mj", {}, ["--app-name", "OpenCode"]]] as const) {
    const b = await cli(w.home, w.proj, env, ...joinCmd(w.inv, name, ...extra));
    assert.match(b.out, new RegExp(`This chat already joined #${room} as opencode \\(approved\\): you are opencode in #${room}\\. Do not join again and do not pick another name`), b.out);
  }
  assert.equal(w.waiting().length, 0, "no new card");
});

test("symptom 2: approved and never finished, the next join itself finishes it (nothing new sent)", async () => {
  const w = await world("unfinished2");
  const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
  f.approve(approveLinkIn(a.out)!);
  const b = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode-2", "--session", SES));
  assert.match(b.out, /already approved this chat's request to join as opencode, so this chat is opencode: nothing new was sent \(not opencode-2\)/, b.out);
  assert.equal(w.waiting().length, 0);
});

test("a member of room A (sec-research, from before bot-link knew OpenCode) joins room B: B gets its own member; --room B never answers with A's member", async () => {
  const w = await world("twoRooms");
  const test1 = await f.room(w.adam, `test${Math.floor(Math.random() * 1e6)}`, "p");
  const inv1 = `http://localhost:8811/i/${f.invite(test1, w.adam)}`;
  // sec-research joined #test1 from this folder as an undetected app (recorded "other", no holder)
  const s = await cli(w.home, w.proj, { BOTLINK_APP: "other" }, ...joinCmd(inv1, "sec-research", "--app-name", "OpenCode"));
  f.approve(approveLinkIn(s.out)!);
  assert.equal((await cli(w.home, w.proj, { BOTLINK_APP: "other" }, "join", "--wait", "--max-s", "5")).status, 0);
  // now OpenCode is detected; the chat passes its session on later calls
  const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
  assert.equal(a.status, 0, a.out);
  assert.equal(w.waiting().length, 1);
  const before = await cli(w.home, w.proj, OC, "status", "--room", w.room.name, "--session", SES);
  assert.doesNotMatch(before.out, /Acting as: sec-research/, "a status for #neon never acts as #test1's member");
  f.approve(approveLinkIn(a.out)!);
  const roster = await cli(w.home, w.proj, OC, "roster", "--room", w.room.name, "--session", SES);
  assert.equal(roster.status, 0, roster.out);
  assert.match(roster.out, /opencode \(this chat\)/);
  const named = await cli(w.home, w.proj, OC, "roster", "--room", w.room.name, "--as", "opencode", "--session", SES);
  assert.equal(named.status, 0, named.out);
  const status = await cli(w.home, w.proj, OC, "status", "--room", w.room.name, "--session", SES);
  assert.match(status.out, new RegExp(`Acting as: opencode in #${w.room.name}`));
  assert.doesNotMatch(status.out, /Acting as: sec-research/);
  // and #test1 still is sec-research
  const t1 = await cli(w.home, w.proj, OC, "roster", "--room", test1.name, "--session", SES);
  assert.match(t1.out, /sec-research \(this chat\)/);
  // a join to #neon under #test1's name: this chat is opencode there already
  const again = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "sec-research", "--session", SES));
  assert.match(again.out, /This chat already joined #neon\d+ as opencode \(approved\)/);
  assert.equal(w.waiting().length, 0);
});

test("adoption has limits: another app's chat in the same folder, and an OpenCode chat in another folder, never take the waiting OpenCode request", async () => {
  const w = await world("adopt");
  const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
  f.approve(approveLinkIn(a.out)!);
  // a Claude Code chat in the same folder: its wait does not finish OpenCode's approved request
  const cc = await cli(w.home, w.proj, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "aaaaaaaa-1111-4222-8333-000000000001" }, "join", "--wait", "--max-s", "3");
  assert.notEqual(cc.status, 0, cc.out);
  assert.doesNotMatch(cc.out, /Joined #/);
  // an OpenCode chat in another folder: neither
  const other = join(w.home, "elsewhere");
  mkdirSync(other, { recursive: true });
  const oc2 = await cli(w.home, other, OC, "roster", "--room", w.room.name);
  assert.doesNotMatch(oc2.out, /finished here/);
  assert.equal(await on(w.home, () => st.liveMembers().filter((m) => m.name === "opencode").length), 0, "nobody became opencode");
  // the chat itself still does
  const own = await cli(w.home, w.proj, OC, "join", "--wait", "--max-s", "5");
  assert.equal(own.status, 0, own.out);
});

test("server cap: a waiting join from this computer, folder and app under another name, with no local record, is 'you already asked'", async () => {
  const w = await world("cap");
  const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
  assert.equal(a.status, 0, a.out);
  const other = { ...OC, BOTLINK_HOME: join(newHome("cap2"), ".botlink") };
  const b = await cli(w.home, w.proj, other, ...joinCmd(w.inv, "opencode-2"));
  assert.notEqual(b.status, 0);
  assert.match(b.out, /A chat on this computer already asked to join #neon\d+ from this folder as opencode, and that request is waiting for approval, but this computer's bot-link folder \(.*\) doesn't hold the key for opencode/, b.out);
  assert.match(b.out, /Do not join again and do not pick another name/);
  assert.equal(w.waiting().length, 1);
});

test("the first join's next step is join --wait, and it says not to run join again", async () => {
  const w = await world("next");
  const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
  assert.equal(a.status, 0, a.out);
  const last = a.out.trim().split("\n").pop()!;
  assert.match(last, /run `[^`]*join --wait` right away/);
  assert.match(last, /Don't run join with the invite again \(not under another name either\)/);
});

test("docs say it too: one join per chat and room, then join --wait; a refused name is the human's to change", async () => {
  const { readFileSync } = await import("node:fs");
  const docs = join(import.meta.dirname, "..", "..", "docs");
  const agents = readFileSync(join(docs, "agents.md"), "utf-8"), llms = readFileSync(join(docs, "llms.txt"), "utf-8");
  assert.match(agents, /\*\*One join per chat and room\.\*\* After the approve link, the next command is `join --wait`, never `join <invite>` again/);
  assert.match(agents, /If bot-link refuses a name, ask your human which name to use; don't invent one\./);
  assert.match(llms, /One join per chat and room: after the approve link the next command is `join --wait`, never `join` again \(not under another name either/);
  assert.match(llms, /If a name is refused, ask your human which name to use; don't invent one\./);
});

// ---------------------------------------------------------------- one identity, the one every command uses

const X = "ses_e03d71949ffeiY6pNFm9SQVLIr";
const APPS: Record<string, { env: Record<string, string>; noSession?: Record<string, string>; extra?: string[] }> = {
  "claude-code": { env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: X }, noSession: { CLAUDECODE: "1" } },
  codex: { env: { CODEX_THREAD_ID: X }, noSession: { CODEX_SANDBOX: "seatbelt" } },
  cursor: { env: { CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: X }, noSession: { CURSOR_AGENT: "1" } },
  opencode: { env: { ...OC, OPENCODE_SESSION_ID: X }, noSession: OC },
  t3: { env: { T3CODE_THREAD_ID: X, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "t3-code" } },
  other: { env: {}, noSession: {}, extra: ["--app-name", "Some App"] },
};
for (const [app, a] of Object.entries(APPS)) {
  for (const how of ["--session", "the app's env", "none"] as const) {
    const env = how === "none" ? a.noSession : how === "--session" ? a.noSession ?? a.env : a.env;
    if (!env || (how === "the app's env" && app === "other")) continue;
    const extra = [...(a.extra || []), ...(how === "--session" ? ["--session", X] : [])];
    test(`join stores the same identity every later command uses: ${app}, session from ${how}`, async () => {
      const w = await world("ident");
      const j = await cli(w.home, w.proj, env, ...joinCmd(w.inv, "chat", ...extra));
      assert.equal(j.status, 0, j.out);
      const req = w.waiting()[0];
      // what status (and every command) takes this chat to be: its session id, a Cursor chat, or its folder
      const st1 = await cli(w.home, w.proj, env, "status", ...(how === "--session" ? ["--session", X] : []));
      const line = /^This chat: .*$/m.exec(st1.out)?.[0] || "";
      const sent = req.body.session_id || null;
      if (sent) assert.match(line, new RegExp(`· session ${sent} `), `join sent session ${sent}; status says: ${line}`);
      else if (app === "cursor" && how !== "none") assert.match(line, new RegExp(`· Cursor chat ${X} `), line);
      else assert.match(line, /no session id \(found by folder\)/, `join sent no session; status says: ${line}`);
      if (app === "cursor" && how !== "none") assert.equal(await on(w.home, () => st.allRequests()[0].cursor_chat), X, "the Cursor chat id the commands use");
      // and the member the person approves is this chat for the next command, from the same context
      f.approve(req.id);
      const r = await cli(w.home, w.proj, env, "roster", "--room", w.room.name, ...(how === "--session" ? ["--session", X] : []));
      if (app === "cursor" && how === "none") {
        // H2: a Cursor chat with no chat id is no identity at all, at join and after: bot-link never guesses
        assert.match(r.out, /can't tell which Cursor chat this is/, r.out);
        return;
      }
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /chat \(this chat\)/, r.out);
    });
  }
}

test("cli.ts and mcp.ts read the chat's session one way only (session.ts chatSession / holderSession / cursorChatOf)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["cli.ts", "mcp.ts"]) {
    const src = readFileSync(join(import.meta.dirname, "..", "src", f), "utf-8");
    const bad = src.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => /currentSession\(\)\.id|noSession|"opencode" \|\| app === "other" \? null/.test(l));
    assert.deepEqual(bad, [], `${f}: a command builds its own session (founder bug 21 Nov 2026: join dropped --session, later commands used it). Use chatSession(app) for this chat's identity, holderSession(app) for what a join or move records, cursorChatOf(app) for a Cursor chat.`);
  }
});

test("the founder's pile (approved original, three newer requests under other names): a bare join --wait finishes the approved one", async () => {
  const w = await world("pile");
  const made: string[] = [];
  // an older client's leftovers: four requests of this chat for #neon (made from other folders, then the same here)
  for (const [i, name] of ["opencode", "opencode-2", "opencode-mj", "sec-research"].entries()) {
    const dir = join(w.home, `d${i}`);
    mkdirSync(dir, { recursive: true });
    const r = await on(w.home, () => core.joinCreate({ invite: w.inv, name, job: "x", app: "opencode", turn: "on_turn", session: null, cwd: dir, folder: `~/d${i}`, machine: "mac" }));
    made.push(r.req.id);
  }
  await on(w.home, () => { for (const r of st.allRequests()) st.saveRequest({ ...r, cwd: w.proj }); });
  f.approve(made[0]);
  const wt = await cli(w.home, w.proj, OC, "join", "--wait", "--max-s", "5");
  assert.equal(wt.status, 0, wt.out);
  assert.match(wt.out, /Joined #neon\d+ as opencode/);
  assert.equal(await on(w.home, () => st.liveMembers().map((m) => m.name).join()), "opencode");
});

test("only the key in this bot-link folder attaches: a chat whose bot-link folder lacks it never becomes the member, and is told so", async () => {
  const w = await world("key");
  const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
  f.approve(approveLinkIn(a.out)!);
  const other = { ...OC, BOTLINK_HOME: join(newHome("nokey"), ".botlink") };
  const r = await cli(w.home, w.proj, other, "roster", "--room", w.room.name);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.out, /\(this chat\)/);
  const j = await cli(w.home, w.proj, other, ...joinCmd(w.inv, "opencode-2"));
  assert.notEqual(j.status, 0);
  assert.match(j.out, /doesn't hold the key for opencode/);
  assert.match(j.out, /Do not join again and do not pick another name/);
  assert.equal(w.waiting().length, 0, "no new identity");
});

test("leave is refused while this chat's own join for that room waits or is approved and unfinished", async () => {
  const w = await world("leave");
  const a = await cli(w.home, w.proj, OC, ...joinCmd(w.inv, "opencode"));
  f.approve(approveLinkIn(a.out)!);
  assert.equal((await cli(w.home, w.proj, OC, "join", "--wait", "--max-s", "5")).status, 0);
  // an older client's leftover: a waiting request of this chat for the same room under another name
  const dir = join(w.home, "old");
  mkdirSync(dir, { recursive: true });
  const left = await on(w.home, () => core.joinCreate({ invite: w.inv, name: "opencode-2", job: "x", app: "opencode", turn: "on_turn", session: null, cwd: dir, folder: "~/old", machine: "mac" }));
  await on(w.home, () => st.saveRequest({ ...left.req, cwd: w.proj }));
  const r1 = await cli(w.home, w.proj, OC, "leave", "opencode", "--yes");
  assert.notEqual(r1.status, 0);
  assert.match(r1.out, /Not left #neon\d+\. This chat's request to join as opencode-2 in #neon\d+ is still waiting for Adam to approve/);
  assert.match(r1.out, /Don't leave now/);
  f.approve(left.req.id);
  const r2 = await cli(w.home, w.proj, OC, "leave", "opencode", "--yes");
  assert.match(r2.out, /approved this chat's request to join as opencode-2 in #neon\d+, and it is not finished yet/);
  assert.equal(await on(w.home, () => st.liveMembers().length), 1, "still a member");
});
