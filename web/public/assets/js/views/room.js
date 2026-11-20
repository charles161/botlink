// Room page: what needs you (only when something does) · who's at the table · invite · activity.
import { h, clear, ago, until, absTime, toast, copyText, fill, details } from "../dom.js";
import { get, post, api, errorText } from "../api.js";
import { icon, avatar, appName, tableScene, turnText } from "../art.js";
import { uuidv7 } from "../crypto.js";
import { needsList, needCards } from "../needs.js";
import { createTicks } from "../batch.js";
import { appAvatar, seatBadge, tintChar } from "../apptint.js";
import { fetchVerified, appendSigned } from "../roster.js";
import { confirmDialog } from "../humancheck.js";
import { app, navigate, refreshNeeds } from "../app.js";
import { uncertifiedBanner, errorBox } from "./rooms.js";
import { scrollArea, keyed, needKey } from "../scrollbox.js";
import { mayInvitePeople, INVITE_PANEL } from "../invites.js";
import { approvedAddresses } from "../needs-eventurl.js";

// hotfix 2026-11-06: only observed behaviour counts as ready (polling at its own turns is not)
const live = (label) => /wakes on its own|always on/.test(label || "");

export default async function room({ params }) {
  const id = params.id;
  let detail = null;
  try {
    detail = await get(`/app/v1/rooms/${id}${app.device ? `?device_id=${app.device.id}` : ""}`);
  } catch (e) {
    if (e.status === 404 || e.status === 403) {
      const mod = await import("./not-found.js");
      return mod.default({});
    }
    throw e;
  }

  let gone = false; // set once this browser closes or leaves the room, so live refreshes stop
  const state = { detail, invite: null, activity: null, activityMore: false, personInvites: null, verify: null };
  const isOwner = () => state.detail.my_role === "owner";

  // Regions (refreshed independently so live updates don't reset focus or scroll).
  const headBox = h("div");
  const bannerBox = h("div");
  const needsBox = h("div", { class: "panel-body needs-list" });
  const ticks = createTicks(); // several chats of this room approved together: ticks live as long as this page
  const tableBox = h("div", { class: "table-wrap" });
  const rosterBox = h("div", { class: "roster" });
  const peopleBox = h("div");
  const inviteBox = h("div", { class: "panel-body" });
  const personBox = h("div");
  const activityBox = h("div", { class: "panel-body" });
  const dangerBox = h("div");
  const needCount = h("span", { class: "count-dot big", hidden: true });
  const memberCount = h("span", { class: "panel-meta" });
  const arrivalStatus = h("p", { class: "sr-only", role: "status", "aria-live": "polite" });
  // long lists scroll inside their panel (header stays; "N new" pill when items arrive while scrolled away)
  const needsArea = scrollArea(needsBox, { label: "What needs you, list" });
  const needsPanel = h("section", { class: "panel needs-panel", "aria-labelledby": "ny", hidden: true },
    h("header", { class: "panel-head" }, h("h2", { id: "ny" }, icon("bell"), "What needs you"), needCount),
    needsArea.el);
  const rosterArea = scrollArea(rosterBox, { label: "Member list", cap: "list" });
  const activityArea = scrollArea(activityBox, { label: "Activity list", newestFirst: true });

  const el = h("section", { class: "page room-page" },
    h("a", { href: "/rooms", class: "back" }, icon("arrowLeft", { size: 18 }), "Your rooms"),
    headBox, bannerBox,
    h("div", { class: "room-grid-layout" },
      h("div", { class: "col col-a" },
        needsPanel,
        // one panel per job: everything about letting someone in (a chat or a person)
        h("section", { class: "panel invite-panel", id: INVITE_PANEL, "aria-labelledby": "inv" },
          h("header", { class: "panel-head" }, h("h2", { id: "inv" }, icon("link"), "Invite")),
          inviteBox,
          h("div", { class: "panel-body person-panel" }, h("h3", { class: "panel-sub" }, "People"), peopleBox, personBox))),
      h("div", { class: "col col-b" },
        h("section", { class: "panel table-panel", "aria-labelledby": "tbl" },
          h("header", { class: "panel-head" }, h("h2", { id: "tbl" }, icon("chat"), "Who's at the table"), memberCount),
          arrivalStatus, tableBox, rosterArea.el),
        h("section", { class: "panel activity-panel", "aria-labelledby": "act" },
          h("header", { class: "panel-head" }, h("h2", { id: "act" }, icon("clock"), "Activity")),
          activityArea.el))),
    dangerBox);

  // ── header ────────────────────────────────────────────────────────────────
  function drawHead() {
    const d = state.detail, r = d.room;
    const purpose = h("p", { class: "room-purpose" }, r.purpose || (isOwner() ? "Add a purpose so chats know what this room is for." : ""));
    if (!r.purpose) purpose.classList.add("muted");
    const editBtn = isOwner() ? h("button", { type: "button", class: "icon-btn", "aria-label": "Edit purpose" }, icon("edit", { size: 18 })) : null;
    editBtn?.addEventListener("click", () => editPurpose(purpose, editBtn));
    const v = state.verify;
    // one calm line; the room fingerprint (proof for people who want to compare it with a chat's) behind Details
    const who = d.people.length > 1 ? "Only people here let chats in" : "Only you let chats in";
    const fpChip = h("details", { class: ["more", "fp-chip", v?.ok === true && "ok", v?.ok === false && "bad"] },
      h("summary", null, v?.ok === false ? icon("alert", { size: 14 }) : icon(v?.ok === true ? "check" : "shield", { size: 14 }),
        v?.ok === false ? "Member list doesn't check out" : who),
      h("div", { class: "more-body" },
        h("p", null, "Every chat and person here was approved by a person, and this browser checked the signed member list", v?.ok === true ? "." : v?.ok === false ? ": it doesn't match." : " (checking…)."),
        h("p", null, "Room fingerprint ", h("code", { class: "fp" }, d.room_fingerprint), ". A chat shows the same one after it joins.")));
    fill(headBox, h("header", { class: "room-head" },
      h("div", { class: "room-title-wrap" },
        h("h1", { class: "room-title" }, h("span", { class: "hash" }, "#"), r.name),
        h("div", { class: "purpose-row" }, purpose, editBtn),
        h("p", { class: "room-meta" },
          h("span", null, isOwner() ? "Your room" : `${r.owner_name}'s room`),
          h("span", null, `${d.members.length} member${d.members.length === 1 ? "" : "s"}`),
          fpChip))));
    if (v?.ok === false) {
      fill(bannerBox, h("div", { class: "banner banner-coral", role: "alert" }, icon("alert", { size: 22 }),
        h("div", null, h("strong", null, "This room's member list doesn't check out."), h("p", null, "Don't trust messages from this room and don't approve anything here. Tell the room owner."))));
    } else if (!d.my_device_certified) {
      fill(bannerBox, uncertifiedBanner(id, d.room.name));
    } else clear(bannerBox);
  }

  function editPurpose(p, btn) {
    const input = h("input", { class: "input", maxlength: 140, value: state.detail.room.purpose || "", "aria-label": "Room purpose" });
    const save = h("button", { type: "submit", class: "btn btn-primary btn-sm" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-label" }, "Save"));
    const cancel = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Cancel");
    const form = h("form", { class: "purpose-form" }, input, save, cancel);
    p.replaceWith(form); btn.hidden = true; input.focus();
    cancel.addEventListener("click", drawHead);
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); save.disabled = true; save.classList.add("busy");
      try { state.detail = await api("PATCH", `/app/v1/rooms/${id}`, { purpose: input.value.trim() }); drawHead(); toast("Purpose saved."); }
      catch (err) { toast(errorText(err), "error"); save.disabled = false; save.classList.remove("busy"); }
    });
  }

  // ── what needs you ─────────────────────────────────────────────────────────
  function drawNeeds() {
    const items = needsList(app.needs, { roomId: id, onDone: refresh, ticks });
    needCount.hidden = !items.length; needCount.textContent = String(needCards(items).length);
    needsPanel.hidden = !items.length; // nothing needs you: no panel at all
    fill(needsBox, items);
    needsArea.track(keyed(needCards(items), needKey));
  }

  // ── table + roster ─────────────────────────────────────────────────────────
  let tableSig = "";
  let seatedIds = null; // members already drawn: only newcomers play the sit-down animation
  function drawTable(force = false) {
    const d = state.detail;
    const narrowNow = matchMedia("(max-width: 560px)").matches;
    const sig = JSON.stringify([narrowNow, d.room.name, d.people.map((p) => p.account_id), d.members.map((m) => [m.id, m.name, m.job, m.turn_label, m.self_label, m.stuck, m.app, m.fingerprint, m.folder, m.person_name, m.muted_by_me])]);
    if (!force && sig === tableSig) return;
    tableSig = sig;
    // Mark the owner's chats only when there is someone else in the room (otherwise it's noise).
    const owner = d.people.length > 1 ? d.people.find((p) => p.role === "owner") : null;
    memberCount.textContent = `${d.members.length} member${d.members.length === 1 ? "" : "s"}`;
    const narrow = matchMedia("(max-width: 560px)").matches;
    const max = narrow ? 8 : 12;
    const shown = d.members.slice(0, max);
    const firstDraw = !seatedIds;
    const prev = seatedIds || new Set();
    const newcomers = firstDraw ? [] : d.members.filter((m) => !prev.has(m.id));
    seatedIds = new Set(d.members.map((m) => m.id));
    const seats = shown.map((m) => ({
      fresh: !firstDraw && !prev.has(m.id),
      kind: m.app, appName: m.app === "other" ? m.app_name : null, ...seatBadge(m.app, m.app_name), label: m.name, sub: appName(m.app, m.app_name), stuck: m.stuck, owner: owner && m.account_id === owner.account_id,
      mine: m.account_id === app.me.account.id, aria: `${m.name}, ${appName(m.app, m.app_name)}, ${m.person_name}'s chat, ${turnText(m.turn_label)}. Open details`,
      onClick: () => memberSheet(m),
    }));
    while (seats.length < Math.min(Math.max(5, shown.length), max)) seats.push({ fresh: false, kind: "empty", label: seats.length === shown.length ? (d.members.length ? "Open seat" : "Your first chat") : "Open seat" });
    if (newcomers.length) {
      arrivalStatus.textContent = "";
      requestAnimationFrame(() => { arrivalStatus.textContent = newcomers.length === 1 ? `${newcomers[0].name} pulled up a chair.` : `${newcomers.length} new members pulled up chairs.`; });
    }
    const extra = d.members.length - shown.length;
    const scene = tableScene({
      seats, compact: narrow,
      center: { title: `#${d.room.name}`, sub: d.members.length ? (extra > 0 ? `+${extra} more below` : `${d.members.length} at the table`) : "room ready" },
    });
    // seats are appended in order: tint the bots of apps named at join
    scene.querySelectorAll(".seat").forEach((el, i) => tintChar(el.querySelector(".char"), seats[i]?.appName));
    fill(tableBox, scene);
    fill(rosterBox, d.members.length
      ? h("ul", { class: "roster-list" }, d.members.map((m) => {
        const b = h("button", { type: "button", class: "roster-item", "aria-label": `${m.name}: details` },
          appAvatar(m.app, m.app_name, { size: 40 }),
          h("span", { class: "ri-main" },
            h("span", { class: "ri-top" }, h("strong", null, m.name),
              owner && m.account_id === owner.account_id ? h("span", { class: "badge badge-owner", title: "The room owner's chat" }, "owner") : null,
              m.stuck ? h("span", { class: "badge badge-stuck" }, "waiting") : null,
              m.muted_by_me ? h("span", { class: "badge", title: "It doesn't wake your chats" }, "muted") : null),
            h("span", { class: "ri-job" }, m.job || "No job given"),
            h("span", { class: "ri-sub" }, `${appName(m.app, m.app_name)} · ${m.person_name}'s chat`)),
          h("span", { class: ["turn", live(m.turn_label) ? "turn-live" : "turn-wait"] }, h("span", { class: "turn-dot", "aria-hidden": "true" }), turnText(m.turn_label)));
        b.addEventListener("click", () => memberSheet(m));
        // security review (item 9): Remove sits on every member you may remove, not only inside its details
        const rm = canRemove(m) ? h("button", { type: "button", class: "btn btn-danger-ghost btn-sm ri-remove", "aria-label": `Remove ${m.name}` }, "Remove") : null;
        rm?.addEventListener("click", () => removeMember(m));
        return h("li", { class: rm ? "ri-row" : null }, b, rm);
      }))
      : h("p", { class: "roster-empty muted" }, "No chats yet. Paste your invite into a chat to fill the first seat."));
    rosterArea.track([...rosterBox.querySelectorAll(".roster-list > li")].map((li, i) => ({ key: d.members[i].id, el: li })));
  }

  const canRemove = (m) => m.account_id === app.me.account.id || isOwner();
  async function removeMember(m) {
    const d = state.detail;
    await confirmDialog({
      title: `Remove ${m.name}?`, danger: true, confirmLabel: "Remove",
      body: `${m.name} leaves #${d.room.name}. Messages waiting for it are dropped. It can come back only with a new invite and your approval.`,
      onConfirm: () => appendSigned(id, app.device, () => ({ op: "member_remove", member: m.id }), (wire) => post(`/app/v1/rooms/${id}/roster`, { roster_entry: wire })),
    }) && (toast(`${m.name} left the room.`), refresh());
  }
  async function setMute(m, muted) {
    try { await post(`/app/v1/members/${m.id}/mute`, { muted }); toast(muted ? `${m.name} won't wake your chats. Its messages wait for their next turn.` : `${m.name} can wake your chats again.`); refresh(); }
    catch (e) { toast(errorText(e), "error"); }
  }

  function memberSheet(m) {
    const d = state.detail;
    const fpOf = state.verify?.verified?.members.get(m.id);
    const fact = (k, v) => h("div", { class: "fact" }, h("dt", null, k), h("dd", null, v));
    const close = h("button", { type: "button", class: "icon-btn sheet-close", "aria-label": "Close" }, icon("x"));
    const remove = canRemove(m) ? h("button", { type: "button", class: "btn btn-danger-ghost" }, icon("trash", { size: 18 }), m.account_id === app.me.account.id ? "Remove my chat" : `Remove ${m.name}`) : null;
    const mute = m.account_id !== app.me.account.id ? h("button", { type: "button", class: "btn btn-ghost" }, m.muted_by_me ? "Unmute" : "Mute for my chats") : null;
    const dlg = h("dialog", { class: "modal sheet", "aria-labelledby": "ms-title" },
      h("div", { class: "modal-body" }, close,
        h("div", { class: "sheet-hero" }, appAvatar(m.app, m.app_name, { size: 72 }),
          h("div", null, h("h2", { id: "ms-title", class: "modal-title small" }, m.name), h("p", { class: "muted" }, `${appName(m.app, m.app_name)} · ${m.person_name}'s chat`))),
        h("p", { class: ["turn", "turn-lg", live(m.turn_label) ? "turn-live" : "turn-wait"] }, h("span", { class: "turn-dot", "aria-hidden": "true" }), turnText(m.turn_label)),
        m.account_id === app.me.account.id ? approvedAddresses(m) : null,
        h("dl", { class: "facts" },
          fact("Job, in its own words", m.job ? h("q", null, m.job) : "None given"),
          m.self_label ? fact("Availability, in its own words", h("q", null, m.self_label)) : null,
          m.folder ? fact("Folder", h("code", null, m.folder)) : null,
          fact("Joined", h("time", { datetime: m.joined_at, title: absTime(m.joined_at) }, ago(m.joined_at))),
          m.stuck ? fact("Status", "Messages are waiting for it. Retry from “What needs you”.") : null),
        details("Details",
          h("p", null, "Key ", h("code", { class: "fp" }, m.fingerprint)),
          h("p", null, fpOf ? "Name, app and key are checked against the signed member list. Job and folder are what the chat says about itself." : "Job and folder are what the chat says about itself.")),
        m.account_id !== app.me.account.id ? h("p", { class: "help" }, m.muted_by_me ? "It doesn't wake your chats. Its messages wait for their next turn." : "Too many messages? Mute it: it stops waking your chats, and its messages wait for their next turn.") : null,
        (remove || mute) ? h("div", { class: "modal-actions" }, mute, remove) : null));
    document.body.append(dlg);
    const done = () => { dlg.close(); dlg.remove(); };
    close.addEventListener("click", done);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) done(); });
    dlg.addEventListener("close", () => dlg.remove());
    remove?.addEventListener("click", () => { done(); removeMember(m); });
    mute?.addEventListener("click", () => { done(); setMute(m, !m.muted_by_me); });
    dlg.showModal();
  }

  // ── people ─────────────────────────────────────────────────────────────────
  function drawPeople() {
    const d = state.detail;
    fill(peopleBox, h("ul", { class: "people-list" }, d.people.map((p) => {
      const me = p.account_id === app.me.account.id;
      const rm = isOwner() && p.role !== "owner" ? h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Remove") : null;
      rm?.addEventListener("click", () => confirmDialog({
        title: `Remove ${p.display_name}?`, danger: true, confirmLabel: "Remove",
        body: `${p.display_name} and all their chats leave #${d.room.name}.`,
        onConfirm: () => appendSigned(id, app.device, () => ({ op: "person_remove", account: p.account_id }), (wire) => post(`/app/v1/rooms/${id}/roster`, { roster_entry: wire })),
      }).then((ok) => ok && (toast(`${p.display_name} was removed.`), refresh())));
      return h("li", { class: "person-row" }, avatar("person", { size: 36, initial: p.display_name }),
        h("span", { class: "pr-name" }, p.display_name, me ? h("span", { class: "muted" }, " (you)") : null),
        p.role === "owner" ? h("span", { class: "badge badge-owner" }, "owner") : null, rm);
    })));
  }

  // ── chat invite ────────────────────────────────────────────────────────────
  async function loadInvite() {
    try { state.invite = await get(`/app/v1/rooms/${id}/chat-invite`); } catch (e) { state.invite = { error: e }; }
    drawInvite();
  }
  function drawInvite() {
    const inv = state.invite;
    if (!inv) { fill(inviteBox, h("div", { class: "sk sk-block" })); return; }
    if (inv.error) { fill(inviteBox, errorBox(errorText(inv.error), loadInvite)); return; }
    const left = until(inv.expires_at);
    const expired = !left;
    const line = `join ${inv.url}`;
    // item 11: this invite adds chats for YOU; a friend who pastes it makes their agent your chat. It is not the
    // prominent action of the panel ("Invite a person" is), and it says so right above the link.
    const copy = h("button", { type: "button", class: "btn btn-ghost btn-sm copy-btn", disabled: inv.off || expired }, icon("copy", { size: 18 }), h("span", { class: "btn-label" }, "Copy"));
    copy.addEventListener("click", async () => {
      if (await copyText(line)) { copy.classList.add("copied"); copy.querySelector(".btn-label").textContent = "Copied"; toast("Copied. Paste it into your own Claude Code, Codex or Cursor."); setTimeout(() => { copy.classList.remove("copied"); copy.querySelector(".btn-label").textContent = "Copy"; }, 2200); }
      else toast("Couldn't copy. Select the text and copy it yourself.", "error");
    });
    const act = (label, action, cls = "btn-ghost") => {
      const b = h("button", { type: "button", class: ["btn", "btn-sm", cls] }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "btn-label" }, label));
      b.addEventListener("click", async () => {
        b.disabled = true; b.classList.add("busy");
        try { state.invite = await post(`/app/v1/rooms/${id}/chat-invite`, { action }); drawInvite(); toast(action === "renew" ? "Fresh invite, good for 24 h. The old one stopped working." : action === "off" ? "Invite turned off. Chats can't use it." : "Invite is on again."); }
        catch (e) { toast(errorText(e), "error"); b.disabled = false; b.classList.remove("busy"); }
      });
      return b;
    };
    // a problem gets one sentence and one action; the everyday controls sit behind Options
    const wasOpen = !!inviteBox.querySelector("details.more[open]");
    const opts = details("Options",
      h("p", null, `Works for ${left || "0 min"}, any number of your chats. Renew for a fresh one; the old one stops working.`),
      h("div", { class: "row-actions" }, act("Renew", "renew"), act("Turn off", "off")));
    opts.open = wasOpen;
    fill(inviteBox, 
      h("h3", { class: "panel-sub" }, "Your chats"),
      h("p", { class: "help invite-own" }, h("b", null, "Add your own chats; don't send this to anyone."), " Each chat that uses it becomes yours."),
      h("div", { class: ["invite-box", (inv.off || expired) && "is-off"] },
        h("code", { class: "invite-line" }, h("span", { class: "kw" }, "join "), h("span", { class: "invite-url" }, inv.url)),
        copy),
      inv.off ? [h("p", { class: "help" }, "This invite is off."), h("div", { class: "row-actions" }, act("Turn on", "on"))]
        : expired ? [h("p", { class: "help" }, "This invite expired."), h("div", { class: "row-actions" }, act("Renew", "renew"))]
          : [h("p", { class: "help" }, "Paste it into your Claude Code, Codex or Cursor. You approve each chat."), opts]);
  }

  // ── person invites ─────────────────────────────────────────────────────────
  async function loadPersonInvites() {
    if (!mayInvitePeople(state.detail.my_role)) { drawPersonInvites(); return; }
    try { state.personInvites = (await get(`/app/v1/rooms/${id}/person-invites`)).invites; } catch (e) { state.personInvites = { error: e }; }
    drawPersonInvites();
  }
  function drawPersonInvites() {
    if (!mayInvitePeople(state.detail.my_role)) {
      const leave = h("button", { type: "button", class: "btn btn-danger-ghost btn-sm" }, icon("logout", { size: 18 }), "Leave this room");
      leave.addEventListener("click", () => confirmDialog({
        title: `Leave #${state.detail.room.name}?`, danger: true, confirmLabel: "Leave",
        body: "You and all your chats leave the room. The owner can invite you again.",
        onConfirm: async () => { gone = true; try { await appendSigned(id, app.device, () => ({ op: "person_remove", account: app.me.account.id }), (wire) => post(`/app/v1/rooms/${id}/roster`, { roster_entry: wire })); } catch (e) { gone = false; throw e; } },
      }).then(async (ok) => { if (ok) { toast(`You left #${state.detail.room.name}.`); await refreshNeeds(); navigate("/rooms"); } }));
      fill(personBox, h("p", { class: "help" }, `Only ${state.detail.room.owner_name} can invite people.`), h("div", { class: "row-actions" }, leave));
      return;
    }
    const list = state.personInvites;
    const create = h("button", { type: "button", class: "btn btn-primary" }, h("span", { class: "spinner", "aria-hidden": "true" }), icon("plus", { size: 18 }), h("span", { class: "btn-label" }, "Invite a person"));
    create.addEventListener("click", async () => {
      create.disabled = true; create.classList.add("busy");
      try {
        const inv = await post(`/app/v1/rooms/${id}/person-invites`, { id: uuidv7() });
        state.fresh = inv.id;
        await loadPersonInvites();
        const ok = await copyText(inv.url);
        toast(ok ? "Invite copied. Send it to one person; it works once." : "Invite ready. Copy it below.", "success");
      } catch (e) { toast(errorText(e), "error"); create.disabled = false; create.classList.remove("busy"); }
    });
    const rows = Array.isArray(list) ? list.filter((p) => !p.used || p.used_by_name).slice(0, 6) : [];
    fill(personBox, 
      h("p", { class: "help" }, h("b", null, "Someone else's agent?"), " Invite the person: they add their own chats. A person invite works once, for 7 days. You approve them here."),
      list?.error ? errorBox(errorText(list.error), loadPersonInvites) : null,
      rows.length ? h("ul", { class: "pinv-list" }, rows.map((p) => {
        const expired = !until(p.expires_at);
        const cp = h("button", { type: "button", class: "icon-btn", "aria-label": "Copy person invite" }, icon("copy", { size: 18 }));
        cp.addEventListener("click", async () => toast((await copyText(p.url)) ? "Copied." : "Couldn't copy.", "info"));
        return h("li", { class: ["pinv", p.id === state.fresh && "is-fresh"] },
          h("span", { class: "pinv-main" },
            h("code", { class: "pinv-url" }, p.url.replace(/^https?:\/\//, "")),
            h("span", { class: "pinv-state" }, p.used ? `Used by ${p.used_by_name}` : expired ? "Expired" : `Unused · ${until(p.expires_at)} left`)),
          !p.used && !expired ? cp : null);
      })) : null,
      h("div", { class: "row-actions" }, create));
  }

  // ── activity (metadata only: who → whom, when) ─────────────────────────────
  async function loadActivity(more = false) {
    try {
      const before = more && state.activity?.length ? `&before=${encodeURIComponent(state.activity[state.activity.length - 1].at)}` : "";
      const { items } = await get(`/app/v1/rooms/${id}/activity?limit=30${before}`);
      state.activity = more ? [...(state.activity || []), ...items] : items;
      state.activityMore = items.length === 30;
    } catch (e) { if (!more) state.activity = { error: e }; else toast(errorText(e), "error"); }
    drawActivity();
  }
  function activityLine(a) {
    const n = (x) => h("b", null, x || "someone");
    switch (a.kind) {
      case "message": return [icon("send", { size: 16 }), h("span", null, n(a.from_name), h("span", { class: "arrow" }, " → "), a.to_name ? n(a.to_name) : h("b", null, "everyone"))];
      case "joined": return [icon("plus", { size: 16 }), h("span", null, n(a.from_name), " joined the room")];
      case "left": return [icon("logout", { size: 16 }), h("span", null, n(a.from_name), " left")];
      case "removed": return [icon("x", { size: 16 }), h("span", null, n(a.from_name), " was removed")];
      case "moved": return [icon("monitor", { size: 16 }), h("span", null, n(a.from_name), " moved to a new machine")];
      case "person_joined": return [icon("users", { size: 16 }), h("span", null, n(a.person_name), " came in")];
      case "person_left": return [icon("users", { size: 16 }), h("span", null, n(a.person_name), " left the room")];
      default: return [icon("clock", { size: 16 }), h("span", null, "Something changed")];
    }
  }
  function drawActivity() {
    const list = state.activity;
    if (!list) { fill(activityBox, h("div", { class: "sk sk-block" }), h("div", { class: "sk sk-block" })); return; }
    if (list.error) { fill(activityBox, errorBox(errorText(list.error), () => loadActivity())); return; }
    const more = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Show older");
    more.addEventListener("click", () => loadActivity(true));
    fill(activityBox, 
      list.length ? h("ol", { class: "activity" }, list.map((a) => h("li", { class: ["act", `act-${a.kind}`] },
        h("span", { class: "act-ic", "aria-hidden": "true" }, activityLine(a)[0]), activityLine(a)[1],
        h("time", { datetime: a.at, title: absTime(a.at) }, ago(a.at)))))
        : h("div", { class: "empty-state" }, h("p", { class: "empty-title" }, "Quiet so far"), h("p", { class: "muted" }, "You'll see who wrote to whom, and when. Never what they said.")),
      list.length ? h("p", { class: "help" }, "Only who and when. What they said stays private, even from bot-link.") : null,
      state.activityMore ? h("div", { class: "row-actions" }, more) : null);
    activityArea.track(keyed([...activityBox.querySelectorAll(".activity > li")], (li) => `${li.className}|${li.querySelector("time")?.getAttribute("datetime")}|${li.children[1]?.textContent || ""}`, { fromEnd: true }));
  }

  // ── danger zone ────────────────────────────────────────────────────────────
  function drawDanger() {
    if (!isOwner()) { clear(dangerBox); return; }
    const del = h("button", { type: "button", class: "btn btn-danger-ghost btn-sm" }, icon("trash", { size: 18 }), "Delete this room");
    del.addEventListener("click", () => confirmDialog({
      title: `Delete #${state.detail.room.name}?`, danger: true, confirmLabel: "Delete room",
      body: "Every chat leaves, waiting messages are dropped and invites stop working. This can't be undone.",
      onConfirm: async () => { gone = true; try { await api("DELETE", `/app/v1/rooms/${id}`); } catch (e) { gone = false; throw e; } },
    }).then(async (ok) => { if (ok) { toast(`#${state.detail.room.name} is closed.`); await refreshNeeds(); navigate("/rooms"); } }));
    fill(dangerBox, h("div", { class: "danger-zone" }, h("p", { class: "muted" }, "Closing time?"), del));
  }

  // ── verify the signed member list in this browser ──────────────────────────
  async function verify() {
    try {
      const { verified } = await fetchVerified(id);
      const ids = new Set(state.detail.members.map((m) => m.id));
      const sameSet = verified.members.size === ids.size && [...verified.members.keys()].every((k) => ids.has(k));
      state.verify = { ok: verified.roomFp === state.detail.room_fingerprint && sameSet, verified };
    } catch (e) {
      state.verify = e.fatal ? { ok: false } : null;
    }
    drawHead();
  }

  async function refresh() {
    if (gone) return;
    try {
      state.detail = await get(`/app/v1/rooms/${id}${app.device ? `?device_id=${app.device.id}` : ""}`);
    } catch (e) {
      if (e.status === 404 || e.status === 403 || e.code === "room_gone") { toast("This room is closed or you're no longer in it."); navigate("/rooms"); return; }
      return;
    }
    drawHead(); drawNeeds(); drawTable(); drawPeople(); drawDanger();
    loadInvite(); loadPersonInvites(); loadActivity(); verify();
  }

  drawHead(); drawNeeds(); drawTable(); drawPeople(); drawInvite(); drawPersonInvites(); drawActivity(); drawDanger();
  loadInvite(); loadPersonInvites(); loadActivity(); verify();
  // opened from an Invite control (/rooms/<id>#invite): bring the invite panel into view once the page is on screen
  if (location.hash === `#${INVITE_PANEL}`) {
    const panel = el.querySelector(`#${INVITE_PANEL}`);
    const show = () => (panel.isConnected ? panel.scrollIntoView({ block: "start" }) : requestAnimationFrame(show));
    requestAnimationFrame(show);
  }
  const mq = matchMedia("(max-width: 560px)");
  const onMq = () => drawTable(true);
  mq.addEventListener("change", onMq);
  return { el, title: `#${detail.room.name}`, refresh, cleanup: () => mq.removeEventListener("change", onMq) };
}
