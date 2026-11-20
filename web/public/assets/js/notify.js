// Telling the person that a chat is asking to join (prod-readiness blocker 10: twice a request was approved while the
// chat waited on another one nobody noticed). Everything here comes from GET /app/v1/needs-you, which the dashboard
// reloads on every "changed" from GET /app/v1/events; no other source, no message content (the server has none).
//
//  - On every signed-in page: a card per waiting request (who, which name, which room, the code, a link to approve),
//    except the ones the page already shows. Two requests for one room say that they are two different requests.
//  - The tab title counts the waiting requests: "(2) Your rooms · bot-link".
//  - A request that leaves (withdrawn by the chat, ran out, replaced) says so for a while instead of just vanishing.
//  - Browser notifications, only after a click on the control on Your rooms, only while the tab is in the background,
//    exactly one per request in this browser (remembered across reloads and tabs). They need an open bot-link tab:
//    there is no Web Push sender on the server.
//
// app.js imports this module; this module imports app.js back and reads it only from functions that run later.
import { h, $, fill, toast } from "./dom.js";
import { icon, appName } from "./art.js";
import * as shell from "./app.js";

const PREF = "botlink-notify";      // "on" | "off": this browser's choice
const TOLD = "botlink-notified";    // {request id: ms}: requests this browser already counted as told
const GONE_MS = 2 * 60 * 1000;      // how long a "this request left" line stays
// the same in memory, for a browser that keeps no local storage (private windows): then it holds for this tab only
let prefHere = null;
const toldHere = new Set();
const pref = () => shell.store.get(PREF) ?? prefHere;
const setPref = (v) => { prefHere = v; shell.store.set(PREF, v); };

const groupCode = (c) => (c && c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c);

// ── what waits ──────────────────────────────────────────────────────────────
/**
 * The requests waiting for this person, newest last: join and move requests, people, new browsers. Only the server's
 * clock says a request ran out (needs-you leaves it out): this browser's clock may be off, so when it thinks a request
 * ran out it asks the server again (see draw) instead of hiding a request that may still be waiting.
 */
export function waiting() {
  const n = shell.app.needs;
  if (!n || !shell.app.me) return [];
  const out = [];
  for (const c of n.join_requests || []) {
    out.push({ id: c.id, type: c.kind === "claim" ? "move" : "join", roomId: c.room_id, room: c.room_name, name: c.name,
      app: appName(c.app, c.app_name), machine: c.machine || "an unknown computer", code: c.match_code,
      expires: Date.parse(c.expires_at), href: `/approve/${c.id}`, sel: `[aria-labelledby="jr-${c.id}"]` });
  }
  for (const p of n.person_requests || []) {
    out.push({ id: p.id, type: "person", roomId: p.room_id, room: p.room_name, name: p.display_name, email: p.email,
      href: `/rooms/${p.room_id}`, sel: `[aria-labelledby="pr-${p.id}"]` });
  }
  for (const a of n.attention || []) {
    if (a.kind !== "new_device" || a.subject_id === shell.app.device?.id) continue;
    out.push({ id: a.id, type: "browser", name: a.data?.label || "A new browser", href: "/rooms", sel: `[data-need-id="${a.id}"]` });
  }
  return out;
}

/** How a join request of this person ended (needs-you ended_join_requests), or null if the dashboard doesn't know. */
export const endedHow = (id) => (shell.app.needs?.ended_join_requests || []).find((e) => e.id === id)?.ended || null;

/** Other join requests waiting for the same room as card (two requests are never one). */
export const twinsOf = (card) => (shell.app.needs?.join_requests || []).filter((c) => c.room_id === card.room_id && c.id !== card.id);

/**
 * One plain line about requests for one room, or null when there is only one. batch: the card sits in a group where
 * several can be ticked and approved together, so the line fits both ways of approving.
 */
export function twinsLine(roomName, names, { batch = false } = {}) {
  if (names.length < 2) return null;
  return `${names.length} different requests for #${roomName} are waiting: ${names.join(", ")}. Each chat shows its own code. ${batch ? "Tick or approve only the ones whose code a chat of yours shows." : "Approve only the one whose code your chat shows."}`;
}

// ── browser notifications ───────────────────────────────────────────────────
let broken = false; // the constructor threw (some phones allow notifications only from an installed app)
const supported = () => typeof window.Notification === "function" && !broken;
/** "unsupported" | "denied" | "on" | "off" */
export function notifyState() {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && pref() === "on" ? "on" : "off";
}

function told() {
  let m = {};
  try { m = JSON.parse(shell.store.get(TOLD) || "{}") || {}; } catch { m = {}; }
  const old = Date.now() - 24 * 3600 * 1000;
  for (const k of Object.keys(m)) if (!(m[k] > old)) delete m[k];
  return m;
}

function words(it) {
  if (it.type === "join") return [`A chat asks to join #${it.room}`, `As ${it.name}, from ${it.app} on ${it.machine}. Open bot-link to compare the code.`];
  if (it.type === "move") return [`${it.name} in #${it.room} asks to move`, `From ${it.app} on ${it.machine}. Open bot-link to compare the code.`];
  if (it.type === "person") return [`${it.name} asks to join #${it.room}`, "Open bot-link to let them in or not."];
  return ["A new browser asks to be approved", `${it.name}. Approve it only if it's yours.`];
}

function tell(it) {
  if (document.visibilityState !== "hidden" || notifyState() !== "on") return;
  const [title, body] = words(it);
  try {
    const n = new Notification(title, { body, tag: `botlink-${it.id}` });
    n.onclick = () => { try { window.focus(); } catch { /* not allowed here */ } shell.navigate(it.href); n.close?.(); };
  } catch {
    broken = true;
    drawControls();
  }
}

async function ask() {
  if (!supported()) { drawControls(); return; }
  let p = Notification.permission;
  if (p === "default") {
    p = await new Promise((res) => {
      try {
        const r = Notification.requestPermission(res);   // older Safari answers through the callback only
        if (r && typeof r.then === "function") r.then(res, () => res(Notification.permission));
      } catch { res(Notification.permission); }
    });
  }
  if (p === "granted") { setPref("on"); toast("Notifications are on in this browser.", "success"); }
  else setPref("off");
  drawControls();
}

// ── the control (Your rooms) ────────────────────────────────────────────────
const controls = new Set();
const TAB_NOTE = "Works while a bot-link tab is open, even in the background. With every bot-link tab closed, nothing tells you.";

function drawControl(el) {
  const st = notifyState();
  el.dataset.state = st;
  const btn = (label, fn) => { const b = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, label); b.addEventListener("click", fn); return b; };
  const text = {
    unsupported: [h("strong", null, "This browser can't show notifications."),
      h("p", null, "While a request waits, the tab title shows how many, like “(1) Your rooms”.")],
    denied: [h("strong", null, "Notifications are blocked for bot-link in this browser."),
      h("p", null, "To get them, allow notifications for this site in the browser's settings. Until then, the tab title shows how many requests wait.")],
    on: [h("strong", null, "Notifications are on in this browser."), h("p", null, TAB_NOTE)],
    off: [h("strong", null, "Hear about requests to join"), h("p", null, TAB_NOTE)],
  }[st];
  fill(el,
    h("span", { class: "notify-ic", "aria-hidden": "true" }, icon("bell", { size: 20 })),
    h("div", { class: "notify-text" }, text),
    st === "off" ? btn("Tell me when a chat asks to join", ask)
      : st === "on" ? btn("Turn them off", () => { setPref("off"); drawControls(); }) : null);
}
function drawControls() { for (const el of controls) { if (el.isConnected) drawControl(el); else controls.delete(el); } }

/** The notification switch, with what it can and can't do. Asks the browser only when its button is clicked. */
export function notifyControl() {
  const el = h("div", { class: "notify-control", role: "group", "aria-label": "Notifications", "data-notify-control": "" });
  controls.add(el);
  drawControl(el);
  return el;
}

// ── the banner on every signed-in page, and the tab title ───────────────────
let host = null, sig = "", timer = null, queued = null, count = 0, asked = 0;
const seen = new Map();   // id → item: requests this tab showed, to say why one left
const gone = new Map();   // id → {text, at}

function goneText(it, how) {
  const who = `${it.name}'s request ${it.type === "move" ? "to move" : "to join"} #${it.room}`;
  return { withdrawn: `${who} was withdrawn by the chat.`, expired: `${who} expired. If the chat asks again, it shows a new code.`,
    replaced: `${who} was replaced by a newer one from the chat.`, closed: `${who} can't go ahead any more.` }[how] || `${who} is no longer waiting.`;
}

function itemCard(it) {
  const [head] = words(it);
  const line = it.type === "join" || it.type === "move" ? h("p", null, "As ", h("b", null, it.name), ` · ${it.app} on ${it.machine}`)
    : it.type === "person" ? h("p", null, it.email) : h("p", null, h("b", null, it.name), ". Approve it only if it's yours.");
  return h("article", { class: "notify-item", "data-notify": it.id },
    h("span", { class: "notify-ic", "aria-hidden": "true" }, icon(it.type === "browser" ? "monitor" : "bell", { size: 20 })),
    h("div", { class: "notify-text" }, h("strong", null, head), line,
      it.code ? h("p", { class: "notify-code" }, "Code ", h("b", null, groupCode(it.code))) : null),
    h("a", { href: it.href, class: "btn btn-primary btn-sm" }, "Open the request"));
}

function draw() {
  queued = null;
  clearTimeout(timer); timer = null;
  const now = Date.now();
  if (!shell.app.me) { seen.clear(); gone.clear(); }
  const items = waiting();
  const ids = new Set(items.map((x) => x.id));
  // the ones that left: say why (not for what the person decided, and not on the approval page that says it itself)
  for (const [id, it] of seen) {
    if (ids.has(id)) continue;
    seen.delete(id);
    if (it.type !== "join" && it.type !== "move") continue;
    const how = endedHow(id);
    if (how === "approved" || how === "rejected" || location.pathname === `/approve/${id}`) continue;
    gone.set(id, { text: goneText(it, how), at: now });
  }
  for (const it of items) seen.set(it.id, it);
  for (const [id, g] of gone) if (now - g.at > GONE_MS || ids.has(id) || !shell.app.me) gone.delete(id);

  // tell once per request, in this browser
  const t = told();
  let wrote = false;
  for (const it of items) if (!t[it.id] && !toldHere.has(it.id)) { t[it.id] = now; toldHere.add(it.id); wrote = true; tell(it); }
  if (wrote) shell.store.set(TOLD, JSON.stringify(t));

  count = items.length;
  setTitle();

  // the banner: what the page doesn't already show
  const main = $("#main");
  const here = (it) => !!main?.querySelector(it.sel) || location.pathname === `/approve/${it.id}`;
  const show = items.filter((it) => !here(it));
  const rooms = new Map();
  for (const it of items) if (it.type === "join" || it.type === "move") rooms.set(it.roomId, [...(rooms.get(it.roomId) || []), it]);
  const kids = [], noted = new Set();
  for (const it of show) {
    const group = rooms.get(it.roomId);
    if (group && group.length > 1 && !noted.has(it.roomId)) {
      noted.add(it.roomId);
      kids.push(h("p", { class: "notify-twins", "data-notify-twins": it.roomId }, icon("alert", { size: 18 }), h("span", null, twinsLine(it.room, group.map((x) => x.name)))));
    }
    kids.push(itemCard(it));
  }
  for (const [id, g] of gone) {
    const ok = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "OK");
    ok.addEventListener("click", () => { gone.delete(id); draw(); });
    kids.push(h("div", { class: "notify-gone", "data-notify-gone": id }, h("p", null, g.text), ok));
  }
  const s = JSON.stringify([show.map((x) => [x.id, x.name, x.room, x.code]), [...noted], [...gone.keys()]]);
  if (!kids.length) { host?.remove(); host = null; sig = ""; }
  else if (s !== sig || !host?.isConnected) {
    sig = s;
    if (!host) host = h("div", { class: "page notify-banners", role: "region", "aria-label": "Requests waiting for you", "aria-live": "polite" });
    if (!host.isConnected) main?.before(host);
    fill(host, kids);
  }

  // The server sends nothing when a request runs out: ask it again a second after the first one should have (at most
  // every 30 s, in case this browser's clock runs ahead), and redraw when a "left" line is due to go.
  const check = Math.max(Math.min(...items.filter((x) => x.expires).map((x) => x.expires + 1000)), asked + 30000);
  const next = Math.min(check, ...[...gone.values()].map((g) => g.at + GONE_MS + 100));
  if (Number.isFinite(next)) timer = setTimeout(() => (Date.now() >= check - 50 ? askAgain() : draw()), Math.max(250, next - Date.now()));
}
async function askAgain() {
  asked = Date.now();
  await shell.refreshNeeds();   // its change redraws this banner
  shell.refreshView();          // and the nav's count and the page's own cards
}
const schedule = () => { if (!queued) queued = setTimeout(draw, 0); };

const PREFIX = /^\(\d+\) /;
function setTitle() {
  const base = document.title.replace(PREFIX, "");
  const want = count ? `(${count}) ${base}` : base;
  if (document.title !== want) document.title = want;
}

setTimeout(() => {
  shell.onChange(schedule);
  // a page swap or a page redrawing its own cards changes what the banner leaves out; app.js resets the title
  const main = $("#main");
  if (main) new MutationObserver(schedule).observe(main, { childList: true, subtree: true });
  const t = $("title");
  if (t) new MutationObserver(setTitle).observe(t, { childList: true, characterData: true, subtree: true });
  schedule();
}, 0);
