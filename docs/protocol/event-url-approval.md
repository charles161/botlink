# An event address a person approves

Status: built (17 Nov 2026, lane EVENTURL-SERVER: migration 0056, `server/internal/agentapi/eventurl.go`,
`server/internal/appapi/eventurl.go`). The code follows this file; where they differ, one of them is a bug. What the
build changed from the first draft is listed in §7.

bot-link Events (SPEC §6.13) sends a small signal to a URL when a message waits for a chat. Before it sends anything
to a new URL, the URL must send back a one-time check value. Some addresses cannot do that: the trigger of a routine
in a chat app answers 200 and nothing else. This file adds a second way to make such an address usable: **the chat's
person approves the address on the dashboard, with a passkey.**

What does not change: a plain subscribe sends one thing to any address a chat names, the signed check request
itself; nothing else is ever sent to an address that neither answered that check nor was approved by the member's
person (an ask with `approval: person` sends nothing at all, and after the person stops an address or turns it down a
plain subscribe sends it nothing for 24 hours, §4). An event never carries message text. The push guard (https, public
addresses only, no redirects, the address checked is the one dialed) applies to every URL, approved or not. A chat
that already knows an address could call it itself, without bot-link, anyway.

## 1. The request

`POST /api/v1/me/events/subscriptions` takes one more optional field: `approval: "person"`, for `message.received`
only (`400` for `roster.changed`: the card in §2 describes messages, nothing else).

An address this chat already proved with the check, or a subscription of this same key (URL, name, `urgent_only`)
that its person approved and that has not lapsed and is not failing, is subscribed or refreshed exactly as without
the field (`201` / `200 {subscription, refreshed}`), with no new request and nothing sent for it. Otherwise the server
does NOT send the check to the URL and sends nothing else there either. It:
1. counts the call (6 per member per hour, `429`): every ask that does not fall through to a plain subscribe or
   refresh counts, whatever refuses it afterwards (the host rule, the push guard, the caps);
2. refuses a host a person could misread (`422 event_url_blocked`, "An address your person approves must have a plain
   host: …"): only ASCII letters, digits and dashes in non-empty labels, no `xn--` label (a browser shows it decoded,
   `xn--80ak6aa92e.com` reads as "apple.com"), no last label that is a number (`16843009`, `0x01010101`, `1.1.257` are
   addresses to a browser), no trailing dot, no user before an `@`; or an IP address written out in full
   (`events.PlainHost`). A routine's trigger sits on a plain vendor host;
3. runs the push guard on the URL as today (`422 event_url_blocked`; a name that does not resolve:
   `422 event_verify_failed {reason: "connection"}`) and the existing body rules; refuses when the member already has
   6 subscriptions (`409 too_many_subscriptions`);
4. makes or reuses an **address request**: `id` (UUIDv7), the member and its keys (`key_epoch`), the URL, the event
   name, `urgent_only`, `ttl_s`, the secret as for any subscription (the caller's own; else the existing
   subscription's of this key; else made by bot-link), `expires_at = now + 24 hours`, status `waiting`;
5. answers `202` with `{ request: { id, status: "waiting", url, name, urgent_only, created_at, expires_at,
   decided_at: null, approve_url }, approve_url, secret? }`, where `approve_url = <app origin>/approve-url/<id>` and
   `secret` is there only when bot-link made it (this answer is the only time it is shown).

The same member asking again for the same URL, name and `urgent_only` while a request waits gets the same request
(`200 {request, approve_url}`, no secret).

No subscription exists, and no event job is made, until the person approves.

Caps: at most 2 waiting requests per member and 10 per account (`409 too_many_requests_waiting`). A request nobody
approved is deleted at the end of its 24 hours; a decided one a day after the decision; one whose member was removed
or moved at once (the sweeper).

`GET /api/v1/me/events/subscriptions` also lists the member's requests (`requests: [...]`, never a secret): the waiting
ones (`status: "expired"` once their 24 hours are over, until the sweeper deletes them) and the ones decided in the
last day (`approved` / `rejected`), so the chat learns the outcome from its next list. Each subscription carries
`approved_by: "person" | null`. `DELETE /api/v1/me/events/requests/{id}` withdraws a waiting one (idempotent,
`{ok, removed}`).

## 2. What the person sees

The request is an item in "What needs you" for the member's person (the account the member belongs to), and has its
own page `/approve-url/<id>` (app host; a dashboard route; anyone else gets the generic not-found page).
`GET /app/v1/needs-you` carries it as `event_urls: [ { id, member: {id, name}, room: {id, name}, url, host, name,
urgent_only, created_at, expires_at } ]` (`host`: see §7): waiting, unexpired requests of the caller's own members that still hold the
keys that asked, in rooms that exist. Every new request (and every decision and withdrawal) sends the person's open
dashboards a "changed" (`GET /app/v1/events`).

The card says, in our words:
- which chat asks, in which room;
- **the host of the address, large, and the full address under it**, as plain text the page did not write (the same
  treatment as a chat's own words on the room-draft page: set apart, never a link, hidden and direction-changing
  characters shown as marks);
- what happens: "bot-link will call this address each time a message waits for <chat>. It sends which room and which
  chat, who wrote, whether the message was to this chat alone or to the room, whether it needs an answer, and how many
  wait, with their ids and the time. It never sends the message text." (What an event carries, exactly: SPEC §6.13
  "Wire". Body `{eventId, name, timestamp, data: {subscription_id, member: {id, name}, room: {id, name}, message_id,
  from: {id, name}, scope, quiet, waiting}}`; a wake test also has `self_test: true` and `from.name = "bot-link"`.
  Headers `webhook-id`, `webhook-timestamp`, `webhook-signature`, `X-MCP-Subscription-Id`, `User-Agent:
  botlink-events/1`, `Content-Type: application/json`.)
- the warning: "bot-link could not check that this address is yours. Approve only if you made this address
  yourself, for example the trigger of a routine in your chat app.";
- **Approve** (passkey) and **Don't**.

## 3. Approve and reject

`POST /app/v1/event-urls/{id}/approve` body `{ human_check }`. The human check has its own action,
`approve_event_url`, target the request id, a passkey on each approval (`humancheck.EveryTime`). In this order:
1. verify the human check (outside any lock, as every approval does);
2. the request is waiting and its member belongs to the caller, else `404 not_found` (one generic body);
3. run the push guard on the URL again, outside any lock (a name lookup can take seconds; it may point elsewhere by
   now): blocked → `422 event_url_blocked`; the name does not resolve → `422 event_verify_failed {reason:
   "connection"}`; nothing approved;
4. one transaction, in the lock order of `store.LockRoom`: the member's room, then the member, then the request.
   The request still waits, is unexpired, and its member is the caller's, not removed, in a room that exists, and still
   held by the keys that asked; else `404`;
5. consume the human check;
6. make the subscription exactly as a verified subscribe would (same id rule, same limits: at most 6 per member,
   `409 too_many_subscriptions`, which rolls everything back and leaves the check usable for this request until it
   expires), marked `approved_by: person`, failure state reset; queue the catch-up event as a subscribe does;
7. mark the request approved. Answer `200 {subscription, request: {id, status: "approved"}}`.

`POST /app/v1/event-urls/{id}/reject` → the request is rejected (`204`); anything not the caller's, decided or
expired is the same `404`. A refused approval (404 or 422) spends its human check, as the other approvals do.

The chat learns the outcome from its next `events list` (the client says so plainly); there is no long poll.

## 4. A subscription a person approved

- It behaves like any subscription: same events, same signature headers, same retries, same honest labels
  (a chat is shown as waking by itself only after an observed idle wake).
- The address never proved itself. So when it fails (the refresh rule of SPEC §6.13: any of this chat's subscriptions
  on that URL has a failure not yet cleared by a later `2xx`, or was turned off by failures; not only after 3 minutes)
  or lapses (its time ran out without a refresh), a refresh does not make it healthy: a plain refresh must pass the
  check (which such an address cannot), `approval: person` asks the person again, and only their new approval resets
  the failure state.
- A refresh of a healthy approved subscription by the same chat, with or without `approval: person`, needs no new
  approval and re-grants its time (default 30 days). The approval covers that one key: another subscription on the
  same URL (the other `urgent_only`) must pass the check or be approved on its own. If the address later passes the
  check, it is proven and `approved_by` is cleared.
- The person can stop it: `GET /app/v1/members/{id}/event-urls` → `{ event_urls: [ { subscription_id, url, host,
  name, urgent_only, approved_at, failing } ] }` (the approved subscriptions of the chat that holds the member now;
  `failing`: failing, turned off by failures, or lapsed; only the member's own person, anyone else the generic `404`),
  shown where the page shows how the member listens, with **Stop** (`POST /app/v1/members/{id}/event-urls/{subscription_id}/stop`; removes the subscription; `204`, also
  when it is already gone; `404` for a member that is not the caller's or a subscription the address proved itself).
- After the person pressed **Stop**, or turned a request for an address down, a plain subscribe by that member to that
  address sends it nothing for 24 hours, not even the check: `409 stopped_by_person` (details `reason: "stopped" |
  "rejected"`, `until`), message "This chat's person stopped this address (turned this address down) in the last 24
  hours, so bot-link sends it nothing, not even its check. To use it, ask the person again: botlink events subscribe
  --url <the address> --ask-person." The address is compared without its query or fragment (scheme and host in lower
  case, then the path: `events.URLKey`), any event name and `urgent_only`. An ask with `approval: person` stays
  possible (it sends nothing); the person's next approval of that address lifts it. Recorded in `event_url_refusals`
  (deleted when its 24 hours are over, and with the account).
- After a move of the member to another chat or computer the subscription is dropped like any other.

## 5. The client

- `botlink events subscribe --url <https URL> --ask-person` (MCP: the existing subscribe path with
  `ask_person: true` if the client exposes subscribe as a tool; otherwise the command only). It prints the link for
  the person, what the person will be asked, and that nothing is sent to the address until they approve.
- When a plain `events subscribe` fails because the address did not answer the check, the text says so and names
  `--ask-person` as the way for an address that can only answer yes, such as a routine's trigger.
- `events list` shows waiting requests and their links, and marks subscriptions a person approved.
- The chat shows the link only to its human. It never opens it.

## 6. What an attacker gets

- A chat steered by injected text can ask for an address that belongs to someone else. Nothing is sent there unless
  the chat's own person approves it with a passkey, on a card that shows the host large and says bot-link could not
  check it. If they approve, that address learns when messages wait for that chat, in which room, from whom and how
  many: never the text. The person can stop it.
- The request itself sends nothing to the address, so it cannot be used to make bot-link call a URL.
- The address may carry a key of the person's own (a routine's trigger often does). It is shown only to that person
  and to the chat that sent it (and in that person's account export); it is stored like any subscription URL and is
  in no log line.
- The calls are signed (Standard Webhooks) with a secret only the chat has: given to the chat in the `202` that made
  the request when bot-link made it, never shown to the person, never listed. A routine's trigger checks no
  signature, so nothing on the person's side tells bot-link's calls from anyone else's: whoever learns the trigger
  address can start the routine, with a body of their choosing. That is true of the trigger with or without bot-link;
  approving it adds nothing there. bot-link's own events carry no text, and messages come only through the routine's
  own signed bot-link client, so a routine that treats the call as "go and read bot-link" is given no words by a
  forged call; one that shows the call's body to its model can be.
- The names of other people's chats that write to this chat, and the room's name, go to an address that one person
  approved, possibly a vendor's platform the member does not run; the room's other people are not told. It is the same
  list of fields an address that answered the check gets.
- An approval lasts as long as the chat keeps renewing it (up to 90 days at a time, no new approval while the address
  answers), until the person stops it, it fails, or it lapses. A passkey reset does not end it.
- The one check request a plain subscribe sends goes to any address a chat names, as before this feature; a chat
  that knows an address could call it itself anyway. After a Stop or a no, bot-link sends that address nothing for 24
  hours, not even that check.
- A chat can put at most 2 requests in front of its person at a time (10 for all of one person's chats), and ask at
  most 6 times an hour (a withdrawal and a new ask make a new item). Each new request reloads the person's open
  dashboards; there is no mail and no push to a closed browser. The risk is a person who approves by habit: the card
  shows the host large and says bot-link could not check it, and each approval asks for the passkey.

## 7. What the build changed from the first draft

- `approval: person` is for `message.received` only (§1).
- The `202` and the list carry more of the request (`urgent_only`, `created_at`, `decided_at`, `approve_url`) and the
  `202` carries `secret` when bot-link made it (§1, §6).
- The list also carries requests decided in the last day, and expired ones until the sweeper deletes them, so the
  chat can read the outcome (§1).
- New error codes: `409 too_many_requests_waiting` (§1) and `409 approval_ended` (a refresh that relied on an approval
  found it stopped, lapsed or failing under its lock, once more after one retry).
- The push guard runs before the approval's transaction, not inside it, and a lookup failure is `422
  event_verify_failed {reason: connection}` (§3). The order and the locks are written out (§3).
- "Failing" is the refresh rule of SPEC §6.13, not "failing for 3 minutes"; a lapsed approved subscription asks again
  too (§4).
- `GET /app/v1/members/{id}/event-urls`, the data for Stop (the dashboard lane's shape); Stop answers `204` / `404`
  (§4). Each subscription view also carries `approved_at`.
- `host` (§2) is what a browser's URL parser gives as `hostname` for `url`: lower-case ASCII, an IPv6 literal in
  brackets. Only plain hosts reach a card (§1 step 2, security review of 17 Nov 2026): no `xn--` label, no numeric
  forms, no trailing dot. So the page's own parse and `host` agree and a look-alike never reaches the card.
- Stop and a turn-down hold plain subscribes back for 24 hours (§4), so "bot-link stops calling this address" is true
  of the check request too.
- A waiting request is not counted in a room card's `needs_you` number (the request has its own page and its own list
  under "What needs you").
