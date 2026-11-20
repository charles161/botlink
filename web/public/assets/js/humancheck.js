// The human check on every approve (SPEC §4.1): Turnstile + WebAuthn (register the first time; this device's
// Face ID / fingerprint / Windows Hello, or a phone or security key when it has none), or {"stub": true} in dev stub
// mode. Rendered as a modal dialog.
import { h, clear } from "./dom.js";
import { post, errorText } from "./api.js";
import { icon } from "./art.js";
import { b64urlDecode, b64urlEncode } from "./crypto.js";

// Letting a chat in (a join approval, a room a chat asked for) and letting bot-link call an address a chat asked for
// ask the passkey on every request, and a fresh sign-in never stands in for it (security review 12 Nov 2026;
// docs/protocol/room-drafts.md §3, docs/protocol/event-url-approval.md §3).
const PASSKEY_EACH_TIME = new Set(["approve_join", "approve_joins", "confirm_room", "approve_event_url"]);
const EACH_TIME = { approve_join: "Face ID, fingerprint or Windows Hello. Asked each time a chat comes in.", approve_joins: "Face ID, fingerprint or Windows Hello, to let these chats in. Asked each time.", confirm_room: "Face ID, fingerprint or Windows Hello, to make this room. Asked each time.",
  approve_event_url: "Face ID, fingerprint or Windows Hello, to let bot-link call this address. Asked each time." };

// ── Turnstile (loaded only when a real check needs it; CSP allows challenges.cloudflare.com) ──
let turnstileReady = null;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileReady) return turnstileReady;
  turnstileReady = new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    sc.async = true;
    sc.onload = () => {
      const wait = (n) => window.turnstile ? resolve(window.turnstile) : n > 50 ? reject(new Error("turnstile")) : setTimeout(() => wait(n + 1), 50);
      wait(0);
    };
    sc.onerror = () => { turnstileReady = null; reject(new Error("turnstile")); };
    document.head.append(sc);
  });
  return turnstileReady;
}

// ── WebAuthn JSON helpers (use the native parsers where the browser has them) ──
const buf = (s) => b64urlDecode(s).buffer;
export function creationOptions(o) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
  return { ...o, challenge: buf(o.challenge), user: { ...o.user, id: buf(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: buf(c.id) })) };
}
function requestOptions(o) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
  return { ...o, challenge: buf(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: buf(c.id) })) };
}
// The passkey being removed may not vouch for its own removal (the server refuses it), so the browser is not offered it.
function withoutCredential(o, id) {
  return id && o?.allowCredentials ? { ...o, allowCredentials: o.allowCredentials.filter((c) => c.id !== id) } : o;
}
export function credJSON(c) {
  if (typeof c.toJSON === "function") { try { return c.toJSON(); } catch { /* fall through */ } }
  const r = c.response, e = (b) => (b ? b64urlEncode(new Uint8Array(b)) : undefined);
  const response = r.attestationObject
    ? { clientDataJSON: e(r.clientDataJSON), attestationObject: e(r.attestationObject), transports: r.getTransports?.() || [] }
    : { clientDataJSON: e(r.clientDataJSON), authenticatorData: e(r.authenticatorData), signature: e(r.signature), userHandle: e(r.userHandle) };
  return { id: c.id, rawId: e(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment || undefined, response, clientExtensionResults: c.getClientExtensionResults?.() || {} };
}
async function platformAuthenticator() {
  try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch { return false; }
}

/**
 * Open the approve dialog.
 * opts: {action, targetId, targets (the request ids a batch approval is bound to), startPath (a route that issues the challenge itself, e.g. the admin unlock or a passkey reset),
 *   startBody (its JSON body), title, lead (node|string), facts (node), confirmLabel, registerTitle/registerSub (the
 *   register step's words), notCredential (a passkey id that must not answer: the one being removed),
 *   onProof: async (proof) => void}
 * onProof does the actual approve call; if it throws, the dialog shows the error and stays open.
 * Resolves true when approved, false when dismissed.
 */
export function humanCheck(opts) {
  return new Promise((resolve) => {
    const status = h("p", { class: "hc-status", role: "status", "aria-live": "polite" });
    const steps = h("ol", { class: "hc-steps" });
    const tsBox = h("div", { class: "hc-turnstile" });
    const cancel = h("button", { type: "button", class: "btn btn-ghost" }, "Not now");
    const go = h("button", { type: "button", class: "btn btn-primary", disabled: true }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-label" }, "Getting ready…"));
    // No Face ID or fingerprint on this computer: a phone (QR) or a security key works; a fresh sign-in is the way out
    // only while the account has no passkey yet (the server never takes it in place of one).
    const alt = h("p", { class: "hc-alt", hidden: true }, "No phone or key at hand? ",
      h("button", { type: "button", class: "hc-alt-link" }, "Sign in again instead"), " (counts for 5 minutes).");
    alt.querySelector("button").addEventListener("click", () => { finish(false); location.href = `/login?reauth=1&return_to=${encodeURIComponent(location.pathname)}`; });
    // A passkey is asked for: say where to go when it is gone (lost-passkey help, prod-readiness blocker 5).
    const lost = h("p", { class: "hc-alt", hidden: true }, h("a", { href: "/help/lost-passkey", class: "hc-alt-link" }, "Lost your passkey or your laptop?"));
    lost.querySelector("a").addEventListener("click", () => finish(false));
    const dlg = h("dialog", { class: "modal hc", "aria-labelledby": "hc-title" },
      h("div", { class: "modal-body" },
        h("div", { class: "hc-mark", "aria-hidden": "true" }, icon("fingerprint", { size: 30 })),
        h("h2", { id: "hc-title", class: "modal-title" }, opts.title || "You're the human here."),
        typeof opts.lead === "string" ? h("p", { class: "modal-lead" }, opts.lead) : opts.lead,
        opts.facts || null,
        steps, tsBox, status,
        h("div", { class: "modal-actions" }, cancel, go),
        alt, lost));
    document.body.append(dlg);

    let challenge = null, tsToken = null, tsWidget = null, done = false, busy = false;
    const setGo = (label, enabled, spinning = false) => {
      go.querySelector(".btn-label").textContent = label;
      go.disabled = !enabled; go.classList.toggle("busy", spinning);
    };
    const step = (state, title, sub) => h("li", { class: ["hc-step", `is-${state}`] },
      h("span", { class: "hc-dot", "aria-hidden": "true" }, state === "done" ? icon("check", { size: 16 }) : state === "warn" ? "!" : ""),
      h("span", null, h("strong", null, title), sub ? h("small", null, sub) : null));
    const finish = (ok) => {
      if (done) return; done = true;
      try { if (tsWidget !== null) window.turnstile?.remove(tsWidget); } catch { /* ignore */ }
      dlg.close(); dlg.remove(); resolve(ok);
    };
    cancel.addEventListener("click", () => finish(false));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (!busy) finish(false); });
    dlg.addEventListener("click", (e) => { if (e.target === dlg && !busy) finish(false); });

    let noPlatform = false;
    async function start() {
      status.textContent = "";
      try {
        challenge = opts.startPath ? await post(opts.startPath, opts.startBody)
          : opts.targets ? await post("/app/v1/human-check", { action: opts.action, target_id: opts.targetId, targets: opts.targets })
          : await post("/app/v1/human-check", { action: opts.action, target_id: opts.targetId });
      } catch (e) { status.textContent = errorText(e); setGo("Try again", true); go.onclick = start; return; }
      clear(steps);
      if (challenge.mode === "stub") {
        steps.append(step("done", "Human check (dev mode)", "This server runs with a stand-in check. Real servers ask for Face ID, fingerprint or Windows Hello."));
        setGo(opts.confirmLabel || "Approve", true);
        go.onclick = () => submit({ id: challenge.id, stub: true });
        return;
      }
      const wstep = challenge.webauthn?.step || "skip";
      noPlatform = wstep !== "skip" && !(await platformAuthenticator());
      if (wstep === "skip") steps.append(step("done", "This device is unlocked", "You confirmed it's you in the last hour."));
      else if (noPlatform) steps.append(step("todo", "Use your phone or a security key", "No Face ID or fingerprint on this computer. Your browser shows a QR code to scan with your phone, or asks you to touch your key."));
      else steps.append(step("todo", wstep === "register" ? (opts.registerTitle || "Set up Face ID or fingerprint") : "Unlock this device", wstep === "register" ? (opts.registerSub || "First approval from this account. Takes a second.") : EACH_TIME[opts.action] || "Face ID, fingerprint or Windows Hello."));
      lost.hidden = wstep !== "assert";
      steps.append(step(challenge.turnstile_site_key ? "todo" : "done", "Human check", "Only people can approve. Agents can't use this page."));
      if (challenge.turnstile_site_key) {
        tsBox.append(h("div", { class: "hc-ts-slot" }));
        try {
          const ts = await loadTurnstile();
          tsWidget = ts.render(tsBox.firstChild, {
            sitekey: challenge.turnstile_site_key, theme: "auto", size: "flexible", action: opts.action,
            callback: (t) => { tsToken = t; steps.lastChild.className = "hc-step is-done"; ready(); },
            "expired-callback": () => { tsToken = null; ready(); },
            "error-callback": () => { tsToken = null; status.textContent = "The human check didn't load. Try again."; },
          });
        } catch { status.textContent = "The human check couldn't load. Check your connection and try again."; }
      }
      ready();
    }
    function ready() {
      // a join approval needs the passkey every time (security review 12 Nov 2026): signing in again doesn't count
      // a delete asks for a passkey on each request too (EveryTime): a fresh sign-in never stands in for it
      alt.hidden = !noPlatform || PASSKEY_EACH_TIME.has(opts.action) || opts.action === "account_delete" || challenge.webauthn?.step !== "register" || opts.action === "passkey_reset_finish";
      const need = !!challenge.turnstile_site_key && !tsToken;
      const label = challenge.webauthn?.step && challenge.webauthn.step !== "skip" ? (noPlatform ? "Use phone or key" : (opts.unlockLabel || "Unlock & approve")) : (opts.confirmLabel || "Approve");
      setGo(need ? "Finish the check above" : label, !need);
      go.onclick = async () => {
        const proof = { id: challenge.id };
        if (tsToken) proof.turnstile_token = tsToken;
        const w = challenge.webauthn;
        if (w && w.step !== "skip") {
          setGo("Waiting for your device…", false, true);
          try {
            const cred = w.step === "register"
              ? await navigator.credentials.create({ publicKey: creationOptions(w.options) })
              : await navigator.credentials.get({ publicKey: requestOptions(withoutCredential(w.options, opts.notCredential)), mediation: "required" });
            proof.webauthn = credJSON(cred);
          } catch (e) {
            status.textContent = e?.name === "NotAllowedError" ? (noPlatform ? (PASSKEY_EACH_TIME.has(opts.action) ? "That was cancelled or timed out. Try again with your phone or key." : "That was cancelled or timed out. Try again, or sign in again instead.") : "Unlock was cancelled. Try again when you're ready.") : "This device couldn't confirm it's you. Try again.";
            ready(); return;
          }
        }
        submit(proof);
      };
    }
    async function submit(proof) {
      busy = true; cancel.disabled = true;
      setGo(opts.busyLabel || "Approving…", false, true);
      status.textContent = "";
      try {
        await opts.onProof(proof, challenge);
        busy = false;
        finish(true);
      } catch (e) {
        busy = false; cancel.disabled = false;
        status.textContent = e?.userMessage || errorText(e, opts.errorCtx);
        // the account's first passkey needs a fresh sign-in (passkey follow-up): offer the way there
        if (e?.details?.reason === "fresh_login_required") alt.hidden = false;
        if (e?.code === "human_check_failed" || e?.fatal) { setGo("Start over", true); go.onclick = () => { tsToken = null; if (tsWidget !== null) { try { window.turnstile?.reset(tsWidget); } catch { /* ignore */ } } start(); }; }
        else if (e?.code === "already_decided" || e?.code === "not_found") { setGo("Close", true); go.onclick = () => finish(false); }
        else { setGo("Try again", true); go.onclick = () => submit(proof); }
      }
    }
    dlg.showModal();
    start();
  });
}

/** A plain confirm dialog (remove, leave, delete). Resolves true/false. */
export function confirmDialog({ title, body, confirmLabel = "Confirm", danger = false, onConfirm }) {
  return new Promise((resolve) => {
    const status = h("p", { class: "hc-status", role: "status", "aria-live": "polite" });
    const cancel = h("button", { type: "button", class: "btn btn-ghost" }, "Cancel");
    const ok = h("button", { type: "button", class: ["btn", danger ? "btn-danger" : "btn-primary"] }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-label" }, confirmLabel));
    const dlg = h("dialog", { class: "modal", "aria-labelledby": "cd-title" },
      h("div", { class: "modal-body" },
        h("h2", { id: "cd-title", class: "modal-title small" }, title),
        typeof body === "string" ? h("p", { class: "modal-lead" }, body) : body,
        status,
        h("div", { class: "modal-actions" }, cancel, ok)));
    document.body.append(dlg);
    let busy = false;
    const finish = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    cancel.addEventListener("click", () => finish(false));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (!busy) finish(false); });
    ok.addEventListener("click", async () => {
      if (!onConfirm) return finish(true);
      busy = true; ok.disabled = true; cancel.disabled = true; ok.classList.add("busy"); status.textContent = "";
      try { await onConfirm(); finish(true); } catch (e) {
        busy = false; ok.disabled = false; cancel.disabled = false; ok.classList.remove("busy");
        status.textContent = e?.userMessage || errorText(e);
      }
    });
    dlg.showModal();
    cancel.focus();
  });
}
