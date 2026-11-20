# Sealed, person-approved messaging for MCP and A2A

> **DRAFT. Not submitted anywhere.** This is a working write-up by the bot-link authors. It has not been filed as an
> MCP SEP, posted to any discussion, or proposed to the A2A project. Nothing in it is endorsed by either project.
> Every external fact below was checked against the cited public page on 2026-11-12; pages change.

| | |
|---|---|
| Draft | 1, 2026-11-12 |
| Proposed MCP extension identifier | `dev.botlink/sealed-rooms` (a third-party, reverse-domain identifier) |
| Proposed A2A extension URI | `https://botlink.dev/ext/sealed-rooms/v1` (placeholder: nothing is served there yet) |
| Depends on | the MCP Events extension (SEP-3415) for wake; the bot-link protocol in this folder for all byte formats |
| Reference implementation | bot-link (this repository); see §8 for what is tested |

## 1. The problem

AI agents increasingly need to talk to *other people's* agents: my coding agent asks your deploy agent whether a
change is live; a contractor's agent hands work to a client's agent. Four things make this different from one
person's agents calling each other's tools:

1. **Different owners.** Neither person gets into the other's machine or sees the other's chat. Only messages cross.
2. **A relay that must not read.** The agents are rarely online at the same moment and rarely reachable directly, so
   something stores and forwards. That relay should be unable to read or forge what passes through it, and unable to
   add a listener.
3. **Membership a person approves.** Who can message whom must be decided by people, not by agents. An agent that
   can admit another agent (or itself) defeats the point. A leaked invite must not be enough.
4. **A provable yes.** When an agent acts on another agent's request, its person's approval should be something a
   third party can check later, not a sentence in a transcript. (bot-link specifies this separately, as a signed
   note inside the sealed message: [yes-note.md](yes-note.md). This draft does not depend on it.)

## 2. What MCP and A2A give today

### MCP

- **Current version.** "The **current** protocol version is **2026-07-28**."
  (https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning.md). The 2026-07-28 changelog makes MCP stateless
  (no `initialize` handshake; protocol version and client capabilities ride in `_meta` on every request), adds
  `subscriptions/listen` in place of `resources/subscribe`, and moves Tasks to an extension
  (https://modelcontextprotocol.io/specification/2026-07-28/changelog.md).
- **Extensions (SEP-2133, Final).** "Extensions are identified using a unique *extension identifier* with the
  format: `{vendor-prefix}/{extension-name}`". Third parties "use a reversed domain name you own as the vendor
  prefix". Support is advertised "in the `extensions` field within their respective capability declarations", and
  "Extensions are always disabled by default and require explicit opt-in from the developer, at every stage."
  (https://modelcontextprotocol.io/extensions/overview,
  https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2133-extensions.md). Unofficial
  extensions "may be introduced and governed by developers outside the MCP organization" (SEP-2133). The overview
  page and SEP-2133 differ on whether a breaking change keeps the identifier; this draft uses a new identifier for a
  breaking change, which satisfies both.
- **Events (SEP-3415).** An Extensions Track SEP, identifier `io.modelcontextprotocol/events`, with `events/list`,
  `events/poll`, `events/stream`, `events/subscribe`, `events/unsubscribe`. Its webhook mode signs each POST the
  Standard Webhooks way (`webhook-id`, `webhook-timestamp`, `webhook-signature`, plus `X-MCP-Subscription-Id`), with a
  client-supplied `whsec_` secret. On 2026-11-12 the pull request is **open and not merged**, labelled `accepted`; its
  text says "Status: Accepted" and its error codes are provisional
  (https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415). Its own security note: "Nothing in the
  verification path depends on end-to-end TLS, because the HMAC covers the raw body and timestamp."
- **Server-initiated notifications in core.** `subscriptions/listen` "opens a long-lived notification stream from the
  server to the client" (https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md);
  a client that is not connected receives nothing, which is the gap SEP-3415 fills.
- **Tasks (SEP-2663).** Now the extension `io.modelcontextprotocol/tasks` (`tasks/get`, `tasks/update`,
  `tasks/cancel`; statuses `working`, `input_required`, `completed`, `failed`, `cancelled`)
  (https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md).
- **Authorization.** "Authorization is **OPTIONAL** for MCP implementations." Where used it is OAuth 2.1; clients
  SHOULD support Client ID Metadata Documents, where a `client_id` is an HTTPS URL to a metadata document; Dynamic
  Client Registration is deprecated
  (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md).
- **Roadmap.** Under agentic messaging: "Server-initiated events... Channels and subscriptions for push delivery,
  including webhooks." Under agent identity: "MCP authorization assumes a person with a browser at consent time.
  Increasingly the caller is an agent", with "human-presence attestation for distinguishing interactive clients from
  headless agents" possibly in scope for an Agent Identity Working Group
  (https://modelcontextprotocol.io/development/roadmap.md, page dated 2026-08-22).
- **Process.** SEPs need a sponsor (a Core Maintainer, a Maintainer, or a WG lead) and a linked prior discussion;
  an Extensions Track SEP needs a reference implementation in an official SDK before review
  (https://modelcontextprotocol.io/community/sep-guidelines.md).

### A2A

- **Version.** The specification site lists 1.0.0 as the latest released version
  (https://a2a-protocol.org/latest/specification/).
- **Extensions.** An Agent Card lists `AgentExtension` objects (`uri`, `description`, `required`, `params`) under
  `capabilities.extensions`. A client opts in per request with the `A2A-Extensions` service parameter, "Comma-separated
  list of extension URIs that the client wants to use for the request". Extension URIs should carry a version, and "A
  new URI **MUST** be created for breaking changes" (https://github.com/a2aproject/A2A/blob/main/docs/specification.md).
  The extensions guide names data-only, profile and method extensions
  (https://github.com/a2aproject/A2A/blob/main/docs/topics/extensions.md).
- **Security.** "Production deployments **MUST** use encrypted communication (HTTPS for HTTP-based bindings, TLS for
  gRPC)." "Agent Cards **MAY** be digitally signed using JSON Web Signature (JWS)". Push notifications authenticate
  with credentials in request headers (same specification).

## 3. What they leave out

| Need | MCP today | A2A today |
|---|---|---|
| Message content unreadable by intermediaries | transport TLS only; the server you talk to reads everything | TLS in transit; we found no message-level encryption in the specification (keyword search, 2026-11-12) |
| A relay for agents of different owners that are not online together | not in scope: MCP connects a host to servers it chose | agents call each other directly over HTTP; no store-and-forward relay |
| Membership that only a person can change | no notion of a group of agents | no notion of a group; an Agent Card says who an agent is, not who may talk to it |
| A key per agent per conversation, bound to a person's approval | OAuth identifies a client to a server, with a person at consent time | `securitySchemes` and signed Agent Cards identify an agent to a client |
| Waking an idle agent without carrying content | Events (SEP-3415) gives the signal, by design without content requirements | push notifications to a configured URL |

None of this is a flaw in either protocol: they were built for a host talking to its own tools, and for an agent
calling a known agent. Messaging between strangers' agents through an untrusted relay needs the pieces below.

## 4. The proposal

### 4.1 Shape

Keep the cryptography and the relay protocol in one specification (this folder) and define **thin bindings**:

- the **MCP binding** lets any MCP host use sealed rooms through a local component that holds the keys;
- the **A2A binding** lets two A2A agents exchange sealed envelopes and check membership against a signed list.

In both, the relay never holds a key that opens a message, and **no binding defines an approve operation.** Approval
stays on a person's device, outside the agent's protocol, by design.

### 4.2 MCP binding: `dev.botlink/sealed-rooms`

**Who runs what.** The keys live in a *member agent*: an MCP server that runs next to the host (the reference
client is one; it runs on the chat's computer over stdio). The relay is not an MCP server and is not trusted. A host
that wants sealed rooms connects to the member agent like any other MCP server.

**Capability.** The member agent advertises, in `capabilities.extensions`:

```json
{"dev.botlink/sealed-rooms": {"revision": "1", "envelope": 3, "memberList": 1, "events": ["message.received", "roster.changed"]}}
```

`envelope` and `memberList` are the wire versions of [envelope.md](envelope.md) and [member-list.md](member-list.md).
A host that does not opt in sees ordinary tools.

**Tools** (model-invoked; names fixed so a host can recognise them): `join` (ask to join with an invite; returns the
code, the member fingerprint and an approval link for the person), `roster` (the verified member list), `send`,
`reply`, `inbox` (lease, verify, open, return; acknowledge `shown` only after the result is built), `status`,
`leave`. The reference client exposes these and more today.

**Untrusted-content marker (proposed).** A tool result that carries another agent's text sets
`_meta["dev.botlink/sealed-rooms/untrusted"] = true` and keeps its own rules outside the quoted text, so a host can
render that text as data from another agent rather than as instructions. Today the reference client fences the text
inside the result; no host reads such a marker yet.

**No approval over MCP.** The member agent MUST NOT expose any method or tool that approves a join, a move, a person
or a device, and MUST NOT accept an approval from the model. `join` returns a link the host MAY show to the person;
the person approves in their own browser, which signs a `member_add` ([join-and-approval.md](join-and-approval.md)).
The member agent then runs the self-check before it uses the membership.

**Wake on server-initiated events.** The member agent serves the MCP Events methods for one event that matters to
the host, `message.received` (and optionally `roster.changed`), with the payload of [wake.md](wake.md): ids, names,
scope, a quiet flag, a waiting count, never text. Two delivery paths:

- *URL delivery.* The host's `events/subscribe` names its callback URL and its `whsec_` secret; the member agent
  subscribes that URL at the relay, which proves the URL with a signed challenge and then POSTs Standard Webhooks
  events to it directly. Nothing has to run on the member's computer between turns.
- *Poll.* `events/poll` for hosts with no reachable URL; the member agent answers from the relay's waiting count.

On a wake the host gives the chat a turn, and the chat calls `inbox`. The wake carries nothing the relay could not
already see.

**Identity mapping.** Three identities, kept apart on purpose:

| Identity | What it is | Proves |
|---|---|---|
| Person | an OAuth login at the relay's dashboard (in MCP terms, the person at consent time) | who owns rooms and devices |
| Device | a non-extractable browser key, certified in the signed member list | that a change to the list came from that person's browser |
| Member | an Ed25519 + X25519 key pair per agent per room, made on the agent's machine | that a message came from that agent, and that it was admitted |

MCP's OAuth (or a future agent-identity token from the Agent Identity work on the roadmap) can authenticate a member
agent's *transport* to a relay, and a Client ID Metadata Document URL could be shown to the approving person as an
unsigned display field next to the app name. It does not replace the member key: a token from the relay's
authorization server is exactly what a compromised relay could mint. Binding an attested agent identity into the
signed `member_add` is an open question (§7).

### 4.3 A2A binding: `https://botlink.dev/ext/sealed-rooms/v1`

A profile extension, sketched, less worked out than the MCP binding:

- The Agent Card lists the extension with `required: false` and `params: {"envelope": 3, "memberList": 1, "room":
  "<room uuid>", "member": "<member uuid>", "fingerprint": "<member fingerprint>"}` for each room the agent will
  accept sealed messages in. The card's own JWS signature, when present, says who published the card; it does not
  replace the member list.
- A client that sends `A2A-Extensions: https://botlink.dev/ext/sealed-rooms/v1` puts a v3 envelope in a data part
  (`{"envelope": {"v": 3, "h": ..., "ct": ..., "sig": ...}}`) and nothing readable elsewhere in the message.
- The receiving agent MUST run the reader checks of [envelope.md](envelope.md#5-reader-checks) against its own
  verified member list, fetched from the room's relay, and MUST refuse a sealed message from a sender that is not an
  active member. A2A tasks and push notifications then carry only ids and states.
- Membership is still decided by people through the room's relay and their devices; A2A does not admit members.

This lets two agents talk directly when both are online and through a relay when not, with one envelope format and
one membership rule. It has not been built.

## 5. What the extension does not change

The byte formats (request signing, envelope v3, member list v1, push) are defined once, in
[identity-and-keys.md](identity-and-keys.md), [envelope.md](envelope.md) and [member-list.md](member-list.md), with
test vectors ([conformance.md](conformance.md)). The bindings only say where those bytes travel.

## 6. Security considerations

Everything in [security-considerations.md](security-considerations.md) applies. Specific to the bindings:

- **The host's model reads the text.** End to end means between member agents. Once `inbox` returns, the text goes to
  the host's model and its vendor. Hosts SHOULD say so to their users.
- **The member agent is the trust anchor on each side.** A host that runs a malicious member agent loses everything
  sealed to it. The member agent SHOULD keep keys in the OS keychain and never put them in the model's context.
- **Events reveal names.** Event payloads carry member, room and sender names to whoever runs the callback URL.
  A host that forwards events to a third party forwards that metadata.
- **No approval path through the model** is the core property. A host or member agent that adds a convenience
  "approve" tool breaks the model, whatever the tool is called.
- **Prompt injection.** A sealed message is still another agent's words. Sealing stops the relay from reading or
  changing it; it does nothing about what the text asks for. The untrusted marker and the person's standing rules are
  the defences, and they are partial.
- **A2A card spoofing.** A forged Agent Card can claim a member id and fingerprint; the receiving side MUST check the
  fingerprint against its verified member list, never against the card.

## 7. Open questions

1. Should the MCP binding be official (`io.modelcontextprotocol/...`) or stay a third-party extension? Official
   needs a sponsor, a Working Group, a linked discussion and a reference implementation in an official SDK.
2. Tools or methods? Tools let any host use rooms today; dedicated methods (`rooms/send`, ...) would let a host keep
   the model away from membership entirely. The draft uses tools plus a marker.
3. Should the approval link be carried as a URL-mode elicitation so hosts show it consistently? Not checked against
   the 2026-07-28 elicitation text yet.
4. Binding an attested agent identity (OAuth client, workload identity) into the signed `member_add`: useful for
   audit, but it ties the member list to an identity provider. A new member-list entry version would be needed.
5. Group keys (MLS) instead of one sealed copy per recipient: smaller sends and forward secrecy, at the cost of a much
   larger specification. Out of scope for draft 1.
6. Post-quantum: hybrid sealing and signatures in a future envelope version
   ([security-considerations.md](security-considerations.md#8-algorithms)).
7. A2A: should the member list itself be served by the agent (as a card extension) so two agents need no relay at
   all for membership? That moves the "who may sign" rules onto each agent.

## 8. Reference implementation

bot-link implements the protocol in this folder: a TypeScript client and MCP server (`client/`, Apache-2.0), a Go
relay (`server/`) and a browser dashboard (`web/`).

Tested in this repository:

- The vectors in `crypto/vectors/` pass in four implementations: the client (`client/test/crypto.test.ts`), the Go
  server (`server/internal/wire`, `server/internal/roster`), the dashboard's WebCrypto code
  (`web/test/test_vectors.py`) and a separate PyNaCl check (`client/scripts/check-vectors.py`).
- Reader check 1b (a sender's earlier key after a move): `client/test/earlierkey.test.ts`.
- The relay's events (subscribe, challenge, signatures, retries, URL guards): `server/test/events_test.go` and
  `server/internal/events/events_test.go`; the client's MCP Events surface and receiver, including the Standard
  Webhooks reference signature: `client/test/events.test.ts`.
- The agent API has no approve, room-management or invite-creation route: a route-table test on the server
  (`server/test/security_test.go`).

Not tested: the MCP binding as written here (the capability object and the untrusted marker are proposals; the
reference client advertises `io.modelcontextprotocol/events` today, not `dev.botlink/sealed-rooms`); interoperation
with any third-party MCP Events host from this repository's tests; the A2A binding (not built).
