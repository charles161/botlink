// A waiting account delete, on every signed-in page of the account (security re-review of fix-all): when it can be
// finished, from which browser it was asked, and a Cancel button that needs no passkey. There is no mail: this note is
// the only warning, so it says what to do when it wasn't you (third security pass). Same place and look as the
// passkey-reset banner (recovery.js), in its own box above it. Server: appapi/account_data.go.
//
// app.js imports this module; this module imports app.js back and only reads its exports from functions that run
// after both have loaded (the first one is queued below).
import { h, $, fill, absTime, until, details } from "./dom.js";
import { get } from "./api.js";
import { icon } from "./art.js";
import { deviceLabel } from "./crypto.js";
import * as shell from "./app.js";

let host = null, seq = 0;

// "Not you?": what to do, as numbered steps (third security pass). A passkey kept in sync by a phone or a password
// manager can also be on a lost computer: the way out is a NEW passkey, then removing the shared one.
export function notMeSteps() {
  return h("ol", { class: "not-me-steps", style: { margin: "6px 0 0", "padding-left": "22px", display: "grid", gap: "6px" } },
    h("li", null, "Cancel the delete here."),
    h("li", null, "Change the password of your Google or GitHub account, and sign out of your other devices there."),
    h("li", null, "If one of your passkeys may also be on a computer you lost (one your phone or password manager keeps in sync): on Your browsers, add a new passkey, confirming with the old one. Then remove the old one there, confirming with the new one. After that the old one works nowhere."),
    h("li", null, "Remove any browser you don't know on Your browsers."));
}

function card(p) {
  const cancel = h("button", { type: "button", class: "btn btn-sm btn-danger-ghost" }, "Cancel the delete");
  cancel.addEventListener("click", async () => {
    const { cancelDelete } = await import("./views/account.js");
    await cancelDelete(p, async () => { await refreshDeleteBanner(); shell.app.listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); });
  });
  const from = p.asked_here ? "this browser" : p.user_agent ? deviceLabel(p.user_agent) : "a browser";
  const title = p.ready ? "Your account can be deleted now." : p.asked_here ? "You asked to delete this account." : "Someone asked to delete this account.";
  const body = p.ready
    ? `Asked ${absTime(p.asked_at)} from ${from}. It can be finished on Your account until ${absTime(p.lapses_at)}. Then there is no undo.`
    : `Asked ${absTime(p.asked_at)} from ${from}. If nobody cancels it, it can be finished from ${absTime(p.ready_at)}${until(p.ready_at) ? ` (in ${until(p.ready_at)})` : ""}.`;
  const firstKey = p.first_passkey ? h("p", { "data-first-passkey": "" }, "A passkey was set up for this account when it was asked. Cancelling removes that passkey and signs out your other browsers.") : null;
  const notMe = p.asked_here ? null : details("Not you? What to do", notMeSteps(),
    location.pathname === "/devices" ? null : h("div", { class: "row-actions" }, h("a", { href: "/devices", class: "btn btn-ghost btn-sm" }, "Your browsers")));
  const open = location.pathname === "/account" ? null : h("a", { href: "/account", class: "btn btn-ghost btn-sm" }, "Your account");
  return h("div", { class: "banner banner-coral", role: "alert", "data-delete-pending": p.ready ? "ready" : "waiting" },
    icon("alert", { size: 22 }),
    h("div", { style: { "min-width": "0" } }, h("strong", null, title), h("p", null, body), firstKey, notMe, h("div", { class: "row-actions" }, cancel, open)));
}

export async function refreshDeleteBanner() {
  const mine = ++seq;
  let p = null;
  if (shell.app.me) { try { p = (await get("/app/v1/me/delete")).pending; } catch { p = null; } }
  if (mine !== seq) return;
  if (!p) { host?.remove(); host = null; return; }
  if (!host || !host.isConnected) {
    host = h("div", { class: "page delete-banners", style: { "padding-top": "16px", "padding-bottom": "0", "animation": "none" } });
    // above the passkey-reset notes (recovery.js): a delete is the bigger loss, so it is read first
    (document.querySelector(".recovery-banners") || $("#main"))?.before(host);
  }
  fill(host, card(p));
}
setTimeout(() => { shell.onChange(refreshDeleteBanner); refreshDeleteBanner(); }, 0);
