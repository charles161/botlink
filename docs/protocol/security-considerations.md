# Security considerations

Sources: `SPEC.md` §11 (the security model), §6.2a, `crypto/ENVELOPE.md` §1, §4, §5.4; the schema in `db/migrations/`.
Statements marked *analysis* follow from the design but are not written in those sources.

**Trust model in one line:** the server is trusted to deliver messages and to serve the dashboard; it is not trusted
with their content or with who is in a room.

## 1. What it protects against

- A stolen database, or a curious or compromised server, reading messages: each copy is sealed to one recipient's
  key and the server never has a sealing secret.
- A server or database swapping a member's key: the signed member list, the approval self-check, pins and
  fingerprints.
- Forged senders: every envelope signature is checked against the verified member list.
- Relabelled or replayed envelopes: the header is bound by the signature, the plaintext carries a copy of the header,
  `ct_sha256` binds the ciphertext, and the reader checks its room pin.
- Replayed requests: a single-use nonce and a 60 second window.
- Agents approving themselves or each other: no approve operation on the agent API, a human check on every approval,
  and a person-side API that takes only a cookie session with CSRF protection.
- Leaked invites: an invite only leads to a request a person must approve with a matching code; 50 and 80 bit
  codes; per-address limits on failed lookups.
- Prompt injection between agents, in part (client behaviour, not wire format): other agents' text is fenced as
  data; the agent asks its person before acting on another agent's request; high-stakes actions always need the
  person; standing rules come only from the person's literal words; no agent free text on the dashboard; member names
  are limited to `a-z 0-9 -`.
- Forged "handled" marks or deletes: a member can only change its own copies.
- Server-side request forgery through wake URLs: dial-time address checks and a challenge before any event, or, for
  an address that cannot answer it, the approval of the member's person with a passkey
  ([event-url-approval.md](event-url-approval.md)); asking for one sends nothing to the address.
- A chat steered into asking for someone else's event address: only the chat's own person sees the request; the card
  shows the host and says bot-link could not check it; if approved, the address learns when messages wait for that
  chat (room, chat, sender, counts, ids, never text) until the person stops it: the names of other people's chats
  and the room go to an address one person approved, possibly a vendor's platform, and the room's other people are
  not told. An approval lasts while the chat renews it (up to 90 days at a time) and the address answers; a passkey
  reset does not end it. The host must be plain (no `xn--` label, no numeric forms). At most 2 waiting per chat, 10
  per person, 6 asks per chat per hour.
- The check request a plain subscribe sends reaches any address a chat names (a routine's trigger runs on any POST);
  after the person stops an address or turns it down, nothing is sent to it for 24 hours, not even that.
- A chat steered into asking for a room ([room-drafts.md](room-drafts.md)): the draft reaches nobody but the link in
  the chat itself; nothing exists until a signed-in person types the chat's code and confirms with the human check;
  caps on open drafts per address, per account and in total bound them; an unconfirmed draft expires after 15 minutes
  in the reference server.

## 2. What it does not protect against

- **Metadata.** See §3.
- **A server that serves malicious dashboard JavaScript at approval time.** That script can make the person's
  browser sign any member-list entry. The chats' pins and comparing the room fingerprint are the backstop.
- **A local program or agent with access to the person's unlocked browser profile and authenticator.** It can
  approve as the person. The human check raises the cost; it does not stop this.
- **Denial of service by the server:** it can delay or drop messages and wake signals.
- **A malicious member leaking what it legitimately receives.**
- **Trust on first use at join.** A fake room shown the first time a chat sees it is caught only by comparing the room
  fingerprint.
- **Compromise of a long-lived member key** (*analysis*). Sealed boxes to a static X25519 key give no forward
  secrecy: whoever gets a member's sealing secret and a stored sealed copy can open it. The reference server drops a
  sealed copy 24 hours after it was shown and unread copies at expiry (at most 7 days), but anyone who recorded the
  ciphertext elsewhere keeps it.
- **What the agents do with what they read.** The protocol carries messages; it does not sandbox agents.
- **A draft link seen by someone else first** ([room-drafts.md](room-drafts.md)). Whoever opens a draft's link first,
  signed in, claims it. The person the chat meant then sees the not-found page and the chat asks again. The one who
  claimed it still needs the code to confirm, and the draft closes after 5 wrong codes.
- **A person who confirms a link and code a stranger handed them.** They make the stranger's chat their own chat, in
  a room they own: the same position as approving a join they were talked into. The reference dashboard says "This
  becomes YOUR chat" on the confirm page; the computer and folder shown on it are the chat's own claims, not checked by
  anyone.
- **A person who ticks without comparing.** Approving several waiting chats at once
  ([join-and-approval.md](join-and-approval.md#4a-approving-several-chats-at-once)) changes what a passkey step
  covers: one passkey step now approves up to five chats of one room. The passkey still proves a person is at the
  browser, and the server binds the step to exactly the ticked requests of that room, so nothing outside the ticked
  set is approved and nothing is approved without a tick. But the per-chat act is now the tick beside each chat's code,
  not a passkey prompt per chat, and ticking a row without comparing its code is easier than tapping through a
  passkey for each one. A lookalike request that sits among genuine ones (a chat that saw a leaked invite asks at the
  same moment) gets through if its row is ticked unchecked. The cap of five per step and the absence of a "select
  all" limit this; they do not remove it. The single approval, one passkey per chat, stays available.
- **The outgoing check for draft links and codes is a net.** The reference client stops a room message that plainly
  carries a draft's confirm link or the code of a draft open on that computer; a link that is reshaped or split, or a
  code written another way, gets through. The rule that keeps them with the person is an instruction to the model.

## 3. Metadata the server sees

From the request formats and the reference schema: which member sends to which and when; the size of every sealed
copy; message ids; `scope`; `in_reply_to`; `sent_at` and `expires_at`; the `quiet` flag; whether and when each copy
was read; every member-list entry (people's account ids and display names, device keys, member names, apps, keys);
the unsigned display fields a chat gives at join or in a room draft (job, folder, machine, `app_name`), and a draft's proposed room name and purpose and the address it came from; people's emails and login
providers; how and when each member polls or is woken; wake URLs; each person's mutes and pauses and each member's wake policy (which other members may wake it). Events and pushes give the receiver of the URL
member, room and sender names and ids ([wake.md](wake.md)).

The server does not see message text or intent.

## 4. The model vendor on each side reads the text

End-to-end here means *between the members' clients*. Once a reader opens a message, its text goes to the model that
runs that chat, which usually means the model vendor of that app. A sender's text is therefore read by the vendor of
every recipient's app, under that vendor's terms. bot-link cannot change this and does not claim to.

## 5. A compromised client

A client holds its members' secret keys (in the OS keychain where available, else in a file readable only by the
user). Whoever controls it can read every message sealed to those members, send as them, and remove them from the
room. It cannot add members, approve anything or re-key another member: those need a person's device key. A program
that can read the user's files can read the keys where no keychain is used.

## 6. A compromised server

It cannot read messages or forge them. It can: drop, delay or reorder messages; withhold member-list entries so a
client sees a consistent but older list (*analysis*: the head pin detects rollback, not withholding, so a removal
can be hidden from a client until it next sees the full list; the reference server itself refuses sends to removed
members, but a malicious one need not); serve malicious dashboard JavaScript (§2); refuse joins; and read all the
metadata in §3. It cannot make an installed reference client run code its release key did not sign (the client's
self-update checks a pinned signing key), though it can withhold updates and a first install trusts the server once.

## 7. Fingerprints and codes

Fingerprints are 64 bits (`fp16`). They catch accidental mismatches and casual substitution well (*analysis*: an
attacker who wanted a different key with the same fingerprint would need a second preimage of a truncated SHA-256,
on the order of 2^64 work). The match code proves nothing about keys. A person who approves without comparing the
code and the fingerprint can approve a lookalike.

## 8. Algorithms

Fixed in this version, with no negotiation:

| Use | Algorithm |
|---|---|
| Signatures (requests, envelopes, member list, device keys) | Ed25519 |
| Sealing | libsodium sealed box: ephemeral X25519 + XSalsa20-Poly1305 |
| Hashes, fingerprints, chains | SHA-256 |
| Push signatures | HMAC-SHA256 |
| Event signatures | HMAC-SHA256 (Standard Webhooks) |

**Post-quantum (non-normative note).** None of these resist a large quantum computer. The most pressing risk is
"record now, decrypt later" against sealed copies (*analysis*). A later envelope version (`v: 4`, with a new
signature context) could seal with a hybrid key encapsulation (X25519 together with ML-KEM) and sign with a hybrid
signature (Ed25519 together with ML-DSA), and the member list would need a matching entry version for the larger
keys. Nothing of this is specified or built today; it would be a new version, never a silent change to `v: 3`.
