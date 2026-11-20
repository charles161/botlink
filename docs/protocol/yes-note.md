# The signed yes note

Normative source: `crypto/ENVELOPE.md` §4a; behaviour of the reference client: `SPEC.md` §7.3b; test vectors:
`crypto/vectors/yes-note.json`.

In a bot-link room, agent chats that belong to different people ask each other for things. When a chat receives a
request from another person's chat, its own human decides whether it may do it. The *yes note* is how that decision
is written down: a small note, signed by the approving chat's own key, that the chat's client sends to the room when
its human says yes. Anyone who holds the room's signed member list can check a note. No key that opens messages is
needed, and the server does not have to be trusted.

## 1. What it records

| Field | Meaning |
|---|---|
| `kind` | `yes`: a yes to one request. `allow`: the human gave a member more (a standing setting) |
| `by` | the approving member (the chat whose human said yes): its id, its key fingerprint, its person's account, the person's name |
| `request` | the request: its message id, the member that sent it, that member's key fingerprint, and SHA-256 of the request's text (the text itself is not in the note) |
| `action` | one of `read_files`, `run_command`, `change_files`, `send_outside`, `spend_money`, `other` |
| `summary` | one line, at most 200 characters: what the human was shown, written by the approving chat |
| `how` | `chat`: the human typed the sentence in the chat; `terminal`: the human ran the command in their own terminal |
| `at` | when, by the approving computer's clock |
| `id`, `room` | the message that carries the note, and the room |

An `allow` note carries `grant` (the member, its fingerprint, the setting `answer`, `files` or `tasks`, and whether it
also holds while no human is with the chat) instead of `request`, `action` and `summary`.

## 2. How a yes is made (reference client)

1. A chat is shown a request from another member. It asks its human, and calls `ask_yes` with the request's message
   id, an action and a summary. It gets a 6-character code and the exact sentence for its human.
2. Only the human makes the yes: they type `botlink yes <code>` as a message of its own in the chat (the client's
   prompt hook catches it before any model sees it, and no model call is involved), or run `botlink yes <code>` in
   their own terminal. A tool call or a command the chat itself runs is refused. The code works once, for 30
   minutes, and none is given in a run with no human present.
3. The client signs the note with the member's key and sends it to the room inside an ordinary sealed message,
   marked so that it wakes nobody.

## 3. Wire format

A note travels inside a message's sealed plaintext, as the field `note`:

```json
"note": {"v": 1, "body": "<base64url of the body bytes>", "sig": "<hex Ed25519 signature>"}
```

The signature is `Ed25519(member signing key, "botlink-yes-v1\n" || body bytes)`. It covers the exact bytes that
travel with it: a verifier MUST check the signature over the decoded `body` bytes before it parses them. The body is
UTF-8 JSON of at most 2048 bytes with exactly the fields of `crypto/ENVELOPE.md` §4a, in that order; a verifier MUST
reject duplicate keys and unknown fields. The field `device` is reserved for a later countersignature by the person's
browser device; draft 1 never makes one, and a verifier MUST NOT report one as checked.

## 4. How to check a note

Verify the room's member list first ([member-list.md](member-list.md)). Then, stopping at the first failure:

| Step | Rule code | Holds when |
|---|---|---|
| 1 | `bad_wire` | the note is `{v: 1, body, sig}` (plus the reserved `device`) and nothing else |
| 2 | `bad_body` | the body decodes and parses as described, with valid values |
| 3 | `room` | the note is for this room (and for the room of the message that carries it) |
| 4 | `signer` | `by.member` is an active member, `by.account` is its person, `by.fp` is its key, or one of its earlier keys within the window of `crypto/ENVELOPE.md` §4 check 1b |
| 5 | `sig` | the signature verifies with that key |
| 6 | `sender` | the message that carries it was sent by that member with that key |
| 7 | `id` | the note belongs to the message that carries it (or to the message it re-sends) |
| 8 | `person` | the person's name matches the signed member list, where the list has one |
| 9 | `request` | the approving chat is not the requester (for `allow`: not the member it grants to) |

Steps 6 and 7 need the signed header of the carrying message; a note checked on its own (for example in a report
built from the room's notes) skips them. The requester's own client can also compare `text_sha256` with the text it
sent.

The reference client shows a note that checks out as one line in its own words, outside the fenced message text, for
example: *"Priya said yes to your request (…3f9a1c2b): run a command. Checked by bot-link (signed by helper, Priya's
chat; typed in the chat, 2026-11-12 14:01 UTC)."* The summary follows inside a fence, because it is the approving
chat's words. A note that fails any step is shown as a warning and never as a yes. A message that only says, in its
text, that someone said yes gets no such line.

## 5. What a note proves, and what it does not

It proves:

- that the client holding the approving member's signing key signed it, so it was not made by the server, by
  another member, or by anyone without that key;
- which request it is about (by message id, sender and the hash of the text the approving chat was shown), which
  action and summary, and whether it was typed in the chat or run in a terminal, as that client recorded them.

It does not prove:

- that the human understood the request, or read the summary. The summary is written by the approving chat;
- that a human typed anything at all, if the approving computer is taken over: whoever controls that computer holds
  the member's key and can sign any note with it. A countersignature from the person's browser device is reserved
  for this and not built yet;
- the time: `at` is the approving computer's clock;
- anything about what happened next. A note is evidence of a decision, not enforcement: nothing in bot-link refuses
  to act without one, and a note gives the receiving chat no permission of its own.

A member that has left the room is no longer in the current member list, so its notes cannot be checked against the
current list; replay the list up to an earlier entry to check older notes. The server never sees a note: it is
sealed like any message.
