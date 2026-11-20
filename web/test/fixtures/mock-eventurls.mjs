// An event address a person approves (docs/protocol/event-url-approval.md §2-4), the app API for the fixture server:
// the needs-you items (event_urls), approve (human check approve_event_url bound to the request id; one transaction:
// waiting/unexpired/the caller's member, consume the check, the push guard again, the subscription, approved), reject,
// the member's approved addresses and Stop. The read of approved addresses is not in the contract yet: the shape here
// (GET /app/v1/members/{id}/event-urls) is the web lane's placeholder until the server lane names its endpoint.
// Test hooks: POST /__mock/eu-member (a member of a room, for an account), /__mock/eu-person (a person in a room),
// /__mock/eu-request (a request as POST /api/v1/me/events/subscriptions {approval: "person"} makes it),
// /__mock/eu-request-edit, GET /__mock/eu-request/<id>, POST /__mock/eu-sub (an approved subscription),
// GET /__mock/eu-subs/<member id>.
import { createHash } from "node:crypto";
import { APPROVE_ACTION } from "../../public/assets/js/eventurl.js";

const APPROVABLE = "message.received"; // approval "person" is for this event only (contract §7)
// After Stop or a turn-down, a plain subscribe of that member to that URL is refused for a day without sending anything
// (only a new approval brings it back). The code is the server lane's to name; this is the mock's one place for it.
export const STOPPED_CODE = "stopped_by_person"; // server/internal/agentapi/eventurl.go refusedByPerson: details {reason: "stopped" | "rejected", until}
const STOPPED_MS = 24 * 3600e3;
const SUBS_PER_MEMBER = 6;

/**
 * The server's rule for a host a person may approve (server/internal/events/subs.go PlainHost): printable ASCII with no
 * "%", no name before an @, a bracketed IPv6 literal without a zone, a dotted IPv4 literal, or labels of a-z 0-9 - that
 * are not xn-- and whose last label is neither all digits nor 0x-hex (a browser reads those as a number).
 */
function plainHost(raw) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw);
  if (!m || /[^\x21-\x7e]|%/.test(raw) || m[1].includes("@") || !m[1]) return false;
  const host = m[1].startsWith("[") ? m[1].slice(1, m[1].indexOf("]")) : m[1].replace(/:\d*$/, "");
  if (m[1].startsWith("[")) return /^[0-9a-f:.]+$/i.test(host) && host.includes(":");
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host)) return true;
  const labels = host.toLowerCase().split(".");
  if (labels.some((l) => !l || l.startsWith("xn--") || /[^a-z0-9-]/.test(l))) return false;
  const last = labels[labels.length - 1];
  return !/^\d+$/.test(last) && !/^0x[0-9a-f]*$/.test(last);
}

export function installEventUrls({ route, E, getDb, uuid, now, later, rawPk, accountByEmail, consumeHumanCheck, changed, origin }) {
  const NOT_FOUND = () => new E(404, "not_found", "Not found.");
  const st = () => { const db = getDb(); db.eventUrls ||= new Map(); db.eventSubs ||= new Map(); db.eventStopped ||= new Map(); return db; };
  const stopped = () => st().eventStopped; // "member|url" → when it was stopped or turned down
  const memberOf = (id) => { for (const r of st().rooms.values()) { const m = !r.deleted && r.members.get(id); if (m) return { r, m }; } return null; };
  const live = (q) => q && q.status === "waiting" && Date.parse(q.expires_at) > Date.now();
  // the request waits, has not run out, and its member belongs to the caller; anything else is the one not-found
  const held = (sess, id) => { const q = st().eventUrls.get(id); const x = q && memberOf(q.member_id); if (!live(q) || !x || x.m.account_id !== sess.account_id) throw NOT_FOUND(); return q; };
  const ownMember = (sess, id) => { const x = memberOf(id); if (!x || x.m.account_id !== sess.account_id) throw NOT_FOUND(); return x; };
  const subId = (q) => `sub_${createHash("sha256").update(`${q.member_id}|${q.url}|${q.name}|${!!q.urgent_only}`).digest("hex").slice(0, 24)}`;
  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ""; } };

  const item = (q) => {
    const { r, m } = memberOf(q.member_id);
    return { id: q.id, member: { id: m.id, name: q.member_name ?? m.name }, room: { id: q.room_id ?? r.id, name: q.room_name ?? r.name }, url: q.url, host: q.host,
      name: q.name, urgent_only: q.urgent_only, created_at: q.created_at, expires_at: q.expires_at };
  };
  /** GET /app/v1/needs-you event_urls for one account. */
  const needs = (acct) => [...st().eventUrls.values()].filter((q) => live(q) && memberOf(q.member_id)?.m.account_id === acct).map(item);

  route("POST", /^\/app\/v1\/event-urls\/([0-9a-f-]{36})\/approve$/, ({ sess, m, body }) => {
    const q0 = st().eventUrls.get(m[1]);
    if (q0) q0.approve_calls += 1;
    if (Object.keys(body || {}).join() !== "human_check") throw new E(400, "bad_request", "The approve body is exactly {human_check}.");
    if (q0?.hc_fail) throw new E(403, "human_check_failed", "Human check failed.");
    const use = consumeHumanCheck(sess, body.human_check, APPROVE_ACTION, m[1]);     // 1 verify (used below)
    // a refused approval (404 or 422) spends its human check
    const spend = (err) => { use(); if (q0) q0.spent_checks += 1; return err; };
    let q;
    try { q = held(sess, m[1]); } catch (e) { throw spend(e); }                       // 2
    if (q.blocked) throw spend(new E(422, "event_url_blocked", "That address isn't allowed (https only, public addresses only). Nothing was approved.")); // 3
    if (q.unresolvable) throw spend(new E(422, "event_verify_failed", "bot-link could not look up that address. Nothing was approved.", { reason: "connection" }));
    const mine = [...st().eventSubs.values()].filter((s) => s.member_id === q.member_id);
    const id = subId(q);
    // 409 rolls everything back: the check stays usable for this request until it expires
    if (!mine.some((s) => s.id === id) && mine.length >= SUBS_PER_MEMBER) throw new E(409, "too_many_subscriptions", "This chat already has 6 addresses bot-link calls. It has to remove one first.");
    use();                                                                             // 5
    const sub = { id, member_id: q.member_id, url: q.url, host: q.host, name: q.name, urgent_only: q.urgent_only, approved_by: "person", approved_at: now(), failing: false };
    st().eventSubs.set(id, sub);                                                       // 6
    stopped().delete(`${q.member_id}|${q.url}`);                                       // a new approval brings it back
    q.status = "approved";                                                             // 7
    changed();
    return { subscription: { id, name: sub.name, url: sub.url, urgent_only: sub.urgent_only, approved_by: "person", approved_at: sub.approved_at }, request: { id: q.id, status: "approved" } };
  });
  route("POST", /^\/app\/v1\/event-urls\/([0-9a-f-]{36})\/reject$/, ({ sess, m, res }) => {
    const q = held(sess, m[1]);
    q.status = "rejected"; q.reject_calls = (q.reject_calls || 0) + 1; stopped().set(`${q.member_id}|${q.url}`, { at: Date.now(), reason: "rejected" }); changed();
    res.writeHead(204, { "Cache-Control": "no-store" }); res.end();
    return undefined;
  }, { raw: true });

  route("GET", /^\/app\/v1\/members\/([0-9a-f-]{36})\/event-urls$/, ({ sess, m }) => {
    ownMember(sess, m[1]);
    return { event_urls: [...st().eventSubs.values()].filter((s) => s.member_id === m[1] && s.approved_by === "person")
      .map((s) => ({ subscription_id: s.id, url: s.url, host: s.host, name: s.name, urgent_only: s.urgent_only, approved_at: s.approved_at, failing: s.failing })) };
  });
  route("POST", /^\/app\/v1\/members\/([0-9a-f-]{36})\/event-urls\/(sub_[0-9a-f]{24})\/stop$/, ({ sess, m, res }) => {
    ownMember(sess, m[1]);
    const s = st().eventSubs.get(m[2]);
    if (s && s.member_id === m[1] && s.approved_by !== "person") throw NOT_FOUND(); // one the address proved itself: not the person's to stop
    if (s && s.member_id === m[1]) { st().eventSubs.delete(s.id); stopped().set(`${s.member_id}|${s.url}`, { at: Date.now(), reason: "stopped" }); changed(); } // 204 also when it is already gone
    res.writeHead(204, { "Cache-Control": "no-store" }); res.end();
    return undefined;
  }, { raw: true });

  // ── test hooks ──
  route("POST", /^\/__mock\/eu-member$/, ({ body }) => {
    const r = st().rooms.get(body.room_id); if (!r) throw NOT_FOUND();
    const id = uuid();
    r.members.set(id, { id, name: body.name || "planner", app: body.app || "claude-code", job: body.job ?? "Plans the week.", folder: "~/acme", turn: "turn",
      account_id: accountByEmail(body.email).id, ed: rawPk(), x: rawPk(), joined_at: now() });
    changed(); return { member_id: id };
  }, { open: true, nocsrf: true });
  route("POST", /^\/__mock\/eu-person$/, ({ body }) => {
    const r = st().rooms.get(body.room_id); if (!r) throw NOT_FOUND();
    const a = accountByEmail(body.email);
    r.people.set(a.id, { account_id: a.id, devices: new Set() });
    changed(); return { ok: true };
  }, { open: true, nocsrf: true });
  // As the subscribe with approval "person" makes it: the push guard refuses anything but an https address with a host
  // (the mock can't resolve names). `unchecked: true` seeds what the server never makes, for render tests only.
  route("POST", /^\/__mock\/eu-request$/, ({ body }) => {
    if (!memberOf(body.member_id)) throw NOT_FOUND();
    const name = body.name || "message.received";
    if (!body.unchecked) {
      let u = null; try { u = new URL(body.url); } catch { /* below */ }
      // a host with any character outside printable ASCII is refused at the ask: an international name comes as xn--
      if (!u || u.protocol !== "https:" || !plainHost(body.url)) throw new E(422, "event_url_blocked", "Not a public https address.");
      if (name !== APPROVABLE) throw new E(400, "bad_request", "approval \"person\" is for message.received only.");
    }
    const q = { id: body.id || uuid(), member_id: body.member_id, url: body.url, host: body.host ?? hostOf(body.url), name, urgent_only: !!body.urgent_only,
      status: "waiting", created_at: now(), expires_at: later(body.expires_in_s ?? 86400), blocked: !!body.blocked, unresolvable: !!body.unresolvable, hc_fail: !!body.hc_fail, approve_calls: 0, reject_calls: 0, spent_checks: 0 };
    st().eventUrls.set(q.id, q); changed();
    return { request: { id: q.id, status: "waiting", url: q.url, name: q.name, expires_at: q.expires_at }, id: q.id, approve_url: `${origin}/approve-url/${q.id}` };
  }, { open: true, nocsrf: true });
  // a request that changes between show and approve (no "changed" event: the page is not told)
  route("POST", /^\/__mock\/eu-request-edit$/, ({ body }) => {
    const q = st().eventUrls.get(body.id); if (!q) throw NOT_FOUND();
    const { id, ...fields } = body; Object.assign(q, fields); return { ok: true };
  }, { open: true, nocsrf: true });
  route("GET", /^\/__mock\/eu-request\/([0-9a-f-]{36})$/, ({ m }) => { const q = st().eventUrls.get(m[1]); if (!q) throw NOT_FOUND(); return q; }, { open: true, nocsrf: true });
  route("POST", /^\/__mock\/eu-plain-subscribe$/, ({ body }) => {
    const x = stopped().get(`${body.member_id}|${body.url}`);
    if (x && Date.now() - x.at < STOPPED_MS) throw new E(409, STOPPED_CODE, "This chat's person stopped this address or turned it down in the last 24 hours, so bot-link sends it nothing, not even its check.",
      { reason: x.reason, until: new Date(x.at + STOPPED_MS).toISOString() });
    return { ok: true };
  }, { open: true, nocsrf: true });
  route("POST", /^\/__mock\/eu-sub$/, ({ body }) => {
    if (!memberOf(body.member_id)) throw NOT_FOUND();
    const q = { member_id: body.member_id, url: body.url, name: body.name || "message.received", urgent_only: !!body.urgent_only };
    const s = { id: subId(q), ...q, host: body.host ?? hostOf(body.url), approved_by: "person", approved_at: body.approved_at || now(), failing: !!body.failing };
    st().eventSubs.set(s.id, s); changed(); return { subscription_id: s.id };
  }, { open: true, nocsrf: true });
  route("GET", /^\/__mock\/eu-subs\/([0-9a-f-]{36})$/, ({ m }) => ({ subs: [...st().eventSubs.values()].filter((s) => s.member_id === m[1]).map((s) => ({ subscription_id: s.id, ...s })) }), { open: true, nocsrf: true });

  return { needs };
}
