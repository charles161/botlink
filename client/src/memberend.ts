/**
 * "This member is gone or not yours" is final (fix-all CLIENTGLUE 8; prod 16 Nov 2026: a client asked /me/wait about
 * every 10 s and got 403, 457 times in a few hours), but only when bot-link's server itself said so: its own JSON
 * error shape ({"error": {"code", "message"}}, api.ts `shaped`) with a final code at its status. Anything else in the
 * 4xx range (a Cloudflare block or challenge page, a firewall, a captive portal, a proxy, a code this client does
 * not know) is "the server could not be reached properly": back off and keep trying, and after it has lasted
 * BOTLINK_REFUSED_TELL_MS (10 min) tell the chat once that something on the way refuses it (noteRefused).
 *
 * What bot-link's server answers on the wait, inbox, send and roster paths (server/internal/agentapi, read 16 Nov):
 *   410 gone              the member was removed (loadMemberByKey, inbox.go)            FINAL for the member
 *   410 room_gone         the room was deleted                                          FINAL for the member
 *   401 unknown_key       no member row has this key at all (moved: new key elsewhere)   FINAL for the member
 *   403 not_holder        another chat (session) holds the member (auth.go authHeld)     FINAL for this chat
 *   409 not_holder        the same, from requireHolder / the wait itself                 FINAL for this chat
 *   401 bad_signature     malformed headers or a signature over another host/path: a
 *                         client bug or something rewriting the request, not the key     transient (told after a while)
 *   401 stale_timestamp   this computer's clock is more than 60 s off (checked BEFORE
 *                         the signature, with server_time): api.ts corrects once         transient (the clock sentence)
 *   401 replayed          a nonce used twice (a retry of the very same bytes)            transient
 *   403 not_member        send into a room this member is not in                         final for that request only
 *   403 forbidden         someone else's join request                                    final for that request only
 *   404 not_found         a route or an object the server doesn't have                   final for that request only
 *   409 superseded / recipients_changed / storage_full / server_full / plan_limit        that request only
 *   429 rate_limited / too_many_polls / mailbox_full / quota_exceeded                    transient
 * Not final either: 426 too old (the update path, tooold.ts), 503 high_load (back off as told), other 5xx and
 * network errors (back off, the pause growing, capped, with jitter).
 *
 * On a final answer every loop that waits or polls for the member (listen, watch, the wait tool and `botlink wait`,
 * the Stop waiter, send's wait for an answer) stops for it and does not start again: its wake path is put aside, a
 * listener exits 4 (its supervisor never restarts that), watch stops waking it. The local record is marked
 * (`ended`), never deleted, so `botlink status` shows what happened, and the chat that held it is told once. A key
 * change on this computer (a move to another chat here, critical fix H1) is not an end. A wrong mark is undone by the
 * next inbox, status or listen of that chat (revive): the server is asked once, and if it takes the key the member is
 * back with its wake path.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";

import { ApiError } from "./api.js";
import * as st from "./state.js";
import { deleteSecrets, type Backend } from "./secrets.js";
import { permsOf, setPerm } from "./perms.js";
import { rulesOf } from "./rules.js";

const FINAL: Record<string, number[]> = { gone: [410], room_gone: [410], unknown_key: [401], not_holder: [403, 409] };
/** Every code bot-link's server sends on a member's calls (above): an unknown one is not taken as the server's word. */
const KNOWN = new Set([...Object.keys(FINAL), "bad_signature", "stale_timestamp", "replayed", "not_member", "forbidden", "own_member", "claim_needs_approval",
  "not_found", "bad_request", "superseded", "recipients_changed", "storage_full", "server_full", "plan_limit", "holder_changed", "id_conflict", "key_in_use",
  "name_taken", "join_pending", "already_member", "room_full", "rate_limited", "too_many_polls", "mailbox_full", "quota_exceeded", "too_large", "no_recipients", "invite_invalid",
  "member_not_found", "sends_refused", "too_many_subscriptions"]);

/** bot-link's server itself said this member is gone, or not this chat's. */
export function isFinal(e: unknown): e is ApiError {
  return e instanceof ApiError && e.shaped && (FINAL[e.code] || []).includes(e.status);
}

/** A 4xx that is not bot-link's server answering (not its error shape, or a code it never sends): something between
 *  this computer and the server refuses the request. */
export function isRefusedOnTheWay(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && (!e.shaped || !KNOWN.has(e.code));
}

/** The plain sentence for a request refused on the way (core.explain). */
export const refusedText = (status: number) =>
  `Something between this computer and bot-link's server refused the request (status ${status}): a proxy, a firewall or a network sign-in page, not bot-link. Nothing was changed. Try again later, and tell your human if it lasts.`;

const ago = (s: number) => (s >= 5400 ? `${Math.round(s / 3600)} hours` : s >= 90 ? `${Math.round(s / 60)} minutes` : `${s} seconds`);
/** 401 stale_timestamp: this computer's clock (core.explain). */
export function clockText(e: ApiError): string {
  const off = e.serverTime ? Math.abs(e.serverTime - Math.floor(Date.now() / 1000)) : 0;
  return `This computer's clock is off${off ? ` by about ${ago(off)}` : ""} from bot-link's server, so the server did not take the request. bot-link corrects for it and keeps trying; to fix it for good, turn on automatic time on this computer. Nothing is wrong with the membership.`;
}

// ------------------------------------------------------------------ refused on the way, for a while: told once
const refusedFile = (id: string) => st.p("refused", `${st.safeName(id)}.json`);
const tellAfterMs = () => Number(process.env.BOTLINK_REFUSED_TELL_MS || 10 * 60_000);

/** A loop's call for m was refused on the way (or kept failing bad_signature). -> the sentence, once, after a while. */
export function noteRefused(m: st.MemberRec, e: ApiError): string | null {
  const status = e.status, code = e.code;
  try {
    const r = st.readJson<{ since: number; told?: boolean } | null>(refusedFile(m.id), null);
    if (!r) {
      st.writeJson(refusedFile(m.id), { since: Date.now() });
      return null;
    }
    if (r.told || Date.now() - r.since < tellAfterMs()) return null;
    st.writeJson(refusedFile(m.id), { ...r, told: true });
    const mins = Math.max(1, Math.round((Date.now() - r.since) / 60_000));
    const what = code !== "bad_signature" ? `Something between this computer and bot-link's server is refusing its requests (status ${status})` : `bot-link's server has not accepted this chat's signed requests (${code})`;
    const text = `${what} for about ${mins} minute${mins === 1 ? "" : "s"}, so nothing reaches ${m.name} in #${m.room.name} right now. ${m.name} is still a member; bot-link keeps trying by itself. Tell your human: a proxy, a firewall or a network sign-in page may be in the way.`;
    if (m.holder_session) st.markLost(m.holder_session, { member: m.id, name: m.name, room: m.room.name, person: m.person_name, at: Date.now(), text });
    return text;
  } catch {
    return null;
  }
}
/** A loop's call for m got through: a refusal before it is over. */
export function noteReached(m: { id: string }) {
  try {
    if (existsSync(refusedFile(m.id))) rmSync(refusedFile(m.id), { force: true });
  } catch {
    /* best effort */
  }
}
/** Worth counting towards "refused for a while" (noteRefused). */
export const refusedKind = (e: unknown): e is ApiError => isRefusedOnTheWay(e) || (e instanceof ApiError && e.code === "bad_signature");

/** The sentence for a member that ended this way (shown to the chat once, kept on the record, in `botlink status`). */
export function endText(m: { name: string; room: { name: string }; person_name?: string }, code: string): string {
  const who = m.person_name || "your human";
  const why = code === "gone" ? "it was removed from the room"
    : code === "room_gone" ? "the room was deleted"
    : code === "not_holder" ? "another chat holds it now"
    : "the server no longer accepts its key (it was removed, its key was replaced, or the browser or account behind it was removed)";
  const next = code === "room_gone" ? `${who} can make a new room and invite this chat.`
    : code === "not_holder" ? `If this chat should be ${m.name} again, ${who} says "use bot-link as ${m.name}" here and approves the move in the browser.`
    : `If this chat should take part again, ${who} gives it a new invite; the room page shows who is in the room.`;
  return `${m.name} is no longer a member of #${m.room.name}: ${why}. Nothing is being received for it. Stop acting as ${m.name}. ${next}`;
}

/**
 * Record a final answer for member m, as the loop knew it (key and holder it used). Returns the sentence, or null when
 * the local record changed meanwhile (moved to another chat on this computer: not an end) or is gone.
 */
export function endMember(m: st.MemberRec, e: ApiError): string | null {
  const cur = st.loadMember(m.id);
  if (!cur || cur.key_id !== m.key_id) return null;
  const code = e.code === "room_gone" || e.code === "gone" || e.code === "not_holder" ? e.code : e.status === 410 ? "gone" : e.status === 403 ? "not_holder" : "unknown_key";
  const text = endText(cur, code);
  if (!cur.ended) {
    // the wake paths are put aside (not lost): a wrong mark is undone with them (revive)
    const wake = st.readJson<unknown>(st.p("wakepath", `${st.safeName(cur.id)}.json`), null);
    const events = st.readJson<unknown>(st.p("wakepath", `${st.safeName(cur.id)}.events.json`), null);
    cur.ended = { at: Date.now(), code, text, ...(wake ? { wake } : {}), ...(events ? { events } : {}) };
    st.saveMember(cur);
    if (cur.holder_session) st.markLost(cur.holder_session, { member: cur.id, name: cur.name, room: cur.room.name, person: cur.person_name, at: Date.now(), text });
  }
  // nothing starts its listener again (listen.ts healWakePaths reads these records)
  for (const f of [st.p("wakepath", `${st.safeName(cur.id)}.json`), st.p("wakepath", `${st.safeName(cur.id)}.events.json`)]) {
    rmSync(f, { force: true });
  }
  return text;
}

const utc = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const rejoinedFile = (id: string) => st.p("rejoined", `${st.safeName(id)}.json`);

/** `botlink status`: one line per member that ended, and once, per membership a re-join replaced, what became of it. */
export function endedLines(): string[] {
  const out = st.endedMembers().map((m) => `ended: ${m.ended!.text} (${utc(m.ended!.at)})`);
  for (const r of st.listJson<{ id: string; name: string; room: string; removed_at: number; joined_at: number }>(st.p("rejoined"))) {
    out.push(`earlier: ${r.name} in #${r.room} was removed (${utc(r.removed_at)}); this chat joined #${r.room} again as ${r.name} (${utc(r.joined_at)}). That earlier membership is gone from this computer.`);
    rmSync(rejoinedFile(r.id), { force: true }); // said once
  }
  return out;
}

/** Everything this computer keeps under a member's id, apart from its record and keys (state.ts lists the folders). */
const PER_MEMBER = ["wakepath", "rosters", "refused", "wake", "signal", "away", "archive", "ledger", "perms", "rules", "asks", "held", "stopped", "seen", "dedupe", "ackq", "events", "wakepolicy"];

/**
 * A join of this chat was just approved (m): every other record of the same server, room and name is a membership the
 * person removed (marked ended, or one this computer never heard was removed: the server lets only one member hold a
 * name in a room). It goes now, in the same step, so nothing can resolve to it, count it as a second room or revive
 * it (launch blocker, staging c5b1c2f). What goes with it: its secret keys (useless, and a secret), its wake paths
 * (nothing restarts its listener; a listener still running finds no record and stops with exit 4), its pending "no
 * longer a member" line (this chat just joined again), its room history (sealed to the deleted key: unreadable) and
 * every other file kept under its id. What carries over: its standing rules and its mutes (they only ever hold back;
 * a grant of more goes back to the default, as for any new member: perms.ts). `botlink status` says once that the
 * earlier membership was removed.
 */
export function replaceEarlier(m: st.MemberRec): void {
  for (const old of st.earlierRecords(m)) {
    try {
      if (old.ended) st.writeJson(rejoinedFile(old.id), { id: old.id, name: old.name, room: m.room.name, removed_at: old.ended.at, joined_at: m.joined_at });
      if (old.holder_session) st.takeLost(old.holder_session, old.id);
      if (!rulesOf(m.id).length && rulesOf(old.id).length) st.writeJson(st.p("rules", `${st.safeName(m.id)}.json`), rulesOf(old.id));
      const mine = permsOf(m.id);
      for (const [sender, rec] of Object.entries(permsOf(old.id))) if (rec.level === "muted" && !mine[sender]) setPerm(m.id, sender, rec);
      if (old.key_id !== m.key_id) deleteSecrets(old.key_id, old.key_backend as Backend);
      for (const dir of PER_MEMBER) {
        let names: string[] = [];
        try {
          names = readdirSync(st.p(dir));
        } catch {
          continue;
        }
        for (const f of names) if (f === old.id || f.startsWith(`${old.id}.`)) rmSync(st.p(dir, f), { recursive: true, force: true });
      }
    } finally {
      st.deleteMember(old.id);
    }
  }
}

/**
 * A chat's explicit inbox, status or listen: its members marked ended are looked at once more. If bot-link's server
 * takes the key again (the mark was wrong), the mark is cleared, the wake paths come back, and the chat is told.
 * A final answer, or no answer: nothing changes. -> the lines to tell the chat.
 */
export async function revive(session: string | null, folders: string[], app?: string | null): Promise<string[]> {
  const ms = st.endedMembers().filter((m) => (!app || m.app === app) && (session ? m.holder_session === session : folders.includes(m.cwd)));
  const out: string[] = [];
  for (const m of ms) {
    try {
      const { apiFor, signerOf } = await import("./core.js");
      await apiFor(m.server).call({ method: "GET", path: "/api/v1/me/roster", signer: signerOf(m), session: m.holder_session, timeoutMs: 10_000, retryForMs: 0 });
    } catch {
      continue; // still ended (a final answer), or no answer now: no change
    }
    const cur = st.loadMember(m.id);
    if (!cur?.ended) continue;
    const e = cur.ended as { wake?: unknown; events?: unknown };
    st.ensureDir(st.p("wakepath"));
    if (e.wake) st.writeJson(st.p("wakepath", `${st.safeName(cur.id)}.json`), e.wake);
    if (e.events) st.writeJson(st.p("wakepath", `${st.safeName(cur.id)}.events.json`), e.events);
    cur.ended = null;
    st.saveMember(cur, { clearEnded: true });
    st.takeLost(cur.holder_session, cur.id);
    noteReached(cur);
    out.push(`bot-link: ${cur.name} in #${cur.room.name} is back: bot-link's server still accepts this chat as ${cur.name}, so the earlier "no longer a member" was wrong. Its way of listening is set up again as before.`);
  }
  return out;
}
