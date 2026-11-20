/**
 * Local state under ~/.botlink (SPEC §7.1): dirs 0700, files 0600, atomic writes (tmp + rename).
 *
 *   config.json                 server URL, clock offset
 *   members/<member_id>.json    room, name, app, folder, holder session, pins (resolvers read liveMembers() only)
 *   rejoined/<member_id>.json   a removed membership a re-join replaced: `botlink status` says it once (memberend.ts)
 *   requests/<request_id>.json  a join/claim request waiting for approval (keys under the request id)
 *   keys/<key id>.json          key fallback store (secrets.ts), 0600
 *   ledger/<member>/<msg_id>    processing | shown (30 days)
 *   outbox/<msg_id>.json        exact send body + resend info, sealed to the sender's own key (7 days)
 *   prompts/<session>.jsonl     the human's prompts, MEMBER chats only, captured by the prompt hook (last 20, 30 min);
 *                               purged when the chat stops holding a member (prunePrompts)
 *   rules/<member_id>.json      standing rules (never sent to the server)
 *   live/<session>.json         pid of the live harness process holding a session
 *   sessions/<pid>-<tag>.json   harness pid -> session id (written by SessionStart hooks)
 *   waiters/<session>.pid       Claude Code Stop waiter
 *   wake/<member_id>.json       a listener nudged this member's chat just now (r3: the chat's own next inbox read counts
 *                               as an idle wake, so a nudged chat's self-test can pass without reading in the wake)
 *   archive/<member_id>/        room reports (archive.ts, SPEC §7.3c): what this chat sent and received, sealed, history days
 *   reports/                    saved room reports + their evidence bundles; pending/ (a report waiting 24 h to be saved)
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { homeDir } from "./config.js";
import type { Pin, RosterSnap } from "./roster.js";

export function p(...parts: string[]): string {
  return join(homeDir(), ...parts);
}

export function ensureDir(d: string) {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  try {
    chmodSync(d, 0o700);
  } catch {
    /* not ours */
  }
}

export function writeAtomic(path: string, data: string | Buffer) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readJson<T>(path: string, dflt: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return dflt;
  }
}

export function writeJson(path: string, obj: unknown) {
  writeAtomic(path, JSON.stringify(obj, null, 2) + "\n");
}

export function listJson<T>(dir: string): T[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const f of names.sort()) {
    const v = readJson<T | null>(join(dir, f), null);
    if (v) out.push(v);
  }
  return out;
}

export function pidAlive(pid: number): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch (e: any) {
    return e?.code === "EPERM";
  }
  // a killed process nobody reaped yet (a zombie) is gone: its listener lock must not look alive (real-world heal
  // test 2026-11-07: a SIGKILLed listener whose parent died too stayed <defunct>, and nothing healed it)
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true; // no /proc (macOS): kill 0 said it exists
  }
}

const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;
export function safeName(s: string): string {
  if (!SAFE.test(s)) throw new Error("unsafe local name");
  return s;
}

// ------------------------------------------------------------------ config
export interface LocalConfig {
  server?: string;
  clock_offset_s?: number;
  /** what a run bot-link starts with no human present may do (safety.ts): the human's choice */
  unattended?: { mode: "answer" | "work"; at: number; accepted?: string[] };
}
export const DEFAULT_SERVER = "https://api.botlink.dev";

export function loadConfig(): LocalConfig {
  return readJson<LocalConfig>(p("config.json"), {});
}
export function saveConfig(c: LocalConfig) {
  writeJson(p("config.json"), c);
}

// ------------------------------------------------------------------ members
/** The app of a chat on this computer. "opencode" is local only: on the wire (signed roster, join request `app`) it is
 *  "other", with `app_name: "opencode"` as unsigned display data (CONTRACT-CHANGES 2026-11-06 OpenCode). */
export type App = "claude-code" | "codex" | "cursor" | "opencode" | "t3" | "other";
/** The signed-roster app for a local app. */
/** "t3" (a T3 Code thread, whichever provider runs under it) is local only too: wire "other", `app_name: "T3 Code"`. */
export const wireApp = (a: App): "claude-code" | "codex" | "cursor" | "other" => (a === "opencode" || a === "t3" ? "other" : a);
export type Turn = "always_on" | "wake" | "listening" | "on_turn";

export interface MemberRec {
  id: string;
  server: string;
  room: { id: string; name: string; purpose: string };
  name: string;
  job: string;
  app: App;
  /** which app an "other" chat runs in (OpenCode, T3 Code, …): detected, or the model's own answer at join. Unsigned
   *  display data (the roster says "other"); never used to decide anything. */
  app_name?: string | null;
  folder: string;
  /** absolute folder, local only (watch resumes there) */
  cwd: string;
  machine: string;
  turn: Turn;
  account: string;
  person_name: string;
  /** the session holding this member, as far as this machine knows (null: none) */
  holder_session: string | null;
  holder_epoch: number;
  /** the key-store id holding this member's keys */
  key_id: string;
  key_backend: string;
  pin: Pin;
  joined_at: number;
  /** set by watch when a resume found the session gone (stop waking until the holder changes) */
  cannot_wake_session?: string | null;
  /** Cursor only (local): the chat watch resumes (`cursor-agent -p --resume <id>`). Cursor members hold no session;
   *  this is the chat that ran `join` (CURSOR_CONVERSATION_ID) or, later, the newest chat whose sessionStart hook ran
   *  in the member's folder. */
  wake_chat?: string | null;
  /** the member list as this chat's model last saw it (a batch's "since your last message" note, SPEC §6.10a) */
  told?: RosterSnap | null;
  /** the last self-test (SPEC §6.4a): woken = shown by a woken run (idle delivery proven) */
  selftest?: { id: string; sent_at: number; /** when the test reaches the chat (sent_at + the hold-back) */ due_at?: number; shown_at: number | null; woken: boolean | null; /** what woke the chat for a PASSED test (wait, a listener, a hook, …) */ how?: string | null; /** Kickoff 2: 1 = the test sent with the first listen, 2 = the one that checks the way the chat was left */ round?: 1 | 2; /** how the chat was listening when the test was asked for: a wait held in its turn (`wait --max-s`), or anything that keeps running */ mode?: "held" | "open"; /** a later wake that went unanswered for minutes (the PASS is in doubt until a new test) */ unanswered_at?: number } | null;
  /** apps bot-link can't identify by session (OpenCode 1.x, T3 Code): the chat's own id, given at join (--session) or
   *  read from the app (T3CODE_THREAD_ID), used only to wake it (listen --via) */
  wake_thread?: { via: "t3" | "opencode"; id: string } | null;
  /** the member list when this chat last sent (a room-wide send shows what changed since) */
  spoke?: RosterSnap | null;
  /** the server said this member is gone or not this chat's (memberend.ts): kept, never polled for again */
  ended?: { at: number; code: string; text: string; /** the wake paths, put aside (memberend.ts revive) */ wake?: unknown; events?: unknown } | null;
}

export function memberPath(id: string) {
  return p("members", `${safeName(id)}.json`);
}
export function loadMember(id: string): MemberRec | null {
  return readJson<MemberRec | null>(memberPath(id), null);
}
/** The newer of two self-test records (sent later, or the same test with a result). */
function newerTest(a: MemberRec["selftest"], b: MemberRec["selftest"]): MemberRec["selftest"] {
  if (!a) return b ?? null;
  if (!b) return a;
  if (a.id !== b.id) return (b.sent_at || 0) > (a.sent_at || 0) ? b : a;
  return b.shown_at ? b : a;
}

export function saveMember(m: MemberRec, o: { /** memberend.ts revive only: this save clears the `ended` mark */ clearEnded?: boolean } = {}) {
  // M2 (a field test T12): several bot-link processes (the MCP server, hooks, watch, listeners) save member records
  // from copies they loaded earlier; a stale copy must never wipe the self-test result another process just recorded
  // (status said "sent, not read yet" after the Stop hook had shown it). Keep the newer self-test.
  // The same for `ended` (memberend.ts): a copy loaded before the server ended the member never clears the mark; only
  // revive does, on purpose.
  const disk = readJson<MemberRec | null>(memberPath(m.id), null);
  if (disk && disk.key_id === m.key_id) {
    m = { ...m, selftest: newerTest(disk.selftest ?? null, m.selftest ?? null) };
    if (disk.ended && !m.ended && !o.clearEnded) m.ended = disk.ended;
  }
  writeJson(memberPath(m.id), m);
}

// ------------------------------------------------------------------ lost members (critical fix H1)
/** A member another chat on this computer took over with the person's approval: the chat it left (its session) is
 *  told once, by its next hook or bot-link call. */
export interface LostRec {
  member: string;
  name: string;
  room: string;
  person: string;
  at: number;
  /** what to tell the chat instead of "moved to another chat" (a member that ended: memberend.ts) */
  text?: string;
}
const lostPath = (session: string) => p("lost", `${safeName(session)}.json`);
export function markLost(session: string, r: LostRec) {
  const all = readJson<LostRec[]>(lostPath(session), []).filter((x) => x.member !== r.member);
  all.push(r);
  writeJson(lostPath(session), all);
}
/** The lost members of this session (all, or only `member`), removed as they are read: each is told once. */
export function takeLost(session: string | null | undefined, member?: string): LostRec[] {
  if (!session) return [];
  const f = lostPath(session);
  const all = readJson<LostRec[]>(f, []);
  if (!Array.isArray(all) || !all.length) return [];
  const mine = all.filter((x) => !member || x.member === member);
  const rest = all.filter((x) => !mine.includes(x));
  if (rest.length) writeJson(f, rest);
  else rmSync(f, { force: true });
  return mine.filter((x) => Date.now() - x.at < 7 * 86400_000);
}
export const lostText = (r: LostRec) => r.text ? `bot-link: ${r.text}` :
  `bot-link: ${r.name} in #${r.room} is now used by another chat (${r.person || "your human"} approved the move). This chat is no longer ${r.name}: stop acting as ${r.name}, and don't send or read bot-link messages as it.`;
export function deleteMember(id: string) {
  rmSync(memberPath(id), { force: true });
}

// Launch blocker, staging c5b1c2f (16 Nov 2026): a member the person removed, then joined again under the same name
// in the same room, left two records here, and `send --as beta` said "a member of several rooms (#a, #a)". The server
// lets one member hold a name in a room at a time, so of the records of one server, room and name only the newest can
// be live; the others are leftovers of a removal. Every resolver reads liveMembers(); the ended ones are read only by
// what tells the person about them (memberend.ts), through endedMembers(). (test/rejoin.test.ts scans the sources.)
function memberRecords(): MemberRec[] {
  return listJson<MemberRec>(p("members"));
}
const slot = (m: MemberRec) => `${m.server}\n${m.room?.id}\n${m.name}`;
const newer = (a: MemberRec, b: MemberRec) => ((a.joined_at || 0) !== (b.joined_at || 0) ? (a.joined_at || 0) > (b.joined_at || 0) : a.id > b.id);
/** The records that are the newest of their server, room and name. */
function newestPerSlot(): MemberRec[] {
  const all = memberRecords();
  const top = new Map<string, MemberRec>();
  for (const m of all) {
    const o = top.get(slot(m));
    if (!o || newer(m, o)) top.set(slot(m), m);
  }
  return all.filter((m) => top.get(slot(m)) === m);
}
/** The members this computer acts as: not ended, and not an earlier record of a room and name joined again since.
 *  Every lookup of a chat's member, name or room uses this. */
export function liveMembers(): MemberRec[] {
  return newestPerSlot().filter((m) => !m.ended);
}
/** Members the server ended (memberend.ts only: `botlink status`, the one-time line, revive). Never resolved. */
export function endedMembers(): MemberRec[] {
  return newestPerSlot().filter((m) => !!m.ended);
}
/** Other records of m's server, room and name (memberend.ts replaceEarlier only: a re-join takes them out). */
export function earlierRecords(m: MemberRec): MemberRec[] {
  return memberRecords().filter((x) => x.id !== m.id && slot(x) === slot(m));
}
/** The room pin a record of this room on this computer holds, ended ones too (an approval checks the room's genesis
 *  against what this computer saw before, also when the earlier membership was removed). */
export function roomPinOf(roomId: string): Pin | null {
  return memberRecords().find((m) => m.room?.id === roomId)?.pin ?? null;
}

// ------------------------------------------------------------------ pending join / claim requests
export interface RequestRec {
  /** the approval card's link (kept so a repeated join shows the same one) */
  approve_url?: string;
  id: string;
  /** create: a room draft this chat asked for (docs/protocol/room-drafts.md): no invite; `room` holds the proposed name
   *  and purpose (id empty) until a person confirms it; approve_url is the draft's /create/<id> link */
  kind: "join" | "claim" | "create";
  server: string;
  invite: string;
  name: string;
  job: string;
  app: App;
  app_name?: string | null;
  turn: Turn;
  session_id: string | null;
  folder: string;
  cwd: string;
  machine: string;
  key_id: string;
  key_backend: string;
  ed: string;
  x: string;
  fingerprint: string;
  match_code: string;
  approver_name: string;
  /** ENVELOPE §5.4: the account whose invite this request used (the request view's approver_account at create, before
   *  anyone could approve; a move: the member's own account). The approval must be that account's member_add. */
  invite_account?: string | null;
  /** display name of that person at create (for the takeover sentence) */
  invite_name?: string | null;
  /** who the request is addressed to now: invite_account, or the one person who took a join over (item 11) */
  approver_account?: string | null;
  room: { id: string; name: string; purpose: string };
  member_id?: string | null;
  /** claim (new machine): the member being moved */
  claim_member?: string | null;
  /** claim: "chat" (another chat on this computer, H1) or "machine" (a new computer) */
  move_to?: "chat" | "machine" | null;
  /** claim to a chat: the session that held the member when the move was asked (told when it loses it) */
  prev_session?: string | null;
  /** Cursor (H2): the chat that made the request (CURSOR_CONVERSATION_ID in its shell), when known */
  cursor_chat?: string | null;
  expires_at: string;
  /** how long the server gives this request (its expires_at minus its own clock when it answered), seconds */
  lifetime_s?: number | null;
  created_at: number;
  wake?: { via: "t3" | "opencode"; id: string } | null;
}

export function requestPath(id: string) {
  return p("requests", `${safeName(id)}.json`);
}
export function loadRequest(id: string): RequestRec | null {
  return readJson<RequestRec | null>(requestPath(id), null);
}
export function saveRequest(r: RequestRec) {
  writeJson(requestPath(r.id), r);
}
export function deleteRequest(id: string) {
  rmSync(requestPath(id), { force: true });
}
export function allRequests(): RequestRec[] {
  return listJson<RequestRec>(p("requests"));
}

// ------------------------------------------------------------------ ledger (processing -> shown)
export type LedgerState = "processing" | "shown";
const LEDGER_DAYS = 30;

function ledgerFile(member: string, msg: string) {
  return p("ledger", safeName(member), safeName(msg));
}
export function ledgerGet(member: string, msg: string): LedgerState | null {
  try {
    const s = readFileSync(ledgerFile(member, msg), "utf-8").trim();
    return s === "processing" || s === "shown" ? s : null;
  } catch {
    return null;
  }
}
export function ledgerSet(member: string, msg: string, s: LedgerState) {
  writeAtomic(ledgerFile(member, msg), s);
}
export function ledgerPrune(member: string, nowMs = Date.now()) {
  const d = p("ledger", safeName(member));
  try {
    for (const f of readdirSync(d)) {
      const fp = join(d, f);
      if (nowMs - statSync(fp).mtimeMs > LEDGER_DAYS * 86400_000) rmSync(fp, { force: true });
    }
  } catch {
    /* nothing yet */
  }
}

// ------------------------------------------------------------------ prompts (captured by the prompt hook)
// Privacy: only a chat that holds a bot-link member has its prompts kept, and only what the standing-rule check
// (rules.ts: a verbatim quote typed within the last 30 minutes) needs. A chat that is not a member stores nothing.
export interface PromptRec {
  at: number;
  text: string;
  /** the app + folder the chat ran in (lets prunePrompts re-check membership for folder-bound members) */
  app?: App;
  cwd?: string;
}
export const PROMPT_KEEP = 20;
export const PROMPT_TTL_MS = 30 * 60_000;
const PROMPT_MAX_CHARS = 20_000;

export function promptsFile(session: string) {
  return p("prompts", `${safeName(session)}.jsonl`);
}
/** Call only for a chat that holds a member (hooks.ts checks first). */
export function capturePrompt(session: string, text: string, nowMs = Date.now(), where: { app?: App; cwd?: string } = {}) {
  const keep = readPrompts(session, nowMs).slice(-(PROMPT_KEEP - 1));
  const rec: PromptRec = { at: nowMs, text: String(text).slice(0, PROMPT_MAX_CHARS) };
  if (where.app) rec.app = where.app;
  if (where.cwd) rec.cwd = where.cwd;
  keep.push(rec);
  writeAtomic(promptsFile(session), keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
function parsePrompts(raw: string, nowMs: number): PromptRec[] {
  const out: PromptRec[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (typeof r.at === "number" && typeof r.text === "string" && nowMs - r.at <= PROMPT_TTL_MS && r.at - nowMs <= PROMPT_TTL_MS) out.push(r);
    } catch {
      /* skip */
    }
  }
  return out.slice(-PROMPT_KEEP);
}
export function readPrompts(session: string, nowMs = Date.now()): PromptRec[] {
  try {
    return parsePrompts(readFileSync(promptsFile(session), "utf-8"), nowMs);
  } catch {
    return [];
  }
}
export function forgetPrompts(session: string) {
  try {
    rmSync(promptsFile(session), { force: true });
  } catch {
    /* unsafe name: nothing of ours */
  }
}
/**
 * Delete every stored prompt file whose chat no longer holds a member (or never did: files written by older versions
 * for every chat), and every file with nothing inside the window. Kept files are rewritten 0600 with expired lines
 * dropped. Runs at every hook / CLI start, so it is also the one-time upgrade migration.
 */
export function prunePrompts(isMember: (session: string, where: { app?: App; cwd?: string }) => boolean, nowMs = Date.now()) {
  const d = p("prompts");
  let names: string[];
  try {
    names = readdirSync(d);
  } catch {
    return; // nothing stored
  }
  try {
    chmodSync(d, 0o700);
  } catch {
    /* not ours */
  }
  for (const f of names) {
    const fp = join(d, f);
    try {
      const session = f.endsWith(".jsonl") ? f.slice(0, -6) : "";
      if (!session || !SAFE.test(session)) {
        // stray / temp files in our prompts dir: drop them (older than a minute, so an in-flight write is not raced)
        if (nowMs - statSync(fp).mtimeMs > 60_000) rmSync(fp, { force: true, recursive: true });
        continue;
      }
      const raw = readFileSync(fp, "utf-8");
      const recs = parsePrompts(raw, nowMs);
      const last = recs[recs.length - 1];
      if (!last || !isMember(session, { app: last.app, cwd: last.cwd })) {
        rmSync(fp, { force: true });
        continue;
      }
      const body = recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
      if (body !== raw) writeAtomic(fp, body);
      else chmodSync(fp, 0o600);
    } catch {
      try {
        rmSync(fp, { force: true }); // unreadable: prompts are disposable, privacy wins
      } catch {
        /* best effort */
      }
    }
  }
}

// ------------------------------------------------------------------ live markers + session links
export interface LiveRec {
  session: string;
  app: App;
  pid: number;
  cwd: string;
  at: number;
}
export function setLive(r: LiveRec) {
  // one live session per harness pid: a /clear or resume inside the same process retires the older marker
  for (const o of listJson<LiveRec>(p("live"))) if (o.pid === r.pid && o.session !== r.session) rmSync(p("live", `${safeName(o.session)}.json`), { force: true });
  writeJson(p("live", `${safeName(r.session)}.json`), r);
}
export function liveOf(session: string): LiveRec | null {
  const r = readJson<LiveRec | null>(p("live", `${safeName(session)}.json`), null);
  return r && pidAlive(r.pid) ? r : null;
}
export function clearLive(session: string) {
  rmSync(p("live", `${safeName(session)}.json`), { force: true });
}

export function appendLog(name: string, line: string) {
  try {
    ensureDir(p("logs"));
    appendFileSync(p("logs", name), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

export function exists(path: string) {
  return existsSync(path);
}

/** The display name an app gets on the dashboard when it isn't one bot-link knows by its roster app. */
export const KNOWN_APP_NAME: Partial<Record<App, string>> = { opencode: "OpenCode", t3: "T3 Code" };

/** app_name as the server accepts it: printable, one line, no fence markers, 1-40 characters (else null). */
export function cleanAppName(v: unknown): string | null {
  const s = String(v ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2069\u061c\ufeff]/g, " ")
    .replace(/<<<|>>>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = [...s].slice(0, 40).join("").trim();
  return cut ? cut : null;
}

// ------------------------------------------------------------------ wake markers (r3, listen lab recommendation #1)
/** How long after a nudge the chat's own inbox read still counts as "woken": a nudged turn starts within seconds; a
 *  queued nudge into a busy chat may take a little longer. */
export const WAKE_MARK_MS = Number(process.env.BOTLINK_WAKE_MARK_MS || 3 * 60_000);
const wakePath = (member: string) => p("wake", `${safeName(member)}.json`);

/** A listener (listen --once / --tmux / --via / --on-message, plain listen) just told this member's chat that messages
 *  wait: its next inbox read within WAKE_MARK_MS is the chat's own idle wake. */
// ------------------------------------------------------------------ a run with no human present is going on
/** watch and listeners write this while a run they started for a member is going (its pid): the member's reads in
 *  that time are "no human here" even when the app does not pass bot-link's environment on to its tools. */
const awayPath = (member: string) => p("away", `${safeName(member)}.json`);
export const AWAY_MAX_MS = 15 * 60_000;
export function markAway(member: string, pid: number, nowMs = Date.now()) {
  try {
    writeJson(awayPath(member), { pid, at: nowMs });
  } catch {
    /* best effort: the run's own environment says it too */
  }
}
export function clearAway(member: string, pid?: number) {
  const r = readJson<{ pid?: number } | null>(awayPath(member), null);
  if (!pid || !r || r.pid === pid) rmSync(awayPath(member), { force: true });
}
export function awayLive(member: string, nowMs = Date.now()): boolean {
  const r = readJson<{ pid?: number; at?: number } | null>(awayPath(member), null);
  return !!r && typeof r.pid === "number" && typeof r.at === "number" && nowMs - r.at >= 0 && nowMs - r.at < AWAY_MAX_MS && pidAlive(r.pid);
}

export function markWake(member: string, how: string, nowMs = Date.now()) {
  try {
    writeJson(wakePath(member), { at: nowMs, how });
  } catch {
    /* best effort: without it the read simply counts as a turn */
  }
  markSignal(member, nowMs);
}

// ------------------------------------------------------------------ is a human here? (perms.ts: the hold)
/** Something told this member's chat that messages wait (a wait, a listener, an event, watch's nudge): the read that
 *  follows was not started by a person. Written on EVERY signal (the wake marker above is not: it is about what a
 *  wake test may claim), used up by the next read. */
const signalPath = (member: string) => p("signal", `${safeName(member)}.json`);
export const SIGNAL_MS = Number(process.env.BOTLINK_SIGNAL_MS || 10 * 60_000);
export function markSignal(member: string, nowMs = Date.now()) {
  try {
    writeJson(signalPath(member), { at: nowMs });
  } catch {
    /* best effort */
  }
}
export function signalFresh(member: string, nowMs = Date.now()): boolean {
  const r = readJson<{ at?: number } | null>(signalPath(member), null);
  return !!r && typeof r.at === "number" && nowMs - r.at >= 0 && nowMs - r.at <= SIGNAL_MS;
}
export function clearSignal(member: string) {
  rmSync(signalPath(member), { force: true });
}

/** Whose turn it is in a chat, as its app's hooks saw it: the prompt hook sets "a person typed" (never for a line a
 *  listener typed or a wake prompt), the stop hook ends it. `prompts`: this app tells bot-link about prompts at all
 *  (Claude Code, Codex); without that, a turn's end says nothing about the next one. */
interface TurnRec {
  human: boolean;
  prompts: boolean;
  at: number;
}
const turnPath = (session: string) => p("turn", `${safeName(session)}.json`);
export const HUMAN_TURN_MAX_MS = Number(process.env.BOTLINK_HUMAN_TURN_MAX_MS || 60 * 60_000);
export function setTurn(session: string | null, human: boolean, fromPrompt = false) {
  if (!session) return;
  try {
    const cur = readJson<TurnRec | null>(turnPath(session), null);
    writeJson(turnPath(session), { human, prompts: fromPrompt || !!cur?.prompts, at: Date.now() } satisfies TurnRec);
  } catch {
    /* best effort */
  }
}
/** "human": a person started the turn this chat is in. "none": the last turn a person started has ended, and nothing
 *  says a person started this one. null: this app's hooks don't tell (no prompt hook has run in this chat). */
export function turnState(session: string | null): "human" | "none" | null {
  if (!session) return null;
  const r = readJson<TurnRec | null>(turnPath(session), null);
  if (!r) return null;
  // (a turn whose end the stop hook never reported doesn't vouch for a person for ever)
  if (r.human) return Date.now() - r.at <= HUMAN_TURN_MAX_MS ? "human" : null;
  return r.prompts ? "none" : null;
}

export const WAKE_MARK_WAIT_MS = Number(process.env.BOTLINK_WAKE_MARK_WAIT_MS || 90_000);
const WAIT_MARKS = new Set(["wait", "wait-held", "listen-once", "listen-print"]);
/** The raw name of the marker a wake left ("wait", "wait-held", "listen-once", "listen", "events", …), or null. */
export function wakeMarkRaw(member: string): string | null {
  const r = readJson<{ how?: string } | null>(wakePath(member), null);
  return typeof r?.how === "string" && r.how ? r.how : null;
}
/** Was the last wake a `wait` this chat started itself (not a listener, a hook, an event)? */
export const waitMark = (member: string) => WAIT_MARKS.has(String(wakeMarkRaw(member)));

/** A wake that went unanswered: something told this member's chat that messages wait, and the chat read nothing for
 *  longer than `olderThanMs` (the marker is still there). null: no such wake. */
export function staleWake(member: string, olderThanMs: number, nowMs = Date.now()): { at: number; how: string | null } | null {
  const r = readJson<{ at?: number; how?: string } | null>(wakePath(member), null);
  if (!r || typeof r.at !== "number" || nowMs - r.at < olderThanMs) return null;
  return { at: r.at, how: typeof r.how === "string" ? WAKE_HOW[r.how] || r.how : null };
}
export function clearWake(member: string) {
  rmSync(wakePath(member), { force: true });
}

/** What nudged this member's chat last (the marker a listener left): "wait", "a listener", …; null when none. */
export function wakeMarkHow(member: string): string | null {
  const r = readJson<{ how?: string } | null>(wakePath(member), null);
  const how = typeof r?.how === "string" ? r.how : "";
  return how ? WAKE_HOW[how] || how : null;
}
const WAKE_HOW: Record<string, string> = { wait: "`wait`", "wait-held": "`wait --max-s`, held in a turn", "listen-once": "`listen --once`", listen: "a listener", "listen-print": "a `listen` this chat ran itself", tmux: "a tmux nudge", "codex-queue": "codex queue", "on-message": "a listener command", events: "an event from bot-link's server", "watch-queue": "bot-link watch" };

/** Is a nudge still unanswered: a listener marked a wake and the chat hasn't read its inbox since (the read consumes
 *  the marker)? The listener uses it to tell a working nudge (`codex queue`, a tmux nudge: the command exits at once and
 *  the chat reads seconds later) from a wake path that does nothing (real run 2026-11-07: counting every nudge as a
 *  failure doubled the gap to 160 s during a normal conversation). */
export function wakeMarkPending(member: string): boolean {
  return existsSync(wakePath(member));
}

/** Was this member's chat nudged within WAKE_MARK_MS? (consume: the marker counts for one read only) */
export function wokenByMark(member: string, consume = false, nowMs = Date.now()): boolean {
  const r = readJson<{ at?: number; how?: string } | null>(wakePath(member), null);
  // a `wait` the chat started itself: the chat reads within seconds when it really got a turn; a human who types
  // minutes later must not count as that wake (review 2026-11-10). A listener's nudge keeps the longer window (a
  // tmux nudge waits for the pane to be idle).
  const window = r && WAIT_MARKS.has(String(r.how)) ? WAKE_MARK_WAIT_MS : WAKE_MARK_MS;
  const fresh = !!r && typeof r.at === "number" && nowMs - r.at >= 0 && nowMs - r.at <= window;
  if (consume && r) rmSync(wakePath(member), { force: true });
  return fresh;
}
