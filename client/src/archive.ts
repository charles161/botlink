/**
 * This chat's own history of a room, kept on this computer for room reports (SPEC §7.1, §7.3c).
 *
 *   archive/<member>/in-<msg id>.json    a message this chat received, exactly as it came (sealed to this member's key,
 *                                        signed by its sender): its signature can be checked again later
 *   archive/<member>/out-<msg id>.json   a message this chat sent: the signed copies as they left (each sealed to its
 *                                        recipient, so this chat can't open them again) plus this chat's own copy of
 *                                        the text, sealed to this member's own key (like the hold, SPEC §7.3a)
 *   archive/<member>/since.json          when this computer started keeping this member's history
 *
 * Dirs 0700, files 0600, atomic writes. Kept `historyDays()` days, pruned on write. Messages of a member this chat
 * muted are never kept. Nothing here ever throws into the send or read path: the history is best effort.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import * as c from "./crypto.js";
import * as st from "./state.js";
import { permsOf } from "./perms.js";
import { peekHeader, type Envelope, type Header } from "./envelope.js";

/** How many days of history this chat keeps: what the server last said for this person's plan (`plan.history_days`
 *  in GET /api/v1/me, kept in config.json by setHistoryDays), else 7. Always 1 to 90. */
export const DEFAULT_HISTORY_DAYS = 7;
export const MAX_HISTORY_DAYS = 90;
const clampDays = (v: number) => Math.max(1, Math.min(MAX_HISTORY_DAYS, Math.floor(v)));
export function historyDays(): number {
  const v = Number((st.loadConfig() as Record<string, unknown>).history_days);
  return Number.isFinite(v) && v >= 1 ? clampDays(v) : DEFAULT_HISTORY_DAYS;
}
/** Keep the server's `plan.history_days` (clamped to 1..90). Anything that is not a number keeps the last value.
 *  Never throws. Returns true when it changed. */
export function setHistoryDays(v: unknown): boolean {
  try {
    if (v === null || v === undefined || v === "" || typeof v === "boolean") return false;
    const n = Number(v);
    if (!Number.isFinite(n)) return false;
    const d = clampDays(n);
    const cfg = st.loadConfig() as Record<string, unknown>;
    if (cfg.history_days === d) return false;
    st.saveConfig({ ...cfg, history_days: d } as st.LocalConfig);
    return true;
  } catch {
    return false;
  }
}

export interface ArchIn {
  v: 1;
  dir: "in";
  member: string;
  room: string;
  id: string;
  /** when this chat got it (ms, this computer's clock) */
  at: number;
  envelope: Envelope;
  /** this chat's client refused it when it came (the reason then); kept so a report lists it */
  refused?: string;
}

export interface SentCopy {
  to_member: string;
  to_fp: string;
  envelope: Envelope;
}

export interface ArchOut {
  v: 1;
  dir: "out";
  member: string;
  room: string;
  id: string;
  at: number;
  scope: "member" | "room";
  envelopes: SentCopy[];
  /** OwnCopy as JSON, sealed to this member's own key */
  own: string;
}

export type ArchRec = ArchIn | ArchOut;

/** What this chat keeps of its own message (it can't open the copies it sealed to the recipients). */
export interface OwnCopy {
  text: string;
  intent: string;
  in_reply_to: string | null;
  needed_by: number | null;
  /** the message this one re-sends (its plaintext resend_of), when it is a re-send */
  resend_of?: string | null;
  /** a signed note this chat sent (yesnote.ts: a yes or an allow), when the message carried one */
  note?: unknown;
}

export const archiveDir = (member: string) => st.p("archive", st.safeName(member));
const file = (member: string, dir: "in" | "out", id: string) => join(archiveDir(member), `${dir}-${st.safeName(id)}.json`);
const MAX_REC = 2 * 1024 * 1024;

function markSince(member: string, nowMs: number) {
  const f = join(archiveDir(member), "since.json");
  if (!st.exists(f)) st.writeJson(f, { at: nowMs });
}

/** When this computer started keeping this member's history (ms), or null. */
export function keptSince(member: string): number | null {
  const r = st.readJson<{ at?: number } | null>(join(archiveDir(member), "since.json"), null);
  return r && typeof r.at === "number" ? r.at : null;
}

const muted = (member: string, from: string) => permsOf(member)[from]?.level === "muted";

/** Keep a message this chat received, as it came. `refused`: the client did not accept it (why). Never throws. */
export function recordReceived(m: { id: string; room: { id: string } }, env: Envelope, refused?: string, nowMs = Date.now()): boolean {
  try {
    if (!env || env.v !== 3 || typeof env.h !== "string" || typeof env.ct !== "string" || typeof env.sig !== "string") return false;
    let h: Header;
    try {
      h = peekHeader(env);
    } catch {
      return false; // not even a header: nothing a report could say about it
    }
    if (h.room !== m.room.id || h.to !== m.id || h.scope === "self") return false;
    if (muted(m.id, h.from)) return false;
    const f = file(m.id, "in", h.id);
    if (st.exists(f)) return false;
    const rec: ArchIn = { v: 1, dir: "in", member: m.id, room: m.room.id, id: h.id, at: nowMs, envelope: { v: 3, h: env.h, ct: env.ct, sig: env.sig }, ...(refused ? { refused: String(refused).slice(0, 200) } : {}) };
    const body = JSON.stringify(rec);
    if (body.length > MAX_REC) return false;
    markSince(m.id, nowMs);
    st.writeAtomic(f, body + "\n");
    prune(m.id, nowMs);
    return true;
  } catch {
    return false;
  }
}

/** Keep a message this chat sent: the request body as it went out, and its own copy of the text sealed to `xPk`
 *  (this member's own key, or a function that reads it). Never throws. */
export function recordSent(m: { id: string; room: { id: string } }, xPk: string | (() => string), id: string, body: string, own: OwnCopy, nowMs = Date.now()): boolean {
  try {
    const pk = typeof xPk === "function" ? xPk() : xPk;
    const req = JSON.parse(body);
    const envs: SentCopy[] = (Array.isArray(req?.envelopes) ? req.envelopes : []).filter((e: any) => e && typeof e.to_member === "string" && e.envelope).map((e: any) => ({ to_member: e.to_member, to_fp: String(e.to_fp || ""), envelope: e.envelope }));
    if (!envs.length) return false;
    const plain: OwnCopy = { text: String(own.text ?? ""), intent: String(own.intent ?? ""), in_reply_to: own.in_reply_to ?? null, needed_by: own.needed_by ?? null, ...(own.resend_of ? { resend_of: own.resend_of } : {}), ...(own.note !== undefined ? { note: own.note } : {}) };
    const rec: ArchOut = { v: 1, dir: "out", member: m.id, room: m.room.id, id, at: nowMs, scope: req.scope === "room" ? "room" : "member", envelopes: envs, own: c.seal(Buffer.from(JSON.stringify(plain), "utf-8"), pk) };
    const out = JSON.stringify(rec);
    if (out.length > 8 * MAX_REC) return false;
    markSince(m.id, nowMs);
    st.writeAtomic(file(m.id, "out", id), out + "\n");
    prune(m.id, nowMs);
    return true;
  } catch {
    return false;
  }
}

/** Open this chat's own copy of a message it sent (null: sealed to a key this member no longer has). */
export function openOwn(rec: ArchOut, xSk: string): OwnCopy | null {
  try {
    const o = JSON.parse(Buffer.from(c.openSealedBytes(Buffer.from(rec.own, "base64"), xSk)).toString("utf-8"));
    return o && typeof o.text === "string" ? o : null;
  } catch {
    return null;
  }
}

const lastPrune = new Map<string, number>();
/** Delete what is older than the history window: this member's, and that of every other member this computer kept
 *  history for (one that left or moved away is never written again, so its history would otherwise stay). At most
 *  once a minute per member per process (called on write). */
export function prune(member: string, nowMs = Date.now(), force = false) {
  if (!force && nowMs - (lastPrune.get(member) || 0) < 60_000) return;
  lastPrune.set(member, nowMs);
  const keep = historyDays() * 86400_000;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(st.p("archive"));
  } catch {
    return;
  }
  for (const who of dirs) {
    const d = join(st.p("archive"), who);
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    let left = 0;
    for (const f of names) {
      if (!/^(in|out)-.+\.json$/.test(f)) continue;
      try {
        if (nowMs - statSync(join(d, f)).mtimeMs > keep) rmSync(join(d, f), { force: true });
        else left++;
      } catch {
        /* gone meanwhile */
      }
    }
    // a member no longer on this computer with nothing left: its folder goes too
    try {
      if (!left && who !== member && !st.exists(st.memberPath(who))) rmSync(d, { recursive: true, force: true });
    } catch {
      /* not a name of ours, or gone meanwhile */
    }
  }
}

/** This member's kept messages whose `at` is in [fromMs, toMs], muted members left out. Malformed files are skipped. */
export function listArchive(member: string, fromMs: number, toMs: number): ArchRec[] {
  const d = archiveDir(member);
  let names: string[] = [];
  try {
    names = readdirSync(d);
  } catch {
    return [];
  }
  const mutedNow = new Set(Object.entries(permsOf(member)).filter(([, v]) => v.level === "muted").map(([k]) => k));
  const out: ArchRec[] = [];
  for (const f of names.sort()) {
    if (!/^(in|out)-.+\.json$/.test(f)) continue;
    const r = st.readJson<ArchRec | null>(join(d, f), null);
    if (!r || r.v !== 1 || r.member !== member || typeof r.at !== "number" || r.at < fromMs || r.at > toMs) continue;
    if (r.dir === "in") {
      if (!r.envelope || typeof r.envelope.h !== "string") continue;
      // a member muted since this was kept: left out of every report too
      try {
        if (mutedNow.has(peekHeader(r.envelope).from)) continue;
      } catch {
        /* unreadable header: listed as could not be checked */
      }
    } else if (r.dir !== "out" || !Array.isArray(r.envelopes) || typeof r.own !== "string") continue;
    out.push(r);
  }
  return out;
}
