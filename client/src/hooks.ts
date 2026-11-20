/**
 * Harness hooks (SPEC §7.2):   botlink hook <app> <event>     (stdin: the app's hook JSON)
 *
 * The rule (J7f-3): a message is acked `shown` only after its text was handed to the harness through a channel that
 * reaches the model, in this process, after the write succeeded. Anything else -> `release` (or the 120 s lease lapses).
 *
 *   Claude Code session-start  lease(0) for members this session holds (no auto-claim: a resume keeps its session id; H1), render,
 *                              stdout {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}, exit 0.
 *                              NEVER exit 2 here: SessionStart stderr reaches only the user (the J7f-3 bug).
 *   Claude Code prompt         not a member chat -> nothing stored, nothing emitted, exit 0. Member: capture the prompt
 *                              (standing rules), retire this session's Stop waiter, lease(0), stdout
 *                              additionalContext, exit 0.
 *   Claude Code stop           (asyncRewake) the live-idle waiter: loop lease(50); on messages -> stderr, ack shown after
 *                              the write is flushed, exit 2 (wakes the idle session; stderr becomes model-visible).
 *   Codex session-start/prompt as Claude Code.
 *   Codex stop                 GET /me/inbox/count; > 0 and not yet nudged for this batch -> {"decision":"block",
 *                              "reason": fixed text}; the model calls `inbox`.
 *   Cursor session-start       {"additional_context": …}; Cursor stop: {"followup_message": fixed text} once per batch.
 * Hooks never crash the harness: any internal error -> exit 0, no output, release.
 */
import { maybeSpawnCheck } from "./update.js";
import { readFileSync, writeSync, fsyncSync } from "node:fs";

import * as c from "./crypto.js";
import * as st from "./state.js";
import { cliFallback, heldBy, healNotes, takeBatch, apiFor, signerOf, parseAllow, setPermission, parseSendAnyway, sendAnyway, explain, HOOK_BUDGET, type Batch } from "./core.js";
import { writeSessionLink, harnessPid, commOf } from "./session.js";
import { parseYes, sayYes } from "./asks.js";
import { WAKE_PROMPT, CURSOR_WAKE_PROMPT } from "./watch.js";
import { SESSION_RE } from "./reqsign.js";
import { ApiError, NetworkError } from "./api.js";
import { recordMiss, recordReached } from "./hookmiss.js";
import { isRefusedOnTheWay } from "./memberend.js";

/** A server or network problem (not an answer about this member): the hook ends quietly and records the miss. */
const unwell = (e: unknown) => e instanceof NetworkError || (e instanceof ApiError && (e.status >= 500 || e.status === 429)) || isRefusedOnTheWay(e);
/** After a batch was taken: a miss is recorded, a good contact clears an old one. */
function noteContact(hook: string, b: { failed?: number }) {
  if (b.failed) recordMiss(hook, "no answer, or an error page");
  else recordReached();
}

export type HookApp = "claude-code" | "codex" | "cursor";
export const NUDGE = (n: number) => `You have ${n} new bot-link message${n === 1 ? "" : "s"}. Call the bot-link inbox tool.`;
const WAIT_LIMIT_S = Number(process.env.BOTLINK_WAIT_LIMIT_S || 3500);
/** a long-poll that returns sooner than this with nothing to show counts as "fast" (backoff) */
const FAST_MS = 5000;
/** after this many fast rounds in a row the waiter gives up until the next turn */
const MAX_FAST = 12;

function readInput(): any {
  try {
    const raw = readFileSync(0, "utf-8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Write all bytes to fd synchronously (pipes may be non-blocking: retry EAGAIN). Throws if it can't. */
export function writeAll(fd: number, text: string) {
  const buf = Buffer.from(text, "utf-8");
  let off = 0;
  let spins = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
      spins = 0;
    } catch (e: any) {
      if (e?.code !== "EAGAIN" || ++spins > 2000) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    fsyncSync(fd);
  } catch {
    /* pipes can't fsync; the write itself completed */
  }
}

function sessionOf(app: HookApp, input: any): string | null {
  const keys = app === "cursor" ? ["conversation_id", "session_id"] : ["session_id"];
  for (const k of keys) {
    const v = input?.[k];
    if (typeof v === "string" && SESSION_RE.test(v)) return v;
  }
  return null;
}

function cwdOf(app: HookApp, input: any): string {
  if (app === "cursor" && Array.isArray(input?.workspace_roots) && typeof input.workspace_roots[0] === "string") return input.workspace_roots[0];
  return typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();
}

function membersFor(session: string | null, cwd: string, app: HookApp): st.MemberRec[] {
  const prev = process.cwd();
  try {
    process.chdir(cwd);
  } catch {
    /* keep */
  }
  try {
    // only this app's members: a Claude Code chat never takes a Cursor member's messages in a shared folder
    return heldBy(session, { app, folders: [cwd] });
  } finally {
    try {
      process.chdir(prev);
    } catch {
      /* keep */
    }
  }
}

/** One context block for SessionStart / UserPromptSubmit, in the app's format. */
function contextJson(app: HookApp, event: "SessionStart" | "UserPromptSubmit", text: string): string {
  if (app === "cursor") return JSON.stringify({ additional_context: text }) + "\n";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) + "\n";
}

/** Emit a batch on stdout as model-visible context; ack shown only after the write succeeded. */
async function emit(app: HookApp, event: "SessionStart" | "UserPromptSubmit", b: Batch, extra: string[] = []) {
  const text = [...extra, b.text].filter(Boolean).join("\n\n");
  if (!text) {
    await b.release(); // nothing rendered (e.g. only rejects): still sends the rejects
    return;
  }
  try {
    writeAll(1, contextJson(app, event, text));
  } catch {
    await b.release();
    return;
  }
  await b.commit();
}

// ------------------------------------------------------------------ session-start
async function sessionStart(app: HookApp, input: any) {
  try {
    maybeSpawnCheck(); // SPEC §7.6: a detached, throttled update check (this hook never waits for it)
  } catch {
    /* never block the hook */
  }
  const session = sessionOf(app, input);
  const cwd = cwdOf(app, input);
  if (session) {
    // the app process -> this chat (SPEC §6.7a): its MCP server and its shell commands find their chat (and, for
    // Cursor, the workspace folder: Cursor's MCP server runs elsewhere) by walking up to this pid
    const pid = writeSessionLink(app, session, cwd);
    if (app !== "cursor" && pid > 1 && !process.env.BOTLINK_WAKE_MEMBER) st.setLive({ session, app, pid, cwd, at: Date.now() });
  }
  // H1: a member this chat held moved to another chat (its person approved the move): told once, first
  const lost = st.takeLost(session).map(st.lostText);
  // No auto-claim here (critical fix H1, decision 1A): a resumed chat keeps its session id (verified 2026-11-07:
  // `claude -p --resume <id>` and `codex exec resume <id>` report the same id), so a watch resume IS the holder; a
  // different session id is a different chat and moves in only with its person's approval (claim).
  const members = membersFor(session, cwd, app);
  // H2: a new Cursor chat in a member's folder is NOT that member (it used to become the chat watch resumes): the member
  // stays the chat that joined (its conversation id, recorded at join)
  if (!members.length) {
    // a fork / copy of a member's chat (same app, same folder) may become it with claim; a Cursor chat never is
    // another Cursor chat's member (H2), so it gets no names
    const here = app === "cursor" ? [] : st.liveMembers().filter((m) => m.cwd === cwd && m.app === app);
    if (here.length) {
      const s = here.map((m) => `${m.name} in #${m.room.name}`).join(", ");
      // a new chat, or a fork / copy of a member's chat (it carries that chat's history but not its identity, SPEC §6.7a)
      writeAll(1, contextJson(app, "SessionStart", [...lost, `bot-link: this chat is NOT a bot-link member. This folder has bot-link member ${s}, which belongs to another chat. If this chat is a copy (fork) of that chat, or your human wants it to take over, they can say "use bot-link as ${here[0].name}" (claim; your human approves the move in the browser, then the other chat stops being it). Until then don't act as ${here[0].name}, even if earlier messages in this chat did.`].join("\n")));
    } else if (lost.length) writeAll(1, contextJson(app, "SessionStart", lost.join("\n")));
    return;
  }
  await c.ready();
  // a chat its human opens shows what a failed wake path left stuck (never an unattended resume: r3)
  // a session a person opens: they are here (never a run bot-link started)
  // (not a compaction in the middle of a turn: that says nothing about who started the turn)
  const person = process.env.BOTLINK_UNATTENDED !== "1" && !members.some((m) => st.awayLive(m.id)) && String(input?.source || "") !== "compact";
  if (person) st.setTurn(session, true);
  const b = await takeBatch(members, session, { waitS: 0, budget: HOOK_BUDGET, unstick: process.env.BOTLINK_UNATTENDED !== "1", humanTurn: true, ...(person ? { human: true } : {}) });
  noteContact(`${app} session-start`, b);
  // the server could not be asked: say nothing (never "No new messages", never the failure: stdout here is the
  // model's context); the miss is in the local record and the next hook shows what waited
  if (b.failed && !b.count && !b.text) return;
  if (!b.count && !b.text) {
    // a short "you are X" line so the model knows its bot-link identity
    writeAll(1, contextJson(app, "SessionStart", [...lost, `bot-link: this chat is ${members.map((m) => `${m.name} in #${m.room.name}`).join(", ")}. No new messages.\n${cliFallback(members[0], members.length > 1)}`].join("\n")));
    return;
  }
  await emit(app, "SessionStart", b, lost);
}

// ------------------------------------------------------------------ prompt
async function prompt(app: HookApp, input: any) {
  const session = sessionOf(app, input);
  const cwd = cwdOf(app, input);
  // privacy: resolve membership FIRST. A chat that holds no member: store nothing, emit nothing, exit 0.
  const members = membersFor(session, cwd, app);
  const lost = st.takeLost(session).map(st.lostText); // H1: told once, at its next turn
  if (!members.length) {
    if (app === "claude-code" && session) retireWaiter(session, { onlyIfRecorded: true }); // a waiter left from before it left
    if (lost.length) writeAll(1, contextJson(app, "UserPromptSubmit", lost.join("\n")));
    return;
  }
  const text = typeof input?.prompt === "string" ? input.prompt : "";
  // did a PERSON type this? Not bot-link's own wake prompt, not a line a listener typed into the chat (they all start
  // with "bot-link:"), not the stop hook's "You have N new bot-link messages", never a run bot-link started.
  const typed = !!text.trim() && process.env.BOTLINK_UNATTENDED !== "1" && !members.some((m) => st.awayLive(m.id)) && !text.includes(WAKE_PROMPT) && !text.includes(CURSOR_WAKE_PROMPT) &&
    !/^You have \d+ new bot-link messages?\. Call the bot-link inbox tool\.$/.test(text.trim()) && !/^bot-?link:/i.test(text.trim());
  st.setTurn(session, typed, true);
  // capture the human's words for standing rules (member chats only): never the watch wake prompt, our own nudge, or an unattended run
  if (session && text && process.env.BOTLINK_UNATTENDED !== "1" && !text.includes(WAKE_PROMPT) && !text.includes(CURSOR_WAKE_PROMPT) && !/^You have \d+ new bot-link messages?\. Call the bot-link inbox tool\.$/.test(text.trim()) && !/^bot-?link:/i.test(text.trim())) {
    try {
      st.capturePrompt(session, text, Date.now(), { app, cwd });
    } catch {
      /* best effort */
    }
  }
  if (app === "claude-code" && session) retireWaiter(session);
  await c.ready();
  // "botlink allow <member> <setting> [while away]": the human's own typed words change what a member may get
  // (perms.ts). Applied here, by the hook, so no model call is involved; never in an unattended run or from a nudge.
  const allow = process.env.BOTLINK_UNATTENDED !== "1" && !text.includes(WAKE_PROMPT) && !text.includes(CURSOR_WAKE_PROMPT) ? parseAllow(text) : null;
  const said: string[] = [];
  if (allow) {
    const fails: string[] = [];
    for (const m of members) {
      try {
        said.push(`bot-link: ${await setPermission(m, session, { member: allow.member, level: allow.level, whileAway: allow.whileAway || undefined, how: "words", quote: text.trim() })}`);
      } catch (e) {
        fails.push(`bot-link: ${explain(e)}`);
      }
    }
    if (!said.length && fails.length) said.push(fails[0]);
  }
  // "botlink send anyway <code>": the human's own words send a message bot-link stopped (outscan.ts)
  const anyway = process.env.BOTLINK_UNATTENDED !== "1" && !text.includes(WAKE_PROMPT) && !text.includes(CURSOR_WAKE_PROMPT) ? parseSendAnyway(text) : null;
  if (anyway) {
    const fails: string[] = [];
    let sent = false;
    for (const m of members) {
      try {
        said.push(`bot-link: ${await sendAnyway(m, anyway, session, "words")}`);
        sent = true;
        break;
      } catch (e) {
        fails.push(`bot-link: ${explain(e)}`);
      }
    }
    if (!sent && fails.length) said.push(fails[0]);
  }
  // "botlink yes <code>": the human's own words record their yes to a member's request and tell the room (asks.ts)
  const yes = process.env.BOTLINK_UNATTENDED !== "1" && !text.includes(WAKE_PROMPT) && !text.includes(CURSOR_WAKE_PROMPT) ? parseYes(text) : null;
  if (yes) {
    const fails: string[] = [];
    let done = false;
    for (const m of members) {
      try {
        said.push(`bot-link: ${await sayYes(m, yes, session, "words", { retryForMs: 20_000 })}`);
        done = true;
        break;
      } catch (e) {
        fails.push(`bot-link: ${explain(e)}`);
      }
    }
    if (!done && fails.length) said.push(fails[0]);
  }
  // the human typed in this chat: messages a failed wake path left stuck come back now (r3, listen lab #2); never in
  // an unattended run (a broken wake path must not keep resetting them)
  // (humanTurn: a `wait` that ended a while ago never makes this read an idle wake; a listener's nudge still does)
  const b = await takeBatch(members, session, { waitS: 0, budget: HOOK_BUDGET, unstick: process.env.BOTLINK_UNATTENDED !== "1", humanTurn: true, ...(typed ? { human: true } : {}) });
  noteContact(`${app} prompt`, b);
  // M1: a wake path that died is healed (or the chat is told the exact command) at its next turn, not only at a tool call
  const heal = process.env.BOTLINK_UNATTENDED === "1" ? "" : await healNotes(members).catch(() => "");
  await emit(app, "UserPromptSubmit", b, [...lost, ...said, heal].filter(Boolean));
}

// ------------------------------------------------------------------ Claude Code Stop waiter (asyncRewake)
function waiterFile(session: string) {
  return st.p("waiters", `${st.safeName(session)}.pid`);
}

function isOurWaiter(pid: number): boolean {
  if (!st.pidAlive(pid) || pid === process.pid) return false;
  try {
    return /hook\s+claude-code\s+stop/.test(readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " "));
  } catch {
    // no /proc (macOS): trust the pid file only when the process is a node process
    return /^node/.test(commOf(pid));
  }
}

/** Kill this session's waiter by its recorded PID (never by pattern). */
export function retireWaiter(session: string, o: { onlyIfRecorded?: boolean } = {}) {
  const rec = st.readJson<any>(waiterFile(session), null);
  if (o.onlyIfRecorded && !rec) return; // never create a per-session file for a chat bot-link doesn't know
  const pid = Number(rec?.pid || 0);
  if (pid && isOurWaiter(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  try {
    st.writeJson(waiterFile(session), { pid: 0, at: Date.now() });
  } catch {
    /* best effort */
  }
}

function printMode(): boolean {
  // `claude -p` kills async hooks at teardown: a waiter there would only take leases it can't show
  try {
    const args = readFileSync(`/proc/${harnessPid()}/cmdline`, "utf-8").split("\0");
    return args.includes("-p") || args.includes("--print");
  } catch {
    return false;
  }
}

async function claudeStopWaiter(input: any): Promise<number> {
  const session = sessionOf("claude-code", input);
  if (!session || process.env.BOTLINK_WAKE_MEMBER || process.env.BOTLINK_UNATTENDED === "1" || printMode()) return 0;
  const cwd = cwdOf("claude-code", input);
  if (!membersFor(session, cwd, "claude-code").length) return 0;
  // one waiter per session: retire an older one, record ours
  retireWaiter(session);
  st.writeJson(waiterFile(session), { pid: process.pid, at: Date.now() });
  const ctl = new AbortController();
  let stopping = false;
  const onTerm = () => {
    stopping = true;
    ctl.abort();
  };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onTerm);
  await c.ready();
  const deadline = Date.now() + WAIT_LIMIT_S * 1000;
  const mine = () => Number(st.readJson<any>(waiterFile(session), null)?.pid || 0) === process.pid;
  let fails = 0;
  while (!stopping && Date.now() < deadline && mine()) {
    // H1: the member moved to another chat (its person approved) while this chat sat idle: tell it now
    const lost = st.takeLost(session).map(st.lostText);
    if (lost.length) {
      try {
        writeAll(2, lost.join("\n") + "\n");
      } catch {
        return 0;
      }
      if (mine()) st.writeJson(waiterFile(session), { pid: 0, at: Date.now() });
      return 2;
    }
    const members = membersFor(session, cwd, "claude-code");
    if (!members.length) return 0;
    let b: Batch;
    const t0 = Date.now();
    try {
      // urgentOnly: an FYI (intros, notes) never wakes this idle chat on its own; it rides along with the next batch.
      // woken: what this waiter shows proves the chat reads messages while idle (SPEC §6.9)
      b = await takeBatch(members, session, { waitS: Math.min(50, Math.max(1, Math.floor((deadline - Date.now()) / 1000))), signal: ctl.signal, budget: HOOK_BUDGET, urgentOnly: true, woken: true });
    } catch {
      b = { text: "", count: 0, lost: [], failed: 1, commit: async () => {}, release: async () => {} };
    }
    if (stopping) return 0;
    noteContact("claude-code stop", b);
    if (!b.text) {
      // notices that render nothing (a roster change) are done: ack them, else every later lease returns them at once
      // and refetches the roster (live bug B, 2026-11-06: 1446 leases + 1445 rosters in 10 minutes)
      if (!b.failed) await b.commit().catch(() => {});
      // a server hiccup (502, 429, network) or a long-poll that came back early with nothing to show never becomes a
      // turn and never a tight loop: back off (2 s doubling to 60 s), reset only after a poll that really waited
      if (b.failed || Date.now() - t0 < FAST_MS) {
        fails++;
        if (fails > MAX_FAST) return 0; // something is wrong; the next turn starts a fresh waiter
        await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * 2 ** Math.min(fails - 1, 5)) * (0.5 + Math.random() / 2)));
      } else fails = 0;
      continue;
    }
    fails = 0;
    if (stopping || !mine()) {
      await b.release(); // a turn started meanwhile: the prompt hook will show them
      return 0;
    }
    try {
      writeAll(2, b.text + "\n");
    } catch {
      await b.release();
      return 0;
    }
    await b.commit();
    if (mine()) st.writeJson(waiterFile(session), { pid: 0, at: Date.now() });
    return 2;
  }
  return 0;
}

// ------------------------------------------------------------------ Codex / Cursor stop: a fixed nudge, never content
async function nudgeStop(app: "codex" | "cursor", input: any) {
  const session = sessionOf(app, input);
  const members = membersFor(session, cwdOf(app, input), app);
  if (!members.length) return;
  await c.ready();
  let n = 0;
  for (const m of members) {
    try {
      // short: this hook holds the end of the chat's turn (runHook's deadline is the backstop)
      const r = (await apiFor(m.server).call<any>({ method: "GET", path: "/api/v1/me/inbox/count", signer: signerOf(m), session, timeoutMs: 4000, retryForMs: 3000 })).json;
      // only messages that want an answer block a turn; FYIs (intros, notes) wait for the next turn
      n += Number(r?.urgent ?? r?.queued ?? 0);
      recordReached();
    } catch (e) {
      // unwell server or network: the stop is allowed, nothing is said; the next stop hook (or the inbox) shows it
      if (unwell(e)) recordMiss(`${app} stop`, e instanceof ApiError ? `status ${e.status}` : "no connection");
    }
  }
  const key = st.p("nudges", `${st.safeName(session || "nosession")}.json`);
  if (n <= 0) {
    st.writeJson(key, { n: 0 });
    return;
  }
  if (st.readJson<any>(key, {}).n === n) return; // already nudged for this batch
  st.writeJson(key, { n, at: Date.now() });
  writeAll(1, JSON.stringify(app === "cursor" ? { followup_message: NUDGE(n) } : { decision: "block", reason: NUDGE(n) }) + "\n");
}

// ------------------------------------------------------------------ entry
export async function runHook(app: string, event: string): Promise<number> {
  if (app !== "claude-code" && app !== "codex" && app !== "cursor") return 0;
  const input = readInput();
  // Claude Code's Stop waiter runs in the background (asyncRewake) and only wakes the chat with real messages: it has
  // its own backoff. Every other hook holds the chat (its start, its prompt, the end of its turn) and gets a deadline
  // under the app's own time limit: past it, the hook ends quietly (exit 0, nothing said) and the miss is recorded.
  // exit 0 with no output is "nothing to add, let it stop" for each app: Claude Code (not exit 2 / no decision
  // block), Codex (no {"decision":"block"}), Cursor (no followup_message).
  if (event === "stop" && app === "claude-code") {
    try {
      st.setTurn(sessionOf(app, input), false);
      return await claudeStopWaiter(input);
    } catch (e) {
      st.appendLog("hooks.log", `${app} ${event}: ${(e as Error)?.stack || e}`);
      return 0;
    }
  }
  const work = (async () => {
    if (event === "session-start") await sessionStart(app, input);
    else if (event === "prompt") await prompt(app, input);
    else if (event === "stop") {
      // the turn is over: whatever starts the next one, it is not this prompt's person (perms.ts: the hold)
      st.setTurn(sessionOf(app, input), false);
      await nudgeStop(app as "codex" | "cursor", input);
    }
  })().catch((e) => {
    if (unwell(e)) recordMiss(`${app} ${event}`, e instanceof ApiError ? `status ${e.status}` : "no connection");
    st.appendLog("hooks.log", `${app} ${event}: ${(e as Error)?.stack || e}`);
  });
  const ms = hookDeadlineMs(app, event);
  let timer: NodeJS.Timeout | undefined;
  const late = await Promise.race([work.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), ms)))]);
  clearTimeout(timer);
  if (late) recordMiss(`${app} ${event}`, `no answer within ${Math.round(ms / 1000)} s`);
  return 0;
}

/** How long a hook may take before it gives up quietly (exit 0, nothing said): under the time each app gives it
 *  (the timeouts setup writes, harnesses.ts: Claude Code session-start 30 s, prompt 25 s; Codex 30 s; Cursor 15 s). */
export function hookDeadlineMs(app: string, event: string): number {
  const env = Number(process.env.BOTLINK_HOOK_DEADLINE_MS);
  if (Number.isFinite(env) && env > 0) return env;
  if (app === "cursor") return 8_000;
  if (event === "stop") return 10_000; // Codex: its Stop hook holds the end of the turn
  if (event === "prompt") return 15_000; // the human waits for this one
  return 20_000;
}
