/**
 * Self-built ears: `botlink listen --on-message "<command>"` (SPEC §6.9 "listening").
 *
 * For apps bot-link can't wake (no wake hooks, no `botlink watch`): the chat, with its human's OK, starts a listener
 * that holds the non-leasing `POST /me/wait` long-poll and runs the human-approved command when messages arrive
 * (typically the app's own "resume this chat headless" command; the woken chat then calls the bot-link inbox tool).
 *   - one listener per member on this computer (lock file ~/.botlink/listen/<member>.json, pid + start tag)
 *   - single-flight: never two runs at once; no wait while a run is going (wakes aren't counted twice)
 *   - backoff: >= 10 s between runs; doubling (up to 5 min) while runs fail or leave the messages waiting
 *   - the command is printed at setup (show it to your human) and kept in the lock file (`botlink status` shows it)
 *   - the member's turn is "listening" on the server while the listener runs, and is put back when it stops
 *   - stops when the member leaves or is removed (410 gone / room_gone / unknown_key, or its local record is gone),
 *     on SIGTERM/SIGINT, or with `botlink listen --stop`
 *   - a run is killed (its process group, by the PID we started) after BOTLINK_LISTEN_RUN_TIMEOUT_MS (10 min)
 * The command runs in the member's folder (where it joined, like watch's resumes) with BOTLINK_UNATTENDED=1 (no human is present), BOTLINK_LISTEN_MEMBER=<name>,
 * BOTLINK_LISTEN_SESSION=<the chat holding the member>, BOTLINK_LISTEN_COUNT=<waiting messages>, and BOTLINK_SESSION=<the
 * holder> so the woken run acts as the member even if the app resumes it under a new session id.
 */
import { selfCmd } from "./version.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import * as st from "./state.js";
import { skipFlag } from "./safety.js";
import { apiFor, signerOf, explain, UserError } from "./core.js";
import { ApiError, highLoadDelayMs } from "./api.js";
import { busyNotice } from "./limits.js";
import { endMember, isFinal, noteReached, noteRefused, refusedKind } from "./memberend.js";
import { startTag } from "./session.js";
import { RESTART_FOR_UPDATE, restartPicksNewer } from "./update.js";

export { RESTART_FOR_UPDATE };
/** How often a long-running part looks for a newer installed copy (update.ts restartPicksNewer). */
export const RESTART_CHECK_MS = Number(process.env.BOTLINK_RESTART_CHECK_MS || 60_000);

export const LISTEN_GAP_MS = Number(process.env.BOTLINK_LISTEN_GAP_MS || 10_000);
export const LISTEN_MAX_GAP_MS = Number(process.env.BOTLINK_LISTEN_MAX_GAP_MS || 5 * 60_000);
export const LISTEN_RUN_TIMEOUT_MS = Number(process.env.BOTLINK_LISTEN_RUN_TIMEOUT_MS || 10 * 60_000);

export interface ListenLock {
  member: string;
  name: string;
  room: string;
  pid: number;
  tag: string;
  command: string;
  cwd: string;
  started: number;
  /** the member's turn before the listener set it to "listening" (put back on stop) */
  prev_turn: st.Turn;
  log: string;
}

export const lockPath = (memberId: string) => st.p("listen", `${st.safeName(memberId)}.json`);
export const listenLog = (memberId: string) => st.p("logs", `listen-${st.safeName(memberId)}.log`);

/** The running listener for a member, or null (a stale lock whose process is gone or reused is ignored). */
export function runningListener(memberId: string): ListenLock | null {
  const l = st.readJson<ListenLock | null>(lockPath(memberId), null);
  if (!l || !l.pid || !st.pidAlive(l.pid)) return null;
  if (l.tag && startTag(l.pid) !== l.tag) return null;
  return l;
}

export function allListeners(): ListenLock[] {
  return st.liveMembers().map((m) => runningListener(m.id)).filter((x): x is ListenLock => !!x);
}

/** The wake prompt a built-in wake path sends into the chat (it has the bot-link tools, or the command line). The
 *  session id lets an app whose tools carry none (Codex without bot-link's hooks) say which chat it is. */
export const viaPrompt = (m: st.MemberRec) =>
  `bot-link: new messages for ${m.name}. Call the bot-link inbox tool now${m.holder_session ? ` (if it can't tell which chat this is, pass session: ${m.holder_session})` : ""} (no bot-link tools in this chat? run: ${selfCmd()} inbox --as ${m.name}), then handle them under the bot-link rules.`;

/** The short line a tmux nudge types into the chat (one line: the TUI submits it with a separate Enter). */
export const nudgeLine = (m: st.MemberRec) =>
  `bot-link: new messages for ${m.name}. Call the bot-link inbox tool${m.holder_session ? ` (session: ${m.holder_session})` : ""} and handle them under the bot-link rules.`;

/** This CLI, exactly as it runs now (a built-in nudger calls back into it). */
const selfExact = () => `${shq(process.execPath)} ${shq(process.argv[1] || "")}`;

/** Codex's own way into an OPEN thread (verified, listen lab 2026-11-06: 4/4 wakes of an open Codex TUI; `codex exec
 *  resume` on an open thread is refused with "already has an active writer"). */
export function codexQueueArgs(thread: string, prompt: string): { cmd: string; args: string[] } {
  return { cmd: process.env.BOTLINK_CODEX_BIN || "codex", args: ["queue", "--thread", thread, "--message", prompt] };
}

/** Which built-in wake path a running listener uses (its command came from viaCommand), or null for a hand-made one. */
export function viaOf(command: string): { via: "opencode" | "t3" | "codex-queue" | "tmux"; id: string } | null {
  let x = command.match(/'queue' '--thread' '([^']+)'/);
  if (x) return { via: "codex-queue", id: x[1] };
  x = command.match(/ nudge --tmux '([^']+)'/);
  if (x) return { via: "tmux", id: x[1] };
  x = command.match(/ thread send '([^']+)'/);
  if (x) return { via: "t3", id: x[1] };
  x = command.match(/ run --session '([^']+)'/);
  if (x) return { via: "opencode", id: x[1] };
  return null;
}

/** How long `listen --detach` waits for the background listener to hold its lock (BOTLINK_LISTEN_START_MS, 30 s). */
export const listenStartMs = () => {
  const v = Number(process.env.BOTLINK_LISTEN_START_MS);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
};

/** Start `listen --on-message <cmd>` for a member in the background (what `listen … --detach` does). */
export async function startDetached(m: st.MemberRec, cmdline: string, maxMs?: number): Promise<ListenLock> {
  st.ensureDir(st.p("logs"));
  const fd = openSync(listenLog(m.id), "a", 0o600);
  // without a time limit it runs under a tiny supervisor that restarts it if it dies
  const child = spawn(process.execPath, [process.argv[1], "listen", "--member-id", m.id, "--on-message", cmdline, ...(maxMs ? ["--max-s", String(maxMs / 1000)] : ["--supervise"])], { cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();
  // wait until it holds the lock (or its process ended), so the answer is true when this returns. Two cold Node starts
  // come first (the supervisor, then the listener); on a loaded computer each can take seconds (gate, 16 Nov 2026:
  // about 6 s each at load 5), so the wait is LISTEN_START_MS (30 s), not the 10 s that told people "didn't start"
  // while the listener then started anyway.
  const budget = listenStartMs();
  const end = Date.now() + budget;
  while (Date.now() < end && !runningListener(m.id) && child.exitCode === null) await new Promise((r) => setTimeout(r, 100));
  const l = runningListener(m.id);
  if (!l) {
    // never a listener running behind the person's back after "didn't start": stop what we started, by its PID (its
    // process group: the supervisor and the listener it may have started)
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
    forgetWakePath(m.id);
    throw new UserError(`The listener didn't start within ${Math.round(budget / 1000)} s, so bot-link stopped it: nothing is listening for ${m.name}. See ${listenLog(m.id)}, then try again.`);
  }
  return l;
}

/**
 * A chat that joins another room keeps ONE wake path (real-world run 2026-11-07: Codex in #acme + #growth woke only for
 * #acme). When this chat already runs a built-in nudge (codex queue / tmux / t3 / opencode) for one of its members, the
 * same nudge, into the same chat, is started for the new member. The human already said yes to that command for this
 * chat; the line returned says it happened. Hand-made --on-message commands are never copied.
 */
export async function extendWake(m: st.MemberRec): Promise<string | null> {
  if (runningListener(m.id)) return null;
  for (const l of allListeners()) {
    if (l.member === m.id) continue;
    const other = st.loadMember(l.member);
    const v = viaOf(l.command || "");
    if (!other || !v) continue;
    const same = v.via === "tmux" ? true : !!m.holder_session && other.holder_session === m.holder_session;
    if (!same) continue;
    const lk = await startDetached(m, viaCommand(v.via, v.id, m));
    return `Already reachable here (no need to offer a wake path for #${m.room.name}): this chat's wake path (${v.via === "tmux" ? `tmux pane ${v.id}` : v.via}, already running for ${other.name} in #${other.room.name}) now covers ${m.name} in #${m.room.name} too (listener pid ${lk.pid}). Stop it with: ${selfCmd()} listen --stop --member ${m.name} --room ${m.room.name}`;
  }
  return null;
}

/** A resume refused because the app holds the session open (Codex TUI / app, T3). */
export const ACTIVE_WRITER = /already has an active writer|active writer/i;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Built-in wake paths (verified CLIs, 2026-11-06):
 *   opencode  `opencode run --session <id> "<prompt>"`   continues that session headless (opencode.ai/docs/cli, opencode 1.18 --help)
 *   t3        `t3 thread send <id> "<prompt>" --wait`    queues a turn in that T3 Code thread (pingdotgg/t3code apps/server/src/cli/thread.ts;
 *             a busy thread gets it as its next turn; needs the T3 Code app running). Avoids `codex exec resume` on a
 *             session T3 owns (active-writer conflict).
 */
/** The T3 Code command line as a listener can run it later, from outside the thread: BOTLINK_T3_BIN, else `t3` when it
 *  is on PATH, else the npm launcher T3 names for its threads' commands (T3CODE_NPM_LAUNCHER_PATH: an `npx t3` install
 *  has no `t3` on PATH; probed on t3 0.1.9), else plain `t3`. */
export function t3Bin(env: NodeJS.ProcessEnv = process.env): string {
  const set = (env.BOTLINK_T3_BIN || "").trim();
  if (set) return shq(set);
  const onPath = (env.PATH || "").split(":").some((d) => d && existsSync(join(d, "t3")));
  const launcher = (env.T3CODE_NPM_LAUNCHER_PATH || "").trim();
  if (!onPath && launcher && existsSync(launcher)) return `${shq(process.execPath)} ${shq(launcher)}`;
  return "t3";
}
/** T3 Code finds its running server through its data directory; a thread's commands get it as T3CODE_HOME when it is
 *  not the default (~/.t3). The listener passes it on, so it reaches the same server whatever its own env is. */
export function t3BaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = (env.T3CODE_HOME || "").trim();
  return d ? ` --base-dir ${shq(d)}` : "";
}
export function viaCommand(via: "opencode" | "t3" | "codex-queue" | "tmux", id: string, m: st.MemberRec): string {
  if (via === "codex-queue") {
    const q = codexQueueArgs(id, viaPrompt(m));
    return [q.cmd, ...q.args].map(shq).join(" ");
  }
  // r3 (listen lab #3): typing into the chat's own tmux pane, done right: wait until the pane is idle, type the text
  // literally (send-keys -l), pause, then Enter as a separate call (in one burst a TUI takes the Enter as a pasted newline)
  if (via === "tmux") return `${selfExact()} nudge --tmux ${shq(id)} --member-id ${shq(m.id)}`;
  if (via === "t3") return `${t3Bin()} thread send ${shq(id)} ${shq(viaPrompt(m))} --wait${t3BaseDir()}`;
  const bin = process.env.BOTLINK_OPENCODE_BIN || "opencode";
  return `${shq(bin)} run --session ${shq(id)} ${shq(viaPrompt(m))}`;
}

const BUSY = /esc to interrupt|Working \(|Thinking|Running…|Generating|ing…/i;

/**
 * `botlink nudge --tmux <pane>` (the command `listen --tmux` runs): wait until the pane is idle (its last lines are
 * unchanged for 3 s and show no "working" marker; at most 5 minutes, then type anyway: the app queues it), type the
 * nudge literally, pause 0.5 s, then press Enter as a separate call. Exit 0 typed, 2 no such pane.
 */
export async function tmuxNudge(pane: string, text: string, o: { maxWaitMs?: number; say?: (s: string) => void } = {}): Promise<number> {
  const say = o.say || ((x: string) => process.stdout.write(x + "\n"));
  const tm = process.env.BOTLINK_TMUX_BIN || "tmux";
  const t = (...a: string[]) => spawnSync(tm, a, { encoding: "utf-8", timeout: 10_000 });
  const id = t("display-message", "-p", "-t", pane, "#{pane_id}");
  if (id.status !== 0 || !id.stdout.trim()) {
    say(`bot-link nudge: no tmux pane ${pane} (${(id.stderr || "").trim() || "tmux failed"}).`);
    return 2;
  }
  const end = Date.now() + (o.maxWaitMs ?? Number(process.env.BOTLINK_NUDGE_MAX_WAIT_MS || 5 * 60_000));
  let last = "", same = 0;
  while (Date.now() < end) {
    const cap = t("capture-pane", "-p", "-t", pane);
    const tail = (cap.stdout || "").split("\n").filter((l) => l.trim()).slice(-15).join("\n");
    if (tail === last && !BUSY.test(tail)) same++;
    else same = 0;
    last = tail;
    if (same >= 3) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  t("send-keys", "-t", pane, "-l", text);
  await new Promise((r) => setTimeout(r, 500));
  t("send-keys", "-t", pane, "Enter");
  say(`bot-link: nudged tmux pane ${pane}.`);
  return 0;
}

export function setupText(m: st.MemberRec, command: string): string {
  return [
    `bot-link listener for ${m.name} in #${m.room.name}: when messages for ${m.name} arrive, it runs this command (one run at a time, at least 10 s apart):`,
    `  ${command}`,
    `Show this command to your human. It runs in ${runDir(m)} without anyone watching (BOTLINK_UNATTENDED=1), with BOTLINK_LISTEN_SESSION=${m.holder_session || "(none)"}.`,
    `Stop it with: ${selfCmd()} listen --stop --member ${m.name}`,
  ].join("\n");
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      r();
    });
  });

async function setTurn(m: st.MemberRec, turn: st.Turn): Promise<boolean> {
  try {
    await apiFor(m.server).call({ method: "PUT", path: "/api/v1/me/turn", body: { turn }, signer: signerOf(m), session: m.holder_session, retryForMs: 15_000 });
    const fresh = st.loadMember(m.id);
    if (fresh) {
      fresh.turn = turn;
      st.saveMember(fresh);
    }
    return true;
  } catch {
    return false;
  }
}

export interface ListenOpts {
  say?: (s: string) => void;
  signal?: AbortSignal;
  /** stop after this long (tests) */
  maxMs?: number;
  /** a newer copy is installed and a restart runs it (default: only under `--supervise`, whose supervisor restarts it) */
  restartWhen?: () => boolean;
  checkEveryMs?: number;
}

/**
 * Run the listener in this process until it stops. -> exit code: 0 stopped (signal / --stop / max time),
 * 4 the member left or was removed, 5 another listener already runs for it.
 */
export async function listenOnMessage(m: st.MemberRec, command: string, o: ListenOpts = {}): Promise<number> {
  const say = o.say || ((s: string) => process.stdout.write(`${new Date().toISOString()} ${s}\n`));
  const other = runningListener(m.id);
  if (other && other.pid !== process.pid) {
    say(`A listener for ${m.name} is already running (pid ${other.pid}): ${other.command}\nStop it first: ${selfCmd()} listen --stop --member ${m.name}`);
    return 5;
  }
  const lock: ListenLock = {
    member: m.id, name: m.name, room: m.room.name, pid: process.pid, tag: startTag(process.pid), command, cwd: runDir(m), started: Date.now(),
    prev_turn: m.turn === "listening" ? "on_turn" : m.turn, log: listenLog(m.id),
  };
  st.ensureDir(st.p("listen"));
  st.writeJson(lockPath(m.id), lock);
  // self-healing: remember this chat's wake path, so the next bot-link call can restart it if it dies
  if (!o.maxMs) recordWakePath(m.id, { kind: "detached", command, at: Date.now() });
  const end = Date.now() + (o.maxMs ?? Infinity);
  const abort = new AbortController();
  o.signal?.addEventListener("abort", () => abort.abort());
  let child: ChildProcess | null = null;
  const onSig = () => {
    abort.abort();
    killRun(child);
  };
  process.on("SIGTERM", onSig);
  process.on("SIGINT", onSig);
  // after an update, a supervised listener stops between runs (never during one) and its supervisor starts it again
  // through the stable path, on the new copy (exit 75); the member's turn stays "listening" meanwhile
  let restarting = false;
  const restartWhen = o.restartWhen ?? (() => process.env.BOTLINK_SUPERVISED === "1" && restartPicksNewer());
  const restartCheck = setInterval(() => {
    try {
      if (restarting || child || !restartWhen()) return;
    } catch {
      return;
    }
    restarting = true;
    say(`${m.name}: bot-link was updated; restarting this listener on the new copy.`);
    abort.abort();
  }, o.checkEveryMs ?? RESTART_CHECK_MS);
  restartCheck.unref();
  say(setupText(m, command));
  if (!(await setTurn(m, "listening"))) say(`${m.name}: could not mark it "listening" on the server (it still listens; the roster may say otherwise).`);
  let code = 0;
  let streak = 0; // runs in a row that failed or left the messages waiting
  let lastRunEnd = 0;
  let afterRun = false;
  let waitFails = 0; // failed waits in a row (backoff 5 s doubling to 5 min)
  try {
    while (!abort.signal.aborted && Date.now() < end) {
      const cur = st.loadMember(m.id);
      if (!cur || cur.ended) {
        say(cur?.ended ? `${cur.ended.text} Listener stopped.` : `${m.name} is no longer a member on this computer. Listener stopped.`);
        code = 4;
        break;
      }
      const lk = st.readJson<ListenLock | null>(lockPath(m.id), null);
      if (!lk || lk.pid !== process.pid) {
        say(`This listener for ${m.name} was replaced or stopped.`);
        break;
      }
      let n = 0;
      const t0 = Date.now();
      try {
        const left = Math.max(1, Math.min(50, Math.floor((end - Date.now()) / 1000)));
        const r = (await apiFor(cur.server).call<any>({ method: "POST", path: "/api/v1/me/wait", body: { wait_s: left }, signer: signerOf(cur), session: cur.holder_session, timeoutMs: (left + 20) * 1000, retryForMs: 0, signal: abort.signal })).json;
        n = Number(r?.count || 0);
        waitFails = 0;
        noteReached(cur);
        if (!n && r?.retry_ms) await sleep(Math.min(60_000, r.retry_ms), abort.signal);
      } catch (e) {
        if (abort.signal.aborted) break;
        // gone, not this chat's (another chat holds it), or its key refused: final. Recorded, the wake path forgotten
        // (so nothing starts it again), exit 4 (its supervisor never restarts that); never a 403 every few seconds
        if (isFinal(e)) {
          const t = endMember(cur, e);
          say(`${t || `${m.name}: ${explain(e)}`} Listener stopped.`);
          code = 4;
          break;
        }
        const busy = highLoadDelayMs(e);
        if (busy) {
          // busy, not broken: one calm line per 10 minutes, back off as told (no failure streak)
          const note = busyNotice(e);
          if (note) say(note);
          await sleep(busy, abort.signal);
          continue;
        }
        waitFails++;
        say(`${m.name}: wait failed (${explain(e)}); retrying soon`);
        // refused on the way (not bot-link's answer) for a while: the chat is told once (memberend.ts)
        if (refusedKind(e)) {
          const t = noteRefused(cur, e);
          if (t) say(t);
        }
        // capped at 30 s (was 5 min): after a network blip the chat is reachable again within ~30 s, at <= 2-4 calls/min
        await sleep(Math.min(30_000, 5000 * 2 ** Math.min(waitFails - 1, 6)) * (0.5 + Math.random() / 2), abort.signal);
        continue;
      }
      if (!n) {
        streak = 0;
        afterRun = false;
        continue;
      }
      // the chat read its inbox since the last nudge (the read consumes the wake marker): the wake path works, so no
      // backoff. Only nudges nobody answers count (a command that does nothing, a chat that never reads).
      if (!st.wakeMarkPending(m.id)) streak = 0;
      // the first wait after a run returned at once: the run left messages waiting (or new ones came during it). A
      // nudge (codex queue, tmux) always does: its chat reads a few seconds later. Wait for that read (the marker goes)
      // up to the gap, and only count the run as failed when it doesn't come.
      if (afterRun && Date.now() - t0 < 2000) {
        const until = lastRunEnd + Math.min(LISTEN_MAX_GAP_MS, LISTEN_GAP_MS * 2 ** Math.min(streak + 1, 10));
        while (st.wakeMarkPending(m.id) && Date.now() < until && !abort.signal.aborted) await sleep(1000, abort.signal);
        if (abort.signal.aborted) break;
        if (st.wakeMarkPending(m.id)) streak++;
        else {
          streak = 0;
          afterRun = false;
          continue; // read: back to the wait (new messages are picked up at once, no extra gap)
        }
      }
      afterRun = false;
      const gap = Math.min(LISTEN_MAX_GAP_MS, LISTEN_GAP_MS * 2 ** Math.min(streak, 10));
      const wait = lastRunEnd + gap - Date.now();
      if (wait > 0) await sleep(wait, abort.signal);
      if (abort.signal.aborted) break;
      // a wake counts only when readable messages still wait (the chat may have read them meanwhile)
      try {
        const pk = (await apiFor(cur.server).call<any>({ method: "POST", path: "/api/v1/me/wait", body: { wait_s: 0, peek: true }, signer: signerOf(cur), session: cur.holder_session, retryForMs: 10_000, signal: abort.signal })).json;
        n = Number(pk?.count || 0);
      } catch {
        /* can't tell: run as planned */
      }
      if (!n) {
        afterRun = false;
        continue;
      }
      say(`${m.name}: ${n} new message${n === 1 ? "" : "s"}; running the listener command`);
      const fresh = st.loadMember(m.id) || cur;
      // the chat's own inbox read right after this counts as its idle wake (r3): the command only has to nudge
      st.markWake(m.id, "listen");
      const out: string[] = [];
      const r = await runOnce(fresh, command, n, (c) => (child = c), out);
      if (ACTIVE_WRITER.test(out.join(""))) {
        say(`${m.name}: the command was refused because this chat is open ("active writer"): resuming an open chat can't work. Nudge the open chat instead: ${selfCmd()} listen --via codex-queue --detach (Codex), or ${selfCmd()} listen --tmux "$TMUX_PANE" --detach.`);
      }
      child = null;
      lastRunEnd = Date.now();
      afterRun = true;
      if (r !== 0) streak++;
      say(`${m.name}: the command exited ${r}`);
    }
  } finally {
    clearInterval(restartCheck);
    process.off("SIGTERM", onSig);
    process.off("SIGINT", onSig);
    killRun(child);
    const lk = st.readJson<ListenLock | null>(lockPath(m.id), null);
    if (lk && lk.pid === process.pid) rmSync(lockPath(m.id), { force: true });
    if (restarting) code = RESTART_FOR_UPDATE;
    else if (code !== 4 && st.loadMember(m.id)) await setTurn(m, lock.prev_turn);
  }
  return code;
}

export function killRun(child: ChildProcess | null) {
  if (!child?.pid || child.exitCode !== null) return;
  // the run's own process group, by the PID we started (never by pattern)
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
}

function runDir(m: st.MemberRec): string {
  return m.cwd && st.exists(m.cwd) ? m.cwd : process.cwd();
}

/** The human accepted (in their own terminal) a wake command that switches the app's permission checks off. */
const fullAccessFile = (member: string) => st.p("listen", `${st.safeName(member)}.fullaccess`);
export function acceptFullAccess(member: string, command: string) {
  st.writeJson(fullAccessFile(member), { command, at: Date.now() });
}
export function fullAccessAccepted(member: string, command: string): boolean {
  return st.readJson<{ command?: string } | null>(fullAccessFile(member), null)?.command === command;
}
/** Why a wake command may not be used as it is (null: fine). */
export function unsafeWakeCommand(m: st.MemberRec, command: string): string | null {
  const flag = skipFlag(command);
  if (!flag || fullAccessAccepted(m.id, command)) return null;
  return `This command has ${flag}: it would start this chat with its permission checks off while nobody is here, so one message could make it run anything on this computer. bot-link won't run it. Use the app's ordinary resume command (a woken chat needs only bot-link's own tools to read and answer). If ${m.person_name || "your human"} really wants it, they start the listener themselves in their own terminal with --allow-full-access.`;
}

export function runOnce(m: st.MemberRec, command: string, count: number, started: (c: ChildProcess) => void, out: string[] = []): Promise<number> {
  st.ensureDir(st.p("logs"));
  const fd = openSync(listenLog(m.id), "a", 0o600);
  // the last check before a command runs with nobody here (also for a command an older client stored)
  const unsafe = unsafeWakeCommand(m, command);
  if (unsafe) {
    writeSync(fd, `not run: ${unsafe}\n`);
    closeSync(fd);
    out.push(unsafe);
    return Promise.resolve(126);
  }
  return new Promise((res) => {
    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        // the member's own folder, like watch: an app's "resume this chat" is scoped to the folder the chat runs in
        cwd: runDir(m),
        detached: true, // its own process group, so a timeout stops the whole run
        // BOTLINK_SESSION = the holder: the command is the member's human-approved wake path (as watch's resume is), so
        // the woken run acts as the member even when the app gives the resumed run a new id (`claude --continue -p`
        // does: run 2026-11-05T22-42-59, s22, every tool said "not a member")
        env: { ...process.env, BOTLINK_UNATTENDED: "1", BOTLINK_APP: m.app, BOTLINK_LISTEN_MEMBER: m.name, BOTLINK_LISTEN_SESSION: m.holder_session || "", BOTLINK_LISTEN_COUNT: String(count), ...(m.holder_session ? { BOTLINK_SESSION: m.holder_session } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      writeSync(fd, `could not start the command: ${(e as Error).message}\n`);
      closeSync(fd);
      res(127);
      return;
    }
    started(child);
    const runPid = child.pid || 0;
    if (runPid) st.markAway(m.id, runPid); // the member's reads during this run are "no human here"
    child.once("exit", () => runPid && st.clearAway(m.id, runPid));
    child.once("error", () => runPid && st.clearAway(m.id, runPid));
    let kept = 0;
    const w = (b: Buffer) => {
      if (kept < 8000) {
        out.push(b.toString("utf-8"));
        kept += b.length;
      }
      try {
        writeSync(fd, b);
      } catch {
        /* log only */
      }
    };
    child.stdout?.on("data", w);
    child.stderr?.on("data", w);
    const timer = setTimeout(() => {
      killRun(child);
      setTimeout(() => {
        try {
          if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }, 5000).unref();
    }, LISTEN_RUN_TIMEOUT_MS);
    let done = false;
    const finish = (c: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        closeSync(fd);
      } catch {
        /* closed */
      }
      res(c);
    };
    child.on("error", () => finish(127));
    child.on("exit", (c, sig) => finish(c ?? (sig ? 128 : 1)));
  });
}

/** `botlink listen --stop`: SIGTERM to the listener's own PID (checked against its start tag). */
/** Is this pid a `botlink wait` / `botlink listen` process (by its command line)? false when `ps` can't tell. */
function isWaitProcess(pid: number): boolean {
  try {
    const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf-8" });
    return r.status === 0 && /(cli\.js|botlink(-[0-9a-f]{16})?(\.tgz)?)\s+(wait|listen)(\s|$)/.test(r.stdout || "");
  } catch {
    return false;
  }
}

export async function stopListener(m: st.MemberRec, waitMs = 10_000): Promise<string> {
  // a `wait` this chat holds (in the background or in its turn): end that one too, by the pid it recorded for itself
  const held = wakePathOf(m.id);
  let endedWait = false;
  // only a process that is still that very wait: same start tag, and its command line is a bot-link wait / listen
  // (never the app's tool server, never a pid another program got since; without `ps` nothing is killed)
  if (held?.kind === "once" && held.pid && held.pid !== process.pid && held.pid !== process.ppid && st.pidAlive(held.pid) && !!held.tag && startTag(held.pid) === held.tag && isWaitProcess(held.pid)) {
    try {
      process.kill(held.pid, "SIGTERM");
      endedWait = true;
    } catch {
      /* gone meanwhile */
    }
  }
  forgetWakePath(m.id); // stopped on purpose: nothing to heal (a background events receiver has its own record)
  const l = runningListener(m.id);
  if (!l) {
    rmSync(lockPath(m.id), { force: true });
    return endedWait ? `Stopped the \`wait\` that was listening for ${m.name}. Nothing listens for it now; messages show up on this chat's next turn.` : `No listener is running for ${m.name}.`;
  }
  try {
    process.kill(l.pid, "SIGTERM");
  } catch {
    /* gone meanwhile */
  }
  const end = Date.now() + waitMs;
  while (Date.now() < end && st.pidAlive(l.pid)) await sleep(200);
  return st.pidAlive(l.pid) ? `Asked the listener for ${m.name} (pid ${l.pid}) to stop; it is still finishing.` : `Stopped the listener for ${m.name}.`;
}

// ------------------------------------------------------------------ self-healing wake paths
/**
 * "If a chat couldn't receive messages, it should fix itself." Each member's wake path is remembered once it runs:
 *   detached  a `listen --on-message/--via/--tmux --detach` listener (its command, approved by the human once)
 *   once      a `listen --once [--print]` run as the app's background task (pid + start tag of the current run)
 * The chat's next bot-link call (inbox, roster, status, send, reply, the MCP tools) checks it: a detached listener
 * that died (killed, crashed, the computer slept) is restarted with the same command and the chat is told; a --once
 * listener that isn't running (it ends after each wake, and with the app) gets an imperative "re-arm it now: <cmd>".
 * `listen --stop` forgets it (turned off on purpose). Honest limit: with every wake process gone, nothing can wake an
 * idle chat; the heal happens at its next turn (any bot-link call), and until then the room shows it "answers on its
 * next turn".
 */
export interface WakePath {
  kind: "detached" | "once";
  command?: string;
  pid?: number;
  tag?: string;
  at: number;
}
const wakePathFile = (memberId: string) => st.p("wakepath", `${st.safeName(memberId)}.json`);
export function recordWakePath(memberId: string, w: WakePath) {
  try {
    st.ensureDir(st.p("wakepath"));
    st.writeJson(wakePathFile(memberId), w);
  } catch {
    /* best effort */
  }
}
export function forgetWakePath(memberId: string) {
  rmSync(wakePathFile(memberId), { force: true });
}
export const wakePathOf = (memberId: string) => st.readJson<WakePath | null>(wakePathFile(memberId), null);

/** A background `events serve` receiver (bot-link Events, SPEC §6.13) is remembered in its OWN record, next to the
 *  listener's: a chat may have both, `listen --stop` and the listener's supervisor only ever look at the listener's
 *  record, `events stop` only at this one. args = the receiver's command line (after the program). */
export interface EventsPath {
  args: string[];
  cwd?: string;
  at: number;
}
const eventsPathFile = (memberId: string) => st.p("wakepath", `${st.safeName(memberId)}.events.json`);
export function recordEventsPath(memberId: string, w: EventsPath) {
  try {
    st.ensureDir(st.p("wakepath"));
    st.writeJson(eventsPathFile(memberId), w);
  } catch {
    /* best effort */
  }
}
export function forgetEventsPath(memberId: string) {
  rmSync(eventsPathFile(memberId), { force: true });
}
export const eventsPathOf = (memberId: string) => st.readJson<EventsPath | null>(eventsPathFile(memberId), null);

function lastLogLine(memberId: string): string {
  try {
    const lines = readFileSync(listenLog(memberId), "utf-8").trim().split("\n").filter((l) => /^\d{4}-\d\d-\d\dT/.test(l));
    return (lines[lines.length - 1] || "").replace(/^\S+Z /, "").slice(0, 160);
  } catch {
    return "";
  }
}

/** One line per member whose remembered wake path is down: what bot-link did, or what the chat must do now. */
export async function healWakePaths(ms: st.MemberRec[]): Promise<string[]> {
  const out: string[] = [];
  for (const m of ms) {
    if (st.loadMember(m.id)?.ended) continue; // the server ended it: nothing to heal (memberend.ts)
    const ev = eventsPathOf(m.id);
    if (ev?.args?.length) {
      const E = await import("./events.js");
      if (!E.runningReceiver(m.id)) {
        try {
          const r = await E.startDetachedReceiver(m, ev.args, ev.cwd);
          out.push(`bot-link: ${m.name}'s event receiver in #${m.room.name} had stopped. bot-link restarted it with the same command (pid ${r.pid}, port ${r.port}), so idle messages reach this chat again. Tell your human in one line; no other action needed.`);
        } catch (e) {
          // said once: a receiver that can't come back (its URL no longer reaches this computer) isn't retried on every call
          forgetEventsPath(m.id);
          out.push(`bot-link: ${m.name}'s event receiver in #${m.room.name} is DOWN and bot-link couldn't restart it (${e instanceof Error ? e.message : e}). Nothing wakes this chat while it's idle. Start it again: \`${selfCmd()} ${ev.args.join(" ").slice(0, 200)} --detach\`, then \`${selfCmd()} selftest\`.`);
        }
      }
    }
    let w = wakePathOf(m.id);
    // a listener started by an older client left no record; a lock left behind means it was killed (a normal stop
    // removes its lock): heal it the same way
    if (!w) {
      const stale = st.readJson<ListenLock | null>(lockPath(m.id), null);
      if (stale?.command && !runningListener(m.id)) w = { kind: "detached", command: stale.command, at: stale.started || 0 };
    }
    if (!w) continue;
    if (w.kind === "detached" && w.command) {
      if (runningListener(m.id)) continue;
      const why = lastLogLine(m.id);
      try {
        const l = await startDetached(m, w.command);
        out.push(`bot-link: ${m.name}'s wake path in #${m.room.name} had stopped${why ? ` (its log ends: "${why}")` : ""}. bot-link restarted it with the same command (pid ${l.pid}), so idle messages reach this chat again. Tell your human in one line; no other action needed.`);
      } catch (e) {
        out.push(`bot-link: ${m.name}'s wake path in #${m.room.name} is DOWN and bot-link couldn't restart it (${e instanceof Error ? e.message : e}). Re-arm it now: ${w.command.length < 200 ? `\`${selfCmd()} listen --member ${m.name} --room ${m.room.name} --on-message "<the same command>" --detach\`` : "run the listen command you set up before"}, then \`${selfCmd()} selftest\`.`);
      }
    } else if (w.kind === "once") {
      if (w.pid && st.pidAlive(w.pid) && (!w.tag || startTag(w.pid) === w.tag)) continue;
      out.push(`bot-link: nothing is listening for ${m.name} right now: the last \`wait\` ended (it ends with every wake and every time-out, and when the app restarts), so messages in #${m.room.name} reach this chat only on its next turn. If you listen by holding \`${selfCmd()} wait\`, start it again now, the same way as before. If your human turned listening off, ignore this (\`${selfCmd()} listen --stop\` makes this line go away).`);
    }
  }
  return [...new Set(out)];
}

/**
 * `listen … --supervise` (started by --detach): runs the listener as a child and starts it again when it dies (killed,
 * crashed) while this chat's wake path is still wanted (the wakepath record exists; `listen --stop` removes it).
 * Never restarts a member that left (exit 4) or a duplicate (exit 5). No polling: it only waits for the child to exit.
 * Exit 75: the child stopped because bot-link was updated; it is started again at once, on the new copy.
 * Backoff 5 s, doubling to 60 s while the child keeps dying within 30 s.
 */
export async function supervise(m: st.MemberRec, args: string[]): Promise<number> {
  let gap = 5000;
  for (;;) {
    const t0 = Date.now();
    const child = spawn(process.execPath, [process.argv[1], ...args], { cwd: process.cwd(), env: { ...process.env, BOTLINK_SUPERVISED: "1" }, stdio: "inherit" });
    const code: number | null = await new Promise((r) => child.on("exit", (c) => r(c)));
    if (code === 4 || code === 5 || !wakePathOf(m.id) || !st.loadMember(m.id)) return code ?? 0;
    if (code === RESTART_FOR_UPDATE) {
      // bot-link was updated: start it again at once (argv[1] is the stable path, so it runs the new copy)
      gap = 5000;
      continue;
    }
    gap = Date.now() - t0 < 30_000 ? Math.min(60_000, gap * 2) : 5000;
    process.stdout.write(`${new Date().toISOString()} ${m.name}: the listener stopped (exit ${code ?? "signal"}); restarting it in ${Math.round(gap / 1000)} s (self-healing)\n`);
    await sleep(gap);
    if (!wakePathOf(m.id)) return 0;
  }
}
