// Shared words and formats for the plan pages (usage, billing, admin plans). API: CONTRACT-PLANS.md.
import { errorText } from "./api.js";

export const LIMIT_KEYS = ["rooms", "agents_per_room", "people_per_room", "history_days", "storage_mb"];
/** Names a person reads (a member is a chat in a room). storage_mb: MB of messages your chats' sent copies take on the
 * server at once (CONTRACT-PLANS.md); the server's safety ceiling refuses a send in every mode. */
export const LIMIT_NAME = { rooms: "Rooms", agents_per_room: "Members per room", people_per_room: "People per room", history_days: "Days of history", storage_mb: "Stored messages" };
export const LIMIT_WORD = { rooms: "rooms", agents_per_room: "members per room", people_per_room: "people per room", history_days: "days of history", storage_mb: "MB of stored messages" };

/** "3 Dec" (UTC, like the server's dates); with year: "3 Dec 2026". */
export function day(iso, year = false) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
}
export const daysLeft = (iso, now = Date.now()) => (Date.parse(iso) - now) / 86400e3;

/** $15, $12.50 (integer cents in, plain text out). */
export function usd(cents) {
  const c = Number(cents) || 0;
  return `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
}
export const num = (x) => Number(x || 0).toLocaleString("en-US");

/** Where a limit's number comes from, in a few words. */
export function sourceText(lim, planName) {
  switch (lim?.source) {
    case "raise": return "raised for you";
    case "boost": return lim.boost?.ends_at ? `boost until ${day(lim.boost.ends_at)}` : "boost";
    case "ceiling": return "the most any account can have";
    default: return `${planName} plan`;
  }
}

/** What being over means, by the mode the server reports. Never hard-coded to one mode. */
export function overMeaning(mode, canUpgrade) {
  if (mode === "block") return `Your rooms stay readable. You can't add more until you're under the limit${canUpgrade ? " or upgrade" : ""}.`;
  if (mode === "count") return "Plan limits block nothing during the beta. Rooms stay readable.";
  return "";
}

const PLAN_CODES = new Set(["billing_off", "not_for_sale", "already_on_plan", "payment_unavailable", "no_billing_account", "only_up", "bad_request", "plan_limit"]);
/** The server's plain message for the plan and billing codes (CONTRACT-PLANS.md), else the usual wording. */
export const planErrorText = (e) => (PLAN_CODES.has(e?.code) && e.message ? e.message : errorText(e));

/** Only send the browser to an http(s) address the server gave (never javascript: or data:). */
export function safeUrl(u) {
  try {
    const url = new URL(u, location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}

// What the person was buying, kept for the return page in this tab only (never anything secret).
const CHECKOUT_KEY = "botlink-checkout";
export function rememberCheckout(c) { try { sessionStorage.setItem(CHECKOUT_KEY, JSON.stringify(c)); } catch { /* private mode */ } }
export function recallCheckout(id) {
  try { const c = JSON.parse(sessionStorage.getItem(CHECKOUT_KEY) || "null"); return c && c.id === id ? c : null; } catch { return null; }
}
export function forgetCheckout() { try { sessionStorage.removeItem(CHECKOUT_KEY); } catch { /* private mode */ } }
