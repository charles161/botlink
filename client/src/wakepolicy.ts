/**
 * Held while away, on the server too (lane F; SPEC §6.9 "Held while away", §7.3a).
 *
 * This client never shows another person's message to a chat while no human is with it (perms.ts: it is held for the
 * human), and never shows a muted member's message at all. The server used to wake the chat for those messages anyway:
 * one model turn each time, on the recipient's account, for nothing. So this client tells the server:
 *
 *   - its wake policy: "other people's chats do not wake me, except these members" (the ones the human let through
 *     `while away`). PUT /api/v1/me/wake-policy, signed and idempotent: after join, after an update (a new copy has no
 *     record yet), whenever a setting changes, and once a day. A server without the route (404) is left alone for 6
 *     hours; a failed call is tried again later with a growing pause. Nothing here ever fails a send or a read.
 *   - a mute: PUT /api/v1/me/mutes/{member}, when this chat's human (or the chat: less is always allowed) sets a member
 *     of another person to `muted`. The server's rule: a chat may mute, only the person un-mutes, on the room page.
 *
 * What the wake used to do now happens without it: the sender's send answer lists the recipients that were not woken
 * (never because of a mute), and this module says so to the sender once per recipient per 10 minutes; the recipient's
 * person gets the dashboard item from the server. The client's own hold stays as the fallback (an old server, a
 * message that woke the chat anyway); `serverTold` keeps it from telling a sender twice.
 *
 * BOTLINK_NO_WAKE_POLICY=1: declare nothing (and take back a policy this member declared before): today's behaviour.
 */
import { createHash } from "node:crypto";

import * as st from "./state.js";
import * as perms from "./perms.js";
import { Api, ApiError, type Signer } from "./api.js";

const V = 1;
const DAY_MS = 86400_000;
const OLD_SERVER_MS = 6 * 3600_000;
const NOTICE_GAP_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Rec {
  /** the member key the policy was declared with (a move to another chat gives a new key: declare again) */
  key_id?: string;
  /** what the server last accepted (a hash of the request) and when */
  sent?: string;
  ok_at?: number;
  /** as the server answered it */
  hold?: boolean;
  except?: string[];
  /** since when the server holds for this key (server time, ms) */
  since?: number;
  fail_at?: number;
  fails?: number;
  /** the server has no such route (404): an older server */
  old_server_at?: number;
  /** mutes this client asked the server for: sent, still to send, or refused (the person's own chat, gone, an old server) */
  mutes?: Record<string, "sent" | "pending" | "refused">;
}

export interface Who {
  m: st.MemberRec;
  api: Api;
  signer: Signer;
  session: string | null;
}

const file = (member: string) => st.p("wakepolicy", `${st.safeName(member)}.json`);
const toldFile = (member: string) => st.p("wakepolicy", `${st.safeName(member)}.told.json`);
const load = (member: string): Rec => {
  const r = st.readJson<Rec>(file(member), {});
  return r && typeof r === "object" ? r : {};
};
const save = (member: string, r: Rec) => st.writeJson(file(member), r);
const off = () => process.env.BOTLINK_NO_WAKE_POLICY === "1";

/** The members this chat's human let through while away (another person's chats only; a muted one never). */
export function exceptOf(member: string): string[] {
  return Object.entries(perms.permsOf(member))
    .filter(([id, r]) => r.while_away === true && r.level !== "muted" && UUID.test(id))
    .map(([id]) => id)
    .sort();
}

function wanted(m: st.MemberRec) {
  return off() ? { hold_others: false, except: [] as string[] } : { hold_others: true, except: exceptOf(m.id) };
}
const hashOf = (m: st.MemberRec, w: ReturnType<typeof wanted>) =>
  createHash("sha256").update(JSON.stringify({ v: V, server: m.server, key: m.key_id, ...w })).digest("hex").slice(0, 32);
const pauseMs = (fails: number) => Math.min(3600_000, 30_000 * 2 ** Math.max(0, fails - 1));
const noRoute = (e: unknown) => e instanceof ApiError && e.status === 404;

async function sendMutes(w: Who, rec: Rec) {
  for (const [id, state] of Object.entries(rec.mutes || {})) {
    if (state !== "pending" || !UUID.test(id)) continue;
    try {
      await w.api.call({ method: "PUT", path: `/api/v1/me/mutes/${id}`, signer: w.signer, session: w.session, timeoutMs: 5000, retryForMs: 0 });
      rec.mutes![id] = "sent";
    } catch (e) {
      // gone from the room, the person's own chat, or a server without mutes: nothing to retry
      if (e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 410)) rec.mutes![id] = "refused";
    }
  }
}

/** Tell the server this member's wake policy (and any mute still to send) when it is due. Never throws. */
export async function ensure(w: Who, o: { force?: boolean } = {}): Promise<void> {
  try {
    const { m } = w;
    let rec = load(m.id);
    if (rec.key_id && rec.key_id !== m.key_id) rec = { mutes: rec.mutes }; // a new key: the old declaration is not its
    // a member muted on this computer before this client told the server about mutes (an earlier version)
    for (const [id, r] of Object.entries(perms.permsOf(m.id))) if (r.level === "muted" && UUID.test(id) && !rec.mutes?.[id]) (rec.mutes = rec.mutes || {})[id] = "pending";
    const pending = Object.values(rec.mutes || {}).includes("pending");
    if (pending) {
      await sendMutes(w, rec);
      save(m.id, rec);
    }
    const want = wanted(m);
    if (off() && !rec.hold) return; // never declared (or already taken back): nothing to undo
    const hash = hashOf(m, want);
    const now = Date.now();
    if (rec.sent === hash && rec.key_id === m.key_id && now - (rec.ok_at || 0) < DAY_MS) return;
    if (!o.force && rec.old_server_at && now - rec.old_server_at < OLD_SERVER_MS) return;
    if (!o.force && rec.fail_at && now - rec.fail_at < pauseMs(rec.fails || 1)) return;
    try {
      const r = (await w.api.call<any>({ method: "PUT", path: "/api/v1/me/wake-policy", body: want, signer: w.signer, session: w.session, timeoutMs: 5000, retryForMs: 0 })).json || {};
      const since = Date.parse(String(r.since || ""));
      rec = { ...rec, key_id: m.key_id, sent: hash, ok_at: now, hold: r.hold_others === true, except: Array.isArray(r.except) ? r.except.filter((x: unknown) => typeof x === "string") : want.except, since: Number.isFinite(since) ? since : undefined, fail_at: undefined, fails: 0, old_server_at: undefined };
    } catch (e) {
      if (noRoute(e)) rec = { ...rec, key_id: m.key_id, old_server_at: now, hold: false, since: undefined };
      else rec = { ...rec, key_id: m.key_id, fail_at: now, fails: (rec.fails || 0) + 1 };
    }
    save(m.id, rec);
  } catch {
    /* best effort: the client's own hold still applies */
  }
}

/** Did the server already report this held message to its sender (and put the item on the dashboard)? Then the
 *  client does not send its own automatic reply for it. The lease's `wake_held` says it exactly; a server without it:
 *  a copy made after the server held for this key, from a member not let through, and not an answer to this chat's
 *  own message (that one still wakes it). */
export function serverTold(m: st.MemberRec, d: { created_at?: unknown; from: string; ownReply?: boolean; wake_held?: unknown }): boolean {
  // the server says it per leased copy (wake_held): exact. Only a server without it leaves this client to work it out.
  if (typeof d.wake_held === "boolean") return d.wake_held;
  if (off()) return false;
  const rec = load(m.id);
  if (!rec.hold || !rec.since || rec.key_id !== m.key_id) return false;
  const at = Date.parse(String(d.created_at || ""));
  if (!Number.isFinite(at) || at < rec.since) return false;
  if ((rec.except || []).includes(d.from) || d.ownReply) return false;
  return true;
}

/** The sender's side: which recipients were not woken because they hold other people's messages, in plain words,
 *  once per recipient per 10 minutes. `who` names a member id from the signed member list. */
export function notWokenNote(m: st.MemberRec, ids: unknown, who: (id: string) => { name: string; person: string } | null): string {
  if (!Array.isArray(ids) || !ids.length) return "";
  try {
    const told = st.readJson<Record<string, number>>(toldFile(m.id), {});
    const now = Date.now();
    const lines: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || !UUID.test(id) || now - (told[id] || 0) < NOTICE_GAP_MS) continue;
      const x = who(id);
      if (!x) continue;
      lines.push(`${x.name} is not woken by other people's chats. It sees this when ${x.person || "its human"} next uses it.`);
      told[id] = now;
    }
    if (lines.length) st.writeJson(toldFile(m.id), told);
    return lines.join("\n");
  } catch {
    return "";
  }
}

/** `send` with a wait (the tool's wait_s, the CLI's --wait-s) when the message woke none of its recipients: no answer
 *  can come in this turn, so the call returns at once with this line instead of sitting there. */
export function noWaitLine(who: { name: string; person: string }[]): string {
  const names = who.map((x) => x.name).join(", ");
  const people = [...new Set(who.map((x) => x.person || "its human"))].join(" or ");
  return `bot-link: not waiting for an answer: ${names} ${who.length === 1 ? "is" : "are"} not woken by other people's chats, so ${who.length === 1 ? "it sees" : "they see"} this message when ${people} next ${who.length === 1 && !people.includes(" or ") ? "uses it" : "uses them"}. The answer will arrive in this chat after that.`;
}

/** After a setting changed (perms.ts): a new mute goes to the server; raising a member the server has muted says that
 *  waking stays off until the person un-mutes it on the room page (the server's rule; not weakened here); the policy
 *  is declared again. -> words to add to the answer ("" for none). Never throws. */
export async function afterSetting(w: Who, sender: { id: string; name: string; account: string }, level: perms.Level, before: perms.Level): Promise<string> {
  const { m } = w;
  const person = m.person_name || "your human";
  let note = "";
  try {
    if (sender.account === m.account && level === "muted" && UUID.test(sender.id)) {
      // the person's own chat: a local setting only (the server refuses to mute it), never sent
      const rec = load(m.id);
      (rec.mutes = rec.mutes || {})[sender.id] = "refused";
      save(m.id, rec);
    } else if (sender.account !== m.account && UUID.test(sender.id)) {
      const rec = load(m.id);
      rec.mutes = rec.mutes || {};
      if (level === "muted" && before !== "muted") {
        rec.mutes[sender.id] = "pending";
        save(m.id, rec);
        await sendMutes(w, rec);
        save(m.id, rec);
        note = rec.mutes[sender.id] === "sent"
          ? ` It also no longer wakes ${person}'s chats; only ${person} can turn that back on, on the room page.`
          : rec.mutes[sender.id] === "pending" ? ` bot-link could not yet tell the server to stop it waking this chat; it tries again with the next bot-link call.` : "";
      } else if (level !== "muted" && before === "muted") {
        let muted = rec.mutes[sender.id] === "sent";
        if (rec.mutes[sender.id] !== "sent") delete rec.mutes[sender.id];
        try {
          const r = (await w.api.call<any>({ method: "GET", path: "/api/v1/me/mutes", signer: w.signer, session: w.session, timeoutMs: 5000, retryForMs: 0 })).json;
          if (Array.isArray(r?.mutes)) muted = r.mutes.some((x: any) => x?.member_id === sender.id);
        } catch {
          /* keep what this computer knows */
        }
        if (!muted) delete rec.mutes[sender.id];
        save(m.id, rec);
        if (muted) note = ` Its messages still do not wake ${person}'s chats until ${person} un-mutes ${sender.name} on the room page; until then they show up at this chat's next turn.`;
      }
    }
  } catch {
    /* the setting itself is saved either way */
  }
  await ensure(w, { force: true });
  return note;
}
