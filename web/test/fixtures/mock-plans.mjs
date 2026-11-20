// Mock of the plans, limits, credits, usage and billing API (CONTRACT-PLANS.md, lane D1) for the web tests.
// Installed by mock-server.mjs. In memory; the fixtures are the contract's mock accounts (asha, ben, cara) plus a
// fresh Free account for anyone else. Test hook: POST /__mock/plans (see the bottom of this file).
//
// The public pricing route GET /app/v1/pricing is NOT in the contract yet (lane D2 asked lane D1 for it); its shape
// here is the one web/public/assets/js/pricing.js reads.
import { randomUUID } from "node:crypto";

const KEYS = ["rooms", "agents_per_room", "people_per_room", "history_days", "storage_mb"];
const LABEL = { rooms: "rooms", agents_per_room: "members per room", people_per_room: "people per room", history_days: "days of history", storage_mb: "MB of stored messages" };
// storage_mb's ceiling is the server's per-account safety ceiling (BOTLINK_STORAGE_CEILING_MB, default 256)
const CEILING = { rooms: 20, agents_per_room: 20, people_per_room: 10, history_days: null, storage_mb: 256 };
const DAY = 86400e3;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const dayName = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const maxOf = (...xs) => Math.max(...xs.filter((x) => typeof x === "number"));

let S;
function seedPlans() {
  const at = iso(Date.now() - 4 * 3600e3);
  return {
    free: { id: "free", name: "Free", rooms: 3, agents_per_room: 5, people_per_room: 4, history_days: 7, storage_mb: 256, for_sale: false, price_month_usd_cents: 0, price_year_month_usd_cents: 0, base_accounts: 41, updated_at: at },
    pro: { id: "pro", name: "Pro", rooms: 20, agents_per_room: 20, people_per_room: 10, history_days: 30, storage_mb: 1024, for_sale: true, price_month_usd_cents: 1500, price_year_month_usd_cents: 1200, base_accounts: 3, updated_at: at },
    team: { id: "team", name: "Team", rooms: 100, agents_per_room: 50, people_per_room: 25, history_days: 30, storage_mb: 1024, for_sale: false, price_month_usd_cents: 0, price_year_month_usd_cents: 0, base_accounts: 0, updated_at: at },
  };
}
export function resetPlans() {
  S = { mode: "count", gateway: "off", payDelayMs: 1200, plans: seedPlans(), accounts: new Map(), checkouts: new Map(), log: [], recent: [], seq: 10, entrySeq: 10 };
  const t = Date.now();
  S.log.push(
    { id: 2, at: iso(t - 3 * 3600e3), actor_kind: "payment", actor: null, target: "account_plan", plan_id: "pro", account_id: "0193-mock-ben", limit: "plan", from: "free", to: "pro", reason: "subscription.active" },
    { id: 1, at: iso(t - 5 * 3600e3), actor_kind: "system", actor: null, target: "plan", plan_id: "free", account_id: null, limit: "history_days", from: "7", to: "7", reason: "Seeded" });
}
resetPlans();

const snapshotOf = (planId) => Object.fromEntries(KEYS.map((k) => [k, S.plans[planId][k]]));
const noRaises = () => Object.fromEntries(KEYS.map((k) => [k, null]));
const ledger = (rows) => rows.map((r, i) => ({ id: i + 1, ...r }));

const FIXTURES = {
  asha: () => {
    const t = Date.now();
    return {
      plan: "free", snapshot: snapshotOf("free"), raises: { ...noRaises(), people_per_room: 6 },
      boosts: [{ id: "0193-boost-asha", limit: "agents_per_room", value: 8, starts_at: iso(t - 2 * DAY), ends_at: iso(t + 5 * DAY), reason: "Demo week", by: "Charles" }],
      billing: { status: "none", interval: null, paid_until: null, cancel_at_period_end: false, customer_id: null, subscription_id: null },
      rooms: [{ id: "0193-r1", name: "design", members: 6, people: 3 }, { id: "0193-r2", name: "launch", members: 2, people: 1 }, { id: "0193-r3", name: "notes", members: 1, people: 1 }, { id: "0193-r4", name: "research", members: 3, people: 2 }],
      ledger: ledger([
        { at: iso(t - 3 * DAY), kind: "topup", amount: 100, reason: "Credits pack", balance_after: 100 },
        { at: iso(t - 2 * DAY), kind: "usage", amount: -50, reason: `Usage on ${iso(t - 3 * DAY).slice(0, 10)}`, balance_after: 50 },
        { at: iso(t - 3600e3), kind: "grant", amount: 200, reason: "Early tester", balance_after: 250 },
      ]),
      seed: 7, busy: true, stored_mb: 41,
    };
  },
  ben: () => ({
    plan: "pro", snapshot: snapshotOf("pro"), raises: noRaises(), boosts: [],
    billing: { status: "active", interval: "month", paid_until: iso(Date.now() + 30 * DAY), cancel_at_period_end: false, customer_id: "cus_mock_ben", subscription_id: "sub_mock_ben" },
    rooms: [{ id: "0193-r9", name: "ops", members: 3, people: 2 }, { id: "0193-r8", name: "support", members: 2, people: 1 }], ledger: [], seed: 3, busy: true,
  }),
  cara: () => ({
    plan: "pro", snapshot: snapshotOf("pro"), raises: noRaises(), boosts: [],
    billing: { status: "cancelled", interval: "month", paid_until: iso(Date.now() + 8 * DAY), cancel_at_period_end: true, customer_id: "cus_mock_cara", subscription_id: "sub_mock_cara" },
    rooms: [{ id: "0193-r7", name: "writing", members: 2, people: 1 }], ledger: [], seed: 5, busy: false,
  }),
  fresh: () => ({
    plan: "free", snapshot: snapshotOf("free"), raises: noRaises(), boosts: [],
    billing: { status: "none", interval: null, paid_until: null, cancel_at_period_end: false, customer_id: null, subscription_id: null },
    rooms: [{ id: "0193-r0", name: "first", members: 2, people: 1 }], ledger: [], seed: 1, busy: false,
  }),
};

function stateOf(id) {
  let a = S.accounts.get(id);
  if (!a) { a = { ...FIXTURES.fresh(), created_at: iso(Date.now() - 10 * DAY) }; S.accounts.set(id, a); }
  return a;
}
const activeBoost = (a, k, t = Date.now()) => a.boosts.filter((b) => b.limit === k && Date.parse(b.starts_at) <= t && Date.parse(b.ends_at) > t).sort((x, y) => y.value - x.value)[0] || null;
const permanent = (a, k) => maxOf(a.snapshot[k], a.raises[k]);
const balance = (a) => (a.ledger.length ? a.ledger[a.ledger.length - 1].balance_after : 0);
const addEntry = (a, kind, amount, reason) => { const e = { id: ++S.entrySeq, at: iso(Date.now()), kind, amount, reason, balance_after: balance(a) + amount }; a.ledger.push(e); return e; };
const logChange = (c) => { S.log.unshift({ id: ++S.seq, at: iso(Date.now()), plan_id: null, account_id: null, ...c }); };

function limitsOf(a) {
  const out = {};
  for (const k of KEYS) {
    const pv = a.snapshot[k], raise = a.raises[k], b = activeBoost(a, k);
    const base = maxOf(pv, raise, b?.value);
    const ceil = CEILING[k];
    const value = ceil == null ? base : Math.min(base, ceil);
    const source = ceil != null && base > ceil ? "ceiling" : b && b.value === base && b.value > maxOf(pv, raise) ? "boost" : raise != null && raise === base && raise > pv ? "raise" : "plan";
    const used = k === "rooms" ? a.rooms.length : k === "agents_per_room" ? Math.max(0, ...a.rooms.map((r) => r.members)) : k === "people_per_room" ? Math.max(0, ...a.rooms.map((r) => r.people)) : k === "storage_mb" ? (a.stored_mb ?? 1) : null;
    const lim = { value, source, plan_value: pv, raise, boost: b ? { id: b.id, value: b.value, ends_at: b.ends_at } : null, ceiling: ceil, used, over: S.mode !== "off" && used != null && used > value };
    if (k === "agents_per_room" || k === "people_per_room") lim.rooms_over = S.mode === "off" ? [] : a.rooms.filter((r) => (k === "agents_per_room" ? r.members : r.people) > value).map((r) => r.id);
    out[k] = lim;
  }
  return out;
}

function planView(id) {
  const a = stateOf(id);
  const limits = limitsOf(a);
  const notices = [];
  for (const k of KEYS) {
    const b = limits[k].boost;
    if (b && Date.parse(b.ends_at) - Date.now() < 7 * DAY) notices.push({ kind: "boost_ending", limit: k, ends_at: b.ends_at, text: `Your extra ${LABEL[k]} end on ${dayName(Date.parse(b.ends_at))}. After that the limit is ${permanent(a, k)}.` });
  }
  if (limits.rooms.over) notices.push({ kind: "over_limit", limit: "rooms", text: `You have ${limits.rooms.used} rooms. Your plan allows ${limits.rooms.value}. Your rooms stay open; you can't add more in block mode.` });
  if (a.billing.cancel_at_period_end && a.billing.paid_until && Date.parse(a.billing.paid_until) > Date.now()) notices.push({ kind: "plan_ending", limit: null, ends_at: a.billing.paid_until, text: `Pro ends on ${dayName(Date.parse(a.billing.paid_until))}. Then your account moves to Free. Your rooms stay open.` });
  const p = S.plans.pro;
  return {
    plan: { id: a.plan, name: S.plans[a.plan].name }, mode: S.mode, limits,
    rooms: a.rooms.map((r) => ({ ...r, over: [limits.agents_per_room.rooms_over.includes(r.id) && "agents_per_room", limits.people_per_room.rooms_over.includes(r.id) && "people_per_room"].filter(Boolean) })),
    over_limit: KEYS.some((k) => limits[k].over), notices,
    billing: { gateway: S.gateway, status: a.billing.status, interval: a.billing.interval, paid_until: a.billing.paid_until, cancel_at_period_end: a.billing.cancel_at_period_end, can_open_portal: S.gateway !== "off" && !!a.billing.customer_id },
    for_sale: a.plan === "pro" || !p.for_sale ? [] : [{ id: "pro", name: "Pro", rooms: p.rooms, agents_per_room: p.agents_per_room, people_per_room: p.people_per_room, history_days: p.history_days, prices: [
      { product: "pro_monthly", usd_cents: p.price_month_usd_cents, per: "month", billed: "monthly", total_usd_cents: p.price_month_usd_cents },
      { product: "pro_yearly", usd_cents: p.price_year_month_usd_cents, per: "month", billed: "yearly", total_usd_cents: p.price_year_month_usd_cents * 12 }] }],
    credits: { balance: balance(a), pack: S.gateway !== "off" ? { product: "credits_pack", credits: 500 } : null },
  };
}

function usageView(id, days) {
  const a = stateOf(id);
  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < days; i++) {
    const quiet = !a.busy ? i % 3 !== 0 : i % 6 === 5;
    const m = quiet ? 0 : (i * 37 + a.seed * 11) % 61;
    rows.push({ day: iso(t0 - i * DAY).slice(0, 10), messages_sent: m, chats_active: m ? 1 + ((i + a.seed) % 4) : 0, wakes: m ? (i * 7 + a.seed) % 9 : 0, credits_used: 0 });
  }
  return {
    days: rows,
    totals: { messages_sent: rows.reduce((s, r) => s + r.messages_sent, 0), chats_active_max: Math.max(0, ...rows.map((r) => r.chats_active)), wakes: rows.reduce((s, r) => s + r.wakes, 0), credits_used: 0 },
    prices: { message: 0, chat_day: 0, wake: 0 }, debits_on: false,
  };
}

const planAdminView = (p) => {
  const extra = [...S.accounts.values()].filter((a) => a.plan === p.id).length;
  const { base_accounts, ...rest } = p;
  return { ...rest, accounts: base_accounts + extra };
};
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export function installPlans({ route, E, adminGate, getAccount, accountByEmail, findAccountByEmail, maskEmail, ORIGIN }) {
  const reason = (body) => {
    const r = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!r || r.length > 300) throw new E(400, "bad_request", "Give a reason.");
    return r;
  };
  const adminName = (sess) => getAccount(sess.account_id).display_name;
  const findTarget = (id) => { if (!id || !getAccount(id)) throw new E(404, "not_found", "No account with that id."); return stateOf(id); };
  function accountView(id, byEmail) {
    const acct = getAccount(id), a = stateOf(id);
    const { for_sale, ...view } = planView(id);
    return {
      ...view,
      account: { id, display_name: acct.display_name, email: byEmail ? acct.email : maskEmail(acct.email), created_at: a.created_at },
      raises: { ...a.raises },
      boosts: a.boosts.map((b) => ({ ...b, active: Date.parse(b.starts_at) <= Date.now() && Date.parse(b.ends_at) > Date.now() })),
      billing: { ...view.billing, customer_id: a.billing.customer_id, subscription_id: a.billing.subscription_id },
    };
  }

  // public (no session): what the pricing page reads
  route("GET", /^\/app\/v1\/pricing$/, () => ({
    mode: S.mode,
    plans: Object.values(S.plans).map((p) => ({ id: p.id, name: p.name, rooms: p.rooms, agents_per_room: p.agents_per_room, people_per_room: p.people_per_room, history_days: p.history_days, storage_mb: p.storage_mb, for_sale: p.for_sale,
      prices: p.for_sale ? [{ product: "pro_monthly", usd_cents: p.price_month_usd_cents, per: "month", billed: "monthly", total_usd_cents: p.price_month_usd_cents },
        { product: "pro_yearly", usd_cents: p.price_year_month_usd_cents, per: "month", billed: "yearly", total_usd_cents: p.price_year_month_usd_cents * 12 }] : [] })),
  }), { open: true, nocsrf: true });

  // person routes
  route("GET", /^\/app\/v1\/plan$/, ({ sess }) => planView(sess.account_id));
  route("GET", /^\/app\/v1\/usage$/, ({ sess, url }) => {
    const d = Number(url.searchParams.get("days") || 30);
    if (!intIn(d, 1, 90)) throw new E(400, "bad_request", "days must be from 1 to 90.");
    return usageView(sess.account_id, d);
  });
  route("GET", /^\/app\/v1\/credits$/, ({ sess, url }) => {
    const a = stateOf(sess.account_id);
    const n = Number(url.searchParams.get("limit") || 50);
    return { balance: balance(a), entries: [...a.ledger].reverse().slice(0, n) };
  });
  route("POST", /^\/app\/v1\/billing\/checkout$/, ({ sess, body }) => {
    if (S.gateway === "off") throw new E(409, "billing_off", "Payments are not on yet.");
    const product = body?.product;
    if (!["pro_monthly", "pro_yearly", "credits_pack"].includes(product)) throw new E(400, "bad_request", "Pick pro_monthly, pro_yearly or credits_pack.");
    const a = stateOf(sess.account_id);
    if (product !== "credits_pack" && a.plan === "pro") throw new E(409, "already_on_plan", "You already have Pro. Use Manage billing to change it.");
    if (S.gateway === "down") throw new E(502, "payment_unavailable", "The payment service did not answer. Try again in a minute.");
    const id = randomUUID();
    S.checkouts.set(id, { id, account: sess.account_id, product, paid: false });
    return { checkout_id: id, checkout_url: `${ORIGIN}/billing/fake?checkout=${id}` };
  });
  route("POST", /^\/app\/v1\/billing\/portal$/, ({ sess }) => {
    if (S.gateway === "off") throw new E(409, "billing_off", "Payments are not on yet.");
    if (!stateOf(sess.account_id).billing.customer_id) throw new E(409, "no_billing_account", "You have not paid for anything yet, so there is nothing to manage.");
    return { portal_url: `${ORIGIN}/billing/fake/portal?customer=${stateOf(sess.account_id).billing.customer_id}` }; // as server/internal/billing/fake.go
  });
  route("POST", /^\/app\/v1\/billing\/fake\/pay$/, ({ sess, body }) => {
    if (S.gateway !== "fake") throw new E(404, "not_found", "Not found.");
    const c = S.checkouts.get(body?.checkout_id);
    if (!c || c.account !== sess.account_id) throw new E(404, "not_found", "Not found.");
    const event_type = c.product === "credits_pack" ? "payment.succeeded" : "subscription.active";
    if (!c.paid) {
      c.paid = true;
      const apply = c.apply = () => {
        if (c.applied) return;
        c.applied = true;
        const a = stateOf(c.account);
        if (c.product === "credits_pack") { addEntry(a, "topup", 500, "Credits pack"); return; }
        const yearly = c.product === "pro_yearly";
        a.plan = "pro";
        for (const k of KEYS) a.snapshot[k] = Math.max(a.snapshot[k], S.plans.pro[k]);
        a.billing = { status: "active", interval: yearly ? "year" : "month", paid_until: iso(Date.now() + (yearly ? 365 : 30) * DAY), cancel_at_period_end: false, customer_id: `cus_${c.id.slice(0, 8)}`, subscription_id: `sub_${c.id.slice(0, 8)}` };
        logChange({ actor_kind: "payment", actor: null, target: "account_plan", plan_id: "pro", account_id: c.account, limit: "plan", from: "free", to: "pro", reason: event_type });
      };
      if (S.payDelayMs >= 0) setTimeout(apply, S.payDelayMs);
    }
    return { ok: true, event_type };
  });

  // admin routes (same gate as the overview: 404 for non-admins, 403 admin_locked until unlocked)
  const A = { open: true, nocsrf: true };
  route("GET", /^\/app\/v1\/admin\/plans$/, (c) => {
    adminGate(c, true);
    return { mode: S.mode, ceiling: { rooms: 20, agents_per_room: 20, people_per_room: 10 }, plans: Object.values(S.plans).map(planAdminView) };
  }, A);
  route("POST", /^\/app\/v1\/admin\/plans\/update$/, (c) => {
    adminGate(c, true);
    const p = S.plans[c.body?.plan_id];
    if (!p) throw new E(404, "not_found", "No plan with that id.");
    const why = reason(c.body);
    const lim = c.body.limits || {};
    const changes = [];
    for (const [k, v] of Object.entries(lim)) {
      if (!KEYS.includes(k) || !intIn(v, 1, 10000)) throw new E(400, "bad_request", "Limits must be whole numbers from 1 to 10000.");
      if (v !== p[k]) changes.push({ limit: k, from: p[k], to: v });
    }
    if (!changes.length) throw new E(400, "bad_request", "Nothing to change.");
    let raised = 0;
    const onPlan = [...S.accounts.values()].filter((a) => a.plan === p.id);
    for (const ch of changes) {
      p[ch.limit] = ch.to;
      if (ch.to > ch.from) for (const a of onPlan) a.snapshot[ch.limit] = Math.max(a.snapshot[ch.limit], ch.to);
      logChange({ actor_kind: "admin", actor: { account_id: c.sess.account_id, display_name: adminName(c.sess) }, target: "plan", plan_id: p.id, limit: ch.limit, from: String(ch.from), to: String(ch.to), reason: why });
    }
    p.updated_at = iso(Date.now());
    const anyUp = changes.some((ch) => ch.to > ch.from), anyDown = changes.some((ch) => ch.to < ch.from);
    if (anyUp) raised = planAdminView(p).accounts;
    const note = anyUp && anyDown ? "Raised limits apply to every account on this plan now. Lowered limits apply only to accounts from now on."
      : anyUp ? "Raised limits apply to every account on this plan now." : "Lowered limits apply only to accounts from now on. Existing accounts keep what they have.";
    return { plan: planAdminView(p), changes, raised_accounts: raised, note };
  }, A);
  route("GET", /^\/app\/v1\/admin\/account$/, (c) => {
    adminGate(c, true);
    const id = c.url.searchParams.get("account_id"), email = c.url.searchParams.get("email");
    if (!id && !email) throw new E(400, "bad_request", "Give account_id or email.");
    if (email) {
      const known = findAccountByEmail(email.trim().toLowerCase());
      if (!known) throw new E(404, "not_found", "No account with that id or email.");
      return accountView(known.id, true);
    }
    if (!getAccount(id)) throw new E(404, "not_found", "No account with that id or email.");
    return accountView(id, false);
  }, A);
  route("POST", /^\/app\/v1\/admin\/account\/raise$/, (c) => {
    adminGate(c, true);
    const b = c.body || {};
    const a = findTarget(b.account_id);
    const why = reason(b);
    if (!KEYS.includes(b.limit)) throw new E(400, "bad_request", "Pick rooms, agents_per_room, people_per_room or history_days.");
    if (!intIn(b.value, 1, 10000)) throw new E(400, "bad_request", "Limits must be whole numbers from 1 to 10000.");
    const cur = permanent(a, b.limit);
    if (b.value <= cur) throw new E(409, "only_up", `A limit can only go up. This account already has ${cur}.`, { current: cur });
    a.raises[b.limit] = b.value;
    logChange({ actor_kind: "admin", actor: { account_id: c.sess.account_id, display_name: adminName(c.sess) }, target: "account", account_id: b.account_id, limit: b.limit, from: String(cur), to: String(b.value), reason: why });
    return accountView(b.account_id, false);
  }, A);
  route("POST", /^\/app\/v1\/admin\/account\/boost$/, (c) => {
    adminGate(c, true);
    const b = c.body || {};
    const a = findTarget(b.account_id);
    const why = reason(b);
    if (!KEYS.includes(b.limit)) throw new E(400, "bad_request", "Pick rooms, agents_per_room, people_per_room or history_days.");
    if (!intIn(b.value, 1, 10000)) throw new E(400, "bad_request", "Limits must be whole numbers from 1 to 10000.");
    const end = Date.parse(b.ends_at || "");
    if (!(end > Date.now() && end <= Date.now() + 366 * DAY)) throw new E(400, "bad_request", "The end date must be in the future and within a year.");
    const cur = permanent(a, b.limit);
    if (b.value <= cur) throw new E(409, "only_up", `A boost must be above the current limit of ${cur}.`, { current: cur });
    a.boosts.push({ id: randomUUID(), limit: b.limit, value: b.value, starts_at: iso(Date.now()), ends_at: iso(end), reason: why, by: adminName(c.sess) });
    logChange({ actor_kind: "admin", actor: { account_id: c.sess.account_id, display_name: adminName(c.sess) }, target: "boost", account_id: b.account_id, limit: b.limit, from: String(cur), to: `${b.value} until ${iso(end).slice(0, 10)}`, reason: why });
    return accountView(b.account_id, false);
  }, A);
  route("POST", /^\/app\/v1\/admin\/credits\/grant$/, (c) => {
    adminGate(c, true);
    const b = c.body || {};
    const a = findTarget(b.account_id);
    const why = reason(b);
    if (!intIn(b.amount, 1, 1000000)) throw new E(400, "bad_request", "Credits must be a whole number from 1 to 1000000.");
    const before = balance(a);
    const entry = addEntry(a, "grant", b.amount, why);
    logChange({ actor_kind: "admin", actor: { account_id: c.sess.account_id, display_name: adminName(c.sess) }, target: "credits", account_id: b.account_id, limit: "credits", from: String(before), to: String(entry.balance_after), reason: why });
    return { balance: entry.balance_after, entry };
  }, A);
  route("GET", /^\/app\/v1\/admin\/limit-changes$/, (c) => {
    adminGate(c, true);
    const q = c.url.searchParams;
    const n = Number(q.get("limit") || 100);
    return { changes: S.log.filter((x) => (!q.get("account_id") || x.account_id === q.get("account_id")) && (!q.get("plan_id") || x.plan_id === q.get("plan_id"))).slice(0, n) };
  }, A);
  route("GET", /^\/app\/v1\/admin\/over-limit$/, (c) => {
    adminGate(c, true);
    const accounts = [];
    for (const [id, a] of S.accounts) {
      const acct = getAccount(id);
      if (!acct) continue;
      const L = limitsOf(a), over = [];
      if (L.rooms.over) over.push({ limit: "rooms", used: L.rooms.used, value: L.rooms.value, room_id: null, room_name: null });
      for (const k of ["agents_per_room", "people_per_room"]) for (const r of a.rooms) {
        const used = k === "agents_per_room" ? r.members : r.people;
        if (S.mode !== "off" && used > L[k].value) over.push({ limit: k, used, value: L[k].value, room_id: r.id, room_name: r.name });
      }
      if (over.length) accounts.push({ account_id: id, display_name: acct.display_name, email: maskEmail(acct.email), plan_id: a.plan, over });
    }
    return { mode: S.mode, accounts, recent: S.recent };
  }, A);

  // test hook: {reset}, {email, fixture}, {gateway: off|fake|dodo|down}, {mode: off|count|block}, {pay_delay_ms} (-1: never on its own), {apply_pending}
  route("POST", /^\/__mock\/plans$/, ({ body }) => {
    if (body.reset) resetPlans();
    if (body.gateway) S.gateway = body.gateway;
    if (body.mode) S.mode = body.mode;
    if (typeof body.pay_delay_ms === "number") S.payDelayMs = body.pay_delay_ms;
    if (body.apply_pending) for (const c of S.checkouts.values()) if (c.paid && c.apply) c.apply();  // the gateway's event "arrives"
    let id = null;
    if (body.email) {
      const acct = accountByEmail(body.email.toLowerCase(), body.display_name);
      id = acct.id;
      const f = FIXTURES[body.fixture || "fresh"];
      if (!f) throw new E(400, "bad_request", "Unknown fixture.");
      S.accounts.set(id, { ...f(), created_at: iso(Date.now() - 10 * DAY) });
      if (body.fixture === "asha") S.recent.unshift({ at: iso(Date.now() - 1800e3), account_id: id, display_name: acct.display_name, limit: "rooms", room_id: null, used: 4, value: 3, refused: false });
    }
    return { ok: true, account_id: id };
  }, { open: true, nocsrf: true });
}
