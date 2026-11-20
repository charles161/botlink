# MCP subscriptions and MCP Events: what the documents say (read 2026-11-16)

Purpose: the facts needed to decide what bot-link builds next for "native MCP events". Every name and shape below
is copied from the document named next to it, read on 2026-11-16. Spec repository: `modelcontextprotocol/modelcontextprotocol`,
`main` at `ac00313f` (2026-11-16). What bot-link ships today is in [mcp-events.md](mcp-events.md).

## 1. Summary

| Question | Answer from the documents |
|---|---|
| Newest specification revision | **2026-07-28**, status "Current". 2025-11-25 and older are "Final". `draft` adds nothing on resources, subscriptions or events. |
| Does `subscriptions/listen` exist? | **Yes, under that name**, in the final 2026-07-28 revision (SEP-2575). It replaces `resources/subscribe`, `resources/unsubscribe` and the HTTP GET stream. |
| Do `resources/subscribe` / `resources/unsubscribe` exist? | Only up to 2025-11-25. **Removed in 2026-07-28.** |
| Do `events/list`, `events/subscribe`, `events/unsubscribe` exist? | Yes, in **SEP-3415 "Events Extension"**: status **Accepted** (2026-11-11), **PR open, not merged**, no reference implementation in an official SDK yet. Not part of any spec revision. It also defines `events/poll`, `events/stream` and six `notifications/events/*`. |
| Which revision does SEP-3415 target? | "defined for protocol revision `2026-07-28` and later" (it relies on `server/discover`, per-request capabilities and `subscriptions/listen`). |
| What does bot-link's SDK speak? | `@modelcontextprotocol/sdk` 1.32.1: up to 2025-11-25 (`LATEST_PROTOCOL_VERSION = '2025-11-25'` in `dist/esm/types.js`). It has `resources/subscribe` and no `subscriptions/listen`, no `server/discover`, no `events/*`. The v1.x README: "Support for the 2026-07-28 spec is not planned for v1.x: it is in v2". No SDK release has Events (typescript-sdk issue #2945, open). |
| Founder's wording vs documents | The founder named `subscriptions/listen` and `events/list|subscribe|unsubscribe`. Both names are right. The first is final in 2026-07-28; the second is an accepted, unmerged extension. |

## 2. Spec revision 2026-07-28 (final)

Sources: https://modelcontextprotocol.io/specification/2026-07-28/changelog,
https://modelcontextprotocol.io/specification/2026-07-28/server/resources,
https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions,
`schema/2026-07-28/schema.ts`. Status: "The **current** protocol version is **2026-07-28**." (versioning page).

Changelog, major change 4 (verbatim):

> Replace the HTTP GET endpoint and `resources/subscribe`/`resources/unsubscribe` with `subscriptions/listen`: a single long-lived POST-response stream for opted-in server-to-client change notifications. Clients opt in to specific types (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`); the server acknowledges and tags notifications with `io.modelcontextprotocol/subscriptionId`. [...] ([SEP-2575])

Also in this revision (changelog, major changes 1, 2, 3, 8): no sessions; **no `initialize` handshake** (version and
client capabilities travel in `_meta` of every request: `io.modelcontextprotocol/protocolVersion`,
`io.modelcontextprotocol/clientCapabilities`); servers MUST implement `server/discover`; every result carries
`resultType`. Minor change 6: resource not found is `-32602` (was `-32002`).

Server capability (resources page, verbatim):

```json
{ "capabilities": { "resources": { "listChanged": true, "subscribe": true } } }
```

> `subscribe` : whether the server supports resource-specific update notifications for resources requested through subscriptions/listen using the resourceSubscriptions filter.

Request and filter (schema.ts, verbatim, comments trimmed):

```ts
export interface SubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  /** Subscribe to notifications/resources/updated for these resource URIs. Replaces the former `resources/subscribe` RPC. */
  resourceSubscriptions?: string[];
}
export interface SubscriptionsListenRequestParams extends RequestParams {
  notifications: SubscriptionFilter;
}
export interface SubscriptionsListenRequest extends JSONRPCRequest {
  method: "subscriptions/listen";
  params: SubscriptionsListenRequestParams;
}
export interface SubscriptionsAcknowledgedNotification extends JSONRPCNotification {
  method: "notifications/subscriptions/acknowledged";
  params: SubscriptionsAcknowledgedNotificationParams; // { notifications: SubscriptionFilter }: the subset the server honors
}
export interface SubscriptionsListenResult extends Result {
  _meta: SubscriptionsListenResultMetaObject; // { "io.modelcontextprotocol/subscriptionId": RequestId }
}
```

Rules (schema.ts, verbatim): "the server **MUST NOT** send notification types the client has not explicitly requested
here." The acknowledgement "MUST be the first message the server sends carrying the subscription's ID". The
subscription id "is the JSON-RPC ID of the `subscriptions/listen` request". The result is sent "only when the server
tears the subscription down". On stdio the client ends a listen with `notifications/cancelled`.

Update notification (resources page, verbatim):

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/resources/updated",
  "params": {
    "_meta": { "io.modelcontextprotocol/subscriptionId": 4 },
    "uri": "file:///project/src/main.rs"
  }
}
```

`notifications/resources/list_changed` (no params) "is only delivered on a subscriptions/listen stream when the client
requested it via the `resourcesListChanged` filter field."

For comparison, 2025-11-25 (final, older): `resources/subscribe {uri}` and `resources/unsubscribe {uri}`, each with an
empty result; `notifications/resources/updated {uri}`. This is what SDK 1.32.1 implements.

## 3. SEP-3415 Events Extension (accepted, not merged)

Source: https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415, file `seps/3415-events-extension.md`
at head `4165cc2e`. Header: "**Status**: Accepted", "**Type**: Extensions Track", "**Extension Identifier**:
`io.modelcontextprotocol/events`". PR state on 2026-11-16: open, not merged, labels `SEP`, `accepted`, `extension`,
`triggers-event-wg`. PR body: "The numbers (`-32023` to `-32027`) are provisional. The reference implementation in an
official SDK is outstanding."

Working group: "Tasks and Events" (chartered 2026-03-24 as "Triggers and Events", renamed 2026-10-16),
https://modelcontextprotocol.io/community/working-groups/tasks-events; incubation repository
`modelcontextprotocol/ext-events` ("Contents are exploratory and do not represent official MCP specifications"). No
meeting notes were found on the site or in the repository.

Capability (verbatim):

```jsonc
{ "result": { "capabilities": { "extensions": { "io.modelcontextprotocol/events": { "listChanged": true } } } } }
```

> a server that does not offer it answers any `events/*` request with `-32601` (Method not found).
> Prototype implementations of the design sketch that preceded this SEP advertised a top-level `events` capability, and at least one deployed client reads it. That key is not part of this extension.

| Name | Kind | Shape (SEP text) |
|---|---|---|
| `events/list` | request | params `{cursor?}`; result `{resultType, events: [{name, description, delivery: ["webhook"\|"push"\|"poll"...], inputSchema, payloadSchema, _meta?}], nextCursor?}` |
| `events/poll` | request | params `{name, arguments, cursor (null = from now), maxAgeMs?, maxEvents?}`; result `{resultType, events: [EventOccurrence], cursor, truncated, hasMore, nextPollMs}` |
| `events/stream` | request (push) | params `{name, arguments, cursor, maxAgeMs?, heartbeatMs?}`; events arrive as notifications on the request's stream (stdio: on stdout); final result `{resultType: "complete", _meta: {subscriptionId}}` |
| `events/subscribe` | request (webhook) | params `{name, arguments, delivery: {mode: "webhook", url, secret: "whsec_..."}, cursor, maxAgeMs?, ttlMs?}`; result `{resultType, id, refreshBefore, cursor, truncated, deliveryStatus?}` |
| `events/unsubscribe` | request (webhook) | params `{name, arguments, delivery: {url}}`; empty result; no match is `NotFound -32023` |
| `notifications/events/active` `event` `error` `heartbeat` `terminated` | notifications (push) | each carries `_meta["io.modelcontextprotocol/subscriptionId"]` |
| `notifications/events/list_changed` | notification | only on a `subscriptions/listen` stream that asked for `eventsListChanged` (a new filter field; a reviewer notes this conflicts with SEP-3371) |

EventOccurrence: `{eventId, name, timestamp, data, cursor?, _meta?}`. Webhook delivery: Standard Webhooks
(`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256(secret, id.timestamp.body)>`, several
signatures allowed during rotation, 5-minute tolerance) plus `X-MCP-Subscription-Id`; `https` only; `410` = stop,
`413` = not retried; endpoint proof by echoing `{"type":"verification","challenge":"<nonce>"}` in a `2xx` body (or an
allowlist, prior verification, or `/.well-known/mcp-webhook-receiver.json`). `deliveryStatus.lastError` "MUST be a
server-generated category string, one of `connection_refused`, `timeout`, `tls_error`, `http_4xx`, `http_5xx` or
`challenge_failed`". Errors: `-32602` InvalidParams, `-32023` NotFound, `-32024` Forbidden, `-32025`
ResourceExhausted, `-32026` Unsupported, `-32027` CallbackEndpointError.

On the model (verbatim): "How this works depends on the agent framework. It might inject the event into the
conversation context, trigger a new agent turn, or queue the event for processing. This extension does not prescribe
it."

## 4. bot-link today versus SEP-3415, method by method

bot-link (client `client/src/mcp-events.ts`, server `server/internal/events`) follows the design sketch that came
before the SEP, on protocol 2025-11-25.

| Item | SEP-3415 | bot-link | Same? |
|---|---|---|---|
| Protocol revision | 2026-07-28, `server/discover`, per-request capabilities | 2025-11-25 `initialize` (SDK 1.32.1) | no |
| Capability | `extensions["io.modelcontextprotocol/events"]` only | that key **and** top-level `events` (the sketch's key; the SEP keeps it out) | partly |
| `events/list` | as above | `message.received` (webhook, poll), `roster.changed` (webhook) | yes |
| `events/poll` | cursor, `maxAgeMs`, `maxEvents` | cursor (count-based, no replay); `maxAgeMs` / `maxEvents` ignored | partly |
| `events/stream` (push) | events on the request's stream | answers `-32026` `{feature: "deliveryMode", value: "push"}` (the SEP's own example of Unsupported) | not offered |
| `events/subscribe` | result `cursor` is a watermark | result `cursor: null`, `truncated: false`; `ttlMs: null` gets the longest grant (90 days) and a `refreshBefore` | partly |
| `events/unsubscribe` | no match is `NotFound -32023` | no match answers success ("unsubscribing twice is fine") | no |
| `deliveryStatus.lastError` | `connection_refused`, `timeout`, `tls_error`, `http_4xx`, `http_5xx`, `challenge_failed` | `connection`, `timeout`, `http_3xx`, `http_4xx`, `http_5xx`, `blocked` | no |
| Webhook wire | Standard Webhooks + `X-MCP-Subscription-Id`, challenge echo, 410/413 | same; `webhook-id` = `eventId`; body `{eventId, name, timestamp, data}` without `cursor` | yes |
| `notifications/events/*` | push and list-change notifications | none sent (`listChanged` not declared) | consistent |
| Error codes | -32023..-32027 (provisional) | the same numbers | yes |

Nothing on bot-link's server is specific to MCP: the subscription API (`/api/v1/me/events/subscriptions`) and the
sender also serve `botlink events serve` and any other receiver. So the client setting `BOTLINK_MCP_EVENTS` has no
server counterpart.

## 5. Which apps support what

Tested: Claude Code 2.1.325 only, two `claude -p` runs on 2026-11-16 against a logging stdio server
(`--mcp-config <temp file> --strict-mcp-config`, temp working folder, no config changed). Run 1: the server answered
`server/discover` with 2026-07-28 and declared `resources.subscribe`, `resources.listChanged` and the events extension.
Run 2: the server refused `server/discover`, forcing the 2025-11-25 handshake (what bot-link's server gets today).

| App | Observed | Evidence (log line) | Documented (not tested) |
|---|---|---|---|
| Claude Code 2.1.325, 2026-07-28 | Calls `server/discover`, then `subscriptions/listen` asking only `toolsListChanged` and `resourcesListChanged`; no `resourceSubscriptions`, no `events/*`; client capabilities `{"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}},"extensions":{"io.modelcontextprotocol/tasks":{}}}` (no events extension) | `"method":"subscriptions/listen" ... "notifications":{"toolsListChanged":true,"resourcesListChanged":true}` | "Receives `list_changed` notifications from servers on the newer revision over a stream it holds open" (code.claude.com/docs/en/mcp). No mention of resource subscriptions or Events. Open requests: anthropics/claude-code#106696, #101434 |
| Claude Code 2.1.325, 2025-11-25 | `initialize` only, no `resources/subscribe`, no `events/*` | `"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}}}` | same page |
| Codex | not tested: no login on this box (the overseer's call) | none | MCP page lists stdio, Streamable HTTP, auth, `instructions`; nothing on resources, subscriptions or events. Open requests: openai/codex#16159, #10105 |
| Cursor | not tested: not installed (`command -v cursor-agent cursor` empty) | none | cursor.com/docs/mcp: Tools, Prompts, Resources, Roots, Elicitation, Apps "Supported"; no row for subscriptions or events |
| T3 Code | not tested: not installed (`command -v t3 t3code` empty) | none | T3 Code exposes its own MCP server; MCP client behavior is the harness's (docs/user/cursor.md); nothing on subscriptions or events |

So no tested app subscribes to a resource or calls any `events/*` method, and none says in its docs that it does.

## 6. Wake preference: what it would take (not built)

The documents give no rule for what a client does with a notification while its model is idle. The spec says an
updated resource "may need to be read again" and that a notification "invalidates the cached response"; the
non-normative architecture page refreshes state and tells the model only `if app.conversation.is_active()`; SEP-3415
leaves it to the app ("This extension does not prescribe it"). Claude Code's docs describe one thing that does start
a turn from outside, its own research-preview channels (`notifications/claude/channel`), which "can't deliver channel
messages" on a 2026-07-28 connection.

So a notification alone is not a wake. Making it one needs, per app: (1) the app subscribes (resource URI or event);
(2) on the notification it gives the chat a turn even when idle, or queues it for the next one, and says which;
(3) it reads the resource or the inbox in that turn. bot-link's side would then be: speak 2026-07-28 (SDK v2 or a
hand-written `server/discover` + `subscriptions/listen`); record per member that the notification path is in use;
let the detached listener and `watch` stand by while it is; fall back when a notification goes unread for a stated
time (a minute is a reasonable start) or the client stops listening; never claim "wakes on its own" from a
notification, only from a wake test the chat passes. Until an app does (2), bot-link's own paths (hooks, the detached
listener, `wait`, `watch`, `events serve`) stay the only wake, and they must not be turned off when a client
subscribes.

## 7. Not found

- Spec text on handling a notification while the model is idle (only the non-normative pseudo-code and SEP-3415's "does not prescribe it").
- A TypeScript schema file for SEP-3415 (the PR adds Markdown only).
- Meeting notes of the working group.
- Any SDK release with Events support.
- Any app documentation claiming resource subscriptions or MCP Events.
