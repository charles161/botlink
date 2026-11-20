// "What needs you": approving several waiting chats of one room together. When one room has two or more join
// requests waiting for this person, each of those cards gets a tick box beside its code (the person says the code
// matches), and the room gets one bar: one human check (approve_joins: that room, exactly the ticked ids), the list
// read again and compared field for field, then the member_add entries signed as a single approval signs them
// (roster.js memberAddOp) and sent in ONE request. Nothing is ticked by default and nothing ticks several cards at once.
// The rules that need no page are in batch.js.
import { h, toast } from "./dom.js";
import { get, post } from "./api.js";
import { appName } from "./art.js";
import { appAvatar } from "./apptint.js";
import { humanCheck } from "./humancheck.js";
import { appendSignedChain, memberAddOp } from "./roster.js";
import { app, refreshNeeds } from "./app.js";
import { BATCH_ACTION, batchRooms, joinProblems, preSignProblems } from "./batch.js";
import { matchCode } from "./needs.js";

const CARD_NOTE = {
  changed: "This request changed. Check it again.",
  already_decided: "Someone already decided this one.",
  expired: "This request ran out.",
  not_found: "This request is gone.",
};
const ANSWER_PART = { changed: "changed", already_decided: "was already decided", expired: "ran out", not_found: "is gone" };
const goLabel = (n) => (n === 0 ? "Approve the ticked chats" : n === 1 ? "Approve the 1 ticked chat" : `Approve the ${n} ticked chats`);
const listNames = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * The rooms of this draw that get tick boxes: room_id → {el (the group: its cards, then the bar), add(cardEl), forCard}.
 * forCard is what joinCard gets as `batch`: tickRow(card, {fpReady, blockReady}) draws the tick box of one card.
 */
export function batchGroups(joins, ticks, { onDone } = {}) {
  ticks.reconcile(joins);
  const out = new Map();
  for (const [roomId, list] of batchRooms(joins)) out.set(roomId, group(roomId, list, ticks, onDone));
  return out;
}

function group(roomId, list, ticks, onDone) {
  const roomName = list[0].room_name;
  const order = new Map(list.map((c, i) => [c.id, i]));
  const cards = h("div", { class: "batch-cards" });
  const status = h("p", { class: "batch-status", role: "status", "aria-live": "polite" }, ticks.roomNote(roomId) || "");
  status.hidden = !ticks.roomNote(roomId);
  const go = h("button", { type: "button", class: "btn btn-primary batch-go" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-label" }));
  const update = () => {
    const n = ticks.count(roomId);
    go.querySelector(".btn-label").textContent = goLabel(n);
    go.disabled = n === 0;
  };
  const say = (text) => { ticks.setRoomNote(roomId, text); status.textContent = text || ""; status.hidden = !text; };
  const el = h("section", { class: "batch-group", "data-need": "batch", "data-batch-room": roomId, "aria-labelledby": `bg-${roomId}` },
    cards,
    h("div", { class: "batch-bar" },
      h("p", { id: `bg-${roomId}`, class: "batch-intro" }, `${list.length} chats are waiting in #${roomName}. Tick each one whose code matches, then approve them together.`),
      status,
      go));
  update();
  go.addEventListener("click", () => approveTicked());

  function tickRow(card, { fpReady, blockReady }) {
    const id = `tick-${card.id}`;
    const box = h("input", { type: "checkbox", id, class: "batch-box", "data-tick": card.id, disabled: true });
    const noted = ticks.note(card.id);
    const note = h("p", { class: "batch-note", role: "status", "aria-live": "polite" }, noted ? CARD_NOTE[noted] || "" : "");
    note.hidden = !noted;
    let fp = null;
    // the card's own check, as the single approval runs it: the browser computed the fingerprint, this browser can
    // sign here, and the request checks out. Until then (or if it fails) the box can't be ticked.
    Promise.all([fpReady, blockReady]).then(([computed, why]) => {
      const kept = ticks.ticked(roomId).find((t) => t.card.id === card.id);
      if (why || !computed || joinProblems(card).length) { if (kept) { ticks.untick(card.id); update(); } return; }
      fp = computed;
      box.disabled = false;
      if (kept && kept.fp === computed) box.checked = true;
      else if (kept) { ticks.untick(card.id); ticks.setNote(card.id, "changed"); note.textContent = CARD_NOTE.changed; note.hidden = false; update(); }
    }, () => {});
    box.addEventListener("change", () => {
      say(null);
      if (box.checked) {
        const r = ticks.tick(card, fp);
        if (r !== "ok") box.checked = false;
        note.textContent = { max: "Five at a time.", lookalike: "These two run in the same place. Approve them one at a time." }[r] || "";
        note.hidden = !note.textContent;
      } else ticks.untick(card.id);
      update();
    });
    return h("div", { class: "batch-tick" },
      h("div", { class: "batch-tick-row" }, box, h("label", { for: id, class: "batch-tick-label" }, `This code matches the one ${card.name} shows`)),
      note);
  }

  async function approveTicked() {
    const shown = ticks.ticked(roomId).sort((a, b) => (order.get(a.card.id) ?? 0) - (order.get(b.card.id) ?? 0));
    if (!shown.length) return;
    const n = shown.length;
    const ids = shown.map((t) => t.card.id);
    say(null);
    let out = null;
    const ok = await humanCheck({
      action: BATCH_ACTION, targetId: roomId, targets: ids,
      title: "You're the human here.",
      lead: h("p", { class: "modal-lead" }, h("b", null, n === 1 ? `This chat becomes your chat in #${roomName}.` : `These ${n} chats become your chats in #${roomName}.`),
        " Approve only if each code matches the one its chat shows."),
      facts: h("ul", { class: "batch-list" }, shown.map(({ card }) => h("li", null,
        h("span", { class: "batch-list-bot" }, appAvatar(card.app, card.app_name, { size: 40 })),
        h("span", { class: "batch-list-name" }, card.name),
        h("span", { class: "batch-list-where" }, `${appName(card.app, card.app_name)} · ${card.machine || "unknown"}`),
        matchCode(card.match_code, { size: "sm" })))),
      confirmLabel: n === 1 ? "Approve 1 chat" : `Approve ${n} chats`, unlockLabel: "Unlock & approve", busyLabel: "Approving…",
      onProof: async (proof) => { out = await send(proof, shown); },
    });
    if (ok && out) await show(out, shown);
  }

  // Read the list again, sign and send. Outcomes the bar shows come back as values; anything else throws (the dialog shows it).
  async function send(proof, shown) {
    const now = await get("/app/v1/needs-you");
    const changed = await preSignProblems(shown, now?.join_requests);
    if (changed.length) return { changed };
    try {
      const res = await appendSignedChain(roomId, app.device, () => shown.map(({ card }) => memberAddOp(card, app.me.account.id)),
        (wires) => post(`/app/v1/rooms/${roomId}/join-requests/approve`, { human_check: proof, items: shown.map(({ card }, i) => ({ id: card.id, roster_entry: wires[i] })) }));
      return { done: res };
    } catch (e) {
      if (e.code === "batch_changed") {
        const items = Array.isArray(e.details?.items) ? e.details.items : [];
        // every ticked chat already decided (this batch went through on a double submit, or in another tab): nothing went wrong
        return shown.every(({ card }) => items.some((x) => x.id === card.id && x.reason === "already_decided")) ? { alreadyDone: items } : { batchChanged: items };
      }
      if (e.code === "room_full") return { full: e.details?.id };
      if (e.code === "bad_request" && e.details?.id) return { alone: e.details.id };
      if (e.code === "rate_limited") return { limited: Number(e.retryAfter) || 0 };
      if (e.code === "name_taken") return { clash: e.details?.id };
      if (e.code === "human_check_failed") e.userMessage = "The passkey step didn't count, so nothing was approved. Try again.";
      throw e;
    }
  }

  async function show(out, shown) {
    const nameOf = (id) => shown.find((t) => t.card.id === id)?.card.name || "a chat";
    let text = null;
    if (out.done) {
      ticks.clearRoom(roomId);
      toast(shown.length === 1 ? `${shown[0].card.name} is in. It'll say “Joined #${roomName}” in its chat.` : `${listNames(shown.map((t) => t.card.name))} are in. Each says “Joined #${roomName}” in its chat.`, "success", 5200);
    } else if (out.changed) {
      ticks.clearRoom(roomId);
      for (const p of out.changed) if (p.reason === "changed") ticks.setNote(p.id, "changed");
      text = `Nothing was signed or sent. A request changed after you ticked it: ${listNames(out.changed.map((p) => p.name))}. Check it again.`;
    } else if (out.batchChanged) {
      ticks.clearRoom(roomId);
      for (const x of out.batchChanged) if (CARD_NOTE[x.reason]) ticks.setNote(x.id, x.reason);
      const parts = out.batchChanged.map((x) => `${nameOf(x.id)} ${ANSWER_PART[x.reason] || "changed"}`);
      text = `Nothing was approved. ${parts.length ? `${listNames(parts)}. ` : ""}Tick the chats again to approve the rest.`;
    } else if (out.alreadyDone) {
      ticks.clearRoom(roomId);
      const names = out.alreadyDone.map((x) => nameOf(x.id));
      toast(`${listNames(names)} ${names.length === 1 ? "was" : "were"} already decided. Nothing else to do.`, "info", 5200);
    } else if (out.alone) {
      ticks.untick(out.alone);
      text = `Nothing was approved. ${nameOf(out.alone)} can't be approved together with the others. Approve it on its own.`;
    } else if (out.limited !== undefined) {
      const min = Math.ceil(out.limited / 60);
      text = `Too many approvals this hour. ${out.limited > 0 ? `Try again in ${min} minute${min === 1 ? "" : "s"}.` : "Try again later."}`;
    } else if (out.full) {
      text = `Nothing was approved. #${roomName} is full (20 members), so ${nameOf(out.full)} can't come in.`;
    } else if (out.clash) {
      ticks.untick(out.clash);
      text = `Nothing was approved. Another member of #${roomName} is already called ${nameOf(out.clash)}.`;
    }
    ticks.setRoomNote(roomId, text);
    await refreshNeeds();
    // the bar goes away when fewer than two chats are left waiting here: say it where it still shows
    if (text && !batchRooms(app.needs?.join_requests).has(roomId)) toast(text, "error", 7000);
    onDone?.();
  }

  return { el, add: (cardEl) => cards.append(cardEl), forCard: { tickRow } };
}
