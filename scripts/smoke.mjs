#!/usr/bin/env node
// End-to-end smoke test of a running bot-link server, the one CI runs against the compose stack (scripts/smoke.sh).
//   node scripts/smoke.mjs <server origin, e.g. http://localhost:8811>
// Needs the server in dev mode with the dev sign-in on (BOTLINK_ENV=dev, BOTLINK_DEV_LOGIN=1, BOTLINK_HUMAN_CHECK=stub):
// it signs in the way the dashboard's dev sign-in does. Never point it at a production server (it refuses one whose
// dev sign-in is off). Needs the built client (cd client && npm ci && npm run build).
// Steps: sign in, register a browser key, create a room, make a chat invite, join two chats with the client command
// line (each in its own empty home folder), approve each join with a signed member-list entry as the dashboard does,
// send a message from one chat to the other, read it with the other's inbox.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+$/.test(base)) {
  console.error("usage: node scripts/smoke.mjs <server origin, e.g. http://localhost:8811>");
  process.exit(2);
}
const dist = join(ROOT, "client", "dist");
const CLI = join(dist, "cli.js");
let c, roster;
try {
  c = await import(join(dist, "crypto.js"));
  roster = await import(join(dist, "roster.js"));
} catch {
  console.error(`smoke: no built client at ${dist}: run (cd client && npm ci && npm run build) first`);
  process.exit(2);
}
await c.ready();

const step = (s) => console.log(`smoke: ${s}`);
const fail = (s) => { console.error(`smoke: FAILED: ${s}`); process.exit(1); };

// ---- the browser side, as the dashboard does it
let cookie = "", csrf = "";
async function call(method, path, body) {
  const headers = { Accept: "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET") {
    headers.Origin = base;
    headers["Content-Type"] = "application/json";
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const txt = await r.text();
  if (!r.ok) fail(`${method} ${path} -> ${r.status} ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}

const ready = await fetch(`${base}/readyz`).catch((e) => fail(`${base}/readyz: ${e.message}`));
if (!ready.ok) fail(`${base}/readyz answered ${ready.status}`);
step("server ready");
const providers = await call("GET", "/app/v1/auth/providers").catch(() => null);
if (providers && Array.isArray(providers.providers) && !providers.providers.includes("dev")) fail("the dev sign-in is off on this server; this smoke test runs only against a dev-mode stack");

const me = await call("POST", "/app/v1/auth/dev-login", { email: `smoke-${c.nonceHex().slice(0, 8)}@example.test`, display_name: "Smoke" });
csrf = me.csrf_token;
const account = me.account;
const seed = c.nonceHex() + c.nonceHex();
const device = { id: c.uuidv7(), seed, pk: c.edPkFromSeed(seed) };
await call("POST", "/app/v1/devices", { id: device.id, ed25519_pk: device.pk, label: "smoke browser" });
csrf = (await call("GET", `/app/v1/me?device_id=${device.id}`)).csrf_token;
step(`signed in as ${account.email} (dev sign-in), browser key registered`);

const roomId = c.uuidv7();
const roomName = `smoke${Date.now() % 1e6}`;
const genesis = roster.makeEntry({ room: roomId, op: "genesis", name: roomName, owner: account.id, device: device.pk }, 0, null, device.pk, device.seed);
await call("POST", "/app/v1/rooms", { id: roomId, name: roomName, purpose: "smoke test", genesis });
step(`room #${roomName} created`);
const invite = (await call("GET", `/app/v1/rooms/${roomId}/chat-invite`)).url;
step(`chat invite made: ${invite.replace(/[^/]+$/, "…")}`);

async function approve(name) {
  const card = (await call("GET", "/app/v1/needs-you")).join_requests.find((x) => x.room_id === roomId && x.name === name);
  if (!card) fail(`no join request from ${name} on the dashboard`);
  const entries = (await call("GET", `/app/v1/rooms/${roomId}/roster`)).entries;
  const head = entries[entries.length - 1];
  const entry = roster.makeEntry({ room: roomId, op: "member_add", member: card.member_id, account: account.id, name: card.name, app: card.app, ed: card.ed25519_pk, x: card.x25519_pk },
    head.seq + 1, roster.entryHash(head), device.pk, device.seed);
  const ch = await call("POST", "/app/v1/human-check", { action: "approve_join", target_id: card.id });
  await call("POST", `/app/v1/join-requests/${card.id}/approve`, { human_check: { id: ch.id, stub: true }, roster_entry: entry });
  return card;
}

// ---- the chats: the real client command line, each in an empty home folder of its own
const homes = [];
const loopback = /^https?:\/\/(localhost|127\.|\[::1\])/.test(base);
function cli(home, ...args) {
  const env = { PATH: process.env.PATH, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: base, BOTLINK_NO_UPDATE: "1", ...(loopback ? { BOTLINK_DEV: "1" } : {}) };
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: "utf-8", timeout: 60_000 });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
async function joinChat(name) {
  const home = mkdtempSync(join(tmpdir(), `botlink-smoke-${name}-`));
  homes.push(home);
  // no app to detect from a plain shell: name one, as a chat in an unknown app is told to (core.askAppName)
  const j = cli(home, "join", invite, "--name", name, "--job", "smoke test", "--app-name", "smoke test");
  if (j.status !== 0) fail(`join ${name}: exit ${j.status}\n${j.out}`);
  const card = await approve(name);
  step(`${name} asked to join (code ${card.match_code}); approved with a signed member-list entry`);
  const w = cli(home, "join", "--wait");
  if (w.status !== 0) fail(`join --wait ${name}: exit ${w.status}\n${w.out}`);
  step(`${name} is in the room`);
  return home;
}

try {
  const a = await joinChat("alpha");
  const b = await joinChat("bravo");
  const token = `smoke-${c.nonceHex().slice(0, 10)}`;
  const s = cli(a, "send", "--as", "alpha", "--to", "bravo", "--intent", "fyi", "--text", `hello from alpha ${token}`);
  if (s.status !== 0) fail(`send: exit ${s.status}\n${s.out}`);
  step("alpha sent bravo a sealed message");
  const i = cli(b, "inbox", "--as", "bravo");
  if (i.status !== 0) fail(`inbox: exit ${i.status}\n${i.out}`);
  if (!i.out.includes(token)) fail(`bravo's inbox does not show the message:\n${i.out}`);
  step("bravo read it: the text arrived and opened on bravo's side only");
  console.log("SMOKE OK");
} finally {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
}
