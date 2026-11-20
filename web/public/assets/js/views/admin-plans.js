// Admin: plans and limits (inside the admin view, behind its unlock). Edit a plan's numbers with a note of who is
// affected, look up one account and raise a limit (only up: the input never offers a lower value, and the server's
// refusal is shown as it says it), add a boost with an end date, grant credits with a reason, the change log, and
// who is over a limit. Loaded once per unlock and after each change, not on the overview's 5 s refresh, so a form
// being filled in is never wiped. Emails stay shortened in lists, like the overview. API: CONTRACT-PLANS.md.
import { h, fill, toast, ago, absTime } from "../dom.js";
import { get, post } from "../api.js";
import { icon } from "../art.js";
import { LIMIT_KEYS, LIMIT_NAME, LIMIT_WORD, day, usd, num, sourceText, planErrorText } from "../plans-util.js";

const MODE_TEXT = {
  count: "Going over a limit is counted and shown. Nothing is refused.",
  block: "Going over a limit refuses adding more. Rooms over a limit stay readable.",
  off: "Limits are not counted right now.",
};
const TARGET = { plan: "Plan", account: "Raise", boost: "Boost", credits: "Credits", account_plan: "Plan change" };

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;
const when = (iso) => (iso ? h("time", { datetime: iso, title: absTime(iso) }, ago(iso)) : h("span", { class: "muted" }, "never"));
const words = (keys) => { const w = keys.map((k) => LIMIT_WORD[k]); return w.length < 2 ? w.join("") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`; };
const intOr = (s) => { const n = Number(s); return s !== "" && Number.isInteger(n) ? n : NaN; };
const shortId = (id) => (id ? String(id).slice(0, 8) : "");

function panel(title, ic, meta, cls, ...body) {
  return h("section", { class: ["panel", "adm-panel", cls] },
    h("div", { class: "panel-head" }, h("h2", null, icon(ic), title), meta ? h("span", { class: "panel-meta" }, meta) : null),
    h("div", { class: "panel-body" }, ...body));
}
function table(label, cols, rows, empty, cls) {
  if (!rows.length) return h("p", { class: "muted adm-empty" }, empty);
  return h("div", { class: "adm-table-wrap" },
    h("table", { class: ["adm-table", cls], "aria-label": label },
      h("thead", null, h("tr", null, cols.map((c) => h("th", { scope: "col", class: c.num ? "num" : null }, c.label)))),
      h("tbody", null, rows.map((r) => h("tr", { class: r._cls }, cols.map((c) => h("td", { "data-label": c.label, class: c.num ? "num" : null }, c.get(r))))))));
}
function field(label, input, hint) {
  const id = input.id || (input.id = nextId("f"));
  return h("div", { class: "field" }, h("label", { for: id }, label), input, hint || null);
}
const reasonInput = () => h("input", { class: "input", type: "text", name: "reason", maxlength: 300, required: true, autocomplete: "off", placeholder: "Why (shown in the change log)" });
const numInput = (name, min, max) => h("input", { class: "input input-num", type: "number", name, min, max, step: 1, inputmode: "numeric", required: true });
function limitSelect() {
  return h("select", { class: "input", name: "limit" }, LIMIT_KEYS.map((k) => h("option", { value: k }, LIMIT_NAME[k])));
}
function submitBtn(text) {
  return h("button", { type: "submit", class: "btn btn-primary btn-sm", disabled: true }, h("span", { class: "spinner", "aria-hidden": "true" }), text);
}
const status = () => h("p", { class: "form-status", role: "status", "aria-live": "polite" });
async function busy(btn, fn) {
  btn.disabled = true; btn.classList.add("busy");
  try { return await fn(); } finally { btn.classList.remove("busy"); }
}

export function plansSection({ onLocked }) {
  const modeLine = h("p", { class: "lead small" });
  const plansBox = h("div", { class: "plan-forms" });
  const findBox = h("div");
  const acctBox = h("div", { class: "acct-box" });
  const overBox = h("div");
  const logBox = h("div");
  const el = h("section", { id: "plans", class: "adm-plans", hidden: true, "aria-labelledby": "plans-title" },
    h("div", { class: "adm-plans-head" },
      h("h2", { class: "h2", id: "plans-title" }, "Plans and limits"),
      modeLine,
      h("p", { class: "fine" }, icon("shield", { size: 16 }), "Limits only go up for existing accounts. Every change is logged with who, when and why.")),
    panel("Plans", "door", "numbers apply live, no deploy", "plans-panel", plansBox),
    panel("One account", "users", null, "acct-panel", findBox, acctBox),
    h("div", { class: "adm-grid" },
      panel("Who is over a limit", "alert", null, "over-panel", overBox),
      panel("Change log", "clock", "newest first", "log-panel", logBox)));
  const jump = h("a", { href: "#plans", class: "chip", hidden: true, "data-native": "" }, icon("door", { size: 18 }), "Plans and limits");

  let loaded = false, plans = null, ceiling = {};
  let shownEmail = null; // {id, email}: the email the admin looked this account up by (shown in full only then)
  const override = {};   // a newer current value the server reported with only_up, per account and limit

  async function call(fn) {
    try { return await fn(); } catch (e) { if (e.code === "admin_locked") onLocked(); throw e; }
  }
  const errBox = (e) => h("div", { class: "error-box", role: "alert" }, h("p", null, planErrorText(e)));

  // ── plans ──────────────────────────────────────────────────────────────
  function planForm(plan) {
    const inputs = {};
    const reason = reasonInput();
    const note = h("p", { class: "plan-note", "aria-live": "polite" });
    const st = status();
    const save = submitBtn("Save");
    const changes = () => LIMIT_KEYS.map((k) => ({ k, from: plan[k], to: intOr(inputs[k].value) })).filter((c) => c.to !== c.from);
    function update() {
      const ch = changes();
      const bad = ch.some((c) => !(c.to >= 1 && c.to <= 10000));
      for (const k of LIMIT_KEYS) inputs[k].setAttribute("aria-invalid", String(ch.some((c) => c.k === k && !(c.to >= 1 && c.to <= 10000))));
      const up = ch.filter((c) => c.to > c.from).map((c) => c.k), down = ch.filter((c) => c.to < c.from).map((c) => c.k);
      const lines = [];
      if (bad) lines.push("Limits must be whole numbers from 1 to 10000.");
      else {
        const n = plan.accounts;
        if (up.length) lines.push(`Raises ${words(up)} for ${n === 1 ? "the one account" : `all ${num(n)} accounts`} on ${plan.name} now.`);
        if (down.length) lines.push(`Lowers ${words(down)} for new accounts only. Existing accounts keep what they have.`);
        const capped = ch.filter((c) => ceiling[c.k] != null && c.to > ceiling[c.k]).map((c) => c.k);
        if (capped.length) lines.push(`Above the most any account can have, so accounts get at most ${capped.map((k) => `${ceiling[k]} ${LIMIT_WORD[k]}`).join(", ")}.`);
      }
      note.textContent = lines.join(" ");
      note.classList.toggle("is-down", !!down.length && !bad);
      save.disabled = !ch.length || bad || !reason.value.trim();
    }
    const fields = LIMIT_KEYS.map((k) => {
      const inp = numInput(k, 1, 10000);
      inp.value = String(plan[k]);
      inp.addEventListener("input", update);
      inputs[k] = inp;
      return field(LIMIT_NAME[k], inp, ceiling[k] != null ? h("span", { class: "help" }, `Most any account can have: ${ceiling[k]}`) : null);
    });
    reason.addEventListener("input", update);
    const price = plan.for_sale ? `for sale · ${usd(plan.price_month_usd_cents)} a month, ${usd(plan.price_year_month_usd_cents)} a month yearly` : "not for sale";
    const form = h("form", { class: "plan-form", "data-plan": plan.id, novalidate: true },
      h("div", { class: "plan-form-head" }, h("h3", null, plan.name), h("span", { class: "muted" }, `${num(plan.accounts)} account${plan.accounts === 1 ? "" : "s"} · ${price}`)),
      h("div", { class: "plan-fields" }, fields),
      field("Reason", reason),
      note,
      h("div", { class: "row-actions" }, save),
      st);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ch = changes();
      if (save.disabled || !ch.length) return;
      st.textContent = "";
      try {
        const res = await busy(save, () => call(() => post("/app/v1/admin/plans/update", { plan_id: plan.id, limits: Object.fromEntries(ch.map((c) => [c.k, c.to])), reason: reason.value.trim() })));
        Object.assign(plan, res.plan);
        for (const k of LIMIT_KEYS) inputs[k].value = String(plan[k]);
        reason.value = "";
        st.classList.remove("is-error");
        st.textContent = `${res.note}${res.raised_accounts ? ` ${num(res.raised_accounts)} account${res.raised_accounts === 1 ? "" : "s"} raised.` : ""}`;
        update();
        loadLog(); loadOver();
      } catch (err) { st.classList.add("is-error"); st.textContent = planErrorText(err); update(); }
    });
    return form;
  }
  async function loadPlans() {
    try {
      const d = await call(() => get("/app/v1/admin/plans"));
      plans = d.plans; ceiling = d.ceiling || {};
      modeLine.textContent = `Limits mode: ${d.mode}. ${MODE_TEXT[d.mode] || ""}`;
      fill(plansBox, plans.map(planForm));
    } catch (e) { if (e.code !== "admin_locked") fill(plansBox, errBox(e)); }
  }

  // ── one account ────────────────────────────────────────────────────────
  const whoInput = h("input", { class: "input", type: "text", name: "who", autocomplete: "off", spellcheck: "false", placeholder: "Account id or exact email" });
  const findSt = status();
  const findBtn = h("button", { type: "submit", class: "btn btn-ghost btn-sm" }, h("span", { class: "spinner", "aria-hidden": "true" }), icon("users", { size: 18 }), "Find");
  const findForm = h("form", { class: "acct-find", novalidate: true }, field("Account id or exact email", whoInput), h("div", { class: "row-actions" }, findBtn), findSt);
  fill(findBox, findForm);
  findForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = whoInput.value.trim();
    findSt.textContent = "";
    if (!v) { findSt.textContent = "Give an account id or the exact email."; return; }
    await busy(findBtn, () => openAccount(v.includes("@") ? { email: v } : { account_id: v }));
    findBtn.disabled = false;
  });

  async function openAccount(q) {
    try {
      const v = await call(() => get(`/app/v1/admin/account?${new URLSearchParams(q)}`));
      shownEmail = q.email && v.account ? { id: v.account.id, email: v.account.email } : null;
      renderAccount(v);
    } catch (e) { if (e.code !== "admin_locked") { findSt.textContent = planErrorText(e); fill(acctBox); } }
  }
  const permanent = (v, k) => {
    const lim = v.limits?.[k] || {};
    const base = Math.max(lim.plan_value || 0, v.raises?.[k] ?? lim.raise ?? 0);
    return Math.max(base, override[`${v.account.id}:${k}`] || 0);
  };

  function onlyUpForm(v, kind) {
    const isBoost = kind === "boost";
    const sel = limitSelect();
    const val = numInput("value", 1, 10000);
    const reason = reasonInput();
    const hint = h("span", { class: "help" });
    const ends = isBoost ? h("input", { class: "input", type: "date", name: "ends", required: true }) : null;
    const st = status();
    const btn = submitBtn(isBoost ? "Add boost" : "Raise");
    const cur = () => permanent(v, sel.value);
    function validate() {
      const c = cur(), n = intOr(val.value);
      const ok = n > c && n <= 10000;
      val.setAttribute("aria-invalid", String(val.value !== "" && !ok));
      hint.textContent = val.value !== "" && !ok ? `Must be more than ${c}. A limit can only go up.` : `Now ${c}. It can only go up.`;
      const endOk = !isBoost || (ends.value && ends.value >= ends.min && ends.value <= ends.max);
      btn.disabled = !ok || !endOk || !reason.value.trim();
    }
    function sync() { const c = cur(); val.min = String(c + 1); val.value = String(c + 1); validate(); }
    // never keep a value at or below the current one: lift it to the lowest allowed when the field is left
    const lift = () => { const c = cur(), n = intOr(val.value); if (!(n > c)) val.value = String(c + 1); else if (n > 10000) val.value = "10000"; validate(); };
    sel.addEventListener("change", sync);
    val.addEventListener("input", validate);
    val.addEventListener("change", lift);
    val.addEventListener("blur", lift);
    reason.addEventListener("input", validate);
    if (isBoost) {
      const d0 = new Date();
      const iso = (n) => new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate() + n)).toISOString().slice(0, 10);
      ends.min = iso(1); ends.max = iso(366);
      ends.addEventListener("input", validate); ends.addEventListener("change", validate);
    }
    const form = h("form", { class: ["acct-form", isBoost ? "boost-form" : "raise-form"], novalidate: true },
      h("h4", null, isBoost ? "Add a boost" : "Raise a limit"),
      h("p", { class: "help" }, isBoost ? "A temporary raise. The person sees the end date and a heads-up 7 days before." : "Permanent for this account. It can't be lowered later."),
      field("Limit", sel), field(isBoost ? "Boost to" : "New value", val, hint),
      isBoost ? field("Ends on", ends) : null,
      field("Reason", reason),
      h("div", { class: "row-actions" }, btn), st);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      lift();
      if (btn.disabled) return;
      st.textContent = "";
      const body = { account_id: v.account.id, limit: sel.value, value: intOr(val.value), reason: reason.value.trim() };
      if (isBoost) body.ends_at = `${ends.value}T00:00:00Z`;
      try {
        const res = await busy(btn, () => call(() => post(isBoost ? "/app/v1/admin/account/boost" : "/app/v1/admin/account/raise", body)));
        toast(isBoost ? `Boost added until ${day(body.ends_at, true)}.` : `Raised to ${body.value}.`);
        renderAccount(res);
        loadLog(); loadOver();
      } catch (err) {
        if (err.code === "only_up" && Number.isInteger(err.details?.current)) override[`${v.account.id}:${sel.value}`] = err.details.current;
        st.classList.add("is-error");
        st.textContent = planErrorText(err);
        val.min = String(cur() + 1);
        validate();
      }
    });
    sync();
    return form;
  }

  function grantForm(v) {
    const amount = numInput("amount", 1, 1000000);
    const reason = reasonInput();
    reason.placeholder = "Why (the person sees this)";
    const st = status();
    const btn = submitBtn("Grant credits");
    const validate = () => { const n = intOr(amount.value); btn.disabled = !(n >= 1 && n <= 1000000) || !reason.value.trim(); amount.setAttribute("aria-invalid", String(amount.value !== "" && !(n >= 1 && n <= 1000000))); };
    amount.addEventListener("input", validate); reason.addEventListener("input", validate);
    const form = h("form", { class: "acct-form grant-form", novalidate: true },
      h("h4", null, "Grant credits"),
      h("p", { class: "help" }, "Free credits. The person sees the reason in their credit list."),
      field("Credits", amount), field("Reason", reason),
      h("div", { class: "row-actions" }, btn), st);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      st.textContent = "";
      try {
        const res = await busy(btn, () => call(() => post("/app/v1/admin/credits/grant", { account_id: v.account.id, amount: intOr(amount.value), reason: reason.value.trim() })));
        toast(`Granted. Balance ${num(res.balance)} credits.`);
        const fresh = await call(() => get(`/app/v1/admin/account?${new URLSearchParams({ account_id: v.account.id })}`));
        renderAccount(fresh);
        loadLog();
      } catch (err) { st.classList.add("is-error"); st.textContent = planErrorText(err); validate(); }
    });
    return form;
  }

  function renderAccount(v) {
    const a = v.account || {};
    const email = shownEmail?.id === a.id ? shownEmail.email : a.email;
    const b = v.billing || {};
    const billing = b.status && b.status !== "none" ? `${b.status.replace(/_/g, " ")}${b.interval ? `, ${b.interval}ly` : ""}${b.paid_until ? `, paid until ${day(b.paid_until, true)}` : ""}` : "never paid";
    const limits = table("Limits for this account", [
      { label: "Limit", get: (r) => LIMIT_NAME[r.k] },
      { label: "Now", num: true, get: (r) => num(r.value) },
      { label: "From", get: (r) => sourceText(r, v.plan?.name || "") },
      { label: "Used", num: true, get: (r) => (typeof r.used === "number" ? h("span", null, num(r.used), r.over ? h("span", { class: "badge lim-badge adm-badge" }, "over") : null) : "–") },
    ], LIMIT_KEYS.filter((k) => v.limits?.[k]).map((k) => ({ k, ...v.limits[k], _cls: v.limits[k].over ? "is-warn" : null })), "No limits.", "acct-limits");
    const boosts = (v.boosts || []).length
      ? h("ul", { class: "acct-boosts" }, v.boosts.map((x) => h("li", { class: x.active ? "is-active" : "is-ended" },
        h("strong", null, `${LIMIT_NAME[x.limit] || x.limit}: ${num(x.value)}`), ` until ${day(x.ends_at, true)}`,
        h("span", { class: "muted" }, ` · ${x.active ? "active" : "not active"}${x.by ? ` · by ${x.by}` : ""}`),
        x.reason ? h("span", { class: "acct-why" }, x.reason) : null)))
      : h("p", { class: "muted acct-boosts" }, "No boosts.");
    fill(acctBox, h("div", { class: "acct", "data-account": a.id },
      h("div", { class: "acct-head" }, h("h3", null, a.display_name || "Account"), h("span", { class: "adm-mail muted" }, email || "")),
      h("dl", { class: "adm-kv" },
        [["Plan", v.plan?.name || ""], ["Joined", a.created_at ? day(a.created_at, true) : ""], ["Billing", billing],
          ["Credits", h("strong", { class: "acct-balance" }, num(v.credits?.balance))], ["Account id", h("code", { class: "adm-code" }, a.id)]]
          .map(([k, val]) => h("div", null, h("dt", null, k), h("dd", null, val)))),
      limits,
      h("h4", { class: "adm-h3" }, "Boosts"), boosts,
      h("div", { class: "acct-forms" }, onlyUpForm(v, "raise"), onlyUpForm(v, "boost"), grantForm(v))));
  }

  // ── who is over, change log ────────────────────────────────────────────
  async function loadOver() {
    try {
      const d = await call(() => get("/app/v1/admin/over-limit"));
      const overText = (o) => `${LIMIT_NAME[o.limit] || o.limit} ${num(o.used)} of ${num(o.value)}${o.room_name ? ` in #${o.room_name}` : ""}`;
      const openBtn = (id) => { const b = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Open"); b.addEventListener("click", () => { whoInput.value = id; openAccount({ account_id: id }).then(() => acctBox.scrollIntoView({ block: "start" })); }); return b; };
      fill(overBox,
        h("p", { class: "help" }, MODE_TEXT[d.mode] || ""),
        table("Accounts over a limit", [
          { label: "Person", get: (r) => h("span", null, h("b", null, r.display_name), " ", h("span", { class: "adm-mail muted" }, r.email || "")) },
          { label: "Plan", get: (r) => r.plan_id },
          { label: "Over", get: (r) => r.over.map(overText).join("; ") },
          { label: "", get: (r) => openBtn(r.account_id) },
        ], d.accounts || [], "Nobody is over a limit.", "over-list"),
        h("h3", { class: "adm-h3" }, "Recently went over"),
        table("Recently went over", [
          { label: "When", get: (r) => when(r.at) },
          { label: "Person", get: (r) => r.display_name },
          { label: "Limit", get: (r) => `${LIMIT_NAME[r.limit] || r.limit} ${num(r.used)} of ${num(r.value)}` },
          { label: "Result", get: (r) => (r.refused ? "refused" : "counted") },
        ], d.recent || [], "Nothing recent."));
    } catch (e) { if (e.code !== "admin_locked") fill(overBox, errBox(e)); }
  }
  async function loadLog() {
    try {
      const d = await call(() => get("/app/v1/admin/limit-changes?limit=100"));
      const who = (r) => (r.actor_kind === "admin" ? r.actor?.display_name || "an admin" : r.actor_kind === "payment" ? "Payment" : "System");
      const what = (r) => {
        const subject = r.target === "plan" ? `${(plans || []).find((p) => p.id === r.plan_id)?.name || r.plan_id} plan` : `account ${shortId(r.account_id)}`;
        const lim = LIMIT_WORD[r.limit] || r.limit;
        return `${TARGET[r.target] || r.target}: ${subject}${r.target === "credits" || r.target === "account_plan" ? "" : `, ${lim}`}`;
      };
      fill(logBox, table("Change log", [
        { label: "When", get: (r) => when(r.at) },
        { label: "Who", get: who },
        { label: "What", get: what },
        { label: "Change", get: (r) => `${r.from ?? ""} → ${r.to ?? ""}` },
        { label: "Why", get: (r) => r.reason || "" },
      ], d.changes || [], "No changes yet.", "change-log"));
    } catch (e) { if (e.code !== "admin_locked") fill(logBox, errBox(e)); }
  }

  return {
    el, jump,
    show() {
      el.hidden = false; jump.hidden = false;
      if (loaded) return;
      loaded = true;
      loadPlans().then(() => loadLog());
      loadOver();
    },
    hide() {
      el.hidden = true; jump.hidden = true; loaded = false;
      fill(acctBox); findSt.textContent = ""; shownEmail = null;
    },
  };
}
