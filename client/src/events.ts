/**
 * bot-link Events (SPEC §6.13): the client side of MCP Events' URL mode (SEP-3415, draft).
 *
 *   - sign / verify: Standard Webhooks (https://www.standardwebhooks.com): the signature is
 *     "v1," + base64(HMAC-SHA256(secret, "<id>.<timestamp>.<body>")), the secret "whsec_" + base64 of 24..64 bytes.
 *   - subscribe / list / unsubscribe: the signed calls to /api/v1/me/events/subscriptions.
 *   - serveEvents: `botlink events serve`: a small receiver for a computer bot-link's server can reach (a server, a
 *     cloud box, anything behind a tunnel). It checks every event's signature, answers the verification challenge,
 *     and gives the member's chat a turn with the same nudges a listener uses. No long-poll, no process holding a
 *     connection open: the server calls when there is something to read.
 *
 * An event never carries message text. It says a sealed message waits; the chat reads it with its own inbox.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

import * as st from "./state.js";
import { apiFor, signerOf, explain, UserError } from "./core.js";
import { ApiError } from "./api.js";
import { selfCmd } from "./version.js";
import { startTag } from "./session.js";

// ------------------------------------------------------------------ catalogue (MCP `events/list`)
export const EVENT_MESSAGE = "message.received";
export const EVENT_ROSTER = "roster.changed";

const who = { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] };

export const EVENT_CATALOG = [
  {
    name: EVENT_MESSAGE,
    description:
      "A sealed bot-link message is waiting for this chat's member. Carries ids and names only, never the text (messages are sealed end to end): on this event, call the bot-link inbox tool to read it.",
    delivery: ["webhook", "poll"],
    inputSchema: {
      type: "object",
      properties: {
        urgent_only: { type: "boolean", description: "skip FYI messages (they wait for the chat's next turn)" },
        room: { type: "string", description: "which room, when this chat is a member of several" },
        as: { type: "string", description: "which member this chat acts as (its name), when bot-link can't tell" },
      },
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        subscription_id: { type: "string" },
        member: who,
        room: who,
        message_id: { type: "string" },
        from: { type: "object", properties: { id: { type: ["string", "null"] }, name: { type: "string" } } },
        scope: { type: "string", enum: ["member", "room", "self"] },
        quiet: { type: "boolean" },
        waiting: { type: "integer", description: "messages waiting for the member right now" },
        self_test: { type: "boolean", description: "bot-link's own wake test, not a member's message" },
      },
      required: ["member", "room", "waiting"],
    },
  },
  {
    name: EVENT_ROSTER,
    description: "The member list of this chat's room changed (someone joined, left, was removed, or moved to a new chat). Content-free: call the bot-link roster tool to see it.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: { room: { type: "string" }, as: { type: "string" } },
      additionalProperties: false,
    },
    payloadSchema: { type: "object", properties: { subscription_id: { type: "string" }, member: who, room: who, head_seq: { type: "integer" } }, required: ["member", "room"] },
  },
] as const;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "14:05 UTC on 18 Nov" */
export function utcWhen(t: number): string {
  const d = new Date(t);
  return `${d.toISOString().slice(11, 16)} UTC on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export const isEventName = (n: unknown): n is string => typeof n === "string" && EVENT_CATALOG.some((e) => e.name === n);

// ------------------------------------------------------------------ Standard Webhooks
const SECRET_RE = /^whsec_([A-Za-z0-9+/]+={0,2})$/;
export const TOLERANCE_S = 300;

/** A fresh signing secret: "whsec_" + base64 of 32 random bytes. */
export function newSecret(): string {
  return "whsec_" + randomBytes(32).toString("base64");
}

/** The key bytes of a `whsec_…` secret, or null when it isn't one (24..64 bytes). */
export function secretKey(secret: string): Buffer | null {
  const x = SECRET_RE.exec(secret || "");
  if (!x) return null;
  const k = Buffer.from(x[1], "base64");
  return k.length >= 24 && k.length <= 64 ? k : null;
}

export function sign(secret: string, id: string, tsSec: number | string, body: Buffer | string): string {
  const k = secretKey(secret);
  if (!k) throw new Error("not a whsec_ secret");
  return "v1," + createHmac("sha256", k).update(`${id}.${tsSec}.`).update(body).digest("base64");
}

export type VerifyResult = "ok" | "bad_signature" | "stale";

/** Check one received message against any of the secrets: the id + timestamp + exact body bytes must carry a "v1"
 *  signature made with one of them, and the timestamp must be within 5 minutes of now. */
export function verify(secrets: string[], h: { id?: string; timestamp?: string; signature?: string }, body: Buffer, nowMs = Date.now()): VerifyResult {
  const { id, timestamp, signature } = h;
  if (!id || !timestamp || !/^\d{1,12}$/.test(timestamp) || !signature) return "bad_signature";
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > TOLERANCE_S) return "stale";
  for (const secret of secrets) {
    const k = secretKey(secret);
    if (!k) continue;
    const want = createHmac("sha256", k).update(`${id}.${timestamp}.`).update(body).digest();
    for (const part of signature.split(/\s+/)) {
      const [v, b64] = part.split(",");
      if (v !== "v1" || !b64) continue;
      const got = Buffer.from(b64, "base64");
      if (got.length === want.length && timingSafeEqual(got, want)) return "ok";
    }
  }
  return "bad_signature";
}

// ------------------------------------------------------------------ subscriptions (signed API)
export interface SubView {
  id: string;
  url: string;
  name: string;
  urgent_only: boolean;
  state: "on" | "off" | "expired";
  created_at: string;
  refreshed_at: string;
  refresh_before: string;
  last_ok_at: string | null;
  last_error: string | null;
  failed_since: string | null;
  fails: number;
  /** "person": the member's person approved the address on the dashboard; the address never answered the check */
  approved_by?: "person" | null;
  approved_at?: string | null;
}

/** An address this member asked its person to approve (docs/protocol/event-url-approval.md §1). Never a secret. */
export interface RequestView {
  id: string;
  status: "waiting" | "approved" | "rejected" | "expired";
  url: string;
  name: string;
  urgent_only: boolean;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  /** the person's page, only while it waits */
  approve_url: string | null;
}

export interface SubscribeArgs {
  name: string;
  url: string;
  secret?: string | null;
  urgentOnly?: boolean;
  ttlS?: number | null;
}

const callAs = (m: st.MemberRec, session: string | null) => ({ signer: signerOf(m), session: session ?? m.holder_session });

/** Subscribe (or refresh the same subscription). `secret`: ours; without one the server makes it (returned once). */
export async function subscribe(m: st.MemberRec, a: SubscribeArgs, session: string | null = null): Promise<{ subscription: SubView; refreshed: boolean; secret?: string }> {
  if (!isEventName(a.name)) throw new UserError(`No such event: ${a.name}. Events: ${EVENT_CATALOG.map((e) => e.name).join(", ")}.`);
  if (a.secret && !secretKey(a.secret)) throw new UserError("The signing secret must be whsec_ followed by base64 of 24 to 64 random bytes.");
  const body: Record<string, unknown> = { name: a.name, url: a.url };
  if (a.secret) body.secret = a.secret;
  if (a.urgentOnly) body.urgent_only = true;
  if (a.ttlS) body.ttl_s = a.ttlS;
  return (await apiFor(m.server).call<any>({ method: "POST", path: "/api/v1/me/events/subscriptions", body, ...callAs(m, session), retryForMs: 15_000, timeoutMs: 20_000 })).json;
}

export async function listSubs(m: st.MemberRec, session: string | null = null): Promise<SubView[]> {
  return (await apiFor(m.server).call<any>({ method: "GET", path: "/api/v1/me/events/subscriptions", ...callAs(m, session), retryForMs: 15_000 })).json.subscriptions;
}

/** The subscriptions and the address requests (waiting, and decided in the last day). */
export async function listAll(m: st.MemberRec, session: string | null = null): Promise<{ subscriptions: SubView[]; requests: RequestView[] }> {
  const j = (await apiFor(m.server).call<any>({ method: "GET", path: "/api/v1/me/events/subscriptions", ...callAs(m, session), retryForMs: 15_000 })).json;
  return { subscriptions: j.subscriptions || [], requests: j.requests || [] };
}

/** Withdraw a waiting address request (idempotent): true when one was removed. */
export async function withdrawRequest(m: st.MemberRec, id: string, session: string | null = null): Promise<boolean> {
  return !!(await apiFor(m.server).call<any>({ method: "DELETE", path: `/api/v1/me/events/requests/${encodeURIComponent(id)}`, ...callAs(m, session), retryForMs: 15_000 })).json.removed;
}

export async function unsubscribe(m: st.MemberRec, id: string, session: string | null = null): Promise<boolean> {
  return !!(await apiFor(m.server).call<any>({ method: "DELETE", path: `/api/v1/me/events/subscriptions/${encodeURIComponent(id)}`, ...callAs(m, session), retryForMs: 15_000 })).json.removed;
}

/** How many messages wait unread for the member right now (no wake counted), or null when that can't be told. */
export async function waitingNow(m: st.MemberRec): Promise<number | null> {
  try {
    // the count call, not the listener's wait: a wait (even a peek) is recorded as "a listener is holding the wait",
    // which this receiver is not
    const r = (await apiFor(m.server).call<any>({ method: "GET", path: "/api/v1/me/inbox/count", signer: signerOf(m), session: m.holder_session, retryForMs: 5000, timeoutMs: 8000 })).json;
    return Number(r?.available || 0);
  } catch {
    return null;
  }
}

/** The server's 409 for a plain subscribe to an address the member's person stopped, or turned a request for down, in
 *  the last 24 hours (server/internal/agentapi/eventurl.go refusedByPerson): nothing is checked or called.
 *  details.reason: stopped | rejected; details.until: when it ends. The address is compared without its query. */
export const PERSON_SAID_NO_CODE = "stopped_by_person";

/** How a subscribe refusal reads in a chat (our words; never the server's internals). `url` + `askHint`: a plain
 *  `events subscribe` the chat ran, where an address that did not echo the check may be one its person can approve. */
export function explainEvents(e: unknown, o: { url?: string; askHint?: boolean; person?: string } = {}): string {
  if (e instanceof ApiError) {
    if (e.code === "event_url_blocked") return "bot-link can't send events to that URL: it must be https and a public address (not this computer or a private network).";
    if (e.code === "event_verify_failed") {
      const why: Record<string, string> = {
        connection: "bot-link's server couldn't reach it",
        http_4xx: "it refused bot-link's signed check (is the signing secret the same on both sides, and is that computer's clock right to within 5 minutes?)",
        http_5xx: "it replied with a server error",
        challenge_failed: "it replied, but didn't send the check value back",
      };
      const reason = String(e.details?.reason);
      // it answered, but not with the check value: an address that can only say yes (a routine's trigger) is one the
      // person can approve instead. Not for an address bot-link could not reach: the person can't fix that.
      const hint = o.askHint && o.url && reason !== "connection"
        ? ` The check called that address once. An address that can only answer yes, such as a routine's trigger in a chat app, can't pass this check. If your human set up this address and asked for it, ask them to approve it instead: \`${selfCmd()} events subscribe --url ${o.url} --ask-person\`.`
        : "";
      return `That URL didn't pass bot-link's check: ${why[reason] || "it didn't reply as an event receiver"}. Nothing was subscribed.${hint}`;
    }
    if (e.code === PERSON_SAID_NO_CODE) {
      // (the server compares the address without its query: nothing here suggests that another query helps)
      const p = o.person || "your human";
      const r = String(e.details?.reason || "");
      const did = r === "stopped" ? "stopped this address" : r === "rejected" ? "turned this address down" : "stopped (or turned down) this address";
      const until = Date.parse(String(e.details?.until ?? ""));
      const end = Number.isFinite(until) ? ` (it sends it nothing until ${utcWhen(until)})` : "";
      return `${cap(p)} ${did} in the last 24 hours, so bot-link did not check or call it${end}. If your human wants it again, ask with \`${selfCmd()} events subscribe --url ${o.url || "<the address>"} --ask-person\`; ${p} approves it on the dashboard.`;
    }
    if (e.code === "approval_ended") {
      const p = o.person || "your human";
      return `bot-link did not renew it: ${p}'s approval of this address ended just now (${p} stopped it, or it ran out or kept failing). To use it again, ask again: \`${selfCmd()} events subscribe --url ${o.url || "<the address>"} --ask-person\`, and your human approves it on the dashboard.`;
    }
    if (e.code === "too_many_subscriptions") return `This member already has 6 event subscriptions. Remove one first: ${selfCmd()} events list, then ${selfCmd()} events unsubscribe <id>.`;
  }
  return explain(e);
}

/** What a chat does when its event subscription was turned off (the room sees "listener down"). */
export function subscriptionOffHint(m: { name: string }, s: SubView, receiverRunning: boolean): string {
  const why: Record<string, string> = { connection: "bot-link's server couldn't reach it", timeout: "it took too long to reply", http_4xx: "it refused the events (a changed signing secret?)", http_5xx: "it replied with server errors", blocked: "its address is no longer a public one" };
  const fix = s.approved_by
    ? `only a new approval turns it on: \`${selfCmd()} events subscribe --url ${s.url} --ask-person\`, and your human approves it on the dashboard`
    : receiverRunning
    ? `the receiver on this computer is running, so check that ${s.url} still reaches it (the tunnel or proxy in front), then restart it: \`${selfCmd()} events stop --as ${m.name}\` and \`${selfCmd()} events serve …\` again`
    : `start the receiver again (\`${selfCmd()} events serve --url ${s.url} …\`), or for your own endpoint fix it and run \`${selfCmd()} events subscribe --url ${s.url}\``;
  return `${m.name}'s event subscription to ${s.url} is off: ${why[s.last_error || ""] || "events kept failing"}${s.failed_since ? ` since ${s.failed_since}` : ""}. Nothing wakes this chat while it's idle and the room sees "listener down". To turn it on: ${fix}; then \`${selfCmd()} selftest\` and end your turn.`;
}

/** One subscription. `person`: who approved it, for one the member's person approved (the address never proved itself). */
export function subLine(s: SubView, person = "your human"): string {
  const again = s.approved_by ? `only a new approval turns it on: ${selfCmd()} events subscribe --url ${s.url} --ask-person` : "subscribe again to turn it on";
  const state = s.state === "on" ? "on" : s.state === "off" ? `OFF (events kept failing: ${s.last_error || "no answer"}; ${again})` : "expired";
  const last = s.last_ok_at ? ` · last accepted ${s.last_ok_at}` : " · nothing accepted yet";
  const by = s.approved_by ? ` · approved by ${person} on the dashboard; bot-link never checked this address` : "";
  return `${s.id} · ${s.name}${s.urgent_only ? " (no FYIs)" : ""} → ${s.url} · ${state}${s.state === "on" ? last : ""} · renew before ${s.refresh_before}${by}`;
}

// ------------------------------------------------------------------ the receiver (`botlink events serve`)
export interface ServeState {
  member: string;
  name: string;
  room: string;
  pid: number;
  /** the process's start tag (session.startTag): the pid alone could be another process after a crash */
  tag: string;
  port: number;
  url: string;
  subscription: string | null;
  command: string | null;
  started: number;
}

export const servePath = (memberId: string) => st.p("events", `${st.safeName(memberId)}.json`);

export const serveLog = (memberId: string) => st.p("logs", `events-${st.safeName(memberId)}.log`);

/** This member's receiver on this computer, when one is running: the recorded process must still exist AND be the
 *  same process (its start tag), so a record left by a crash never points at an unrelated process that got the same
 *  pid later (`events stop` signals this pid). A stale record is removed. */
export function runningReceiver(memberId: string): ServeState | null {
  const r = st.readJson<ServeState | null>(servePath(memberId), null);
  if (!r) return null;
  const alive = Number.isInteger(r.pid) && r.pid > 1 && st.pidAlive(r.pid);
  if (!alive) {
    rmSync(servePath(memberId), { force: true }); // only a record whose process is gone is ever removed
    return null;
  }
  // the tag check only speaks when both sides have one: `ps` may be missing (slim containers) or fail once, and then
  // the pid check alone decides, as for listeners. A live pid with a DIFFERENT tag is another process: not ours, and
  // never signalled (the record is left for the next receiver to overwrite).
  const now = r.tag ? startTag(r.pid) : "";
  return !r.tag || !now || now === r.tag ? r : null;
}

export const receiverLine = (r: ServeState) => `events: ${r.name} in #${r.room} · receiver pid ${r.pid} on port ${r.port} for ${r.url} · ${r.command ? `runs: ${r.command}` : "prints a line"}`;

/**
 * Start `events serve` for a member in the background (its own session; what `events serve --detach` does, and what
 * self-healing does when a receiver it remembers has died). `args` is the command line after the program, without
 * --detach. Resolves once the receiver is subscribed; throws with the end of its log when it doesn't get there.
 */
export async function startDetachedReceiver(m: st.MemberRec, args: string[], cwd = process.cwd()): Promise<ServeState> {
  const { spawn } = await import("node:child_process");
  const { openSync, closeSync, readFileSync, chmodSync } = await import("node:fs");
  st.ensureDir(st.p("logs"));
  const log = serveLog(m.id);
  const fd = openSync(log, "a", 0o600);
  try {
    chmodSync(log, 0o600); // (the mode above only applies when the file is new)
  } catch {
    /* not ours to change: it is still only written through this descriptor */
  }
  const ch = spawn(process.execPath, [process.argv[1], ...args], { cwd: st.exists(cwd) ? cwd : process.cwd(), env: process.env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  ch.unref();
  let exited: number | null = null;
  ch.on("exit", (c) => (exited = c ?? 1));
  // subscribed = its record names a subscription (the subscribe call may retry for a while: up to 40 s)
  const ready = () => {
    const r = runningReceiver(m.id);
    return r && r.pid === ch.pid && r.subscription ? r : null;
  };
  for (let i = 0; i < 400 && exited === null && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
  const r = ready();
  if (r) return r;
  if (exited === null && ch.pid) {
    try {
      process.kill(ch.pid, "SIGTERM"); // the child we started: never leave a half-started receiver behind
    } catch {
      /* gone */
    }
  }
  let tail = "";
  try {
    tail = readFileSync(log, "utf-8").trim().split("\n").slice(-1)[0].replace(/^\S+Z /, "").slice(0, 300);
  } catch {
    /* no log */
  }
  throw new UserError(`The receiver didn't start${tail ? `: ${tail}` : "."}`);
}

export interface ServeOpts {
  /** the URL bot-link's server reaches this receiver at (https; any path) */
  url: string;
  port: number;
  host?: string;
  /** what gives the chat a turn (the same commands a listener runs). None: print a line (a background task's output). */
  command?: string | null;
  /** exit after the first event (a background task the app turns into a turn) */
  once?: boolean;
  urgentOnly?: boolean;
  ttlS?: number;
  say?: (s: string) => void;
  signal?: AbortSignal;
  maxMs?: number;
  /** tests: called once the receiver is subscribed */
  onReady?: (info: { port: number; subscription: SubView }) => void;
  /** tests: the gap between two runs of the command */
  gapMs?: number;
  /** tests: stand-ins for the signed calls */
  api?: { subscribe: typeof subscribe; unsubscribe: typeof unsubscribe; waiting?: typeof waitingNow };
}

const MAX_BODY = 256 * 1024;
/** How long `events serve` asks for (seconds); it renews at a third of it. */
export const SERVE_TTL_S = 1800;

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((res) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) over = true;
      else chunks.push(c);
    });
    req.on("end", () => res(over ? null : Buffer.concat(chunks)));
    req.on("error", () => res(null));
  });
}

/**
 * Run the receiver until it stops. -> exit code: 0 stopped (signal / max time / --once fired), 4 the member left or
 * moved, 6 it couldn't subscribe (the URL doesn't reach this receiver, or isn't allowed).
 */
export async function serveEvents(m: st.MemberRec, o: ServeOpts): Promise<number> {
  const say = o.say || ((s: string) => process.stdout.write(`${new Date().toISOString()} ${s}\n`));
  const L = await import("./listen.js");
  const other = runningReceiver(m.id);
  if (other && other.pid !== process.pid) {
    say(`A receiver for ${m.name} is already running (pid ${other.pid}, port ${other.port}). Stop it first: ${selfCmd()} events stop --as ${m.name}`);
    return 5;
  }
  const secret = newSecret();
  const seen = new Map<string, number>(); // webhook-id → when (events may be sent again; each wakes once)
  const abort = new AbortController();
  o.signal?.addEventListener("abort", () => abort.abort());
  let child: ChildProcess | null = null;
  let running = false;
  let again = false;
  let lastRunEnd = 0;
  let code = 0;
  const gap = o.gapMs ?? L.LISTEN_GAP_MS;

  let latest = 1; // the newest event's count of waiting messages
  const wake = async (n: number) => {
    latest = n;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      for (let round = 0; ; round++) {
        again = false;
        let waiting = latest;
        const cur = st.loadMember(m.id);
        if (!cur) {
          say(`${m.name} is no longer a member on this computer. Receiver stopped.`);
          code = 4;
          abort.abort();
          return;
        }
        const wait = lastRunEnd + gap - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (abort.signal.aborted) return;
        // events that came in during a run: the run usually read those messages too. Run again only when something
        // still waits unread (a wake is a whole turn of the chat; never spend one on nothing).
        if (round > 0) {
          const left = await (o.api?.waiting || waitingNow)(cur);
          if (left === 0) {
            if (!again) return;
            continue; // an event came in while we were asking: look again (its message may be the one that waits)
          }
          if (left) waiting = left;
        }
        // the chat's own inbox read right after this counts as its idle wake (the nudge never reads or acks)
        st.markWake(m.id, "events");
        if (o.command) {
          say(`${m.name}: ${waiting} new message${waiting === 1 ? "" : "s"}; running the wake command`);
          const r = await L.runOnce(cur, o.command, waiting, (c) => (child = c));
          child = null;
          say(`${m.name}: the command exited ${r}`);
        } else {
          say(`${waiting} new bot-link message${waiting === 1 ? "" : "s"} for ${m.name}. Call the bot-link inbox tool (or run: ${selfCmd()} inbox --as ${m.name}).`);
        }
        lastRunEnd = Date.now();
        if (o.once) {
          abort.abort();
          return;
        }
        if (!again) return;
      }
    } finally {
      running = false;
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const end = (status: number, body?: unknown) => {
      const b = body === undefined ? "" : JSON.stringify(body);
      res.writeHead(status, b ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(b) } : {});
      res.end(b);
    };
    if (req.method !== "POST") return end(req.method === "GET" ? 200 : 405, req.method === "GET" ? { ok: true } : undefined);
    const body = await readBody(req);
    if (!body) return end(413);
    const hdr = (k: string) => (Array.isArray(req.headers[k]) ? (req.headers[k] as string[])[0] : (req.headers[k] as string | undefined));
    const id = hdr("webhook-id");
    const v = verify([secret], { id, timestamp: hdr("webhook-timestamp"), signature: hdr("webhook-signature") }, body);
    if (v !== "ok") {
      say(`refused a request (${v === "stale" ? "its time is too far from now" : "its signature doesn't verify"})`);
      return end(401);
    }
    let msg: any;
    try {
      msg = JSON.parse(body.toString("utf-8"));
    } catch {
      return end(400);
    }
    if (!msg || typeof msg !== "object") return end(400);
    // control messages carry a top-level type (SEP-3415); a body without one is an event
    if (msg.type === "verification") return typeof msg.challenge === "string" ? end(200, { challenge: msg.challenge }) : end(400);
    if (typeof msg.type === "string") return end(204);
    if (seen.has(id!)) return end(204); // sent again: already acted on
    seen.set(id!, Date.now());
    if (seen.size > 2000) for (const k of [...seen.keys()].slice(0, 1000)) seen.delete(k); // oldest first (insertion order)
    end(204); // accepted; the wake runs after the answer
    if (msg.name !== EVENT_MESSAGE || msg.data?.member?.id !== m.id) return;
    void wake(Number(msg.data?.waiting) || 1).catch((e) => say(`wake failed: ${e instanceof Error ? e.message : e}`));
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        /* closed */
      }
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const host = o.host || "127.0.0.1";
  try {
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(o.port, host, () => res());
    });
  } catch (e) {
    say(`Can't listen on ${host}:${o.port}: ${(e as Error).message}`);
    return 6;
  }
  const port = (server.address() as { port: number }).port;
  const onSig = () => {
    abort.abort();
    L.killRun(child);
  };
  process.on("SIGTERM", onSig);
  process.on("SIGINT", onSig);
  let sub: SubView | null = null;
  const state = (): ServeState => ({ member: m.id, name: m.name, room: m.room.name, pid: process.pid, tag: startTag(process.pid), port, url: o.url, subscription: sub?.id || null, command: o.command || null, started: Date.now() });
  const api = o.api || { subscribe, unsubscribe };
  // a short grant, renewed often: a receiver that dies leaves nothing behind for long (bot-link stops calling the URL
  // within the half hour), and one whose subscription failures turned off is back on at its next renewal
  const doSubscribe = async () => (await api.subscribe(m, { name: EVENT_MESSAGE, url: o.url, secret, urgentOnly: o.urgentOnly, ttlS: o.ttlS ?? SERVE_TTL_S })).subscription;
  let refresh: NodeJS.Timeout | null = null;
  try {
    // the record first (before the subscribe call, which can take seconds): a second receiver started meanwhile
    // sees this one and refuses, instead of both subscribing and the loser's exit removing the winner's subscription
    st.ensureDir(st.p("events"));
    st.writeJson(servePath(m.id), state());
    try {
      sub = await doSubscribe();
    } catch (e) {
      say(`${m.name}: ${explainEvents(e)}`);
      code = 6;
      return 6;
    }
    st.writeJson(servePath(m.id), state());
    say(`${m.name} in #${m.room.name}: bot-link now sends a signed event to ${o.url} whenever a message waits (subscription ${sub.id}); this receiver (port ${port}) checks each one and ${o.command ? `runs: ${o.command}` : "prints a line"}. Events carry no message text. Test it: ${selfCmd()} selftest --as ${m.name}, then end your turn.`);
    o.onReady?.({ port, subscription: sub });
    // renew at a third of the granted time (every 10 minutes by default)
    const every = Math.max(60_000, Math.min(12 * 3600_000, (Date.parse(sub.refresh_before) - Date.now()) / 3));
    refresh = setInterval(() => {
      doSubscribe().then(
        (s) => (sub = s),
        (e) => {
          say(`${m.name}: couldn't renew the subscription (${explainEvents(e)})`);
          if (e instanceof ApiError && (e.code === "gone" || e.code === "room_gone" || e.code === "unknown_key" || e.code === "not_holder")) {
            code = 4;
            abort.abort();
          }
        },
      );
    }, every);
    refresh.unref();
    await new Promise<void>((res) => {
      if (abort.signal.aborted) return res();
      abort.signal.addEventListener("abort", () => res());
      if (o.maxMs) setTimeout(res, o.maxMs).unref();
    });
  } finally {
    process.off("SIGTERM", onSig);
    process.off("SIGINT", onSig);
    if (refresh) clearInterval(refresh);
    L.killRun(child);
    await new Promise<void>((res) => {
      server.close(() => res());
      server.closeAllConnections?.();
    });
    const lk = st.readJson<ServeState | null>(servePath(m.id), null);
    if (lk && lk.pid === process.pid) rmSync(servePath(m.id), { force: true });
    // stop the events too (best effort; an unreachable server lets the subscription run out by itself)
    if (sub && code !== 4 && st.loadMember(m.id)) await api.unsubscribe(m, sub.id).catch(() => false);
  }
  return code;
}
