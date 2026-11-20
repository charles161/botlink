/**
 * Manual end-to-end check for the critical fixes of a field test (2026-11-07,: H1, M5, H2, M2, M1.
 * Not part of `npm test`. Real Go server on 127.0.0.1:8856 against the private dev Postgres (database BOTLINK_IT_DB),
 * real CLI / hook / MCP-server processes in temp HOMEs; the "browser" signs approvals like the dashboard.
 * Run: BOTLINK_IT_SERVER=<binary> BOTLINK_IT_PG=postgres://botlink@127.0.0.1:55432 BOTLINK_IT_DB=botlink_test_crit2 \
 *      node --import tsx test/it/e2e-critical2.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import * as c from "../../src/crypto.js";
import { signedHeaders } from "../../src/reqsign.js";
import { RealServer, Browser, sql } from "./realserver.js";

const CLI = join(import.meta.dirname, "..", "..", "dist", "cli.js");
const base = mkdtempSync(join(tmpdir(), "bl-e2e-crit2-"));
const srv = new RealServer(8856);
const results: [string, boolean, string][] = [];
const ck = (name: string, ok: boolean, ev = "") => {
  results.push([name, ok, ev]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ev ? `\n     ${ev.replace(/\n/g, "\n     ").slice(0, 1200)}` : ""}`);
};

function envFor(home: string, extra: Record<string, string> = {}) {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|CODEX|CURSOR|BOTLINK_|TMUX|OPENCODE|T3CODE)/.test(k)) e[k] = v;
  return { ...e, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: srv.url, BOTLINK_DEV: "1", BOTLINK_KEYCHAIN: "0", BOTLINK_NO_UPDATE: "1", BOTLINK_NO_HARNESS_CLI: "1", BOTLINK_WAKE_TEST_DELAY_S: "3", ...extra };
}
function run(home: string, args: string[], extra: Record<string, string> = {}, stdin?: string, cwd = home): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const ch = spawn(process.execPath, [CLI, ...args], { cwd, env: envFor(home, extra), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    ch.stdout.on("data", (b) => (out += b));
    ch.stderr.on("data", (b) => (err += b));
    ch.stdin.end(stdin ?? "");
    ch.on("exit", (code) => res({ code, out, err }));
  });
}
/** A real bot-link MCP server process (what the app starts), driven over stdio like the app does. */
async function mcp(home: string, app: string, extra: Record<string, string> = {}, cwd = home) {
  const t = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--app", app], env: envFor(home, extra) as Record<string, string>, cwd, stderr: "ignore" });
  const cl = new Client({ name: "e2e", version: "1" });
  await cl.connect(t);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await cl.callTool({ name, arguments: args });
    return (r.content || []).map((x: any) => x.text).join("\n");
  };
  return { call, close: () => cl.close() };
}
/** A raw signed agent request with a member's key from a home (an old client, or a chat that read the key file). */
async function rawSigned(home: string, member: string, method: string, path: string, body: any, session: string) {
  const rec = JSON.parse(readFileSync(join(home, ".botlink", "members", `${member}.json`), "utf-8"));
  const k = JSON.parse(readFileSync(join(home, ".botlink", "keys", `${rec.key_id}.json`), "utf-8"));
  const pk = c.edPkFromSeed(k.ed25519_sk);
  const raw = Buffer.from(JSON.stringify(body));
  const u = new URL(srv.url + path);
  const h = signedHeaders({ method, host: u.host, target: u.pathname, body: raw, time: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString("hex"), key: pk, session }, k.ed25519_sk);
  const r = await fetch(u, { method, headers: { ...h, "Content-Type": "application/json" }, body: raw });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const memberId = (home: string, name: string) => {
  for (const f of readdirSync(join(home, ".botlink", "members"))) {
    const m = JSON.parse(readFileSync(join(home, ".botlink", "members", f), "utf-8"));
    if (m.name === name) return m.id as string;
  }
  throw new Error(`no ${name} in ${home}`);
};

const SA = "e2ecrit2-aaaa-4222-8333-000000000001"; // mac-claude's own chat
const SQ = "e2ecrit2-aaaa-4222-8333-0000000000qa"; // qa-lead: another chat on the same computer
const SX = "e2ecrit2-cccc-4222-8333-0000000000c0"; // a Codex peer

async function joinChat(adam: Browser, invite: string, home: string, name: string, env: Record<string, string>, cwd = home) {
  mkdirSync(home, { recursive: true });
  const j = await run(home, ["join", invite, "--name", name, "--job", `${name} job`], env, undefined, cwd);
  if (j.code !== 0) throw new Error(`join ${name}: ${j.out}${j.err}`);
  const req = (await adam.needsYou()).join_requests.find((x: any) => x.name === name && x.kind === "join");
  await adam.approve(req.id);
  const w = await run(home, ["join", "--wait"], env, undefined, cwd);
  if (w.code !== 0) throw new Error(`join --wait ${name}: ${w.out}${w.err}`);
  return w.out;
}

async function main() {
  await c.ready();
  mkdirSync(join(base, "logs"), { recursive: true });
  await srv.start(join(base, "logs"));
  try {
    const adam = await new Browser(srv.url).login("Adam");
    const room = await adam.createRoom("test1");
    const invite = await adam.chatInvite(room.id);
    const otherRoom = await adam.createRoom("secret-room");
    const otherInvite = await adam.chatInvite(otherRoom.id);

    // ================================================================ H1: claim needs the person's approval
    const hM = join(base, "mac"); // one computer: mac-claude's chat and qa-lead's chat share this HOME
    const ccA = { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: SA };
    const ccQ = { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: SQ };
    await joinChat(adam, invite, hM, "mac-claude", ccA);
    const hX = join(base, "codex");
    const cxEnv = { BOTLINK_APP: "codex", CODEX_THREAD_ID: SX };
    await joinChat(adam, invite, hX, "tester", cxEnv);
    const macId = memberId(hM, "mac-claude");
    // Adam's standing rule, typed in mac-claude's chat (captured by its prompt hook, saved by its tool)
    await run(hM, ["hook", "claude-code", "prompt"], ccA, JSON.stringify({ session_id: SA, cwd: hM, prompt: "you three should communicate and do a task together, fine without asking me" }));
    const mA = await mcp(hM, "claude-code", ccA);
    const saved = await mA.call("save_rule", { quote: "you three should communicate and do a task together" });
    ck("setup: a standing rule saved in mac-claude's own chat", /^Saved this standing rule/.test(saved) && existsSync(join(hM, ".botlink", "rules", `${macId}.json`)), saved.slice(0, 200));

    // 1. qa-lead's chat says "claim mac-claude": nothing moves; it gets the approve link + code
    const cl = await run(hM, ["claim", "mac-claude", "--room", "test1"], ccQ);
    ck("H1 claim from another chat: not taken; approve link + code; the other chat stays mac-claude", cl.code === 0 && /Moving mac-claude \(#test1\) to this chat needs Adam's OK in the browser: http:\/\/127\.0\.0\.1:8856\/approve\/[0-9a-f-]{36}/.test(cl.out) && /Code [A-Z2-9]{3}-[A-Z2-9]{3} · key /.test(cl.out) && /the other chat stays mac-claude/.test(cl.out), cl.out.trim());
    ck("H1 server: holder unchanged while pending", sql(`select holder_session from members where id = '${macId}'`) === SA, `holder_session = ${sql(`select holder_session from members where id = '${macId}'`)}`);
    // qa-lead tries to act as mac-claude meanwhile: refused (client and server)
    const imp = await run(hM, ["send", "--as", "mac-claude", "--room", "test1", "--to", "tester", "--intent", "fyi", "--text", "IMPERSONATION"], ccQ);
    ck("H1 qa-lead can't send as mac-claude while the move waits", imp.code !== 0 && /belongs to another chat/.test(imp.err), imp.err.trim().slice(0, 300));
    const rawSend = await rawSigned(hM, macId, "POST", "/api/v1/me/presence", {}, SQ);
    ck("H1 server refuses mac-claude's key from qa-lead's session (403 not_holder)", rawSend.status === 403 && rawSend.json?.error?.code === "not_holder", JSON.stringify(rawSend));
    // an old client's silent claim (the 3bedf81 behaviour): refused by the server
    const bare = await rawSigned(hM, macId, "POST", "/api/v1/me/claim", { session_id: SQ }, SQ);
    ck("H1 server: a bare claim from another session is refused (403 claim_needs_approval)", bare.status === 403 && bare.json?.error?.code === "claim_needs_approval", JSON.stringify(bare));
    // the old holder keeps working until approval
    const stillA = await mA.call("roster", {});
    ck("H1 the old chat keeps working until approval", /mac-claude \(this chat\)/.test(stillA), stillA.split("\n").find((l) => /this chat/.test(l)) || stillA.slice(0, 200));
    // the dashboard card
    const card = (await adam.needsYou()).join_requests.find((x: any) => x.kind === "claim" && x.name === "mac-claude");
    ck("H1 dashboard: a 'move to a new chat' card for Adam (code, new key, where it runs)", !!card && card.move_to === "chat" && card.app === "claude-code" && /^[A-Z2-9]{6}$/.test(card.match_code), JSON.stringify({ kind: card?.kind, move_to: card?.move_to, name: card?.name, app: card?.app, machine: card?.machine, folder: card?.folder, match_code: card?.match_code }));
    // a message tester sent before the move
    await run(hX, ["send", "--to", "mac-claude", "--intent", "question", "--text", "E2E-H1 before the move"], cxEnv);

    // 2. Adam approves in the browser (human check + member_rekey); qa-lead's wait finishes the move
    await adam.approve(card.id);
    const cw = await run(hM, ["claim", "--wait"], ccQ);
    ck("H1 after approval: qa-lead is mac-claude; rules cleared; old chat told", cw.code === 0 && /This chat is now mac-claude in #test1 \(Adam approved the move\)/.test(cw.out) && /Standing rules for mac-claude were cleared/.test(cw.out), cw.out.split("\n")[0]);
    ck("H1 server: new holder + new key; old key dead", sql(`select holder_session || ' key_epoch=' || key_epoch || ' verified=' || (wake_verified_at is not null) from members where id = '${macId}'`) === `${SQ} key_epoch=2 verified=false`, sql(`select holder_session || ' key_epoch=' || key_epoch from members where id = '${macId}'`));
    ck("H1 standing rules for mac-claude are gone", !existsSync(join(hM, ".botlink", "rules", `${macId}.json`)));
    // the old chat (mac-claude's original): told once, by its next tool call (and its next hook)
    const oldTold = await mA.call("status", {});
    ck("H1 old chat told it lost the member (next tool call)", /mac-claude in #test1 is now used by another chat \(Adam approved the move\)\. This chat is no longer mac-claude/.test(oldTold), oldTold.split("\n")[0]);
    const oldAgain = await mA.call("send", { to: "tester", text: "x", intent: "fyi" }).catch((e) => String(e));
    ck("H1 old chat can no longer act as mac-claude", !/^Passed to/.test(oldAgain), oldAgain.slice(0, 200));
    await mA.close();
    // the room: tester's next read says mac-claude moved (signed member list), and the pre-move message is re-sent
    await run(hM, ["send", "--to", "tester", "--intent", "question", "--text", "E2E-H1 hello from the new chat"], ccQ);
    const tIn = await run(hX, ["inbox"], cxEnv);
    ck("H1 room notice: 'mac-claude moved to a new chat (new key …)', content-free", /mac-claude moved to a new chat \(new key [0-9a-f-]+\)\./.test(tIn.out) && /E2E-H1 hello from the new chat/.test(tIn.out), (tIn.out.match(/[^\n]*moved to a new chat[^\n]*/) || [""])[0]);
    const tIn2 = await run(hX, ["inbox"], cxEnv);
    const qIn = await run(hM, ["inbox"], ccQ);
    ck("H1 the message sent before the move reaches the new chat (re-sent to the new key)", /E2E-H1 before the move/.test(qIn.out) && /re-sent after it moved to a new chat/.test(tIn.out + tIn2.out), (qIn.out.match(/[^\n]*E2E-H1 before[^\n]*/) || [""])[0]);
    const act = await adam.call("GET", `/app/v1/rooms/${room.id}/activity`);
    ck("H1 dashboard activity: 'moved'", JSON.stringify(act).includes('"moved"'), JSON.stringify((act.items || []).filter((x: any) => x.kind === "moved")));
    // the same chat after an app restart / resume (same session id) needs no approval
    const same = await run(hM, ["claim", "mac-claude", "--room", "test1"], ccQ);
    ck("H1 same chat (same session id) continues without approval", same.code === 0 && /This chat is already mac-claude/.test(same.out), same.out.trim().split("\n")[0]);

    // ================================================================ M5: the pre-join error names nobody
    const hN = join(base, "newchat");
    mkdirSync(hN, { recursive: true });
    // a member of another room lives on this computer too
    await joinChat(adam, otherInvite, hM, "bunny-claude", { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: "e2ecrit2-bbbb-4222-8333-00000000000b" });
    const pre = await run(hM, ["roster"], { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: "e2ecrit2-dddd-4222-8333-00000000000d" });
    ck("M5 pre-join error: no member names, no other rooms, no `as` hint", pre.code !== 0 && /isn't a bot-link member yet\. To join, ask your human for an invite and run join/.test(pre.err) && !/mac-claude|bunny-claude|tester|secret-room|test1|--as|as:/.test(pre.err), pre.err.trim());
    const mN = await mcp(hM, "claude-code", { CLAUDE_CODE_SESSION_ID: "e2ecrit2-dddd-4222-8333-00000000000d" });
    const preT = await mN.call("send", { to: "tester", text: "x", intent: "fyi" });
    ck("M5 same via the tool", /isn't a bot-link member yet/.test(preT) && !/mac-claude|bunny-claude|secret-room/.test(preT), preT.trim());
    await mN.close();

    // ================================================================ H2: two Cursor chats in one folder
    const hC = join(base, "cursor");
    const folder = join(hC, "bunny");
    mkdirSync(folder, { recursive: true });
    const C1 = "e2ecrit2-c001-4222-8333-000000000c01", C2 = "e2ecrit2-c002-4222-8333-000000000c02";
    const cur1 = { BOTLINK_APP: "cursor", CURSOR_CONVERSATION_ID: C1 };
    const cur2 = { BOTLINK_APP: "cursor", CURSOR_CONVERSATION_ID: C2 };
    const room4 = await adam.createRoom("test4");
    await joinChat(adam, await adam.chatInvite(room4.id), hC, "cursor", cur1, folder); // chat 1 joins #test4 from its shell
    // chat 2 (same folder) gets a NEW invite for #lowbar and joins with the tool, invite + wait in one call
    const lowbar = await adam.createRoom("lowbar");
    const lowInv = await adam.chatInvite(lowbar.id);
    const m2 = await mcp(hC, "cursor", { BOTLINK_WORKSPACE: folder }, folder);
    const j2p = m2.call("join", { invite: lowInv, name: "acme-cursor", job: "reviews", wait: true });
    let card2: any = null;
    for (let i = 0; i < 50 && !card2; i++) {
      card2 = (await adam.needsYou()).join_requests.find((x: any) => x.name === "acme-cursor");
      if (!card2) await new Promise((r) => setTimeout(r, 200));
    }
    if (card2) await adam.approve(card2.id);
    const j2 = await j2p;
    ck("H2 a join WITH a new invite joins that room (never answers with another member)", !!card2 && card2.room_name === "lowbar" && /Joined #lowbar as acme-cursor/.test(j2) && !/already joined #test4/.test(j2), j2.split("\n").filter((l) => /Waiting for|Joined|already/.test(l)).join("\n"));
    // the tools can't tell which Cursor chat calls: they don't assume the folder's members
    const st2 = await m2.call("status", {});
    ck("H2 Cursor tool status never lists the folder's members as 'this chat'", !/This chat is (cursor|acme-cursor)/.test(st2) && /can't tell which Cursor chat this is/.test(st2) && !/cursor in #test4|acme-cursor in #lowbar/.test(st2), st2.trim().slice(0, 400));
    const sendNoAs = await m2.call("send", { to: "room", text: "x", intent: "fyi" });
    ck("H2 a Cursor tool call without `as` is refused plainly (no guess, no names)", /can't tell which Cursor chat this is .* say which one with as: <its name>/.test(sendNoAs) && !/acme-cursor|#test4/.test(sendNoAs), sendNoAs.trim().slice(0, 300));
    const rAs = await m2.call("roster", { as: "acme-cursor" });
    ck("H2 with as: acme-cursor the tool acts as acme-cursor in #lowbar", /#lowbar/.test(rAs) && /acme-cursor \(this chat\)/.test(rAs), rAs.split("\n")[0]);
    await m2.close();
    // the CLI in each chat's shell knows its chat
    const s1 = await run(hC, ["status"], cur1, undefined, folder);
    const s2 = await run(hC, ["status"], cur2, undefined, folder);
    ck("H2 CLI: chat 1 is cursor (#test4), chat 2 is not cursor", /Acting as: cursor in #test4/.test(s1.out) && !/Acting as: cursor in #test4/.test(s2.out), `chat1: ${(s1.out.match(/Acting as:[^\n]*/) || [""])[0]}\nchat2: ${(s2.out.match(/Acting as:[^\n]*/) || [""])[0]}`);
    // hooks: chat 2's stop hook never nudges for chat 1's member
    // a Codex chat in #test4 asks cursor (chat 1's member) something
    const hP = join(base, "pinger");
    const pgEnv = { BOTLINK_APP: "codex", CODEX_THREAD_ID: "e2ecrit2-cccc-4222-8333-0000000000p1" };
    await joinChat(adam, await adam.chatInvite(room4.id), hP, "pinger", pgEnv);
    await run(hP, ["send", "--to", "cursor", "--intent", "question", "--text", "E2E-H2 for chat 1 only"], pgEnv);
    const hook2 = await run(hC, ["hook", "cursor", "session-start"], {}, JSON.stringify({ conversation_id: C2, session_id: C2, workspace_roots: [folder] }), folder);
    ck("H2 a new Cursor chat in the folder gets neither the members' identity nor their names", !/cursor in #test4|acme-cursor|#lowbar/.test(hook2.out) && hook2.code === 0, `exit ${hook2.code}, stdout ${JSON.stringify(hook2.out.trim().slice(0, 300))}`);
    const stop2 = await run(hC, ["hook", "cursor", "stop"], {}, JSON.stringify({ conversation_id: C2, workspace_roots: [folder], status: "completed" }), folder);
    const stop1 = await run(hC, ["hook", "cursor", "stop"], {}, JSON.stringify({ conversation_id: C1, workspace_roots: [folder], status: "completed" }), folder);
    ck("H2 Cursor stop hook: chat 2 is never nudged for chat 1's messages; chat 1 is", stop2.out.trim() === "" && /followup_message/.test(stop1.out), `chat2: ${JSON.stringify(stop2.out.trim())} · chat1: ${stop1.out.trim()}`);

    // ================================================================ M2: Claude Code self-test via the real Stop hook
    const hS = join(base, "cc2");
    const SS = "e2ecrit2-eeee-4222-8333-0000000000e1";
    const ccS = { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: SS };
    await joinChat(adam, invite, hS, "qa-lead", ccS);
    // the coordinator reads its inbox in a turn after the wake test is due: it picks the test up there (no FAILED)
    await new Promise((r) => setTimeout(r, 4000));
    const inTurn = await run(hS, ["inbox"], ccS);
    ck("M2 a self-test picked up by the chat's own inbox read in a turn: 'no result', never FAILED", /self-test for qa-lead: no result/.test(inTurn.out) && !/FAILED/.test(inTurn.out), (inTurn.out.match(/[^\n]*self-test for qa-lead[^\n]*/) || [""])[0]);
    // selftest, end the turn: the real Stop hook (Claude Code's asyncRewake waiter) shows it while idle
    await run(hS, ["selftest"], ccS);
    const stop = await run(hS, ["hook", "claude-code", "stop"], ccS, JSON.stringify({ session_id: SS, cwd: hS, hook_event_name: "Stop" }));
    ck("M2 the Stop hook delivers the self-test while idle: PASSED (exit 2)", stop.code === 2 && /self-test for qa-lead: PASSED \(wake test\)/.test(stop.err), `exit ${stop.code}: ${(stop.err.match(/[^\n]*self-test for qa-lead[^\n]*/) || [""])[0]}`);
    // another process saving a stale copy of the member record can't wipe it
    const st3 = await run(hS, ["status"], ccS);
    const res = await run(hS, ["selftest", "--result"], ccS);
    ck("M2 status + selftest --result: PASSED (not 'sent, not read yet')", /self-test reached the chat while idle ✓/.test(st3.out) && /PASSED/.test(res.out) && !/not read yet/.test(st3.out), `${(st3.out.match(/[^\n]*qa-lead in #[^\n]*/) || [""])[0]}\n${res.out.trim()}`);
    const hist = await run(hS, ["inbox", "--history"], ccS);
    ck("M2 history shows the earlier results as they were, never a new 'wake test failed'", !/wake test failed/.test(hist.out) && /self-test for qa-lead \(earlier\): PASSED/.test(hist.out), (hist.out.match(/[^\n]*\(earlier\)[^\n]*/g) || []).join("\n"));
    // the room sees it consistently: in a turn right after (no idle waiter running) it is still "wakes on its own"
    const lbl = (await adam.call("GET", `/app/v1/rooms/${room.id}`)).members.find((x: any) => x.name === "qa-lead")?.turn_label;
    ck("M2/L5 roster label: 'wakes on its own' while the chat works", lbl === "wakes on its own", `label: ${lbl}`);

    // ================================================================ M1: a listener dies silently
    const hL = join(base, "cursor-tester");
    const CT = "e2ecrit2-c003-4222-8333-000000000c03";
    const curT = { BOTLINK_APP: "cursor", CURSOR_CONVERSATION_ID: CT };
    await joinChat(adam, invite, hL, "cursor-tester", curT);
    const tId = memberId(hL, "cursor-tester");
    // its listen --once --print runs (held the wait), then dies (killed by its PID, like Cursor dropping it)
    const lp = spawn(process.execPath, [CLI, "listen", "--once", "--print", "--member", "cursor-tester"], { cwd: hL, env: envFor(hL, curT), stdio: "ignore" });
    for (let i = 0; i < 50 && sql(`select coalesce((last_wait_at > now() - interval '10 seconds')::text, 'false') from members where id = '${tId}'`) !== "true"; i++) await new Promise((r) => setTimeout(r, 200));
    const lblUp = (await adam.call("GET", `/app/v1/rooms/${room.id}`)).members.find((x: any) => x.name === "cursor-tester")?.turn_label;
    lp.kill("SIGKILL"); // by its PID
    await new Promise((r) => lp.on("exit", r));
    // 4 minutes pass (time-shift the server's view instead of sleeping)
    sql(`update members set last_wait_at = last_wait_at - interval '4 minutes', last_seen_at = last_seen_at - interval '4 minutes', last_poll_at = last_poll_at - interval '4 minutes' where id = '${tId}'`);
    const lblDown = (await adam.call("GET", `/app/v1/rooms/${room.id}`)).members.find((x: any) => x.name === "cursor-tester")?.turn_label;
    ck("M1 roster/dashboard: 'listener down' once the listener stopped reporting", lblDown === "listener down", `while listening: ${lblUp} → after it died: ${lblDown}`);
    const snd = await run(hX, ["send", "--to", "cursor-tester", "--intent", "question", "--text", "E2E-M1 are you there?"], cxEnv);
    ck("M1 the sender is told plainly", /cursor-tester \(listener down\)/.test(snd.out) && /cursor-tester: listener down\. That chat sees this when its human next opens it/.test(snd.out), snd.out.trim());
    const stT = await run(hL, ["status"], curT);
    ck("M1 the chat's status shows it and the exact re-arm command", /The room sees cursor-tester as: "listener down"/.test(stT.out) && /listen --once --print` as a background task/.test(stT.out), stT.out.split("\n").filter((l) => /listener down|wake path|re-arm/i.test(l)).join("\n"));
    const nextCall = await run(hL, ["roster"], curT);
    ck("M1 the chat's next bot-link call tells it to re-arm (self-healing note)", /wake path is DOWN[\s\S]*listen --once --print/.test(nextCall.out + nextCall.err), (nextCall.out.match(/[^\n]*wake path is DOWN[^\n]*/) || [""])[0]);
  } finally {
    await srv.stop();
  }
  const bad = results.filter((r) => !r[1]);
  console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await srv.stop();
  process.exit(1);
});
