// Plan and usage: the person's plan, each limit with where its number comes from, what being over means (in the
// mode the server reports), a heads-up before a boost ends, 30 days of usage (counts only, never message text),
// credits and their ledger, and the upgrade and billing buttons, only when payments are on. API: CONTRACT-PLANS.md.
import { h, fill, toast } from "../dom.js";
import { get, post, errorText, ApiError } from "../api.js";
import { icon } from "../art.js";
import { errorBox } from "./rooms.js";
import { LIMIT_KEYS, LIMIT_NAME, day, daysLeft, usd, num, sourceText, overMeaning, planErrorText, safeUrl, rememberCheckout } from "../plans-util.js";

const KIND = { grant: "Free credits", topup: "Bought", usage: "Used", refund: "Refunded" };
let dailyOpen = false; // "Each day" stays open across live refreshes

function panel(title, ic, meta, cls, ...body) {
  return h("section", { class: ["panel", "usage-panel", cls] },
    h("div", { class: "panel-head" }, h("h2", null, icon(ic), title), meta ? h("span", { class: "panel-meta" }, meta) : null),
    h("div", { class: "panel-body" }, ...body));
}

function busy(btn, on) { btn.disabled = on; btn.classList.toggle("busy", on); }
function spinBtn(cls, text, attrs) {
  return h("button", { type: "button", class: ["btn", cls], ...attrs }, h("span", { class: "spinner", "aria-hidden": "true" }), text);
}

async function startCheckout(btn, product, plan) {
  busy(btn, true);
  try {
    const r = await post("/app/v1/billing/checkout", { product });
    const url = safeUrl(r?.checkout_url);
    if (!url) throw new Error("no checkout address");
    rememberCheckout({ id: r.checkout_id, product, balance: plan.credits?.balance ?? 0 });
    location.assign(url);
  } catch (e) {
    toast(e instanceof ApiError ? planErrorText(e) : "Something went wrong on our side. Try again.", "error");
    busy(btn, false);
  }
}

async function openPortal(btn) {
  busy(btn, true);
  try {
    const r = await post("/app/v1/billing/portal", {});
    const url = safeUrl(r?.portal_url);
    if (!url) throw new Error("no portal address");
    location.assign(url);
  } catch (e) {
    toast(e instanceof ApiError ? planErrorText(e) : "Something went wrong on our side. Try again.", "error");
    busy(btn, false);
  }
}

function billingLine(p) {
  const b = p.billing || {};
  const until = b.paid_until && Date.parse(b.paid_until) > Date.now() ? day(b.paid_until, true) : null;
  if (["on_hold", "past_due", "failed"].includes(b.status)) return `The last payment didn't go through.${b.can_open_portal ? " Update your card in Manage billing." : ""}`;
  if (until && (b.cancel_at_period_end || b.status === "cancelled")) return `Paid until ${until}. It won't renew.`;
  if (until && b.status === "active") return `Billed ${b.interval === "year" ? "yearly" : "monthly"}. Renews on ${until}.`;
  return "What your plan allows and what you use.";
}

/** The room with the most members (or people), for the per-room limits. */
function fullest(rooms, field) {
  return (rooms || []).reduce((best, r) => (!best || r[field] > best[field] ? r : best), null);
}

function limitRow(key, lim, p) {
  const over = !!lim.over && p.mode !== "off";
  const perRoom = key === "agents_per_room" || key === "people_per_room";
  const room = perRoom ? fullest(p.rooms, key === "agents_per_room" ? "members" : "people") : null;
  const hasUse = typeof lim.used === "number";
  const mb = key === "storage_mb" ? " MB" : "";
  const pct = hasUse && lim.value > 0 ? Math.min(100, Math.round((lim.used / lim.value) * 100)) : 0;
  return h("li", { class: ["lim", over && "is-over"], "data-limit": key },
    h("div", { class: "lim-top" },
      h("span", { class: "lim-name" }, LIMIT_NAME[key], over ? h("span", { class: "badge lim-badge" }, "over") : null),
      h("span", { class: "lim-num" }, hasUse ? `${num(lim.used)}${mb} of ${num(lim.value)}${mb}` : `${num(lim.value)} days`)),
    hasUse ? h("div", {
      class: "lim-bar", role: "meter", "aria-label": LIMIT_NAME[key], "aria-valuemin": "0", "aria-valuemax": String(lim.value),
      "aria-valuenow": String(Math.min(lim.used, lim.value)), "aria-valuetext": `${lim.used}${mb} of ${lim.value}${mb}${over ? ", over" : ""}`,
    }, h("span", { class: "lim-fill", style: { width: `${pct}%` } })) : null,
    h("div", { class: "lim-foot" },
      h("span", { class: "lim-src" }, sourceText(lim, p.plan.name)),
      room ? h("span", { class: "lim-room" }, "Fullest room: #", room.name) : perRoom ? h("span", { class: "lim-room" }, "No rooms yet") : null));
}

/** Stored messages: every copy your chats send counts until it is removed, and the server's ceiling always refuses. */
function storageText(lim) {
  const cap = typeof lim.ceiling === "number" ? ` Past ${num(lim.ceiling)} MB, the most any account can have, new messages are refused in every plan, also during the beta.` : "";
  return `Stored messages: each copy your chats send counts. Its sealed text counts until it is removed (24 hours after it is read, or when it expires unread), and a small record of it for 30 days.${cap}`;
}

function notices(p, canUpgrade) {
  const out = [];
  const L = p.limits || {};
  if (p.over_limit && p.mode !== "off") {
    const lines = [];
    if (L.rooms?.over) lines.push(`You have ${num(L.rooms.used)} rooms. Your plan allows ${num(L.rooms.value)}.`);
    for (const r of p.rooms || []) {
      if ((r.over || []).includes("agents_per_room")) lines.push(`#${r.name} has ${num(r.members)} members. Your plan allows ${num(L.agents_per_room.value)}.`);
      if ((r.over || []).includes("people_per_room")) lines.push(`#${r.name} has ${num(r.people)} people. Your plan allows ${num(L.people_per_room.value)}.`);
    }
    if (L.storage_mb?.over) lines.push(`Your chats' messages take ${num(L.storage_mb.used)} MB on bot-link. Your plan allows ${num(L.storage_mb.value)} MB.`);
    out.push(h("div", { class: "usage-note usage-over" },
      h("span", { class: "usage-note-ic", "aria-hidden": "true" }, icon("alert", { size: 20 })),
      h("div", null, h("strong", null, "Over a limit"), lines.map((t) => h("p", null, t)), h("p", { class: "usage-mean" }, overMeaning(p.mode, canUpgrade)))));
  }
  const shown = new Set();
  for (const n of p.notices || []) {
    if (n.kind === "boost_ending" && n.text) {
      shown.add(n.limit);
      out.push(h("div", { class: "usage-note is-boost" }, h("span", { class: "usage-note-ic", "aria-hidden": "true" }, icon("clock", { size: 20 })),
        h("div", null, h("strong", null, "A boost ends soon"), h("p", null, n.text))));
    } else if (n.kind === "plan_ending" && n.text) {
      out.push(h("div", { class: "usage-note is-ending" }, h("span", { class: "usage-note-ic", "aria-hidden": "true" }, icon("bell", { size: 20 })),
        h("div", null, h("strong", null, "Your plan is ending"), h("p", null, n.text))));
    }
  }
  // A boost that ends within 7 days always gets a heads-up, even if the server sent no notice for it.
  for (const k of LIMIT_KEYS) {
    const b = L[k]?.boost;
    if (b?.ends_at && !shown.has(k) && daysLeft(b.ends_at) <= 7 && daysLeft(b.ends_at) > 0) {
      out.push(h("div", { class: "usage-note is-boost" }, h("span", { class: "usage-note-ic", "aria-hidden": "true" }, icon("clock", { size: 20 })),
        h("div", null, h("strong", null, "A boost ends soon"), h("p", null, `Your extra ${LIMIT_NAME[k].toLowerCase()} end on ${day(b.ends_at, true)}.`))));
    }
  }
  return out.length ? h("div", { class: "usage-notes" }, out) : null;
}

function upgradePanel(p, pro) {
  const monthly = pro.prices.find((x) => x.billed === "monthly");
  const yearly = pro.prices.find((x) => x.billed === "yearly");
  const btns = [];
  if (monthly) {
    const b = spinBtn("btn-primary", `Pro monthly · ${usd(monthly.usd_cents)} a month`, { "data-checkout": monthly.product });
    b.addEventListener("click", () => startCheckout(b, monthly.product, p)); btns.push(b);
  }
  if (yearly) {
    const b = spinBtn("btn-ghost", `Pro yearly · ${usd(yearly.usd_cents)} a month`, { "data-checkout": yearly.product });
    b.addEventListener("click", () => startCheckout(b, yearly.product, p)); btns.push(b);
  }
  return panel("Pro", "sparkle", null, "usage-upgrade",
    h("p", { class: "usage-pro-limits" }, `${num(pro.rooms)} rooms, ${num(pro.agents_per_room)} members per room, ${num(pro.people_per_room)} people per room, ${num(pro.history_days)} days of history.`),
    h("div", { class: "row-actions" }, btns),
    yearly ? h("p", { class: "help" }, `Yearly is billed ${usd(yearly.total_usd_cents)} at once.`) : null,
    h("p", { class: "fine" }, icon("users", { size: 16 }), "Priced per person. Agents and messages are never billed."));
}

function dailyPanel(u) {
  const rows = [...(u.days || [])].reverse(); // oldest first, left to right
  const max = Math.max(1, ...rows.map((r) => r.messages_sent || 0));
  const t = u.totals || {};
  const stat = (label, value) => h("div", { class: "ud-stat" }, h("span", { class: "ud-stat-label" }, label), h("strong", null, num(value)));
  const more = h("details", { class: "ud-more", open: dailyOpen },
    h("summary", null, "Each day"),
    h("div", { class: "adm-table-wrap" }, h("table", { class: "adm-table ud-table", "aria-label": "Daily usage" },
      h("thead", null, h("tr", null, ["Day", "Messages sent", "Chats active", "Wakes"].map((c, i) => h("th", { scope: "col", class: i ? "num" : null }, c)))),
      h("tbody", null, (u.days || []).map((r) => h("tr", null,
        h("td", { "data-label": "Day" }, day(r.day + "T00:00:00Z")),
        h("td", { "data-label": "Messages sent", class: "num" }, num(r.messages_sent)),
        h("td", { "data-label": "Chats active", class: "num" }, num(r.chats_active)),
        h("td", { "data-label": "Wakes", class: "num" }, num(r.wakes))))))));
  more.addEventListener("toggle", () => { dailyOpen = more.open; });
  return panel("Daily usage", "chat", `last ${rows.length} days`, "usage-daily",
    h("div", { class: "ud-stats" }, stat("Messages sent", t.messages_sent), stat("Most chats active in a day", t.chats_active_max), stat("Wakes", t.wakes)),
    rows.length ? h("div", { class: "ud-chart" },
      h("div", { class: "ud-bars", "aria-hidden": "true" }, rows.map((r) => h("span", {
        class: ["ud-bar", !r.messages_sent && "is-zero"], title: `${day(r.day + "T00:00:00Z")}: ${num(r.messages_sent)} messages sent`,
        style: { "--h": `${Math.round(((r.messages_sent || 0) / max) * 100)}%` },
      }))),
      h("div", { class: "ud-axis", "aria-hidden": "true" }, h("span", null, day(rows[0].day + "T00:00:00Z")), h("span", null, "Today")),
      h("p", { class: "sr-only" }, `Messages sent per day, last ${rows.length} days. The numbers are in "Each day".`)) : null,
    more,
    h("p", { class: "help" }, "Chats active: your chats that sent or read a message that day. Wakes: times bot-link woke one of your chats."),
    u.debits_on
      ? h("p", { class: "fine" }, icon("clock", { size: 16 }), `Credits per unit: ${num(u.prices?.message)} a message, ${num(u.prices?.chat_day)} a chat day, ${num(u.prices?.wake)} a wake. Today is counted once the day is over.`)
      : h("p", { class: "fine" }, icon("check", { size: 16 }), "Usage is counted. Nothing is charged for it right now."));
}

function creditsPanel(p, c, billingOn) {
  const entries = c?.entries || [];
  const pack = billingOn ? p.credits?.pack : null;
  let buy = null;
  if (pack) {
    buy = spinBtn("btn-ghost btn-sm", `Buy ${num(pack.credits)} credits`, { "data-checkout": pack.product });
    buy.addEventListener("click", () => startCheckout(buy, pack.product, p));
  }
  return panel("Credits", "sparkle", null, "usage-credits",
    h("div", { class: "credit-top" },
      h("div", null, h("strong", { class: "credit-balance" }, num(c?.balance ?? p.credits?.balance ?? 0)), h("span", { class: "credit-unit" }, " credits")),
      buy),
    entries.length
      ? h("div", { class: "adm-table-wrap" }, h("table", { class: "adm-table ledger", "aria-label": "Credit history" },
        h("thead", null, h("tr", null, h("th", { scope: "col" }, "When"), h("th", { scope: "col" }, "What"), h("th", { scope: "col", class: "num" }, "Credits"), h("th", { scope: "col", class: "num" }, "Balance"))),
        h("tbody", null, entries.map((e) => h("tr", null,
          h("td", { "data-label": "When" }, day(e.at, true)),
          h("td", { "data-label": "What" }, KIND[e.kind] || "Change", e.reason ? `: ${e.reason}` : ""),
          h("td", { "data-label": "Credits", class: ["num", e.amount < 0 ? "is-minus" : "is-plus"] }, `${e.amount > 0 ? "+" : ""}${num(e.amount)}`),
          h("td", { "data-label": "Balance", class: "num" }, num(e.balance_after)))))))
      : h("p", { class: "muted" }, "No credits yet."));
}

function render(p, u, c) {
  const billingOn = !!p.billing?.gateway && p.billing.gateway !== "off";
  const pro = billingOn && p.plan?.id !== "pro" ? (p.for_sale || []).find((x) => x.id === "pro" && x.prices?.length) : null;
  let manage = null;
  if (billingOn && p.billing.can_open_portal) {
    manage = spinBtn("btn-ghost", "Manage billing", { "data-portal": "" });
    manage.addEventListener("click", () => openPortal(manage));
  }
  const L = p.limits || {};
  return h("div", { class: "usage-body" },
    h("div", { class: "page-head usage-head" },
      h("div", null,
        h("p", { class: "kicker" }, "Plan and usage"),
        h("h1", { class: "h1" }, `${p.plan?.name || "Your"} plan`),
        h("p", { class: "lead small usage-sub" }, billingLine(p))),
      manage ? h("div", { class: "usage-head-side" }, manage) : null),
    notices(p, !!pro),
    h("div", { class: "usage-grid" },
      panel("Limits", "door", p.mode === "count" ? "counted" : p.mode === "off" ? "not counted right now" : null, "usage-limits",
        h("ul", { class: "lims" }, LIMIT_KEYS.filter((k) => L[k]).map((k) => limitRow(k, L[k], p))),
        L.storage_mb ? h("p", { class: "fine" }, icon("alert", { size: 16 }), storageText(L.storage_mb)) : null,
        h("p", { class: "fine" }, icon("lock", { size: 16 }), "A room over a limit stays readable. If your plan's numbers are lowered later, you keep what you have now.")),
      h("div", { class: "usage-side" }, pro ? upgradePanel(p, pro) : null, creditsPanel(p, c, billingOn))),
    dailyPanel(u));
}

export default async function usage() {
  const box = h("div", { "aria-busy": "true" }, h("div", { class: "sk sk-block" }), h("div", { class: "sk sk-block" }), h("div", { class: "sk sk-block" }));
  const el = h("section", { class: "page usage-page" },
    h("a", { href: "/rooms", class: "back" }, icon("arrowLeft", { size: 18 }), "Your rooms"),
    box);
  let shown = false;
  async function refresh() {
    try {
      const [p, u, c] = await Promise.all([get("/app/v1/plan"), get("/app/v1/usage?days=30"), get("/app/v1/credits?limit=50")]);
      box.removeAttribute("aria-busy");
      const y = window.scrollY;
      fill(box, render(p, u, c));
      if (shown) window.scrollTo(0, y);
      shown = true;
    } catch (e) {
      box.removeAttribute("aria-busy");
      if (!shown) fill(box, h("h1", { class: "h1" }, "Plan and usage"), errorBox(errorText(e), refresh));
    }
  }
  await refresh();
  return { el, title: "Plan and usage", refresh };
}
