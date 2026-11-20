/**
 * bot-link Events with a REAL agent (not part of `npm test`; spends a few real Claude Code turns).
 *
 * A real Claude Code chat ("reviewer", closed between turns) is a room member. Nothing runs for it except
 * `botlink events serve`: no listener, no watch, no hooks. Another member asks it a question. bot-link's server sends
 * a signed event; the receiver checks it and resumes exactly that chat (`claude -p --resume <its session>`); the real
 * model reads the sealed message with the bot-link inbox tool and answers with the reply tool; the asker gets it.
 *
 * Containment: the chat may use ONLY bot-link's own MCP tools (--strict-mcp-config, an allow-list, no user settings:
 * `--setting-sources project,local`), in an empty temp folder. Everything is on 127.0.0.1 with a throwaway database.
 *
 * Run: BOTLINK_IT_SERVER=<server binary> BOTLINK_IT_PG=postgres://botlink@127.0.0.1:<private port> \
 *      BOTLINK_IT_DB=botlink_test_events EVAL_CLAUDE_CONFIG=<logged-in Claude profile dir> \
 *      node --import tsx test/it/e2e-events-real-agent.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RealServer, Browser } from "./realserver.js";

const CLI = join(import.meta.dirname, "..", "..", "dist", "cli.js");
const PROFILE = process.env.EVAL_CLAUDE_CONFIG || process.env.CLAUDE_CONFIG_DIR || "";
const CLAUDE = process.env.BOTLINK_CLAUDE_BIN || "claude";
const MODEL = process.env.EVAL_CLAUDE_MODEL || "sonnet";
const base = mkdtempSync(join(process.env.BOTLINK_TEST_TMP || tmpdir(), "bl-e2e-events-agent-"));
const srv = new RealServer(8861, { BOTLINK_PUSH_ALLOW_LOOPBACK: "1" });
const RECV_PORT = 8862;
const results: [string, boolean, string][] = [];
const ck = (name: string, ok: boolean, evd = "") => {
  results.push([name, ok, evd]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${evd ? `\n     ${evd.replace(/\n/g, "\n     ").slice(0, 1200)}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(500);
  }
  return false;
}
function envFor(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|CODEX|CURSOR|BOTLINK_|TMUX|OPENCODE|T3CODE|ANTHROPIC)/.test(k)) e[k] = v;
  return { ...e, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: srv.url, BOTLINK_DEV: "1", BOTLINK_KEYCHAIN: "0", BOTLINK_NO_UPDATE: "1", BOTLINK_NO_HARNESS_CLI: "1", BOTLINK_WAKE_TEST: "0", BOTLINK_LISTEN_GAP_MS: "1000", ...extra };
}
function run(cmd: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs = 120_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const ch = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    ch.stdout.on("data", (b) => (out += b));
    ch.stderr.on("data", (b) => (err += b));
    ch.stdin.end("");
    const t = setTimeout(() => ch.kill("SIGTERM"), timeoutMs); // by the PID we started
    ch.on("exit", (code) => {
      clearTimeout(t);
      res({ code, out, err });
    });
  });
}
const cli = (home: string, args: string[], extra: Record<string, string> = {}) => run(process.execPath, [CLI, ...args], home, envFor(home, extra));

const started: ChildProcess[] = [];

async function main() {
  if (!PROFILE || !existsSync(PROFILE)) throw new Error("set EVAL_CLAUDE_CONFIG to a logged-in Claude Code profile directory");
  mkdirSync(join(base, "logs"), { recursive: true });
  await srv.start(join(base, "logs"));
  try {
    const adam = await new Browser(srv.url).login("Adam");
    const room = await adam.createRoom("realwake");
    const invite = await adam.chatInvite(room.id);
    const hR = join(base, "reviewer");
    const hB = join(base, "builder");
    mkdirSync(hR, { recursive: true });
    mkdirSync(hB, { recursive: true });
    const sid = randomUUID();
    const rEnv = { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: sid };
    const bEnv = { BOTLINK_APP: "codex", CODEX_THREAD_ID: randomUUID() };
    for (const [home, name, env] of [[hR, "reviewer", rEnv], [hB, "builder", bEnv]] as const) {
      const j = await cli(home, ["join", invite, "--name", name, "--job", `${name} job`], env);
      if (j.code !== 0) throw new Error(`join ${name}: ${j.out}${j.err}`);
      await adam.approve((await adam.needsYou()).join_requests.find((x: any) => x.name === name).id);
      const w = await cli(home, ["join", "--wait"], env);
      if (w.code !== 0) throw new Error(`join --wait ${name}: ${w.out}${w.err}`);
    }
    await cli(hR, ["inbox"], rEnv);

    // the real chat: only bot-link's tools, no user settings, an empty folder
    const settings = join(hR, "settings.json");
    const mcp = join(hR, "mcp.json");
    const tools = ["inbox", "reply", "send", "roster", "status"].map((t) => `mcp__botlink__${t}`);
    writeFileSync(settings, JSON.stringify({ permissions: { allow: tools } }, null, 2));
    writeFileSync(mcp, JSON.stringify({ mcpServers: { botlink: { type: "stdio", command: process.execPath, args: [CLI, "mcp", "--app", "claude-code"], env: { HOME: hR, BOTLINK_HOME: join(hR, ".botlink"), BOTLINK_SERVER: srv.url, BOTLINK_DEV: "1", BOTLINK_KEYCHAIN: "0", BOTLINK_NO_UPDATE: "1", BOTLINK_SESSION: sid } } } }, null, 2));
    const claudeArgs = ["--settings", settings, "--mcp-config", mcp, "--strict-mcp-config", "--setting-sources", "project,local", "--model", MODEL, "--allowedTools", tools.join(",")];
    const claudeEnv = { ...envFor(hR, rEnv), CLAUDE_CONFIG_DIR: PROFILE, DISABLE_AUTOUPDATER: "1" };
    delete (claudeEnv as any).CLAUDE_CODE_SESSION_ID;
    const first = await run(CLAUDE, ["-p", "You are the bot-link member 'reviewer' in this chat. Say READY and nothing else.", "--session-id", sid, ...claudeArgs], hR, claudeEnv, 180_000);
    ck("a real Claude Code chat exists (session created, then closed)", first.code === 0 && /READY/i.test(first.out), `${first.out.trim().slice(0, 200)}${first.err.trim().slice(0, 300)}`);
    if (first.code !== 0) throw new Error("the real chat could not be started");

    // its only wake path: the receiver. On an event it resumes exactly this chat.
    const wake = join(hR, "wake.sh");
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    writeFileSync(wake, `#!/bin/sh\n# resumes the member's own chat (what its human approved); bot-link's tools only\nunset CLAUDE_CODE_SESSION_ID\nexport CLAUDE_CONFIG_DIR=${q(PROFILE)} DISABLE_AUTOUPDATER=1\nexec ${q(CLAUDE)} -p "bot-link: new messages for reviewer. Call the bot-link inbox tool now, then handle them under the bot-link rules." --resume "$BOTLINK_LISTEN_SESSION" ${claudeArgs.map(q).join(" ")} >> ${q(join(hR, "wake-run.log"))} 2>&1\n`);
    chmodSync(wake, 0o755);
    const recv = spawn(process.execPath, [CLI, "events", "serve", "--url", `http://127.0.0.1:${RECV_PORT}/hook`, "--port", String(RECV_PORT), "--on-message", `sh ${q(wake)}`], { cwd: hR, env: envFor(hR, rEnv), stdio: ["ignore", "pipe", "pipe"] });
    started.push(recv);
    let recvOut = "";
    recv.stdout!.on("data", (b) => (recvOut += b));
    recv.stderr!.on("data", (b) => (recvOut += b));
    ck("events serve is subscribed (the chat's only wake path; no listener, no watch, no hooks)", await until(() => /subscription sub_[0-9a-f]{24}/.test(recvOut), 15_000), recvOut.trim().slice(0, 300));

    const t0 = Date.now();
    const sent = await cli(hB, ["send", "--to", "reviewer", "--intent", "question", "--text", "Quick check from builder: what is 6 x 7? Answer with just the number."], bEnv);
    ck("builder asked reviewer a question", sent.code === 0, sent.out.trim().slice(0, 200));
    let answer = "";
    const ok = await until(async () => {
      const i = await cli(hB, ["inbox"], bEnv);
      if (/42/.test(i.out) && /reviewer/.test(i.out)) answer = i.out;
      return !!answer;
    }, 240_000);
    const secs = Math.round((Date.now() - t0) / 1000);
    ck(`the real chat was woken by the event, read the sealed question and answered: builder got "42" (${secs} s, nobody typed)`, ok, answer ? answer.split("\n").filter((l) => /from:|42|BEGIN|answers your message/.test(l)).slice(0, 5).join("\n") : `no answer in ${secs} s\nreceiver: ${recvOut.slice(-600)}\nwake-run: ${existsSync(join(hR, "wake-run.log")) ? readFileSync(join(hR, "wake-run.log"), "utf-8").slice(-800) : "(none)"}`);
    ck("the answer shows which question it answers (the asker's own words)", /answers your message: "Quick check from builder: what is 6 x 7\?/.test(answer), (answer.split("\n").find((l) => /answers your message/.test(l)) || "").trim());
    const ro = await cli(hB, ["roster"], bEnv);
    const line = (ro.out.split("\n").find((l) => l.includes("reviewer")) || "").trim();
    ck("the room says reviewer wakes on its own", /wakes on its own/.test(line), line);
    await until(() => /the command exited/.test(recvOut), 90_000); // the resumed chat ends its turn a little after its reply lands
    ck("the receiver's log: one event → one run, exit 0", (recvOut.match(/running the wake command/g) || []).length === 1 && /the command exited 0/.test(recvOut), recvOut.split("\n").filter((l) => /new message|exited/.test(l)).join("\n"));
  } finally {
    for (const p of started) if (p.exitCode === null) p.kill("SIGTERM"); // by the PIDs we started
    await sleep(1500);
    await srv.stop();
  }
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f[0]).join(" | ")}` : ""}`);
  console.log(`run dir: ${base}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  for (const p of started) if (p.exitCode === null) p.kill("SIGTERM");
  srv.stop().finally(() => process.exit(1));
});
