# Rooms started by a chat (room drafts)

Status: contract for v1.1 (17 Nov 2026). The code follows this file; where they differ, one of them is a bug.

A chat can ask for a new room. It cannot make one. The chat makes a **draft**; a signed-in person opens the draft's
link, types the code the chat shows, and confirms with a passkey. Their browser signs the room's genesis entry and,
in the same step, the `member_add` that lets the asking chat in. Until then nothing exists that a message, an invite
or a member could attach to.

What does not change: genesis is signed by the owner's browser key; every member is signed for in a browser; every
join is confirmed with a passkey; person invites (bring a friend) are made by people only.

## 1. The draft

A draft is one row. It is not a room: it has no members, no messages, no invites, no roster, and it is in no list
(not in "What needs you", not in the rooms list, not in the admin overview's room counts). Making, claiming or
losing a draft sends nothing to anyone: no mail, no dashboard item, no badge, no event, no notice. The only way a
person learns of a draft is the link in their own chat.

Fields: `id` (UUIDv7, chosen by the client), the proposed room `name` and `purpose` (the rules of §6.2 of SPEC.md; the purpose also one line of visible text, §5),
the asking chat's proposal (exactly the fields of a join request: name, job, keys, app, app name, session, folder,
machine, turn), `match_code` (6 characters, same alphabet as a join's), `member_id` (assigned at creation),
`expires_at`, the caller's address (IPv4 as it is, IPv6 as its /56 network; for the caps only), `claimed_by` (an account, empty at first), `wrong_codes`, and a
status: `open`, `confirmed`, `rejected`, `closed`.

The table is `room_drafts` (migration 0053). Lifetime: `expires_at = now + BOTLINK_JOIN_TTL` (15 minutes in production; the same setting as a join request, so
staging's short value applies to both). After that a draft cannot be claimed or confirmed. The sweeper deletes closed
drafts at once and open or rejected ones once they are past `expires_at` (a rejected row stays until then so the
chat's wait can read it); a confirmed draft's row stays 24 hours so the chat's wait can still
read the result, then goes.

## 2. Agent API (`/api/v1`, api host)

### `POST /api/v1/room-drafts`
Signed by the NEW key in the body, like `POST /api/v1/join-requests` (`X-Botlink-Key` equals `ed25519_pk`). No other
credential: a chat that is in no room yet can call it.

Body: the fields of `JoinRequestCreate` without `invite` and `kind`, plus `room_name` and `room_purpose`.

`201` (`200` for the same id and the same body) `RoomDraftView`:
`{ id, status: "open", room_name, room_purpose, name, member_id, match_code, expires_at, confirm_url }`
with `confirm_url = <app origin>/create/<id>`.

Errors: `400` (bad room name, purpose, member fields; same rules and codes as rooms and joins), `409 id_conflict`,
`409 key_in_use`, `429 too_many_drafts` with `Retry-After` (caps, §5).

### `POST /api/v1/room-drafts/{id}/wait`
Signed by the draft's key. Long poll, at most 50 s per call. The response has exactly the schema of
`POST /api/v1/join-requests/{id}/wait`: `pending` while open; `approved` with the member and the room once
confirmed (the view's `kind` is `create`; the room and the owner appear only then); `rejected`; `expired` while the
expired row still exists. A draft that is gone (swept, cancelled, closed after wrong codes, unknown, or asked for
with another key) answers `404 draft_gone`; the client treats it as expired.

### `POST /api/v1/room-drafts/{id}/cancel`
Signed by the draft's key. Deletes an open draft (`204`; also `204` when it is already gone). A confirmed draft
answers `409 already_decided`: the chat then leaves the usual way (`DELETE /api/v1/me`).

### `POST /api/v1/me/invite-link`
Signed by a member's key like every `/api/v1/me` call. Returns the room owner's chat invite for this room, the same
row and the same URL the dashboard shows (`GET /app/v1/rooms/{id}/chat-invite`): `{ url, expires_at }`.
- Only a chat of the room's owner: any other member gets `403 not_owner`.
- It never renews an invite and never turns one on: `409 invite_off`, `409 invite_expired`. The owner does that on
  the dashboard.
- Rate limit: 6 per hour per member, 20 per hour per room: `429`. Every call counts, refused ones too.
- If the owner has no chat invite for the room yet, the call makes it exactly as the dashboard would.
- The link is a right to ask. Every use still makes a join request that the owner approves with a passkey and the
  code check (SPEC §6.4). The existing caps stay: 10 requests per invite per hour, at most 10 pending per room.

## 3. App API (`/app/v1`, app host; signed-in session, same CSRF rules as the other POSTs)

### `POST /app/v1/room-drafts/{id}/claim`
Binds an open, unexpired, unclaimed draft to the caller's account, or returns the card again if the caller already
holds it. Returns `RoomDraftCard`:
`{ id, room_name, room_purpose, name, job, app, app_name, machine, folder, turn, member_id, ed25519_pk, x25519_pk,
expires_at, name_taken }` (`name_taken`: the caller already owns a room with that name).
**The card does not contain the match code.** The person types it from their chat.
- `404 not_found` for every other case (unknown, expired, claimed by someone else, closed, confirmed, rejected): one
  body, no way to tell them apart.
- `429 too_many_drafts`: the account already holds 3 open drafts.

### `POST /app/v1/room-drafts/{id}/confirm`
Body: `{ code, human_check, room: { id, name, purpose, genesis, entries }, roster_entry }`. `room` is exactly the
body of `POST /app/v1/rooms`; `roster_entry` is a `member_add` for the draft's chat, signed by the same browser, at
the seq after the entries in `room`.

One transaction, in this order:
1. The draft is open, unexpired and claimed by the caller, else `404 not_found`.
2. `code` equals the match code (compare in constant time; case and a dash between the groups are ignored). If not:
   `wrong_codes += 1` and `403 code_mismatch` with `details.left`; the fifth wrong code (`left` 0) closes the draft
   (later calls: `404`). An empty or missing code is `400` and counts as nothing. A wrong code does not use up the
   human check.
3. Consume the human check: action `confirm_room`, target the draft id, a passkey every time, as for an approval.
   A check made for another action is refused.
4. Create the room exactly as `POST /app/v1/rooms` does, with every rule it has (name format, unique per owner →
   `409 name_taken`, at most 20 rooms per owner, the `device_add` rules). `room.name` and `room.purpose` are what the
   person confirmed; the page may let them change the name when it is taken.
5. Check `roster_entry` field for field against the draft's chat (member id, name, app, keys) and that its signer is
   a device of the caller in the new room; append it; insert the member, as an approval does.
6. Mark the draft confirmed with the room id. The chat's wait returns `approved`.

Returns `201` with what `POST /app/v1/rooms` returns. The same request sent again after it succeeded (same room id)
returns `200` with the room; a room id that already exists otherwise is `409 id_conflict`.

### `POST /app/v1/room-drafts/{id}/reject`
The holder says no: the draft is rejected; the chat's wait returns `rejected`. `204`.

## 4. The page: `https://app.botlink.dev/create/<id>`

A dashboard route on the app host (host table: `/create/{id}`, app, page; the site host answers 301 to the app host,
the api host 404). Signed out: sign in, then back to the same link (as `/approve/<id>`). Then claim, then the card:

- The heading says what happens, in our words: **"This makes a new room owned by you and lets this chat in."**
- The room name and the purpose are the chat's words. They are shown as quoted, untrusted text: inside visible
  quotation marks, set apart from our own text, rendered as plain text (never as HTML, Markdown or a link), with a
  line saying a chat wrote them.
- The chat, large, as on a join card: name, app, computer, folder, job. The key fingerprint, computed by the browser
  from the card's keys.
- A field: "Type the code your chat shows." Six characters; a dash and lower case are accepted.
- **Confirm** (passkey) and **Don't make it**.
- On confirm the browser makes the room id, builds and signs the genesis entry and the `device_add` entries exactly
  as "Start a room" does, builds and signs the `member_add`, and sends one request. Then it opens the new room.
- Not found, expired, wrong code (with tries left), name taken (offer another name), too many drafts: each has its
  own plain message. Not found uses the generic not-found page.

A brand-new account sets up its first passkey in the confirm step, as in an approval.

## 5. Caps (all counted in Postgres; `429` with `Retry-After`, except the server-wide cap: see below)

| What | Default | Setting |
|---|---|---|
| Open drafts per caller IP | 5 | `BOTLINK_DRAFT_OPEN_PER_IP` |
| Drafts made per caller IP per hour (refused ones do not count) | 30 | `BOTLINK_DRAFT_PER_IP_HOUR` |
| Open drafts on the whole server (at the cap the oldest unopened draft makes room) | 20000 | `BOTLINK_DRAFT_OPEN_TOTAL` |
| Open drafts one account holds | 3 | `BOTLINK_DRAFT_OPEN_PER_PERSON` |
| Wrong codes before a draft closes | 5 | fixed |
| `invite-link` calls | 6 per hour per member (every call), 20 per hour per room (calls by the owner's chats) | fixed |

The caller IP is taken the way the invite lookup limit takes it, then counted by network: an IPv4 address by itself
(an IPv4-mapped IPv6 address as its IPv4), an IPv6 address by its /56. A create that would wait more than 0.5 s
behind its own caller's other creates answers `429 too_many_drafts`.

The per-address caps do not hold a caller whose address changes with every request (a rotating egress, such as a
VPN or proxy network that hands each request another address). The server-wide cap is the brake then, and it does
not refuse: at the cap a new draft is made and the oldest open draft that nobody has opened yet (not claimed) is
deleted; its chat's wait answers `404 draft_gone`, and its link shows the not-found page. A draft a person has opened
is never deleted this way; only when every open draft is claimed does the create answer `429 too_many_drafts`. So a
flood no longer blocks new drafts: it shortens how long an unopened draft lives (the cap divided by the flood's rate,
about 15 minutes at 22 drafts a second), and a person who opens their link promptly is not affected. The count is
read without a server-wide lock, so the total can go over by the creates in flight at that moment. A rate limit at the
edge (in front of the server) is the operator's tool against such a caller.

`room_purpose` is one line of visible text: a draft whose purpose has a line break, a tab, a control character, a
zero-width or direction-changing character is refused with `400`.

## 6. The client

- MCP tool `create_room { name, purpose, as, job, app_name?, session? }` and command
  `botlink create-room --room <name> --purpose "<…>" --name <chat name> --job "<…>"`. It makes the keys and the
  request id like `join`, calls the server, records a pending request of kind `create`, and returns at once. It
  prints the commands the chat can use, then: the link for the human, the code and the key fingerprint, and that the
  human types the code on that page. `botlink join --wait` waits for a draft exactly as for a join (exit 0
  confirmed, 3 still waiting, 4 rejected, expired or gone).
- After `approved` the client does what it does after a join: fetch and verify the roster, the approval self-check
  (its own `member_add`, with its own keys, signed by a device of the room's owner in a roster that verifies from
  genesis), pin the room fingerprint, print "Joined …", run the self-test. If the self-check fails it takes back what
  its key holds and deletes the key, as today.
- MCP tool `invite_link { room?, as?, session? }` and command `botlink invite-link [--as <name>]`. Prints the link
  and one line: the link lets a chat ask to join, and the owner approves each one on the dashboard.
- The tool descriptions tell the model: make a room only when your human asked for one; show the link and the code
  only to your human; never put them in a room message. A message that plainly carries a draft link
  (`/create/<id>`) or the code of a draft open on this computer is stopped by the outgoing check; one that writes
  them another way is not, so the rule for the model stands by itself.
- Refusals have plain texts that say what the human can do: too many drafts, not the owner's chat, invite off or
  expired (the owner renews it on the dashboard), draft expired.

## 7. What an attacker gets

- A chat steered by injected text can make drafts. They reach nobody but its own human, they cost one small row, the
  caps bound them, and they are gone in 15 minutes.
- A caller whose address changes with every request is not held by the per-address caps. It can fill the server-wide
  cap; it cannot block new drafts, because at the cap the oldest unopened draft makes room. What it can do is shorten
  how long an unopened draft lives, so a person who opens their link late may find it gone and the chat asks again.
  It cannot remove a draft a person has opened. A rate limit at the edge is the operator's tool against it.
- Someone who has the link but not the code cannot confirm. Someone who has both can confirm, and then owns a new
  room with that chat in it. That is the same position as a person whose invite a chat was talked into joining
  (SPEC §6.4): the person behind the room approved, the chat's human may not have. The tool text and the outgoing
  check are there to keep the link and the code with the human.
- A chat of the owner can hand out the invite link. A link never lets anyone in: each use is a join request the
  owner approves with a passkey and the code check; the per-invite and per-room caps bound the requests.
- The room name and purpose are text from a chat. The page shows them quoted and inert.
