// /approve-url/<request id> (docs/protocol/event-url-approval.md §2): the link a chat prints when it asks bot-link to
// call an address its person must approve. After sign-in it shows exactly that request's card (needs-eventurl.js).
// A request that is not the caller's, unknown, ran out or already decided: the generic not-found page, so the link
// reveals nothing by itself. The same when it stops waiting while the page is open (decided in another browser).
import { h, fill } from "../dom.js";
import { app, refreshNeeds } from "../app.js";
import { inertText } from "../draft.js";
import { eventUrlCard } from "../needs-eventurl.js";
import { approvedText, REJECTED } from "../eventurl.js";

const waiting = (id) => (app.needs?.event_urls || []).find((x) => x.id === id) || null;
const notFound = async () => (await import("./not-found.js")).default({});

function page(r) {
  const wrap = h("div");
  const room = `#${inertText(r.room?.name || "")}`;
  let left = false;
  const leave = (el) => { left = true; fill(wrap, el); };
  const statePage = (state, title, line) => h("section", { class: "page page-narrow", "data-eu-state": state },
    h("p", { class: "kicker" }, room),
    h("h1", { class: "display-sm" }, title),
    h("p", { class: "lead" }, line),
    h("div", { class: "row-actions" }, h("a", { href: "/rooms", class: "btn btn-primary" }, "Your rooms")));
  const gone = async () => { if (!left) leave((await notFound()).el); };
  const card = eventUrlCard(r, { on: {
    approved: async () => { leave(statePage("approved", "Approved", approvedText(inertText(r.member?.name || "your chat")))); await refreshNeeds(); },
    rejected: async () => { leave(statePage("rejected", "Not approved", REJECTED)); await refreshNeeds(); },
    gone,
  } });
  fill(wrap, h("section", { class: "page page-narrow eu-page", "data-eu-page": r.id },
    h("p", { class: "kicker" }, room),
    h("h1", { class: "display-sm" }, "Approve an address"),
    h("p", { class: "lead" }, "This is the request your chat's link points to. Check the whole address before you approve."),
    card));
  // decided in another browser, withdrawn or ran out while open
  const refresh = () => { if (!left && app.needs && !waiting(r.id)) gone(); };
  return { el: wrap, refresh, cleanup: () => { left = true; } };
}

export default async function approveUrl({ params }) {
  await refreshNeeds();
  const r = waiting(params.id);
  if (!r) return notFound();
  return { ...page(r), title: "Approve an address" };
}
