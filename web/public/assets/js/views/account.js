// Your account: download everything bot-link holds about you, or delete the account (fix-all blocker 3, SPEC §6.15).
// Delete takes two steps (security re-review of fix-all). Ask: a passkey and your email; nothing changes yet, and every
// signed-in page of the account shows it (deletebanner.js) with a Cancel button. Finish, after the wait: a passkey and
// your email again; this browser signs your leave in every room someone else owns (the server can't sign a member
// list), and the server does the rest in one go: nothing changes unless all of it goes through.
import { h, fill, absTime, until, toast } from "../dom.js";
import { get, post, errorText, setCsrf } from "../api.js";
import { icon } from "../art.js";
import { signRosterEntry, forgetDevice } from "../crypto.js";
import { app, ensureDevice, store, HOST, SITE_ORIGIN, paywallOn } from "../app.js";
import { fetchVerified, notSignerError } from "../roster.js";
import { humanCheck, confirmDialog } from "../humancheck.js";
import { span } from "../recovery.js";
import { refreshDeleteBanner } from "../deletebanner.js";
import { errorBox } from "./rooms.js";
import { PAID_TEXT } from "../paid-text.js";

// What to tell a person whose passkeys are all lost: deleting needs one, so reset first (recovery.js), or read the help.
const LOST_PASSKEYS = () => h("span", null, "Lost every passkey? Deleting needs one. ",
  h("a", { href: "/devices#reset" }, "Reset your passkeys"), " under Your browsers first, or read ",
  h("a", { href: "/help/lost-passkey" }, "Lost your passkey or your laptop?"), ".");

function panel(title, ic, ...body) {
  return h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", null, icon(ic), title)),
    h("div", { class: "panel-body" }, ...body));
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

async function downloadExport(btn, status) {
  btn.disabled = true; btn.classList.add("busy"); status.textContent = "";
  try {
    const res = await fetch("/app/v1/me/export", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!res.ok) {
      let body = null; try { body = await res.json(); } catch { /* not JSON */ }
      const e = new Error("export"); e.code = body?.error?.code; e.status = res.status; e.retryAfter = body?.error?.retry_after_s; e.message = body?.error?.message || "";
      throw e;
    }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "botlink-account.json";
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name, hidden: true });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    status.textContent = `Saved ${name}.`;
  } catch (e) {
    status.textContent = errorText(e);
  } finally {
    btn.disabled = false; btn.classList.remove("busy");
  }
}

/** Sign this browser's leave (person_remove of me) in every room I'm a person in, at each room's verified head. */
async function signLeaves(plan, device) {
  const entries = [];
  for (const r of plan.joined_rooms) {
    const { verified } = await fetchVerified(r.id);
    if (![...verified.people.values()].some((p) => p.devices.has(device.pk))) throw await notSignerError(device, r.id, r.name);
    const { wire } = await signRosterEntry(device, { room: r.id, seq: verified.headSeq + 1, prev: verified.headHash, op: "person_remove", account: app.me.account.id });
    entries.push({ room_id: r.id, roster_entry: wire });
  }
  return entries;
}

/**
 * Cancel the waiting delete p: any signed-in browser of the account may, no passkey needed. When the ask set up the
 * account's first passkey (p.first_passkey), the server removes that passkey and ends every other sign-in with it.
 */
export async function cancelDelete(p, onDone) {
  let res = null;
  const ok = await confirmDialog({
    title: "Cancel the delete?",
    body: h("div", null,
      h("p", { class: "modal-lead" }, "Your account stays as it is."),
      p?.first_passkey ? h("p", { class: "modal-lead", "data-first-passkey": "" }, "A passkey was set up for this account when the delete was asked for. Cancelling here removes that passkey and signs out every other browser; this one stays signed in. If you set it up yourself, you can set up a passkey again afterwards.") : null,
      h("p", { class: "modal-lead" }, "If you didn't ask for it, change your Google or GitHub password too: whoever asked could sign in as you.")),
    confirmLabel: "Cancel the delete", onConfirm: async () => { res = await post("/app/v1/me/delete/cancel", {}); return res; },
  });
  if (ok) {
    toast(res?.first_passkey_removed
      ? "The delete is cancelled. The passkey added when the delete was asked for was removed; other sign-ins were ended. Change your Google or GitHub password."
      : "The delete is cancelled. Your account stays.", "success", res?.first_passkey_removed ? 12000 : 4000);
    await onDone?.();
  }
  return ok;
}

export default async function account() {
  const box = h("div", { "aria-busy": "true" }, h("div", { class: "sk sk-block" }), h("div", { class: "sk sk-block" }));
  const el = h("section", { class: "page page-narrow account-page" },
    h("a", { href: "/rooms", class: "back" }, icon("arrowLeft", { size: 18 }), "Your rooms"),
    h("h1", { class: "h1" }, "Your account"),
    h("p", { class: "lead small" }, `Signed in as ${app.me.account.email}.`),
    box);
  let done = false;
  let typed = () => false; // the confirmation has text in it: a live refresh must not wipe it

  function deleted(res) {
    done = true;
    app.me = null; app.needs = null; app.device = null; setCsrf(null);
    store.set("botlink-session-hint", null);
    forgetDevice().catch(() => {});
    document.querySelector("#nav-side .menu-wrap")?.remove();
    fill(el,
      h("h1", { class: "h1", tabindex: "-1" }, "Your account is deleted."),
      h("p", { class: "lead small" }, `You left ${plural(res.rooms_left, "room", "rooms")}, ${plural(res.rooms_deleted, "room", "rooms")} you owned ${res.rooms_deleted === 1 ? "is" : "are"} deleted, and every browser is signed out.`),
      h("p", { class: "help" }, "Signing in again with the same email starts a new, empty account."),
      h("div", { class: "row-actions" }, h("a", { href: "/", class: "btn btn-ghost", "data-native": "" }, "Go to the home page")));
    el.querySelector("h1").focus();
  }

  async function refresh() {
    if (done) return;
    let plan;
    try {
      plan = await get(`/app/v1/me/delete${app.device ? `?device_id=${app.device.id}` : ""}`);
    } catch (e) { box.removeAttribute("aria-busy"); fill(box, errorBox(errorText(e), refresh)); return; }
    box.removeAttribute("aria-busy");

    // ── your data
    const dlStatus = h("p", { class: "help", role: "status", "aria-live": "polite" });
    const dl = h("button", { type: "button", class: "btn btn-ghost" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-label" }, "Download my data"));
    dl.addEventListener("click", () => downloadExport(dl, dlStatus));
    const data = panel("Your data", "book",
      h("p", null, paywallOn()
        ? PAID_TEXT.exportLead
        : "One file with everything bot-link's server holds about your account: profile, sign-ins, browsers, passkeys (public part), rooms, chats and requests."),
      h("p", { class: "help" }, "Messages are sealed on your chats' computers and the server can't open them. The file counts them and gives their sizes; your chats already have the text."),
      h("div", { class: "row-actions" }, dl), dlStatus);

    // ── delete
    const owned = plan.owned_rooms, joined = plan.joined_rooms;
    const effects = h("ul", { class: "checklist" },
      joined.length ? h("li", null, icon("logout", { size: 18 }), h("span", null, `You leave ${joined.map((r) => `#${r.name} (${r.owner_name}'s)`).join(", ")}. This browser signs it.`)) : null,
      owned.length ? h("li", null, icon("trash", { size: 18 }), h("span", null, `Rooms you own are deleted: ${owned.map((r) => r.other_people ? `#${r.name} (also for ${plural(r.other_people, "other person", "other people")})` : `#${r.name}`).join(", ")}.`)) : null,
      plan.chats ? h("li", null, icon("chat", { size: 18 }), h("span", null, `Your ${plural(plan.chats, "chat", "chats")} stop working in every room, and anything waiting for them is dropped.`)) : null,
      h("li", null, icon("key", { size: 18 }), h("span", null, "Your sign-ins, browsers and passkeys are removed and every browser is signed out.")),
      h("li", null, icon("alert", { size: 18 }), h("span", null, "Once you finish it, there is no undo.")));
    const stays = h("p", { class: "help" }, h("span", null, `What stays: messages your chats sent stay with the chats that got them, and the server keeps their sealed copies until those chats read them or they expire. Your name and your chats' names and public keys stay in the signed member list of rooms you were in, because every member holds a copy. ${paywallOn() ? PAID_TEXT.paymentsStay : ""}`,
      h("a", { href: `${HOST === "app" && SITE_ORIGIN ? SITE_ORIGIN : ""}/privacy.html#rights`, "data-native": "" }, "What a delete removes"), "."));

    const blockers = [];
    if (paywallOn() && plan.plan_renews) blockers.push(h("p", { class: "help", role: "alert" }, icon("alert", { size: 18 }), h("span", null, PAID_TEXT.renewsBefore, h("a", { href: "/usage" }, PAID_TEXT.menu), PAID_TEXT.renewsAfter)));
    if (joined.length && !app.cryptoOk) blockers.push(h("p", { class: "help", role: "alert" }, icon("alert", { size: 18 }), "This browser can't sign. Use a recent Chrome, Edge, Firefox or Safari."));
    if (plan.ask_paused_until && !plan.pending) blockers.push(h("p", { class: "help", role: "alert", "data-ask-paused": "" }, icon("clock", { size: 18 }), h("span", null,
      `A browser of this account was removed or signed out recently, so asking to delete it is paused until ${absTime(plan.ask_paused_until)}.`)));
    const cannot = joined.filter((r) => !r.can_sign);
    if (cannot.length) blockers.push(h("p", { class: "help", role: "alert" }, icon("alert", { size: 18 }), h("span", null,
      `This browser isn't approved in ${cannot.map((r) => `#${r.name}`).join(", ")}, so it can't sign your leave there. Delete from a browser that is, approve this one from it, or ask the owner to remove you.`)));

    const confirmInput = h("input", { id: "delete-confirm", class: "input", type: "email", autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-describedby": "delete-confirm-help" });
    const pend = plan.pending;
    const ready = !!pend?.ready;
    const go = h("button", { type: "button", class: "btn btn-danger", disabled: true }, icon("trash", { size: 18 }), ready ? "Delete my account now" : "Ask to delete my account");
    const status = h("p", { class: "form-status", role: "alert", "aria-live": "assertive" });
    const matches = () => confirmInput.value.trim().toLowerCase() === plan.confirm_text.toLowerCase();
    typed = () => confirmInput.value.trim() !== "";
    confirmInput.addEventListener("input", () => { go.disabled = blockers.length > 0 || !matches(); status.textContent = ""; });
    const passkeyNote = plan.human_check_mode !== "real" ? null
      : plan.passkeys ? h("p", { class: "help", "data-lost-passkeys": "" }, h("span", null, "Deleting asks for one of your passkeys. ", LOST_PASSKEYS()))
        : h("p", { class: "help" }, "Deleting asks you to set up a passkey (Face ID, a fingerprint, your phone or a security key), from a sign-in in the last 5 minutes.");

    // step 1: ask (nothing is removed or signed; the wait starts)
    const ask = async () => {
      const ok = await humanCheck({
        action: "account_delete", title: "Ask to delete your account",
        lead: h("p", { class: "modal-lead" }, `Nothing is removed now. You can finish it after ${span(plan.delay_s)}. Until then every page signed in to ${app.me.account.email} shows it and can cancel it, and removing a browser or signing out the other browsers cancels it too.`),
        confirmLabel: "Ask to delete", unlockLabel: "Unlock & ask", busyLabel: "Asking…",
        onProof: (proof) => post("/app/v1/me/delete/ask", { confirm: confirmInput.value.trim(), human_check: proof }),
      });
      if (ok) { toast("Asked. Your account is not deleted yet.", "success", 5000); confirmInput.value = ""; await refresh(); refreshDeleteBanner(); }
    };
    go.addEventListener("click", async () => {
      if (!matches()) return;
      status.textContent = "";
      if (!ready) { await ask(); return; }
      let device = app.device;
      if (joined.length) {
        try { device = await ensureDevice(); } catch (e) { status.textContent = errorText(e); return; }
      }
      let result = null;
      const ok = await humanCheck({
        action: "account_delete", title: "Delete your account",
        lead: h("p", { class: "modal-lead" }, `${app.me.account.email} and everything above goes now. There is no undo.`),
        confirmLabel: "Delete", unlockLabel: "Unlock & delete", busyLabel: "Deleting…",
        onProof: async (proof) => {
          // the member lists can move while we sign (someone approves a chat): re-read and re-sign, same check
          for (let attempt = 0; ; attempt++) {
            const p = attempt ? await get(`/app/v1/me/delete${device ? `?device_id=${device.id}` : ""}`) : plan;
            const entries = await signLeaves(p, device);
            try {
              result = await post("/app/v1/me/delete", { confirm: confirmInput.value.trim(), human_check: proof, entries });
              return;
            } catch (e) {
              if (e.code === "roster_conflict" && attempt < 4) { await new Promise((r) => setTimeout(r, 150 + Math.random() * 400)); continue; }
              if (paywallOn() && e.code === "plan_renews") e.userMessage = PAID_TEXT.renewsShort;
              throw e;
            }
          }
        },
      });
      if (ok && result) deleted(result);
    });

    const cancel = h("button", { type: "button", class: "btn btn-ghost" }, "Cancel the delete");
    cancel.addEventListener("click", () => cancelDelete(pend, async () => { await refresh(); refreshDeleteBanner(); }));
    const waitNote = !pend
      ? h("p", null, `Deleting takes two steps. First you ask: nothing is removed, and every browser signed in to this account shows it and can cancel it. bot-link can't email you about it, so that note is the only warning. After ${span(plan.delay_s)} you can finish it, within ${span(plan.window_s)}. Finishing does this:`)
      : ready
        ? h("div", { class: "help", role: "status", "data-delete-state": "ready" }, icon("clock", { size: 18 }), h("span", null,
          `You asked ${absTime(pend.asked_at)}. You can finish it now, until ${absTime(pend.lapses_at)}. Finishing does this:`))
        : h("div", { class: "help", role: "status", "data-delete-state": "waiting" }, icon("clock", { size: 18 }), h("span", null,
          `Asked ${absTime(pend.asked_at)}. You can finish it from ${absTime(pend.ready_at)}${until(pend.ready_at) ? ` (in ${until(pend.ready_at)})` : ""}. Until then nothing is removed. Finishing will do this:`));
    const del = panel("Delete your account", "trash",
      waitNote, effects, stays, ...blockers, passkeyNote,
      pend && !ready ? null : h("div", { class: "field" },
        h("label", { for: "delete-confirm" }, "Type your email address to confirm"),
        confirmInput,
        h("p", { id: "delete-confirm-help", class: "help" }, plan.confirm_text)),
      h("div", { class: "row-actions" }, pend && !ready ? null : go, pend ? cancel : null), status);
    fill(box, data, del);
    if (blockers.length || (pend && !ready)) confirmInput.disabled = true;
  }

  await refresh();
  // live updates (another tab, a room change) redraw the page, but never under an open dialog or a typed confirmation
  return { el, title: "Your account", refresh: () => { if (!done && !typed() && !document.querySelector("dialog[open]")) refresh(); } };
}
