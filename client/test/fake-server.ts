/**
 * A contract-faithful fake of the bot-link v1 agent API (api/openapi.yaml, SPEC §6, ENVELOPE §3-§5), in memory, for
 * client unit tests. It verifies request signatures (±60 s, single-use nonces), envelope signatures/fingerprints and
 * roster entries exactly as the server must, and exposes "dashboard" helpers (create room, approve with a device key)
 * as plain function calls. Bind only to 127.0.0.1 on ports 8820-8829.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import * as c from "../src/crypto.js";
import { verifyRequest } from "../src/reqsign.js";
import { makeEntry, verifyRoster, entryHash, type SignedEntry, type RosterState } from "../src/roster.js";
import { FakeEvents } from "./fake-events.js";
import { cmpVersion } from "../src/stale.js";
import { npxRun } from "../src/version.js";

type Turn = "always_on" | "wake" | "listening" | "on_turn";

interface Account {
  id: string;
  name: string;
  device: { seed: string; pk: string };
}
interface Room {
  id: string;
  name: string;
  purpose: string;
  owner: string;
  entries: SignedEntry[];
  invites: Map<string, { code: string; account: string; off: boolean; expires: number; uses: number }>;
}
interface Member {
  id: string;
  room: string;
  account: string;
  name: string;
  app: string;
  /** the name an app bot-link can't detect gave itself (unsigned display, as the real server's roster view) */
  app_name?: string | null;
  job: string;
  folder: string;
  machine: string;
  turn: Turn;
  ed: string;
  x: string;
  key_epoch: number;
  holder_session: string | null;
  holder_epoch: number;
  removed: boolean;
  handover: any;
  last_wait_at: number;
  last_poll_at: number;
  last_seen_at?: number;
  wake_verified_at?: number;
  self_label?: string | null;
}
interface JoinReq {
  id: string;
  kind: "join" | "claim";
  room: string;
  account: string;
  body: any;
  bodyHash: string;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  match_code: string;
  member_id: string;
  expires: number;
  readdressed_from?: string;
  /** whose chat invite it was made with (the invite row, as the real server's invite_id) */
  invite_of?: string;
}
interface Delivery {
  seq: number;
  message_id: string;
  member: string;
  from: string;
  scope: "member" | "room" | "self";
  in_reply_to: string | null;
  envelope: any;
  quiet?: boolean;
  state: "queued" | "shown" | "done" | "stuck" | "needs_resend" | "expired";
  lease_until: number;
  attempts: number;
  wakes: number;
  key_epoch: number;
  created: number;
  expires: number;
}
interface Notice {
  id: number;
  member: string;
  kind: string;
  data: any;
  created: number;
  acked: boolean;
}

// the server's own clock: a test that puts the client's clock off (Date.now in this process) must not move it too
const serverClock = Date.now.bind(Date);
const now = () => serverClock();
const nowS = () => Math.floor(serverClock() / 1000);
const iso = (ms: number) => new Date(ms).toISOString();

class HttpErr extends Error {
  /** seconds for the Retry-After header of a 429 / 503 (default 1) */
  retryAfterS?: number;
  constructor(public status: number, public code: string, msg = code, public details: any = undefined, public extra: Record<string, unknown> = {}) {
    super(msg);
  }
}

/** A room draft (docs/protocol/room-drafts.md §1): one row, not a room, until a person confirms it. */
interface Draft {
  id: string;
  body: any;
  bodyHash: string;
  status: "open" | "confirmed" | "rejected" | "closed";
  match_code: string;
  member_id: string;
  expires: number;
  room?: string;
  confirmer?: string;
}

export class FakeServer {
  accounts = new Map<string, Account>();
  rooms = new Map<string, Room>();
  members = new Map<string, Member>();
  joins = new Map<string, JoinReq>();
  drafts = new Map<string, Draft>();
  /** bot-link Events: subscriptions and addresses a person approves (fake-events.ts) */
  events = new FakeEvents((status, code, msg, details, retryAfterS) => Object.assign(new HttpErr(status, code, msg, details), retryAfterS ? { retryAfterS } : {}));
  presenceLog: { member: string; at: number }[] = [];
  messages = new Map<string, { from: string; hash: string; room: string }>();
  deliveries: Delivery[] = [];
  notices: Notice[] = [];
  attention: { member: string; reason: string }[] = [];
  turnLog: { member: string; turn: string }[] = [];
  ackLog: { member: string; message_id: string; woken: boolean }[] = [];
  nonces = new Set<string>();
  seq = 0;
  nseq = 0;
  bells = new Set<() => void>();
  clientGone: () => boolean = () => false;
  /** calls per "METHOD path" (busy-loop tests) */
  hits = new Map<string, number>();
  /** live bug B (2026-11-06): the server answers every lease at once (no long-poll), with nothing new to show */
  leaseAtOnce = false;
  log: { method: string; path: string; status: number; session: string | null }[] = [];
  /** the Cloudflare Access service-token headers each request carried (cfaccess.test.ts) */
  access: { path: string; id?: string; secret?: string }[] = [];
  /** test knobs */
  clockSkewS = 0;
  failNext: { path: RegExp; status: number; code: string; times: number; message?: string; details?: Record<string, unknown> } | null = null;
  /** an unwell proxy: an HTML 502/503, a response that never comes (stall), or a 200 that is not JSON (garbage) */
  fault: { path: RegExp; kind: "502" | "503" | "403" | "410" | "stall" | "garbage"; times: number } | null = null;
  /**: ack requests hang (never applied, never answered) while true: a hook process the app ends mid-ack */
  holdAcks = false;
  /** the client the server hands out (incident 21 Nov 2026): named on every answer; a join, room draft or move from a
   *  copy that asks (X-Botlink-Client-Stale: refuse) and is older is refused 409 client_outdated, as the real server's
   *  clientgate/joingate.go */
  client: { version: string; url: string; release?: number } | null = null;
  /** the X-Botlink-Client-* headers each request carried */
  clientHeaders: { path: string; version?: string; stale?: string; release?: string }[] = [];
  /** runs once right before the next send is processed (e.g. a member joins in between) */
  beforeSend: (() => void) | null = null;
  server!: Server;
  port = 0;

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    // a busy port rejects (the caller tries the next one) instead of leaving the test hanging
    await new Promise<void>((r, bad) => {
      this.server.once("error", bad);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", bad);
        r();
      });
    });
    this.port = (this.server.address() as any).port;
    if (this.port < 8820 || this.port > 8829) {
      // tests ask for 0 only to probe; the rule is 8820-8829
    }
    return this;
  }

  async stop() {
    for (const b of this.bells) b();
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  ring() {
    for (const b of [...this.bells]) b();
  }

  // ------------------------------------------------------------------ dashboard side (humans), as function calls
  async account(name: string): Promise<Account> {
    await c.ready();
    const seed = c.sha256hex(`fake-device|${name}|${Math.random()}`);
    const a: Account = { id: c.uuidv7(), name, device: { seed, pk: c.edPkFromSeed(seed) } };
    this.accounts.set(a.id, a);
    return a;
  }

  async room(owner: Account, name: string, purpose = ""): Promise<Room> {
    const id = c.uuidv7();
    const g = makeEntry({ room: id, op: "genesis", name, owner: owner.id, device: owner.device.pk }, 0, null, owner.device.pk, owner.device.seed);
    const r: Room = { id, name, purpose, owner: owner.id, entries: [g], invites: new Map() };
    this.rooms.set(id, r);
    return r;
  }

  append(room: Room, signer: Account | { seed: string; pk: string }, fields: Record<string, unknown>): SignedEntry {
    const dev = "device" in signer ? signer.device : signer;
    const head = room.entries[room.entries.length - 1];
    const e = makeEntry({ room: room.id, ...fields }, room.entries.length, entryHash(head), dev.pk, dev.seed);
    verifyRoster(room.id, [...room.entries, e]); // the server validates every append with the same rules
    room.entries.push(e);
    for (const m of this.members.values()) if (m.room === room.id && !m.removed) this.notice(m.id, "roster_changed", { head_seq: e.seq });
    return e;
  }

  addPerson(room: Room, owner: Account, friend: Account) {
    this.append(room, owner, { op: "person_add", account: friend.id, name: friend.name, device: friend.device.pk });
  }

  invite(room: Room, who: Account): string {
    for (const i of room.invites.values()) if (i.account === who.id) return `${room.name}-${i.code}`;
    const code = Array.from({ length: 10 }, () => c.BASE32[Math.floor(Math.random() * 32)]).join("");
    room.invites.set(code, { code, account: who.id, off: false, expires: now() + 24 * 3600_000, uses: 0 });
    return `${room.name}-${code}`;
  }

  pending(): JoinReq[] {
    return [...this.joins.values()].filter((j) => j.status === "pending");
  }

  /** the id of the last move-to-another-chat request (H1), for tests to approve */
  lastMove: string | null = null;

  /**
   * opts.asAccount: a misbehaving server together with another person of the room (finding "self-check names the
   * member's account, not the invite's"): that person's browser signs a perfectly valid member_add for this chat's
   * keys with THEIR account, while the request stays addressed to the invite's person.
   */
  approve(reqId: string, opts: { signer?: Account; asAccount?: Account } = {}): Member {
    const j = this.joins.get(reqId)!;
    if (j.status !== "pending") throw new HttpErr(409, "already_decided");
    const room = this.rooms.get(j.room)!;
    const acct = opts.asAccount || this.accounts.get(j.account)!;
    const signer = opts.signer || acct;
    if (j.kind === "join") {
      this.append(room, signer, { op: "member_add", member: j.member_id, account: acct.id, name: j.body.name, app: j.body.app, ed: j.body.ed25519_pk, x: j.body.x25519_pk });
      const m: Member = {
        id: j.member_id, room: room.id, account: acct.id, name: j.body.name, app: j.body.app, app_name: j.body.app_name ?? null, job: j.body.job || "", folder: j.body.folder || "", machine: j.body.machine || "",
        turn: j.body.turn, ed: j.body.ed25519_pk, x: j.body.x25519_pk, key_epoch: 1, holder_session: j.body.session_id || null, holder_epoch: 1, removed: false, handover: null, last_wait_at: 0, last_poll_at: 0,
      };
      this.members.set(m.id, m);
      j.status = "approved";
      this.ring();
      return m;
    }
    // claim: member_rekey
    const m = this.members.get(j.member_id)!;
    this.append(room, signer, { op: "member_rekey", member: m.id, ed: j.body.ed25519_pk, x: j.body.x25519_pk });
    m.ed = j.body.ed25519_pk;
    m.x = j.body.x25519_pk;
    m.key_epoch++;
    m.holder_session = j.body.session_id || null;
    m.holder_epoch++;
    m.handover = null;
    m.turn = j.body.turn;
    const bySender = new Map<string, string[]>();
    for (const d of this.deliveries) {
      if (d.member === m.id && (d.state === "queued" || d.state === "stuck") && d.key_epoch < m.key_epoch) {
        d.state = "needs_resend";
        d.envelope = null;
        (bySender.get(d.from) || bySender.set(d.from, []).get(d.from)!).push(d.message_id);
      }
    }
    for (const [from, ids] of bySender) this.notice(from, "needs_resend", { to_member: m.id, to_name: m.name, message_ids: ids });
    j.status = "approved";
    this.ring();
    return m;
  }

  /** Security review item 11 (as the real server): another person of the room makes a pending join theirs, once. */
  readdress(reqId: string, to: Account) {
    const j = this.joins.get(reqId)!;
    if (j.kind !== "join" || j.status !== "pending" || j.account === to.id || j.readdressed_from) throw new HttpErr(404, "not_found");
    j.readdressed_from = j.account;
    j.account = to.id;
    this.ring();
  }

  /** test knob: how long a join request lasts (the server's setting: 15 minutes in production, 2 on staging) */
  requestTtlMs = 15 * 60_000;

  /** test knob: a server from before POST /join-requests/{id}/cancel */
  noCancel = false;

  /** test knob: the server's request views leave out approver_account (a server from before it) */
  noApproverAccount = false;

  /** the person renews their chat invite: a new code on the same invite; the old code stops working */
  renewInvite(room: Room, who: Account): string {
    for (const [code, i] of room.invites) if (i.account === who.id) room.invites.delete(code);
    return this.invite(room, who);
  }

  /** the invite a person's chat invite is now (their one invite row in the room) */
  inviteRow(room: Room, who: Account) {
    return [...room.invites.values()].find((i) => i.account === who.id);
  }

  reject(reqId: string) {
    const j = this.joins.get(reqId)!;
    j.status = "rejected";
    this.ring();
  }

  /** T8: a compromised DB swaps a pending request's keys before the person approves */
  swapKeys(reqId: string) {
    const j = this.joins.get(reqId)!;
    const k = c.genKeys();
    j.body = { ...j.body, ed25519_pk: k.ed, x25519_pk: k.x };
  }

  removeMember(memberId: string, by: Account) {
    const m = this.members.get(memberId)!;
    this.append(this.rooms.get(m.room)!, by, { op: "member_remove", member: m.id });
    this.dropMember(m);
  }

  private dropMember(m: Member) {
    m.removed = true;
    for (const d of this.deliveries) if (d.member === m.id && (d.state === "queued" || d.state === "stuck")) {
      d.state = "expired";
      d.envelope = null;
    }
    this.ring();
  }

  unstick(memberId: string) {
    for (const d of this.deliveries) if (d.member === memberId && d.state === "stuck") Object.assign(d, { state: "queued", attempts: 0, wakes: 0 });
    this.ring();
  }

  notice(member: string, kind: string, data: any) {
    this.notices.push({ id: ++this.nseq, member, kind, data, created: now(), acked: false });
    this.ring();
  }

  copies(messageId: string) {
    return this.deliveries.filter((d) => d.message_id === messageId);
  }

  // ------------------------------------------------------------------ room drafts (docs/protocol/room-drafts.md)
  /** test knob: POST /api/v1/room-drafts answers 429 too_many_drafts with this Retry-After (seconds) */
  draftsFull: number | null = null;
  /** test knob: the roster served for these rooms has a broken genesis signature (it does not verify from genesis) */
  brokenRoster = new Set<string>();
  /** invite-link calls per member (6 per hour as the contract) */
  inviteLinkCalls = new Map<string, number>();

  /**
   * The person confirms a draft on /create/<id> (contract §3 confirm): their browser signs the genesis and the
   * member_add for the draft's chat. Knobs for a misbehaving server: keys (another key in the member_add), by (another
   * person of the room signs the member_add for their own account), name (another name).
   */
  confirmDraft(id: string, owner: Account, o: { by?: Account; keys?: { ed: string; x: string }; name?: string; roomName?: string } = {}): Room {
    const d = this.drafts.get(id)!;
    if (d.status !== "open" || d.expires < now()) throw new HttpErr(404, "not_found");
    const rid = c.uuidv7();
    const name = o.roomName || d.body.room_name;
    const g = makeEntry({ room: rid, op: "genesis", name, owner: owner.id, device: owner.device.pk }, 0, null, owner.device.pk, owner.device.seed);
    const room: Room = { id: rid, name, purpose: d.body.room_purpose || "", owner: owner.id, entries: [g], invites: new Map() };
    this.rooms.set(rid, room);
    const acct = o.by || owner;
    if (o.by) this.addPerson(room, owner, o.by);
    const ed = o.keys?.ed ?? d.body.ed25519_pk, x = o.keys?.x ?? d.body.x25519_pk;
    this.append(room, acct, { op: "member_add", member: d.member_id, account: acct.id, name: o.name || d.body.name, app: d.body.app, ed, x });
    const m: Member = {
      id: d.member_id, room: rid, account: acct.id, name: o.name || d.body.name, app: d.body.app, job: d.body.job || "", folder: d.body.folder || "", machine: d.body.machine || "",
      turn: d.body.turn, ed, x, key_epoch: 1, holder_session: d.body.session_id || null, holder_epoch: 1, removed: false, handover: null, last_wait_at: 0, last_poll_at: 0,
    };
    this.members.set(m.id, m);
    d.status = "confirmed";
    d.room = rid;
    d.confirmer = owner.id;
    this.ring();
    return room;
  }

  rejectDraft(id: string) {
    this.drafts.get(id)!.status = "rejected";
    this.ring();
  }

  /** five wrong codes: the draft is closed (later calls: 404 draft_gone) */
  closeDraft(id: string) {
    this.drafts.get(id)!.status = "closed";
    this.ring();
  }

  /** the draft's row goes (the sweeper) */
  sweepDraft(id: string) {
    this.drafts.delete(id);
    this.ring();
  }

  private draftCreated(d: Draft) {
    return { id: d.id, status: "open", room_name: d.body.room_name, room_purpose: d.body.room_purpose, name: d.body.name, member_id: d.member_id, match_code: d.match_code, expires_at: iso(d.expires), confirm_url: `http://localhost:8811/create/${d.id}` };
  }

  private draftView(d: Draft) {
    // the join view, kind create, as server/internal/agentapi/room_drafts.go: no person and no room id before the confirm
    const base = { id: d.id, kind: "create", match_code: d.match_code, fingerprint: c.memberFingerprint(d.body.ed25519_pk, d.body.x25519_pk), expires_at: iso(d.expires), room: { name: d.body.room_name, purpose: "" }, approver_name: "", approve_url: `http://localhost:8811/create/${d.id}` };
    if (d.status === "confirmed") {
      const room = this.rooms.get(d.room!)!;
      const who = this.accounts.get(d.confirmer!)!;
      return { ...base, status: "approved", room: { id: room.id, name: room.name, purpose: room.purpose }, approver_name: who.name, approver_account: room.owner, member_id: d.member_id, dashboard_url: `http://localhost:8811/rooms/${room.id}` };
    }
    if (d.status === "open" && d.expires < now()) return { ...base, status: "expired" };
    return { ...base, status: d.status === "open" ? "pending" : d.status };
  }

  // ------------------------------------------------------------------ HTTP
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url || "/", "http://x");
    const session = (req.headers["x-botlink-session"] as string) || null;
    this.access.push({ path: url.pathname, id: req.headers["cf-access-client-id"] as string | undefined, secret: req.headers["cf-access-client-secret"] as string | undefined });
    let status = 200;
    const hv = (n: string) => req.headers[n] as string | undefined;
    this.clientHeaders.push({ path: url.pathname, version: hv("x-botlink-client-version"), stale: hv("x-botlink-client-stale"), release: hv("x-botlink-client-release") });
    if (this.client) {
      res.setHeader("X-Botlink-Client-Current", this.client.version);
      res.setHeader("X-Botlink-Client-Url", this.client.url);
      if (this.client.release) res.setHeader("X-Botlink-Client-Current-Release", String(this.client.release));
    }
    try {
      if (this.client && req.method === "POST" && /^\/api\/v1\/(join-requests|room-drafts|me\/claim)$/.test(url.pathname) && hv("x-botlink-client-stale") === "refuse" &&
        cmpVersion(hv("x-botlink-client-version") || "", this.client.version) === -1) {
        throw new HttpErr(409, "client_outdated", `This bot-link client (${hv("x-botlink-client-version")}) is out of date. Run exactly: ${npxRun(this.client.url)} <the same command and arguments>. Do not retry the old command: it runs the old copy again.`, { reason: "behind_current", current_version: this.client.version, url: this.client.url });
      }
      if (this.holdAcks && url.pathname === "/api/v1/me/inbox/ack") {
        await new Promise<void>((r) => res.on("close", () => r()));
        return;
      }
      // what a proxy in front of the server does while the server or the tunnel is unwell (fix-all CLIENTGLUE 7)
      if (this.fault && this.fault.path.test(url.pathname) && this.fault.times > 0) {
        this.fault.times--;
        const k = this.fault.kind;
        status = k === "garbage" ? 200 : k === "stall" ? 504 : Number(k);
        this.log.push({ method: req.method || "", path: url.pathname, status, session });
        if (k === "stall") {
          await new Promise<void>((r) => {
            const t = setTimeout(r, 90_000);
            res.on("close", () => {
              clearTimeout(t);
              r();
            });
          });
          if (!res.writableEnded && !res.destroyed) res.writeHead(504).end();
          return;
        }
        res.writeHead(status, { "Content-Type": "text/html" });
        res.end(k === "garbage" ? "<html><body>Please wait while we check your browser</body></html>" : `<html><body>error code: ${k}</body></html>`);
        return;
      }
      if (this.failNext && this.failNext.path.test(url.pathname) && this.failNext.times > 0) {
        this.failNext.times--;
        throw new HttpErr(this.failNext.status, this.failNext.code, this.failNext.message ?? this.failNext.code, this.failNext.details);
      }
      let gone = false;
      res.on("close", () => (gone = true));
      this.clientGone = () => gone;
      const r = await this.route(req, url, raw, session);
      status = r.status;
      if (r.status === 204) res.writeHead(204).end();
      else {
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r.body));
      }
    } catch (e) {
      const he = e instanceof HttpErr ? e : new HttpErr(500, "internal", String((e as Error)?.stack || e));
      status = he.status;
      res.writeHead(he.status, { "Content-Type": "application/json", ...(he.status === 429 || he.status === 503 ? { "Retry-After": String(he.retryAfterS ?? 1) } : {}) });
      res.end(JSON.stringify({ error: { code: he.code, message: he.message, ...(he.details ? { details: he.details } : {}), ...he.extra } }));
    }
    this.log.push({ method: req.method || "", path: url.pathname, status, session });
  }

  private auth(req: IncomingMessage, url: URL, raw: Buffer): { key: string; session: string | null } {
    const H = (n: string) => req.headers[n] as string | undefined;
    const key = H("x-botlink-key"), t = H("x-botlink-time"), nonce = H("x-botlink-nonce"), sig = H("x-botlink-signature");
    const session = H("x-botlink-session") || null;
    if (!key || !/^[0-9a-f]{64}$/.test(key) || !t || !/^\d+$/.test(t) || !nonce || !/^[0-9a-f]{32}$/.test(nonce) || !sig || !/^[0-9a-f]{128}$/.test(sig)) throw new HttpErr(401, "bad_signature");
    if (session && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(session)) throw new HttpErr(401, "bad_signature");
    const server = nowS() + this.clockSkewS;
    if (Math.abs(server - Number(t)) > 60) throw new HttpErr(401, "stale_timestamp", "stale", undefined, { server_time: server });
    const ok = verifyRequest({ method: req.method || "GET", host: String(req.headers.host || ""), target: url.pathname + url.search, body: raw, time: Number(t), nonce, key, session }, sig);
    if (!ok) throw new HttpErr(401, "bad_signature");
    if (this.nonces.has(`${key}:${nonce}`)) throw new HttpErr(401, "replayed");
    this.nonces.add(`${key}:${nonce}`);
    return { key, session };
  }

  private memberByKey(key: string): Member {
    for (const m of this.members.values()) if (m.ed === key && !m.removed) return m;
    for (const m of this.members.values()) if (m.ed === key && m.removed) throw new HttpErr(410, "gone");
    throw new HttpErr(401, "unknown_key");
  }

  private holder(m: Member, session: string | null) {
    if (m.holder_session && session !== m.holder_session) throw new HttpErr(409, "not_holder", "not holder", { holder_epoch: m.holder_epoch });
  }

  /** SPEC §6.9 (r3 hotfix): from observed behaviour, as server/internal/store TurnLabel */
  private turnLabel(m: Member): string {
    if (m.turn === "always_on") return "always on";
    const waitFresh = now() - m.last_wait_at < 70_000;
    const pollFresh = now() - m.last_poll_at < 70_000 || (now() - (m.last_seen_at || 0) < 90_000 && (m.last_seen_at || 0) > m.last_wait_at + 2000);
    const verified = !!m.wake_verified_at && !this.deliveries.some((d) => d.member === m.id && d.state === "stuck");
    if (verified && (waitFresh || pollFresh)) return "wakes on its own";
    return "answers on its next turn";
  }

  private fp(m: Member) {
    return c.memberFingerprint(m.ed, m.x);
  }

  /** the plan GET /api/v1/me reports (CONTRACT-PLANS "Agent route"); null: an older server that sends none */
  plan: { id: string; history_days: unknown } | null = null;
  private memberSelf(m: Member) {
    const room = this.rooms.get(m.room)!;
    return {
      ...(this.plan ? { plan: this.plan } : {}),
      id: m.id, room: { id: room.id, name: room.name, purpose: room.purpose }, name: m.name, app: m.app, job: m.job, folder: m.folder, machine: m.machine, turn: m.turn,
      account_name: this.accounts.get(m.account)!.name, holder_session: m.holder_session, holder_epoch: m.holder_epoch, key_epoch: m.key_epoch, fingerprint: this.fp(m), handover: m.handover,
    };
  }

  private rosterBody(room: Room) {
    const entries = this.brokenRoster.has(room.id) ? [{ ...room.entries[0], sig: room.entries[0].sig.replace(/^./, (ch) => (ch === "A" ? "B" : "A")) }, ...room.entries.slice(1)] : room.entries;
    return {
      room_id: room.id, head_seq: room.entries.length - 1, entries,
      members: [...this.members.values()].filter((m) => m.room === room.id && !m.removed).map((m) => ({
        member_id: m.id, name: m.name, app: m.app, app_name: m.app_name ?? null, job: m.job, folder: m.folder, turn: m.turn, turn_label: this.turnLabel(m), self_label: m.self_label ?? null, person_name: this.accounts.get(m.account)!.name,
      })),
    };
  }

  private joinView(j: JoinReq) {
    const room = this.rooms.get(j.room)!;
    return {
      id: j.id, kind: j.kind, status: j.status, match_code: j.match_code, fingerprint: c.memberFingerprint(j.body.ed25519_pk, j.body.x25519_pk),
      room: { id: room.id, name: room.name, purpose: room.purpose }, approver_name: this.accounts.get(j.account)!.name,
      ...(this.noApproverAccount ? {} : { approver_account: j.account }),
      dashboard_url: "http://localhost:8811/rooms", approve_url: `http://localhost:8811/approve/${j.id}`, expires_at: iso(j.expires), ...(j.status === "approved" ? { member_id: j.member_id } : {}),
      ...(j.kind === "join" && j.status !== "pending" && j.status !== "approved" && !this.noInviteState ? this.inviteState(room, j) : {}),
    };
  }

  /** test knob: a server from before the request views said whether the invite still works */
  noInviteState = false;
  /** test knob: rooms whose invites no longer let a chat in (deleted, or the inviting person left): invite.state "closed" */
  closedRooms = new Set<string>();
  /** as the real server (agentapi/joinend.go): the invite row the request was made with, never its code */
  private inviteState(room: Room, j: JoinReq) {
    const i = [...room.invites.values()].find((x) => x.account === (j.invite_of || j.account));
    if (!i) return {};
    if (this.closedRooms.has(room.id)) return { invite: { state: "closed" } }; // the room was deleted or the inviter left
    if (i.off) return { invite: { state: "off" } };
    if (i.expires <= now()) return { invite: { state: "expired" } };
    return { invite: { state: "works", expires_at: iso(i.expires) } };
  }

  private async longPoll<T>(waitS: number, check: () => T | null): Promise<T | null> {
    const deadline = now() + waitS * 1000;
    const gone = this.clientGone;
    for (;;) {
      if (gone()) return null; // "client gone" ends the poll (SPEC §6.6)
      let rang!: () => void;
      const p = new Promise<void>((r) => (rang = r));
      this.bells.add(rang); // hold the bell FIRST, then check
      try {
        const v = check();
        if (v) return v;
        if (now() >= deadline) return null;
        await Promise.race([p, new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, deadline - now()))))]);
      } finally {
        this.bells.delete(rang);
      }
    }
  }

  private markStuck(m: Member) {
    for (const d of this.deliveries) {
      if (d.member === m.id && d.state === "queued" && d.lease_until < now() && (d.attempts >= 5 || d.wakes >= 5)) {
        d.state = "stuck";
        this.attention.push({ member: m.id, reason: d.attempts >= 5 ? "attempts" : "wakes" });
        if (d.attempts < 5) m.wake_verified_at = undefined; // five unanswered wakes: nothing wakes this chat now
      }
    }
  }

  private findInvite(code: string) {
    const up = (code.split("-").pop() || "").toUpperCase();
    for (const r of this.rooms.values()) {
      const i = r.invites.get(up);
      if (i && !i.off && i.expires > now()) return { room: r, inv: i };
    }
    throw new HttpErr(404, "invite_invalid");
  }

  private async route(req: IncomingMessage, url: URL, raw: Buffer, _session: string | null): Promise<{ status: number; body: any }> {
    const M = req.method || "GET";
    const P = url.pathname;
    this.hits.set(`${M} ${P}`, (this.hits.get(`${M} ${P}`) || 0) + 1);
    const body = () => (raw.length ? JSON.parse(raw.toString("utf-8")) : {});
    let mm: RegExpMatchArray | null;

    if (M === "GET" && (mm = P.match(/^\/api\/v1\/invites\/([^/]+)$/))) {
      const { room, inv } = this.findInvite(decodeURIComponent(mm[1]));
      return {
        status: 200,
        // open to anyone holding the link: no inviter, purpose or member names
        body: {
          room: { name: room.name }, expires_at: iso(inv.expires),
          member_count: [...this.members.values()].filter((m) => m.room === room.id && !m.removed).length,
        },
      };
    }

    const a = this.auth(req, url, raw);

    if (M === "POST" && P === "/api/v1/join-requests") {
      const b = body();
      if (b.ed25519_pk !== a.key) throw new HttpErr(401, "bad_signature", "key mismatch");
      const prior = this.joins.get(b.id);
      const h = c.sha256hex(raw);
      if (prior) {
        if (prior.bodyHash !== h) throw new HttpErr(409, "id_conflict");
        return { status: 200, body: this.joinView(prior) };
      }
      const { room, inv } = this.findInvite(b.invite);
      let memberId: string;
      if (b.kind === "claim") {
        const m = [...this.members.values()].find((x) => x.room === room.id && !x.removed && x.name === b.name && x.account === inv.account);
        if (!m) throw new HttpErr(404, "member_not_found");
        memberId = m.id;
      } else {
        const live = (x: JoinReq) => x.expires > now();
        if ([...this.members.values()].some((x) => x.room === room.id && !x.removed && x.name === b.name)) throw new HttpErr(409, "name_taken", "taken", { suggestion: `${b.name}-2` });
        // as the real server (agentapi/join.go pendingNameTaken): only a waiting request holds the name
        const waits = this.pending().find((x) => x.room === room.id && x.kind === "join" && x.body.name === b.name && live(x));
        if (waits) throw new HttpErr(409, "name_taken", "A chat's request to join under that name is waiting for approval in this room.", { suggestion: `${b.name}-2`, pending: true, same_machine: !!b.machine && waits.body.machine === b.machine });
        // one chat, one identity per room (agentapi/join.go oneWaitingJoin): the same unsigned words of a chat
        const sess = b.session_id || "", an = b.app_name || "";
        if (b.machine && b.folder && !(b.app === "cursor" && !sess)) {
          const same = (x: { machine?: string; folder?: string; app: string; app_name?: string | null }) => x.machine === b.machine && x.folder === b.folder && x.app === b.app && (x.app_name || "") === an;
          const m = [...this.members.values()].find((x) => x.room === room.id && !x.removed && x.account === inv.account && same(x) && (x.holder_session || "") === sess);
          if (m) throw new HttpErr(409, "already_member", `A chat on this computer is already ${m.name} in this room, from this folder.`, { name: m.name });
          const w = this.pending().find((x) => x.room === room.id && x.kind === "join" && x.account === inv.account && live(x) && x.body.name !== b.name && same(x.body) && (x.body.session_id || "") === sess);
          if (w) throw new HttpErr(409, "join_pending", `A chat on this computer already asked to join this room from this folder as ${w.body.name}.`, { name: w.body.name });
        }
        memberId = c.uuidv7();
      }
      inv.uses++;
      const j: JoinReq = {
        id: b.id, kind: b.kind, room: room.id, account: inv.account, invite_of: inv.account, body: b, bodyHash: h, status: "pending",
        match_code: Array.from({ length: 6 }, () => c.BASE32[Math.floor(Math.random() * 32)]).join(""), member_id: memberId, expires: now() + this.requestTtlMs,
      };
      this.joins.set(j.id, j);
      this.ring();
      return { status: 201, body: this.joinView(j) };
    }

    if (M === "POST" && (mm = P.match(/^\/api\/v1\/join-requests\/([^/]+)\/wait$/))) {
      const j = this.joins.get(mm[1]);
      if (!j) throw new HttpErr(404, "not_found");
      if (j.body.ed25519_pk !== a.key) throw new HttpErr(403, "forbidden"); // signed by the request's key (as the real server)
      // a still pending join moves to the waiting chat's session id (founder report 16 Nov 2026), as the real server
      if (typeof body().session_id === "string" && j.status === "pending" && j.kind === "join") j.body.session_id = body().session_id;
      const ws = Math.min(50, Number(body().wait_s ?? 50));
      await this.longPoll(ws, () => (j.status !== "pending" ? true : null));
      if (j.status === "pending" && j.expires < now()) j.status = "expired";
      return { status: 200, body: this.joinView(j) };
    }

    // the chat takes its own request back (blocker 10), as the real server: only the request's key, only while pending
    if (M === "POST" && (mm = P.match(/^\/api\/v1\/join-requests\/([^/]+)\/cancel$/))) {
      if (this.noCancel) throw new HttpErr(404, "not_found");
      const j = this.joins.get(mm[1]);
      if (!j) throw new HttpErr(404, "not_found");
      if (j.body.ed25519_pk !== a.key) throw new HttpErr(403, "forbidden");
      if (j.status === "pending" && j.expires < now()) j.status = "expired";
      if (j.status === "pending") {
        j.status = "cancelled";
        this.ring();
      }
      return { status: 200, body: this.joinView(j) };
    }

    // ---- room drafts (docs/protocol/room-drafts.md §2): signed by the draft's NEW key, like a join request
    if (M === "POST" && P === "/api/v1/room-drafts") {
      const b = body();
      if (b.ed25519_pk !== a.key) throw new HttpErr(401, "bad_signature", "key mismatch");
      if ("invite" in b || "kind" in b) throw new HttpErr(400, "bad_request", "unknown field");
      const h = c.sha256hex(raw);
      const prior = this.drafts.get(b.id);
      if (prior) {
        if (prior.bodyHash !== h) throw new HttpErr(409, "id_conflict");
        return { status: 200, body: this.draftCreated(prior) };
      }
      if (this.draftsFull !== null) {
        const e = new HttpErr(429, "too_many_drafts", "too many drafts");
        e.retryAfterS = this.draftsFull;
        throw e;
      }
      if (typeof b.room_name !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(b.room_name)) throw new HttpErr(400, "bad_room_name", "bad room name");
      if (typeof b.room_purpose !== "string" || b.room_purpose.length > 140) throw new HttpErr(400, "bad_purpose", "bad purpose");
      if (b.name === "bot-link" || b.room_name === "bot-link") throw new HttpErr(409, "name_taken", "That name is taken.", { suggestion: `${b.name}-2` });
      if ([...this.members.values()].some((m) => m.ed === b.ed25519_pk) || [...this.drafts.values()].some((d) => d.body.ed25519_pk === b.ed25519_pk)) throw new HttpErr(409, "key_in_use");
      const d: Draft = { id: b.id, body: b, bodyHash: h, status: "open", match_code: Array.from({ length: 6 }, () => c.BASE32[Math.floor(Math.random() * 32)]).join(""), member_id: c.uuidv7(), expires: now() + this.requestTtlMs };
      this.drafts.set(d.id, d);
      return { status: 201, body: this.draftCreated(d) };
    }
    if (M === "POST" && (mm = P.match(/^\/api\/v1\/room-drafts\/([^/]+)\/wait$/))) {
      const d = this.drafts.get(mm[1]);
      if (!d || d.status === "closed" || d.body.ed25519_pk !== a.key) throw new HttpErr(404, "draft_gone"); // another key learns nothing
      const ws = Math.min(50, Number(body().wait_s ?? 50));
      await this.longPoll(ws, () => (d.status !== "open" || d.expires < now() ? true : null));
      if (d.status === "closed" || !this.drafts.has(d.id)) throw new HttpErr(404, "draft_gone");
      return { status: 200, body: this.draftView(d) };
    }
    if (M === "POST" && (mm = P.match(/^\/api\/v1\/room-drafts\/([^/]+)\/cancel$/))) {
      const d = this.drafts.get(mm[1]);
      if (d && d.body.ed25519_pk === a.key && d.status === "confirmed") throw new HttpErr(409, "already_decided", "already made", { status: "approved" });
      if (d && d.body.ed25519_pk === a.key && d.status === "open") {
        this.drafts.delete(d.id);
        this.ring();
      }
      return { status: 204, body: null };
    }

    // ---- everything below: an active member's key (or, for /me/roster after approval, the request key = member key)
    const m = this.memberByKey(a.key);
    const room = this.rooms.get(m.room)!;

    // the room owner's chat invite, for one of the owner's chats (room-drafts.md §2): never renewed or turned on here
    if (M === "POST" && P === "/api/v1/me/invite-link") {
      const n = (this.inviteLinkCalls.get(m.id) || 0) + 1;
      this.inviteLinkCalls.set(m.id, n);
      if (n > 6) {
        const e = new HttpErr(429, "rate_limited", "too many");
        e.retryAfterS = 1800;
        throw e;
      }
      if (m.account !== room.owner) throw new HttpErr(403, "not_owner", "not the owner's chat");
      const owner = this.accounts.get(room.owner)!;
      let i = this.inviteRow(room, owner);
      if (!i) {
        this.invite(room, owner);
        i = this.inviteRow(room, owner)!;
      }
      if (i.off) throw new HttpErr(409, "invite_off", "the invite is off");
      if (i.expires <= now()) throw new HttpErr(409, "invite_expired", "the invite expired");
      return { status: 200, body: { url: `http://localhost:8811/i/${room.name}-${i.code}`, expires_at: iso(i.expires) } };
    }

    if (M === "GET" && P === "/api/v1/me") return { status: 200, body: this.memberSelf(m) };
    if (M === "GET" && P === "/api/v1/me/roster") return { status: 200, body: this.rosterBody(room) };

    if (M === "POST" && P === "/api/v1/me/claim") {
      const b = body();
      if (a.session !== b.session_id) throw new HttpErr(400, "bad_request", "session header must equal session_id");
      if (b.expected_holder_epoch !== undefined && b.expected_holder_epoch !== m.holder_epoch) throw new HttpErr(409, "holder_changed");
      const prev = m.holder_session;
      if (prev !== b.session_id) {
        // H1 (as the real server): another chat moves in only with the person's approval (a claim request, new keys)
        if (!b.request) throw new HttpErr(403, "claim_needs_approval", "Moving this member to another chat needs its person's approval in the browser.");
        const q = b.request;
        const h = c.sha256hex(raw);
        const prior = this.joins.get(q.id);
        if (prior) {
          if (prior.bodyHash !== h) throw new HttpErr(409, "id_conflict");
          return { status: 200, body: { ...this.joinView(prior), pending: true, move_to: "chat" } };
        }
        for (const x of this.pending()) if (x.member_id === m.id) x.status = "cancelled";
        const j: JoinReq = {
          id: q.id, kind: "claim", room: m.room, account: m.account, body: { ...q, name: m.name, session_id: b.session_id }, bodyHash: h, status: "pending",
          match_code: Array.from({ length: 6 }, () => c.BASE32[Math.floor(Math.random() * 32)]).join(""), member_id: m.id, expires: now() + 15 * 60_000,
        };
        this.joins.set(j.id, j);
        this.lastMove = j.id;
        this.ring();
        return { status: 201, body: { ...this.joinView(j), pending: true, move_to: "chat" } };
      }
      const waiting = this.deliveries.filter((d) => d.member === m.id && d.state === "queued").length;
      return { status: 200, body: { member: this.memberSelf(m), holder_epoch: m.holder_epoch, previous_session: prev, waiting, handover: m.handover } };
    }

    if (M === "PUT" && P === "/api/v1/me/handover") {
      this.holder(m, a.session);
      const b = body();
      if (JSON.stringify(b.envelope).length > 8192) throw new HttpErr(413, "too_large");
      m.handover = b.envelope;
      return { status: 200, body: { ok: true } };
    }

    if (M === "POST" && P === "/api/v1/me/ask-human") {
      this.attention.push({ member: m.id, reason: body().reason });
      return { status: 200, body: { ok: true } };
    }

    if (M === "DELETE" && P === "/api/v1/me") {
      const b = body();
      const e: SignedEntry = b.roster_entry;
      if (e.seq !== room.entries.length) throw new HttpErr(409, "roster_conflict");
      try {
        verifyRoster(room.id, [...room.entries, e]);
      } catch (x) {
        throw new HttpErr(400, "roster_invalid", String(x));
      }
      room.entries.push(e);
      this.dropMember(m);
      for (const o of this.members.values()) if (o.room === room.id && !o.removed) this.notice(o.id, "roster_changed", { head_seq: e.seq });
      return { status: 200, body: { ok: true } };
    }

    if (M === "POST" && P === "/api/v1/messages") return this.send(m, room, raw, body());

    if (M === "POST" && P === "/api/v1/me/inbox/lease") {
      this.holder(m, a.session);
      const b = body();
      m.last_poll_at = now();
      const ws = this.leaseAtOnce ? 0 : Math.min(50, Number(b.wait_s ?? 0));
      const max = Math.min(50, Number(b.max ?? 50));
      // the chat's own read takes its stuck copies back, and the answer says how many (never a wake)
      let unstuck = 0;
      if (b.unstick) {
        unstuck = this.deliveries.filter((d) => d.member === m.id && d.state === "stuck").length;
        if (unstuck) this.unstick(m.id);
      }
      const r = await this.longPoll(ws, () => {
        if (m.removed) throw new HttpErr(410, "gone");
        this.holder(m, a.session);
        this.markStuck(m);
        if (b.urgent_only && !this.deliveries.some((d) => d.member === m.id && d.state === "queued" && d.lease_until < now() && !d.quiet)) return null;
        const pick = this.deliveries.filter((d) => d.member === m.id && d.state === "queued" && d.lease_until < now()).slice(0, max);
        for (const d of pick) {
          d.lease_until = now() + 120_000;
          d.attempts++;
        }
        const ns = this.notices.filter((n) => n.member === m.id && !n.acked).slice(0, 20);
        return pick.length || ns.length ? { pick, ns } : null;
      });
      const pick = r?.pick || [];
      return {
        status: 200,
        body: {
          deliveries: pick.map((d) => ({ seq: d.seq, message_id: d.message_id, from_member: d.from, scope: d.scope, in_reply_to: d.in_reply_to, created_at: iso(d.created), expires_at: iso(d.expires), attempt: d.attempts, envelope: d.envelope })),
          notices: (r?.ns || []).map((n) => ({ id: n.id, kind: n.kind, data: n.data, created_at: iso(n.created) })),
          lease_s: 120, retry_ms: 0, unstuck,
        },
      };
    }

    if (M === "POST" && P === "/api/v1/me/inbox/ack") {
      this.holder(m, a.session);
      const b = body();
      const items: any[] = [];
      if (b.woken === false) m.wake_verified_at = undefined; // a wake test FAILED: an earlier proof no longer holds
      for (const it of b.items || []) {
        const d = this.deliveries.find((x) => x.member === m.id && x.message_id === it.message_id);
        if (!d) {
          items.push({ message_id: it.message_id, state: "unknown" });
          continue;
        }
        if (it.action === "shown" && d.state === "queued") {
          Object.assign(d, { state: "shown", lease_until: 0 });
          // SPEC §6.9 (2026-11-11): only the client's own statement counts; no inference from "a wait saw it"
          if (b.woken === true) m.wake_verified_at = now();
          this.ackLog.push({ member: m.id, message_id: d.message_id, woken: !!b.woken });
        }
        else if (it.action === "release" && d.state === "queued") d.lease_until = 0;
        else if (it.action === "reject" && d.state === "queued") {
          d.state = "stuck";
          this.notice(d.from, "rejected_by_recipient", { to_member: m.id, to_name: m.name, message_id: d.message_id, reason: it.reason });
        }
        items.push({ message_id: it.message_id, state: d.state });
      }
      for (const id of b.notice_ids || []) {
        const n = this.notices.find((x) => x.id === id && x.member === m.id);
        if (n) n.acked = true;
      }
      return { status: 200, body: { items } };
    }

    if (M === "GET" && P === "/api/v1/me/inbox/recent") {
      this.holder(m, a.session);
      const ds = this.deliveries.filter((d) => d.member === m.id && (d.state === "shown" || d.state === "done") && d.envelope);
      return { status: 200, body: { deliveries: ds.map((d) => ({ seq: d.seq, message_id: d.message_id, from_member: d.from, scope: d.scope, in_reply_to: d.in_reply_to, created_at: iso(d.created), expires_at: iso(d.expires), attempt: d.attempts, envelope: d.envelope })) } };
    }

    if (M === "POST" && P === "/api/v1/me/presence") {
      m.last_seen_at = now();
      this.presenceLog.push({ member: m.id, at: now() });
      return { status: 200, body: { turn_label: this.turnLabel(m), listening_for_s: 90 } };
    }

    if (M === "GET" && P === "/api/v1/me/inbox/count") {
      this.holder(m, a.session);
      m.last_seen_at = now();
      const q = this.deliveries.filter((d) => d.member === m.id && d.state === "queued");
      return { status: 200, body: { queued: q.length, urgent: q.filter((d) => !d.quiet).length, notices: this.notices.filter((n) => n.member === m.id && !n.acked).length, available: q.filter((d) => d.lease_until < now()).length } };
    }

    if (M === "PUT" && P === "/api/v1/me/turn") {
      const t = body().turn;
      if (!["wake", "listening", "on_turn"].includes(t)) throw new HttpErr(400, "bad_request");
      m.turn = t;
      this.turnLog.push({ member: m.id, turn: t });
      return { status: 200, body: { turn: t } };
    }

    if (M === "PUT" && P === "/api/v1/me/card") {
      const b = body();
      if (typeof b.label === "string") m.self_label = b.label.trim() || null;
      return { status: 200, body: this.memberSelf(m) };
    }

    if (M === "POST" && P === "/api/v1/me/selftest") {
      const b = body();
      const hd = JSON.parse(Buffer.from(b.envelope.h, "base64url").toString("utf-8"));
      if (hd.scope !== "self" || hd.from !== m.id || hd.to !== m.id || hd.id !== b.id) throw new HttpErr(400, "bad_request", "not a self-test");
      this.messages.set(b.id, { from: m.id, hash: c.sha256hex(raw), room: room.id });
      // delay_s (r3): the copy reaches the member that many seconds later (the real server holds it back with not_before)
      const put = () => {
        this.deliveries.push({
          seq: ++this.seq, message_id: b.id, member: m.id, from: m.id, scope: "self", in_reply_to: null, envelope: b.envelope, state: "queued", lease_until: 0,
          attempts: 0, wakes: 0, key_epoch: m.key_epoch, created: now(), expires: now() + 86400_000,
        });
        this.ring();
      };
      // (only tests that ask for it: BOTLINK_FAKE_DELAY=1; the others see the copy at once, as before)
      if (Number(b.delay_s) > 0 && process.env.BOTLINK_FAKE_DELAY === "1") setTimeout(put, Number(b.delay_s) * 1000).unref();
      else put();
      return { status: 201, body: { id: b.id, duplicate: false } };
    }

    if (M === "POST" && P === "/api/v1/me/wait") {
      const wb = body();
      const ws = Math.min(50, Number(wb.wait_s ?? 50));
      m.last_wait_at = now();
      const n = await this.longPoll(ws, () => {
        if (m.removed) throw new HttpErr(410, "gone");
        this.markStuck(m);
        const ds = this.deliveries.filter((d) => d.member === m.id && d.state === "queued" && d.lease_until < now() && !(wb.urgent_only && d.quiet));
        if (!wb.peek) for (const d of ds) d.wakes++;
        return ds.length ? ds.length : null;
      });
      return { status: 200, body: { count: n || 0, holder_session: m.holder_session, retry_ms: 0 } };
    }

    const ev = this.events.route(M, P, { id: m.id, account: m.account }, body);
    if (ev) return ev;

    throw new HttpErr(404, "not_found", `${M} ${P}`);
  }

  private send(m: Member, room: Room, raw: Buffer, b: any) {
    if (this.beforeSend) {
      const f = this.beforeSend;
      this.beforeSend = null;
      f();
    }
    const h = c.sha256hex(raw);
    const prior = this.messages.get(b.id);
    if (prior) {
      if (prior.from === m.id && prior.hash === h) return { status: 200, body: { id: b.id, recipients: this.copies(b.id).length, duplicate: true } };
      throw new HttpErr(409, "id_conflict");
    }
    if (b.room_id !== room.id) throw new HttpErr(403, "not_member");
    const recips = [...this.members.values()].filter((x) => x.room === room.id && !x.removed && x.id !== m.id && (b.scope === "room" || x.id === b.to_member));
    const changed = () =>
      new HttpErr(409, "recipients_changed", "recipients changed", { head_seq: room.entries.length - 1, recipients: [...this.members.values()].filter((x) => x.room === room.id && !x.removed && x.id !== m.id).map((x) => ({ member_id: x.id, fingerprint: this.fp(x) })) });
    const envs: any[] = b.envelopes || [];
    if (envs.length !== recips.length || !recips.every((r) => envs.some((e) => e.to_member === r.id))) throw changed();
    const now7 = nowS() + 7 * 86400;
    for (const e of envs) {
      const r = recips.find((x) => x.id === e.to_member)!;
      if (e.to_fp !== this.fp(r)) throw changed();
      const hb = Buffer.from(e.envelope.h, "base64url");
      const hd = JSON.parse(hb.toString("utf-8"));
      if (!c.verifyCtx(c.CTX_ENV, hb, e.envelope.sig, m.ed)) throw new HttpErr(400, "bad_request", "envelope signature");
      if (hd.id !== b.id || hd.room !== room.id || hd.from !== m.id || hd.scope !== b.scope || (hd.in_reply_to ?? null) !== (b.in_reply_to ?? null) || hd.to !== r.id || hd.to_fp !== this.fp(r) || hd.from_fp !== this.fp(m)) {
        throw new HttpErr(400, "bad_request", "header mismatch");
      }
      if (c.sha256hex(Buffer.from(e.envelope.ct, "base64")) !== hd.ct_sha256) throw new HttpErr(400, "bad_request", "ct hash");
      if (hd.expires_at < nowS() + 60 || hd.expires_at > now7 + 5) throw new HttpErr(400, "bad_request", "expires_at");
    }
    this.messages.set(b.id, { from: m.id, hash: h, room: room.id });
    for (const e of envs) {
      const r = recips.find((x) => x.id === e.to_member)!;
      this.deliveries.push({
        seq: ++this.seq, message_id: b.id, member: r.id, from: m.id, scope: b.scope, in_reply_to: b.in_reply_to ?? null, envelope: e.envelope, state: "queued", lease_until: 0, quiet: !!b.quiet,
        attempts: 0, wakes: 0, key_epoch: r.key_epoch, created: now(), expires: now() + 7 * 86400_000,
      });
    }
    if (b.in_reply_to) for (const d of this.deliveries) if (d.message_id === b.in_reply_to && d.member === m.id && (d.state === "queued" || d.state === "shown")) Object.assign(d, { state: "done", envelope: null });
    this.ring();
    return { status: 201, body: { id: b.id, recipients: recips.length, duplicate: false } };
  }
}

export type { RosterState };
