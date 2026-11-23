// "What needs you": join / move requests, person requests, attention items, and their approve flows.
import { h, ago, until, toast, details } from "./dom.js";
import { get, post, errorText } from "./api.js";
import { icon, avatar, appName } from "./art.js";
import { appAvatar } from "./apptint.js";
import { memberFingerprint, deviceFingerprint, signRosterEntry } from "./crypto.js";
import { humanCheck } from "./humancheck.js";
import { appendSigned, fetchVerified, memberAddOp } from "./roster.js";
import { app, refreshNeeds } from "./app.js";
import { twinsOf, twinsLine } from "./notify.js";
import { batchGroups } from "./needs-batch.js";
import { eventUrlCard } from "./needs-eventurl.js";
import { joinTries } from "./tries.js";
import { triesParts } from "./needs-tries.js";

/** Big match code, one box per character (read aloud easily, compared at a glance). */
export function matchCode(code, { size = "lg" } = {}) {
  // 6 characters are read in two groups of three (K7Q-2MX); the dash is only drawn, never part of the code
  const chars = code.split("");
  const kids = [];
  chars.forEach((c, i) => {
    if (chars.length === 6 && i === 3) kids.push(h("span", { class: "mc-sep", "aria-hidden": "true" }, "-"));
    kids.push(h("span", { class: "mc-char", "aria-hidden": "true" }, c));
  });
  return h("span", { class: ["match-code", `mc-${size}`], role: "img", "aria-label": `Code ${chars.join(" ")}` }, kids);
}
/** "K7Q2MX" -> "K7Q-2MX" (as the chat shows it). */
export const groupCode = (code) => (code && code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code);
const fpEl = (fp) => h("code", { class: "fp" }, fp);

/** Whether this browser can sign for a room right now (shows why not). */
async function signBlocker(roomId) {
  if (!app.cryptoOk) return "This browser can't sign. Use a recent Chrome, Edge, Firefox or Safari to approve.";
  if (!app.device) return "This browser has no signing key yet. Reload the page and try again.";
  const p = roomId && pendingHere(roomId);
  if (p) {
    askOnce();
    const where = p.signer_labels?.length ? [...new Set(p.signer_labels)].join(" or ") : (await otherBrowserLabel()) || "a browser you already use with bot-link";
    return `This browser isn't approved for #${p.room_name} yet. Approve it from ${where}: it's waiting under “What needs you” there.`;
  }
  return null;
}
/** The room this browser can't sign in yet (from AppMe.device.pending), or null. */
export const pendingHere = (roomId) => (app.me?.device?.pending || []).find((x) => x.room_id === roomId) || null;
let askedFor = "";
/** Make sure the person's other browsers show this browser's request (once per set of pending rooms). */
export function askOnce(roomId = null) {
  const ids = (app.me?.device?.pending || []).map((x) => x.room_id);
  if (roomId && !ids.includes(roomId)) ids.push(roomId);
  const key = ids.join(",");
  if (!app.device || !key || key === askedFor) return;
  askedFor = key;
  post(`/app/v1/devices/${app.device.id}/ask`).catch(() => { askedFor = ""; });
}
let otherLabelCache = null;
export async function otherBrowserLabel() {
  if (otherLabelCache !== null) return otherLabelCache;
  try {
    const { devices } = await get("/app/v1/devices");
    const d = devices.find((x) => x.id !== app.device?.id && !x.revoked_at && x.certified_rooms > 0);
    otherLabelCache = d ? d.label : "";
  } catch { otherLabelCache = ""; }
  return otherLabelCache;
}

function actions(...btns) { return h("div", { class: "need-actions" }, btns); }
export function busyBtn(btn, on) { btn.disabled = on; btn.classList.toggle("busy", on); }
export const btn = (label, cls, onClick, ic) => {
  const b = h("button", { type: "button", class: ["btn", cls] }, h("span", { class: "spinner", "aria-hidden": "true" }), ic ? icon(ic, { size: 18 }) : null, h("span", { class: "btn-label" }, label));
  b.addEventListener("click", () => onClick(b));
  return b;
};

// ── join / move requests ────────────────────────────────────────────────────
/**
 * Who is asking, big and plain (item 9: a lookalike request is caught by WHERE it comes from, not only the code): the
 * proposed name, the app, the computer, the folder and the job. All are the chat's own words except the app.
 */
// Long folder paths (app scratch dirs) pushed Approve out of view: keep the start and the last folder, full path on hover.
function shortPath(p) {
  if (p.length <= 48) return p;
  const parts = p.split("/");
  const s = parts.length > 4 ? `${parts.slice(0, 2).join("/")}/…/${parts[parts.length - 1]}` : p;
  // a few very long segments (or one): keep the start and the end
  return s.length <= 48 ? s : `${s.slice(0, 20)}…${s.slice(-26)}`;
}

export function requestFacts(card, { compact = false } = {}) {
  const row = (label, value, cls) => (value ? h("div", { class: ["rq-fact", cls] }, h("dt", null, label), h("dd", null, value)) : null);
  return h("dl", { class: ["rq-facts", compact ? "rq-compact" : null] },
    row("Name", card.name, "rq-name"),
    row("App", appName(card.app, card.app_name)),
    row("Computer", card.machine || "unknown"),
    row("Folder", card.folder ? h("span", { title: card.folder }, shortPath(card.folder)) : "unknown", "rq-folder"),
    compact ? null : row("Job", card.job ? h("q", null, card.job) : null, "rq-job"));
}

/**
 * batch: the room's tick box maker when several of its chats wait (needs-batch.js); a move never gets one.
 * tries: needs-tries.js triesParts when card is the newest of several tries from one place; the card stays card's own.
 */
export function joinCard(card, { showRoom = false, onDone, batch = null, tries = null } = {}) {
  const isMove = card.kind === "claim";
  const toChat = isMove && card.move_to === "chat"; // H1: another chat on the same computer
  const fpSlot = h("code", { class: "fp" }, "computing…");
  const fpReady = memberFingerprint(card.ed25519_pk, card.x25519_pk).then((fp) => { fpSlot.textContent = fp; card._fp = fp; return fp; });
  const blocker = h("p", { class: "need-blocker", hidden: true });
  const expires = until(card.expires_at);
  const approve = btn(isMove ? "Approve the move" : "Approve", "btn-primary", () => approveJoin(card, onDone));
  const reject = tries ? btn("Reject all", "btn-ghost", tries.rejectAll) : btn("Reject", "btn-ghost", async (b) => {
    busyBtn(b, true);
    try { await post(`/app/v1/join-requests/${card.id}/reject`); toast(`${card.name} won't ${isMove ? "move" : "come in"}.`); await refreshNeeds(); onDone?.(); }
    catch (e) { toast(errorText(e, { name: card.name }), "error"); busyBtn(b, false); if (e.code === "already_decided") { await refreshNeeds(); onDone?.(); } }
  });
  const blockReady = signBlocker(card.room_id).then((why) => { if (why) { blocker.textContent = why; blocker.hidden = false; approve.disabled = true; } return why; });
  const tick = batch && !isMove ? batch.tickRow(card, { fpReady, blockReady }) : null;
  const twins = tries ? tries.line : twinsLine(card.room_name, [card, ...twinsOf(card)].map((c) => c.name), { batch: !!tick }); // two requests are never one
  return h("article", { class: ["need", isMove ? "need-move" : "need-join", tries && "need-tries", tries?.again && "need-again"], "data-need": "join", "data-request": card.id, "aria-labelledby": `jr-${card.id}`,
    "data-tries": tries?.count, "data-need-key": tries && `tries|${tries.key}` },
    h("header", { class: "need-head" },
      h("span", { class: "need-kind" }, toChat ? "Moving chats" : isMove ? "Moving machines" : "Join request", showRoom ? h("span", { class: "need-room" }, `#${card.room_name}`) : null),
      h("span", { class: "need-time" }, ago(card.created_at), expires ? ` · ${expires} left` : " · expired")),
    h("div", { class: "need-main" },
      appAvatar(card.app, card.app_name, { size: 52, label: appName(card.app, card.app_name) }),
      h("div", null,
        h("h3", { class: "need-title", id: `jr-${card.id}` }, tries ? tries.title : toChat ? `${card.name} wants to move to a new chat` : isMove ? `${card.name} wants to move to a new machine` : `${card.name} would like to come in`),
        h("p", { class: "need-meta" }, toChat ? "Another chat on this computer wants to continue as it. Approve only if you asked for this; the chat it leaves stops being it." : isMove ? "Is this your chat? Check where it runs." : h("span", null, h("b", null, "This becomes YOUR chat."), " Running on someone else's computer? Reject.")))),
    twins ? h("p", { class: "need-twins" }, icon("alert", { size: 18 }), h("span", null, twins)) : null,
    requestFacts(card),
    card.readdressed_from_name ? h("p", { class: "need-hint" }, `It used ${card.readdressed_from_name}'s chat invite; you made it yours.`) : null,
    h("div", { class: "code-row" },
      h("div", null, h("span", { class: "code-label" }, "Code"), matchCode(card.match_code)),
      details("Details",
        h("p", null, isMove ? "New key " : "Key ", fpSlot),
        h("p", null, "Name, computer, folder and job are what the chat says about itself."),
        card.invite_label ? h("p", null, `Used ${card.invite_label}.`) : null)),
    tick,
    h("p", { class: "need-hint" }, icon("check", { size: 16 }), `Approve only if ${card.name} shows the same code.`),
    blocker,
    tries ? tries.older(blockReady) : null,
    actions(approve, reject));
}

export async function approveJoin(card, onDone) {
  const isMove = card.kind === "claim";
  const fp = card._fp || await memberFingerprint(card.ed25519_pk, card.x25519_pk);
  const ok = await humanCheck({
    action: "approve_join", targetId: card.id,
    title: "You're the human here.",
    lead: h("p", { class: "modal-lead" }, isMove ? `Before ${card.name} moves, match ` : `Before ${card.name} comes in, match `, h("b", null, groupCode(card.match_code)), " with the code shown in that chat.", isMove ? null : h("span", null, " ", h("b", null, "It becomes your chat."))),
    facts: h("div", { class: "hc-facts" },
      requestFacts(card, { compact: true }),
      h("div", null, h("span", { class: "code-label" }, "Code"), matchCode(card.match_code, { size: "md" })),
      details("Details", h("p", null, isMove ? "New key " : "Key ", fpEl(fp)))),
    errorCtx: { name: card.name },
    onProof: (proof) => appendSigned(card.room_id, app.device, (v) => {
      if (isMove) {
        const m = v.members.get(card.member_id);
        if (!m || m.account !== app.me.account.id || m.name !== card.name) {
          const e = new Error("member mismatch"); e.fatal = true;
          e.userMessage = `${card.name} isn't one of your chats in this room, so this move can't be approved.`; throw e;
        }
        return { op: "member_rekey", member: card.member_id, ed: card.ed25519_pk, x: card.x25519_pk };
      }
      return memberAddOp(card, app.me.account.id);
    }, (wire) => post(`/app/v1/join-requests/${card.id}/approve`, { human_check: proof, roster_entry: wire })),
  });
  if (ok) {
    toast(isMove ? `${card.name} moved. Its messages will follow.` : `${card.name} is in. It'll say “Joined #${card.room_name}” in its chat.`, "success", 5200);
    await refreshNeeds(); onDone?.();
  }
}

// ── person requests (owner) ─────────────────────────────────────────────────
export function personCard(pr, { showRoom = false, onDone } = {}) {
  const fpSlot = h("code", { class: "fp" }, pr.device_fingerprint);
  const warn = h("p", { class: "need-blocker", hidden: true });
  const approve = btn("Approve", "btn-primary", () => approvePerson(pr, onDone));
  if (pr.device_pk) deviceFingerprint(pr.device_pk).then((fp) => {
    fpSlot.textContent = fp;
    if (fp !== pr.device_fingerprint) { warn.textContent = "This browser key doesn't check out. Don't approve; ask them to send a new request."; warn.hidden = false; approve.disabled = true; }
  });
  else { warn.textContent = "This request is missing their browser key, so it can't be approved."; warn.hidden = false; approve.disabled = true; }
  signBlocker(pr.room_id).then((why) => { if (why) { warn.textContent = why; warn.hidden = false; approve.disabled = true; } });
  const reject = btn("Reject", "btn-ghost", async (b) => {
    busyBtn(b, true);
    try { await post(`/app/v1/person-requests/${pr.id}/reject`); toast(`${pr.display_name} won't come in.`); await refreshNeeds(); onDone?.(); }
    catch (e) { toast(errorText(e), "error"); busyBtn(b, false); }
  });
  const provider = { github: "GitHub", google: "Google", dev: "dev sign-in", supabase: "email" }[pr.provider] || pr.provider;
  return h("article", { class: "need need-person", "data-need": "person", "aria-labelledby": `pr-${pr.id}` },
    h("header", { class: "need-head" },
      h("span", { class: "need-kind" }, "Person request", showRoom && pr.room_name ? h("span", { class: "need-room" }, `#${pr.room_name}`) : null),
      h("span", { class: "need-time" }, ago(pr.created_at))),
    h("div", { class: "need-main" },
      avatar("person", { size: 52, initial: pr.display_name }),
      h("div", null,
        h("h3", { class: "need-title", id: `pr-${pr.id}` }, `${pr.display_name} would like to come in`),
        h("p", { class: "need-meta" }, `${pr.email} · ${provider}`))),
    h("p", { class: "need-fine" }, "Once in, they can bring and approve their own chats."),
    details("Details", h("p", null, "Their browser key ", fpSlot)),
    warn,
    actions(approve, reject));
}

async function approvePerson(pr, onDone) {
  const ok = await humanCheck({
    action: "approve_person", targetId: pr.id,
    title: "You're the human here.",
    lead: `Let ${pr.display_name} (${pr.email}) into the room? They'll be able to bring in and approve their own chats.`,
    onProof: (proof) => appendSigned(pr.room_id, app.device,
      () => ({ op: "person_add", account: pr.account_id, name: [...pr.display_name].slice(0, 80).join("") || pr.email.slice(0, 80), device: pr.device_pk }),
      (wire) => post(`/app/v1/person-requests/${pr.id}/approve`, { human_check: proof, roster_entry: wire })),
  });
  if (ok) { toast(`${pr.display_name} is in.`, "success"); await refreshNeeds(); onDone?.(); }
}

// ── attention items ─────────────────────────────────────────────────────────
export function attentionCard(it, { showRoom = false, onDone } = {}) {
  const name = it.member_name || "A chat";
  const appLabel = it.app ? appName(it.app, it.app_name) : "its app";
  const dismiss = btn(it.kind === "needs_you" ? "Done" : it.kind === "member_joined" || it.kind === "member_left" ? "Got it" : "Dismiss", "btn-ghost", async (b) => {
    busyBtn(b, true);
    try { await post(`/app/v1/attention/${it.id}/dismiss`); await refreshNeeds(); onDone?.(); } catch (e) { toast(errorText(e), "error"); busyBtn(b, false); }
  });
  let title, body, extraBody = null, extra = [];
  if (it.kind === "stuck") {
    const n = it.data?.count;
    title = `${n ? `${n} message${n === 1 ? "" : "s"}` : "Messages"} waiting for ${name}`;
    body = `Its chat didn't pick ${n === 1 ? "it" : "them"} up. Open it in ${appLabel}, then retry.`;
    extra.push(btn("Retry", "btn-sun", async (b) => {
      busyBtn(b, true);
      try { const r = await post(`/app/v1/members/${it.subject_id}/unstick`); toast(r?.requeued ? `Retrying ${r.requeued} message${r.requeued === 1 ? "" : "s"} for ${name}.` : `Retrying for ${name}.`, "success"); await refreshNeeds(); onDone?.(); }
      catch (e) { toast(errorText(e), "error"); busyBtn(b, false); }
    }, "refresh"));
  } else if (it.kind === "cannot_wake") {
    title = `${name}'s chat is gone`;
    body = `Open ${appLabel} and say “use bot-link as ${name}” to continue in a new chat.`;
  } else if (it.kind === "needs_you") {
    title = `${name} has a question for you`;
    body = `Open ${appLabel} to read it.`;
  } else if (it.kind === "new_device") {
    const label = it.data?.label || "a new browser";
    const rooms = (it.data?.room_names || []).map((n) => `#${n}`);
    const roomsText = rooms.length ? rooms.join(", ") : "your rooms";
    title = it.data?.approved ? `${label} isn't approved for ${roomsText} yet` : `New browser: ${label}`;
    const fpSlot = h("code", { class: "fp" }, it.data?.fingerprint || "…");
    const self = browserIsTarget(it.subject_id);
    body = self
      ? h("span", null, "This is the browser you're using. Approve it from a browser you already use.")
      : h("span", null, it.data?.approved ? `Approve it for ${roomsText} too.` : `Was this you? Approve it for ${roomsText}.`);
    extraBody = details("Details", h("p", null, "Browser key ", fpSlot));
    get("/app/v1/devices").then(({ devices }) => {
      const d = devices.find((x) => x.id === it.subject_id);
      if (d) deviceFingerprint(d.ed25519_pk).then((fp) => { fpSlot.textContent = fp; });
    }).catch(() => {});
    if (!self) {
      const ap = btn("Approve", "btn-primary", () => approveDevice(it.subject_id, label, onDone));
      signBlocker(null).then((why) => { if (why) ap.disabled = true; });
      extra.push(ap);
    }
  } else if (it.kind === "member_joined" || it.kind === "member_left") {
    const d = it.data || {};
    const who = d.name || name;
    const whose = d.person_name ? `${d.person_name}'s chat` : "a chat";
    const how = it.kind === "member_joined" ? "joined" : d.how === "left" ? "left" : "was removed from";
    title = `${who} ${how} #${d.room_name || it.room_name || "the room"}`;
    body = h("span", null,
      h("span", { class: "need-line" }, [appName(d.app, d.app_name), whose].filter(Boolean).join(" · "),
        it.kind === "member_left" && d.how === "removed" && d.by_name ? ` · removed by ${d.by_name}` : ""),
      it.kind === "member_joined" && d.job ? h("span", { class: "need-line" }, "Job, in its own words: ", h("q", null, d.job)) : null,
      h("span", { class: "need-line" }, it.kind === "member_joined" ? "It gets messages sent from now on, never earlier ones." : "It gets nothing sent from now on."));
    if (d.fingerprint) extraBody = details("Details", h("p", null, "Key ", h("code", { class: "fp" }, d.fingerprint)));
  } else { title = `${name} needs a look`; body = ""; }
  return h("article", { class: ["need", `need-${it.kind}`], "data-need": it.kind, "data-need-id": it.id },
    h("header", { class: "need-head" },
      h("span", { class: "need-kind" }, { stuck: "Waiting", cannot_wake: "Chat gone", needs_you: "Question waiting", new_device: "New browser", member_joined: "Joined", member_left: "Left" }[it.kind] || "Needs a look",
        showRoom && it.room_name ? h("span", { class: "need-room" }, `#${it.room_name}`) : null),
      h("span", { class: "need-time" }, ago(it.created_at))),
    h("div", { class: "need-main" },
      it.kind === "new_device" ? h("span", { class: "need-ic" }, icon("monitor", { size: 26 })) : avatar(it.app || it.data?.app || "other", { size: 52 }),
      h("div", null, h("h3", { class: "need-title" }, title), body ? h("p", { class: "need-meta" }, body) : null, extraBody)),
    actions(...extra, dismiss));
}
const browserIsTarget = (id) => app.device?.id === id;

export async function approveDevice(deviceId, label, onDone) {
  let note = "";
  const ok = await humanCheck({
    action: "approve_device", targetId: deviceId,
    title: "Approve a new browser?",
    lead: `${label} will be able to approve chats and people in your rooms. Only approve it if it's yours.`,
    busyLabel: "Signing for your rooms…",
    onProof: async (proof) => {
      // One device_add per room THIS browser can sign in (SPEC §6.1). Rooms it can't sign in stay pending and
      // show up on a browser that can. On roster_conflict, re-sign only the rooms that moved (all-or-nothing).
      const [{ rooms }, { devices }] = await Promise.all([get(`/app/v1/devices/${deviceId}/pending-rooms`), get("/app/v1/devices")]);
      const target = devices.find((d) => d.id === deviceId);
      if (!target) { const e = new Error("gone"); e.code = "not_found"; throw e; }
      const signed = new Map(); // room_id → wire
      const skipped = [];
      const sign = async (roomId) => {
        const { verified } = await fetchVerified(roomId);
        if (![...verified.people.values()].some((p) => p.devices.has(app.device.pk))) { skipped.push(roomId); return; }
        const { wire } = await signRosterEntry(app.device, { room: roomId, seq: verified.headSeq + 1, prev: verified.headHash, op: "device_add", account: app.me.account.id, device: target.ed25519_pk, label: target.label.slice(0, 80) });
        signed.set(roomId, wire);
      };
      for (const r of rooms) await sign(r.room_id);
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await post(`/app/v1/devices/${deviceId}/certify`, { human_check: proof, entries: [...signed].map(([room_id, roster_entry]) => ({ room_id, roster_entry })) });
          if (skipped.length) {
            const left = (target.pending || []).filter((p) => skipped.includes(p.room_id));
            const where = [...new Set(left.flatMap((p) => p.signer_labels || []))].filter((l) => l !== app.device.label);
            note = ` ${left.map((p) => `#${p.room_name}`).join(", ") || "Some rooms"} still need${left.length === 1 ? "s" : ""} an OK from ${where.length ? where.join(" or ") : "a browser that can sign there"}.`;
          }
          return res;
        } catch (e) {
          if (e.code !== "roster_conflict" || attempt >= 4) throw e;
          await new Promise((r) => setTimeout(r, 100 + Math.random() * 400));
          const moved = e.details?.room_ids || [...signed.keys()];
          for (const id of moved) { signed.delete(id); await sign(id); }
        }
      }
    },
  });
  if (ok) { toast(`${label} is approved.${note}`, "success", note ? 7000 : 4000); await refreshNeeds(); onDone?.(); }
}

/**
 * The whole list, filtered (roomId) or all. Join requests of one room from the same place are one card (tries.js,
 * needs-tries.js). With `ticks` (batch.js createTicks, one per page), a room with two or more waiting chats (a card of
 * tries counts as one, by its newest) shows them together in one group with tick boxes and one approve bar (needs-batch.js).
 */
export function needsList(needs, { roomId = null, showRoom = false, onDone, ticks = null } = {}) {
  if (!needs) return [];
  const inRoom = (x) => !roomId || x.room_id === roomId;
  const joins = needs.join_requests.filter(inRoom);
  const units = joinTries(joins);
  const groups = ticks ? batchGroups(units.map((u) => u.newest), ticks, { onDone, all: joins }) : new Map();
  const joinEls = [];
  for (const u of units) {
    const c = u.newest;
    const g = c.kind === "join" ? groups.get(c.room_id) : null;
    const el = joinCard(c, { showRoom, onDone, batch: g?.forCard, tries: u.older.length ? triesParts(u, { onDone }) : null });
    if (!g) { joinEls.push(el); continue; }
    if (!joinEls.includes(g.el)) joinEls.push(g.el);
    g.add(el);
  }
  return [
    ...joinEls,
    ...needs.person_requests.filter(inRoom).map((p) => personCard(p, { showRoom, onDone })),
    // an address a chat asked bot-link to call: never in a batch
    ...(needs.event_urls || []).filter((e) => !roomId || e.room?.id === roomId).map((e) => eventUrlCard(e, { onDone })),
    // Items not tied to a room (a new browser) show on every room page too.
    ...needs.attention.filter((a) => (roomId ? a.room_id === roomId || !a.room_id : true)).map((a) => attentionCard(a, { showRoom, onDone })),
  ];
}

/** The cards of a drawn list (a batch group counts as its cards): what the count and the "N new" pill go by. */
export const needCards = (items) => items.flatMap((el) => (el.dataset.need === "batch" ? [...el.querySelectorAll("[data-need=join]")] : [el]));
