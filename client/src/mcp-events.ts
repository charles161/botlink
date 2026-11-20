/**
 * MCP Events for the bot-link MCP server (SPEC §6.13; SEP-3415, draft): `events/list`, `events/subscribe`,
 * `events/unsubscribe` (URL delivery) and `events/poll`. An app that speaks MCP Events (ChatGPT, the Vercel AI SDK,
 * Mastra, TanStack AI, Hermes at the time of writing) subscribes its own URL through these and bot-link's server
 * calls it whenever a sealed message waits for this chat's member: the app gives the chat a turn by itself, with no
 * listener and nothing held open on this computer.
 *
 * The draft has two dialects in the wild; this speaks both where they differ: both capability keys are advertised,
 * results carry `resultType`, and the id sent with each event equals its `eventId` (what deployed apps check).
 */
import { z } from "zod";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type * as st from "./state.js";
import { apiFor, signerOf, UserError } from "./core.js";
import { ApiError } from "./api.js";
import * as ev from "./events.js";

// JSON-RPC error codes: -32602 is the standard one; the others are SEP-3415's (provisional) numbers
export const E = { InvalidParams: -32602, NotFound: -32023, Forbidden: -32024, ResourceExhausted: -32025, Unsupported: -32026, CallbackEndpointError: -32027, Internal: -32603 } as const;

export const EVENTS_CAPABILITIES = { events: {}, extensions: { "io.modelcontextprotocol/events": {} } };

/** Which member the calling chat is (the same rule as every tool: its session's member; `as` / `room` when asked). */
export type Resolve = (a: { room?: string; as?: string }) => Promise<{ m: st.MemberRec; session: string | null }>;

const MIN_TTL_S = 300;
const MAX_TTL_S = 90 * 24 * 3600;
const POLL_MS = 15_000;
const POLL_REPEAT_MS = 60_000; // waiting messages nobody read are reported again after a minute, then ever later
const POLL_REPEAT_MAX_MS = 3600_000;

const complete = <T extends object>(r: T) => ({ resultType: "complete" as const, ...r });

function args(name: string, a: unknown): { urgent_only: boolean; room?: string; as?: string } {
  if (a === undefined || a === null) return { urgent_only: false };
  if (typeof a !== "object" || Array.isArray(a)) throw new McpError(E.InvalidParams, "arguments must be an object.");
  const o = a as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "urgent_only" && k !== "room" && k !== "as") throw new McpError(E.InvalidParams, `Unknown argument ${k} (urgent_only, room, as).`);
  if (o.urgent_only !== undefined && typeof o.urgent_only !== "boolean") throw new McpError(E.InvalidParams, "urgent_only must be true or false.");
  if (o.urgent_only && name !== ev.EVENT_MESSAGE) throw new McpError(E.InvalidParams, "urgent_only is only for message.received.");
  for (const k of ["room", "as"] as const) if (o[k] !== undefined && typeof o[k] !== "string") throw new McpError(E.InvalidParams, `${k} must be a string.`);
  return { urgent_only: !!o.urgent_only, room: o.room as string | undefined, as: o.as as string | undefined };
}

function eventName(p: any): string {
  if (!ev.isEventName(p?.name)) throw new McpError(E.NotFound, `No such event: ${String(p?.name)}.`, { kind: "event" });
  return p.name;
}

/** Server refusals and "which chat is this" as MCP errors (categories only; never an endpoint's own words). */
function toMcp(e: unknown): never {
  if (e instanceof McpError) throw e;
  if (e instanceof ApiError) {
    switch (e.code) {
      case "event_verify_failed":
        throw new McpError(E.CallbackEndpointError, "The URL didn't pass the verification challenge.", { reason: String(e.details?.reason || "challenge_failed") });
      case "event_url_blocked":
        throw new McpError(E.InvalidParams, "delivery.url must be https and a public address.");
      case "too_many_subscriptions":
        throw new McpError(E.ResourceExhausted, "This member already has 6 event subscriptions.", { limit: "subscriptions", max: 6 });
      case "rate_limited":
      case "too_many_polls":
        throw new McpError(E.ResourceExhausted, "Too many calls; try again later.", { limit: "rate", retryAfterMs: (e.retryAfterS || 60) * 1000 });
      case "not_holder":
      case "gone":
      case "room_gone":
      case "unknown_key":
        throw new McpError(E.Forbidden, "This chat is no longer that bot-link member.", { reason: e.code });
      case "bad_request":
        throw new McpError(E.InvalidParams, e.message);
    }
    throw new McpError(E.Internal, `bot-link's server refused that (${e.code}).`);
  }
  if (e instanceof UserError) throw new McpError(E.Forbidden, e.message);
  throw new McpError(E.Internal, e instanceof Error ? e.message : String(e));
}

const status = (s: ev.SubView) => ({ active: s.state === "on", lastDeliveryAt: s.last_ok_at, lastError: s.last_error, failedSince: s.failed_since });

interface PollCursor {
  n: number;
  t: number;
  /** how often the same waiting messages were reported again (the gap doubles each time, up to an hour) */
  r?: number;
  /** the newest waiting message's number when last reported: a higher one is a new message even if the count is the same */
  s?: number;
}
const encCursor = (c: PollCursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decCursor(s: unknown): PollCursor | null {
  if (typeof s !== "string") return null;
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf-8"));
    return typeof c?.n === "number" && typeof c?.t === "number" ? { n: c.n, t: c.t, r: typeof c.r === "number" ? c.r : 0, s: typeof c.s === "number" ? c.s : 0 } : null;
  } catch {
    return null;
  }
}

/** The handlers (also called directly by tests). */
const countOf = async (m: st.MemberRec, session: string | null): Promise<{ available?: number; urgent?: number; newest_seq?: number | null; newest_urgent_seq?: number | null }> =>
  (await apiFor(m.server).call<any>({ method: "GET", path: "/api/v1/me/inbox/count", signer: signerOf(m), session: session ?? m.holder_session, retryForMs: 0, timeoutMs: 8000 })).json;

export function eventHandlers(resolve: Resolve, now: () => number = Date.now, count: typeof countOf = countOf) {
  return {
    async list(_p?: any) {
      return complete({ events: ev.EVENT_CATALOG.map((e) => ({ ...e, delivery: [...e.delivery] })) });
    },

    async subscribe(p: any) {
      try {
        const name = eventName(p);
        const a = args(name, p.arguments);
        const d = p.delivery;
        if (!d || typeof d !== "object") throw new McpError(E.InvalidParams, "delivery is required: {mode, url, secret}.");
        if (d.mode !== undefined && d.mode !== "webhook") throw new McpError(E.Unsupported, "events/subscribe takes delivery.mode = \"webhook\" only; for poll, call events/poll.", { feature: "deliveryMode", value: String(d.mode) });
        if (typeof d.url !== "string" || !/^https?:\/\//.test(d.url)) throw new McpError(E.InvalidParams, "delivery.url must be an https URL.");
        if (typeof d.secret !== "string" || !ev.secretKey(d.secret)) throw new McpError(E.InvalidParams, "delivery.secret must be whsec_ followed by base64 of 24 to 64 random bytes.");
        let ttlS: number | null = null;
        if (p.ttlMs === null) ttlS = MAX_TTL_S; // "no expiry" isn't offered: the longest grant, and refreshBefore says when
        else if (p.ttlMs !== undefined) {
          if (typeof p.ttlMs !== "number" || !Number.isFinite(p.ttlMs) || p.ttlMs <= 0) throw new McpError(E.InvalidParams, "ttlMs must be a positive number or null.");
          ttlS = Math.max(MIN_TTL_S, Math.min(MAX_TTL_S, Math.ceil(p.ttlMs / 1000)));
        }
        const { m, session } = await resolve(a);
        const r = await ev.subscribe(m, { name, url: d.url, secret: d.secret, urgentOnly: a.urgent_only, ttlS }, session);
        return complete({ id: r.subscription.id, refreshBefore: r.subscription.refresh_before, cursor: null, truncated: false, ...(r.refreshed ? { deliveryStatus: status(r.subscription) } : {}) });
      } catch (e) {
        toMcp(e);
      }
    },

    async unsubscribe(p: any) {
      try {
        const name = eventName(p);
        const a = args(name, p.arguments);
        const url = p.delivery?.url;
        if (typeof url !== "string") throw new McpError(E.InvalidParams, "delivery.url is required.");
        const { m, session } = await resolve(a);
        const hit = (await ev.listSubs(m, session)).find((s) => s.url === url && s.name === name && s.urgent_only === a.urgent_only);
        if (hit) await ev.unsubscribe(m, hit.id, session);
        return complete({}); // no match answers the same: unsubscribing twice is fine
      } catch (e) {
        toMcp(e);
      }
    },

    /** Poll delivery, for an app with no URL bot-link can reach (a laptop behind NAT). One cheap count per call; the
     *  cursor remembers what was last reported so waiting messages aren't announced on every poll. */
    async poll(p: any) {
      try {
        const name = eventName(p);
        if (name !== ev.EVENT_MESSAGE) throw new McpError(E.Unsupported, `${name} can't be polled.`, { feature: "deliveryMode", value: "poll" });
        const a = args(name, p.arguments);
        const { m, session } = await resolve(a);
        const c = await count(m, session);
        let n = Number(a.urgent_only ? Math.min(c?.urgent ?? 0, c?.available ?? 0) : c?.available ?? 0) || 0;
        // (the two counts can disagree for a moment: the only urgent copy is being read while an FYI waits. A server
        // that reports "no urgent copy an inbox read would get" settles it.)
        if (a.urgent_only && c && "newest_urgent_seq" in c && c.newest_urgent_seq === null) n = 0;
        const t = now();
        const prev = p.cursor === null || p.cursor === undefined ? null : decCursor(p.cursor);
        if (p.cursor !== null && p.cursor !== undefined && !prev) throw new McpError(E.InvalidParams, "cursor is not one this server issued.");
        // a null cursor means "from now": nothing is reported in this call; what waits is reported by the next one
        // more than before: report now. The same ones still unread: again after a minute, then 2, 4, … up to an hour
        // (an app that turns every event into a turn must not get one a minute forever for a message nobody reads)
        // (a new message can leave the count unchanged: one was read, another came. The newest waiting message's
        // number tells that apart, so a new message is never held back by the repeat gap of an old one.)
        const newest = Number((a.urgent_only ? c?.newest_urgent_seq : c?.newest_seq) ?? 0) || 0;
        const more = !!prev && n > 0 && (n > prev.n || newest > (prev.s || 0));
        const repeat = !!prev && n > 0 && !more && t - prev.t >= Math.min(POLL_REPEAT_MAX_MS, POLL_REPEAT_MS * 2 ** Math.max(0, Math.min(20, prev.r || 0)));
        const fire = more || repeat;
        const next: PollCursor = !prev ? { n: 0, t, s: 0 } : more ? { n, t, r: 0, s: newest } : repeat ? { n, t, r: (prev.r || 0) + 1, s: newest } : n < prev.n ? { n, t, r: 0, s: newest } : prev;
        const events = fire
          ? [{ eventId: `poll-${m.id}-${t}`, name, timestamp: new Date(t).toISOString(), data: { member: { id: m.id, name: m.name }, room: { id: m.room.id, name: m.room.name }, waiting: n } }]
          : [];
        return complete({ events, cursor: encCursor(next), truncated: false, hasMore: false, nextPollMs: POLL_MS });
      } catch (e) {
        toMcp(e);
      }
    },
  };
}

const req = <M extends string>(method: M) => z.object({ method: z.literal(method), params: z.any().optional() });

/** BOTLINK_MCP_EVENTS: `on` (default, unset or empty) or `off`. The one switch for everything in this file. */
export function eventsSetting(env: NodeJS.ProcessEnv = process.env): "on" | "off" {
  const v = (env.BOTLINK_MCP_EVENTS ?? "").trim().toLowerCase();
  if (v === "" || v === "on") return "on";
  if (v === "off") return "off";
  throw new UserError(`BOTLINK_MCP_EVENTS must be on or off (it is "${String(env.BOTLINK_MCP_EVENTS).slice(0, 20)}"). Unset it for the default, on.`);
}

/** Advertise the capability (before connecting) and register the methods; with BOTLINK_MCP_EVENTS=off, nothing:
 *  no capability, no extension key, and every events/* method is method-not-found. */
export function registerEvents(server: McpServer, resolve: Resolve, env: NodeJS.ProcessEnv = process.env) {
  if (eventsSetting(env) === "off") return;
  const s = server.server;
  s.registerCapabilities(EVENTS_CAPABILITIES as any);
  const h = eventHandlers(resolve);
  s.setRequestHandler(req("events/list"), async (r) => h.list(r.params) as any);
  s.setRequestHandler(req("events/subscribe"), async (r) => h.subscribe(r.params ?? {}) as any);
  s.setRequestHandler(req("events/unsubscribe"), async (r) => h.unsubscribe(r.params ?? {}) as any);
  s.setRequestHandler(req("events/poll"), async (r) => h.poll(r.params ?? {}) as any);
  // push streams aren't offered: say so in the draft's own terms instead of "method not found"
  s.setRequestHandler(req("events/stream"), async () => {
    throw new McpError(E.Unsupported, "Push streams aren't offered; use URL delivery (events/subscribe) or events/poll.", { feature: "deliveryMode", value: "push" });
  });
}
