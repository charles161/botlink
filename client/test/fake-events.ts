/**
 * bot-link Events in the fake server: subscriptions (SPEC §6.13) and addresses a person approves
 * (docs/protocol/event-url-approval.md), answered as server/internal/agentapi/events.go and eventurl.go answer them:
 * the same statuses, bodies and error codes. The fake reaches no URL (the network guard forbids it): `guard` and
 * `check` stand in for the push guard and the challenge, by host.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { PERSON_SAID_NO_CODE } from "../src/events.js";

export const APP_ORIGIN = "http://localhost:8811";
const H = 3600_000;
const DAY = 24 * H;
const CATALOGUE = [
  { name: "message.received", description: "A sealed message waits for this member." },
  { name: "roster.changed", description: "The room's member list changed." },
];

export interface FakeSub {
  id: string;
  member: string;
  url: string;
  name: string;
  urgent_only: boolean;
  secret: string;
  created: number;
  refreshed: number;
  expires: number;
  verified: boolean;
  last_ok: number | null;
  last_error: string | null;
  failed_since: number | null;
  disabled: number | null;
  fails: number;
  approved_by: "person" | null;
  approved_at: number | null;
}

export interface FakeRequest {
  id: string;
  member: string;
  account: string;
  url: string;
  name: string;
  urgent_only: boolean;
  secret: string;
  ttl_s: number;
  status: "waiting" | "approved" | "rejected";
  created: number;
  expires: number;
  decided: number | null;
}

/** What an error answer needs (the fake server's HttpErr). */
export type Err = (status: number, code: string, msg: string, details?: any, retryAfterS?: number) => Error;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class FakeEvents {
  subs = new Map<string, FakeSub>();
  requests = new Map<string, FakeRequest>();
  /** asks per member, with their times (6 per hour, a refused ask counts too) */
  asks = new Map<string, number[]>();
  /** test knob: the push guard. Default: https only, no loopback or private names; ".invalid" does not resolve */
  guard: (url: string) => "blocked" | "connection" | null = (url) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return "blocked";
    }
    if (u.protocol !== "https:") return "blocked";
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(u.hostname)) return "blocked";
    if (u.hostname.endsWith(".invalid")) return "connection";
    return null;
  };
  /** test knob: what the address answers to the challenge. Default: a host with "echo" in it echoes; the rest only say 200 */
  check: (url: string) => string | null = (url) => (/echo/.test(new URL(url).hostname) ? null : "challenge_failed");
  /** every POST body this fake took, in order (what the client sent) */
  sent: any[] = [];
  /** every URL the fake's stand-in challenge was run against (what the real server would have called) */
  challenged: string[] = [];
  /** member + url key → why and until when: the person stopped it or turned a request for it down (24 h) */
  saidNo = new Map<string, { reason: "stopped" | "rejected"; until: number }>();

  constructor(private err: Err) {}

  subId(member: string, url: string, name: string, urgent: boolean) {
    return "sub_" + createHash("sha256").update(`${member}\n${url}\n${name}\n${urgent}`).digest("hex").slice(0, 24);
  }

  view(s: FakeSub, now = Date.now()) {
    const state = s.expires <= now ? "expired" : s.disabled !== null ? "off" : "on";
    return {
      id: s.id, url: s.url, name: s.name, urgent_only: s.urgent_only, state, created_at: iso(s.created), refreshed_at: iso(s.refreshed), refresh_before: iso(s.expires),
      last_ok_at: iso(s.last_ok), last_error: s.last_error, failed_since: iso(s.failed_since), fails: s.fails, approved_by: s.approved_by, approved_at: iso(s.approved_at),
    };
  }

  reqView(q: FakeRequest, now = Date.now()) {
    const status = q.status === "waiting" && q.expires <= now ? "expired" : q.status;
    return {
      id: q.id, status, url: q.url, name: q.name, urgent_only: q.urgent_only, created_at: iso(q.created), expires_at: iso(q.expires), decided_at: iso(q.decided),
      approve_url: status === "waiting" ? `${APP_ORIGIN}/approve-url/${q.id}` : null,
    };
  }

  /** the agent routes; null when the path is not one of them */
  route(M: string, P: string, member: { id: string; account: string }, body: () => any): { status: number; body: any } | null {
    if (P === "/api/v1/me/events/subscriptions" && M === "POST") {
      const b = body();
      this.sent.push(b);
      return this.subscribe(member, b);
    }
    if (P === "/api/v1/me/events/subscriptions" && M === "GET") {
      const now = Date.now();
      const subs = [...this.subs.values()].filter((s) => s.member === member.id).map((s) => this.view(s, now));
      const reqs = [...this.requests.values()].filter((q) => q.member === member.id && (q.status === "waiting" || (q.decided !== null && q.decided > now - DAY))).map((q) => this.reqView(q, now));
      return { status: 200, body: { subscriptions: subs, requests: reqs, event_types: CATALOGUE } };
    }
    let mm: RegExpMatchArray | null;
    if (M === "DELETE" && (mm = P.match(/^\/api\/v1\/me\/events\/subscriptions\/([^/]+)$/))) {
      const id = decodeURIComponent(mm[1]);
      if (!/^sub_[0-9a-f]{24}$/.test(id)) throw this.err(404, "not_found", "Not found.");
      const s = this.subs.get(id);
      const removed = !!s && s.member === member.id;
      if (removed) this.subs.delete(id);
      return { status: 200, body: { ok: true, removed } };
    }
    if (M === "DELETE" && (mm = P.match(/^\/api\/v1\/me\/events\/requests\/([^/]+)$/))) {
      const id = decodeURIComponent(mm[1]);
      if (!UUID.test(id)) throw this.err(404, "not_found", "Not found.");
      const q = this.requests.get(id);
      const removed = !!q && q.member === member.id && q.status === "waiting";
      if (removed) this.requests.delete(id);
      return { status: 200, body: { ok: true, removed } };
    }
    return null;
  }

  private verifyFailed(reason: string) {
    if (reason === "blocked") return this.err(422, "event_url_blocked", "That URL isn't allowed (https only, public addresses only).");
    return this.err(422, "event_verify_failed", 'The URL didn\'t pass bot-link\'s check: it must answer the signed verification message with 2xx and {"challenge": the same value}.', { reason });
  }

  private subscribe(member: { id: string; account: string }, b: any) {
    const known = new Set(["name", "url", "secret", "urgent_only", "ttl_s", "approval"]);
    for (const k of Object.keys(b || {})) if (!known.has(k)) throw this.err(400, "bad_request", `unknown field ${k}`);
    if (b.approval !== undefined && b.approval !== "person") throw this.err(400, "bad_request", 'approval must be "person": the member\'s person approves the URL on the dashboard.');
    if (b.approval !== undefined && b.name !== "message.received") throw this.err(400, "bad_request", "approval: person is only for message.received.");
    if (!CATALOGUE.some((e) => e.name === b.name)) throw this.err(400, "bad_request", "name must be an event from the catalogue (GET /api/v1/me/events/subscriptions lists it).");
    if (typeof b.url !== "string" || !b.url || b.url.length > 500) throw this.err(400, "bad_request", "url is required (500 chars max).");
    if (!b.url.startsWith("https://") && !b.url.startsWith("http://")) throw this.verifyFailed("blocked");
    const urgent = b.urgent_only === true;
    if (urgent && b.name !== "message.received") throw this.err(400, "bad_request", "urgent_only is only for message.received.");
    let ttl = 30 * DAY;
    if (b.ttl_s !== undefined) {
      ttl = Number(b.ttl_s) * 1000;
      if (!(ttl >= 300_000 && ttl <= 90 * DAY)) throw this.err(400, "bad_request", "ttl_s must be between 300 (5 minutes) and 7776000 (90 days).");
    }
    const id = this.subId(member.id, b.url, b.name, urgent);
    const now = Date.now();
    let secret: string;
    let made = false;
    if (b.secret !== undefined) {
      if (typeof b.secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(b.secret)) throw this.err(400, "bad_request", "secret must be whsec_ followed by base64 of 24 to 64 random bytes.");
      secret = b.secret;
    } else if (this.subs.has(id)) secret = this.subs.get(id)!.secret;
    else {
      secret = "whsec_" + randomBytes(32).toString("base64");
      made = true;
    }
    const mine = [...this.subs.values()].filter((s) => s.member === member.id);
    const have = this.subs.has(id);
    const verified = mine.some((s) => s.url === b.url && s.verified && s.approved_by === null);
    const failing = mine.some((s) => s.url === b.url && (s.failed_since !== null || s.disabled !== null));
    const approved = have && this.subs.get(id)!.approved_by !== null && this.subs.get(id)!.expires > now;
    const live = mine.filter((s) => s.expires > now && s.id !== id).length;
    if (!have && live >= 6) throw this.err(409, "too_many_subscriptions", "This member already has 6 event subscriptions. Remove one first.");
    if (b.approval !== undefined && (failing || !(verified || approved))) return this.ask(member, { url: b.url, name: b.name, urgent, secret, made, ttl });
    const no = this.saidNo.get(`${member.id}\n${this.urlKey(b.url)}`);
    if (b.approval === undefined && no !== undefined && no.until > now) {
      throw this.err(409, PERSON_SAID_NO_CODE, `This chat's person ${no.reason === "rejected" ? "turned this address down" : "stopped this address"} in the last 24 hours, so bot-link sends it nothing, not even its check. To use it, ask the person again: botlink events subscribe --url <the address> --ask-person.`, { reason: no.reason, until: new Date(no.until).toISOString() });
    }
    const g = this.guard(b.url);
    if (g) throw this.verifyFailed(g);
    let challenged = false;
    if ((!verified && !approved) || failing) {
      challenged = true;
      this.challenged.push(b.url);
      const r = this.check(b.url);
      if (r) throw this.verifyFailed(r);
    }
    const prev = this.subs.get(id);
    const s: FakeSub = prev
      ? { ...prev, secret, expires: now + ttl, refreshed: now, verified: true }
      : { id, member: member.id, url: b.url, name: b.name, urgent_only: urgent, secret, created: now, refreshed: now, expires: now + ttl, verified: true, last_ok: null, last_error: null, failed_since: null, disabled: null, fails: 0, approved_by: null, approved_at: null };
    if (challenged) Object.assign(s, { disabled: null, fails: 0, failed_since: null, approved_by: null, approved_at: null });
    this.subs.set(id, s);
    return { status: have ? 200 : 201, body: { subscription: this.view(s), refreshed: have, ...(made ? { secret } : {}) } };
  }

  /** events.PlainHost (server/internal/events/subs.go), ported on its own: an IP address written out in full, or ASCII
   *  letters, digits and dashes in non-empty labels, no xn-- label, no trailing dot, a last label that is not a number,
   *  no user before an @ */
  plainHost(raw: string): boolean {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw);
    if (!m || !m[1] || m[1].includes("@")) return false;
    const auth = m[1];
    if (auth.startsWith("[")) {
      const h = auth.slice(1, auth.indexOf("]"));
      return !h.includes("%") && /^[0-9a-f:.]+$/i.test(h) && h.includes(":");
    }
    const h = auth.replace(/:\d*$/, "");
    if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(h)) return true;
    const labels = h.toLowerCase().split(".");
    if (labels.some((l) => l === "" || l.startsWith("xn--") || !/^[a-z0-9-]+$/.test(l))) return false;
    const last = labels[labels.length - 1];
    return !/^\d+$/.test(last) && !/^0x[0-9a-f]*$/.test(last);
  }

  /** events.URLKey: scheme and host in lower case and the path, without the query or fragment */
  urlKey(raw: string): string {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(raw);
    return m ? `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3]}` : raw;
  }

  private ask(member: { id: string; account: string }, q: { url: string; name: string; urgent: boolean; secret: string; made: boolean; ttl: number }) {
    // counted first: a refused ask (the host rule, the guard, the caps) is still an ask
    const now = Date.now();
    const times = (this.asks.get(member.id) || []).filter((t) => t > now - H);
    times.push(now);
    this.asks.set(member.id, times);
    if (times.length > 6) throw this.err(429, "rate_limited", "Too many requests.", undefined, Math.ceil((times[0] + H - now) / 1000));
    if (!this.plainHost(q.url)) {
      throw this.err(422, "event_url_blocked", "An address your person approves must have a plain host: letters, digits, dots and dashes (no xn-- part, no number a browser reads as an address, no dot at the end), or an IP address written out in full.");
    }
    const g = this.guard(q.url);
    if (g) throw this.verifyFailed(g);
    for (const r of [...this.requests.values()]) if (r.member === member.id && r.status === "waiting" && r.expires <= now) this.requests.delete(r.id);
    const same = [...this.requests.values()].find((r) => r.member === member.id && r.url === q.url && r.name === q.name && r.urgent_only === q.urgent && r.status === "waiting");
    if (same) return { status: 200, body: { request: this.reqView(same), approve_url: this.reqView(same).approve_url } };
    const waiting = [...this.requests.values()].filter((r) => r.status === "waiting" && r.expires > now);
    if (waiting.filter((r) => r.member === member.id).length >= 2) throw this.err(409, "too_many_requests_waiting", "This member already has 2 addresses waiting for its person. Withdraw one, or wait until the person decides.");
    if (waiting.filter((r) => r.account === member.account).length >= 10) throw this.err(409, "too_many_requests_waiting", "This person already has 10 addresses waiting from their chats. Wait until the person decides.");
    const r: FakeRequest = { id: randomUUID(), member: member.id, account: member.account, url: q.url, name: q.name, urgent_only: q.urgent, secret: q.secret, ttl_s: Math.round(q.ttl / 1000), status: "waiting", created: now, expires: now + DAY, decided: null };
    this.requests.set(r.id, r);
    const v = this.reqView(r);
    return { status: 202, body: { request: v, approve_url: v.approve_url, ...(q.made ? { secret: q.secret } : {}) } };
  }

  // ------------------------------------------------------------------ the person's side (dashboard), as calls
  /** The person approves with a passkey: the subscription as a verified subscribe makes it, marked approved_by person. */
  approve(reqId: string): FakeSub {
    const q = this.requests.get(reqId);
    if (!q || q.status !== "waiting" || q.expires <= Date.now()) throw new Error("not a waiting request");
    const now = Date.now();
    const id = this.subId(q.member, q.url, q.name, q.urgent_only);
    const s: FakeSub = { id, member: q.member, url: q.url, name: q.name, urgent_only: q.urgent_only, secret: q.secret, created: this.subs.get(id)?.created ?? now, refreshed: now, expires: now + q.ttl_s * 1000, verified: true, last_ok: null, last_error: null, failed_since: null, disabled: null, fails: 0, approved_by: "person", approved_at: now };
    this.subs.set(id, s);
    Object.assign(q, { status: "approved", decided: now });
    return s;
  }

  reject(reqId: string) {
    const q = this.requests.get(reqId);
    if (!q || q.status !== "waiting") throw new Error("not a waiting request");
    Object.assign(q, { status: "rejected", decided: Date.now() });
    this.saidNo.set(`${q.member}\n${this.urlKey(q.url)}`, { reason: "rejected", until: Date.now() + DAY });
  }

  /** the person stops an approved address (Stop on the member's page) */
  stop(subId: string) {
    const s = this.subs.get(subId);
    if (!s) return;
    this.subs.delete(subId);
    this.saidNo.set(`${s.member}\n${this.urlKey(s.url)}`, { reason: "stopped", until: Date.now() + DAY });
  }

  /** its 24 hours are over (the sweeper has not deleted it yet) */
  expire(reqId: string) {
    this.requests.get(reqId)!.expires = Date.now() - 1000;
  }

  /** failures turned it off */
  fail(subId: string) {
    Object.assign(this.subs.get(subId)!, { disabled: Date.now(), failed_since: Date.now() - 300_000, fails: 3, last_error: "http_5xx" });
  }
}
