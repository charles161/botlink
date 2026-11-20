// /create/<draft id>: a room a chat asked for (docs/protocol/room-drafts.md §4). The chat shows this link and a code to
// its person. Signed in, the page claims the draft and shows it: what happens (our words), the room name and purpose
// (the chat's words, quoted and inert), and the chat as on a join card. The person types the code and confirms with the
// human check; the browser signs the genesis and device_add entries as "Start a room" does (room-start.js) and the
// chat's member_add as an approval does (roster.js), sends one request and opens the new room. Unknown, ran out,
// someone else's, closed or decided: the generic not-found page, so the link reveals nothing by itself.
import { h, fill, toast, until } from "../dom.js";
import { post, errorText } from "../api.js";
import { icon, appName } from "../art.js";
import { appAvatar } from "../apptint.js";
import { memberFingerprint, signRosterEntry, uuidv7, ROOM_NAME } from "../crypto.js";
import { humanCheck } from "../humancheck.js";
import { app, ensureDevice, navigate, refreshNeeds } from "../app.js";
import { requestFacts } from "../needs.js";
import { memberAddOp } from "../roster.js";
import { signRoomStart, slugify } from "../room-start.js";
import { normalizeCode, inertText, cardProblems, sameCard, CONFIRM_ACTION } from "../draft.js";
import { quoted } from "../chatwords.js";

export const HEADING = "This makes a new room owned by you and lets this chat in.";
const START_AGAIN = "If you still want the room, ask your chat to start again. It shows a new link and code.";
const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** A page for a state the draft can't leave (ran out, closed, said no, too many). */
function statePage(state, title, line) {
  return h("section", { class: "page page-narrow create-page", "data-draft-state": state },
    h("p", { class: "kicker" }, "New room"),
    h("h1", { class: "display-sm" }, title),
    h("p", { class: "lead" }, line),
    h("div", { class: "row-actions" }, h("a", { href: "/rooms", class: "btn btn-primary" }, "Your rooms")));
}
const tooManyPage = () => statePage("too-many", "Too many new rooms waiting",
  "Too many rooms your chats asked for are waiting for you to confirm. Confirm or turn down one of them first (the links are in those chats), or wait until they run out. Then open this link again.");

function page(shown, id) {
  const wrap = h("div");
  const timers = [];
  let left = false;               // the page moved to a state it can't leave
  let pending = null;             // {name, room, roster_entry}: signed once, sent again on a retry
  let kept = null;                // {proof, expiresAt}: the human check of a try that failed on the code or the name
  let fp = null;

  const problems = cardProblems(shown, id);
  const ownName = !ROOM_NAME.test(shown.room_name || "") || shown.name_taken;
  const status = h("p", { id: "create-status", class: "form-status", role: "alert", "aria-live": "assertive" });
  const codeInput = h("input", { id: "draft-code", name: "code", class: "input code-input", maxlength: 9, autocomplete: "off", autocapitalize: "characters", spellcheck: "false", inputmode: "text", placeholder: "K7Q-2MX", "aria-describedby": "draft-code-help", "data-autofocus": "" });
  codeInput.addEventListener("input", () => { codeInput.removeAttribute("aria-invalid"); status.textContent = ""; });

  // the room's name: the chat's, or the person's own when it can't be used (taken, or not a room name)
  const nameSlot = h("div");
  let nameInput = null;
  const askName = (why) => {
    if (!nameInput) {
      nameInput = h("input", { id: "draft-room-name", name: "room-name", class: "input input-prefixed", maxlength: 32, autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: "acme", "aria-describedby": "draft-room-name-help" });
      nameInput.addEventListener("input", () => { nameInput.value = slugify(nameInput.value); nameInput.removeAttribute("aria-invalid"); status.textContent = ""; });
    }
    fill(nameSlot, h("div", { class: "field" },
      h("label", { for: "draft-room-name" }, "Name for the room"),
      h("div", { class: "prefix-wrap" }, h("span", { class: "prefix", "aria-hidden": "true" }, "#"), nameInput),
      h("p", { id: "draft-room-name-help", class: "help" }, why)));
  };
  if (!ROOM_NAME.test(shown.room_name || "")) askName("Room names use lowercase letters, numbers and dashes. Pick a name for this one.");
  else if (shown.name_taken) askName(`You already own a room called #${shown.room_name}. Pick another name for this one.`);
  const roomName = () => (nameInput ? nameInput.value : shown.room_name);

  const fpSlot = h("code", { class: "fp", "data-fp": "" }, "computing…");
  const fpReady = problems.length ? Promise.resolve(null) : memberFingerprint(shown.ed25519_pk, shown.x25519_pk).then((x) => { fp = x; fpSlot.textContent = x; return x; });

  const confirmBtn = h("button", { type: "submit", class: "btn btn-primary" }, h("span", { class: "spinner", "aria-hidden": "true" }), icon("fingerprint", { size: 18 }), h("span", { class: "btn-label" }, "Confirm"));
  const rejectBtn = h("button", { type: "button", class: "btn btn-ghost" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-label" }, "Don't make it"));
  const busy = (b, on) => { b.disabled = on; b.classList.toggle("busy", on); };
  const blocker = problems.length ? h("p", { class: "need-blocker" }, "This request doesn't check out, so it can't be confirmed. Don't make it, and ask your chat to start again.") : null;
  if (problems.length) confirmBtn.disabled = true;

  const leave = (el) => { left = true; timers.forEach(clearTimeout); fill(wrap, el); };
  const expiredPage = () => statePage("expired", "This request ran out", `It ran out at ${clock(shown.expires_at)} before you confirmed it. Nothing was made. ${START_AGAIN}`);
  const ranOut = () => Date.parse(shown.expires_at) <= Date.now();
  const gone = async () => leave(ranOut() ? expiredPage() : (await (await import("./not-found.js")).default({})).el);

  // the time left, and the moment it runs out while the page is open
  const timeLeft = h("span", { class: "need-time" });
  const tick = () => {
    if (left) return;
    if (ranOut()) { leave(expiredPage()); return; }
    const u = until(shown.expires_at);
    timeLeft.textContent = u ? `Runs out in ${u}` : "";
    timers.push(setTimeout(tick, Math.min(30000, Math.max(250, Date.parse(shown.expires_at) - Date.now() + 50))));
  };

  // Sign and send. Outcomes the page shows itself come back as values; anything else throws (the dialog shows it).
  async function send(code, proof, expiresAt) {
    const device = await ensureDevice();
    if (!device) { const e = new Error("no device"); e.userMessage = "This browser has no signing key yet. Reload the page and try again."; throw e; }
    const name = roomName();
    if (!pending || pending.name !== name) {
      const owner = app.me.account.id;
      const start = await signRoomStart(device, { id: uuidv7(), name, purpose: shown.room_purpose || "", owner });
      const member = await signRosterEntry(device, { room: start.room.id, seq: start.headSeq + 1, prev: start.headHash, ...memberAddOp(shown, owner) });
      pending = { name, room: start.room, roster_entry: member.wire };
    }
    try {
      return { done: await post(`/app/v1/room-drafts/${id}/confirm`, { code, human_check: proof, room: pending.room, roster_entry: pending.roster_entry }) };
    } catch (e) {
      const keep = () => { kept = { proof, expiresAt }; };
      if (e.code === "code_mismatch") { keep(); return { wrong: Number(e.details?.left ?? 0) }; }
      if (e.code === "name_taken") { keep(); pending = null; return { taken: name }; }
      if (e.code === "quota_exceeded") { keep(); return { quota: true }; }
      if (e.code === "not_found") return { gone: true };
      if (e.code === "human_check_failed") kept = null;
      throw e;
    }
  }

  async function show(out) {
    if (!out) return;
    if (out.done) {
      toast(`#${out.done.room.name} is ready and ${shown.name} is in.`, "success", 5200);
      await refreshNeeds();
      navigate(`/rooms/${out.done.room.id}`);
    } else if (out.wrong !== undefined) {
      if (out.wrong <= 0) { leave(statePage("closed", "Closed after five wrong codes", `The code was wrong five times, so this link is closed. Nothing was made. ${START_AGAIN}`)); return; }
      codeInput.setAttribute("aria-invalid", "true");
      status.textContent = `That code doesn't match the one your chat shows. ${out.wrong} ${out.wrong === 1 ? "try" : "tries"} left.`;
      codeInput.select(); codeInput.focus();
    } else if (out.taken) {
      askName(`You already own a room called #${out.taken}. Pick another name for this one.`);
      nameInput.setAttribute("aria-invalid", "true"); nameInput.focus();
    } else if (out.quota) status.textContent = "You own 20 rooms, the most for now. Delete one to start another.";
    else if (out.gone) await gone();
  }

  async function confirm() {
    status.textContent = "";
    const code = normalizeCode(codeInput.value);
    if (!code) {
      codeInput.setAttribute("aria-invalid", "true");
      status.textContent = codeInput.value.trim() ? "The code has six characters, like K7Q-2MX." : "Type the code your chat shows.";
      codeInput.focus(); return;
    }
    if (nameInput && !ROOM_NAME.test(nameInput.value)) {
      nameInput.setAttribute("aria-invalid", "true");
      status.textContent = nameInput.value ? "Use lowercase letters, numbers and dashes, starting with a letter or number." : "Give the room a name.";
      nameInput.focus(); return;
    }
    if (!app.cryptoOk) { status.textContent = "This browser can't sign. Use a recent Chrome, Edge, Firefox or Safari."; return; }
    busy(confirmBtn, true);
    try {
      // sign only what the person saw: the card again, field for field, and the fingerprint they were shown
      let now;
      try { now = await post(`/app/v1/room-drafts/${id}/claim`); } catch (e) { if (e.code === "not_found") { await gone(); return; } throw e; }
      const shownFp = await fpReady;
      if (!sameCard(shown, now) || cardProblems(now, id).length || await memberFingerprint(now.ed25519_pk, now.x25519_pk) !== shownFp) {
        status.textContent = "This request changed after you opened it, so nothing was signed. Reload the page and check it again.";
        left = true; confirmBtn.disabled = true; confirmBtn.classList.remove("busy"); return;
      }
      // a try that failed on the code or the name kept its human check: use it again while it is still good
      if (kept && Date.parse(kept.expiresAt || "") - Date.now() > 15000) {
        try { await show(await send(code, kept.proof, kept.expiresAt)); return; } catch (e) { if (e.code !== "human_check_failed") throw e; }
      }
      let out = null;
      const ok = await humanCheck({
        action: CONFIRM_ACTION, targetId: id,
        title: "You're the human here.",
        lead: h("p", { class: "modal-lead" }, "Make ", h("b", null, `#${roomName()}`), ", owned by you, and let ", h("b", null, shown.name), " in as your chat?"),
        facts: h("div", { class: "hc-facts" }, requestFacts(chatFacts(shown), { compact: true })),
        confirmLabel: "Confirm", unlockLabel: "Unlock & confirm", busyLabel: "Making the room…",
        registerSub: "First time you confirm from this account. Takes a second.",
        errorCtx: { name: shown.name },
        onProof: async (proof, challenge) => { out = await send(code, proof, challenge?.expires_at); },
      });
      if (ok) await show(out);
    } catch (e) {
      status.textContent = e?.userMessage || errorText(e, { name: shown.name });
    } finally {
      if (!left) busy(confirmBtn, false);
    }
  }

  rejectBtn.addEventListener("click", async () => {
    busy(rejectBtn, true); status.textContent = "";
    try { await post(`/app/v1/room-drafts/${id}/reject`); leave(statePage("rejected", "Not made", `Nothing was made. ${shown.name} is told you said no.`)); }
    catch (e) { busy(rejectBtn, false); if (e.code === "not_found") await gone(); else status.textContent = errorText(e); }
  });

  const form = h("form", { class: "create-form", novalidate: true },
    nameSlot,
    h("div", { class: "field" },
      h("label", { for: "draft-code" }, "Type the code your chat shows."),
      codeInput,
      h("p", { id: "draft-code-help", class: "help" }, "Six characters, like K7Q-2MX. Lower case and the dash are fine.")),
    status,
    blocker,
    h("div", { class: "need-actions" }, confirmBtn, rejectBtn),
    h("p", { class: "fine" }, "Confirm asks for your passkey. Nothing is made before that."));
  form.addEventListener("submit", (e) => { e.preventDefault(); if (!confirmBtn.disabled) confirm(); });

  fill(wrap, h("section", { class: "page page-narrow create-page", "data-draft": id },
    h("p", { class: "kicker" }, "New room"),
    h("h1", { id: "create-title", class: "display-sm" }, HEADING),
    h("div", { class: "chat-words", role: "group", "aria-labelledby": "cw-by" },
      h("p", { id: "cw-by", class: "cw-by" }, icon("alert", { size: 16 }), "A chat wrote the name and the purpose below. They are its words, shown as plain text."),
      quoted("Room name", "room_name", shown.room_name),
      quoted("Purpose", "room_purpose", shown.room_purpose)),
    h("article", { class: "need need-join create-chat", "aria-labelledby": "create-chat-name" },
      h("header", { class: "need-head" }, h("span", { class: "need-kind" }, "The chat"), timeLeft),
      h("div", { class: "need-main" },
        appAvatar(shown.app, inertText(shown.app_name || ""), { size: 52, label: appName(shown.app, inertText(shown.app_name || "")) }),
        h("div", null,
          h("h2", { class: "need-title", id: "create-chat-name" }, shown.name),
          h("p", { class: "need-meta" }, h("b", null, "This becomes YOUR chat."), " Running on someone else's computer? Don't make it."))),
      requestFacts(chatFacts(shown)),
      h("p", { class: "need-hint create-fp" }, icon("key", { size: 16 }), h("span", null, "Key fingerprint ", fpSlot, ". Your chat shows the same one."))),
    form));
  tick();
  return { el: wrap, cleanup: () => { left = true; timers.forEach(clearTimeout); } };
}

/** The chat's words on the join card's facts, with hidden and direction-changing characters shown as marks. */
const chatFacts = (c) => ({ ...c, app_name: c.app_name ? inertText(c.app_name) : c.app_name, machine: c.machine ? inertText(c.machine) : c.machine, folder: c.folder ? inertText(c.folder) : c.folder, job: c.job ? inertText(c.job) : c.job });

export default async function create({ params }) {
  let card;
  try { card = await post(`/app/v1/room-drafts/${params.id}/claim`); }
  catch (e) {
    if (e.code === "not_found") return (await import("./not-found.js")).default({});
    if (e.code === "too_many_drafts") return { el: tooManyPage(), title: "Too many new rooms waiting" };
    throw e;
  }
  return { ...page(card, params.id), title: "Confirm a new room" };
}
