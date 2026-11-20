// /app/v1 client: cookie session + X-CSRF-Token on every non-GET (Origin is added by the browser).

let csrf = null;
export const setCsrf = (t) => { csrf = t; };

export class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error || {};
    super(e.message || `Request failed (${status})`);
    this.status = status;
    this.code = e.code || (status === 0 ? "network" : "internal");
    this.details = e.details || {};
    this.retryAfter = e.retry_after_s;
  }
}

let onUnauthenticated = () => {};
export const setUnauthenticatedHandler = (fn) => { onUnauthenticated = fn; };

export async function api(method, path, body, { quiet401 = false } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrf) headers["X-CSRF-Token"] = csrf;
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { error: { code: "network", message: "Can't reach bot-link. Check your connection and try again." } });
  }
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && !quiet401) onUnauthenticated();
    throw err;
  }
  return data;
}
export const get = (p, o) => api("GET", p, undefined, o);
export const post = (p, b = {}, o) => api("POST", p, b, o);

/** Plain-language copy for error codes (we never show raw codes). */
export function errorText(err, ctx = {}) {
  const who = ctx.name ? ctx.name : "this chat";
  switch (err?.code) {
    case "network": return "Can't reach bot-link. Check your connection and try again.";
    case "already_decided": return "Someone already decided this one.";
    case "roster_conflict": return "The member list just changed. Try again.";
    case "name_taken": return `Another member is already called ${who}.`;
    case "room_full": return "This room is full (20 members).";
    case "human_check_failed":
      if (err.details?.reason === "fresh_login_required") return "Your first passkey needs a fresh sign-in. Sign in again, then set it up within 5 minutes.";
      if (err.details?.reason === "webauthn_other_passkey") return "Confirm with another of your passkeys, not the one you're removing.";
      return "The human check didn't go through. Try again.";
    case "last_passkey": return "That's your only passkey. Add another one before you remove it.";
    case "passkeys_unavailable": return "This server runs a stand-in human check, so there are no passkeys to manage.";
    case "not_signer": return "This browser can't approve for this room yet. Approve it from your other browser first.";
    case "forbidden": return "That's not yours to change.";
    case "invite_invalid": return "This invite can't be used. It may be off, expired or already used.";
    case "rate_limited": case "quota_exceeded": return err.retryAfter ? `Too many tries. Wait ${err.retryAfter} s and try again.` : "Too many tries. Wait a little and try again.";
    case "roster_invalid": return "The member list didn't check out, so nothing was signed.";
    case "already_in_room": return "You're already in this room.";
    case "csrf_failed": return "Your session went stale. Reload the page and try again.";
    case "unavailable": return "bot-link is busy for a moment. Try again shortly.";
    case "not_found": return "That doesn't exist anymore.";
    case "unauthenticated": return "Please sign in again.";
    default: return err?.message && err.status && err.status < 500 ? err.message : "Something went wrong on our side. Try again.";
  }
}
