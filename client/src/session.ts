/**
 * Which chat is calling? (SPEC §6.7a: a chat's identity is its app SESSION, never its folder)
 *   1. explicit: `--session <id>` (CLI) / `session` (MCP tool argument) / BOTLINK_SESSION (a listener's command)
 *   2. hook stdin `session_id` (the hooks pass it in)
 *   3. walk parent PIDs to a harness PID that a SessionStart hook linked in ~/.botlink/sessions/<pid>-<tag>.json
 *      (follows /clear; Claude Code's MCP server keeps the id it was spawned with)
 *   4. the app's own env: CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, CODEX_SESSION_ID, OPENCODE_SESSION_ID
 * Kept from botlink-mcp session.ts: the pid + start-time tag (guards pid reuse) and "link the harness only when
 * our parent is a shell".
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import * as st from "./state.js";
import { SESSION_RE } from "./reqsign.js";

function ps(args: string[]): string {
  try {
    return execFileSync("ps", args, { stdio: ["ignore", "pipe", "ignore"] }).toString("utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Linux: process facts from /proc, not a `ps` process each. One listener start spawned about 22 `ps` processes
 * (44 ms each on a quiet box, several hundred under load), so a detached listener on a busy computer took longer to
 * start than `listen --detach` waited (gate, 16 Nov 2026). Elsewhere (macOS): `ps`.
 */
const PROC = (() => {
  try {
    return existsSync("/proc/self/stat");
  } catch {
    return false;
  }
})();
/** /proc/<pid>/stat fields from field 3 (state) on: the command name may hold spaces and parentheses. */
function procStat(pid: number): string[] | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

export function parentOf(pid: number): number {
  if (PROC) return Number(procStat(pid)?.[1]) || 0;
  return Number(ps(["-o", "ppid=", "-p", String(pid)])) || 0;
}

/** A pid's start time, hashed: guards a link against pid reuse. */
export function startTag(pid: number): string {
  const s = ps(["-o", "lstart=", "-p", String(pid)]);
  return s ? createHash("sha256").update(s).digest("hex").slice(0, 12) : "";
}

export function commOf(pid: number): string {
  if (PROC) {
    try {
      return readFileSync(`/proc/${pid}/comm`, "utf-8").trim();
    } catch {
      return "";
    }
  }
  return ps(["-o", "comm=", "-p", String(pid)]).split("/").pop() || "";
}

/** A pid's command line as `ps` shows it ("" when it can't tell). */
export function argsOf(pid: number): string {
  if (PROC) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").filter(Boolean).join(" ");
    } catch {
      return "";
    }
  }
  return ps(["-o", "args=", "-p", String(pid)]);
}

function isShell(pid: number): boolean {
  return /^-?(sh|bash|zsh|dash|ksh|fish|ash|cmd(\.exe)?|powershell|pwsh)$/.test(commOf(pid));
}

/** The harness process a hook runs under: our parent, or the shell's parent when our parent is a shell. */
export function harnessPid(): number {
  const p1 = process.ppid;
  return isShell(p1) ? parentOf(p1) || p1 : p1;
}

export interface SessionLink {
  app: string;
  session_id: string;
  /** the folder the chat runs in, as the app's hook said (Cursor: its workspace root, not the MCP server's cwd) */
  cwd: string;
  pid: number;
  ts: number;
}

/** An explicit session for this process (CLI --session). */
let EXPLICIT: string | null = null;
export function setExplicitSession(id: string | null) {
  if (id && !SESSION_RE.test(id)) throw new Error("That --session id doesn't look right (letters, digits, - _ . : only).");
  EXPLICIT = id || null;
}

/** SessionStart hook: link the harness pid to this session (overwrites: /clear and resume start new sessions). */
export function writeSessionLink(app: string, sessionId: string, cwd: string): number {
  const pid = harnessPid();
  if (pid > 1) {
    const tag = startTag(pid);
    if (tag) st.writeJson(st.p("sessions", `${pid}-${tag}.json`), { app, session_id: sessionId, cwd, pid, ts: Date.now() } satisfies SessionLink);
  }
  pruneLinks();
  return pid;
}

function pruneLinks() {
  try {
    const d = st.p("sessions");
    for (const f of readdirSync(d)) {
      const pid = Number(f.split("-")[0]);
      if (pid && !st.pidAlive(pid) && Date.now() - statSync(join(d, f)).mtimeMs > 60_000) rmSync(join(d, f), { force: true });
    }
  } catch {
    /* best effort */
  }
}

/** Walk up to 8 ancestors looking for a linked harness pid. */
export function linkedSession(): SessionLink | null {
  // only an ancestor that has a link file is asked its start time (a `ps` each): most have none
  let linked: Set<string>;
  try {
    linked = new Set(readdirSync(st.p("sessions")).map((f) => f.split("-")[0]));
  } catch {
    return null;
  }
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const tag = linked.has(String(pid)) ? startTag(pid) : "";
    if (tag) {
      const r = st.readJson<SessionLink | null>(st.p("sessions", `${pid}-${tag}.json`), null);
      if (r && typeof r.session_id === "string" && SESSION_RE.test(r.session_id)) return r;
    }
    pid = parentOf(pid);
  }
  return null;
}

/** The app's own session env (what it gives its shell commands / MCP servers). */
const APP_ENV_KEYS = ["T3CODE_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "OPENCODE_SESSION_ID", "ANTIGRAVITY_CONVERSATION_ID"];

function envSession(keys: string[]): string | null {
  for (const k of keys) {
    const v = (process.env[k] || "").trim();
    if (v && SESSION_RE.test(v)) return v;
  }
  return null;
}
export function sessionFromEnv(): string | null {
  return envSession(["BOTLINK_SESSION", ...APP_ENV_KEYS]);
}

/**
 * THE session id that is the calling chat, for every command: join, join --wait, create-room, claim, status, roster,
 * send, inbox, wait, … (founder bug 21 Nov 2026: join dropped an OpenCode chat's --session while every later command
 * used it, so the chat's request and member were found under one identity and its later calls looked under another,
 * where they found its member of another room and nothing for this one). One answer per app:
 * - OpenCode: none. It is found by app and folder. Its tools get no session id and a model passes --session on some
 *   calls and not others (docs/agents.md asks for it, to wake the chat), so a member held by a session would lock out
 *   every call without it (why e304f5e left the session out of its join; now no command uses it). Its --session still
 *   names the session to wake (`listen --via opencode`): a wake target, not this chat's identity.
 * - An app bot-link doesn't detect: the session it is given (--session, BOTLINK_SESSION: a person's terminal, a
 *   listener, a script), for join as for every other command; none given, it is found by its folder.
 * - Cursor: the id names the Cursor chat (H2). It never holds a member (Cursor's MCP server has no chat id); join
 *   records it as the request's Cursor chat (cursorChatOf), the same id the other commands match members with.
 * - Every other app: its session id (explicit, hook, the app's env).
 * cli.ts and mcp.ts never read a session any other way (client/test/rejoinpending.test.ts checks it).
 */
export function chatSession(app: string, given: string | null = currentSession().id): string | null {
  return app === "opencode" ? null : given;
}
/** What a join, create-room or move records as its session: chatSession, except a Cursor chat's id (cursorChatOf). */
export function holderSession(app: string, given: string | null = currentSession().id): string | null {
  return app === "cursor" ? null : chatSession(app, given);
}
/** The Cursor / Grok Bot chat a request is made from: the id the chat passed, else its shell's CURSOR_CONVERSATION_ID. */
export function cursorChatOf(app: string, given: string | null = currentSession().id): string | null {
  return app === "cursor" || app === "grok-bot" ? given || cursorChatFromEnv() : null;
}

/** Local process identity of the calling harness (for folder-matched apps with no chat session id). */
export function originProcess(): { pid: number; tag: string } | null {
  const ocPid = Number((process.env.OPENCODE_PID || "").trim()) || 0;
  const pid = ocPid > 1 ? ocPid : harnessPid();
  if (pid <= 1) return null;
  const tag = startTag(pid);
  return tag ? { pid, tag } : null;
}

/** True when `origin` is this process or an ancestor of this process (same live harness process). */
export function isAncestorProcess(origin: { pid: number; tag: string } | null | undefined): boolean {
  if (!origin || origin.pid <= 1 || !origin.tag) return false;
  let pid = process.pid;
  for (let i = 0; i < 13 && pid > 1; i++) {
    if (pid === origin.pid) return startTag(pid) === origin.tag;
    pid = parentOf(pid);
  }
  return false;
}

/** True when `origin` is a STILL-RUNNING harness process that is NOT an ancestor of this process (another open chat). */
export function isLiveOtherProcess(origin: { pid: number; tag: string } | null | undefined): boolean {
  if (!origin || origin.pid <= 1 || !origin.tag) return false;
  if (!st.pidAlive(origin.pid)) return false;
  if (startTag(origin.pid) !== origin.tag) return false;
  return !isAncestorProcess(origin);
}

export type SessionSource = "explicit" | "env:BOTLINK_SESSION" | "hook" | "app-link" | "app-env" | "none";

/** The calling chat's session id, and where it came from. explicit: an MCP tool's `session` argument. */
export function currentSession(hookInput?: any, explicit?: string | null): { id: string | null; app: string | null; source: SessionSource; cwd: string | null } {
  const x = (explicit || "").trim() || EXPLICIT;
  if (x && SESSION_RE.test(x)) return { id: x, app: null, source: "explicit", cwd: null };
  const b = envSession(["BOTLINK_SESSION"]);
  if (b) return { id: b, app: null, source: "env:BOTLINK_SESSION", cwd: null };
  // a T3 Code thread is the chat, whichever provider runs under it (a provider switch keeps the thread and changes
  // the provider's own session id): the thread id wins over the provider's hook / env ids
  const t3 = t3ThreadFromEnv();
  if (t3) return { id: t3, app: "t3", source: "app-env", cwd: null };
  const h = hookInput && typeof hookInput.session_id === "string" ? hookInput.session_id : null;
  if (h && SESSION_RE.test(h)) return { id: h, app: null, source: "hook", cwd: null };
  const l = linkedSession();
  // a Cursor link names the newest chat of a window that may hold several: its folder counts, not its id
  if (l && l.app !== "cursor") return { id: l.session_id, app: l.app, source: "app-link", cwd: l.cwd || null };
  const e = envSession(APP_ENV_KEYS);
  if (e) return { id: e, app: null, source: "app-env", cwd: l?.cwd || null };
  return { id: null, app: l?.app ?? null, source: "none", cwd: l?.cwd || null };
}

/** The folder the calling chat runs in, as its app said (a SessionStart hook's cwd / Cursor workspace root), if known. */
export function chatFolder(): string | null {
  return linkedSession()?.cwd || appProcessFolder();
}

/** Claude Code runs a chat's shell commands wherever the model cd's to (often its own scratchpad: real-world run
 *  2026-11-07, the join card said "/tmp/…/scratchpad"); the app's own process sits in the chat's project folder. It
 *  tells its commands its pid (CLAUDE_PID). Linux only (/proc); elsewhere the command's folder is used as before. */
function appProcessFolder(): string | null {
  const pid = (process.env.CLAUDE_PID || "").trim();
  if (!/^\d+$/.test(pid)) return null;
  // only when that Claude Code is this command's own ancestor (an env inherited by another app, e.g. Codex started
  // from a Claude Code terminal, names a different chat)
  let up = process.ppid, hops = 0;
  while (up > 1 && String(up) !== pid && hops++ < 12) up = parentOf(up);
  if (String(up) !== pid) return null;
  try {
    const d = readlinkSync(`/proc/${pid}/cwd`);
    return d && d.startsWith("/") ? d : null;
  } catch {
    return null;
  }
}

/** Grok Bot's Linux runtime carries Cursor's marks (`CURSOR_AGENT`, `CURSOR_CONVERSATION_ID`) alongside its own
 *  `GROK_BOT_*` / `SAND_SUPERVISOR_ENABLED` + `SAND_BOX_*` env vars (verified on a live Grok Bot VM, 23 Nov 2026). */
export function isGrokBotEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const has = (k: string) => !!(env[k] || "").trim();
  const keys = Object.keys(env);
  if (keys.some((k) => k.startsWith("GROK_BOT_") && has(k))) return true;
  return (has("SAND_SUPERVISOR_ENABLED") || has("SAND_MANIFEST_V2")) && keys.some((k) => k.startsWith("SAND_BOX_") && has(k));
}

/** Grok Bot's shared Linux boxes carry hostnames of the form `grok-bot-vm-<digits>`. */
export function isGrokBotHost(host: string = hostname()): boolean {
  return /^grok-bot-vm-/i.test((host || "").trim());
}

/**
 * The apps whose chat may run this command, from the env they give their shell commands and MCP servers (strongest
 * first): Grok Bot (GROK_BOT_* / SAND_SUPERVISOR_ENABLED+SAND_BOX_* — checked before Cursor because Grok Bot's VM
 * also sets CURSOR_AGENT), Cursor's agent (CURSOR_CONVERSATION_ID / CURSOR_AGENT), OpenCode (OPENCODE=1 + OPENCODE_PID,
 * set by the opencode process for everything it starts: probed on opencode 1.19.5), Claude Code (CLAUDECODE /
 * CLAUDE_CODE_ENTRYPOINT / CLAUDE_CODE_SESSION_ID), Codex (CODEX_THREAD_ID / CODEX_SESSION_ID / CODEX_SANDBOX*),
 * Antigravity (ANTIGRAVITY_*). CODEX_HOME / CURSOR_CONFIG_DIR / OPENCODE_CONFIG are user settings, not signals.
 */
export function appsFromEnv(env: NodeJS.ProcessEnv = process.env): ("grok-bot" | "claude-code" | "codex" | "cursor" | "opencode" | "antigravity")[] {
  const has = (k: string) => !!(env[k] || "").trim();
  const out: ("grok-bot" | "claude-code" | "codex" | "cursor" | "opencode" | "antigravity")[] = [];
  if (isGrokBotEnv(env)) out.push("grok-bot");
  if (has("CURSOR_CONVERSATION_ID") || has("CURSOR_AGENT")) out.push("cursor");
  // only what Claude Code sets for its own commands (CLAUDE_CODE_USE_BEDROCK / _EFFORT_LEVEL etc. are user settings)
  if (env.CLAUDECODE === "1" || has("CLAUDE_CODE_ENTRYPOINT") || has("CLAUDE_CODE_SESSION_ID")) out.push("claude-code");
  if (Object.keys(env).some((k) => /^CODEX_(THREAD_ID|SESSION_ID|SANDBOX)/.test(k) && has(k))) out.push("codex");
  if (has("ANTIGRAVITY_CONVERSATION_ID") || has("ANTIGRAVITY_AGENT") || has("ANTIGRAVITY_TRAJECTORY_ID") || has("ANTIGRAVITY_APP_DATA_DIR") || has("ANTIGRAVITY_LS_VERSION")) out.push("antigravity");
  if (env.OPENCODE === "1" || /^\d+$/.test((env.OPENCODE_PID || "").trim())) out.push("opencode");
  return out;
}
/** The env's app when the env alone decides: one signal, or several without OpenCode (grok-bot > cursor > claude-code > codex > antigravity). */
export function appFromEnv(env: NodeJS.ProcessEnv = process.env): "grok-bot" | "claude-code" | "codex" | "cursor" | "opencode" | "antigravity" | null {
  const es = appsFromEnv(env);
  return (es.length > 1 && es.includes("opencode") ? es.filter((a) => a !== "opencode")[0] : es[0]) ?? null;
}

/** The app an ancestor process name belongs to (null: not one we know). */
export function appOfComm(comm: string): "claude-code" | "codex" | "cursor" | "opencode" | "antigravity" | null {
  const c = comm.toLowerCase();
  if (c.includes("opencode")) return "opencode";
  if (c === "claude" || c.startsWith("claude")) return "claude-code";
  if (c.startsWith("codex")) return "codex";
  if (c.includes("cursor")) return "cursor";
  if (c === "agy" || c.startsWith("antigravity")) return "antigravity";
  return null;
}

const DETECTED = ["claude-code", "codex", "cursor", "opencode", "t3", "antigravity", "grok-bot", "other"] as const;
/** Which app is running us: BOTLINK_APP, the env/host the app gives its commands, a session link, or the ancestor process names. */
export function detectApp(host: string = hostname()): "claude-code" | "codex" | "cursor" | "opencode" | "t3" | "antigravity" | "grok-bot" | "other" {
  const env = (process.env.BOTLINK_APP || "").trim();
  if ((DETECTED as readonly string[]).includes(env)) return env as any;
  // T3 Code runs Claude Code / Codex / other providers as its threads and gives their commands T3CODE_THREAD_ID
  // (probed on t3 0.1.9: a Claude thread also has CLAUDECODE=1 and CLAUDE_CODE_ENTRYPOINT=t3-code). The chat the
  // human sees is the T3 thread, so T3 wins over the provider under it.
  if (t3ThreadFromEnv()) return "t3";
  // Grok Bot runs shell commands in a VM that also sets CURSOR_AGENT / CURSOR_CONVERSATION_ID, so check Grok Bot's
  // own env/hostname markers before Cursor.
  if (isGrokBotEnv(process.env) || isGrokBotHost(host)) return "grok-bot";
  const es = appsFromEnv();
  if (es.includes("opencode") && es.length > 1) {
    // OpenCode plus another app's env: OpenCode wins when its own process (OPENCODE_PID) is our ancestor and no
    // Claude Code / Codex / Cursor process sits between us and it (else that app runs inside OpenCode, or the
    // OpenCode env is stale): then the other apps' usual precedence decides.
    const opid = Number((process.env.OPENCODE_PID || "").trim()) || 0;
    let pid = process.ppid;
    let inside: string | null = null;
    for (let i = 0; i < 16 && pid > 1; i++) {
      if (pid === opid) {
        inside = "opencode";
        break;
      }
      const a = appOfComm(commOf(pid));
      if (a && a !== "opencode") break;
      pid = parentOf(pid);
    }
    return inside === "opencode" ? "opencode" : es.filter((a) => a !== "opencode")[0];
  }
  if (es.length) return es[0];
  const l = linkedSession();
  if (l && ["claude-code", "codex", "cursor"].includes(l.app)) return l.app as any;
  if (process.env.CURSOR_TRACE_ID) return "cursor"; // Cursor's own terminal (weaker: a Claude Code started in it inherits it)
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const a = appOfComm(commOf(pid));
    if (a) return a;
    pid = parentOf(pid);
  }
  return "other";
}

/** The Cursor chat this process runs in (cursor-agent sets CURSOR_CONVERSATION_ID for its shell commands), or null. */
export function cursorChatFromEnv(): string | null {
  const v = (process.env.CURSOR_CONVERSATION_ID || "").trim();
  return v && SESSION_RE.test(v) ? v : null;
}

export function machineName(): string {
  const m = (process.env.BOTLINK_MACHINE || hostname() || "computer").replace(/[^\x20-\x7e]/g, "").slice(0, 64);
  return m || "computer";
}

/** `~`-relative folder for display (SPEC §6.4). */
export function tildeFolder(dir: string): string {
  const home = process.env.HOME || "";
  const f = home && (dir === home || dir.startsWith(home + "/")) ? "~" + dir.slice(home.length) : dir;
  return f.slice(0, 200);
}

/**
 * Does the calling chat already have bot-link's tools? True when a bot-link MCP server (`<…>/dist/cli.js mcp --app …`)
 * runs as a child of one of our ancestors (the app process that also runs this command). Best effort: false when
 * `ps` can't tell.
 */
export function mcpToolsLoaded(): boolean {
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf-8");
  } catch {
    return false;
  }
  const anc = new Set<number>();
  for (let pid = process.ppid, i = 0; i < 10 && pid > 1; i++, pid = parentOf(pid)) anc.add(pid);
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m && anc.has(Number(m[2])) && /[\\/]dist[\\/]cli\.js mcp --app /.test(m[3])) return true;
  }
  return false;
}

/** T3 Code runs Codex / Claude chats and gives their commands T3CODE_THREAD_ID (its own thread: `t3 thread send`). */
export function t3ThreadFromEnv(): string | null {
  const v = (process.env.T3CODE_THREAD_ID || "").trim();
  return v && SESSION_RE.test(v) ? v : null;
}

/** Antigravity CLI (`agy`) gives its shell commands ANTIGRAVITY_CONVERSATION_ID. */
export function antigravityConvFromEnv(): string | null {
  const v = (process.env.ANTIGRAVITY_CONVERSATION_ID || "").trim();
  return v && SESSION_RE.test(v) ? v : null;
}

/**
 * Is this command running inside a HEADLESS app run (`claude -p`, `codex exec`, `cursor-agent -p`, `agy -p`)? Such a run either
 * waits for its background tasks before it ends or kills them when it ends, so a background `listen --once` hangs the
 * run or dies with it (r3 full eval 2026-11-06: a `claude -p` chat re-armed it every turn and each turn hung 15 min).
 * Returns what was found ("claude -p"), or null (an interactive window, or unknown).
 */
export function headlessRun(): string | null {
  return appRun()?.headless ?? null;
}

/** The app run this command is in: the nearest app ancestor and whether it runs headless (null headless: a window). */
export function appRun(): { app: "claude-code" | "codex" | "cursor" | "opencode" | "antigravity"; headless: string | null } | null {
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    const args = argsOf(pid);
    const app = appOfComm(commOf(pid)) || appOfComm((args.split(/\s+/)[0] || "").split("/").pop() || "");
    if (app === "claude-code" && /(^|\s)(-p|--print)(\s|$)/.test(args)) return { app, headless: "claude -p" };
    if (app === "codex" && /(^|\s)exec(\s|$)/.test(args)) return { app, headless: "codex exec" };
    if (app === "cursor" && /(^|\s)(-p|--print)(\s|$)/.test(args)) return { app, headless: "cursor-agent -p" };
    if (app === "antigravity" && /(^|\s)(-p|--print|--prompt)(\s|$)/.test(args)) return { app, headless: "agy -p" };
    if (app) return { app, headless: null }; // the app process itself, interactive
    pid = parentOf(pid);
  }
  return null;
}
