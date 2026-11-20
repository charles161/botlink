// /p/{code}: a friend opens a person invite, signs in, and asks to join. The owner approves.
import { h, until, toast, fill } from "../dom.js";
import { get, post, errorText } from "../api.js";
import { icon, avatar, tableScene } from "../art.js";
import { app, ensureDevice, loginUrl, refreshNeeds } from "../app.js";

export default async function personInvite({ params }) {
  const code = params.code.toUpperCase();
  const card = h("div", { class: "card invite-card" });
  const el = h("section", { class: "page page-narrow person-invite" }, card);

  if (!app.me) {
    fill(card, 
      h("div", { class: "invite-art", "aria-hidden": "true" }, avatar("empty", { size: 72 })),
      h("p", { class: "kicker" }, "You're invited"),
      h("h1", { class: "h1" }, "Someone saved you a seat."),
      h("p", { class: "lead small" }, "Sign in to see the room and ask to come in. The owner approves you, then you can bring your own chats."),
      h("a", { href: loginUrl(`/p/${code}`), class: "btn btn-primary btn-lg btn-block" }, "Sign in to continue", icon("arrowRight")));
    return { el, title: "You're invited" };
  }

  let preview;
  try { preview = await get(`/app/v1/person-invites/${code}`); }
  catch (e) {
    fill(card, 
      h("div", { class: "invite-art", "aria-hidden": "true" }, avatar("empty", { size: 72 })),
      h("h1", { class: "h1" }, "This invite can't be used."),
      h("p", { class: "lead small" }, e.status === 404 ? "It may have been used already, turned off, or it expired. Ask the person who sent it for a new one." : errorText(e)),
      h("a", { href: "/rooms", class: "btn btn-ghost" }, "Your rooms"));
    return { el, title: "Invite unavailable" };
  }

  const r = preview.room;
  const status = h("p", { class: "form-status", role: "status", "aria-live": "polite" });
  const ask = h("button", { type: "button", class: "btn btn-primary btn-lg btn-block" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-label" }, "Ask to join"), icon("arrowRight"));
  // Before the owner approves you, the preview gives a count, never who the chats are (invite links leak).
  const n = Number(r.member_count) || 0;
  const seats = [
    { kind: "person", label: preview.owner_name, sub: "owner", initial: preview.owner_name, owner: true },
    { kind: "empty", label: "Your seat" },
  ];
  const scene = tableScene({ seats, compact: true, center: { title: `#${r.name}`, sub: `${n} chat${n === 1 ? "" : "s"} here` }, ariaLabel: `#${r.name}: ${n} chat${n === 1 ? "" : "s"} here` });

  ask.addEventListener("click", async () => {
    if (!app.cryptoOk) { status.textContent = "This browser can't sign. Use a recent Chrome, Edge, Firefox or Safari."; return; }
    ask.disabled = true; ask.classList.add("busy"); status.textContent = "";
    try {
      const dev = await ensureDevice();
      await post(`/app/v1/person-invites/${code}/accept`, { device_id: dev.id });
      await refreshNeeds();
      card.replaceChildren(
        h("div", { class: "invite-art ok", "aria-hidden": "true" }, icon("check", { size: 34 })),
        h("h1", { class: "h1", "data-autofocus": "" }, "Asked."),
        h("p", { class: "lead small" }, `${preview.owner_name} will see your request on their dashboard. Once they approve, #${r.name} shows up in your rooms.`),
        h("a", { href: "/rooms", class: "btn btn-primary btn-block" }, "Go to your rooms"));
      card.querySelector("h1").focus();
    } catch (e) {
      ask.disabled = false; ask.classList.remove("busy");
      if (e.code === "already_in_room") { toast("You're already in this room."); status.textContent = "You're already in this room."; }
      else status.textContent = errorText(e);
    }
  });

  const left = until(preview.expires_at);
  fill(card, 
    h("p", { class: "kicker" }, `${preview.owner_name} invited you`),
    h("h1", { class: "room-title sm" }, h("span", { class: "hash" }, "#"), r.name),
    r.purpose ? h("p", { class: "lead small" }, r.purpose) : null,
    scene,
    h("ul", { class: "checklist" },
      h("li", null, icon("check", { size: 18 }), `${preview.owner_name} approves you before you're in; then you see who's here.`),
      h("li", null, icon("check", { size: 18 }), "Then you bring your own chats and approve them yourself."),
      h("li", null, icon("check", { size: 18 }), "Messages stay private, even from bot-link.")),
    ask, status,
    h("p", { class: "fine center" }, `Signed in as ${app.me.account.email}. This invite works once${left ? ` and expires in ${left}` : ""}.`));
  return { el, title: `Join #${r.name}` };
}
