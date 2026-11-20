/**
 * Waits that end in nothing (prod-readiness review, blocker 10, 16 Nov 2026). What a chat is told when its join
 * request ends without it getting in, and how it takes back what its key still holds on the server when the approval
 * self-check fails (ENVELOPE §5.4), so no card and no member is left on the person's dashboard with no chat behind it.
 * Kept in one place so it merges easily; core.ts calls it from joinCreate, joinWait and finishApproval. The self-check
 * itself is not here and is not changed: this only runs after it has failed.
 */
import * as st from "./state.js";
import { ApiError, inviteCode, type Api, type Signer } from "./api.js";
import { makeEntry, entryHash, type SignedEntry } from "./roster.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (t: number) => `${new Date(t).getUTCDate()} ${MONTHS[new Date(t).getUTCMonth()]}`;
const groupCode = (s: string) => (s && s.length === 6 ? `${s.slice(0, 3)}-${s.slice(3)}` : s || "");

/** The first answer of a join: how long the person has, in plain words ("" when the server gave no expiry). */
export function approveWithin(approver: string, expiresAt: string | null | undefined): string {
  const t = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(t)) return "";
  const min = Math.max(1, Math.round((t - Date.now()) / 60_000));
  return `${approver} has ${min} minute${min === 1 ? "" : "s"} to approve this (until ${hhmm(t)} UTC).`;
}

/** Whether the invite a request that ended was made with still lets a chat in. */
export type InviteNow = { state: "works"; until: string | null } | { state: "expired" | "off" | "renewed" | "closed" | "dead" | "unknown" };

/**
 * The server says what became of the invite (agentapi/joinend.go): expired, turned off, its room or person gone, or it
 * works. It never says the code, so a renewed invite also reads "works": this chat asks for its own code (the open
 * invite preview) to tell. A server from before that field: the preview alone (works, or it does not, with no reason).
 */
export async function inviteNow(req: st.RequestRec, view: any, api: Api): Promise<InviteNow> {
  const s = view?.invite?.state;
  if (s === "expired" || s === "off" || s === "closed") return { state: s };
  if (!req.invite) return { state: "unknown" };
  try {
    const r = await api.call<any>({ method: "GET", path: `/api/v1/invites/${encodeURIComponent(inviteCode(req.invite))}`, timeoutMs: 10_000, retryForMs: 5_000 });
    return { state: "works", until: r.json?.expires_at ?? view?.invite?.expires_at ?? null };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { state: s === "works" ? "renewed" : "dead" };
    return { state: "unknown" };
  }
}

/** How long the request lasted, from the server's own numbers (RequestRec.lifetime_s), never this computer's clock:
 *  "within 2 minutes", "within 1 minute", "within 45 seconds"; unknown: "in time". */
export function lastedText(s: number | null | undefined): string {
  if (!s || !Number.isFinite(s) || s <= 0 || s > 2 * 3600) return "in time";
  if (s < 60) return `within ${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  return `within ${m} minute${m === 1 ? "" : "s"}`;
}

/** A join request that ended without an approval (expired, or cancelled on the server): what happened, that nothing
 *  was joined, and exactly what to do next for the invite as it is now. */
export function endedText(req: st.RequestRec, view: any, inv: InviteNow): string {
  const name = req.name, who = req.approver_name, inviter = req.invite_name || req.approver_name;
  const head = view?.status === "cancelled"
    ? `The request to join as ${name} was cancelled on the server (the room, its member or the person's place in it changed). Nothing was joined.`
    : `The request to join as ${name} expired: ${who} didn't approve it ${lastedText(req.lifetime_s)}. Nothing was joined.`;
  switch (inv.state) {
    case "works": {
      const t = inv.until ? Date.parse(inv.until) : NaN;
      const until = Number.isFinite(t) ? ` (until ${hhmm(t)} UTC on ${day(t)})` : "";
      return `${head} The invite still works${until}. So join again with the same invite and the same name, ${name}. No new invite is needed. That asks ${who} again, with a new code to show your human.`;
    }
    case "expired":
      return `${head} The invite has run out too (an invite lasts 24 hours). Ask your human for a fresh invite (Renew on the room page), then join again as ${name}.`;
    case "off":
      return `${head} ${inviter} turned the invite off. Ask your human to turn it on again on the room page, or for a fresh invite, then join again as ${name}.`;
    case "renewed":
      return `${head} The invite was renewed since, so this link no longer works. Ask your human for the new link (the room page shows it), then join again as ${name}.`;
    case "closed":
      return `${head} The invite no longer lets a chat in: the room was deleted, or ${inviter} is no longer in it. Ask your human.`;
    case "dead":
      return `${head} The invite no longer works (it ran out, was turned off or was renewed). Ask your human for a fresh invite, then join again as ${name}.`;
    default:
      return `${head} bot-link couldn't check the invite just now. An invite lasts 24 hours unless your human turns it off or renews it: join again with the same invite and the same name, ${name}; if bot-link then says the invite doesn't work, ask your human for a fresh one.`;
  }
}

/** What the failed self-check was about: an approval, a request still waiting, or one the server no longer holds this
 *  chat's key for (it can't tell which). */
export type Phase = "approved" | "pending" | "unknown";
/** What this chat's key could take back on the server. */
export type TakeBack = "withdrawn" | "left" | "gone" | "not_ours" | "failed";

/**
 * After a failed self-check, with this chat's key (before it is deleted): a pending request is withdrawn (POST
 * …/cancel); a member that was approved with this chat's key leaves by that key (member_remove signed by the member's
 * own key, DELETE /api/v1/me, ENVELOPE §5.2), so the room shows plainly that it left. Nothing here trusts the server's
 * member list: the entry only ever removes this chat's own member, signed by its own key. A move (claim) is never
 * taken out: that member was there before this chat asked.
 */
export async function takeBack(req: st.RequestRec, api: Api, signer: Signer, o: { approved: boolean; ourKey: boolean; memberId?: string | null }): Promise<TakeBack> {
  if (!o.ourKey) return "not_ours";
  let memberId = o.memberId || req.member_id || null;
  if (!o.approved && req.kind === "create") {
    // a room draft (room-drafts.md §2): cancel deletes it while open (204, also when it is already gone)
    // 409 already_decided: it was confirmed meanwhile, so this chat's key is a member now: it leaves (below)
    let confirmed = false;
    try {
      await api.call({ method: "POST", path: `/api/v1/room-drafts/${req.id}/cancel`, body: {}, signer, session: req.session_id, timeoutMs: 15_000, retryForMs: 10_000 });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409 && e.code === "already_decided")) return e instanceof ApiError && e.status === 403 ? "not_ours" : "failed";
      confirmed = true;
    }
    if (!confirmed) return "withdrawn";
  }
  if (!o.approved && req.kind !== "create") {
    let v: any;
    try {
      v = (await api.call<any>({ method: "POST", path: `/api/v1/join-requests/${req.id}/cancel`, body: {}, signer, session: req.session_id, timeoutMs: 15_000, retryForMs: 10_000 })).json;
    } catch (e) {
      return e instanceof ApiError && e.status === 403 ? "not_ours" : "failed";
    }
    if (v?.status === "cancelled") return "withdrawn";
    if (v?.status !== "approved") return "gone"; // rejected or expired: no card is left
    if (v.fingerprint && v.fingerprint !== req.fingerprint) return "not_ours";
    memberId = v.member_id || memberId;
  }
  if (req.kind === "claim" || !memberId || !UUID.test(memberId)) return "failed";
  try {
    for (let i = 0; ; i++) {
      const rr = (await api.call<any>({ method: "GET", path: "/api/v1/me/roster", signer, session: req.session_id, retryForMs: 10_000 })).json;
      const entries: SignedEntry[] = Array.isArray(rr?.entries) ? rr.entries : [];
      const head = entries[entries.length - 1];
      if (!head || typeof rr.room_id !== "string") return "failed";
      const entry = makeEntry({ room: rr.room_id, op: "member_remove", member: memberId }, head.seq + 1, entryHash(head), signer.pk, signer.seed);
      try {
        await api.call({ method: "DELETE", path: "/api/v1/me", body: { roster_entry: entry }, signer, session: req.session_id, retryForMs: 10_000 });
        return "left";
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409 && i === 0)) throw e; // the list moved on: once more at its new head
      }
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 410) return "gone";
    if (e instanceof ApiError && (e.code === "unknown_key" || e.status === 401 || e.status === 403)) return "not_ours";
    return "failed";
  }
}

/** The failed self-check, said calmly and exactly: what happened, that nothing was joined, what was taken back, and
 *  the words for the human. A security signal: the chat neither retries nor tries another name on its own. */
export function mismatchText(req: st.RequestRec, phase: Phase, took: TakeBack): string {
  const name = req.name, room = `#${req.room?.name || "the room"}`, code = groupCode(req.match_code);
  const open = phase === "approved" ? "This approval does not match this chat's key, so bot-link did not use it."
    : phase === "pending" ? "bot-link stopped waiting: the server's answer for this request no longer matches this chat's key or the person whose invite it used."
    : "bot-link stopped waiting: the server no longer holds this chat's key for this request.";
  const what = phase === "approved" ? "the approval" : "the request";
  const why = phase === "pending" ? "it did not match this chat's key or the person whose invite it used" : "it did not match this chat's key";
  const left = phase === "approved" ? `${name} may still show as a member of ${room} that no chat holds`
    : phase === "pending" ? `the card for ${name} (code ${code}) may still be on the dashboard`
    : `the card for ${name} (code ${code}) may still be on the dashboard, or ${name} may show as a member of ${room}`;
  const ask = phase === "approved" ? ` Please remove ${name} on the room page.`
    : phase === "pending" ? ` Please reject the request for ${name} (code ${code}) on the dashboard.`
    : ` Please reject the request for ${name} (code ${code}) on the dashboard, or remove ${name} on the room page if it was approved.`;
  const done = took === "withdrawn" ? { now: ` bot-link withdrew the request for ${name}, so its card is gone from the dashboard.`, tell: "" }
    : took === "left" ? { now: ` bot-link took ${name} out of ${room} again, signed with this chat's key, so the room page shows that ${name} left.`, tell: ` ${name} was taken out of the room again.` }
    : took === "gone" ? { now: phase === "approved" ? ` ${name} is not in ${room} any more.` : ` The request for ${name} is no longer open, so no card is left for it.`, tell: "" }
    : { now: ` bot-link could not take it back${took === "not_ours" ? " (the server holds another key for it)" : ""}: ${left}.`, tell: ask };
  return `${open} Nothing was joined: this chat is not a member of ${room}, and its keys for this request were deleted.${done.now} ` +
    `Tell your human, in these words: "bot-link refused ${what} for ${name} in ${room}: ${why}, so nothing was joined.${done.tell}" ` +
    `Don't join again, and don't try another name, until your human has looked at it.`;
}
