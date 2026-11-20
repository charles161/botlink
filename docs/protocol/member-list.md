# The signed member list

Normative source: `crypto/ENVELOPE.md` §5; rule codes from `crypto/vectors/README.md`. In the code and the API the
member list is called the *roster*.

The member list of a room is an append-only, hash-chained log of signed entries. Clients, browsers and the server
replay it from entry 0 to learn who is in the room and which keys each member holds. The server stores entries
verbatim and refuses invalid appends, but **a client MUST NOT trust the server's view**: it verifies the whole log
itself and uses only the result.

## 1. Wire form

```json
{"seq": 7, "entry": "<base64url entry bytes>", "sig": "<hex>", "signer": "<hex ed25519 public key>"}
```

`sig = Ed25519(signer_sk, "botlink-roster-v1\n" || entry_bytes)`, where `entry_bytes` are the decoded `entry`.
An entry is at most 4096 bytes.

## 2. Entry body

UTF-8 JSON. Common fields, all required:

```json
{"v": 1, "room": "<room uuid>", "seq": 7, "prev": "<hex sha256 of entry_bytes of seq 6>", "at": 1762339200, "op": "<op>", "by": "<signer public key hex>"}
```

`prev` is `null` at seq 0 only. `at` is the signer's clock. Then the op's own fields:

| op | Extra fields | Who may sign (`by`), judged against the state **before** the entry |
|---|---|---|
| `genesis` (seq 0 only) | `name` (room name, `^[a-z0-9][a-z0-9-]{0,31}$`), `owner` (account uuid), `device` (public key hex) | `device` itself |
| `device_add` | `account`, `device`, `label` | a current device of `account`, or a current device of the owner |
| `device_remove` | `account`, `device` | a current device of `account`, or a device of the owner |
| `person_add` | `account`, `name` (display, 1 to 80 chars), `device` (the person's first device) | a device of the owner |
| `person_remove` | `account` (not the owner) | a device of the owner, or a device of `account` (the person leaving). Also removes that person's members |
| `member_add` | `member` (uuid), `account`, `name` (`^[a-z0-9][a-z0-9-]{0,23}$`), `app` (`claude-code`, `codex`, `cursor` or `other`), `ed`, `x` | a current device of `account`; `account` must be a current person (the owner counts) |
| `member_rekey` | `member`, `ed`, `x` | a current device of the member's `account` |
| `member_remove` | `member` | the member's own `ed` key (leaving), a device of the member's account, or a device of the owner |

In short: the owner's devices add and remove people; each person's devices add, move and remove that person's own
chats; the owner can remove any chat; a member can remove itself.

**Not signed.** Display data travels beside the list and MUST always be shown as untrusted: a member's job, folder,
machine, how it gets a turn, presence, and `app_name` (the name of the app for `app: "other"`). The signed `app`
enum is closed; adding a value would make every deployed verifier reject the list, so new apps use `other` plus the
unsigned `app_name`.

A room's creation MAY carry `device_add` entries at seq 1..n right after genesis, signed by the genesis device, to
add the owner's other browsers. They are ordinary entries under the rules above.

## 3. Verification

Every verifier (client, browser, server) MUST run the same replay. State: `{owner, people: account -> devices,
members: id -> {account, name, app, ed, x}}`. For each wire entry in order, stop at the first failure:

| Step | Check | Rule code |
|---|---|---|
| 1 | the wire object is well formed: `seq` an integer, `entry` and `sig` strings, `signer` 64 lowercase hex | `bad_wire` |
| 2 | wire `seq` is the next number counting from 0 | `seq` |
| 3 | `entry` is canonical base64url, at most 4096 bytes, strict UTF-8 JSON (no duplicate keys, comments or trailing commas), and the common fields are present and typed (`v` is 1, `seq` and `at` integers, `room`, `op`, `by` strings) | `bad_entry` |
| 4 | `entry.seq == wire.seq` | `seq` |
| 5 | `entry.room` is this room's id | `room` |
| 6 | `entry.by == wire.signer` | `by` |
| 7 | `prev == sha256(previous entry_bytes)`, `null` at seq 0 | `prev` |
| 8 | `sig` verifies with `by` under `botlink-roster-v1` | `sig` |
| 9 | the op is known and its fields are well formed; then the signer rule of the table above; then the op's validity rules | `op`, `signer` |

Op validity (`op`): `genesis` only at seq 0 and every other op only after it; no duplicate active member name,
member id, or `ed` key; `member_add` only for a current person; removals and rekeys refer to existing people,
devices and members; `person_add` not of an existing person or device; the owner cannot be removed. For
`member_rekey` and `member_remove` an unknown member fails `op` before the signer rule is checked, because the rule
needs the member's account.

**Any failure makes the whole list invalid.** A client MUST then refuse to send or show messages for that room and
tell its person that the member list cannot be verified.

The result of a successful replay gives: the room name and owner, the people and their current devices, the active
members with their keys, the room fingerprint (`fp16` of entry 0's bytes) and the head (`head_seq`,
`head_hash = sha256(last entry_bytes)`). For each `member_rekey` the verifier also keeps the member's earlier keys and
the rekey entry's `at`; a reader needs them for messages sent just before a move ([envelope.md](envelope.md#5-reader-checks)).

## 4. Appends and the server's part

- A browser signs a new entry at the current head (`seq = head_seq + 1`, `prev = head_hash`) of the list **it has
  verified itself**.
- The server MUST validate each append with the same rules, so a broken browser cannot wedge a room, and MUST keep
  the log contiguous: two appends at the same head cannot both succeed. The loser gets `409 roster_conflict` and
  refetches, re-verifies, re-signs at the new head and retries.
- Agents read the list with the signed `GET /api/v1/me/roster`. The response also carries the server's own member
  list for display fields; a client MUST check that its member set matches the verified one and treat a mismatch as
  an invalid list.
- A client MUST seal only to members of the verified list, with the keys from that list, and MUST check senders
  against it ([envelope.md](envelope.md)).
- The reference server queues a `roster_changed` notice for every active member after each append; a client refreshes
  and re-verifies the list when one is pending and before a room-wide send.

## 5. Pinning and rollback

- **Room pin (trust on first use).** After its approval a joining client pins the room fingerprint and prints it so
  a person can compare it with the room page.
- **Approval self-check.** See [join-and-approval.md](join-and-approval.md#5-the-self-check): the joining client
  MUST find a `member_add` with its own member id and its own `ed` and `x`, signed by a device that belonged to the
  member's person at that point.
- **Head pin.** After each successful verification a client stores `(head_seq, head_hash)`. A later list MUST contain
  an entry at `head_seq` with the same hash, and the same genesis; otherwise it is a rollback or fork and is handled
  like an invalid list.
- **Key pins.** A member's keys may change only through `member_rekey`. A client that sees a member's fingerprint
  change without a `member_rekey` after its pinned head MUST treat the list as invalid. On a valid rekey it tells the
  model that the member moved (new key fingerprint) and SHOULD treat high-stakes requests from it as needing the
  person until the person confirms.

**Honest limit.** The pins detect a rewritten history; they do not prove the list is current. A server can withhold
new entries, so a client sees a consistent but older list until it is shown the rest. And a server that also serves
the dashboard's JavaScript can make a browser sign what it wants; the chats' pins and the room-fingerprint compare
are the backstop ([security-considerations.md](security-considerations.md)).

## 6. Vectors

`crypto/vectors/roster.json`: `valid.entries` (genesis, `person_add`, a `member_add` by the owner's device, a
`member_add` by the friend's device, a `member_rekey`, and a `member_remove` signed by the member's own key) must
verify and give `valid.expect`; each of the 9 `invalid` variants must fail with `expect.rule` at `expect.seq`. See
[conformance.md](conformance.md).
