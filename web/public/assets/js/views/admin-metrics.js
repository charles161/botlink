// Admin: the numbers that decide the company (KILL-CRITERIA.md), from GET /app/v1/admin/metrics.
// Plain tables: the thresholds with met / not met / too early beside the numbers, then the funnel, the weekly series,
// retention and activation. Counts only: the server never sends an email address or a domain here.
// Asked for only when the admin clicks (the queries read the whole history); not part of the 5 s refresh.
import { h, fill } from "../dom.js";
import { get, errorText } from "../api.js";
import { icon } from "../art.js";

const KEY = "botlink-admin-launch"; // the launch moment, remembered in this browser only
const STATUS = { met: ["Met", "is-met", "ok"], not_met: ["Not met", "is-not-met is-bad", "bad"], too_early: ["Too early", "is-early is-gone", null] };

const n = (x) => (x === null || x === undefined ? null : Number(x).toLocaleString());
const pct = (x) => (x === null || x === undefined ? null : `${Number(x).toLocaleString(undefined, { maximumFractionDigits: 1 })} %`);
const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const muted = (t) => h("span", { class: "muted" }, t);
const or = (v, empty) => (v === null ? muted(empty) : v);

function table(label, cols, rows) {
  return h("div", { class: "adm-table-wrap" },
    h("table", { class: "adm-table", "aria-label": label },
      h("thead", null, h("tr", null, cols.map((c) => h("th", { scope: "col", class: c.num && "num" }, c.label)))),
      h("tbody", null, rows.map((r) => h("tr", { class: r._cls }, cols.map((c) => h("td", { "data-label": c.label, class: c.num && "num" }, c.get(r))))))));
}

function value(t) {
  if (t.value === null || t.value === undefined) return muted("no data yet");
  if (t.unit === "pct") return pct(t.value);
  if (t.unit === "yes") return t.value ? "yes" : "no";
  return n(t.value);
}
const goal = (t) => (t.unit === "pct" ? `${t.goal} % or more` : t.unit === "yes" ? "yes" : `${n(t.goal)} or more`);

function status(t) {
  const [label, , dot] = STATUS[t.status] || [t.status, "", null];
  return dot ? h("span", { class: ["adm-dot", dot === "bad" && "bad"] }, label) : muted(label);
}

const FUNNEL = [
  ["signups", "Sign-ups"], ["rooms_created", "Rooms started"], ["person_invites_made", "Invites to a person"],
  ["person_requests", "People who used an invite"], ["people_approved", "People approved"], ["chat_join_requests", "Chats asking to join"],
  ["chat_joins_approved", "Chats approved"], ["rooms_first_message", "Rooms with a first message"], ["rooms_2plus_people", "Rooms with chats of 2+ people"],
  ["rooms_between_people", "Rooms between people (both sides sent)"], ["rooms_between_people_2plus_domains", "… spanning 2+ email domains"],
  ["rooms_between_people_2plus_domains_split_freemail", "… counting each free-mail address as its own domain"],
  ["cross_domain_pct", "Share spanning 2+ domains", true], ["rooms_idle_answer", "Rooms with an answer while idle (the one number)"],
  ["back_next_week", "Rooms between people back the week after"], ["back_next_week_pct", "Share back the week after", true],
];

function render(d) {
  const thresholds = table("Thresholds", [
    { label: "When", get: (t) => t.when },
    { label: "What has to be true", get: (t) => h("span", null, h("b", null, t.label), h("br"), muted(t.source)) },
    { label: "Goal", get: goal },
    { label: "Now", num: true, get: value },
    { label: "Status", get: status },
    { label: "Then", get: (t) => h("span", null, t.then, h("br"), h("code", { class: "adm-code" }, t.query)) },
  ], d.thresholds.map((t) => ({ ...t, _cls: (STATUS[t.status] || [])[1] })));

  const f1 = d.funnel_week1, f30 = d.funnel_day30;
  const funnel = table("Funnel: launch week and first 30 days", [
    { label: "Step", get: (r) => r.label },
    { label: `Launch week (to ${day(f1.until)})`, num: true, get: (r) => or(r.pct ? pct(f1[r.key]) : n(f1[r.key]), "too early") },
    { label: `First 30 days (to ${day(f30.until)})`, num: true, get: (r) => or(r.pct ? pct(f30[r.key]) : n(f30[r.key]), "too early") },
  ], FUNNEL.map(([key, label, isPct]) => ({ key, label, pct: isPct })));

  const weekly = table("Weekly series", [
    { label: "Week of", get: (r) => h("span", null, day(r.week), r.week_complete ? null : muted(" (so far)")) },
    { label: "Active rooms", num: true, get: (r) => n(r.rooms_active) },
    { label: "2+ people", num: true, get: (r) => n(r.rooms_2plus_people) },
    { label: "2+ domains", num: true, get: (r) => n(r.rooms_2plus_domains) },
    { label: "2+ domains, free-mail split", num: true, get: (r) => n(r.rooms_2plus_domains_split_freemail) },
    { label: "Between people", num: true, get: (r) => n(r.rooms_between_people) },
    { label: "… 2+ domains", num: true, get: (r) => or(pct(r.cross_domain_pct), "–") },
    { label: "With an idle answer", num: true, get: (r) => or(n(r.rooms_activated), "not kept") },
  ], [...d.weekly].reverse());

  const retention = table("Retention of rooms between people", [
    { label: "First week", get: (r) => day(r.cohort_week) },
    { label: "Rooms", num: true, get: (r) => n(r.rooms) },
    { label: "Back week +1", num: true, get: (r) => or(r.week1_back === null ? null : `${n(r.week1_back)} · ${pct(r.week1_pct) ?? "–"}`, "too early") },
    { label: "Back week +4", num: true, get: (r) => or(r.week4_back === null ? null : `${n(r.week4_back)} · ${pct(r.week4_pct) ?? "–"}`, "too early") },
  ], [...d.retention].reverse().filter((r) => r.rooms > 0));

  const activation = table("Activation by sign-up week", [
    { label: "Signed up", get: (r) => h("span", null, day(r.signup_week), r.complete ? null : muted(" (still counting)")) },
    { label: "Accounts", num: true, get: (r) => n(r.accounts) },
    { label: "In a room", num: true, get: (r) => n(r.in_room) },
    { label: "Chat approved", num: true, get: (r) => n(r.chat_approved) },
    { label: "First message", num: true, get: (r) => n(r.first_message) },
    { label: "Room between people", num: true, get: (r) => n(r.between_people) },
  ], [...d.activation].reverse().filter((r) => r.accounts > 0));

  const empty = (rows, el, text) => (rows.some(Boolean) ? el : h("p", { class: "muted adm-empty" }, text));
  return h("div", { class: "adm-body" },
    h("h3", { class: "adm-h3" }, `Thresholds for a launch on ${day(d.since)} (KILL-CRITERIA.md)`), thresholds,
    h("h3", { class: "adm-h3" }, "Funnel"), funnel,
    h("h3", { class: "adm-h3" }, "Every week (last 26)"), weekly,
    h("h3", { class: "adm-h3" }, "Rooms between people coming back"),
    empty(d.retention.map((r) => r.rooms > 0), retention, "No room between people yet."),
    h("h3", { class: "adm-h3" }, "New accounts, first 7 days"),
    empty(d.activation.map((r) => r.accounts > 0), activation, "No accounts in the last 26 weeks."),
    h("p", { class: "fine" }, icon("lock", { size: 16 }),
      "Counts only. Messages are deleted after 30 days, so answers while idle exist for recent weeks only; the other columns are kept."));
}

/** The section on the admin page. */
export default function metricsPanel() {
  let saved = "";
  try { saved = localStorage.getItem(KEY) || ""; } catch { /* storage blocked: start empty */ }
  const since = h("input", { type: "datetime-local", name: "since", id: "adm-since", class: "input", value: saved, "aria-describedby": "adm-since-help" });
  const go = h("button", { type: "submit", class: "btn btn-primary" }, "Show the numbers");
  const out = h("div", { "aria-live": "polite" });
  const form = h("form", { class: "field" },
    h("label", { for: "adm-since" }, "Launch moment (your time)"),
    since,
    h("p", { id: "adm-since-help", class: "fine" }, "The time of the launch post. Empty: 7 days ago."),
    h("div", { class: "row-actions" }, go));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try { localStorage.setItem(KEY, since.value); } catch { /* fine */ }
    const q = since.value ? `?since=${encodeURIComponent(new Date(since.value).toISOString().replace(/\.\d{3}Z$/, "Z"))}` : "";
    go.disabled = true;
    out.setAttribute("aria-busy", "true");
    try {
      const st = await get("/app/v1/admin/status"); // a closed area never costs a 403
      if (!st.unlocked) throw Object.assign(new Error("locked"), { code: "admin_locked" });
      fill(out, render(await get(`/app/v1/admin/metrics${q}`)));
    } catch (err) {
      const msg = err.code === "admin_locked" ? "Confirm it's you above to open the admin area, then ask again." : errorText(err);
      fill(out, h("div", { class: "error-box", role: "alert" }, h("p", null, msg)));
    } finally {
      go.disabled = false;
      out.removeAttribute("aria-busy");
    }
  });
  return h("section", { class: "panel adm-panel", id: "adm-metrics" },
    h("div", { class: "panel-head" }, h("h2", null, icon("book"), "Numbers that decide the company"),
      h("span", { class: "panel-meta" }, "read only · counts only")),
    h("div", { class: "panel-body" }, form, out));
}
