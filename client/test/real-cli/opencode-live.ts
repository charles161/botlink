/**
 * Real OpenCode check (item 5 d): the real `opencode` CLI, headless, against the real Go server.
 *   - `botlink up --app opencode --dev` writes OpenCode's MCP entry in an isolated XDG_CONFIG_HOME;
 *   - an OpenCode chat (free model, no API key) joins with the bot-link MCP join tool: bot-link detects OpenCode
 *     (app other + app_name "OpenCode" on the wire, "opencode" locally);
 *   - a Claude Code teammate (scripted, core API) asks it a question;
 *   - `botlink listen --on-message "opencode run --continue …"` wakes it; the woken run reads its inbox (the live bug:
 *     it never did) and answers with the reply tool; the server shows it "listening now".
 * Never touches the real ~/.config/opencode, ~/.local/share/opencode: HOME and every XDG dir are a temp dir.
 * Database botlink_test_opencode on the private 127.0.0.1:55432 (dropped and recreated); server on 127.0.0.1:8824.
 *
 *   cd client && npm run build && (cd .. && go build -o /tmp/x/botlink-server ./server/cmd/botlink)
 *   BOTLINK_IT_SERVER=/tmp/x/botlink-server BOTLINK_IT_PG=postgres://botlink@127.0.0.1:55432 OPENCODE_BIN=<opencode> \
 *     node --import tsx test/real-cli/opencode-live.ts [--model opencode/big-pickle]
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Browser } from "../it/realserver.js";

const PSQL = "/usr/lib/postgresql/16/bin/psql";
const PORT = 8824;
const DB = "botlink_test_opencode";
const MODEL = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : "opencode/big-pickle";
const BIN = process.env.OPENCODE_BIN || "opencode";
const CLI = join(import.meta.dirname, "..", "..", "dist", "cli.js");
const base = (process.env.BOTLINK_IT_PG || "").replace(/\/+$/, "");
if (!/^postgres:\/\/[^@]+@127\.0\.0\.1:55432$/.test(base)) throw new Error("BOTLINK_IT_PG must be the private dev cluster on 127.0.0.1:55432");

const T = mkdtempSync(join(tmpdir(), "botlink-opencode-"));
const log = (s: string) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${s}\n`);
const psql = (db: string, q: string) => {
  const r = spawnSync(PSQL, [`${base}/${db}`, "-tA", "-c", q], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

function homeEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: `${join(BIN, "..")}:${process.env.PATH}`, HOME: home, TERM: "dumb",
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
    BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: `http://127.0.0.1:${PORT}`, BOTLINK_DEV: "1", BOTLINK_KEYSTORE: "file",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 300_000): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { env, cwd });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs); // by the PID we started
    p.on("exit", (code) => {
      clearTimeout(t);
      res({ code, out });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail]);
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` · ${detail}` : ""}`);
};

async function main() {
  // server
  for (const q of [`drop database if exists ${DB} with (force)`, `create database ${DB}`]) psql("postgres", q);
  const senv = { PATH: process.env.PATH, HOME: T, BOTLINK_ENV: "dev", BOTLINK_ADDR: `127.0.0.1:${PORT}`, BOTLINK_COPY_ID: "OC", BOTLINK_DATABASE_URL: `${base}/${DB}`,
    BOTLINK_APP_ORIGIN: `http://127.0.0.1:${PORT}`, BOTLINK_DEV_LOGIN: "1", BOTLINK_HUMAN_CHECK: "stub", BOTLINK_METRICS_ADDR: "off", BOTLINK_RETRY_MS: "0" };
  const m = spawnSync(process.env.BOTLINK_IT_SERVER!, ["migrate"], { env: senv, encoding: "utf-8" });
  if (m.status !== 0) throw new Error(m.stdout + m.stderr);
  const server = spawn(process.env.BOTLINK_IT_SERVER!, [], { env: senv, stdio: ["ignore", openSync(join(T, "server.log"), "a"), openSync(join(T, "server.log"), "a")] });
  let listener: ReturnType<typeof spawn> | null = null;
  try {
    for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${PORT}/readyz`).then((r) => r.ok, () => false)); i++) await sleep(100);
    const adam = await new Browser(`http://127.0.0.1:${PORT}`).login("Adam");
    const room = await adam.createRoom("ocroom", "OpenCode check");
    const invite = await adam.chatInvite(room.id);

    // OpenCode's computer
    const home = join(T, "oc-home");
    const proj = join(home, "proj");
    mkdirSync(proj, { recursive: true });
    const env = homeEnv(home);
    const up = await run(process.execPath, [CLI, "setup", "opencode", "--scope", "user", "--yes", "--no-shim", "--dev"], env, proj);
    const cfg = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf-8"));
    check("up --app opencode writes the MCP entry", up.code === 0 && cfg.mcp?.botlink?.type === "local" && cfg.mcp.botlink.command.slice(-1)[0] === "opencode", up.out.trim().split("\n")[0]);
    const mcpList = await run(BIN, ["mcp", "list"], env, proj, 60_000);
    check("opencode sees the botlink MCP server", /botlink/.test(mcpList.out) && !/failed|error/i.test(mcpList.out.split("\n").filter((l) => /botlink/.test(l)).join("\n")), mcpList.out.replace(/\s+/g, " ").slice(0, 200));

    // 1. join with the MCP tool (the human already agreed to the name and job)
    const j = await run(BIN, ["run", "-m", MODEL, "--format", "json", `My human pasted a bot-link invite: ${invite} . We agreed you join as name "sec-oc" with job "security research". Call the bot-link join tool now with invite, name and job (no other tools). Then tell me the code it printed.`], env, proj);
    writeFileSync(join(T, "join.jsonl"), j.out);
    const card = (await adam.needsYou()).join_requests.find((x: any) => x.name === "sec-oc");
    check("the OpenCode chat called join (MCP)", !!card, card ? `code ${card.match_code}` : j.out.slice(-300));
    if (!card) return;
    check("join request: app other + app_name OpenCode", card.app === "other" && card.app_name === "OpenCode", `${card.app} / ${card.app_name}`);
    await adam.approve(card.id);
    const w = await run(BIN, ["run", "--continue", "-m", MODEL, "--format", "json", "Your human approved it. Call the bot-link join tool with wait: true now, then call the bot-link presence tool. Report what they said."], env, proj);
    writeFileSync(join(T, "wait.jsonl"), w.out);
    const local = JSON.parse(readFileSync(join(home, ".botlink", "members", `${card.member_id}.json`), "utf-8"));
    check("joined; local member app opencode", local.app === "opencode" && local.app_name === "OpenCode", `${local.app} / ${local.app_name}`);
    const seen = psql(DB, `select coalesce(last_seen_at > now() - interval '90 seconds', false) from members where id = '${card.member_id}'`);
    check("presence/inbox from OpenCode reached the server", seen === "t", `last_seen fresh: ${seen}`);

    // 2. a Claude Code teammate (scripted with the client core) joins and asks a question
    const leadHome = join(T, "lead-home");
    mkdirSync(join(leadHome, "w"), { recursive: true });
    const lenv = { ...homeEnv(leadHome), BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: "11111111-2222-4333-8444-000000000001" };
    const lj = await run(process.execPath, [CLI, "join", invite, "--name", "lead", "--job", "lead", "--no-setup"], lenv, join(leadHome, "w"));
    const lcard = (await adam.needsYou()).join_requests.find((x: any) => x.name === "lead");
    if (!lcard) throw new Error(`lead join failed: ${lj.out}`);
    await adam.approve(lcard.id);
    await run(process.execPath, [CLI, "join", "--wait"], lenv, join(leadHome, "w"));
    const s = await run(process.execPath, [CLI, "send", "--to", "sec-oc", "--intent", "question", "--text", "What is the capital of France? Answer with one word using the bot-link reply tool."], lenv, join(leadHome, "w"));
    check("lead sent a question", s.code === 0, s.out.trim().slice(0, 120));

    // 3. sec-oc's listener wakes the OpenCode chat (the live bug's path)
    const wake = `${BIN} run --continue -m ${MODEL} "bot-link: you have new messages. Call the bot-link inbox tool now, then answer each with the bot-link reply tool."`;
    listener = spawn(process.execPath, [CLI, "listen", "--member", "sec-oc", "--on-message", wake, "--max-s", "420"], { env: { ...env }, cwd: proj, stdio: ["ignore", openSync(join(T, "listen.log"), "a"), openSync(join(T, "listen.log"), "a")] });
    let answered = "";
    for (let i = 0; i < 80 && !answered; i++) {
      await sleep(5000);
      const inb = await run(process.execPath, [CLI, "inbox"], lenv, join(leadHome, "w"));
      if (/from: sec-oc/.test(inb.out)) answered = inb.out;
    }
    const st = psql(DB, `select string_agg(d.state, ',') from deliveries d join members m on m.id = d.member_id where m.name = 'sec-oc'`);
    const poll = psql(DB, `select last_poll_at is not null from members where name = 'sec-oc'`);
    check("woken OpenCode run read its inbox (last_poll_at set; copy not stuck)", poll === "t" && !/stuck/.test(st), `states ${st}, polled ${poll}`);
    check("lead got sec-oc's reply", !!answered && /paris/i.test(answered), answered.replace(/\s+/g, " ").slice(0, 200));
    const label = (await adam.call("GET", `/app/v1/rooms/${room.id}`)).members.find((x: any) => x.name === "sec-oc");
    check("dashboard: OpenCode name + an honest label", label?.app_name === "OpenCode" && /^(wakes on its own|answers on its next turn)$/.test(label?.turn_label || ""), `${label?.app_name} · ${label?.turn_label}`);
  } finally {
    if (listener && listener.exitCode === null) listener.kill("SIGTERM"); // by PID
    server.kill("SIGTERM");
    log(`artifacts: ${T}`);
    const pass = results.every((r) => r[1]);
    log(`${results.filter((r) => r[1]).length}/${results.length} checks passed${pass ? "" : " (FAIL)"}`);
    process.exitCode = pass ? 0 : 1;
  }
}

await main();
