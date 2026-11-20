// Your browsers: each one holds its own signing key. A new one is approved from a known one. A lost one is removed
// here, and a lost passkey is reset here (recovery.js; prod-readiness blocker 5).
import { h, clear, ago, absTime, fill, details, toast } from "../dom.js";
import { get, post, errorText } from "../api.js";
import { icon } from "../art.js";
import { deviceFingerprint, deviceLabel } from "../crypto.js";
import { app, refreshNeeds } from "../app.js";
import { approveDevice } from "../needs.js";
import { humanCheck, creationOptions, credJSON } from "../humancheck.js";
import { errorBox } from "./rooms.js";
import { HELP, loadReset, askReset, removeBrowser, span } from "../recovery.js";
import { eventSentence } from "../events.js";

const H3 = { "margin-top": "28px", "font-size": "19px" };

export default async function devices() {
  const box = h("div", { "aria-busy": "true" }, h("div", { class: "sk sk-block" }), h("div", { class: "sk sk-block" }));
  const el = h("section", { class: "page page-narrow" },
    h("a", { href: "/rooms", class: "back" }, icon("arrowLeft", { size: 18 }), "Your rooms"),
    h("h1", { class: "h1" }, "Your browsers"),
    h("p", { class: "lead small" }, "Browsers you use with bot-link. A new one needs an OK from one you already use."),
    box);

  // Passkeys (security follow-up): they are what lets a chat in, so adding one asks an existing one first, and
  // removing one asks another one. Only where the server runs the real human check.
  const passkeyBox = h("section", { class: "passkeys", "aria-labelledby": "pk-h" });
  // Lost passkey: ask for a reset (the open one shows as a banner on every page, this one included).
  const resetBox = h("section", { class: "passkey-reset", id: "reset", "aria-labelledby": "reset-h" });
  async function drawReset() {
    let st;
    try { st = await loadReset(); } catch (e) { fill(resetBox, h("p", { class: "help" }, errorText(e))); return; }
    const lostLink = h("a", { href: HELP, class: "btn btn-ghost btn-sm" }, icon("book", { size: 16 }), "Lost your passkey or your laptop?");
    // one sentence each (events.js): who, what, when; the exact time on hover
    const x = { here: app.device?.id, deviceLabel, absTime, when: ago };
    const events = st.events.length ? details("Recent changes",
      h("ul", { class: "reset-events" }, st.events.map((e) => h("li", { "data-event": e.kind, title: absTime(e.at) }, eventSentence(e, x))))) : null;
    if (st.reset) {
      fill(resetBox, h("h3", { id: "reset-h", style: H3 }, "Passkey reset"),
        h("p", { class: "help" }, "A reset is open: see the note at the top of the page."), events);
      return;
    }
    let ask = null;
    if (st.had_passkey && st.reset_enabled) {
      ask = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Reset my passkeys");
      ask.addEventListener("click", () => askReset(st, refresh));
    }
    // every state says only what is true on this server (BOTLINK_PASSKEY_RESET can turn resets off)
    const text = !st.had_passkey ? "You have no passkey yet. Your next approval sets one up."
      : !st.reset_enabled ? "Passkey resets are turned off on this server. Without a working passkey, approving chats and deleting this account stay locked. Ask the people who run this server."
      : `${st.passkeys > 0 ? "If none of your passkeys works any more" : "None of your passkeys is left"}: ask for a reset. It takes ${span(st.delay_s)}, finishes only in this browser, and can be cancelled from your other browsers meanwhile.`;
    fill(resetBox,
      h("h3", { id: "reset-h", style: H3 }, "No passkey left?"),
      h("p", { class: "help" }, text),
      h("div", { class: "row-actions" }, ask, lostLink), events);
  }

  async function drawPasskeys() {
    if (app.me?.human_check_mode !== "real") { clear(passkeyBox); return; }
    let list = [];
    try { list = (await get("/app/v1/me/passkeys")).passkeys; } catch (e) { fill(passkeyBox, h("p", { class: "help" }, errorText(e))); return; }
    const add = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Add a passkey");
    add.addEventListener("click", () => humanCheck({
      action: "webauthn_register", title: "Add a passkey",
      lead: h("p", { class: "modal-lead" }, list.length ? "First confirm with a passkey you already have. Then set up the new one." : "Set up a passkey: Face ID, a fingerprint, your phone or a security key."),
      confirmLabel: "Add", unlockLabel: list.length ? "Confirm & add" : "Set up",
      onProof: async (proof, challenge) => {
        const body = { human_check: proof };
        if (challenge?.register?.options) body.credential = credJSON(await navigator.credentials.create({ publicKey: creationOptions(challenge.register.options) }));
        await post("/app/v1/me/passkeys", body);
      },
    }).then((ok) => { if (ok) { toast("Passkey added."); drawPasskeys(); drawReset(); } }));
    const rowsPk = list.map((k, i) => {
      const rm = h("button", { type: "button", class: "btn btn-danger-ghost btn-sm", disabled: list.length < 2, title: list.length < 2 ? "Your only passkey: add another one first" : null }, "Remove");
      rm.addEventListener("click", () => humanCheck({
        action: "passkey_remove", title: "Remove a passkey",
        lead: h("p", { class: "modal-lead" }, "Confirm with another of your passkeys, not this one."),
        confirmLabel: "Remove", notCredential: k.id,
        onProof: (proof) => post("/app/v1/me/passkeys/remove", { credential_id: k.id, human_check: proof }),
      }).then((ok) => { if (ok) { toast("Passkey removed."); drawPasskeys(); drawReset(); } }));
      return h("li", { class: "device" },
        h("span", { class: "device-ic", "aria-hidden": "true" }, icon("fingerprint", { size: 24 })),
        h("span", { class: "device-main" }, h("strong", null, `Passkey ${i + 1}`),
          h("span", { class: "device-sub" }, `added ${ago(k.created_at)}${k.created_device_label ? ` in ${k.created_device_label}` : ""}${k.last_used_at ? ` · last used ${ago(k.last_used_at)}${k.last_used_device_label ? ` in ${k.last_used_device_label}` : ""}` : ""}`)),
        rm);
    });
    fill(passkeyBox,
      h("h2", { id: "pk-h", class: "h2" }, "Passkeys"),
      h("p", { class: "help" }, "Every chat you let in asks for one. Adding one asks for one you have; removing one asks for another."),
      rowsPk.length ? h("ul", { class: "device-list" }, rowsPk) : h("p", { class: "muted" }, "No passkey yet. Your first approval sets one up."),
      h("div", { class: "row-actions" }, add));
  }

  async function refresh() {
    drawPasskeys();
    drawReset();
    try {
      const { devices } = await get("/app/v1/devices");
      box.removeAttribute("aria-busy");
      const rows = await Promise.all(devices.map(async (d) => {
        const fp = await deviceFingerprint(d.ed25519_pk);
        const mine = d.id === app.device?.id;
        const pending = !d.revoked_at && d.pending_rooms > 0;
        let action = null;
        if (pending && !mine && app.me.device?.certified_rooms > 0) {
          action = h("button", { type: "button", class: "btn btn-primary btn-sm" }, "Approve");
          action.addEventListener("click", () => approveDevice(d.id, d.label, refresh));
        }
        // Remove (a lost laptop, a shared computer). A removed browser still listed in some rooms can be finished
        // from a browser that signs there.
        let remove = null;
        if (!d.revoked_at || (d.certified_rooms > 0 && !mine)) {
          remove = h("button", { type: "button", class: "btn btn-danger-ghost btn-sm" }, d.revoked_at ? "Finish removing" : mine ? "Remove this browser" : "Remove");
          remove.addEventListener("click", () => removeBrowser(d, refresh));
        }
        return h("li", { class: ["device", mine && "is-this", d.revoked_at && "is-revoked"], style: { "flex-wrap": "wrap" } },
          h("span", { class: "device-ic", "aria-hidden": "true" }, icon("monitor", { size: 24 })),
          h("span", { class: "device-main", style: { "flex-basis": "200px" } },
            h("strong", null, d.label, mine ? h("span", { class: "badge badge-this" }, "this browser") : null),
            h("span", { class: "device-sub" },
              d.revoked_at ? `Removed ${ago(d.revoked_at)}${d.certified_rooms > 0 ? ` · still listed in ${d.certified_rooms} room${d.certified_rooms === 1 ? "" : "s"}` : ""}`
                : `${d.certified_rooms} room${d.certified_rooms === 1 ? "" : "s"} approved${pending ? ` · ${d.pending_rooms} waiting for approval` : ""} · added `,
              d.revoked_at ? null : h("time", { datetime: d.created_at, title: absTime(d.created_at) }, ago(d.created_at))),
            fp !== d.fingerprint ? h("b", { class: "device-sub warn" }, "This browser's key doesn't check out. Don't approve it.") : null,
            details("Details", h("p", null, "Key ", h("code", { class: "fp" }, fp), ". It never leaves that browser."))),
          h("span", { class: "device-actions", style: { display: "flex", "flex-wrap": "wrap", gap: "8px", "margin-left": "auto" } }, action, remove));
      }));
      // security review: end every other sign-in of this account (a lost laptop, a shared computer)
      const out = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Sign out other browsers");
      out.addEventListener("click", async () => {
        out.disabled = true;
        try {
          const r = await post("/app/v1/me/sessions/sign-out-others");
          toast([r.signed_out ? `Signed out ${r.signed_out} other sign-in${r.signed_out === 1 ? "" : "s"}.` : "No other browser was signed in.",
            r.delete_cancelled ? "The waiting delete of this account was cancelled." : "",
            r.first_passkey_removed ? "The passkey added when the delete was asked for was removed. Change your Google or GitHub password." : ""].filter(Boolean).join(" "),
          "success", r.delete_cancelled ? 9000 : 4000);
          if (r.delete_cancelled) { const { refreshDeleteBanner } = await import("../deletebanner.js"); refreshDeleteBanner(); refresh(); }
        }
        catch (e) { toast(errorText(e), "error"); }
        out.disabled = false;
      });
      fill(box, 
        rows.length ? h("ul", { class: "device-list" }, rows) : h("p", { class: "muted" }, "No browsers yet."),
        h("p", { class: "help" }, icon("shield", { size: 16 }), h("span", null, "Lost a laptop or phone? Remove it here, with its passkeys: its browser key stops working and its sign-ins end. A passkey kept on it keeps working until you remove that passkey too; if it is one your phone or password manager keeps in sync, add a new passkey first, confirming with it, then remove it. ",
          h("a", { href: HELP }, "What to do when a device is lost"))),
        passkeyBox, resetBox,
        h("p", { class: "fine" }, icon("shield", { size: 16 }), "Only approve browsers you use yourself."),
        h("div", { class: "row-actions" }, out),
        h("p", { class: "help" }, "Signs out every other browser now. This one stays signed in. It also cancels a waiting delete of this account."));
    } catch (e) { fill(box, errorBox(errorText(e), refresh)); }
  }
  await refreshNeeds();
  refresh();
  return { el, title: "Your browsers", refresh };
}
