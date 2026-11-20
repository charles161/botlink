# MCP Events in bot-link's tool server

bot-link's MCP tool server (`botlink mcp`) offers the experimental MCP Events methods of the SEP-3415 draft, as
described in `SPEC.md` §6.13. The current documents, and how this implementation differs from them, are in
[mcp-events-facts.md](mcp-events-facts.md).

## What it offers

| Method | What it does here |
|---|---|
| `events/list` | Two events: `message.received` (delivery `webhook`, `poll`) and `roster.changed` (delivery `webhook`). |
| `events/subscribe` | Webhook delivery only. The URL must echo bot-link's server's signed challenge first. |
| `events/unsubscribe` | Removes the matching subscription. Asking twice is not an error. |
| `events/poll` | `message.received` only. One count request per call. |
| `events/stream` | Not offered: answers `-32026` with `{feature: "deliveryMode", value: "push"}`. |

`initialize` declares `capabilities.events` (the key of the design sketch that preceded the SEP) and
`capabilities.extensions["io.modelcontextprotocol/events"]` (the SEP's key). An event carries ids and names, never
message text; the chat reads messages with the inbox tool, as always.

## The setting

| Client setting | Values | Default | Effect |
|---|---|---|---|
| `BOTLINK_MCP_EVENTS` | `on`, `off` | `on` | `off`: `initialize` declares neither key, and every `events/*` method answers `-32601` (method not found), as the SEP says a server without the extension does. Any other value stops the tool server at start with a sentence naming the two values. |

Set it in the environment the app starts `botlink mcp` with. With the default, the tool server answers `initialize`
and `tools/list` byte for byte as the build of commit `768fdc8` did (`client/test/mcp-events-flag.test.ts`).

The server has no matching setting: nothing on bot-link's server is specific to MCP. The subscription API and the
sender serve `botlink events serve` and any other receiver as well (§6.13).
