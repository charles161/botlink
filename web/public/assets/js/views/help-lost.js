// "I lost my passkey / my laptop": what to do, in plain words (prod-readiness blocker 5). Open to everyone; the waiting
// time is read from the server when signed in. Linked from the passkey prompt and from Your browsers.
import { h } from "../dom.js";
import { icon } from "../art.js";
import { get } from "../api.js";
import { span } from "../recovery.js";

export default async function helpLost({ app }) {
  let wait = "3 days", hold = "7 days", del = "3 days", pause = "a day", st = null;
  if (app.me) {
    try { st = await get("/app/v1/me/passkey-reset"); wait = span(st.delay_s); hold = span(st.delete_hold_s); } catch { /* the default words */ }
    try { const p = await get("/app/v1/me/delete"); if (p.delay_s > 0) del = span(p.delay_s); if (p.ask_hold_s > 0) pause = span(p.ask_hold_s); } catch { /* the default words */ }
  }
  const sec = (id, title, ...kids) => h("section", { id, "aria-labelledby": `${id}-h` }, h("h2", { id: `${id}-h` }, title), ...kids);
  const steps = (...items) => h("ol", null, items.map((x) => h("li", null, x)));
  const el = h("section", { class: "page page-narrow" },
    h("a", { href: app.me ? "/devices" : "/", class: "back" }, icon("arrowLeft", { size: 18 }), app.me ? "Your browsers" : "bot-link"),
    h("h1", { class: "h1" }, "Lost your passkey or your laptop?"),
    h("p", { class: "lead small" }, "Approving a chat always needs one of your passkeys. Here is how to get back in, and how to lock out a device you lost."),
    h("article", { class: "prose" },
      sec("laptop", "A laptop or phone is lost or stolen",
        steps(
          "Change the password of the Google or GitHub account you sign in to bot-link with, and sign out of your other devices there. Whoever has the device may still be signed in to it.",
          "Sign in to bot-link on a browser you still have.",
          h("span", null, "Open ", h("a", { href: "/devices" }, "Your browsers"), " and remove the lost one, with the passkeys kept on it (they are ticked when bot-link knows they were made or used there). You confirm with a passkey. From then on bot-link refuses that browser's key, and your other browsers are signed out. A passkey you don't remove keeps working wherever it is kept."),
          "No passkey left to confirm with? Reset your passkeys first (below), then remove the lost browser."),
        h("p", { id: "synced" }, h("strong", null, "A passkey that is also on the lost device. "),
          "A passkey your phone or password manager keeps in sync lives on every device it syncs to, and bot-link only knows where it was made and last used. If you confirm the removal with such a passkey, it stays, and whoever has the lost device can still use it. Lock it out like this:"),
        steps(
          h("span", null, "On ", h("a", { href: "/devices" }, "Your browsers"), ", under Passkeys, add a new passkey, confirming with the old one. Make it one that does not sync to the lost device (a security key, or a different password manager)."),
          "Remove the old passkey there, confirming with the new one.",
          "After that the old passkey works nowhere, and whoever has the lost device can't approve, remove your browsers or cancel your reset with it."),
        h("p", null, "If the lost browser was the only one of yours that could change who is in a room, the removal can't be written into that room's member list from another browser. bot-link still refuses the lost browser. If you own that room, nobody can change its members any more: make a new room and bring your chats there.")),
      sec("passkey", "None of your passkeys works any more",
        st?.reset_enabled === false ? h("p", null, h("strong", null, "Passkey resets are turned off on this server: none can be started or finished. Ask the people who run it.")) : null,
        steps(
          h("span", null, "Sign in again, open ", h("a", { href: "/devices" }, "Your browsers"), " and choose Reset my passkeys."),
          `Wait ${wait}. Approving a chat still needs one of your old passkeys during that time: there is never a moment when it works without one.`,
          "Come back to the same browser (the reset belongs to it: don't clear its cookies meanwhile), sign in again, and set up a new passkey. Your old passkeys stop working at that moment, and your other browsers are signed out."),
        h("p", null, "The wait is there in case someone else asked. Every bot-link page you're signed in on shows the reset, and it can be cancelled from there: with one of your passkeys, or from a browser that was already signed in before the reset was asked."),
        h("p", null, `While a reset is waiting, and for ${hold} after one is finished, the account can't be deleted.`),
        h("p", null, "bot-link can't email you about a reset yet, so that note is the only warning. Open bot-link now and then while a reset is waiting.")),
      sec("not-back", "What a reset does not give back",
        h("p", null, "A reset gives you a new passkey. It does not give a new browser the place your lost browser had in your rooms. A room's member list only takes changes signed by a browser that is already in it. bot-link's server signs no changes for you."),
        h("ul", null,
          h("li", null, "If you still have another browser that is in those rooms, approve the new one from it under Your browsers. Then nothing is lost."),
          h("li", null, "If the lost browser was your only one in a room, the new browser can't approve a chat there, remove one, or add or remove a person. Your chats already in that room keep working."),
          h("li", null, "In a room you own, nobody can change who is in it any more. Make a new room and invite the people and chats again."),
          h("li", null, "In a room someone else owns, ask the owner to remove you and invite you again. Your chats in that room leave with you and join again."),
          h("li", null, "To delete your account, the new browser has to be able to sign your leave in every room someone else owns. Where it can't, ask the owner to remove you first."))),
      sec("delete", "Someone asked to delete your account",
        h("p", null, `Deleting an account waits ${del} after it is asked. Every bot-link page you're signed in on shows it, with a button to cancel it, and no passkey is needed to cancel. Removing a browser or signing out your other browsers cancels it too, and then nobody can ask again for ${pause}.`),
        steps(
          "Cancel it from the note at the top of any bot-link page.",
          "Change your Google or GitHub password, and sign out of your other devices there.",
          h("span", null, "If one of your passkeys may be on a device you lost, add a new one and remove the old one (", h("a", { href: "#synced" }, "how"), ")."),
          h("span", null, "Remove any browser you don't know on ", h("a", { href: "/devices" }, "Your browsers"), ".")),
        h("p", null, "If your account never had a passkey, whoever asked had to set one up to ask. Cancelling without a passkey removes it again and signs out your other browsers. Any first passkey you didn't set up: a browser of yours that was signed in before it shows a note at the top of the page for 3 days, and can remove it there."),
        h("p", null, h("strong", null, "bot-link can't email you yet. "), `The wait protects you only if you open bot-link during it: a delete that nobody cancels within ${del} can then be finished.`)),
      sec("someone", "You didn't ask for a reset",
        steps(
          "Cancel it from the note at the top of any bot-link page.",
          "Change your Google or GitHub password: whoever asked could sign in as you.",
          h("span", null, "Check ", h("a", { href: "/devices" }, "Your browsers"), " and remove any browser you don't know."))),
      sec("again", "Someone keeps cancelling your reset",
        h("p", null, "If someone else can sign in as you and also holds one of your passkeys, they can keep cancelling your reset. Change your Google or GitHub password first, then sign out other browsers from Your browsers, then ask for the reset. If you still have a passkey that works, you don't need a reset: add a new passkey and remove the shared one instead (", h("a", { href: "#synced" }, "how"), ")."))));
  return { el, title: "Lost your passkey or laptop?" };
}
