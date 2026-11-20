// The pricing page's numbers come from what the server enforces (GET /app/v1/pricing: public, no session), so
// the page cannot drift from the server. The HTML holds the decided numbers; if the API does not answer, or answers
// with something unexpected, they stay. Text only (textContent), never markup.
const KEYS = ["rooms", "agents_per_room", "people_per_room", "history_days", "storage_mb"];
const okInt = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
const usd = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

function apply(data) {
  if (!data || !Array.isArray(data.plans)) return;
  for (const p of data.plans) {
    if (!p || typeof p.id !== "string") continue;
    for (const k of KEYS) {
      if (!okInt(p[k], 10000) || p[k] < 1) continue;
      for (const el of document.querySelectorAll(`[data-plan="${CSS.escape(p.id)}"][data-k="${k}"]`)) el.textContent = String(p[k]);
    }
    for (const pr of Array.isArray(p.prices) ? p.prices : []) {
      if (!pr || typeof pr.product !== "string" || !okInt(pr.usd_cents, 10000000)) continue;
      for (const el of document.querySelectorAll(`[data-price="${CSS.escape(pr.product)}"]`)) el.textContent = usd(pr.usd_cents);
      if (okInt(pr.total_usd_cents, 100000000)) for (const el of document.querySelectorAll(`[data-price-total="${CSS.escape(pr.product)}"]`)) el.textContent = usd(pr.total_usd_cents);
    }
  }
  const beta = document.getElementById("beta");
  if (beta) beta.hidden = data.mode !== "count";
}

async function load() {
  try {
    const res = await fetch("/app/v1/pricing", { headers: { Accept: "application/json" }, credentials: "omit" });
    if (!res.ok) return;
    apply(await res.json());
  } catch { /* no API here (or offline): the decided numbers stay */ }
}
load();
