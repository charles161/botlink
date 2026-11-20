// /approve/<request id> (item 9): the link a joining chat prints. After sign-in it shows exactly that join (or move)
// request's card. Anyone else (another account, a mistyped id, a request that ended over 30 minutes ago) sees the same
// generic not-found page: the link carries only the request id, never a secret, and reveals nothing by itself. The
// person the request was for sees why it is no longer waiting (withdrawn by the chat, expired, replaced, decided).
//
// Security review item 11 (self-heal): a chat that used another person's chat invite is addressed to that person.
// When a different person of the same room opens its link, they are offered to make the request theirs.
import { h, fill, toast } from "../dom.js";
import { get, post, errorText } from "../api.js";
import { app, refreshNeeds } from "../app.js";
import { appName } from "../art.js";
import { joinCard } from "../needs.js";
import { endedHow, twinsOf } from "../notify.js";

const waitingCard = (id) => (app.needs?.join_requests || []).find((c) => c.id === id) || null;

// A request that is no longer waiting says why (needs-you ended_join_requests), instead of a card that can't be approved.
const GONE = {
  withdrawn: ["Withdrawn by the chat", "The chat took this request back, so there is nothing to approve. If it asks again, it shows a new code."],
  // how long a request lasts is the server's setting (15 minutes in production, less on staging): only the time the
  // server says it ran out is shown, never a lifetime this page would have to assume
  expired: ["This request expired", (r) => `It ran out${ranOutAt(r) ? ` at ${ranOutAt(r)}` : ""} before anyone approved it. If the chat asks again, it shows a new code.`],
  replaced: ["Replaced by a newer request", "The chat asked again. The newer request has its own code: find it under What needs you."],
  closed: ["This request can't go ahead", "The room was deleted, or the chat or its person is no longer in it."],
  approved: ["Already approved", null],
  rejected: ["Already rejected", null],
};
function ranOutAt(r) {
  const at = (app.needs?.ended_join_requests || []).find((e) => e.id === r.id)?.ended_at || r.expires_at;
  const t = Date.parse(at || "");
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
}
function gonePage(r, how) {
  const [title, said] = GONE[how] || ["This request is no longer waiting", "It was decided in another browser, or the chat took it back."];
  const line = typeof said === "function" ? said(r) : said;
  const text = line || (how === "approved" ? `${r.name} is in #${r.room_name}.` : `${r.name} won't come in.`);
  return h("section", { class: "page page-narrow", "data-gone": how || "unknown", "data-gone-id": r.id },
    h("p", { class: "kicker" }, `#${r.room_name}`),
    h("h1", { class: "display-sm" }, title),
    h("p", { class: "lead" }, `${r.name}: ${text}`),
    h("div", { class: "row-actions" },
      h("a", { href: "/rooms", class: "btn btn-primary" }, "See what needs you"),
      how === "approved" ? h("a", { href: `/rooms/${r.room_id}`, class: "btn btn-ghost" }, `Open #${r.room_name}`) : null));
}

function page(card) {
  const wrap = h("div");
  let decided = false, left = false, twins = "";
  const done = h("p", { class: "lead", hidden: true }, "Done. ", h("a", { href: `/rooms/${card.room_id}` }, `Open #${card.room_name}`), ".");
  const slot = h("div", { class: "approve-one" });
  const onDone = () => { decided = true; if (!left) { slot.hidden = true; done.hidden = false; } };
  // runs on every change (and when notify.js asks the server again after the request should have run out)
  const draw = () => {
    if (decided || left) return;
    const now = waitingCard(card.id);
    if (!now) { // withdrawn, ran out, replaced, or decided in another browser
      left = true;
      fill(wrap, gonePage(card, endedHow(card.id)));
      return;
    }
    const key = twinsOf(now).map((c) => c.id).join(); // another request for this room came or went: redraw the card
    if (key !== twins || !slot.firstChild) { twins = key; fill(slot, joinCard(now, { showRoom: true, onDone })); }
  };
  fill(wrap, h("section", { class: "page page-narrow" },
    h("p", { class: "kicker" }, `#${card.room_name}`),
    h("h1", { class: "display-sm" }, card.kind === "claim" ? "Approve a move" : "Approve a chat"),
    h("p", { class: "lead" }, "This is the request the chat's link points to. Check where it runs and that the code matches the one in that chat."),
    slot, done));
  draw();
  return { el: wrap, refresh: draw };
}

function offerPage(offer, onTaken) {
  const take = h("button", { type: "button", class: "btn btn-primary" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-label" }, "Make it my chat"));
  take.addEventListener("click", async () => {
    take.disabled = true; take.classList.add("busy");
    try { await post(`/app/v1/join-requests/${offer.id}/readdress`); await refreshNeeds(); onTaken(); }
    catch (e) { toast(errorText(e, { name: offer.name }), "error"); take.disabled = false; take.classList.remove("busy"); }
  });
  return h("section", { class: "page page-narrow readdress" },
    h("p", { class: "kicker" }, `#${offer.room_name}`),
    h("h1", { class: "display-sm" }, `This used ${offer.invite_owner_name}'s link`),
    h("p", { class: "lead" }, `${offer.name} (${appName(offer.app, offer.app_name)} on ${offer.machine || "an unknown computer"}) asked to join with ${offer.invite_owner_name}'s chat invite, so it waits for ${offer.invite_owner_name}. Is it your chat? Make it yours, then check the code and approve it.`),
    h("div", { class: "row-actions" }, take),
    h("p", { class: "help" }, `Not yours? Leave it; ${offer.invite_owner_name} decides.`));
}

export default async function approve({ params }) {
  await refreshNeeds();
  const card = waitingCard(params.id);
  if (card) return { ...page(card), title: card.kind === "claim" ? "Approve a move" : "Approve a chat" };
  const ended = (app.needs?.ended_join_requests || []).find((e) => e.id === params.id); // this person's own, lately
  if (ended) return { el: gonePage(ended, ended.ended), title: "No longer waiting" };
  let offer = null;
  try { offer = (await get(`/app/v1/join-requests/${params.id}/readdress`)).offer; } catch { offer = null; }
  if (!offer) return (await import("./not-found.js")).default({});
  const wrap = h("div");
  wrap.append(offerPage(offer, () => {
    const mine = waitingCard(params.id);
    wrap.replaceChildren(mine ? page(mine).el : h("p", { class: "lead" }, "It's yours now. Find it under What needs you."));
  }));
  return { el: wrap, title: "Make it my chat" };
}
