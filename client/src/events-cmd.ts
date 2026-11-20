/**
 * What `botlink events subscribe | list | unsubscribe` do and say (SPEC §6.13), including an address the member's
 * person approves (docs/protocol/event-url-approval.md §5): `events subscribe --url … --ask-person` sends
 * `approval: "person"`; bot-link sends nothing to the address until the person approves it on the dashboard with a
 * passkey. The chat shows the link only to its human, never opens it, and learns the outcome from its next
 * `events list`; it does not wait for it in the turn that asked (a real model once kept waiting and never showed its
 * human a link: the output ends with the block to repeat and "Then end your turn.").
 */
import type * as st from "./state.js";
import { apiFor, signerOf, UserError } from "./core.js";
import { ApiError } from "./api.js";
import * as ev from "./events.js";
import { selfCmd } from "./version.js";

export interface SubscribeCmd {
  url: string;
  name?: string;
  secret?: string | null;
  urgentOnly?: boolean;
  ttlS?: number | null;
  /** ask the member's person to approve the address instead of the check (message.received only) */
  askPerson?: boolean;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const personOf = (m: st.MemberRec) => m.person_name || "your human";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "14:05 UTC on 18 Nov" */
function when(at: string | number | null | undefined): string {
  const t = typeof at === "number" ? at : Date.parse(String(at ?? ""));
  if (!Number.isFinite(t)) return "an unknown time";
  const d = new Date(t);
  return `${d.toISOString().slice(11, 16)} UTC on ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The address's host as written (no IDNA conversion: what the server sees). */
const rawHost = (url: string) => /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]*)/i.exec(url)?.[1];

/**
 * The host of an address a person approves must be plain (server/internal/events/subs.go PlainHost, `422
 * event_url_blocked`): an IP address written out in full, or ASCII letters, digits and dashes in non-empty labels, no
 * xn-- label (a browser decodes it into another script: a look-alike), no dot at the end, a last label that is not a
 * number (a browser turns 16843009, 0x01010101 or 1.1.257 into an address), no user before an @. Refused here, before
 * anything is sent, exactly as the server refuses it (the test copies the server's table); null when it is fine.
 */
export function hostFormRefusal(url: string): string | null {
  const auth = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1];
  if (auth === undefined) return null; // not an address at all: the server's own checks answer
  const say = (why: string) => `bot-link did not ask: for an address your human approves, the host must be a plain name or a plain IP address, and ${why}. Nothing was asked.`;
  if (![...auth].every((ch) => ch.charCodeAt(0) >= 0x21 && ch.charCodeAt(0) <= 0x7e)) return say("this one has characters outside plain ASCII");
  if (auth.includes("@")) return say("this one has a name and an @ before the host");
  if (auth.startsWith("[")) {
    const ip = auth.slice(1, auth.indexOf("]"));
    return !ip.includes("%") && /^[0-9a-f:.]+$/i.test(ip) && ip.includes(":") ? null : say("this one is not an IP address written out in full");
  }
  const host = auth.replace(/:\d*$/, "");
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host)) return null;
  if (host.endsWith(".")) return say("this one ends with a dot");
  const labels = host.toLowerCase().split(".");
  if (labels.some((l) => l === "")) return say("this one has an empty part (two dots in a row)");
  if (labels.some((l) => l.startsWith("xn--"))) return say("this one has an xn-- part (an international name)");
  if (labels.some((l) => !/^[a-z0-9-]+$/.test(l))) return say("this one has characters other than letters, digits, dots and dashes");
  const last = labels[labels.length - 1];
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return say("this one ends in a number a browser reads as an address (write an IP address in full, like 1.2.3.4)");
  return null;
}

const NOT_MESSAGE = "--ask-person is only for message.received: your human approves an address that is called when a message waits, nothing else. Nothing was asked.";

/** `events subscribe`: subscribe (the address answers the check) or, with askPerson, ask the person. The text to print. */
export async function subscribeText(m: st.MemberRec, o: SubscribeCmd, session: string | null = null): Promise<string> {
  const name = o.name || ev.EVENT_MESSAGE;
  const person = personOf(m);
  if (o.askPerson) {
    if (name !== ev.EVENT_MESSAGE) throw new UserError(NOT_MESSAGE);
    const bad = hostFormRefusal(o.url);
    if (bad) throw new UserError(bad);
    if (o.secret && !ev.secretKey(o.secret)) throw new UserError("The signing secret must be whsec_ followed by base64 of 24 to 64 random bytes.");
    const body: Record<string, unknown> = { name, url: o.url, approval: "person" };
    if (o.secret) body.secret = o.secret;
    if (o.urgentOnly) body.urgent_only = true;
    if (o.ttlS) body.ttl_s = o.ttlS;
    let r: { status: number; json: any };
    try {
      // a refused ask counts toward the hour's limit: never tried again by itself (retry429: false)
      r = await apiFor(m.server).call<any>({ method: "POST", path: "/api/v1/me/events/subscriptions", body, signer: signerOf(m), session: session ?? m.holder_session, retryForMs: 15_000, timeoutMs: 20_000, retry429: false });
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError(await explainAsk(e, m, o.url, session));
    }
    // the address was already proven by this chat, or approved and healthy: a plain subscribe or renewal
    if (!r.json?.request) return subscribedText(m, r.json);
    return askText(m, r.json, r.status !== 202);
  }
  let r: Awaited<ReturnType<typeof ev.subscribe>>;
  try {
    r = await ev.subscribe(m, { name, url: o.url, secret: o.secret || null, urgentOnly: o.urgentOnly, ttlS: o.ttlS ?? null }, session);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(ev.explainEvents(e, { url: o.url, askHint: true, person }));
  }
  return subscribedText(m, r);
}

function subscribedText(m: st.MemberRec, r: { subscription: ev.SubView; refreshed: boolean; secret?: string; unchecked?: boolean }): string {
  const person = personOf(m);
  const out = [`${r.refreshed ? "Renewed" : "Subscribed"}: ${ev.subLine(r.subscription, person)}`];
  if (r.unchecked) out.push("This server did not ask that URL to prove itself (its operator allowed the host without the check, a test setting). Nothing is known yet about what sits behind it: the wake test decides.");
  if (r.subscription.approved_by) out.push(`No new approval was needed: ${person} approved this address on the dashboard earlier; bot-link never checked it.`);
  if (r.secret) out.push(`Signing secret (shown once; the receiver needs it to check each event's signature): ${r.secret}`);
  out.push(`bot-link's server now calls that URL when ${r.subscription.name === ev.EVENT_MESSAGE ? `a message waits for ${m.name}` : `the members of #${m.room.name} change`}. An event carries ids and names only, never message text. Check it end to end: ${selfCmd()} selftest --as ${m.name}, then end your turn. The run your endpoint starts reads with \`${selfCmd()} inbox --as ${m.name} --woken\` (--woken says: this run was started by the event, nobody typed).`);
  return out.join("\n");
}

/** The answer to an ask: in this order, what is true now, the link and what the person is asked, who sees it, how
 *  the chat learns the outcome, the secret once, and the block to repeat to the human; then the turn ends. */
export function askText(m: st.MemberRec, j: { request: ev.RequestView; approve_url?: string; secret?: string }, again: boolean): string {
  const q = j.request;
  const link = j.approve_url || q.approve_url || "";
  const nothing = `Nothing is sent to ${q.url} yet: bot-link calls that address only after your human approves it.`;
  const lines = [
    again ? `A request for this address already waits for your human. ${nothing}` : nothing,
    `Link for your human: ${link}`,
    `On that page your human is asked to approve that bot-link calls this address when a message waits for ${m.name}, and confirms with a passkey. The link works until ${when(q.expires_at)}.`,
    "Show this link only to your human, in this chat. Never open it yourself, and never put it in a room message.",
    `You learn the outcome from \`${selfCmd()} events list --as ${m.name}\` in a later turn, after your human says they decided: it shows whether they approved it, turned it down, have not decided yet, or whether it expired.`,
  ];
  if (j.secret) {
    lines.push(`Signing secret (shown once): ${j.secret}`);
    lines.push("bot-link signs each call to the address with it, so a receiver that checks signatures can tell bot-link's calls from anyone else's. A routine's trigger does not check it.");
  } else if (again) lines.push("The signing secret was shown only when this request was first made.");
  lines.push("Tell your human:");
  // the whole address, not its host: on a shared vendor host another person's routine has the same host. The address
  // is not repeated here: it may carry the person's own key, and the page shows it (security review, 17 Nov 2026)
  lines.push(`  Open this link and approve it with your passkey, only if the address on that page is exactly the one your app shows for your own routine; it lets bot-link call that address when a message waits for ${m.name}: ${link}`);
  lines.push("Then end your turn.");
  return lines.join("\n");
}

/** An ask's refusal in plain words. */
async function explainAsk(e: unknown, m: st.MemberRec, url: string, session: string | null): Promise<string> {
  const person = personOf(m);
  if (e instanceof ApiError) {
    if (e.code === "too_many_requests_waiting") {
      // which cap: this chat's own two, or the person's ten (the chat's own list tells)
      let mine: number | null = null;
      try {
        mine = (await ev.listAll(m, session)).requests.filter((q) => q.status === "waiting").length;
      } catch {
        /* unknown */
      }
      const own = mine !== null ? mine >= 2 : /member/i.test(e.message);
      return own
        ? `bot-link did not ask: ${m.name} already has 2 addresses waiting for ${person}, the most at a time. ${cap(person)} approves or turns one down on the dashboard first, or withdraw one of them: \`${selfCmd()} events unsubscribe <request id>\` (\`${selfCmd()} events list\` shows them).`
        : `bot-link did not ask: ${cap(person)} already has 10 addresses waiting from their chats, the most at a time. ${cap(person)} approves or turns one down on the dashboard first.`;
    }
    if (e.status === 429) {
      const after = when(Date.now() + (e.retryAfterS || 3600) * 1000).slice(0, 9);
      return `bot-link did not ask: ${m.name} asked for an address ${person} approves 6 times in the last hour, the most allowed (an ask that was refused counts too). Try again after ${after}, and only if your human still wants it.`;
    }
    // the guard (a private or loopback address) or a host form this client did not catch: the server says which only in
    // its own words, so the text names both
    if (e.code === "event_url_blocked" && !hostFormRefusal(url) && /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|0\.)/i.test(rawHost(url) || "")) return `${ev.explainEvents(e)} Nothing was asked.`;
    if (e.code === "event_url_blocked") return hostFormRefusal(url) || "bot-link can't send events to that URL: it must be https and a public address (not this computer or a private network), and for an address your human approves the host must be a plain name or a plain IP address. Nothing was asked.";
    if (e.code === "event_verify_failed" && String(e.details?.reason) === "connection") return "bot-link's server couldn't find that address: its name does not resolve. Nothing was asked.";
    if (e.code === "bad_request" && /message\.received/.test(e.message)) return NOT_MESSAGE;
  }
  return ev.explainEvents(e, { url, person });
}

/** `events list`: subscriptions, the address requests in plain words, and what an approval does and does not show. */
export async function listText(m: st.MemberRec, session: string | null = null): Promise<string> {
  const { subscriptions: subs, requests: reqs } = await ev.listAll(m, session);
  const B = selfCmd();
  if (!subs.length && !reqs.length) {
    return `${m.name} in #${m.room.name} has no event subscriptions. Events: ${ev.EVENT_CATALOG.map((e) => e.name).join(", ")}. Start one: ${B} events subscribe --url <https URL>, or run a receiver here: ${B} events serve --url <the URL that reaches this computer>.`;
  }
  const person = personOf(m);
  const lines = subs.length ? [`Event subscriptions of ${m.name} in #${m.room.name}:`, ...subs.map((x) => "  " + ev.subLine(x, person))] : [`${m.name} in #${m.room.name} has no event subscriptions.`];
  if (reqs.length) {
    lines.push(`Addresses this chat asked ${person} to approve:`);
    for (const q of reqs) {
      const head = `  ${q.id} · ${q.url}${q.urgent_only ? " (no FYIs)" : ""} · `;
      if (q.status === "waiting") lines.push(`${head}waiting for ${person}, nothing is sent to it yet · link for your human: ${q.approve_url} · works until ${when(q.expires_at)}`);
      else if (q.status === "approved") {
        const sub = subs.find((x) => x.url === q.url && x.name === q.name && x.urgent_only === q.urgent_only);
        lines.push(`${head}approved by ${person} at ${when(q.decided_at)}: ${sub ? `bot-link calls it when a message waits for ${m.name} (subscription ${sub.id})` : "it was stopped or removed since, so nothing is sent to it now"}`);
      } else if (q.status === "rejected") lines.push(`${head}turned down by ${person} at ${when(q.decided_at)}: nothing is sent to it. Ask again only if your human asks you to.`);
      else lines.push(`${head}expired: nobody approved it within 24 hours, so nothing is sent to it. Ask again only if your human still wants it.`);
    }
  }
  if (subs.some((x) => x.approved_by)) {
    // the honest-label rule (SPEC §6.9, §6.13): an approval proves the address exists, not that this chat is woken
    lines.push(`${cap(person)} approved an address for ${m.name}: bot-link calls it when a message waits. Whether that gives this chat a turn depends on what the address starts; only a wake test that arrived through it shows that (\`${B} selftest --as ${m.name}\`, then end your turn). Until one did, don't tell your human or the room that this chat wakes by itself: new messages show up on its next turn.`);
  }
  return lines.join("\n");
}

/** `events unsubscribe <id> | --url <URL>`: remove a subscription (sub_…) or withdraw a waiting request (its id). */
export async function unsubscribeText(m: st.MemberRec, o: { id?: string | null; url?: string | null; name?: string | null }, session: string | null = null): Promise<string> {
  const B = selfCmd();
  const person = personOf(m);
  let id = o.id || "";
  let reqUrl = "";
  if (!id && o.url) {
    const { subscriptions, requests } = await ev.listAll(m, session);
    const hits = [
      ...subscriptions.filter((x) => x.url === o.url && (!o.name || x.name === o.name)).map((x) => x.id),
      ...requests.filter((q) => q.status === "waiting" && q.url === o.url && (!o.name || q.name === o.name)).map((q) => q.id),
    ];
    if (hits.length > 1) throw new UserError(`Several subscriptions or requests use that URL; name one: ${hits.join(", ")}.`);
    if (!hits.length) return "No subscription or waiting request uses that URL.";
    id = hits[0];
    reqUrl = o.url;
  }
  if (!id) throw new UserError(`Name a subscription (sub_…) or a waiting request by its id: \`${B} events list\` shows them.`);
  if (UUID.test(id)) {
    if (!reqUrl) reqUrl = (await ev.listAll(m, session)).requests.find((q) => q.id.toLowerCase() === id.toLowerCase())?.url || "";
    return (await ev.withdrawRequest(m, id, session))
      ? `Withdrew the request ${id}: it no longer waits for ${person}, and nothing is sent to ${reqUrl || "that address"}.`
      : `No waiting request ${id} (already approved, turned down, expired or withdrawn). An approved address is a subscription: \`${B} events list\` shows its sub_ id.`;
  }
  return (await ev.unsubscribe(m, id, session)) ? `Removed ${id}: bot-link no longer calls that URL for ${m.name}.` : `No subscription ${id} (already removed).`;
}
