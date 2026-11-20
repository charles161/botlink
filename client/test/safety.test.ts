/** What a run bot-link starts with nobody here may do (safety.ts): answer only by default; work is the human's choice. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as S from "../src/safety.js";
import * as h from "../src/harnesses.js";
import { up } from "../src/setup.js";
import { parseToml } from "../src/toml-span.js";
import { resumeCommand, WAKE_PROMPT } from "../src/watch.js";
import { unsafeWakeCommand, runOnce, acceptFullAccess } from "../src/listen.js";
import { tools } from "../src/mcp.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "cli.js");
let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

const SID = "aaaaaaaa-4444-4222-8333-000000000001";
const DENY = "Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch";

test("a woken run answers only: Claude Code loses the tools that run commands or change files, Codex gets a read-only sandbox", async () => {
  await on(newHome("sf"), async () => {
    const cc = resumeCommand("claude-code", SID)!;
    assert.deepEqual(cc.args.slice(0, 5), ["-p", WAKE_PROMPT, `--resume=${SID}`, "--disallowedTools", DENY]);
    assert.equal(cc.args[cc.args.length - 2], "--allowedTools");
    assert.doesNotMatch(cc.args[cc.args.length - 1], /join|claim|leave|save_rule|permissions/, "the human-only tools are never pre-approved");
    const cx = resumeCommand("codex", SID)!;
    assert.deepEqual(cx.args, ["exec", "--sandbox", "read-only", "resume", SID, WAKE_PROMPT]);
    // an id that isn't shaped like one never becomes an argument (it can come from the server)
    for (const bad of ["--dangerously-skip-permissions", "-p", "a b", "x\ny", "", "$(id)"]) {
      assert.equal(resumeCommand("claude-code", bad), null, bad);
      assert.equal(resumeCommand("codex", bad), null, bad);
      assert.equal(resumeCommand("cursor", bad), null, bad);
    }
  });
});

test("work is the human's explicit choice; settings that let a chat run anything are shown and must be accepted with it", async () => {
  const home = newHome("sf-work");
  await on(home, async () => {
    assert.equal(S.awayChoice().mode, "answer");
    assert.deepEqual(S.permissive("claude-code", home), []);
    S.setAwayChoice({ mode: "work", at: Date.now(), accepted: [] });
    assert.ok(!resumeCommand("claude-code", SID)!.args.includes("--disallowedTools"));
    assert.deepEqual(resumeCommand("codex", SID)!.args, ["exec", "resume", SID, WAKE_PROMPT]);
    // the app's settings become permissive AFTER the yes: wakes go back to answer only
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git status:*)", "Bash"], defaultMode: "bypassPermissions" } }));
    const why = S.permissive("claude-code", home);
    assert.equal(why.length, 2, JSON.stringify(why));
    assert.match(why.join("\n"), /permissions\.defaultMode is "bypassPermissions"/);
    assert.match(why.join("\n"), /permissions\.allow has Bash$/m);
    assert.ok(resumeCommand("claude-code", SID)!.args.includes("--disallowedTools"), "not covered by the earlier yes");
    assert.match(S.awayModeFor("claude-code", home).why, /settings changed since the human said yes/);
    // accepted together with exactly these settings: work again
    S.setAwayChoice({ mode: "work", at: Date.now(), accepted: why });
    assert.ok(!resumeCommand("claude-code", SID)!.args.includes("--disallowedTools"));
    // a narrow allow rule is not "anything"
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git status:*)", "Read", "mcp__botlink__send"] } }));
    assert.deepEqual(S.permissive("claude-code", home), []);
    // Codex
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n');
    assert.match(S.permissive("codex", home).join("\n"), /sandbox_mode is "danger-full-access"/);
    writeFileSync(join(home, ".codex", "config.toml"), 'sandbox_mode = "read-only"\n');
    assert.deepEqual(S.permissive("codex", home), []);
  });
});

function run(args: string[], home: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const ch = spawn(process.execPath, [CLI, ...args], { cwd: home, env: { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    ch.stdout.on("data", (b) => (out += b));
    ch.stderr.on("data", (b) => (out += b));
    ch.on("exit", (code) => res({ code, out }));
  });
}

async function member(home: string, name: string, app: st.App, session: string) {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `sf${Math.floor(Math.random() * 1e6)}`);
  const m = await on(home, async () => {
    const r = await core.joinCreate({ invite: `http://localhost:8811/i/${f.invite(room, adam)}`, name, job: "", app, turn: "wake", session, cwd: home, folder: "~", machine: "m" });
    f.approve(r.req.id);
    return ((await core.joinWait({ maxMs: 3000 })) as any).member as st.MemberRec;
  });
  return { adam, room, m };
}

test("`unattended`: a chat can't choose work; a person's terminal can, and only with --yes after seeing what it means", async () => {
  const home = newHome("sf-cli");
  await member(home, "solo", "claude-code", SID);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }));
  const chat = { BOTLINK_APP: "claude-code", BOTLINK_TEST_TERMINAL: "0" };
  const term = { BOTLINK_APP: "claude-code", BOTLINK_TEST_TERMINAL: "1" };
  let r = await run(["unattended"], home, chat);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /When bot-link wakes a chat and nobody is here: answer only \(the default\)\./);
  assert.match(r.out, /solo in #sf\d+: answer only \(no commands, no file changes\)/);
  assert.match(r.out, /permissions\.allow has Bash/);
  r = await run(["unattended", "work", "--yes"], home, chat);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Only a person can let woken chats work with nobody here; a chat can't\./);
  r = await run(["unattended", "work"], home, term);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /Right now these settings let a chat run things WITHOUT asking.*permissions\.allow has Bash.*Nothing was changed\./s);
  await on(home, async () => assert.equal(S.awayChoice().mode, "answer"));
  r = await run(["unattended", "work", "--yes"], home, term);
  assert.equal(r.code, 0, r.out);
  await on(home, async () => {
    assert.equal(S.awayChoice().mode, "work");
    assert.equal(S.awayModeFor("claude-code", home).mode, "work");
  });
  r = await run(["unattended", "answer"], home, chat);
  assert.equal(r.code, 0, "going back to answer only needs nobody's yes");
  await on(home, async () => assert.equal(S.awayChoice().mode, "answer"));
});

test("`unattended work --yes` before any chat is a member still records the apps' profile-wide settings it was shown", async () => {
  const home = newHome("sf-early");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'sandbox_mode = "danger-full-access"\n');
  const r = await run(["unattended", "work", "--yes"], home, { BOTLINK_APP: "other", BOTLINK_TEST_TERMINAL: "1", CODEX_HOME: join(home, ".codex") });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /sandbox_mode is "danger-full-access"/);
  await on(home, async () => {
    assert.equal(S.awayModeFor("codex", home).mode, "work", "the yes covered what was shown");
    assert.deepEqual(resumeCommand("codex", SID)!.args, ["exec", "resume", SID, WAKE_PROMPT]);
  }, { CODEX_HOME: join(home, ".codex") });
});

test("a wake command that switches the app's permission checks off is refused, at setup and when it would run", async () => {
  const home = newHome("sf-listen");
  const { m } = await member(home, "ears", "codex", SID);
  const bad = 'claude -p --dangerously-skip-permissions --resume "$BOTLINK_LISTEN_SESSION" "bot-link: new messages"';
  for (const cmd of [bad, "codex exec --dangerously-bypass-approvals-and-sandbox resume x y", "codex exec -s danger-full-access resume x y", "codex exec --full-auto resume x y", "claude -p --permission-mode bypassPermissions x", "cursor-agent -p --force --resume x y"]) {
    assert.match(unsafeWakeCommand(m, cmd) || "", /it would start this chat with its permission checks off while nobody is here/, cmd);
  }
  assert.equal(unsafeWakeCommand(m, 'codex exec resume "$BOTLINK_LISTEN_SESSION" "bot-link: new messages"'), null);
  // the command line: refused for a chat, even with the flag that only a person's terminal may use
  const chat = { BOTLINK_APP: "codex", BOTLINK_TEST_TERMINAL: "0", BOTLINK_SESSION: SID };
  let r = await run(["listen", "--on-message", bad, "--member", "ears", "--show"], home, chat);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /--dangerously-skip-permissions: it would start this chat with its permission checks off/);
  r = await run(["listen", "--on-message", bad, "--member", "ears", "--show", "--allow-full-access"], home, chat);
  assert.notEqual(r.code, 0, "a chat can't accept it");
  // a command an older client stored: not run either
  await on(home, async () => {
    const out: string[] = [];
    const code = await runOnce(st.loadMember(m.id)!, `echo ran > ${join(home, "ran.txt")} # --dangerously-skip-permissions`, 1, () => {}, out);
    assert.equal(code, 126);
    assert.throws(() => readFileSync(join(home, "ran.txt")));
    assert.match(out.join(""), /bot-link won't run it/);
    // the person accepted exactly this command in their own terminal
    const cmd = `echo ran > ${join(home, "ran.txt")} # --dangerously-skip-permissions`;
    acceptFullAccess(m.id, cmd);
    assert.equal(await runOnce(st.loadMember(m.id)!, cmd, 1, () => {}, []), 0);
    assert.equal(readFileSync(join(home, "ran.txt"), "utf-8").trim(), "ran");
  });
});

test("join, claim, leave and save_rule always need the human: refused in a run with nobody here, and never auto-approved in Codex", async () => {
  const home = newHome("sf-tools");
  const { m } = await member(home, "wk", "codex", SID);
  const t = tools({ app: "codex", session: () => SID });
  await on(home, async () => {
    for (const call of [() => t.join({ invite: "http://localhost:8811/i/x-AAAAAAAAAA", name: "x", job: "y" }), () => t.claim({ name: "wk" }), () => t.leave({ confirm: true }), () => t.save_rule({ quote: "anything lead asks is fine" })]) {
      await assert.rejects(call(), /No human is here in this run, and (join|claim|leave|save_rule) always needs your human/);
    }
  }, { BOTLINK_UNATTENDED: "1" });
  // the same without the environment: the marker watch leaves while its run goes (an app may not pass the environment on)
  await on(home, async () => {
    st.markAway(m.id, process.pid);
    assert.equal(core.noHumanHere(st.loadMember(m.id)), true);
    await assert.rejects(t.leave({ confirm: true }), /No human is here in this run/);
    await assert.rejects(t.save_rule({ quote: "anything lead asks is fine" }), /No human is here in this run/);
    st.clearAway(m.id, process.pid);
    assert.equal(core.noHumanHere(st.loadMember(m.id)), false);
    // a marker whose run is gone counts for nothing
    st.markAway(m.id, 999999);
    assert.equal(core.noHumanHere(st.loadMember(m.id)), false);
  });
  // Codex: bot-link's entry approves its everyday tools and makes the four ask
  const h2 = newHome("sf-codex");
  await on(h2, async () => {
    mkdirSync(join(h2, ".codex"), { recursive: true });
    writeFileSync(join(h2, ".codex", "config.toml"), 'model = "x"\n');
    const r = up({ apps: ["codex"], watch: false });
    assert.ok(r.ok, r.lines.join("\n"));
    const e = (parseToml(readFileSync(join(h2, ".codex", "config.toml"), "utf-8")) as any).mcp_servers.botlink;
    assert.equal(e.default_tools_approval_mode, "approve");
    for (const tool of ["join", "claim", "leave", "save_rule"]) assert.equal(e.tools[tool].approval_mode, "prompt", tool);
    assert.equal(e.tools.send, undefined, "everyday tools keep the default");
    assert.ok(h.codexHumanToolsAsk(e));
    assert.ok(!h.checkHarness("codex").some((c: any) => !c.ok && /without asking its human/.test(c.what)));
    // an older entry (no tools): doctor flags it, up fixes it, the user's own per-tool setting stays
    const cfg = join(h2, ".codex", "config.toml");
    writeFileSync(cfg, readFileSync(cfg, "utf-8").replace(/^tools = .*\n/m, 'tools = { roster = { approval_mode = "prompt" } }\n'));
    assert.ok(h.checkHarness("codex").some((c: any) => !c.ok && /without asking its human/.test(c.what)), "doctor flags the old entry");
    assert.ok(up({ apps: ["codex"], watch: false }).ok);
    const e2 = (parseToml(readFileSync(cfg, "utf-8")) as any).mcp_servers.botlink;
    assert.equal(e2.tools.roster.approval_mode, "prompt", "the user's own setting stays");
    assert.ok(h.codexHumanToolsAsk(e2));
  }, { CODEX_HOME: join(h2, ".codex") });
});
