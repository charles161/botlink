// An event address a person approves (docs/protocol/event-url-approval.md §2-4): the rules that need no page
// (tests: web/test/eventurl.test.mjs). Which host the card shows large (the server's, as it came; never decoded), the request checked against itself, the
// comparison before the passkey step and before sending, and our sentences, each in one place. No imports: the test
// runs this file in node. The card is needs-eventurl.js.

/** The human-check action of an approval (target: the request id; a passkey every time). The fixture server uses it too. */
export const APPROVE_ACTION = "approve_event_url";

/**
 * What the card says for each event a person may approve: the heading and what bot-link sends. Only message.received
 * (the server answers 400 for approval "person" on any other event, docs/protocol/event-url-approval.md §7); a request
 * for another event can't be approved here (requestProblems). "sent" is the one place the list of what an event
 * carries is written (the event body, SPEC §6.13 "Wire", server/internal/events/worker.go); correct it here.
 */
export const EVENTS = {
  "message.received": {
    heading: (chat) => `${chat} asks bot-link to call an address when a message waits for it.`,
    sent: (chat) => `bot-link will call this address each time a message waits for ${chat}. It sends which room and which chat, who wrote, whether the message was to this chat alone or to the room, whether it needs an answer, and how many wait, with their ids and the time. It never sends the message text.`,
  },
};
export const URGENT_ONLY = "Only for messages marked urgent.";
export const WARNING = "bot-link could not check that this address is yours. Approve only if you made this address yourself, for example the trigger of a routine in your chat app.";
export const CHANGED = "This request changed after you opened it. Nothing was approved.";
export const BLOCKED = "bot-link may not call this address (it does not point to a public https address). Nothing was approved.";
export const UNREACHABLE = "bot-link could not reach this address, so nothing was approved.";
export const tooMany = (chat) => `${chat} already has six addresses. Stop one first.`;
export const HC_FAILED = "The passkey step did not count, so nothing was approved.";
export const approvedText = (chat) => `Approved. bot-link calls this address when a message waits for ${chat}. If one waits now, it has just called it.`;
export const REJECTED = "Not approved. bot-link sends nothing to this address.";
export const REFUSED = "This request doesn't check out, so it can't be approved. Don't approve it, and ask your chat to ask again.";
export const COMPARE = "The host alone doesn't show it is yours. Compare the whole address with the one your app shows for your routine.";
/** How long an approval lasts: the chat renews it (30 days at a time by default, at most 90) for as long as the address answers. */
export const lasts = (chat) => `It stays for as long as ${chat} keeps renewing it, until you stop it here.`;
export const ENCODED = "This host is an encoded name (a part of it starts with xn--). What it would look like is not shown on purpose: it can look like another name. bot-link does not let you approve it.";
export const USERINFO = (host) => `The address has a name before an @ sign. That part is not where bot-link calls: it calls ${host}.`;
export const stopBody = (chat) => `bot-link stops calling this address. ${chat} will not be woken through it any more. ${chat} can ask you again.`;

/**
 * The host as written in the address: what comes after "scheme://", before the first "/", "?" or "#", without a name
 * before an @ and without the port, in lower case (an IPv6 literal keeps its brackets). null when the address has no
 * "scheme://" as written. Nothing here parses it: compared with the parser's hostname it shows when the parser rewrote
 * the host (number forms, a trailing dot, percent-encoding, backslashes, another script).
 */
export function writtenHost(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(String(url ?? ""));
  if (!m) return null;
  const auth = m[1].slice(m[1].lastIndexOf("@") + 1);
  const host = auth.startsWith("[") ? auth.slice(0, auth.indexOf("]") + 1) : auth.replace(/:\d*$/, "");
  return host.toLowerCase();
}

/**
 * What the card shows about an address. host: the server's host exactly as it came (what bot-link dials; shown large,
 * never decoded). problems (empty: it can be approved): "url" (no URL with a host), "scheme" (not https; http only where
 * the dashboard itself runs on http, as in development), "host" (the server's host is not, as a string, both the
 * browser's hostname for the address and the host as written in it: no second parse of the server's host), "encoded"
 * (an xn-- name: what it would look like is never shown, and it is never offered for approval). userinfo: the address
 * has a name before an @. port.
 */
export function hostView(url, { serverHost, allowHttp = false } = {}) {
  const host = typeof serverHost === "string" ? serverHost : "";
  let u = null;
  try { u = new URL(String(url ?? "")); } catch { u = null; }
  if (!u || !u.hostname || !/^https?:$/.test(u.protocol)) return { problems: ["url"], host, encoded: false, userinfo: false, port: "" };
  const problems = [];
  if (u.protocol !== "https:" && !allowHttp) problems.push("scheme");
  if (!host || host !== u.hostname || host !== writtenHost(url)) problems.push("host");
  const encoded = host.split(".").some((l) => l.startsWith("xn--"));
  if (encoded) problems.push("encoded");
  return { problems, host, encoded, userinfo: !!(u.username || u.password), port: u.port };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The fields the person sees and approves. A change in any of them between show and send stops the approval. */
export const REQUEST_FIELDS = ["id", "url", "host", "name", "urgent_only", "member.id", "member.name", "room.id", "room.name"];
const field = (o, f) => f.split(".").reduce((x, k) => (x == null ? x : x[k]), o) ?? null;
export const sameRequest = (a, b) => !!a && !!b && REQUEST_FIELDS.every((f) => field(a, f) === field(b, f));

/** The request checked against itself before Approve is offered. Returns what is wrong (empty when it checks out). */
export function requestProblems(r, id, opts = {}) {
  if (!r || typeof r !== "object") return ["request"];
  const out = [];
  if (r.id !== id || !UUID.test(r.id || "")) out.push("id");
  if (!UUID.test(r.member?.id || "") || typeof r.member?.name !== "string" || !r.member.name) out.push("member");
  if (!UUID.test(r.room?.id || "") || typeof r.room?.name !== "string" || !r.room.name) out.push("room");
  if (!Object.hasOwn(EVENTS, r.name)) out.push("name");
  out.push(...hostView(r.url, { ...opts, serverHost: r.host }).problems);
  return out;
}
