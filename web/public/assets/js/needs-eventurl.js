// An event address a person approves (docs/protocol/event-url-approval.md §2-4). A chat asked bot-link to call an
// address when a message waits for it (the trigger of a routine answers only 200, so it can't echo the check value).
// Its person sees a card under "What needs you" and on /approve-url/<id> (views/approve-url.js): our heading with the
// room, the warning, the host large (the URL parser's host, never a name before an @; Unicode and punycode when they
// differ), the full address as the chat's words (chatwords.js: inert, never a link), what is sent, Approve and Don't.
// Approve reads the request again before the passkey step and again before sending, and stops on any difference. These
// cards never join a batch (needs-batch.js works on join requests only). Also: the member's approved addresses with
// Stop, on its details sheet, for the member's own person only. The rules that need no page are in eventurl.js.
import { h, ago, until, toast } from "./dom.js";
import { get, post, errorText } from "./api.js";
import { icon } from "./art.js";
import { humanCheck, confirmDialog } from "./humancheck.js";
import { refreshNeeds } from "./app.js";
import { inertText } from "./draft.js";
import { quoted } from "./chatwords.js";
import {
  APPROVE_ACTION, EVENTS, URGENT_ONLY, WARNING, COMPARE, lasts, ENCODED, CHANGED, BLOCKED, UNREACHABLE, HC_FAILED, REJECTED, REFUSED, USERINFO,
  approvedText, stopBody, tooMany, hostView, sameRequest, requestProblems,
} from "./eventurl.js";

// http addresses only where the dashboard itself runs on http (development); the server's push guard decides anyway
const opts = () => ({ allowHttp: location.protocol === "http:" });
const notes = new Map(); // request id → the last line its card said (kept when the list is drawn again)

/** The request as the server holds it now, or null when it no longer waits for this person. */
async function readAgain(id) {
  const n = await get("/app/v1/needs-you");
  return (n?.event_urls || []).find((x) => x.id === id) || null;
}

/** The host large, exactly as the server gave it (what bot-link dials; never decoded), and what a person needs to know about it. */
function hostLines(view) {
  return [
    h("bdi", { class: "eu-host", text: view.host ? inertText(view.host) : "No host given" }),
    view.encoded ? h("p", { class: "eu-encoded" }, ENCODED) : null,
    view.userinfo ? h("p", { class: "eu-userinfo" }, USERINFO(inertText(view.host))) : null,
  ];
}

const button = (label, cls, ic) => h("button", { type: "button", class: ["btn", cls] }, h("span", { class: "spinner", "aria-hidden": "true" }), ic ? icon(ic, { size: 18 }) : null, h("span", { class: "btn-label" }, label));
const busy = (b, on) => { b.disabled = on; b.classList.toggle("busy", on); };

/**
 * The card. on: {approved, rejected, gone} replace what the list does (a toast and the list drawn again); the page
 * moves to its own states with them.
 */
export function eventUrlCard(r, { on = {}, onDone } = {}) {
  const shown = structuredClone(r);
  const ev = EVENTS[r.name];
  const chat = inertText(r.member?.name || "A chat");
  const room = inertText(r.room?.name || "");
  const view = hostView(r.url, { ...opts(), serverHost: r.host });
  const problems = requestProblems(r, r.id, opts());
  let stopped = false;

  const status = h("p", { class: "eu-status", role: "alert", hidden: !notes.get(r.id) }, notes.get(r.id) || "");
  const say = (text) => { if (text) notes.set(r.id, text); else notes.delete(r.id); status.textContent = text || ""; status.hidden = !text; };
  const approveBtn = button("Approve", "btn-primary", "fingerprint");
  const rejectBtn = button("Don't", "btn-ghost");
  if (problems.length) approveBtn.disabled = true;
  const offer = !view.encoded; // an encoded name is never offered for approval

  const done = {
    approved: on.approved || (async () => { toast(approvedText(chat), "success", 7000); await refreshNeeds(); onDone?.(); }),
    rejected: on.rejected || (async () => { toast(REJECTED); await refreshNeeds(); onDone?.(); }),
    gone: on.gone || (async () => { toast(errorText({ code: "not_found" }), "error"); await refreshNeeds(); onDone?.(); }),
  };
  const changed = () => { stopped = true; say(CHANGED); approveBtn.disabled = true; approveBtn.classList.remove("busy"); };
  const differs = (now) => !sameRequest(shown, now) || requestProblems(now, r.id, opts()).length > 0;

  // Outcomes the card shows come back as values; anything else throws (the dialog shows it).
  async function send(proof) {
    const now = await readAgain(r.id);
    if (!now) return { gone: true };
    if (differs(now)) return { changed: true };
    try {
      await post(`/app/v1/event-urls/${r.id}/approve`, { human_check: proof });
      return { done: true };
    } catch (e) {
      if (e.code === "event_url_blocked") return { blocked: true };
      if (e.code === "event_verify_failed") return { unreachable: true };
      if (e.code === "too_many_subscriptions") return { full: true };
      if (e.code === "not_found") return { gone: true };
      if (e.code === "human_check_failed") e.userMessage = HC_FAILED;
      throw e;
    }
  }

  async function approve() {
    say(null);
    busy(approveBtn, true);
    try {
      const now = await readAgain(r.id);
      if (!now) { stopped = true; await done.gone(); return; }
      if (differs(now)) { changed(); return; }
      let out = null;
      const ok = await humanCheck({
        action: APPROVE_ACTION, targetId: r.id,
        title: "You're the human here.",
        lead: h("p", { class: "modal-lead" }, "Let bot-link call ", h("b", { class: "eu-dlg-host" }, inertText(view.host)), " for ", h("b", null, chat), "?"),
        facts: h("div", { class: "hc-facts eu-dlg" }, h("p", { class: "eu-warn" }, icon("alert", { size: 18 }), h("span", null, `${WARNING} ${COMPARE}`))),
        confirmLabel: "Approve", unlockLabel: "Unlock & approve", busyLabel: "Approving…",
        errorCtx: { name: chat },
        onProof: async (proof) => { out = await send(proof); },
      });
      if (!ok || !out) return;
      if (out.done) { stopped = true; notes.delete(r.id); await done.approved(); }
      else if (out.changed) changed();
      else if (out.blocked) say(BLOCKED);
      else if (out.unreachable) say(UNREACHABLE);
      else if (out.full) say(tooMany(chat));
      else if (out.gone) { stopped = true; await done.gone(); }
    } catch (e) {
      say(e?.userMessage || errorText(e, { name: chat }));
    } finally {
      if (!stopped) busy(approveBtn, false);
    }
  }
  approveBtn.addEventListener("click", approve);
  rejectBtn.addEventListener("click", async () => {
    say(null);
    busy(rejectBtn, true);
    try { await post(`/app/v1/event-urls/${r.id}/reject`); stopped = true; notes.delete(r.id); await done.rejected(); }
    catch (e) { busy(rejectBtn, false); if (e.code === "not_found") await done.gone(); else say(errorText(e)); }
  });

  const left = until(r.expires_at);
  return h("article", { class: "need need-event_url", "data-need": "event_url", "data-request": r.id, "aria-labelledby": `eu-${r.id}` },
    h("header", { class: "need-head" },
      h("span", { class: "need-kind" }, "Address request", room ? h("span", { class: "need-room" }, `#${room}`) : null),
      h("span", { class: "need-time" }, ago(r.created_at), left ? ` · ${left} left` : "")),
    h("h3", { class: "need-title", id: `eu-${r.id}` }, ev ? ev.heading(chat, room) : `${chat} asks bot-link to call an address.`),
    h("p", { class: "eu-warn" }, icon("alert", { size: 18 }), h("span", null, `${WARNING} ${COMPARE}`)),
    h("div", { class: "chat-words eu-address", role: "group", "aria-labelledby": `eu-by-${r.id}` },
      h("p", { id: `eu-by-${r.id}`, class: "cw-by" }, "The address your chat sent, as plain text. bot-link calls the host in large letters."),
      h("div", { class: "cw-line" }, h("span", { class: "cw-label" }, "Host"), ...hostLines(view)),
      quoted("Full address", "url", r.url, { address: true })),
    ev ? h("p", { class: "eu-sent" }, ev.sent(chat, room)) : null,
    r.urgent_only ? h("p", { class: "need-fine" }, URGENT_ONLY) : null,
    problems.length && offer ? h("p", { class: "need-blocker" }, REFUSED) : null,
    offer ? h("p", { class: "need-fine eu-lasts" }, lasts(chat)) : null,
    status,
    h("div", { class: "need-actions" }, offer ? approveBtn : null, rejectBtn));
}

// ── the member's approved addresses ─────────────────────────────────────────
/**
 * The one place the dashboard reads a member's approved addresses. The read endpoint is the server lane's to name
 * (docs/protocol/event-url-approval.md §4 gives only Stop); until it does: GET /app/v1/members/{id}/event-urls →
 * {event_urls: [{subscription_id, url, host, name, urgent_only, approved_at, failing}]}.
 */
export const readApproved = (memberId) => get(`/app/v1/members/${memberId}/event-urls`).then((x) => (Array.isArray(x?.event_urls) ? x.event_urls : []));

const day = (iso) => { const t = Date.parse(iso || ""); return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "a day the server did not give"; };

/** For the member's own person only (the caller decides): its approved addresses, each with Stop. Hidden while none. */
export function approvedAddresses(m) {
  const list = h("ul", { class: "eu-sub-list" });
  const box = h("section", { class: "eu-subs", hidden: true, "aria-labelledby": `eus-${m.id}` },
    h("h3", { class: "eu-subs-title", id: `eus-${m.id}` }, "Addresses bot-link calls"),
    h("p", { class: "need-fine" }, "You approved these for this chat. Stop one and bot-link no longer calls it."),
    list);
  const chat = inertText(m.name);
  const row = (s) => {
    const stop = h("button", { type: "button", class: "btn btn-danger-ghost btn-sm" }, "Stop");
    const li = h("li", { class: "eu-sub", "data-sub": s.subscription_id },
      ...hostLines(hostView(s.url, { serverHost: s.host })),
      quoted("Full address", "url", s.url, { address: true }),
      h("p", { class: "need-fine" }, `Approved by you on ${day(s.approved_at)}. ${lasts(chat)}`),
      s.failing ? h("p", { class: "need-fine" }, "bot-link could not reach it lately. To use it again, your chat asks again and you approve again.") : null,
      stop);
    stop.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Stop calling this address?", body: stopBody(chat), confirmLabel: "Stop", danger: true,
        onConfirm: () => post(`/app/v1/members/${m.id}/event-urls/${encodeURIComponent(s.subscription_id)}/stop`),
      });
      if (!ok) return;
      li.remove();
      box.hidden = !list.childElementCount;
      toast(`bot-link stopped calling ${inertText(s.host || "it")}.`);
    });
    return li;
  };
  readApproved(m.id).then((subs) => {
    list.replaceChildren(...subs.map(row));
    box.hidden = !subs.length;
  }, () => { box.hidden = true; });
  return box;
}
