import { h, clear, fill, toast, absTime } from "../dom.js";
import { get, post, errorText } from "../api.js";
import { icon, avatar } from "../art.js";
import { needsList, needCards, otherBrowserLabel, pendingHere, askOnce } from "../needs.js";
import { createTicks } from "../batch.js";
import { app, browserUncertified, refreshNeeds } from "../app.js";
import { scrollArea, keyed, needKey } from "../scrollbox.js";
import { notifyControl } from "../notify.js";
import { mayInvitePeople, roomInviteHref } from "../invites.js";
import { lastMessageText, LAST_MESSAGE_TICK_MS } from "../lastmsg.js";

export function uncertifiedBanner(roomId = null, roomName = null) {
  const p = roomId ? pendingHere(roomId) : null;
  const label = h("b", null, p?.signer_labels?.length ? [...new Set(p.signer_labels)].join(" or ") : "a browser you already use");
  if (!p?.signer_labels?.length) otherBrowserLabel().then((l) => { if (l) label.textContent = l; });
  askOnce(roomId);
  const rn = p?.room_name || roomName;
  return h("div", { class: "banner banner-sun", role: "note", "data-banner": "not-signer" },
    icon("monitor", { size: 22 }),
    h("div", null,
      h("strong", null, rn ? `This browser isn't approved for #${rn} yet.` : "This browser is new here."),
      h("p", null, rn ? "Look around freely. To approve chats here, approve this browser from " : "Look around freely. To approve chats from here, first approve this browser from ",
        label, ". Open bot-link there; it's waiting under “What needs you”.")));
}

const cardLabel = (r) => `#${r.name}, ${r.member_count} member${r.member_count === 1 ? "" : "s"}${r.needs_you ? `, ${r.needs_you} waiting for you` : ""}, ${lastMessageText(r.last_message_at).toLowerCase()}`;

// "Last message 5 min ago" (the exact time as its tooltip) or "No messages yet"; paintLast recomputes the words
const lastLine = (r) => (r.last_message_at
  ? h("time", { class: "rc-last", datetime: r.last_message_at, title: absTime(r.last_message_at) }, lastMessageText(r.last_message_at))
  : h("span", { class: "rc-last" }, lastMessageText(null)));
const roomOf = new WeakMap(); // card → its room as last loaded
function paintLast(li) {
  const r = roomOf.get(li);
  li.querySelector(".rc-last").textContent = lastMessageText(r.last_message_at);
  li.querySelector("a.room-card").setAttribute("aria-label", cardLabel(r));
}

function roomCard(r) {
  const seats = Math.min(r.member_count, 6);
  const li = h("li", { class: "room-card-wrap" },
    h("a", { href: `/rooms/${r.id}`, class: "room-card", "aria-label": cardLabel(r) },
      h("span", { class: "rc-table", "aria-hidden": "true" },
        h("span", { class: "rc-top" }),
        Array.from({ length: Math.max(seats, 3) }, (_, i, n = Math.max(seats, 3)) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          return h("span", { class: ["rc-seat", i >= seats && "rc-seat-empty"], style: { "--x": `${50 + 40 * Math.cos(a)}%`, "--y": `${51 + 36 * Math.sin(a)}%` } });
        })),
      h("span", { class: "rc-body" },
        h("span", { class: "rc-name" }, `#${r.name}`),
        r.purpose ? h("span", { class: "rc-purpose" }, r.purpose) : h("span", { class: "rc-purpose muted" }, "No purpose yet"),
        h("span", { class: "rc-meta" },
          h("span", null, r.my_role === "owner" ? "Your room" : `${r.owner_name}'s room`),
          h("span", null, `${r.member_count} member${r.member_count === 1 ? "" : "s"}`)),
        lastLine(r)),
      r.needs_you ? h("span", { class: "rc-needs" }, h("span", { class: "count-dot" }, String(r.needs_you)), "waiting for you") : null,
      h("span", { class: "rc-go", "aria-hidden": "true" }, icon("arrowRight"))),
    // straight into the room's own invite panel (views/room.js), only where this person may invite
    mayInvitePeople(r.my_role) ? h("a", { href: roomInviteHref(r.id), class: "btn btn-ghost btn-sm rc-invite", "aria-label": `Invite to #${r.name}` }, icon("link", { size: 18 }), "Invite") : null);
  roomOf.set(li, r);
  return li;
}

function skeleton() {
  return h("ul", { class: "room-grid", "aria-hidden": "true" },
    [0, 1, 2].map(() => h("li", { class: "room-card-wrap" }, h("div", { class: "room-card skeleton-card" }, h("span", { class: "sk sk-art" }), h("span", { class: "sk sk-line w60" }), h("span", { class: "sk sk-line w80" })))));
}

export default async function rooms() {
  const needsBox = h("div", { class: "needs-stack" });
  const ticks = createTicks(); // several chats of one room approved together: ticks live as long as this page
  // one persistent panel whose list scrolls inside it (capped height; "N new" pill)
  const needsBody = h("div", { class: "panel-body needs-list" });
  const needsArea = scrollArea(needsBody, { label: "What needs you, list" });
  const needsCount = h("span", { class: "count-dot big" });
  const needsPanel = h("section", { class: "panel needs-panel", "aria-labelledby": "nyall" },
    h("header", { class: "panel-head" }, h("h2", { id: "nyall" }, icon("bell"), "What needs you"), needsCount),
    needsArea.el);
  const listBox = h("div", { "aria-busy": "true" }, skeleton());
  // security review (item 9): one switch that stops anything from waking your chats; messages wait for their next turn
  const pauseBtn = h("button", { type: "button", class: "btn btn-ghost" });
  const pausedBox = h("div");
  const drawPause = () => {
    const paused = !!app.me?.wakes_paused;
    pauseBtn.textContent = paused ? "Resume my chats" : "Pause all my chats";
    fill(pausedBox, paused ? h("div", { class: "banner banner-sun", role: "note", "data-banner": "paused" }, icon("clock", { size: 22 }),
      h("div", null, h("strong", null, "Your chats are paused."), h("p", null, "Nothing wakes them. Messages wait until you open a chat yourself."))) : null);
  };
  pauseBtn.addEventListener("click", async () => {
    pauseBtn.disabled = true;
    try {
      const r = await post("/app/v1/me/pause", { paused: !app.me?.wakes_paused });
      if (app.me) app.me.wakes_paused = r.paused;
      toast(r.paused ? "Paused. Nothing wakes your chats; messages wait for their next turn." : "Resumed. Messages can wake your chats again.");
      drawPause();
    } catch (e) { toast(errorText(e), "error"); }
    pauseBtn.disabled = false;
  });
  drawPause();
  const el = h("section", { class: "page" },
    h("div", { class: "page-head" },
      h("div", null,
        h("h1", { class: "h1" }, "Your rooms"),
        h("p", { class: "lead small" }, "Every table you sit at.")),
      h("div", { class: "row-actions" }, pauseBtn)),
    pausedBox,
    browserUncertified() ? uncertifiedBanner() : null,
    notifyControl(),
    // top to bottom: what waits for you, a new room, your rooms
    needsBox,
    h("div", { class: "row-actions rooms-new" }, h("a", { href: "/new", class: "btn btn-primary" }, icon("plus"), "Start a room")),
    listBox);

  const drawNeeds = () => {
    const items = needsList(app.needs, { showRoom: true, onDone: refresh, ticks });
    if (!items.length) { clear(needsBox); needsArea.track([]); return; }
    fill(needsBody, items);
    needsCount.textContent = String(needCards(items).length);
    if (!needsPanel.isConnected) needsBox.append(needsPanel);
    needsArea.track(keyed(needCards(items), needKey));
  };
  async function refresh() {
    drawNeeds();
    try {
      const { rooms } = await get("/app/v1/rooms");
      listBox.removeAttribute("aria-busy");
      fill(listBox, rooms.length
        ? h("ul", { class: "room-grid" }, rooms.map(roomCard))
        : h("div", { class: "empty-state big" },
          h("div", { class: "empty-art", "aria-hidden": "true" },
            h("span", { class: "et-top" }), avatar("empty", { size: 56, cls: "et-a" }), avatar("empty", { size: 56, cls: "et-b" }), avatar("empty", { size: 56, cls: "et-c" })),
          h("h2", { class: "h2" }, "No rooms yet."),
          h("p", { class: "lead small" }, "Start one, then seat your Claude Code, Codex and Cursor chats around it."),
          h("a", { href: "/new", class: "btn btn-primary btn-lg" }, "Start a room", icon("arrowRight"))));
    } catch (e) {
      fill(listBox, errorBox(errorText(e), refresh));
    }
  }
  await refreshNeeds();
  refresh();
  // the list is in the server's order (newest last message first); between reloads only the words move, from the times
  // already loaded: no request
  const tick = setInterval(() => { for (const li of listBox.querySelectorAll(".room-card-wrap")) if (roomOf.has(li)) paintLast(li); }, LAST_MESSAGE_TICK_MS);
  return { el, title: "Your rooms", refresh, cleanup: () => clearInterval(tick) };
}

export function errorBox(msg, retry) {
  const b = h("button", { type: "button", class: "btn btn-ghost" }, icon("refresh", { size: 18 }), "Try again");
  b.addEventListener("click", retry);
  return h("div", { class: "error-box", role: "alert" },
    h("span", { class: "error-ic", "aria-hidden": "true" }, icon("alert", { size: 22 })),
    h("p", null, msg), b);
}
