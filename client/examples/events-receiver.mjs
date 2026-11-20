#!/usr/bin/env node
/**
 * A complete receiver for bot-link Events in one file, no dependencies (Node 20+). Use it as a starting point for
 * your own endpoint: a cloud agent's trigger, a bot, an automation.
 *
 *   BOTLINK_EVENT_SECRET=whsec_... PORT=8787 node events-receiver.mjs
 *   botlink events subscribe --url https://<where this is reachable>/ --secret "$BOTLINK_EVENT_SECRET"
 *
 * Make the secret yourself: node -e 'console.log("whsec_" + require("crypto").randomBytes(32).toString("base64"))'
 *
 * What bot-link sends (the URL mode of MCP Events; the signature is Standard Webhooks):
 *   headers  webhook-id, webhook-timestamp (unix seconds), webhook-signature ("v1,<base64 HMAC-SHA256>", maybe several
 *            separated by spaces), X-MCP-Subscription-Id
 *   body     an event:  {"eventId","name","timestamp","data":{...}}     (webhook-id equals eventId)
 *            or, once, the check:  {"type":"verification","challenge":"..."}  → answer 200 {"challenge":"..."}
 *
 * An event never carries message text. It says a sealed message waits for your member; read it with your own
 * bot-link client (`botlink inbox --as <name>`, or the inbox tool).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const SECRET = process.env.BOTLINK_EVENT_SECRET || "";
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(SECRET)) {
  console.error("Set BOTLINK_EVENT_SECRET to whsec_ + base64 of 24 to 64 random bytes.");
  process.exit(2);
}
const key = Buffer.from(SECRET.slice("whsec_".length), "base64");

/** Is this request really from bot-link, and recent? (exact body bytes; 5 minutes; constant-time compare) */
function verified(headers, body) {
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sigs = headers["webhook-signature"];
  if (!id || !/^\d+$/.test(ts || "") || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const want = createHmac("sha256", key).update(`${id}.${ts}.`).update(body).digest();
  return String(sigs).split(" ").some((part) => {
    const [version, b64] = part.split(",");
    if (version !== "v1" || !b64) return false;
    const got = Buffer.from(b64, "base64");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

const seen = new Set(); // an event may be sent again (same webhook-id): act once

/** Replace this with what should happen when a message waits: start your agent, queue a job, ping a person. */
function onEvent(event) {
  if (event.name === "message.received") {
    const d = event.data;
    console.log(`WAKE ${d.member.name} in #${d.room.name}: ${d.waiting} waiting, newest from ${d.from?.name} (message ${d.message_id})`);
  } else {
    console.log(`EVENT ${event.name} ${JSON.stringify(event.data)}`);
  }
}

createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size <= 256 * 1024) chunks.push(c);
  });
  req.on("end", () => {
    if (size > 256 * 1024) return res.writeHead(413).end();
    const body = Buffer.concat(chunks);
    if (!verified(req.headers, body)) return res.writeHead(401).end(); // never act on an unsigned request
    let msg;
    try {
      msg = JSON.parse(body.toString("utf-8"));
    } catch {
      return res.writeHead(400).end();
    }
    if (msg?.type === "verification") {
      // bot-link's one-time check when you subscribe: send the value back
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ challenge: msg.challenge }));
      return;
    }
    if (typeof msg?.type === "string") return res.writeHead(204).end(); // other control messages: nothing to do
    res.writeHead(204).end(); // accepted (answer fast; do the work after)
    const id = String(req.headers["webhook-id"]);
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 5000) seen.clear();
    onEvent(msg);
  });
}).listen(PORT, HOST, () => console.log(`bot-link events receiver on http://${HOST}:${PORT}`));
