/**
 * Real-CLI matrix (PLAN §5.3). Each message carries a unique token BLTOK-<cell>-<n>-<rand>; it counts as delivered
 * only if the token appears in MODEL-VISIBLE context in the session transcript (hook additionalContext, Stop rewake
 * text, or an inbox tool result) AND the server shows the copy `shown` (or `done`). Pass: N/N per cell, 0 stuck,
 * 0 duplicates shown without the "re-delivered" flag. Writes a per-cell table to RESULTS.md.
 *
 *   node --import tsx test/real-cli/matrix.ts --claude-config <dir> [--codex-home <dir>] [--cursor-home <dir>] [--apps claude-code,codex,cursor]
 *        [--cells session-start,resume,restart,idle,cross-person,reply] [--n 20] [--reply-n 3] [--gap-s 3] [--stub] [--out RESULTS.md]
 * `reply` (FINDINGS F1): the chat's human saves a standing rule (save_rule), then watch wakes it for each of
 * --reply-n messages and the model must CALL the bot-link reply tool; pass = every answer reaches the sender as a
 * reply (in_reply_to + token), no tool call refused for approval, the rule saved.
 *
 * Isolation: HOME, XDG and BOTLINK_HOME are temp dirs; the real Go server runs on 127.0.0.1:8822 against the private
 * dev Postgres (55432/botlink_test_client, reset at start; don't run it at the same time as scripts/run-it.sh).
 * Claude Code gets bot-link's hooks + MCP server through --settings / --mcp-config (the profile's own config files are
 * never edited); CLAUDE_CONFIG_DIR must be a profile that is already logged in. Codex needs a dedicated, logged-in
 * CODEX_HOME (bot-link's entry and hooks are written there with `botlink up --app codex`, and resumes pass
 * --dangerously-bypass-hook-trust so untrusted hooks still run in this test home only).
 * Cursor (cursor-agent) needs a dedicated, logged-in HOME (--cursor-home; cursor keeps its login in
 * $HOME/.config/cursor): `botlink up --app cursor` writes bot-link's mcp.json + hooks.json into that HOME's ~/.cursor
 * (with the client's own ledger + backups) and `botlink uninstall cursor` takes them out again at the end. Cursor cells:
 * `session-start` (20 sends, then a NEW headless chat in the member's folder: its sessionStart hook shows them),
 * `resume` (a chat joins with turn=wake from its shell, so CURSOR_CONVERSATION_ID names it; 20 sends; the real
 * `botlink watch` resumes it with `cursor-agent -p --resume <id> "<wake prompt>"`: Cursor runs no sessionStart hook
 * on resume, so delivery is the model calling the bot-link inbox tool) and `restart` (as resume, but watch is killed
 * by its PID before the 20 sends and started again after them). Headless MCP calls are allowed by the
 * Mcp(botlink:*) rule `botlink up` adds to cursor-agent's cli-config.json. Model-visible text is read from the
 * chat's store.db (hooks_context in the prompt, tool results), never the model's own replies.
 * --stub replaces both CLIs with test/real-cli/stub-harness.mjs (no model): it checks the harness plumbing only.
 * Kills only PIDs it started (never pkill -f).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
const RUN_STARTED_MS = Date.now();
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import * as c from "../../src/crypto.js";
import { IT, RealServer, Browser, sql } from "../it/realserver.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");
const STUB = join(import.meta.dirname, "stub-harness.mjs");

function args() {
  const a: Record<string, string | boolean> = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (!v[i].startsWith("--")) continue;
    const k = v[i].slice(2);
    if (i + 1 < v.length && !v[i + 1].startsWith("--")) a[k] = v[++i];
    else a[k] = true;
  }
  return a;
}
const A = args();
const STUBBED = !!A.stub;
const N = Number(A.n || 20);
const GAP_MS = Number(A["gap-s"] || 3) * 1000;
type MxApp = "claude-code" | "codex" | "cursor";
const APPS = String(A.apps || "claude-code,codex").split(",") as MxApp[];
const CELLS = String(A.cells || "idle,session-start,resume,restart,cross-person,reply").split(",");
const OUT = String(A.out || join(import.meta.dirname, "RESULTS.md"));
const PORT = 8822;

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(2);
}

if (!IT) die("set BOTLINK_IT_SERVER (built server binary) and BOTLINK_IT_PG=postgres://botlink@127.0.0.1:55432");
const realHome = userInfo().homedir;
const claudeConfig = STUBBED ? "" : String(A["claude-config"] || "");
const codexHome = STUBBED ? "" : String(A["codex-home"] || "");
if (!STUBBED && APPS.includes("claude-code") && !claudeConfig) die("--claude-config <logged-in CLAUDE_CONFIG_DIR> is required (or --stub)");
if (!STUBBED && APPS.includes("codex")) {
  if (!codexHome) die("--codex-home <dedicated logged-in CODEX_HOME> is required for Codex cells (or --apps claude-code)");
  if (resolve(codexHome) === join(realHome, ".codex")) die("refusing the real ~/.codex: use a dedicated CODEX_HOME (CODEX_HOME=<dir> codex login)");
}
const cursorHome = STUBBED ? "" : String(A["cursor-home"] || "");
if (APPS.includes("cursor")) {
  if (STUBBED) die("--stub has no Cursor harness: run Cursor cells for real (--cursor-home)");
  if (!cursorHome) die("--cursor-home <dedicated logged-in HOME for cursor-agent> is required for Cursor cells");
  if (resolve(cursorHome) === resolve(realHome)) die("refusing the real HOME for Cursor: use a dedicated, logged-in test HOME");
}
const cursorBin = String(A["cursor-bin"] || (cursorHome ? join(cursorHome, ".local", "bin", "cursor-agent") : "cursor-agent"));
if (claudeConfig && resolve(claudeConfig) === join(realHome, ".claude")) die("refusing the real ~/.claude: pass a logged-in profile dir");

const base = mkdtempSync(join(process.env.BOTLINK_TEST_TMP || tmpdir(), "botlink-matrix-"));
const started: ChildProcess[] = [];
const CURSOR_BOTLINK_HOME = join(base, "cursor-botlink");
const log = (s: string) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ per-chat environment
interface Chat {
  label: string;
  home: string;
  work: string;
  env: NodeJS.ProcessEnv;
  app: MxApp | "other";
  botlinkHome: string;
  session: string | null;
  member?: string;
  settings?: string;
  mcp?: string;
}

function chatEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: `http://127.0.0.1:${PORT}`, BOTLINK_KEYCHAIN: "0", BOTLINK_NO_HARNESS_CLI: "1", LANG: "C.UTF-8", TERM: "xterm-256color",
    // r2: the join's self-test would reach watch before the cell's chat exists (a fresh --session-id), and a resume of a
    // not-yet-created session marks the member cannot_wake. The self-test is measured by eval s27; cells measure messages.
    BOTLINK_NO_SELFTEST: "1", ...extra };
  return e;
}

function newChat(label: string, app: Chat["app"]): Chat {
  const home = join(base, label);
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  const extra: NodeJS.ProcessEnv = {};
  if (app === "cursor") {
    // cursor-agent needs its logged-in HOME; bot-link state is one shared temp BOTLINK_HOME (mcp.json pins it)
    // headless runs reject every MCP tool call unless permitted: `botlink up --app cursor` (main) adds Mcp(botlink:*)
    // to cursor-agent's cli-config.json; no per-workspace .cursor/cli.json is written. watch resumes with this binary.
    const ch: Chat = { label, home: cursorHome, work, env: chatEnv(cursorHome, { BOTLINK_HOME: CURSOR_BOTLINK_HOME, BOTLINK_CURSOR_BIN: cursorBin }), app, session: null, botlinkHome: CURSOR_BOTLINK_HOME };
    return ch;
  }
  if (app === "claude-code") {
    if (STUBBED) Object.assign(extra, { BOTLINK_CLAUDE_BIN: STUB, STUB_APP: "claude-code", STUB_CLI: CLI, STUB_TRANSCRIPTS: join(home, "transcripts") });
    else extra.CLAUDE_CONFIG_DIR = claudeConfig;
  }
  if (app === "codex") {
    if (STUBBED) Object.assign(extra, { BOTLINK_CODEX_BIN: STUB, STUB_APP: "codex", STUB_CLI: CLI, STUB_TRANSCRIPTS: join(home, "transcripts") });
    else extra.CODEX_HOME = codexHome;
  }
  // the scripted sender is its own (unknown) app: say so, whatever process tree runs the matrix (r2: a chat acts
  // only as its own app's members)
  if (app === "other") extra.BOTLINK_APP = "other";
  const ch: Chat = { label, home, work, env: chatEnv(home, extra), app, session: null, botlinkHome: join(home, ".botlink") };
  if (app === "claude-code") {
    // hooks + MCP via flags: nothing is written into the profile
    const hook = (ev: string) => `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} hook claude-code ${ev}`;
    ch.settings = join(home, "botlink-settings.json");
    writeFileSync(ch.settings, JSON.stringify({ hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: hook("session-start"), timeout: 30 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: hook("prompt"), timeout: 25 }] }],
      Stop: [{ hooks: [{ type: "command", command: hook("stop"), asyncRewake: true, timeout: 3600 }] }],
    } }, null, 2));
    ch.mcp = join(home, "botlink-mcp.json");
    writeFileSync(ch.mcp, JSON.stringify({ mcpServers: { botlink: { type: "stdio", command: process.execPath, args: [CLI, "mcp", "--app", "claude-code"], env: { BOTLINK_HOME: ch.env.BOTLINK_HOME!, BOTLINK_SERVER: ch.env.BOTLINK_SERVER! } } } }, null, 2));
    ch.env.BOTLINK_CLAUDE_ARGS = JSON.stringify(["--settings", ch.settings, "--mcp-config", ch.mcp, "--strict-mcp-config", "--setting-sources", "project,local"]);
  }
  if (app === "codex") {
    ch.env.BOTLINK_CODEX_ARGS = JSON.stringify(["--dangerously-bypass-hook-trust", "--skip-git-repo-check"]);
    if (!STUBBED) {
      // --dev: a dedicated CODEX_HOME and the local matrix server (FINDINGS F4 guard)
      const r = spawnSync(process.execPath, [CLI, "setup", "codex", "--scope", "user", "--yes", "--no-watch", "--no-shim", "--dev"], { env: ch.env, encoding: "utf-8" });
      if (r.status !== 0) die(`botlink up --app codex failed: ${r.stdout}${r.stderr}`);
    }
  }
  return ch;
}

function run(ch: Chat, cmd: string, argv: string[], timeoutMs = 10 * 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, argv, { cwd: ch.work, env: ch.env, stdio: ["ignore", "pipe", "pipe"] });
    started.push(p);
    let out = "";
    p.stdout!.on("data", (b) => (out += b));
    p.stderr!.on("data", (b) => (out += b));
    const t = setTimeout(() => p.pid && p.kill("SIGTERM"), timeoutMs);
    p.on("exit", (code) => {
      clearTimeout(t);
      res({ code, out });
    });
  });
}

const claudeBin = () => (STUBBED ? STUB : "claude");
const codexBin = () => (STUBBED ? STUB : "codex");

/** Create the holder session; returns its id. */
async function createSession(ch: Chat): Promise<string> {
  if (ch.app === "claude-code") {
    const sid = c.uuidv7();
    const r = await run(ch, claudeBin(), ["-p", "Say READY and nothing else.", "--session-id", sid, ...JSON.parse(ch.env.BOTLINK_CLAUDE_ARGS!)]);
    if (r.code !== 0) throw new Error(`claude session create failed: ${r.out.slice(0, 500)}`);
    return sid;
  }
  const r = await run(ch, codexBin(), ["exec", "--json", ...JSON.parse(ch.env.BOTLINK_CODEX_ARGS!), "Say READY and nothing else."]);
  const m = r.out.match(/"thread_id"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error(`codex session create failed: ${r.out.slice(0, 500)}`);
  return m[1];
}

async function joinChat(ch: Chat, b: Browser, roomId: string, name: string, session: string | null, turn: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const inv = await b.chatInvite(roomId);
  const env = { ...ch.env, ...(session ? { BOTLINK_SESSION: session } : {}), ...extraEnv };
  const jc = { ...ch, env };
  // --no-setup: never write bot-link into the profile (Claude Code gets it via --settings / --mcp-config)
  const r = await run(jc, process.execPath, [CLI, "join", inv, "--name", name, "--job", `matrix ${ch.label}`, "--app", ch.app, ...(ch.app === "other" ? ["--app-name", "Matrix script"] : []), "--turn", turn, "--no-setup"], 60_000);
  if (r.code !== 0) throw new Error(`join failed: ${r.out}`);
  const rq = join(ch.botlinkHome, "requests");
  const newest = readdirSync(rq).map((f) => join(rq, f)).sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0];
  const id = JSON.parse(readFileSync(newest, "utf-8")).id;
  await b.approve(id);
  const w = await run(jc, process.execPath, [CLI, "join", "--wait", "--app", ch.app, "--max-s", "30"], 60_000);
  if (w.code !== 0) throw new Error(`join --wait failed: ${w.out}`);
  const md = join(ch.botlinkHome, "members");
  const m = readdirSync(md).map((f) => JSON.parse(readFileSync(join(md, f), "utf-8"))).find((x) => x.cwd === ch.work && x.name === name);
  if (!m) throw new Error("member file not found after join");
  if (m.holder_session !== session) throw new Error(`holder ${m.holder_session} != ${session}`);
  if (m.cwd !== ch.work) throw new Error("member folder mismatch");
  ch.member = m.id;
  ch.session = session;
  return m.id as string;
}

// ------------------------------------------------------------------ Cursor: headless runs + store.db transcripts
const cursorChats = new Map<string, string[]>(); // chat label -> cursor chat ids this run created/resumed

/** One headless cursor-agent turn in the chat's folder; returns the chat id and the final text. */
async function cursorTurn(ch: Chat, prompt: string, resume: string | null, extraEnv: NodeJS.ProcessEnv = {}) {
  const argv = ["-p", "--trust", "--approve-mcps", "--output-format", "json", ...(resume ? ["--resume", resume] : []), prompt];
  const r = await run({ ...ch, env: { ...ch.env, ...extraEnv } }, cursorBin, argv, 10 * 60_000);
  const line = r.out.split("\n").reverse().find((l) => l.startsWith("{") && l.includes('"session_id"'));
  if (!line) throw new Error(`cursor-agent run failed (exit ${r.code}): ${r.out.slice(-500)}`);
  const j = JSON.parse(line);
  if (j.is_error) throw new Error(`cursor-agent error: ${String(j.result).slice(0, 300)}`);
  const ids = cursorChats.get(ch.label) || [];
  if (!ids.includes(j.session_id)) ids.push(j.session_id);
  cursorChats.set(ch.label, ids);
  return { id: j.session_id as string, text: String(j.result || ""), code: r.code };
}

/** Model-visible text of this chat's Cursor conversations: every JSON message blob in store.db that is NOT the model's
 *  own output (role assistant). Blobs are content-addressed, so each prompt / tool result is stored once. */
async function cursorTranscriptText(ch: Chat): Promise<string> {
  const { DatabaseSync } = await import("node:sqlite");
  const parts: string[] = [];
  // cursor-agent keeps chats in $XDG_CONFIG_HOME/cursor/chats (chatEnv sets it) or ~/.cursor/chats
  const roots = [join(String(ch.env.XDG_CONFIG_HOME), "cursor", "chats"), join(cursorHome, ".cursor", "chats")].filter((r) => existsSync(r));
  const collect = (v: any) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  for (const root of roots) for (const ws of readdirSync(root)) for (const id of cursorChats.get(ch.label) || []) {
    const db = join(root, ws, id, "store.db");
    if (!existsSync(db)) continue;
    const d = new DatabaseSync(db, { readOnly: true });
    try {
      for (const row of d.prepare("select data from blobs").all() as { data: Uint8Array }[]) {
        let j: any;
        try {
          j = JSON.parse(Buffer.from(row.data).toString("utf-8"));
        } catch {
          continue; // protobuf bookkeeping (and the model's own reasoning/output copies)
        }
        if (!j || typeof j !== "object" || !j.role || j.role === "assistant") continue;
        if (j.role === "system") continue; // Cursor's own system prompt
        // a tool result is stored twice in one record (result + experimental_content): count it once
        if (j.role === "tool" && Array.isArray(j.content)) for (const x of j.content) if (x && typeof x === "object") delete x.experimental_content;
        collect(j.content);
      }
    } finally {
      d.close();
    }
  }
  return parts.join("\n");
}

/** Read the sender's inbox the way a hook would (non-cursor, holder-less member in its folder) and return its text. */
async function readSenderInbox(sender: Chat): Promise<string> {
  // the scripted sender reads like any chat of its app: the CLI inbox as itself (a Codex hook would only ever show a
  // Codex chat's members: the sender is its own app)
  const r = await run(sender, process.execPath, [CLI, "inbox", "--as", "sender"], 60_000);
  return r.out;
}

// ------------------------------------------------------------------ transcripts: model-visible text only
function transcriptText(ch: Chat): string {
  const files: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".jsonl") && !ch.session) {
        const st = statSync(p);
        if (st.mtimeMs >= RUN_STARTED_MS && st.size < 20 * 1024 * 1024 && p.includes(ch.work.replace(/[^A-Za-z0-9]/g, "-"))) files.push(p);
      }
      else if (f.name.endsWith(".jsonl") && ch.session) {
        // Real profiles hold huge transcripts: match by filename, content-scan only small files touched by this run.
        const st = statSync(p);
        // only this chat's own project folder: other transcripts (an operator's session that printed a token) never count
        if (!STUBBED && ch.app === "claude-code" && !p.includes(ch.work.replace(/[^A-Za-z0-9]/g, "-"))) continue;
        if (f.name.includes(ch.session)) files.push(p);
        else if (st.mtimeMs >= RUN_STARTED_MS && st.size < 20 * 1024 * 1024 && readFileSync(p, "utf-8").includes(ch.session)) files.push(p);
      }
    }
  };
  if (STUBBED) walk(join(ch.home, "transcripts"));
  else if (ch.app === "claude-code") walk(join(claudeConfig, "projects"));
  else walk(join(codexHome, "sessions"));
  const parts: string[] = [];
  const collect = (v: any) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  for (const f of files) for (const l of readFileSync(f, "utf-8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const rec = JSON.parse(l);
      // Claude Code logs ONE delivery up to 3 times (hook_success echo, hook_additional_context, api-request-blob).
      // Count only what the model was given once: injected hook context and tool results (the inbox tool).
      if (!STUBBED && ch.app === "claude-code") {
        const at = rec?.attachment?.type;
        const isCtx = rec?.type === "attachment" && at === "hook_additional_context";
        const isTool = rec?.type === "user" && JSON.stringify(rec?.message?.content ?? "").includes("tool_result");
        // the Stop waiter's asyncRewake: its stderr reaches the model as a user turn ("Stop hook blocking error from
        // command ...") inside a <task-notification>; the queue-operation and api-request-blob copies are not counted
        const isRewake = rec?.type === "user" && typeof rec?.message?.content === "string" && rec.message.content.includes("Stop hook blocking error");
        if (!isCtx && !isTool && !isRewake) continue;
        delete rec.rendered; // Claude Code also stores a rendered copy of the same context on the record
      }
      // Codex (0.162) logs every finished tool call twice: the response_item (custom_tool_call_output / function_call_output,
      // what the model is given) and an event_msg item_completed copy. Count the model's copy only: once the woken run can
      // call bot-link's tools (FINDINGS F1), an inbox result would otherwise count as a duplicate showing.
      if (!STUBBED && ch.app === "codex" && rec?.type === "event_msg" && rec?.payload?.type === "item_completed") continue;
      collect(rec);
    } catch {
      /* skip */
    }
  }
  return parts.join("\n");
}

interface CellResult {
  app: string;
  cell: string;
  sent: number;
  inContext: number;
  shown: number;
  stuck: number;
  dupUnflagged: number;
  notes: string;
  /** cells that send fewer than N (reply): how many must pass */
  expect?: number;
}

async function score(app: string, cell: string, ch: Chat, sent: { id: string; tok: string }[], notes: string): Promise<CellResult> {
  const t = ch.app === "cursor" ? await cursorTranscriptText(ch) : transcriptText(ch);
  let inContext = 0, dup = 0;
  for (const s of sent) {
    const blocks = t.split("<<<BEGIN BOT-LINK MESSAGE").slice(1).filter((b) => b.includes(s.tok));
    if (blocks.length || t.includes(s.tok)) inContext++;
    // every showing after the first must carry the re-delivered flag (it precedes the block)
    const idx: number[] = [];
    let i = -1;
    while ((i = t.indexOf(`id: ${s.id}`, i + 1)) >= 0) idx.push(i);
    for (const k of idx.slice(1)) if (!t.slice(Math.max(0, k - 900), k).includes("re-delivered")) dup++;
  }
  const states = sent.map((s) => sql(`select state from deliveries where message_id='${s.id}'`));
  // for re-scoring offline: what was sent, the server states, and which transcript the chat used
  writeFileSync(join(base, "logs", `${app}-${cell}-sent.json`), JSON.stringify({ session: ch.session, work: ch.work, sent, states }, null, 2));
  return { app, cell, sent: sent.length, inContext, shown: states.filter((x) => x === "shown" || x === "done").length, stuck: states.filter((x) => x === "stuck").length, dupUnflagged: dup, notes };
}

async function sendN(sender: Chat, to: string, cell: string): Promise<{ id: string; tok: string }[]> {
  const out: { id: string; tok: string }[] = [];
  for (let n = 1; n <= N; n++) {
    const tok = `BLTOK-${cell}-${n}-${randomBytes(3).toString("hex")}`;
    const r = await run(sender, process.execPath, [CLI, "send", "--as", "sender", "--to", to, "--intent", "task", "--json", "--text", `${tok} (matrix message ${n} of ${N}; no action needed, just note the token)`], 15 * 60_000);
    if (r.code !== 0) throw new Error(`send failed: ${r.out}`);
    out.push({ id: JSON.parse(r.out.trim().split("\n").pop()!).id, tok });
    if (n < N) await sleep(GAP_MS);
  }
  return out;
}

async function waitShown(sent: { id: string }[], maxMs: number) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const n = Number(sql(`select count(*) from deliveries where message_id in (${sent.map((s) => `'${s.id}'`).join(",")}) and state in ('shown','done','stuck')`));
    if (n >= sent.length) return;
    await sleep(2000);
  }
}

const watchLog = (ch: Chat) => join(base, "logs", `watch-${ch.label}.log`);
function startWatch(ch: Chat): ChildProcess {
  const fd = openSync(watchLog(ch), "a");
  const p = spawn(process.execPath, [CLI, "watch"], { cwd: ch.work, env: ch.env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  started.push(p);
  return p;
}
/** How many resumes watch started for this chat so far (its own log lines). */
function cursorRunCount(ch: Chat): number {
  return existsSync(watchLog(ch)) ? (readFileSync(watchLog(ch), "utf-8").match(/; resuming cursor chat /g) || []).length : 0;
}
function cursorChatIds(ch: Chat): string[] {
  return cursorChats.get(ch.label) || [];
}
async function stopPid(p: ChildProcess) {
  if (p.exitCode !== null) return;
  await new Promise<void>((r) => {
    p.on("exit", () => r());
    p.kill("SIGTERM");
  });
}

function tmux(args: string[]) {
  return spawnSync("tmux", args, { encoding: "utf-8" });
}

// ------------------------------------------------------------------ cells
async function cell(app: MxApp, name: string, b: Browser, other: Browser): Promise<CellResult> {
  const room = await b.createRoom(`mx${Date.now() % 1e7}`, `matrix ${app} ${name}`);
  const rcpt = newChat(`${app}-${name}-rcpt`, app);
  const sender = newChat(`${app}-${name}-sender`, "other");
  const senderOwner = name === "cross-person" ? other : b;
  if (name === "cross-person") await addPerson(b, other, room.id);
  await joinChat(sender, senderOwner, room.id, "sender", null, "on_turn");
  const notes: string[] = [];
  if (app === "cursor") return await cursorCell(name, b, room.id, rcpt, sender);
  if (name === "session-start") {
    const sid = await createSession(rcpt);
    await joinChat(rcpt, b, room.id, "rcpt", sid, "on_turn");
    const sent = await sendN(sender, "rcpt", `${app}-ss`);
    const ask = "List every BLTOK token you can see in your context, one per line. If the bot-link context says more messages are waiting, call the bot-link inbox tool until it says there are none, then list them too.";
    const r = app === "claude-code"
      ? await run(rcpt, claudeBin(), ["-p", ask, "--resume", sid, ...JSON.parse(rcpt.env.BOTLINK_CLAUDE_ARGS!), "--allowedTools", "mcp__botlink__inbox"])
      : await run(rcpt, codexBin(), ["exec", ...JSON.parse(rcpt.env.BOTLINK_CODEX_ARGS!), "resume", sid, ask]);
    notes.push(`resume run exit ${r.code}`);
    return await score(app, name, rcpt, sent, notes.join("; "));
  }
  if (name === "resume" || name === "restart" || name === "cross-person") {
    const sid = await createSession(rcpt);
    await joinChat(rcpt, b, room.id, "rcpt", sid, "wake");
    let w = startWatch(rcpt);
    let sent: { id: string; tok: string }[];
    if (name === "restart") {
      await sleep(3000);
      await stopPid(w);
      sent = await sendN(sender, "rcpt", `${app}-rs`);
      w = startWatch(rcpt);
    } else sent = await sendN(sender, "rcpt", `${app}-${name === "resume" ? "rm" : "xp"}`);
    await waitShown(sent, 15 * 60_000);
    await stopPid(w);
    const sessions = sql(`select holder_session from members where id='${rcpt.member}'`);
    notes.push(`holder after: ${sessions === sid ? "same session" : `auto-claimed ${sessions}`}`);
    return await score(app, name, rcpt, sent, notes.join("; "));
  }
  if (name === "reply") {
    // FINDINGS F1: a woken (non-interactive) run must be able to CALL bot-link's tools, not just see the messages.
    // The member's human saves a standing rule in an attended run (save_rule: also refused before the F1 fix), then
    // watch wakes the chat for each of K messages and the model must answer each with the reply tool.
    if (STUBBED) return { app, cell: name, sent: 0, inContext: 0, shown: 0, stuck: 0, dupUnflagged: 0, notes: "not run in --stub (needs the model to call a tool)" };
    const K = Number(A["reply-n"] || 3);
    const sid = await createSession(rcpt);
    await joinChat(rcpt, b, room.id, "rcpt", sid, "wake");
    const rule = "replying to teammates' bot-link messages with the reply tool is fine without asking me";
    const intro = `I'm your human. My standing rule for you: ${rule}. Save that standing rule now with the bot-link save_rule tool, quoting my exact words, then say SAVED.`;
    const ir = app === "claude-code"
      ? await run(rcpt, claudeBin(), ["-p", intro, "--resume", sid, ...JSON.parse(rcpt.env.BOTLINK_CLAUDE_ARGS!), "--allowedTools", "mcp__botlink__save_rule"])
      : await run(rcpt, codexBin(), ["exec", ...JSON.parse(rcpt.env.BOTLINK_CODEX_ARGS!), "resume", sid, intro]);
    const rulesDir = join(rcpt.botlinkHome, "rules");
    const saved = existsSync(rulesDir) && readdirSync(rulesDir).some((f) => readFileSync(join(rulesDir, f), "utf-8").includes("reply tool is fine"));
    notes.push(`save_rule in an attended run: ${saved ? "saved" : `NOT saved (exit ${ir.code}: ${ir.out.replace(/\s+/g, " ").slice(-160)})`}`);
    const w = startWatch(rcpt);
    const sent: { id: string; tok: string }[] = [];
    for (let n = 1; n <= K; n++) {
      const tok = `BLANS-${n}-${randomBytes(3).toString("hex")}`;
      const r = await run(sender, process.execPath, [CLI, "send", "--as", "sender", "--to", "rcpt", "--intent", "question", "--json", "--text", `Quick check ${n} of ${K}: please answer this message with the bot-link reply tool, text exactly: ${tok}`], 5 * 60_000);
      if (r.code !== 0) throw new Error(`send failed: ${r.out}`);
      sent.push({ id: JSON.parse(r.out.trim().split("\n").pop()!).id, tok });
      // one wake per message: wait until the answer is back before the next one
      const end = Date.now() + Number(A["reply-wait-s"] || 480) * 1000;
      while (Date.now() < end && Number(sql(`select count(*) from messages g join members f on f.id=g.from_member where f.id='${rcpt.member}' and g.in_reply_to='${sent[sent.length - 1].id}'`)) === 0) await sleep(3000);
    }
    await sleep(5000);
    await stopPid(w);
    const inbox = await readSenderInbox(sender);
    const answered = sent.filter((s) => inbox.includes(s.tok) && inbox.includes(`reply to: ${s.id}`)).length;
    const shown = sent.map((s) => sql(`select state from deliveries where message_id='${s.id}'`)).filter((x) => x === "shown" || x === "done").length;
    const stuck = sent.map((s) => sql(`select state from deliveries where message_id='${s.id}'`)).filter((x) => x === "stuck").length;
    const t = transcriptText(rcpt);
    const refused = (t.match(/requires approval|approval policy is never/g) || []).length;
    const resumes = existsSync(watchLog(rcpt)) ? (readFileSync(watchLog(rcpt), "utf-8").match(/; resuming /g) || []).length : 0;
    notes.push(`watch resumes ${resumes}; replies received by sender (reply tool, in_reply_to + token): ${answered}/${K}; tool calls refused for approval: ${refused}`);
    writeFileSync(join(base, "logs", `${app}-reply-sent.json`), JSON.stringify({ session: sid, sent, inbox }, null, 2));
    const ok = saved && refused === 0;
    return { app, cell: name, sent: K, inContext: ok ? answered : 0, shown, stuck, dupUnflagged: 0, notes: notes.join("; "), expect: K };
  }
  if (name === "idle") {
    if (STUBBED) return { app, cell: name, sent: 0, inContext: 0, shown: 0, stuck: 0, dupUnflagged: 0, notes: "not run in --stub (needs an interactive CLI in tmux)" };
    const sid = app === "claude-code" ? c.uuidv7() : await createSession(rcpt);
    await joinChat(rcpt, b, room.id, "rcpt", sid, "wake");
    // a dedicated tmux session per cell, killed by its exact name at the end (never by pattern)
    const tm = `botlink-idle-${app}-${randomBytes(3).toString("hex")}`;
    const envs = Object.entries(rcpt.env).map(([k, v]) => `${k}=${JSON.stringify(String(v))}`).join(" ");
    const cmd = app === "claude-code"
      ? `env -i ${envs} claude --session-id ${sid} --settings ${JSON.stringify(rcpt.settings)} --mcp-config ${JSON.stringify(rcpt.mcp)} --strict-mcp-config --allowedTools mcp__botlink__inbox,mcp__botlink__reply`
      : `env -i ${envs} codex --dangerously-bypass-hook-trust resume ${sid}`;
    const pane = () => tmux(["capture-pane", "-p", "-t", tm]).stdout || "";
    const paneLog = join(base, "logs", `${tm}.pane.txt`);
    const snap = (label: string) => writeFileSync(paneLog, `${existsSync(paneLog) ? readFileSync(paneLog, "utf-8") : ""}\n===== ${new Date().toISOString()} ${label}\n${pane()}`);
    const type = async (text: string) => {
      tmux(["send-keys", "-t", tm, "-l", text]);
      await sleep(1000);
      tmux(["send-keys", "-t", tm, "Enter"]);
    };
    if (tmux(["new-session", "-d", "-s", tm, "-c", rcpt.work, "-x", "200", "-y", "50", cmd]).status !== 0) throw new Error("tmux failed");
    liveTmux = tm;
    log(`  tmux ${tm} (attach: tmux attach -t ${tm})`);
    // watch runs as it would on a real machine: it must leave the live session alone (its own hooks handle it)
    const w = startWatch(rcpt);
    try {
      await sleep(10_000);
      snap("started");
      await type("Say READY and nothing else.");
      await sleep(30_000);
      snap("after the first (only) human prompt");
      const sent = await sendN(sender, "rcpt", `${app}-idle`);
      const shownNow = () => Number(sql(`select count(*) from deliveries where message_id in (${sent.map((s) => `'${s.id}'`).join(",")}) and state in ('shown','done')`));
      if (app === "codex") {
        // SPEC §7.2: Codex has no idle waiter (its Stop hook runs only at the end of a turn). Measure, then type once.
        await sleep(90_000);
        const before = shownNow();
        snap(`codex idle 90 s after the sends: ${before}/${sent.length} shown`);
        notes.push(`idle with no input for 90 s after the 20 sends: ${before}/${sent.length} shown`);
        await type("Anything new from bot-link? Read all of it.");
      }
      await waitShown(sent, app === "codex" ? 10 * 60_000 : 15 * 60_000);
      await sleep(15_000); // let the last rewake turn finish writing the transcript
      snap("end");
      if (app === "codex") notes.push(`after ONE typed prompt: ${shownNow()}/${sent.length} shown`);
      else notes.push("no human input after the first prompt (Stop hook asyncRewake waiter)");
      const resumes = existsSync(watchLog(rcpt)) ? (readFileSync(watchLog(rcpt), "utf-8").match(/; resuming /g) || []).length : 0;
      notes.push(`watch running, resumes it started: ${resumes}`);
      return await score(app, name, rcpt, sent, notes.join("; "));
    } finally {
      await stopPid(w);
      tmux(["kill-session", "-t", tm]);
      liveTmux = null;
    }
  }
  throw new Error(`unknown cell ${name}`);
}

const ASK = "List every BLTOK token you can see in your context, one per line. If the bot-link context says more messages are waiting, call the bot-link inbox tool until it says there are none, then list them too.";

async function cursorCell(name: string, b: Browser, roomId: string, rcpt: Chat, sender: Chat): Promise<CellResult> {
  const notes: string[] = [];
  // Cursor members hold no session: they act from the folder they joined in (core.heldBy)
  if (name === "session-start") {
    await joinChat(rcpt, b, roomId, "rcpt", null, "on_turn");
    const sent = await sendN(sender, "rcpt", "cursor-ss");
    const t = await cursorTurn(rcpt, ASK, null); // a NEW chat: its sessionStart hook shows what is waiting
    notes.push(`new chat ${t.id.slice(0, 8)} exit ${t.code}`);
    // and back the other way: the model sends through the bot-link MCP tools
    const rtok = `BLREPLY-${randomBytes(3).toString("hex")}`;
    await cursorTurn(rcpt, `Use the bot-link send tool to send the member "sender" the text "${rtok}" (intent fyi). Then say SENT.`, t.id);
    const inbox = await readSenderInbox(sender);
    notes.push(`MCP send back: ${inbox.includes(rtok) ? "received by sender" : "NOT received"}`);
    const r = await score("cursor", name, rcpt, sent, notes.join("; "));
    if (!inbox.includes(rtok)) r.notes += " (FAIL: send back)";
    return r;
  }
  if (name === "resume" || name === "restart") {
    // the chat the human works in (its first run approves the workspace + MCP servers, as the human would once)
    const first = await cursorTurn(rcpt, "Say READY and nothing else.", null);
    // join from that chat's shell: cursor-agent gives its commands CURSOR_CONVERSATION_ID (probed), so watch knows the chat
    await joinChat(rcpt, b, roomId, "rcpt", null, "wake", { CURSOR_CONVERSATION_ID: first.id });
    const m = JSON.parse(readFileSync(join(rcpt.botlinkHome, "members", `${rcpt.member}.json`), "utf-8"));
    if (m.wake_chat !== first.id) throw new Error(`join didn't record the Cursor chat (wake_chat ${m.wake_chat})`);
    const before = cursorRunCount(rcpt);
    let w = startWatch(rcpt);
    let sent: { id: string; tok: string }[];
    if (name === "restart") {
      await sleep(3000);
      await stopPid(w); // killed by its PID
      sent = await sendN(sender, "rcpt", "cursor-rs");
      w = startWatch(rcpt);
    } else sent = await sendN(sender, "rcpt", "cursor-rm");
    await waitShown(sent, 15 * 60_000);
    await stopPid(w);
    const ids = cursorChatIds(rcpt);
    notes.push(`watch resumed chat ${first.id.slice(0, 8)} ${cursorRunCount(rcpt) - before}x (cursor-agent -p --resume; no sessionStart on resume: delivery is the inbox tool); chats seen: ${ids.length}`);
    return await score("cursor", name, rcpt, sent, notes.join("; "));
  }
  return { app: "cursor", cell: name, sent: 0, inContext: 0, shown: 0, stuck: 0, dupUnflagged: 0, notes: "not a Cursor cell" };
}

async function addPerson(owner: Browser, friend: Browser, roomId: string) {
  const pid = c.uuidv7();
  const pi = await owner.call("POST", `/app/v1/rooms/${roomId}/person-invites`, { id: pid });
  const code = pi.url.split("/p/")[1];
  const req = await friend.call("POST", `/app/v1/person-invites/${code}/accept`, { device_id: friend.device.id });
  const entries = await owner.roster(roomId);
  const { makeEntry, entryHash } = await import("../../src/roster.js");
  const head = entries[entries.length - 1];
  const e = makeEntry({ room: roomId, op: "person_add", account: friend.account.id, name: friend.account.display_name, device: friend.device.pk }, head.seq + 1, entryHash(head), owner.device.pk, owner.device.seed);
  await owner.call("POST", `/app/v1/person-requests/${req.id}/approve`, { human_check: await owner.humanCheck("approve_person", req.id), roster_entry: e });
}

// ------------------------------------------------------------------ main
const results: CellResult[] = [];
let cursorInstalled = false;
const srv = new RealServer(PORT);
let liveTmux: string | null = null;
// a stopped run (SIGTERM / Ctrl-C) still cleans up what it started: its PIDs, its tmux session, the server
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => {
  for (const p of started) if (p.exitCode === null && p.pid) p.kill("SIGTERM");
  if (liveTmux) tmux(["kill-session", "-t", liveTmux]);
  void srv.stop().finally(() => process.exit(130));
});
try {
  await c.ready();
  if (!existsSync(CLI)) die("build first: npm run build");
  mkdirSync(join(base, "logs"), { recursive: true });
  await srv.start(join(base, "logs"));
  const adam = await new Browser(srv.url).login("Adam");
  const priya = await new Browser(srv.url).login("Priya");
  if (APPS.includes("cursor")) {
    // bot-link's own entries into the test HOME's ~/.cursor (mcp.json + hooks.json), ledger + backups in BOTLINK_HOME
    const env = chatEnv(cursorHome, { BOTLINK_HOME: CURSOR_BOTLINK_HOME });
    const r = spawnSync(process.execPath, [CLI, "setup", "cursor", "--scope", "user", "--yes", "--no-watch", "--no-shim", "--dev"], { env, encoding: "utf-8" });
    if (r.status !== 0) die(`botlink up --app cursor failed: ${r.stdout}${r.stderr}`);
    cursorInstalled = true;
    log(`cursor: ${r.stdout.trim().split("\n").join(" | ").slice(0, 400)}`);
  }
  for (const app of APPS) {
    for (const name of CELLS) {
      if (name === "cross-person" && app !== "claude-code") continue;
      if (app === "cursor" && name !== "session-start" && name !== "resume" && name !== "restart") continue;
      log(`cell ${app} / ${name} ...`);
      try {
        const r = await cell(app, name, adam, priya);
        results.push(r);
        log(`  ${r.inContext}/${r.sent} in context, ${r.shown} shown, ${r.stuck} stuck, ${r.dupUnflagged} unflagged duplicates`);
      } catch (e) {
        results.push({ app, cell: name, sent: 0, inContext: 0, shown: 0, stuck: 0, dupUnflagged: 0, notes: `ERROR: ${(e as Error).message.slice(0, 300)}` });
        log(`  ERROR ${(e as Error).message}`);
      }
    }
  }
} finally {
  for (const p of started) if (p.exitCode === null && p.pid) p.kill("SIGTERM");
  await srv.stop();
  if (cursorInstalled) {
    const r = spawnSync(process.execPath, [CLI, "uninstall", "cursor"], { env: chatEnv(cursorHome, { BOTLINK_HOME: CURSOR_BOTLINK_HOME }), encoding: "utf-8" });
    log(`cursor uninstall exit ${r.status}: ${(r.stdout + r.stderr).trim().split("\n").join(" | ").slice(0, 300)}`);
  }
}
const pass = (r: CellResult) => { const k = r.expect ?? N; return r.sent === k && r.inContext === k && r.shown === k && r.stuck === 0 && r.dupUnflagged === 0; };
const table = [
  `| App | Cell | Sent | Token in model context | Server shown | Stuck | Unflagged duplicates | Pass | Notes |`,
  `|---|---|---|---|---|---|---|---|---|`,
  ...results.map((r) => `| ${r.app} | ${r.cell} | ${r.sent} | ${r.inContext}/${r.sent} | ${r.shown}/${r.sent} | ${r.stuck} | ${r.dupUnflagged} | ${pass(r) ? "PASS" : "FAIL"} | ${r.notes.replace(/\|/g, "/")} |`),
].join("\n");
const head = `## Run ${new Date().toISOString()} · ${STUBBED ? "STUB harness (no model: plumbing check only, NOT the real matrix)" : "real CLIs"} · N=${N}, gap ${GAP_MS / 1000}s\n\n`;
const prev = existsSync(OUT) ? readFileSync(OUT, "utf-8") : "# Real-CLI matrix results (PLAN §5.3)\n";
writeFileSync(OUT, `${prev.replace(/\n*$/, "")}\n\n${head}${table}\n`);
log(`results -> ${OUT}`);
process.exit(results.every(pass) ? 0 : 1);
void homedir;
