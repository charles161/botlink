# CONTRACT-PLANS: plans, limits, credits, usage, billing (lane D1 server, lane D2 web)

**Switched off for the launch (v1.5, 16 Nov 2026, founder: "we are gonna release without a paywall").** Everything in
this file exists only with `BOTLINK_PAYWALL=on`. With the default (off) bot-link is free: every route below answers
404 like a route that does not exist, nothing is counted, refused or charged for a plan, and only the fair-use limits
apply (SPEC §9 and §9.0). The code, tables, views and tests are kept, not deleted; the plan and billing tests run with
the flag on. See "Turning the paywall on" at the end.

Status: v1, 12 Nov 2026. The server lane (D1) owns this file. If it changes, the change lands in the same commit as
the code and is listed under "Changes" at the bottom. Every route below is also in `api/openapi.yaml`.

## Words and rules the web must follow

- Limit keys (JSON): `rooms`, `agents_per_room`, `people_per_room`, `history_days`, `storage_mb`. Show them as "rooms",
  "members per room", "people per room", "days of history", "MB of stored messages". (A member is a chat in a room.)
- `people_per_room` counts the owner. Free 4 = the owner plus 3 others.
- Limits only go up. The admin page must not offer a value at or below the current one (the server refuses it
  with `409 only_up` anyway). A boost is the only thing that ends; always show its end date.
- A room over a limit stays readable. Being over only stops adding more, and only in `block` mode.
- `mode` is `off`, `count` (default) or `block`. In `count` the person sees "over" but nothing is refused.
- Never per member, never per message: prices are per person (per account).
- Product text: plain words, no em dashes, none of: receipt, seen, delivered, webhook, lease, envelope, epoch.
- Times are RFC 3339 UTC strings. Money is integer US cents. Credits are integers.

## Plans (seeded by migration 0021; admins change the numbers live)

| id | name | rooms | agents_per_room | people_per_room | history_days | for_sale | price |
|---|---|---|---|---|---|---|---|
| free | Free | 3 | 5 | 4 | 7 | no (default plan) | 0 |
| pro | Pro | 20 | 20 | 10 | 30 | yes | $15 a month, or $12 a month billed yearly ($144) |
| team | Team | 100 | 50 | 25 | 30 (placeholder: undecided) | no, cannot be bought | per seat, later |

`storage_mb` (v1.3): free 256, pro 1024, team 1024. MB of messages one account's chats may have stored at once; every
stored copy counts against the SENDER's account (its bytes, plus 256 while the copy's row exists). In `limits` it has
`used` (MB, rounded up) and `ceiling` = the account's safety ceiling: a free account never exceeds
`BOTLINK_STORAGE_CEILING_MB` (default 64; Free then shows `value` 64, `source` `ceiling`), an account on a paid plan
gets the larger of that and its plan's `storage_mb` (Pro: 1024).

Ceiling: today's hard caps (20 rooms owned, 20 members per room, 10 people per room) still refuse exactly as
before, in every mode. The storage ceiling refuses a send in every mode too: `409 storage_full`. A limit above the ceiling is stored but the effective value is capped; `source` is then
`ceiling`. `history_days` has no ceiling.

## Who can call what

- Person routes: signed-in cookie session (`bl_session`); every non-GET needs `Origin` = app origin and
  `X-CSRF-Token` (same as every `/app/v1` route). Signed out: `401 unauthenticated` "Sign in first."
- Admin routes: same rules as `/app/v1/admin/overview`: non-admins (and signed-out callers) get `404 not_found`;
  an admin who has not passed the human check gets `403 admin_locked` "Confirm it's you to open the admin area."
  Every admin route needs the area unlocked. Every write needs a `reason` (1 to 300 characters).
- Event route: no session; the payment gateway signs it (Standard Webhooks headers).
- Agent route: the existing signed `/api/v1/me`.

Common errors (all routes): `400 bad_request` "<what is wrong, one sentence>", `429 quota_exceeded`,
`500 internal`, `503 unavailable`. Error body: `{"error":{"code":"…","message":"…","details":{…}}}`.

---

## Public route

### GET /app/v1/pricing   (no session; `Cache-Control: public, max-age=60`)
The live plan numbers and prices for the pricing page. Nothing about any account (no counts, no ids). Every plan is
listed; `prices` is empty when a plan is not for sale. On a site host `/app/v1` is not served (the page keeps the
numbers in its HTML).
```json
{
  "mode": "count",
  "plans": [
    { "id": "free", "name": "Free", "rooms": 3, "agents_per_room": 5, "people_per_room": 4, "history_days": 7, "for_sale": false, "prices": [] },
    { "id": "pro", "name": "Pro", "rooms": 20, "agents_per_room": 20, "people_per_room": 10, "history_days": 30, "for_sale": true,
      "prices": [
        { "product": "pro_monthly", "usd_cents": 1500, "per": "month", "billed": "monthly", "total_usd_cents": 1500 },
        { "product": "pro_yearly",  "usd_cents": 1200, "per": "month", "billed": "yearly",  "total_usd_cents": 14400 } ] },
    { "id": "team", "name": "Team", "rooms": 100, "agents_per_room": 50, "people_per_room": 25, "history_days": 30, "for_sale": false, "prices": [] }
  ]
}
```

## Person routes

### GET /app/v1/plan
My plan, effective limits and where each comes from, usage against each limit, boost heads-ups, billing state,
what is for sale, and my credit balance.

```json
{
  "plan": { "id": "free", "name": "Free" },
  "mode": "count",
  "limits": {
    "rooms":           { "value": 3,  "source": "plan",  "plan_value": 3, "raise": null, "boost": null, "ceiling": 20,
                         "used": 4, "over": true },
    "agents_per_room": { "value": 8,  "source": "boost", "plan_value": 5, "raise": null,
                         "boost": { "id": "0193…b1", "value": 8, "ends_at": "2026-12-01T00:00:00Z" }, "ceiling": 20,
                         "used": 6, "over": false, "rooms_over": [] },
    "people_per_room": { "value": 6,  "source": "raise", "plan_value": 4, "raise": 6, "boost": null, "ceiling": 10,
                         "used": 3, "over": false, "rooms_over": [] },
    "history_days":    { "value": 7,  "source": "plan",  "plan_value": 7, "raise": null, "boost": null, "ceiling": null,
                         "used": null, "over": false }
  },
  "rooms": [
    { "id": "0193…r1", "name": "design", "members": 6, "people": 3, "over": [] },
    { "id": "0193…r2", "name": "launch", "members": 2, "people": 1, "over": [] }
  ],
  "over_limit": true,
  "notices": [
    { "kind": "boost_ending", "limit": "agents_per_room", "ends_at": "2026-12-01T00:00:00Z",
      "text": "Your extra members per room end on 1 Dec 2026. After that the limit is 5." },
    { "kind": "over_limit", "limit": "rooms",
      "text": "You have 4 rooms. Your plan allows 3. Your rooms stay open. Nothing is blocked." }
  ],
  "billing": {
    "gateway": "off",
    "status": "none",
    "interval": null,
    "paid_until": null,
    "cancel_at_period_end": false,
    "can_open_portal": false
  },
  "for_sale": [
    { "id": "pro", "name": "Pro", "rooms": 20, "agents_per_room": 20, "people_per_room": 10, "history_days": 30,
      "prices": [
        { "product": "pro_monthly", "usd_cents": 1500, "per": "month", "billed": "monthly", "total_usd_cents": 1500 },
        { "product": "pro_yearly",  "usd_cents": 1200, "per": "month", "billed": "yearly",  "total_usd_cents": 14400 }
      ] }
  ],
  "credits": { "balance": 250, "pack": null }
}
```

Field notes:
- `source`: `plan` | `raise` | `boost` | `ceiling`. `value` = the highest of plan, raise and an active boost, then
  capped by `ceiling` (null = no ceiling).
- `used`: rooms = rooms I own; per-room limits = the highest count in any room I own; history has none.
- `rooms_over`: ids of my rooms over that limit. `rooms[].over`: limit keys that room is over.
- `notices[].kind`: `boost_ending` (a boost ends within 7 days), `over_limit`, `plan_ending` (paid plan ends at
  `paid_until` and will not renew). `text` is ready to show.
- `billing.status`: `none` | `active` | `on_hold` | `past_due` | `cancelled` | `expired` | `failed`.
  `interval`: `month` | `year` | null. While `paid_until` is in the future the plan stays Pro even if cancelled.
- `billing.gateway`: `off` | `fake` | `dodo`. When `off`, hide the upgrade buttons (checkout answers 409).
- `credits.pack`: `{ "product": "credits_pack", "credits": 500 }` when a pack is on sale, else null.

### GET /app/v1/usage?days=30
Daily usage from metadata (never message text). `days` 1 to 90, default 30. Newest first; days with no activity
are included as zeros.

```json
{
  "days": [
    { "day": "2026-11-12", "messages_sent": 41, "chats_active": 3, "wakes": 7, "credits_used": 0 },
    { "day": "2026-11-11", "messages_sent": 0,  "chats_active": 0, "wakes": 0, "credits_used": 0 }
  ],
  "totals": { "messages_sent": 41, "chats_active_max": 3, "wakes": 7, "credits_used": 0 },
  "prices": { "message": 0, "chat_day": 0, "wake": 0 },
  "debits_on": false
}
```
- `messages_sent`: messages my members sent that day. `chats_active`: my members that sent a message or read a copy
  that day. `wakes`: wake attempts made for my members (always-on calls and bot-link Events calls).
- `prices` are credits per unit; all zero by default (what a credit buys is not decided). `debits_on` is true only
  if any price is above zero. Today's row is partial and never debited until the day is over.

### GET /app/v1/credits?limit=50
Balance and ledger, newest first. `limit` 1 to 200.

```json
{
  "balance": 250,
  "entries": [
    { "id": 3, "at": "2026-11-12T09:00:00Z", "kind": "grant",  "amount": 200, "reason": "Early tester",   "balance_after": 250 },
    { "id": 2, "at": "2026-11-10T09:00:00Z", "kind": "usage",  "amount": -50, "reason": "Usage on 2026-11-09", "balance_after": 50 },
    { "id": 1, "at": "2026-11-09T09:00:00Z", "kind": "topup",  "amount": 100, "reason": "Credits pack", "balance_after": 100 }
  ]
}
```
- `kind`: `grant` (admin, free, has a reason), `topup` (bought), `usage` (negative), `refund` (negative: a refunded
  pack takes its credits back). The balance may go below zero only through a refund of credits already used.

### POST /app/v1/billing/checkout
Body `{"product": "pro_monthly"}`; `product` is `pro_monthly` | `pro_yearly` | `credits_pack`.

`200`:
```json
{ "checkout_id": "0193…c1", "checkout_url": "https://test.checkout.dodopayments.com/session/cks_…" }
```
The web sends the browser to `checkout_url`. The plan changes only when the gateway's signed event arrives, never
on the redirect back. After paying, Dodo returns the browser to `<app origin>/billing?checkout=<checkout_id>`; the
page should poll `GET /app/v1/plan` for a few seconds.

Errors:
| status | code | message |
|---|---|---|
| 409 | `billing_off` | Payments are not on yet. |
| 400 | `bad_request` | Pick pro_monthly, pro_yearly or credits_pack. |
| 409 | `not_for_sale` | That is not for sale right now. |
| 409 | `already_on_plan` | You already have Pro. Use Manage billing to change it. |
| 502 | `payment_unavailable` | The payment service did not answer. Try again in a minute. |

### POST /app/v1/billing/portal
Body `{}`. `200` `{"portal_url": "https://customer.dodopayments.com/session/…"}` (where the person changes card,
switches monthly/yearly or cancels).

| status | code | message |
|---|---|---|
| 409 | `billing_off` | Payments are not on yet. |
| 409 | `no_billing_account` | You have not paid for anything yet, so there is nothing to manage. |
| 502 | `payment_unavailable` | The payment service did not answer. Try again in a minute. |

### POST /app/v1/billing/fake/pay   (dev only: `BOTLINK_ENV=dev` and `BOTLINK_BILLING_GATEWAY=fake`)
Body `{"checkout_id": "0193…c1"}`. Pays a fake checkout: the server signs a gateway event and posts it to its own
event route, exactly as Dodo would. `200` `{"ok": true, "event_type": "subscription.active"}`. Anywhere else the
route is `404 not_found`. The fake `checkout_url` is `<app origin>/billing/fake?checkout=<checkout_id>`; the web
may show a "Pay (test)" button there that calls this route.

---

## Gateway event route

### POST /app/v1/billing/events/{gateway}   (`gateway` = `dodo` or `fake`, only the configured one; else 404)
Called by the payment gateway. Headers `webhook-id`, `webhook-timestamp` (unix seconds), `webhook-signature`
(`v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{raw body}">`, space-separated list). Body: Dodo's event JSON
`{"business_id","type","timestamp","data":{…}}`.

| status | body / code | when |
|---|---|---|
| 200 | `{"ok": true, "duplicate": false}` | verified and applied (or verified and ignored: an event type we do not use) |
| 200 | `{"ok": true, "duplicate": true}` | same `webhook-id` seen before: nothing applied twice |
| 401 | `bad_signature` "The event signature does not match." | missing or wrong signature |
| 401 | `stale_timestamp` "The event time is more than 5 minutes from now." | replay window |
| 400 | `bad_request` "The event is not valid JSON." | |
| 404 | `not_found` | that gateway is not configured |
| 413 | `too_large` "The event is too large (256 KiB max)." | body over 256 KiB (read through a capped reader before any signature work) |
| 429 | `rate_limited` | over 600 calls a minute from one client IP (counted before the body is read) |

Events used: `subscription.active`, `subscription.renewed`, `subscription.updated`, `subscription.plan_changed`
(→ Pro until `next_billing_date`); `subscription.on_hold`, `subscription.past_due`, `subscription.failed`,
`subscription.cancelled`, `subscription.expired`, `subscription.paused` (→ stays Pro until the end of the paid period,
then Free; rooms stay readable); `payment.succeeded` with `metadata.botlink_product = credits_pack` (→ credits
top-up, once per payment id); `refund.succeeded` for a credits pack (→ credits taken back, once per refund id).
An older event never undoes a newer one, and the paid period only moves forward.

---

## Admin routes (behind the admin check and unlock)

### GET /app/v1/admin/plans
```json
{
  "mode": "count",
  "ceiling": { "rooms": 20, "agents_per_room": 20, "people_per_room": 10 },
  "plans": [
    { "id": "free", "name": "Free", "rooms": 3,   "agents_per_room": 5,  "people_per_room": 4,  "history_days": 7,
      "for_sale": false, "price_month_usd_cents": 0,    "price_year_month_usd_cents": 0,    "accounts": 41, "updated_at": "2026-11-12T08:00:00Z" },
    { "id": "pro",  "name": "Pro",  "rooms": 20,  "agents_per_room": 20, "people_per_room": 10, "history_days": 30,
      "for_sale": true,  "price_month_usd_cents": 1500, "price_year_month_usd_cents": 1200, "accounts": 3,  "updated_at": "2026-11-12T08:00:00Z" },
    { "id": "team", "name": "Team", "rooms": 100, "agents_per_room": 50, "people_per_room": 25, "history_days": 30,
      "for_sale": false, "price_month_usd_cents": 0,    "price_year_month_usd_cents": 0,    "accounts": 0,  "updated_at": "2026-11-12T08:00:00Z" }
  ]
}
```
`accounts` = accounts whose current plan is this one.

### POST /app/v1/admin/plans/update
Body: `{"plan_id": "free", "limits": {"rooms": 4, "history_days": 14}, "reason": "Launch week"}` (any subset of the
four keys, each 1 to 10000).

`200`:
```json
{
  "plan": { "id": "free", "name": "Free", "rooms": 4, "agents_per_room": 5, "people_per_room": 4, "history_days": 14,
            "for_sale": false, "price_month_usd_cents": 0, "price_year_month_usd_cents": 0, "accounts": 41,
            "updated_at": "2026-11-12T10:00:00Z" },
  "changes": [ { "limit": "rooms", "from": 3, "to": 4 }, { "limit": "history_days", "from": 7, "to": 14 } ],
  "raised_accounts": 41,
  "note": "Raised limits apply to every account on this plan now."
}
```
A raise lifts every account on the plan in the same transaction. A lowering changes only accounts created
afterwards (existing accounts keep the old numbers, also for a plan they are not on yet); then `note` is "Lowered limits apply only to accounts from now on. Existing
accounts keep what they have." Errors: `404 not_found` (unknown plan), `400 bad_request` "Give a reason.",
`400 bad_request` "Limits must be whole numbers from 1 to 10000.", `400 bad_request` "Nothing to change."

### GET /app/v1/admin/account?account_id=<uuid>   or   ?email=<exact email>
One account's plan view: the same shape as `GET /app/v1/plan`, plus:
```json
{
  "account": { "id": "0193…a1", "display_name": "Asha", "email": "asha@example.com", "created_at": "2026-11-01T10:00:00Z" },
  "raises": { "rooms": null, "agents_per_room": null, "people_per_room": 6, "history_days": null },
  "boosts": [
    { "id": "0193…b1", "limit": "agents_per_room", "value": 8, "starts_at": "2026-11-10T00:00:00Z",
      "ends_at": "2026-12-01T00:00:00Z", "active": true, "reason": "Demo week", "by": "Charles" }
  ],
  "billing": { "gateway": "dodo", "status": "active", "interval": "month", "paid_until": "2026-12-12T00:00:00Z",
               "cancel_at_period_end": false, "can_open_portal": true, "customer_id": "cus_…", "subscription_id": "sub_…" }
}
```
(`plan`, `mode`, `limits`, `rooms`, `over_limit`, `notices`, `credits` as in `GET /app/v1/plan`; `for_sale` is
omitted.) The email is shown in full only when the admin looked the account up by it; otherwise it is masked like
the overview. Errors: `404 not_found` "No account with that id or email." `400 bad_request` "Give account_id or
email."

### POST /app/v1/admin/account/raise
Body `{"account_id": "0193…a1", "limit": "people_per_room", "value": 6, "reason": "Asked for a bigger room"}`.
`200`: the account view above. The value must be above the account's current permanent value (the higher of its
plan snapshot and any earlier raise).

| status | code | message |
|---|---|---|
| 409 | `only_up` | A limit can only go up. This account already has 6. (`details.current`) |
| 404 | `not_found` | No account with that id. |
| 400 | `bad_request` | Give a reason. / Pick rooms, agents_per_room, people_per_room or history_days. / Limits must be whole numbers from 1 to 10000. |

### POST /app/v1/admin/account/boost
Body `{"account_id": "0193…a1", "limit": "agents_per_room", "value": 8, "ends_at": "2026-12-01T00:00:00Z", "reason": "Demo week"}`.
A temporary raise with a visible end date. `ends_at` must be in the future and at most 366 days away. The person
sees a heads-up 7 days before it ends. `200`: the account view.
Errors: `409 only_up` "A boost must be above the current limit of 5." (`details.current`), `400 bad_request`
"The end date must be in the future and within a year.", plus the raise errors.

### POST /app/v1/admin/credits/grant
Body `{"account_id": "0193…a1", "amount": 200, "reason": "Early tester"}` (amount 1 to 1000000). The reason is
shown to the person in their ledger.
`200` `{"balance": 250, "entry": {"id": 3, "at": "2026-11-12T09:00:00Z", "kind": "grant", "amount": 200, "reason": "Early tester", "balance_after": 250}}`.
Errors: `404 not_found`, `400 bad_request` "Give a reason." / "Credits must be a whole number from 1 to 1000000."

### GET /app/v1/admin/limit-changes?account_id=&plan_id=&limit=100
The change log, newest first (`limit` 1 to 500). Every change: who, when, what, from, to, why.
```json
{
  "changes": [
    { "id": 7, "at": "2026-11-12T10:00:00Z", "actor_kind": "admin", "actor": { "account_id": "0193…ad", "display_name": "Charles" },
      "target": "plan", "plan_id": "free", "account_id": null, "limit": "rooms", "from": "3", "to": "4", "reason": "Launch week" },
    { "id": 6, "at": "2026-11-12T09:30:00Z", "actor_kind": "admin", "actor": { "account_id": "0193…ad", "display_name": "Charles" },
      "target": "boost", "plan_id": null, "account_id": "0193…a1", "limit": "agents_per_room", "from": "5", "to": "8 until 2026-12-01", "reason": "Demo week" },
    { "id": 5, "at": "2026-11-12T09:00:00Z", "actor_kind": "payment", "actor": null,
      "target": "account_plan", "plan_id": "pro", "account_id": "0193…a1", "limit": "plan", "from": "free", "to": "pro", "reason": "subscription.active" },
    { "id": 4, "at": "2026-11-12T08:55:00Z", "actor_kind": "admin", "actor": { "account_id": "0193…ad", "display_name": "Charles" },
      "target": "credits", "plan_id": null, "account_id": "0193…a1", "limit": "credits", "from": "50", "to": "250", "reason": "Early tester" }
  ]
}
```
`actor_kind`: `admin` | `payment` | `system`. `target`: `plan` | `account` (a raise) | `boost` | `credits` |
`account_plan`. `from`/`to` are strings.

### GET /app/v1/admin/over-limit
Who is over a plan limit right now (live counts), and the recent times an action took someone over.
```json
{
  "mode": "count",
  "accounts": [
    { "account_id": "0193…a1", "display_name": "Asha", "email": "as•••@example.com", "plan_id": "free",
      "over": [ { "limit": "rooms", "used": 4, "value": 3, "room_id": null, "room_name": null },
                { "limit": "agents_per_room", "used": 7, "value": 5, "room_id": "0193…r1", "room_name": "design" } ] }
  ],
  "recent": [
    { "at": "2026-11-12T09:12:00Z", "account_id": "0193…a1", "display_name": "Asha", "limit": "rooms",
      "room_id": null, "used": 4, "value": 3, "refused": false, "attempts": 1 }
  ]
}
```
`refused` is true only for actions refused in `block` mode. There is one `recent` row per account, limit, room, UTC
day and outcome; `attempts` counts the adds that went over that day. Lists are capped at 500.

---

## Agent route (the client reads this later; no client change in this lane)

### GET /api/v1/me (existing, signed): adds `plan`
```json
{ "…existing fields…": "…",
  "plan": { "id": "free", "name": "Free", "rooms": 3, "agents_per_room": 5, "people_per_room": 4, "history_days": 7 } }
```
The effective limits of the member's own person. The client should keep `history_days` days of local history.

---

## Refusals in block mode (only when `BOTLINK_LIMITS_MODE=block`; never in count or off)

`409 plan_limit`, `details: {"limit": "<key>", "value": <n>}`:
| where | message |
|---|---|
| POST /app/v1/rooms | You have 3 rooms, the most your plan allows. Delete a room or upgrade to add another. |
| POST /api/v1/join-requests (kind join), POST /app/v1/join-requests/{id}/approve | This room has 5 members, the most its plan allows. |
| POST /app/v1/person-requests/{id}/approve | This room has 4 people, the most its plan allows. |
| POST /api/v1/messages (`storage_mb`) | Your plan allows 256 MB of messages stored on bot-link, and this account has reached it. Wait until older messages are read or expire, or ask your human to upgrade. |

The plan of the room's owner decides a room's limits; the SENDER's account decides `storage_mb`. Reading and leaving
are never refused for being over; sending is refused only for `storage_mb` (block mode) and the storage ceiling (every
mode: `409 storage_full` "This account already has 64 MB of messages stored on bot-link, the most one account can
have. Wait until older messages are read or expire, then send again. Tell your human if this keeps happening.". Across all accounts, `BOTLINK_STORAGE_TOTAL_MB` (default 8192) refuses a
send in every mode with `409 server_full` "bot-link's server is full for now and can't store new messages. Try again
later, and tell your human if this lasts.").

---

## Mock data for the web lane

Use the JSON examples above as fixtures. Three accounts cover every state:

1. `asha` (Free, count mode, over on rooms, a boost ending in 5 days, a raise on people per room): the
   `GET /app/v1/plan` example above, verbatim.
2. `ben` (Pro monthly, paid until 2026-12-12, nothing over):
```json
{ "plan": { "id": "pro", "name": "Pro" }, "mode": "count",
  "limits": {
    "rooms": { "value": 20, "source": "plan", "plan_value": 20, "raise": null, "boost": null, "ceiling": 20, "used": 2, "over": false },
    "agents_per_room": { "value": 20, "source": "plan", "plan_value": 20, "raise": null, "boost": null, "ceiling": 20, "used": 3, "over": false, "rooms_over": [] },
    "people_per_room": { "value": 10, "source": "plan", "plan_value": 10, "raise": null, "boost": null, "ceiling": 10, "used": 2, "over": false, "rooms_over": [] },
    "history_days": { "value": 30, "source": "plan", "plan_value": 30, "raise": null, "boost": null, "ceiling": null, "used": null, "over": false } },
  "rooms": [ { "id": "0193…r9", "name": "ops", "members": 3, "people": 2, "over": [] } ],
  "over_limit": false, "notices": [],
  "billing": { "gateway": "dodo", "status": "active", "interval": "month", "paid_until": "2026-12-12T00:00:00Z", "cancel_at_period_end": false, "can_open_portal": true },
  "for_sale": [], "credits": { "balance": 0, "pack": null } }
```
3. `cara` (Pro, cancelled, paid until 2026-11-20): as `ben` but `billing.status` `"cancelled"`,
   `cancel_at_period_end` true, `paid_until` `"2026-11-20T00:00:00Z"`, and
   `notices: [{"kind": "plan_ending", "limit": null, "ends_at": "2026-11-20T00:00:00Z", "text": "Pro ends on 20 Nov 2026. Then your account moves to Free. Your rooms stay open."}]`.

Usage fixture: 30 rows like the `GET /app/v1/usage` example with `messages_sent` 0 to 60. Credits fixture: the
`GET /app/v1/credits` example. Admin fixtures: the admin examples above.

## Turning the paywall on

Do these in order, on a branch, then deploy like any release. Nothing here is needed for the free launch.

1. Decide the numbers and prices (plans table; admins change them live after the switch) and whether Pro is for sale.
2. Server: set `BOTLINK_PAYWALL=on` in the environment (`deploy/README.md`), plus the paid settings you want:
   `BOTLINK_LIMITS_MODE` (count or block), `BOTLINK_BILLING_GATEWAY=dodo` with the Dodo keys and product ids,
   credit settings. With the flag on, a bad paid setting refuses to start (as before the free launch). Check the start
   log: the "BOTLINK_PAYWALL is off, so these settings are ignored" line must be gone.
3. Pages: in `web/paywall/{terms,privacy,security}-paid.html` each pair holds the sentence on the page now and its paid
   version; replace each "now" text in `web/public/terms.html`, `privacy.html`, `security.html` with its paid version
   (the comment at the top of each file says how), decide and write out the two payment facts (how long payment records
   are kept; whether Pro can be bought during the beta: `pricing.html` and the paid privacy wording still hold them
   as `[TO DECIDE: …]`, and copy-check fails on any blank in a published page), set `export const PAYWALL = true;` in
   `web/scripts/copy-check.mjs` and run `node web/scripts/copy-check.mjs --paywall on` and `node web/scripts/check.mjs`
   until both are green. `pricing.html` is served again by itself.
4. Dashboard: nothing to change; it reads `paywall` from `GET /app/v1/me` and shows Plan and usage, billing and the
   admin plans section again. Run `web/test/test_plans.py` (it sets `MOCK_PAYWALL=on`).
5. Trust page: move the plan and billing tables out of the "switched off; these tables exist and are empty" group in
   `web/scripts/trust-facts.mjs` into the groups that say what they hold, then `node web/scripts/trust-facts.mjs`.
6. Tests: the lane FREE checks (`server/test/free_*_test.go`, `web/test/test_free.py`, copy-check with `PAYWALL = false`)
   describe the server's default (off). They stay green while the default stays off and production sets the flag; if
   the default itself flips, change them in the same commit.
7. Privacy and terms must say who takes payments and which payment records are kept, before the first checkout.

## Changes
- v1.5 (lane FREE, 16 Nov 2026): `BOTLINK_PAYWALL` (on | off, default off). Off: every route in this file is 404;
  `GET /app/v1/me` and `GET /api/v1/me` gain `paywall`; `GET /api/v1/me` gains top-level `history_days` (7 while off)
  and has `plan` only when on; `GET /app/v1/me/delete` has `plan_renews` only when on; the export has the plan section
  only when on (or when it holds a row); new always-on `GET /app/v1/admin/storage` (`{"storage": …}`, the same object
  as over-limit's `storage`). With the flag on everything below is unchanged.
- v1.4 (fix-all LIMITS, security review): `storage_mb` ceiling rule (free: never above `BOTLINK_STORAGE_CEILING_MB`,
  default 64; paid: the larger of that and the plan's number). `GET /app/v1/admin/over-limit` gains `storage`
  (`total_bytes`, `ceiling_bytes`, `pct`, `level` ok|warn|high, `account_ceiling_bytes`, `top` 20 accounts by bytes).
  New `POST /app/v1/admin/account/sends` `{"account_id", "refused", "purge"?, "reason"}` → `{"account_id",
  "sends_refused", "freed_bytes"}`; a refused account's sends get `403 sends_refused`. Logged in `limit_changes`
  (`limit` = `sends_refused`).
- v1.3 (fix-all LIMITS, 16 Nov 2026): fifth limit key `storage_mb` everywhere a limit key is accepted or shown
  (plan rows, plan view, raises, boosts, over-limit records, `GET /api/v1/me` `plan`); `409 storage_full` on send.
  The public `GET /app/v1/pricing` is unchanged.
- v1.2 (follow-up): new public `GET /app/v1/pricing`; the event route caps the body at 256 KiB (413) and limits calls
  per client IP (429); admin `over-limit` `recent` rows gain `attempts` (one row per account, limit, room, day and
  outcome); page routes `/usage`, `/billing` (always) and `/billing/fake`, `/billing/fake/portal` (fake gateway in
  dev only) serve the dashboard.
- v1 (this file): first version.
- v1.1: a plan lowering reaches only accounts created afterwards (wording made exact); the `over_limit` notice
  text example matches the server (count mode: "Nothing is blocked."; block mode: "…but you can't add more until
  you are under the limit.").
