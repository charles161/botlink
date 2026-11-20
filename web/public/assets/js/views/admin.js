// Admin (owner only, read-only): accounts, rooms, members, how messages are moving, always-on wake-ups, quotas,
// this server copy's health and recent errors. Metadata only: the server never sends message text here.
// Shown only to accounts the server marks is_admin; everyone else gets the not-found page (the API answers 404).
// Opens after a human check ("Confirm it's you"), for 30 minutes in this browser session; refreshes every 5 s.
import { h, ago, absTime, fill, toast } from "../dom.js";
import { get, post, errorText } from "../api.js";
import { icon, appName } from "../art.js";
import { humanCheck } from "../humancheck.js";
import notFound from "./not-found.js";
import metricsPanel from "./admin-metrics.js";
import { plansSection } from "./admin-plans.js";
import { storageSection } from "./admin-storage.js";
import { paywallOn } from "../app.js";

const POLL_MS = 5000;
const FIRST = 10; // long lists show this many rows, the rest behind "Show all"
const opened = new Set(); // which "Show all" boxes are open, kept across the 5 s refreshes
function more(key, summary, ...body) {
  return h("details", { class: "adm-more", open: opened.has(key), on: { toggle: (e) => { if (e.currentTarget.open) opened.add(key); else opened.delete(key); } } },
    h("summary", null, summary), ...body);
}
/** table() with only the first rows visible; the rest open on demand. */
function capped(key, label, cols, rows, empty) {
  if (rows.length <= FIRST) return table(label, cols, rows, empty);
  return h("div", { class: "adm-capped" }, table(label, cols, rows.slice(0, FIRST), empty),
    more(key, `Show all ${rows.length}`, table(`${label} (rest)`, cols, rows.slice(FIRST), empty)));
}

const STATES = [
  ["waiting", "Waiting"], ["shown", "Shown to the chat"], ["done", "Done"],
  ["stuck", "Stuck"], ["needs_resend", "Needs resend"], ["expired", "Expired"],
];
const STUCK_REASONS = {
  attempts: "Tried too many times", wakes: "Woken too many times", undecryptable: "Can't be opened by the chat",
  bad_signature: "Signature didn't check out", cannot_wake: "Chat can't be woken",
};
const PUSH_CLASSES = {
  blocked: "Address not allowed", http_4xx: "Their server said no (4xx)", http_5xx: "Their server failed (5xx)",
  http_other: "Unexpected answer", timeout: "Timed out", refused: "Connection refused", dns: "Address not found",
  tls: "Certificate problem", network: "Network error",
};
const LIMITS = {
  "send:m": "Sends per member", "send:md": "Sends per member per day", "send:r": "Sends per room",
  "join:k": "Join requests per key", "join:i": "Join requests per invite", "invfail:ip": "Failed invite lookups per address",
  "ask:m": "Asks for a human", "approve:a": "Approvals per person", "pinv:a": "Person invites per owner",
  "dash:s": "Dashboard requests per browser", "selftest:m": "Self-tests per member",
};

const n = (x) => Number(x || 0).toLocaleString();
const win = (s) => (s >= 86400 ? `${s / 86400} day` : s >= 3600 ? `${s / 3600} h` : `${s / 60} min`);
const bytes = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.round(b / (1 << 20))} MB`);
function dur(s) {
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${hr} h` : hr ? `${hr} h ${m} min` : `${m} min`;
}
// Route patterns use a few internal words; show the dashboard's words instead.
const routeLabel = (r) => String(r).replace(/\/lease\b/, "/take");
const when = (iso) => (iso ? h("time", { datetime: iso, title: absTime(iso) }, ago(iso)) : h("span", { class: "muted" }, "never"));

function stat(label, value, sub, tone) {
  return h("div", { class: ["adm-stat", tone && `is-${tone}`] },
    h("span", { class: "adm-stat-label" }, label),
    h("strong", { class: "adm-stat-value" }, value),
    sub ? h("span", { class: "adm-stat-sub" }, sub) : null);
}

function panel(title, ic, meta, ...body) {
  return h("section", { class: "panel adm-panel" },
    h("div", { class: "panel-head" }, h("h2", null, icon(ic), title), meta ? h("span", { class: "panel-meta" }, meta) : null),
    h("div", { class: "panel-body" }, ...body));
}

/** A table that becomes stacked cards on phones (each cell carries its column name). */
function table(label, cols, rows, empty) {
  if (!rows.length) return h("p", { class: "muted adm-empty" }, empty);
  return h("div", { class: "adm-table-wrap" },
    h("table", { class: "adm-table", "aria-label": label },
      h("thead", null, h("tr", null, cols.map((c) => h("th", { scope: "col", class: c.num && "num" }, c.label)))),
      h("tbody", null, rows.map((r) => h("tr", { class: r._cls }, cols.map((c) => h("td", { "data-label": c.label, class: c.num && "num" }, c.get(r))))))));
}

function kv(pairs) {
  return h("dl", { class: "adm-kv" }, pairs.map(([k, v]) => h("div", null, h("dt", null, k), h("dd", null, v))));
}

const dot = (ok, yes, no) => h("span", { class: ["adm-dot", ok ? "ok" : "bad"] }, ok ? yes : no);

function render(d) {
  const t = d.totals, srv = d.server, c = srv.counters;
  const stuckTotal = d.copies.total.stuck;
  const stats = h("div", { class: "adm-stats" },
    stat("People", n(t.accounts), `${n(t.people_active_24h)} active today`),
    stat("Rooms", n(t.rooms)),
    stat("Members", n(t.members)),
    stat("Messages", n(t.messages_24h), `last 24 h${t.self_tests_24h ? ` · ${n(t.self_tests_24h)} self-tests` : ""}`),
    stat("Waiting", n(d.copies.total.waiting), "copies not shown yet"),
    stat("Stuck", n(stuckTotal), stuckTotal ? "need a retry" : "all moving", stuckTotal ? "bad" : "ok"));

  const health = panel(`This server copy · ${srv.copy_id}`, "monitor", srv.ready ? "Ready" : "Not ready",
    h("div", { class: "adm-health" },
      dot(srv.ready, "Ready", "Not ready"), dot(srv.db_ok, "Database OK", "Database down"),
      dot(srv.listen_connected, "Wake connection up", "Wake connection down")),
    kv([
      ["Up for", `${dur(srv.uptime_s)} (since ${absTime(srv.started_at)})`],
      ["Open inbox waits", `${n(srv.open_polls.inbox)} inbox · ${n(srv.open_polls.wait)} listener`],
      ["Requests", `${n(c.http_requests)} · ${n(c.http_4xx)} refused · ${n(c.http_429)} too many · ${n(c.http_5xx)} server error${c.http_5xx === 1 ? "" : "s"}`],
      ["Copies marked stuck", n(c.stuck)], ["Inbox retries", n(c.inbox_retries)], ["Wake reconnects", n(c.listen_reconnects)],
      ["Always-on wake-ups", Object.keys(c.push).length ? Object.entries(c.push).map(([k, v]) => `${k} ${n(v)}`).join(" · ") : "none yet"],
      ["Memory", `${bytes(srv.rss_bytes)} · ${n(srv.goroutines)} goroutines`],
      ["Environment", srv.env],
    ]),
    h("p", { class: "fine" }, icon("clock", { size: 16 }), "Counters are for this copy since it started. Other copies keep their own."));

  const flow = panel("How messages are moving", "send", "one copy per recipient, last 30 days",
    h("ul", { class: "adm-states" }, STATES.map(([k, l]) => h("li", { class: `st-${k}` }, h("strong", null, n(d.copies.total[k])), h("span", null, l)))),
    h("h3", { class: "adm-h3" }, "Per room"),
    table("Messages by room", [
      { label: "Room", get: (r) => h("span", { class: "adm-room" }, "#", r.room_name) },
      ...STATES.map(([k, l]) => ({ label: l, num: true, get: (r) => (r.states[k] ? n(r.states[k]) : h("span", { class: "muted" }, "0")) })),
    ], d.copies.per_room.map((r) => ({ ...r, _cls: r.states.stuck ? "is-bad" : null })), "No messages yet."),
    h("h3", { class: "adm-h3" }, "Why copies are stuck"),
    Object.values(d.copies.stuck_reasons).some(Boolean)
      ? h("ul", { class: "adm-reasons" }, Object.entries(d.copies.stuck_reasons).filter(([, v]) => v).map(([k, v]) =>
        h("li", { class: "is-bad" }, h("span", null, STUCK_REASONS[k] || k), h("strong", null, n(v)))))
      : h("p", { class: "muted adm-empty" }, "Nothing is stuck."));

  const p = d.push;
  const push = panel("Always-on wake-ups", "bell", `${n(p.always_on_members)} always-on member${p.always_on_members === 1 ? "" : "s"}`,
    kv([["Pending", n(p.pending)], ["Retrying", n(p.retrying)], ["Gave up", `${n(p.failed)} (${n(p.failed_24h)} today)`]]),
    p.error_classes.length ? h("ul", { class: "adm-reasons" }, p.error_classes.map((e) =>
      h("li", { class: "is-bad" }, h("span", null, PUSH_CLASSES[e.class] || e.class), h("strong", null, n(e.count))))) : null,
    table("Recent wake-ups that gave up", [
      { label: "Member", get: (r) => h("span", null, h("b", null, r.member_name), " in #", r.room_name) },
      { label: "Tries", num: true, get: (r) => n(r.tries) },
      { label: "Why", get: (r) => PUSH_CLASSES[r.error_class] || r.error_class },
      { label: "When", get: (r) => when(r.created_at) },
    ], p.recent_failures, "No wake-ups gave up."),
    h("p", { class: "fine" }, icon("shield", { size: 16 }), "Addresses and keys are never shown here, only the kind of error."));

  const quotaCols = [
      { label: "Quota", get: (r) => h("span", null, LIMITS[r.limit] || r.limit, h("code", { class: "adm-code" }, r.limit)) },
      { label: "Limit", get: (r) => `${n(r.max)} / ${win(r.window_s)}` },
      { label: "Times reached", num: true, get: (r) => n(r.windows_at_limit_24h) },
      { label: "Turned away", num: true, get: (r) => n(r.turned_away_24h) },
      { label: "This copy", num: true, get: (r) => n(r.turned_away_this_copy) },
      { label: "Last", get: (r) => (r.last_at ? when(r.last_at) : h("span", { class: "muted" }, "not today")) },
  ];
  const reached = d.rate_limits.filter((r) => r.windows_at_limit_24h || r.turned_away_this_copy);
  const all = more("quotas", `All ${d.rate_limits.length} quotas`,
    table("All quotas", quotaCols, d.rate_limits.map((r) => ({ ...r, _cls: r.windows_at_limit_24h ? "is-warn" : null })), "No quotas."));
  const limits = panel("Quotas", "clock", "last 24 h, all copies",
    reached.length ? table("Quotas reached", quotaCols, reached.map((r) => ({ ...r, _cls: "is-warn" })), "") : h("p", { class: "muted adm-empty" }, "No quota was reached in the last 24 h."),
    all);

  const errs = panel("Recent server errors", "alert", `this copy · ${n(d.errors.total)} since start`,
    table("Recent server errors", [
      { label: "When", get: (r) => when(r.at) },
      { label: "Route", get: (r) => h("code", { class: "adm-code" }, routeLabel(r.route)) },
      { label: "Code", num: true, get: (r) => String(r.status) },
      { label: "Request id", get: (r) => h("code", { class: "adm-code" }, r.request_id) },
    ], d.errors.items, "No server errors on this copy."),
    h("p", { class: "fine" }, icon("book", { size: 16 }), "Only this copy's last 100. Look the request id up in the logs for details."));

  const accounts = panel("People", "users", `${n(d.accounts.total)} account${d.accounts.total === 1 ? "" : "s"}`,
    capped("people", "People", [
      { label: "Name", get: (r) => h("span", null, h("b", null, r.display_name), r.is_admin ? h("span", { class: "badge badge-owner adm-badge" }, "admin") : null) },
      { label: "Email", get: (r) => h("span", { class: "adm-mail" }, r.email) },
      { label: "Rooms", num: true, get: (r) => n(r.rooms) },
      { label: "Joined", get: (r) => when(r.created_at) },
      { label: "Last active", get: (r) => when(r.last_seen_at) },
    ], [...d.accounts.items].sort((a, b) => b.is_admin - a.is_admin), "No accounts yet."),
    h("p", { class: "fine" }, icon("lock", { size: 16 }), "Emails are shortened except for admins."));

  const rooms = panel("Rooms", "door", `${n(d.rooms.total)} room${d.rooms.total === 1 ? "" : "s"}`,
    capped("rooms", "Rooms", [
      { label: "Room", get: (r) => h("span", { class: "adm-room" }, "#", r.name) },
      { label: "Owner", get: (r) => r.owner_name },
      { label: "Members", num: true, get: (r) => n(r.member_count) },
      { label: "People", num: true, get: (r) => n(r.people_count) },
      { label: "Started", get: (r) => when(r.created_at) },
    ], d.rooms.items, "No rooms yet."));

  const members = panel("Members", "chat", `${n(d.members.total)} including removed`,
    capped("members", "Members", [
      { label: "Member", get: (r) => h("span", null, h("b", null, r.name), " in #", r.room_name) },
      { label: "App", get: (r) => appName(r.app, r.app_name) },
      { label: "Person", get: (r) => r.person_name },
      { label: "Turn", get: (r) => h("span", { class: ["adm-turn", r.listening && "is-live", r.removed && "is-gone"] }, r.turn_label) },
      { label: "Chat open", get: (r) => (r.removed ? "–" : r.holder_present ? "yes" : "no") },
      { label: "Last active", get: (r) => when(r.last_active_at) },
      { label: "State", get: (r) => (r.removed ? h("span", { class: "muted" }, `removed ${ago(r.removed_at)}`) : r.stuck ? h("span", { class: "badge badge-stuck" }, "stuck") : "ok") },
    ], d.members.items.map((r) => ({ ...r, _cls: r.removed ? "is-gone" : r.stuck ? "is-bad" : null })), "No members yet."));

  return h("div", { class: "adm-body" }, stats,
    h("div", { class: "adm-grid" }, health, flow),
    h("div", { class: "adm-grid" }, push, errs),
    limits, accounts, rooms, members);
}

export default async function admin(ctx) {
  if (!ctx.app.me?.is_admin) return notFound();
  const status = h("p", { class: "adm-live", role: "status", "aria-live": "polite" });
  const lockBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm", hidden: true }, icon("lock", { size: 18 }), "Lock now");
  const box = h("div", { "aria-busy": "true" }, h("div", { class: "sk sk-block" }), h("div", { class: "sk sk-block" }), h("div", { class: "sk sk-block" }));
  const el = h("section", { class: "page adm-page" },
    h("div", { class: "page-head" },
      h("div", null,
        h("p", { class: "kicker" }, "Admin"),
        h("h1", { class: "h1" }, "How bot-link is doing"),
        h("p", { class: "lead small" }, "Counts and health for this server. Never message text: the server can't read it anyway.")),
      h("div", { class: "adm-head-side" }, status, lockBtn)),
    box, metricsPanel());
  // sections behind the unlock: stored messages in every mode; plans and limits (CONTRACT-PLANS.md) only with the paywall on
  const onLocked = () => { openUntil = 0; showLocked(); };
  const sections = [storageSection({ onLocked }), ...(paywallOn() ? [plansSection({ onLocked })] : [])];
  for (const s of sections) { el.append(s.el); el.querySelector(".adm-head-side").append(s.jump); }

  let timer = null, last = null, stopped = false, locked = false, inflight = false;
  const schedule = () => { clearTimeout(timer); if (!stopped && !locked && document.visibilityState !== "hidden") timer = setTimeout(refresh, POLL_MS); };

  function showLocked() {
    locked = true; lockBtn.hidden = true; status.textContent = ""; sections.forEach((s) => s.hide());
    box.removeAttribute("aria-busy");
    const go = h("button", { type: "button", class: "btn btn-primary", "data-autofocus": "" }, icon("fingerprint", { size: 20 }), "Confirm it's you");
    go.addEventListener("click", unlock);
    fill(box, h("div", { class: "card adm-lock" },
      h("div", { class: "adm-lock-ic", "aria-hidden": "true" }, icon("lock", { size: 30 })),
      h("h2", { class: "modal-title" }, "Confirm it's you"),
      h("p", { class: "lead small" }, "The admin area opens for 30 minutes in this browser after a quick human check."),
      h("div", { class: "row-actions" }, go)));
  }

  async function unlock() {
    const ok = await humanCheck({
      action: "admin", startPath: "/app/v1/admin/human-check", title: "Confirm it's you",
      lead: "Only people can open the admin area. It stays open for 30 minutes in this browser.",
      confirmLabel: "Open admin", unlockLabel: "Unlock & open", busyLabel: "Opening…",
      onProof: (proof) => post("/app/v1/admin/unlock", { human_check: proof }),
    });
    if (ok) { locked = false; toast("Admin is open for 30 minutes."); refresh(); }
  }

  lockBtn.addEventListener("click", async () => {
    try { await post("/app/v1/admin/lock"); openUntil = 0; toast("Admin locked."); showLocked(); } catch (e) { toast(errorText(e), "error"); }
  });

  let openUntil = 0; // ms; known from status / the last overview, so a closed area never costs a 403
  async function refresh() {
    if (stopped || inflight) return;
    inflight = true;
    try {
      if (openUntil <= Date.now()) {
        const st = await get("/app/v1/admin/status");
        if (stopped) return;
        if (!st.unlocked) { showLocked(); return; }
        openUntil = Date.parse(st.unlocked_until);
      }
      const d = await get("/app/v1/admin/overview");
      openUntil = Date.parse(d.unlocked_until);
      if (stopped) return;
      locked = false; last = d;
      box.removeAttribute("aria-busy");
      const y = window.scrollY;
      fill(box, render(d));
      window.scrollTo(0, y);
      lockBtn.hidden = false; sections.forEach((s) => s.show());
      status.replaceChildren(h("span", { class: "eyebrow-dot", "aria-hidden": "true" }),
        ` Live · open until ${new Date(d.unlocked_until).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`);
    } catch (e) {
      if (e.code === "admin_locked") { openUntil = 0; showLocked(); }
      else if (e.status === 404) { const nf = await notFound(); fill(el, nf.el); stopped = true; }
      else if (!last) fill(box, h("div", { class: "error-box", role: "alert" }, h("p", null, errorText(e))));
      else status.textContent = "Couldn't refresh. Trying again…";
    } finally { inflight = false; schedule(); }
  }

  const onVis = () => { if (document.visibilityState === "visible") refresh(); else clearTimeout(timer); };
  document.addEventListener("visibilitychange", onVis);
  await refresh();
  return {
    el, title: "Admin",
    cleanup: () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); },
  };
}
