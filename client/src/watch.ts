/**
 * `botlink watch` (SPEC §6.9): one per machine. For each local member with turn=wake whose holder session is a
 * resumable Claude Code / Codex session:
 *   - holder session live on this machine (live marker, pid alive)  -> don't poll: its hooks handle it
 *   - else hold one non-leasing `POST /me/wait` long-poll (no lease, counts one wake)
 *   - count > 0 -> resume exactly the holder session in its folder, env BOTLINK_WAKE_MEMBER + BOTLINK_UNATTENDED=1:
 *       Claude Code  claude -p --resume <sid> "<WAKE_PROMPT>"      (verified: claude --help, code.claude.com/docs/en/cli-reference)
 *       Codex        codex exec resume <sid> "<WAKE_PROMPT>"       (verified: codex exec resume --help, developers.openai.com/codex/noninteractive)
 *       Cursor       cursor-agent -p --resume <chat> "<CURSOR_WAKE_PROMPT>"   (verified: cursor-agent --help, 2026.11.05)
 *     Claude Code / Codex: the resumed run's SessionStart hook leases + shows the messages (§7.2). Cursor runs no
 *     sessionStart on --resume (and no stop hook in -p), so its wake prompt has the model call the bot-link inbox tool.
 *     A Cursor member holds no session; watch resumes its `wake_chat` (the chat that ran join, or the newest chat whose
 *     sessionStart hook ran in its folder). Cursor has no "chat not found": an unknown id starts an empty chat under
 *     that id, and the wake prompt's inbox call still shows the messages there.
 *   - no new wait for that member until the resume exits (killed by PID after 10 min); >= 10 s between wakes per
 *     member; <= 2 concurrent resumes per machine. Never pkill -f: only PIDs this process started.
 *   - "session not found" -> ask-human cannot_wake, stop waking that member until its holder changes.
 * A resume path that fails before any hook runs still bumps `wakes` server-side on every round, so after 5 the
 * message is stuck and the person is told (P0-3).
 * r3 (listen lab 2026-11-06): a Codex resume refused with "active writer" means the chat is OPEN (Codex TUI / app):
 * watch queues the wake into that open thread instead (`codex queue --thread <id> --message …`), keeps doing that
 * for 10 minutes without trying the resume again, and peeks (no wake counted) for a minute after each nudge so the
 * open chat can read the messages itself. If the queue fails too, watch stops waking that member for 10 minutes:
 * the messages wait for the chat's own turn (inbox shows them, stuck or not) instead of burning 5 wakes in a minute.
 */
import { selfCmd } from "./version.js";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";

import * as st from "./state.js";
import { apiFor, signerOf, explain } from "./core.js";
import { ApiError, highLoadDelayMs } from "./api.js";
import { busyLine, busyNotice } from "./limits.js";
import { endMember, isFinal, noteReached, noteRefused, refusedKind } from "./memberend.js";
import { UNATTENDED_TOOL_NAMES } from "./config.js";
import { ACTIVE_WRITER, codexQueueArgs, viaPrompt } from "./listen.js";
import { SESSION_RE, safeSession } from "./reqsign.js";
import { CLAUDE_AWAY_DENY, CODEX_AWAY_SANDBOX, awayModeFor } from "./safety.js";

export const WAKE_PROMPT = "bot-link: new messages for you are in your context. Handle them under the bot-link rules. (If you don't see them, call the bot-link inbox tool.)";
/** Cursor's resumed chat gets no hook context: the model must fetch the messages itself. */
export const CURSOR_WAKE_PROMPT = "bot-link: you have new messages. Call the bot-link inbox tool now to read them, then handle them under the bot-link rules.";
export const RESUME_TIMEOUT_MS = Number(process.env.BOTLINK_RESUME_TIMEOUT_MS || 10 * 60_000);
export const WAKE_GAP_MS = Number(process.env.BOTLINK_WAKE_GAP_MS || 10_000);
export const MAX_RESUMES = 2;
/** bot-link's own tools a resumed Claude Code run may call without a prompt (it is unattended). */
export const UNATTENDED_TOOLS = UNATTENDED_TOOL_NAMES.flatMap((t) => [`mcp__botlink__${t}`, `mcp__botlink-v1__${t}`]);

/** Extra args for the resumed run (the real-CLI matrix passes --settings / --mcp-config / -c here). JSON array. */
function extraArgs(name: string): string[] {
  try {
    const v = JSON.parse(process.env[name] || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function resumeCommand(app: string, session: string, m?: st.MemberRec): { cmd: string; args: string[] } | null {
  // the id goes into another program's arguments: only an id shaped like one (it can come from the server); never a
  // word that starts with "-" and would be read as a flag
  if (!SESSION_RE.test(session)) return null;
  // what the woken run may do (safety.ts): answer only unless the human let woken runs work
  const work = awayModeFor(app, m?.cwd || null).mode === "work";
  // a chat inside T3 Code: T3 owns the Codex/Claude session (resuming it directly fails with an active-writer
  // conflict), so the wake is a turn queued into its T3 thread (`t3 thread send <id> "<prompt>" --wait`)
  if (m?.wake_thread?.via === "t3") return { cmd: process.env.BOTLINK_T3_BIN || "t3", args: ["thread", "send", m.wake_thread.id, CURSOR_WAKE_PROMPT, "--wait"] };
  // the prompt sits right after -p (`claude -p "<prompt>" --resume <id>`, the documented headless form):
  // --allowedTools is variadic and would swallow a trailing prompt
  // (--disallowedTools takes the tools away whatever the app's own settings allow; it comes before --allowedTools)
  if (app === "claude-code") return { cmd: process.env.BOTLINK_CLAUDE_BIN || "claude", args: ["-p", WAKE_PROMPT, `--resume=${session}`, ...extraArgs("BOTLINK_CLAUDE_ARGS"), ...(work ? [] : ["--disallowedTools", CLAUDE_AWAY_DENY.join(",")]), "--allowedTools", UNATTENDED_TOOLS.join(",")] };
  if (app === "codex") return { cmd: process.env.BOTLINK_CODEX_BIN || "codex", args: ["exec", ...extraArgs("BOTLINK_CODEX_ARGS"), ...(work ? [] : ["--sandbox", CODEX_AWAY_SANDBOX]), "resume", session, WAKE_PROMPT] };
  // H2: Cursor's tools can't tell which chat calls them: the wake prompt names the member (as)
  if (app === "cursor") return { cmd: process.env.BOTLINK_CURSOR_BIN || "cursor-agent", args: ["-p", "--resume", session, ...extraArgs("BOTLINK_CURSOR_ARGS"), m ? `${CURSOR_WAKE_PROMPT} (Call it with as: ${m.name}.)` : CURSOR_WAKE_PROMPT] };
  return null;
}

/** The chat watch resumes for a member: its holder session (Claude Code / Codex) or its wake chat (Cursor). */
export function wakeTarget(m: st.MemberRec): string | null {
  // a chat that named itself another app than the one bot-link detected (core.claimedApp): never resumed with the
  // detected app's command (a Grok Bot chat is not a Cursor chat cursor-agent can resume)
  if (m.app_name && st.wireApp(m.app) !== "other") return null;
  if (m.app === "cursor") return m.wake_chat || null;
  if (m.app === "claude-code" || m.app === "codex") return m.holder_session || null;
  return null;
}

const NOT_FOUND = /no (conversation|session)[^\n]*found|session[^\n]*not found|could not find (a )?(session|conversation)|no rollout found|thread not found/i;

interface Slot {
  member: string;
  polling: boolean;
  resume: { pid: number; child: ChildProcess; started: number; timer: NodeJS.Timeout } | null;
  lastWake: number;
  attempts: number;
  abort: AbortController | null;
  /** r3: the chat is open (a resume was refused "active writer"): until then, nudge it with codex queue */
  openUntil?: number;
  /** r3: last nudge into the open chat: peek (no wake counted) for a minute so it can read the messages itself */
  nudgedAt?: number;
  /** r3: neither resume nor queue works: don't wake this member until then */
  pausedUntil?: number;
  /** failed waits in a row (the server or network unwell): the pause before the next grows */
  fails?: number;
}

export interface WatchOpts {
  say?: (s: string) => void;
  /** stop after this many ms (tests) */
  runForMs?: number;
  /** member reload interval */
  tickMs?: number;
  signal?: AbortSignal;
  /** a newer copy is installed and a restart runs it (cli.ts: only when the service manager runs watch) */
  restartWhen?: () => boolean;
  /** how often to ask restartWhen (default 60 s, BOTLINK_RESTART_CHECK_MS) */
  checkEveryMs?: number;
}

export class Watcher {
  slots = new Map<string, Slot>();
  resumes = 0;
  stopped = false;
  /** stopped because bot-link was updated: exit 75 so the service manager starts it again on the new copy */
  restarting = false;
  log: (s: string) => void;
  constructor(private o: WatchOpts = {}) {
    this.log = o.say || ((s) => process.stdout.write(`${new Date().toISOString()} ${s}\n`));
  }

  /** members watch is responsible for */
  candidates(): st.MemberRec[] {
    return st.liveMembers().filter((m) => {
      const t = m.turn === "wake" && !m.ended ? wakeTarget(m) : null;
      return !!t && m.cannot_wake_session !== t;
    });
  }

  tick() {
    const want = new Set<string>();
    for (const m of this.candidates()) {
      want.add(m.id);
      let s = this.slots.get(m.id);
      if (!s) this.slots.set(m.id, (s = { member: m.id, polling: false, resume: null, lastWake: 0, attempts: 0, abort: null }));
      if (s.polling || s.resume) continue;
      if ((s.pausedUntil || 0) > Date.now()) continue;
      if (m.app !== "cursor" && st.liveOf(m.holder_session!)) continue; // the live session's own hooks handle it
      void this.poll(s);
    }
    for (const [id, s] of this.slots) if (!want.has(id) && s.polling) s.abort?.abort();
  }

  async poll(s: Slot) {
    s.polling = true;
    s.abort = new AbortController();
    try {
      const m = st.loadMember(s.member);
      if (!m || !wakeTarget(m)) return;
      // just nudged an open chat: peek (no wake counted) until it read them or a minute passed
      const peek = !!s.nudgedAt && Date.now() - s.nudgedAt < 60_000;
      const r = (await apiFor(m.server).call<any>({ method: "POST", path: "/api/v1/me/wait", body: peek ? { wait_s: 0, peek: true } : { wait_s: 50 }, signer: signerOf(m), session: m.holder_session, timeoutMs: 70_000, retryForMs: 0, signal: s.abort.signal })).json;
      if (peek) {
        if (r?.count > 0) await sleep(5000);
        else s.nudgedAt = 0;
        return;
      }
      if (m.app !== "cursor" && typeof r?.holder_session !== "undefined" && r.holder_session !== m.holder_session) {
        // the server knows a newer holder (a claim): follow it
        const fresh = st.loadMember(m.id);
        if (fresh) {
          // an id shaped like one, or nothing: it becomes an argument of the app's resume command
          fresh.holder_session = r.holder_session === null ? null : safeSession(r.holder_session) ?? fresh.holder_session;
          st.saveMember(fresh);
        }
        return;
      }
      s.fails = 0;
      noteReached(m);
      if (r?.count > 0) await this.wake(s, m, r.count);
      else if (r?.retry_ms) await sleep(Math.min(60_000, r.retry_ms));
    } catch (e) {
      if (this.stopped || s.abort?.signal.aborted) return;
      if (e instanceof ApiError && e.code === "superseded") return;
      // gone, or not this computer's chat's any more (another chat holds it, its key refused): final. Recorded and
      // never polled again (memberend.ts); a member another chat on this computer took over keeps its new record.
      if (isFinal(e)) {
        const m = st.loadMember(s.member);
        const t = m ? endMember(m, e) : null;
        this.log(`${t || `${m?.name || s.member}: ${explain(e)}`} Not watching it any more.`);
        const now = st.loadMember(s.member);
        if (now && !now.ended) {
          now.cannot_wake_session = wakeTarget(now);
          st.saveMember(now);
        }
        return;
      }
      const busy = highLoadDelayMs(e);
      if (busy) {
        // busy, not broken: one calm line per 10 minutes, back off as told
        const note = busyNotice(e);
        if (note) this.log(note);
        await sleep(busy);
        return;
      }
      // the server or the network is unwell: try again, the pause growing (2 s doubling to 60 s, with jitter)
      s.fails = (s.fails || 0) + 1;
      this.log(`${s.member}: wait failed (${explain(e)}); retrying soon`);
      if (refusedKind(e)) {
        const m = st.loadMember(s.member);
        const t = m ? noteRefused(m, e) : null;
        if (t) this.log(t);
      }
      await sleep(Math.min(60_000, 2000 * 2 ** Math.min(s.fails - 1, 5)) * (0.5 + Math.random() / 2));
    } finally {
      s.polling = false;
      s.abort = null;
    }
  }

  async wake(s: Slot, m: st.MemberRec, count: number) {
    if (m.app !== "cursor" && st.liveOf(m.holder_session!)) return; // became live meanwhile
    const gap = s.lastWake + WAKE_GAP_MS - Date.now();
    if (gap > 0) await sleep(gap);
    while (this.resumes >= MAX_RESUMES && !this.stopped) await sleep(500);
    if (this.stopped) return;
    const target = wakeTarget(m);
    if (target && m.app === "codex" && (s.openUntil || 0) > Date.now()) {
      // the chat is open: a resume would be refused again
      await this.queueIntoOpen(s, m, target);
      return;
    }
    const rc = target ? resumeCommand(m.app, target, m) : null;
    if (!rc) return;
    s.lastWake = Date.now();
    s.attempts++;
    this.resumes++;
    const logf = st.p("logs", `resume-${m.id}.log`);
    st.ensureDir(st.p("logs"));
    const fd = openSync(logf, "a", 0o600);
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn(rc.cmd, rc.args, {
        cwd: m.cwd || process.env.HOME,
        // BOTLINK_APP: the woken run is this member's app, whatever its process tree looks like
        env: { ...process.env, BOTLINK_WAKE_MEMBER: m.id, BOTLINK_UNATTENDED: "1", BOTLINK_APP: m.app },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      this.resumes--;
      closeSync(fd);
      this.log(`${m.name}: could not start ${rc.cmd}: ${(e as Error).message}`);
      return;
    }
    const capture = (b: Buffer) => {
      if (out.length < 8000) out += b.toString("utf-8");
      try {
        writeSync(fd, b);
      } catch {
        /* log only */
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    // while this run goes, the member's reads are "no human here" (also for apps that give their tools another environment)
    const runPid = child.pid || 0;
    if (runPid) st.markAway(m.id, runPid);
    this.log(`${m.name}: ${count} new message${count === 1 ? "" : "s"}; resuming ${m.app} ${m.app === "cursor" ? "chat" : "session"} ${target} (pid ${child.pid})`);
    await new Promise<void>((res) => {
      const timer = setTimeout(() => {
        // killed by the PID we started, never by pattern
        if (child.pid) {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            /* gone */
          }
          setTimeout(() => {
            try {
              if (child.pid && child.exitCode === null) process.kill(child.pid, "SIGKILL");
            } catch {
              /* gone */
            }
          }, 5000).unref();
        }
      }, RESUME_TIMEOUT_MS);
      s.resume = { pid: child.pid || 0, child, started: Date.now(), timer };
      const done = (code: number | null) => {
        clearTimeout(timer);
        if (runPid) st.clearAway(m.id, runPid);
        res();
        void this.afterResume(m, code, out, s);
      };
      child.on("error", (e) => {
        out += `\n${e.message}`;
        done(127);
      });
      child.on("exit", (code) => done(code));
    });
    s.resume = null;
    this.resumes--;
    closeSync(fd);
  }

  /** r3: wake an OPEN Codex chat by queueing a turn into its thread (`codex queue`). */
  async queueIntoOpen(s: Slot, m: st.MemberRec, thread: string) {
    const q = codexQueueArgs(thread, viaPrompt(m));
    s.lastWake = Date.now();
    st.markWake(m.id, "watch-queue"); // before: the queued turn may start (and read) before codex queue returns
    const r = await new Promise<{ code: number | null; out: string }>((res) => {
      let out = "";
      let child: ChildProcess;
      try {
        child = spawn(q.cmd, q.args, { cwd: m.cwd || process.env.HOME, env: { ...process.env, BOTLINK_APP: m.app }, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        res({ code: 127, out: (e as Error).message });
        return;
      }
      const t = setTimeout(() => child.pid && child.exitCode === null && child.kill("SIGTERM"), 60_000);
      child.stdout?.on("data", (b) => (out += b));
      child.stderr?.on("data", (b) => (out += b));
      child.on("error", (e) => {
        clearTimeout(t);
        res({ code: 127, out: out + e.message });
      });
      child.on("exit", (code) => {
        clearTimeout(t);
        res({ code, out });
      });
    });
    if (r.code === 0) {
      s.nudgedAt = Date.now();
      this.log(`${m.name}: queued the wake into its open Codex chat ${thread} (codex queue)`);
      return;
    }
    s.openUntil = 0;
    s.pausedUntil = Date.now() + 10 * 60_000;
    this.log(`${m.name}: its Codex chat is open and codex queue failed too (exit ${r.code}: ${r.out.trim().split("\n").pop()?.slice(0, 200)}); not waking it for 10 minutes. Its messages wait for its next turn (the inbox tool shows them).`);
  }

  async afterResume(m: st.MemberRec, code: number | null, out: string, s?: Slot) {
    if (code === 0) return;
    this.log(`${m.name}: resume exited ${code}`);
    if (s && m.app === "codex" && ACTIVE_WRITER.test(out)) {
      const target = wakeTarget(m);
      this.log(`${m.name}: its Codex chat is open ("active writer"): resuming it can't work; queueing the wake into the open thread instead`);
      s.openUntil = Date.now() + 10 * 60_000;
      if (target) await this.queueIntoOpen(s, m, target);
      return;
    }
    if (!NOT_FOUND.test(out)) return; // wakes keep counting server-side; 5 -> stuck + the person is told
    const fresh = st.loadMember(m.id);
    if (!fresh || wakeTarget(fresh) !== wakeTarget(m)) return;
    fresh.cannot_wake_session = wakeTarget(fresh);
    st.saveMember(fresh);
    this.log(`${m.name}: its chat ${wakeTarget(m)} is gone; telling ${m.person_name} and not waking it until another chat uses it`);
    try {
      await apiFor(m.server).call({ method: "POST", path: "/api/v1/me/ask-human", body: { reason: "cannot_wake" }, signer: signerOf(m), session: m.holder_session, retryForMs: 30_000 });
    } catch (e) {
      this.log(`${m.name}: could not tell the dashboard (${explain(e)})`);
    }
  }

  async run(): Promise<void> {
    const tickMs = this.o.tickMs ?? 2000;
    const end = this.o.runForMs ? Date.now() + this.o.runForMs : Infinity;
    this.log(`bot-link watch: watching ${this.candidates().length} member(s)`);
    const stop = () => this.stop();
    this.o.signal?.addEventListener("abort", stop);
    const checkMs = this.o.checkEveryMs ?? Number(process.env.BOTLINK_RESTART_CHECK_MS || 60_000);
    let checked = Date.now();
    while (!this.stopped && Date.now() < end) {
      if (this.o.restartWhen && Date.now() - checked >= checkMs) {
        checked = Date.now();
        let newer = false;
        try {
          newer = this.o.restartWhen();
        } catch {
          newer = false;
        }
        if (newer) {
          // its waits stop now; resumes it started finish first (below), then it exits 75 and is started again
          this.restarting = true;
          this.log("bot-link was updated; watch restarts on the new copy.");
          break;
        }
      }
      try {
        this.tick();
      } catch (e) {
        this.log(`tick failed: ${(e as Error).message}`);
      }
      await sleep(tickMs);
    }
    this.stop();
    // let in-flight resumes finish (they are bounded by RESUME_TIMEOUT_MS)
    while ([...this.slots.values()].some((s) => s.resume)) await sleep(200);
  }

  stop() {
    this.stopped = true;
    for (const s of this.slots.values()) s.abort?.abort();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ listen (a chat's own background command)
/**
 * `botlink listen`: keeps running (feedback: a listener that exits after one batch has to be restarted by the chat each
 * time). It holds the non-leasing wait; when messages wait it prints one line per member, then re-checks without
 * counting a wake (peek) until they are read, and prints again only for new ones. --once: the old behaviour (print,
 * exit 0). Exit 4: every member left / was removed; 3: --max-s ran out.
 */
export async function listen(members: st.MemberRec[] | (() => st.MemberRec[]), o: { maxMs?: number; say?: (s: string) => void; signal?: AbortSignal; once?: boolean; print?: boolean; /** `botlink wait`: the name of the wake marker, and where what happened is reported */ how?: string; fired?: { name: string; count: number; already: boolean }[]; /** the wait tool runs inside the app's own tool server: its pid is not a wait to stop */ noRecord?: boolean; /** how the polls went (a wait that never reached the server must not say "no new messages"; busy: turned away by a busy server) */ health?: { ok: number; failed: number; last: string; busy?: number } } = {}): Promise<number> {
  const say = o.say || ((s: string) => process.stdout.write(s + "\n"));
  const end = Date.now() + (o.maxMs ?? Infinity);
  // a function: the members this chat holds NOW (a room joined while the listener runs is covered from its next round;
  // real-world run 2026-11-07: a chat that joined a second room was reachable only in the first)
  const current = () => (typeof members === "function" ? members() : members);
  if (!current().length) {
    say("No bot-link member to listen for here.");
    return 1;
  }
  const told = new Map<string, number>(); // member -> count already announced and not yet read
  const fails = new Map<string, number>(); // member -> failed waits in a row (server or network unwell)
  const gone = new Set<string>();
  // self-healing: a --once run is this chat's wake path; when it isn't running (it fired, or the app
  // restarted) the chat's next bot-link call says "re-arm it now"
  const recorded = new Set<string>();
  const remember = async (ms: st.MemberRec[]) => {
    if (!o.once || o.noRecord) return;
    const fresh = ms.filter((m) => !recorded.has(m.id));
    if (!fresh.length) return;
    const L = await import("./listen.js");
    const { startTag } = await import("./session.js");
    for (const m of fresh) {
      recorded.add(m.id);
      // a detached listener is this chat's wake path already: a wait it also holds for a moment (to stay for an
      // answer) must not replace that record, or a dead listener would no longer be restarted (real run 2026-11-10)
      if (L.runningListener(m.id) || L.wakePathOf(m.id)?.kind === "detached") continue;
      L.recordWakePath(m.id, { kind: "once", pid: process.pid, tag: startTag(process.pid), at: Date.now() });
    }
  };
  // one wait per member, each on its own: a member's message is handled when ITS wait returns, never held back by
  // another member's 50 s long-poll (before: Promise.all over every member)
  const inflight = new Map<string, Promise<{ m: st.MemberRec; n: number; failed?: boolean }>>();
  const waitOne = async (m: st.MemberRec): Promise<{ m: st.MemberRec; n: number; failed?: boolean }> => {
    const peek = (told.get(m.id) || 0) > 0;
    try {
      if (peek) await sleep(Math.min(5000, Math.max(0, end - Date.now())));
      const left = peek ? 0 : Math.max(1, Math.min(50, Math.floor((end - Date.now()) / 1000)));
      const r = (await apiFor(m.server).call<any>({ method: "POST", path: "/api/v1/me/wait", body: { wait_s: left, ...(peek ? { peek: true } : {}) }, signer: signerOf(m), session: m.holder_session, timeoutMs: (left + 20) * 1000, retryForMs: 0, signal: o.signal })).json;
      if (o.health) o.health.ok++;
      fails.delete(m.id);
      noteReached(m);
      return { m, n: Number(r?.count || 0) };
    } catch (e) {
      // gone or not this chat's: final (memberend.ts), never asked again
      if (isFinal(e)) {
        const t = endMember(m, e);
        say(`bot-link: ${t || `${m.name}: ${explain(e)}`}`);
        return { m, n: -1 };
      }
      const busy = highLoadDelayMs(e);
      if (busy) {
        // the server is busy, not unreachable: one calm line, then back off (never a line per retry)
        const note = busyNotice(e);
        if (note) say(note);
        if (o.health) {
          o.health.busy = (o.health.busy || 0) + 1;
          o.health.last = busyLine(e, true);
        }
        await sleep(Math.min(busy, Math.max(0, end - Date.now())));
        return { m, n: told.get(m.id) || 0, failed: true };
      }
      if (refusedKind(e)) {
        const t = noteRefused(m, e);
        if (t) say(`bot-link: ${t}`);
      }
      if (o.health) {
        o.health.failed++;
        o.health.last = explain(e);
        // said once, where the chat (or its log) reads it: a wait that can't reach the server is not listening
        if (o.fired && o.health.failed === 3 && !o.health.ok) process.stderr.write(`bot-link: can't reach bot-link's server (${o.health.last}); still trying.\n`);
      }
      // the server or the network is unwell: try again, the pause growing (3 s doubling to 60 s, with jitter)
      const k = (fails.get(m.id) || 0) + 1;
      fails.set(m.id, k);
      await sleep(Math.min(Math.min(60_000, 3000 * 2 ** Math.min(k - 1, 5)) * (0.5 + Math.random() / 2), Math.max(0, end - Date.now())));
      return { m, n: told.get(m.id) || 0, failed: true };
    }
  };
  // `botlink wait`: what waits before the wait begins (one look, nothing counted as a wake)
  const early = new Set<string>();
  if (o.fired) {
    await Promise.all(current().map(async (m) => {
      try {
        const r = (await apiFor(m.server).call<any>({ method: "POST", path: "/api/v1/me/wait", body: { wait_s: 0, peek: true }, signer: signerOf(m), session: m.holder_session, timeoutMs: 15_000, retryForMs: 0, signal: o.signal })).json;
        if (Number(r?.count || 0) > 0) early.add(m.id);
      } catch {
        // not known what waited before: the first message after this is not taken for a wake (never a pass by luck)
        early.add(m.id);
      }
    }));
  }
  while (Date.now() < end && !o.signal?.aborted) {
    const live = current().filter((m) => !gone.has(m.id));
    if (!live.length) return 4;
    await remember(live);
    for (const m of live) if (!inflight.has(m.id)) inflight.set(m.id, waitOne(m));
    const r = await Promise.race([...inflight.values()]);
    inflight.delete(r.m.id);
    if (r.n < 0) {
      gone.add(r.m.id);
      continue;
    }
    const before = told.get(r.m.id) || 0;
    // what waited before the wait began has been read meanwhile (a hook, another read): from here on a message is a wake
    if (r.n === 0 && !r.failed) early.delete(r.m.id);
    if (r.n > before) {
      // r3: this chat's own inbox read right after this line counts as its idle wake (the listener only nudges)
      // messages that were already waiting when `wait` started woke nobody: the chat started the wait in its own turn
      // and reads them there (no wake marker, so that read never counts as an idle wake)
      const already = !!o.fired && early.has(r.m.id);
      // (a plain `listen` the chat runs itself is the chat's own signal, like a wait: never the mark of a listener's command)
      if (!already) st.markWake(r.m.id, o.how || (o.once ? "listen-once" : "listen-print"));
      else st.markSignal(r.m.id); // no wake to claim, but the read that follows was still not started by a person
      o.fired?.push({ name: r.m.name, count: r.n, already });
      if (o.fired) return 0; // `botlink wait` words its own lines
      if (o.print) {
        // one step (listen lab #4): the messages themselves, read now; this output is the chat's own next turn
        const { inboxText } = await import("./core.js");
        say(await inboxText([r.m], r.m.holder_session, false));
        if (o.once) return 0;
        told.set(r.m.id, 0);
        continue;
      }
      say(`${r.n} new bot-link message${r.n === 1 ? "" : "s"} for ${r.m.name}. Call the bot-link inbox tool (or run: ${selfCmd()} inbox --as ${r.m.name}).`);
      if (o.once) return 0;
    }
    told.set(r.m.id, r.n);
  }
  return 3;
}
