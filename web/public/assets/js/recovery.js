// Lost passkey / lost laptop (prod-readiness blocker 5). The passkey reset (ask, wait, cancel, finish), removing a
// browser, and the banner every signed-in page shows while a reset waits. Server: appapi/recovery.go, devremove.go.
//
// app.js imports this module for its banner; this module imports app.js back. It only reads app.js's exports from
// functions that run after both have loaded (the first one is queued below), never while the modules load.
import { h, $, fill, toast, absTime, until, ago } from "./dom.js";
import { get, post, errorText } from "./api.js";
import { icon } from "./art.js";
import { deviceLabel, forgetDevice, signRosterEntry, utf8, toHex, b64urlDecode } from "./crypto.js";
import { humanCheck, confirmDialog } from "./humancheck.js";
import { fetchVerified } from "./roster.js";
import * as shell from "./app.js";

export const HELP = "/help/lost-passkey";
const REAUTH = `/login?reauth=1&return_to=${encodeURIComponent("/devices")}`;

export const loadReset = () => get("/app/v1/me/passkey-reset");

/** "3 days", "36 hours", "10 minutes". */
export function span(seconds) {
  if (seconds >= 86400 && seconds % 86400 === 0) { const d = seconds / 86400; return `${d} day${d === 1 ? "" : "s"}`; }
  if (seconds >= 3600 && seconds % 3600 === 0) { const hr = seconds / 3600; return `${hr} hour${hr === 1 ? "" : "s"}`; }
  const m = Math.max(1, Math.round(seconds / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

const helpLink = (text = "How this works") => h("a", { href: HELP, class: "btn btn-ghost btn-sm" }, icon("book", { size: 16 }), text);

function signInAgain(st, what) {
  return confirmDialog({
    title: "Sign in again first",
    body: h("p", { class: "modal-lead" }, `To ${what}, bot-link needs a sign-in from the last ${span(st.signin_max_age_s)}. Sign in again, then come back to Your browsers.`),
    confirmLabel: "Sign in again",
  }).then((ok) => { if (ok) location.href = REAUTH; return false; });
}

async function changed(onDone) {
  await shell.refreshNeeds().catch(() => {});
  await refreshBanner();
  onDone?.();
}

/** Ask for a reset (Your browsers). */
export async function askReset(st, onDone) {
  if (!st.signin_fresh) return signInAgain(st, "reset your passkeys");
  const ok = await confirmDialog({
    title: "Reset your passkeys?",
    body: h("div", null,
      h("p", { class: "modal-lead" }, `Only if no passkey of yours works any more. You can set up a new one in this browser after ${span(st.delay_s)}.`),
      h("p", { class: "modal-lead" }, "Until then, approving a chat still needs one of your passkeys. Every page you're signed in on shows the reset, and it can be cancelled there. When you set up the new passkey, your old ones stop working and your other browsers are signed out."),
      h("p", { class: "modal-lead" }, "A new passkey does not make this browser a member of your rooms' lists. If you also lost the browser you used there, read ", h("a", { href: `${HELP}#not-back` }, "what a reset does not give back"), " first.")),
    confirmLabel: "Ask for a reset",
    onConfirm: () => post("/app/v1/me/passkey-reset"),
  });
  if (ok) { toast(`Reset asked. Come back to this browser in ${span(st.delay_s)}.`, "success", 6000); await changed(onDone); }
  return ok;
}

/** Cancel the waiting reset: from an older sign-in with a click, otherwise with a passkey. */
export async function cancelReset(st, onDone) {
  let ok;
  if (!st.reset.cancel_needs_passkey) {
    ok = await confirmDialog({
      title: "Cancel the passkey reset?",
      body: "Your passkeys stay as they are. If you didn't ask for it, change your Google or GitHub password too: whoever asked could sign in as you.",
      confirmLabel: "Cancel the reset", danger: true,
      onConfirm: () => post("/app/v1/me/passkey-reset/cancel", {}),
    });
  } else {
    ok = await humanCheck({
      action: "passkey_reset_cancel", startPath: "/app/v1/me/passkey-reset/check", startBody: { action: "cancel" },
      title: "Cancel the passkey reset",
      lead: "This browser signed in after the reset was asked, so confirm with one of your passkeys.",
      confirmLabel: "Cancel the reset", unlockLabel: "Unlock & cancel", busyLabel: "Cancelling…",
      onProof: (proof) => post("/app/v1/me/passkey-reset/cancel", { human_check: proof }),
    });
  }
  if (ok) { toast("The passkey reset is cancelled.", "success"); await changed(onDone); }
  return ok;
}

/** Finish a ready reset in the browser that asked: the new passkey replaces every old one. */
export async function finishReset(st, onDone) {
  if (!st.signin_fresh) return signInAgain(st, "set up your new passkey");
  const ok = await humanCheck({
    action: "passkey_reset_finish", startPath: "/app/v1/me/passkey-reset/check", startBody: { action: "finish" },
    title: "Set up your new passkey",
    lead: "Your old passkeys stop working and your other browsers are signed out.",
    registerTitle: "Set up your new passkey", registerSub: "Face ID, a fingerprint, your phone or a security key.",
    confirmLabel: "Set up", unlockLabel: "Set up", busyLabel: "Setting up…",
    onProof: (proof) => post("/app/v1/me/passkey-reset/finish", { human_check: proof }),
  });
  if (ok) { toast("Your new passkey is set up. Your old ones no longer work.", "success", 6000); await changed(onDone); }
  return ok;
}

/** The reset as a card: on every page (banner) and on Your browsers. */
export function resetCard(st, onDone) {
  const r = st.reset;
  const from = r.user_agent ? deviceLabel(r.user_agent) : "a browser";
  const left = until(r.ready_at);
  const cancel = h("button", { type: "button", class: ["btn", "btn-sm", r.started_here ? "btn-ghost" : "btn-danger-ghost"] }, "Cancel the reset");
  cancel.addEventListener("click", () => cancelReset(st, onDone));
  let title, body, actions;
  if (r.started_here && r.ready) {
    title = "Your passkey reset is ready.";
    body = "Set up your new passkey now, in this browser. Your old passkeys then stop working.";
    const go = h("button", { type: "button", class: "btn btn-primary btn-sm" }, icon("fingerprint", { size: 16 }), "Set up new passkey");
    go.addEventListener("click", () => finishReset(st, onDone));
    actions = [go, cancel];
  } else if (r.started_here) {
    title = "You asked to reset your passkeys.";
    body = `You can set up a new passkey in this browser from ${absTime(r.ready_at)}${left ? ` (in ${left})` : ""}. Until then, approving a chat still needs one of your passkeys.`;
    actions = [cancel, helpLink()];
  } else {
    title = "A passkey reset was asked for your account.";
    body = `Asked ${absTime(r.created_at)} from ${from}. ${r.ready ? "It can be finished now, in that browser." : `If nobody cancels it, a new passkey can replace yours from ${absTime(r.ready_at)}.`} Not you? Cancel it now and change your Google or GitHub password.`;
    actions = [cancel, helpLink("What is this?")];
  }
  return h("div", { class: ["banner", r.started_here ? "banner-sun" : "banner-coral"], role: r.started_here ? "status" : "alert", "data-reset": r.ready ? "ready" : "waiting" },
    icon(r.started_here ? "clock" : "alert", { size: 22 }),
    h("div", null, h("strong", null, title), h("p", null, body), h("div", { class: "row-actions" }, actions)));
}

// A passkey that became the account's FIRST one after this browser signed in (account_guard.go, third security pass):
// this browser may remove it without a passkey until fp.until. Someone with only the Google or GitHub sign-in can set
// one up; then the owner's approvals need it. "It was me" hides the note in this browser.
const FIRST_OK = "botlink-first-passkey-ok";
function firstPasskeyCard(fp, onDone) {
  const from = fp.user_agent ? deviceLabel(fp.user_agent) : "a browser";
  const rm = h("button", { type: "button", class: "btn btn-danger-ghost btn-sm" }, "Remove that passkey");
  rm.addEventListener("click", async () => {
    let res = null;
    const ok = await confirmDialog({
      title: "Remove the new passkey?",
      body: h("div", null,
        h("p", { class: "modal-lead" }, "This removes every passkey of this account set up since then, and signs out every browser that signed in after this one. A waiting passkey reset or account delete is cancelled."),
        h("p", { class: "modal-lead" }, "Change the password of your Google or GitHub account first: whoever set it up can sign in as you and set up another one.")),
      confirmLabel: "Remove it", danger: true,
      onConfirm: async () => { res = await post("/app/v1/me/first-passkey/remove", {}); return res; },
    });
    if (ok) { toast(`Removed ${res?.passkeys_removed === 1 ? "the passkey" : `${res?.passkeys_removed || 0} passkeys`}. ${res?.sign_ins_ended ? `${res.sign_ins_ended} newer sign-in${res.sign_ins_ended === 1 ? " was" : "s were"} ended.` : ""}`, "success", 8000); await changed(onDone); }
  });
  const mine = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "It was me");
  mine.addEventListener("click", () => { try { localStorage.setItem(FIRST_OK, fp.made_at); } catch { /* private mode: it shows again */ } refreshBanner(); });
  return h("div", { class: "banner banner-sun", role: "status", "data-first-passkey-undo": "" }, icon("fingerprint", { size: 22 }),
    h("div", { style: { "min-width": "0" } }, h("strong", null, "A first passkey was set up for your account."),
      h("p", null, `Set up ${ago(fp.made_at)} on ${from}, after this browser signed in. From now on approving needs it. If it wasn't you, remove it here: this browser can, without a passkey, until ${absTime(fp.until)}.`),
      h("div", { class: "row-actions" }, rm, mine, helpLink("What is this?"))));
}

function removedCard() {
  const again = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Start over in this browser");
  again.addEventListener("click", async () => { await forgetDevice().catch(() => {}); location.reload(); });
  return h("div", { class: "banner banner-coral", role: "alert", "data-removed": "" }, icon("alert", { size: 22 }),
    h("div", null, h("strong", null, "This browser was removed from your account."),
      h("p", null, "It can't approve or change anything in your rooms. If you still use it, start over here and approve it from another browser."),
      h("div", { class: "row-actions" }, again)));
}

// ── the banner on every signed-in page ───────────────────────────────────────
// Tell the server which browser key this sign-in uses, once per sign-in and key: it records where a passkey is made or
// used, so removing a browser can offer to remove the passkeys that live there. A hint, never a permission.
let boundFor = "";
function bindBrowser(me) {
  const dev = shell.app.device;
  if (!dev || me.device?.revoked_at) return;
  const key = `${me.csrf_token}|${dev.id}`;
  if (boundFor === key) return;
  boundFor = key;
  proveBrowser(dev).catch(() => { boundFor = ""; });
}

// The proof: a challenge from the server, signed with this browser's own key (the key never leaves the browser). The
// server records this sign-in as this browser only when the signature checks out with the key it holds for it.
const PROOF_CTX = "botlink-browser-proof-v1\n";
async function proveBrowser(dev) {
  const ch = await post("/app/v1/me/browser/challenge", {});
  const msg = [...utf8(PROOF_CTX), ...b64urlDecode(ch.challenge), ...utf8(dev.id)];
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", dev.keyPair.privateKey, new Uint8Array(msg)));
  await post("/app/v1/me/browser", { device_id: dev.id, proof_id: ch.id, sig: toHex(sig) });
}

let host = null, seq = 0;
export async function refreshBanner() {
  const mine = ++seq;
  const me = shell.app.me;
  if (me) bindBrowser(me);
  let st = null;
  if (me) { try { st = await loadReset(); } catch { st = null; } }
  if (mine !== seq) return;
  const cards = [];
  if (me?.device?.revoked_at) cards.push(removedCard());
  if (st?.reset) cards.push(resetCard(st));
  let okd = null;
  try { okd = localStorage.getItem(FIRST_OK); } catch { okd = null; }
  // the page under it redraws too (Your browsers lists the passkeys and the recent changes)
  const redraw = () => shell.app.listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  if (st?.first_passkey_undo && okd !== st.first_passkey_undo.made_at) cards.push(firstPasskeyCard(st.first_passkey_undo, redraw));
  if (!cards.length) { host?.remove(); host = null; return; }
  if (!host) {
    host = h("div", { class: "page recovery-banners", style: { "padding-top": "16px", "padding-bottom": "0", "animation": "none" } });
    $("#main")?.before(host);
  }
  fill(host, cards);
}
setTimeout(() => { shell.onChange(refreshBanner); refreshBanner(); }, 0);

// ── removing a browser ───────────────────────────────────────────────────────
/**
 * Remove device d ("Remove this browser" when it is this one). This browser signs one device_remove per room where d is
 * listed and this browser may sign it; the server refuses d from then on either way. Resolves true when done.
 */
export async function removeBrowser(d, onDone) {
  const me = shell.app.me.account.id;
  const self = d.id === shell.app.device?.id;
  const plan = []; // rooms that list d: {id, name, canSign, lonely, owned}
  try {
    const { rooms } = await get("/app/v1/rooms");
    for (const r of rooms) {
      let v;
      try { ({ verified: v } = await fetchVerified(r.id)); } catch { continue; }
      const p = v.people.get(me);
      if (!p?.devices.has(d.ed25519_pk)) continue;
      const pk = shell.app.device?.pk;
      const canSign = !!pk && (p.devices.has(pk) || !!v.people.get(v.owner)?.devices.has(pk));
      plan.push({ id: r.id, name: v.roomName || r.name, canSign, lonely: p.devices.size === 1, owned: v.owner === me });
    }
  } catch (e) { toast(errorText(e), "error"); return false; }
  // The account's passkeys, in three groups (security review of fix-all, finding 2, and its re-review):
  //   - made or last used in that browser (its place proved by its own key): ticked;
  //   - made in another of your browsers: not ticked;
  //   - place unknown (made before 16 Nov 2026, or in a sign-in that proved no browser): keep or remove, no default.
  // A passkey kept on that computer keeps working until it is removed.
  let keys = [];
  try { keys = (await get("/app/v1/me/passkeys")).passkeys; } catch { keys = []; }
  // the delete wait's numbers, for the note below (account_data.go)
  let del = null;
  try { del = await get("/app/v1/me/delete"); } catch { del = null; }
  const place = (id, lbl) => (id === d.id ? (self ? "this browser" : `${d.label}, the one you're removing`) : id === shell.app.device?.id ? "this browser" : lbl);
  const where = (k) => [k.created_device_label && `made in ${place(k.created_device_id, k.created_device_label)}`,
    k.last_used_device_label && `last used in ${place(k.last_used_device_id, k.last_used_device_label)}`].filter(Boolean).join(", ");
  const BOX = { width: "44px", height: "44px", "min-width": "44px", "min-height": "44px", margin: "0", flex: "0 0 auto", "accent-color": "var(--blue, #2c5fe0)" };
  const ROW = { display: "flex", gap: "10px", "align-items": "center", "min-height": "44px", "flex-wrap": "wrap" };
  const name = (k) => `Passkey ${keys.indexOf(k) + 1}`;
  const there = keys.filter((k) => k.created_device_id === d.id || k.last_used_device_id === d.id);
  const unknown = keys.filter((k) => !there.includes(k) && !k.created_device_id);
  const elsewhere = keys.filter((k) => !there.includes(k) && !unknown.includes(k));
  const tick = (k, checked) => {
    const box = h("input", { type: "checkbox", id: `rm-pk-${k.id}`, value: k.id, checked, style: BOX, "data-passkey": "tick" });
    return h("label", { for: `rm-pk-${k.id}`, class: "rm-passkey", style: { ...ROW, "flex-wrap": "nowrap" } }, box,
      h("span", { style: { flex: "1", "min-width": "0" } }, h("strong", null, name(k)), ` · ${where(k)}`));
  };
  const choose = (k) => {
    const opt = (v, text) => h("label", { style: { display: "inline-flex", gap: "8px", "align-items": "center", "min-height": "44px" } },
      h("input", { type: "radio", name: `rm-pk-${k.id}`, value: v, style: BOX, "data-passkey": "choose", "data-id": k.id }), text);
    return h("div", { class: "rm-passkey rm-unknown", role: "radiogroup", "aria-label": name(k), style: ROW },
      h("strong", null, name(k)), opt("keep", "Keep"), opt("remove", "Remove"));
  };
  const group = (title, note, rows) => rows.length ? h("fieldset", { class: "rm-passkeys", style: { border: "0", padding: "0", margin: "0 0 12px" } },
    h("legend", { class: "modal-lead" }, h("strong", null, title), note ? ` ${note}` : ""), rows) : null;
  const choice = (root) => {
    const drop = [], keep = [], open = [];
    for (const b of root.querySelectorAll("input[data-passkey=tick]")) (b.checked ? drop : keep).push(b.value);
    for (const k of unknown) {
      const v = root.querySelector(`input[name="rm-pk-${k.id}"]:checked`)?.value;
      if (v === "remove") drop.push(k.id); else if (v === "keep") keep.push(k.id); else open.push(k);
    }
    return { drop, keep, open };
  };
  const unsignable = plan.filter((x) => !x.canSign);
  const stuck = plan.filter((x) => x.lonely && x.owned);
  const lonelyJoined = plan.filter((x) => x.lonely && !x.owned);
  const label = self ? "this browser" : d.label;
  const freezeBox = stuck.length ? h("input", { type: "checkbox", id: "rm-freeze", style: BOX }) : null;
  const lead = h("div", null,
    h("p", { class: "modal-lead" }, self
      ? "This browser's key stops working in your rooms at once, and it signs out here."
      : `${d.label}'s browser key stops working in your rooms at once, and its sign-ins end. Your other browsers are signed out too; this one stays signed in.`),
    keys.length ? h("p", { class: "modal-lead" }, h("strong", null, "Passkeys. "),
      "A passkey kept on that computer keeps working until you remove it. With it, whoever holds that computer and can sign in to your Google or GitHub account there can still remove your other browsers, add passkeys, cancel a passkey reset and ask to delete this account.") : null,
    group(`Made or last used in ${self ? "this browser" : d.label}:`, "ticked, so they are removed with it.", there.map((k) => tick(k, true))),
    group("Made in your other browsers:", "A passkey your phone or password manager keeps in sync can be on more than one computer. This list shows only where each one was made and last used, so one of these may also be on the computer you're removing.", elsewhere.map((k) => tick(k, false))),
    group("bot-link can't tell where these live.", "They were made before bot-link recorded it, or in a browser that didn't prove which one it is. They may be on the computer you're removing. Choose for each.", unknown.map(choose)),
    keys.length ? h("div", { class: "modal-lead", "data-answering": "" },
      h("p", null, "The passkey you confirm with now stays, even if you chose to remove it. If that same passkey is also on the computer you're removing (one your phone or password manager keeps in sync), removing the browser doesn't lock out whoever has that computer. Then, on Your browsers under Passkeys:"),
      h("ol", { style: { margin: "6px 0 0", "padding-left": "22px" } },
        h("li", null, "Add a new passkey, confirming with the old one."),
        h("li", null, "Remove the old one, confirming with the new one. After that it works nowhere."))) : null,
    h("p", { class: "modal-lead", "data-delete-note": "" }, del?.pending
      ? "This also cancels the delete of this account that is waiting."
      : `Removing a browser also cancels a waiting delete of this account, and nobody can ask to delete it for the next ${del ? span(del.ask_hold_s || 86400) : "day"}.`,
      ` Someone who keeps a passkey of yours can still ask to delete it later. That waits ${del ? span(del.delay_s) : "a few days"} and shows on every page you're signed in on, where you can cancel it if you see it. bot-link can't email you about it.`),
    unsignable.length ? h("p", { class: "modal-lead" }, `${unsignable.map((x) => `#${x.name}`).join(", ")} will still list it until a browser of yours that can sign there finishes this. bot-link refuses it everywhere from now on.`) : null,
    lonelyJoined.length ? h("p", { class: "modal-lead" }, `In ${lonelyJoined.map((x) => `#${x.name}`).join(", ")} (other people's rooms) you won't be able to bring in or remove your own chats any more; the owner can still remove you.`) : null,
    stuck.length ? h("div", { class: "modal-lead", role: "note", "data-freeze": String(stuck.length) },
      h("p", null, h("strong", null, "Careful: "), `in ${stuck.length} room${stuck.length === 1 ? "" : "s"} you own (${stuck.map((x) => `#${x.name}`).join(", ")}) this is the only browser that can approve or remove members. After removal nobody can change who is in ${stuck.length === 1 ? "it" : "them"}, and a removed browser can't be brought back.`),
      h("p", null, self
        ? h("span", null, "To avoid this, sign in on another browser first and approve it from this one on ", h("a", { href: "/devices" }, "Your browsers"), "; then remove this one.")
        : "This can't be avoided from here: only that browser could approve another one there."),
      h("label", { for: "rm-freeze", style: ROW }, freezeBox, "I understand: nobody can change who is in these rooms after this.")) : null);
  let result = null;
  const ok = await humanCheck({
    action: "device_remove", targetId: d.id,
    title: self ? "Remove this browser?" : `Remove ${d.label}?`, lead,
    confirmLabel: "Remove", unlockLabel: "Unlock & remove", busyLabel: "Removing…",
    onProof: async (proof) => {
      const signed = new Map();
      const sign = async (roomId) => {
        const { verified } = await fetchVerified(roomId);
        const { wire } = await signRosterEntry(shell.app.device, { room: roomId, seq: verified.headSeq + 1, prev: verified.headHash, op: "device_remove", account: me, device: d.ed25519_pk });
        signed.set(roomId, wire);
      };
      // the choices first: every passkey of unknown place needs keep or remove; frozen rooms need the tick
      const { drop, keep, open } = choice(lead);
      if (open.length) { const e = new Error("choose"); e.userMessage = `Choose keep or remove for ${open.map(name).join(", ")} first.`; throw e; }
      if (freezeBox && !freezeBox.checked) { const e = new Error("freeze"); e.userMessage = "Tick “I understand” for the rooms that can't change after this, or keep the browser."; throw e; }
      for (const x of plan) if (x.canSign) await sign(x.id);
      for (let attempt = 0; ; attempt++) {
        try {
          result = null;
          result = await post(`/app/v1/devices/${d.id}/remove`, { human_check: proof, this_browser: self, passkey_ids: drop, keep_ids: keep, freeze_ok: !!freezeBox?.checked,
            entries: [...signed].map(([room_id, roster_entry]) => ({ room_id, roster_entry })) });
          return result;
        } catch (e) {
          if (e.code !== "roster_conflict" || attempt >= 4) throw e;
          await new Promise((res) => setTimeout(res, 100 + Math.random() * 400));
          for (const id of e.details?.room_ids || [...signed.keys()]) { signed.delete(id); await sign(id); }
        }
      }
    },
  });
  if (!ok) return false;
  if (self) {
    await forgetDevice().catch(() => {});
    toast("This browser is removed and signed out.", "success", 5000);
    setTimeout(() => { location.href = "/login"; }, 600);
    return true;
  }
  const n = result?.passkeys_removed || 0;
  const kept = keys.length - n;
  toast([`Removed ${label}${n ? ` and ${n} passkey${n === 1 ? "" : "s"}` : ""}. Its browser key no longer works and your other browsers were signed out.`,
    result?.answering_kept ? "The passkey you confirmed with stayed although you chose to remove it: if it's also on that computer, add a new passkey here and then remove it." : "",
    unsignable.length ? `${unsignable.map((x) => `#${x.name}`).join(", ")} still list${unsignable.length === 1 ? "s" : ""} it: finish from a browser that can sign there.` : "",
    kept > 0 ? `${kept === 1 ? "The passkey" : `The ${kept} passkeys`} you kept still work${kept === 1 ? "s" : ""} wherever ${kept === 1 ? "it is" : "they are"} kept.` : ""].filter(Boolean).join(" "), "success", 9000);
  await changed(onDone);
  return true;
}
