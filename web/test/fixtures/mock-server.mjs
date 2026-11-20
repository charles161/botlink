// Local fixture server for the web dashboard (PLAN.md §4: W may use its own fixture server under
// web/test/fixtures until server/ lands). Implements the /app/v1 surface of api/openapi.yaml in
// memory, serves web/public with the contract's SPA fallback + CSP, and verifies roster entries for
// real (Ed25519 signature, hash chain, op fields), so the browser's signing code is exercised.
// Never used in production. Test-only hooks live under /__mock/.
//
//   node web/test/fixtures/mock-server.mjs            # :8829, stub human check
//   MOCK_HC=real node web/test/fixtures/mock-server.mjs   # Turnstile test key + WebAuthn
//   MOCK_PAYWALL=on node web/test/fixtures/mock-server.mjs  # plans, credits, billing (default off, like BOTLINK_PAYWALL)
//   MOCK_SOURCE_URL=https://github.com/<owner>/<repo> ...    # the "Self-host it" link, like BOTLINK_SOURCE_URL (default none)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createHash, randomBytes, createPublicKey, verify as edVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import { join, extname, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { installPlans } from "./mock-plans.mjs"; // plans, limits, credits, billing (CONTRACT-PLANS.md)
import { installRecovery } from "./mock-recovery.mjs"; // lost passkey: reset, remove a browser
import { installAccount } from "./mock-account.mjs"; // Your account: download my data, delete my account
import { installNotify } from "./mock-notify.mjs"; // how a join request ended (needs-you ended_join_requests)
import { installStorage } from "./mock-storage.mjs"; // admin: stored bytes per account, refuse an account's sends
import { installDrafts } from "./mock-drafts.mjs"; // rooms a chat asked for: claim, confirm, reject (docs/protocol/room-drafts.md §3)
import { installBatch } from "./mock-batch.mjs"; // approve several waiting chats of one room together
import { installEventUrls } from "./mock-eventurls.mjs"; // an event address a person approves (docs/protocol/event-url-approval.md)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PUBLIC = join(ROOT, "web", "public");
const PORT = Number(process.env.PORT || 8829);
const ORIGIN = `http://localhost:${PORT}`;
const HC_MODE = process.env.MOCK_HC === "real" ? "real" : "stub";
const PROVIDERS = (process.env.MOCK_PROVIDERS || "github,google,dev").split(",").filter(Boolean);
const TURNSTILE_TEST_SITE_KEY = "1x00000000000000000000AA"; // Cloudflare's always-pass test key
const CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://avatars.githubusercontent.com https://lh3.googleusercontent.com; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
if (!["on", "off", undefined].includes(process.env.MOCK_PAYWALL)) throw new Error("MOCK_PAYWALL must be on or off");
const PAYWALL = process.env.MOCK_PAYWALL === "on";
// the same rule as the server (server/internal/config/source.go): empty, or https://github.com/<owner>/<repository>
const SOURCE_URL = process.env.MOCK_SOURCE_URL || "";
if (SOURCE_URL && !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(SOURCE_URL)) throw new Error("MOCK_SOURCE_URL must be https://github.com/<owner>/<repository>");
const escAttr = (v) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** index.html and trust.html as the Go server serves them (pages.go index, source.go trustPage). */
function withSource(file, body) {
  const name = file.split("/").pop();
  if (name === "index.html" && SOURCE_URL) return Buffer.from(String(body).replace("<head>", `<head>\n<meta name="botlink-source-url" content="${escAttr(SOURCE_URL)}">`));
  if (name === "trust.html") return Buffer.from(String(body).replace("<!-- source-link -->", SOURCE_URL ? `<a href="${escAttr(SOURCE_URL)}" rel="noopener noreferrer">Self-host it</a>` : ""));
  return body;
}
const PAID_PAGES = [/^\/usage$/, /^\/billing$/, /^\/billing\/fake$/, /^\/billing\/fake\/portal$/];
const SPA = [/^\/$/, /^\/login$/, /^\/rooms$/, /^\/rooms\/[0-9a-f-]{36}$/, /^\/new$/, /^\/p\/[A-Za-z0-9]{16}$/, /^\/devices$/, /^\/docs$/, /^\/admin$/, /^\/approve\/[0-9a-f-]{36}$/, /^\/create\/[0-9a-f-]{36}$/, /^\/approve-url\/[0-9a-f-]{36}$/, ...(PAYWALL ? PAID_PAGES : []), /^\/help\/lost-passkey$/, /^\/account$/];
const PAID_FILES = new Set(["/pricing.html", "/pricing.css"]); // 404 while the paywall is off
// BOTLINK_ADMIN_EMAILS equivalent for the admin area (views/admin.js); empty = feature off.
const ADMIN_EMAILS = (process.env.MOCK_ADMIN_EMAILS ?? "ops@botlink.test").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const STARTED = new Date().toISOString();
const B32 = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

// ── helpers ──────────────────────────────────────────────────────────────────
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const fp16 = (b) => { const x = sha256hex(b).slice(0, 16); return `${x.slice(0, 4)}-${x.slice(4, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}`; };
const memberFp = (ed, x) => fp16(Buffer.from(`${ed}|${x}`));
const deviceFp = (pk) => fp16(Buffer.from(`botlink-device-v1|${pk}`));
const code = (n) => Array.from(randomBytes(n), (b) => B32[b % 32]).join("");
const now = () => new Date().toISOString();
const later = (s) => new Date(Date.now() + s * 1000).toISOString();
const b64u = (b) => Buffer.from(b).toString("base64url");
const uuid = () => randomUUID();
function edOk(pkHex, sigHex, msg) {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pkHex, "hex").toString("base64url") }, format: "jwk" });
    return edVerify(null, msg, key, Buffer.from(sigHex, "hex"));
  } catch { return false; }
}
const rawPk = () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  return Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
};
class E extends Error { constructor(status, code, message, details, retryAfter) { super(message); this.status = status; this.code = code; this.details = details; this.retryAfter = retryAfter; } }

// ── state ────────────────────────────────────────────────────────────────────
let db;
function reset() {
  db = { accounts: new Map(), sessions: new Map(), devices: new Map(), rooms: new Map(), invites: new Map(), personInvites: new Map(),
    joinRequests: new Map(), personRequests: new Map(), attention: new Map(), humanChecks: new Map(), creds: new Map(), mutes: new Set(), drafts: new Map() };
}
reset();
const sse = new Set();
const changed = () => { for (const res of sse) res.write("event: changed\ndata: {}\n\n"); };

function accountByEmail(email, display_name) {
  for (const a of db.accounts.values()) if (a.email === email) return a;
  const a = { id: uuid(), email, display_name: display_name || email.split("@")[0].replace(/^./, (c) => c.toUpperCase()), avatar_url: null, provider: "dev" };
  db.accounts.set(a.id, a);
  return a;
}
function roomPeople(room) { return [...room.people.values()]; }
function inRoom(room, acct) { return room.people.has(acct); }
const devicePublic = (d) => {
  let certified = 0;
  const pending = [];
  for (const r of db.rooms.values()) if (!r.deleted && inRoom(r, d.account_id)) {
    if (r.signers.has(d.ed25519_pk)) certified++;
    else pending.push({ room_id: r.id, room_name: r.name, signer_labels: [...db.devices.values()].filter((x) => x.account_id === d.account_id && r.signers.has(x.ed25519_pk)).map((x) => x.label) });
  }
  return { id: d.id, ed25519_pk: d.ed25519_pk, label: d.label, fingerprint: deviceFp(d.ed25519_pk), created_at: d.created_at, revoked_at: d.revoked_at || null, certified_rooms: certified, pending_rooms: pending.length, approved: !!d.approved, pending };
};
// SPEC §6.1: one open new_device item per browser that can't sign in some of its person's rooms.
function syncDeviceAttention(acct, onlyId = null) {
  for (const d of db.devices.values()) {
    if (d.account_id !== acct || (onlyId && d.id !== onlyId)) continue;
    const pub = devicePublic(d);
    const open = [...db.attention.values()].find((a) => !a.resolved && a.kind === "new_device" && a.subject_id === d.id);
    if (!pub.pending.length || d.revoked_at) { if (open) open.resolved = true; continue; }
    const data = { label: d.label, fingerprint: deviceFp(d.ed25519_pk), approved: !!d.approved, room_names: pub.pending.map((p) => p.room_name), pending_rooms: pub.pending.length };
    if (open) open.data = data;
    else { const id = uuid(); db.attention.set(id, { id, kind: "new_device", account: acct, room_id: null, subject_id: d.id, member_name: null, app: null, data, created_at: now() }); }
  }
  changed();
}
// SPEC §6.10a: every person of the room except the one who did it.
function membershipAttention(room, mem, kind, how, actor) {
  const data = { name: mem.name, app: mem.app, job: mem.job, person_name: db.accounts.get(mem.account_id)?.display_name, fingerprint: mem.fingerprint || null, how, by_name: actor ? db.accounts.get(actor)?.display_name : "", room_name: room.name };
  for (const acct of room.people.keys()) {
    if (acct === actor) continue;
    const id = uuid();
    db.attention.set(id, { id, kind, account: acct, room_id: room.id, subject_id: mem.id, member_name: mem.name, app: mem.app, data, created_at: now() });
  }
}

// Roster append with the same rules as ENVELOPE §5 (enough to catch browser bugs).
function appendEntry(room, wire, expect) {
  const bytes = Buffer.from(wire.entry, "base64url");
  if (!edOk(wire.signer, wire.sig, Buffer.concat([Buffer.from("botlink-roster-v1\n"), bytes]))) throw new E(400, "roster_invalid", "Signature doesn't verify.", { rule: "signature" });
  const e = JSON.parse(bytes.toString("utf8"));
  if (e.v !== 1 || e.room !== room.id || e.by !== wire.signer || e.seq !== wire.seq) throw new E(400, "roster_invalid", "Entry fields don't match.", { rule: "format" });
  if (wire.seq !== room.entries.length || e.prev !== room.headHash) throw new E(409, "roster_conflict", "The member list changed. Refetch and sign again.");
  if (!room.signers.has(e.by) && !(e.op === "member_remove" && [...room.members.values()].some((m) => m.ed === e.by))) throw new E(403, "not_signer", "This device can't sign for this room.");
  if (expect) for (const [k, v] of Object.entries(expect)) if (e[k] !== v) throw new E(400, "roster_invalid", `Entry ${k} doesn't match the request.`, { rule: "match" });
  room.entries.push({ seq: wire.seq, entry: wire.entry, sig: wire.sig, signer: wire.signer });
  room.headHash = sha256hex(bytes);
  return e;
}

function roomDetail(room, acct, deviceId) {
  const owner = db.accounts.get(room.owner);
  const dev = deviceId ? db.devices.get(deviceId) : null;
  return {
    room: roomSummary(room, acct),
    room_fingerprint: room.fp,
    people: roomPeople(room).map((p) => ({ account_id: p.account_id, display_name: db.accounts.get(p.account_id).display_name, role: p.account_id === room.owner ? "owner" : "person" })),
    members: [...room.members.values()].map((m) => ({ ...memberView(room, m), muted_by_me: db.mutes.has(`${acct}>${m.id}`) })),
    my_role: acct === room.owner ? "owner" : "person",
    head_seq: room.entries.length - 1, head_hash: room.headHash,
    my_device_certified: !!(dev && room.signers.has(dev.ed25519_pk)),
    _owner: owner.display_name,
  };
}
function memberView(room, m) {
  const person = db.accounts.get(m.account_id).display_name;
  // hotfix 2026-11-06 labels (the mock treats a "wake" member as one whose idle wake was observed)
  const label = m.turn === "always_on" ? "always on" : m.turn === "wake" ? "wakes on its own" : "answers on its next turn";
  return { id: m.id, name: m.name, app: m.app, app_name: m.app_name ?? null, job: m.job, folder: m.folder, turn: m.turn, turn_label: label, person_name: person, account_id: m.account_id, fingerprint: memberFp(m.ed, m.x), stuck: !!m.stuck, joined_at: m.joined_at };
}
function needsFor(acct, roomId) {
  let n = 0;
  for (const j of db.joinRequests.values()) if (j.status === "pending" && j.for_account === acct && (!roomId || j.room_id === roomId)) n++;
  for (const p of db.personRequests.values()) if (p.status === "pending" && db.rooms.get(p.room_id).owner === acct && (!roomId || p.room_id === roomId)) n++;
  for (const a of db.attention.values()) if (!a.resolved && a.account === acct && (!roomId || a.room_id === roomId)) n++;
  return n;
}
function roomSummary(room, acct) {
  return { id: room.id, name: room.name, purpose: room.purpose, owner_name: db.accounts.get(room.owner).display_name, my_role: acct === room.owner ? "owner" : "person", member_count: room.members.size, needs_you: needsFor(acct, room.id) };
}
function chatInvite(room, acct) {
  let inv = [...db.invites.values()].find((i) => i.room_id === room.id && i.account === acct);
  if (!inv) { inv = { id: uuid(), room_id: room.id, account: acct, code: code(10), expires_at: later(86400), off: false, use_count: 0 }; db.invites.set(inv.id, inv); }
  return inv;
}
const inviteView = (room, inv) => ({ room_id: room.id, url: `${ORIGIN}/i/${room.name}-${inv.code}`, code: inv.code, expires_at: inv.expires_at, off: inv.off, use_count: inv.use_count });
const activity = (room, item) => room.activity.unshift({ at: now(), from_name: null, to_name: null, person_name: null, ...item });

// ── human check ──────────────────────────────────────────────────────────────
function newHumanCheck(sess, action, target, targets = null) {
  const id = uuid();
  const acct = db.accounts.get(sess.account_id);
  const fresh = sess.uv_at && Date.now() - sess.uv_at < 3600e3;
  const myCreds = [...db.creds.values()].filter((c) => c.account === acct.id);
  // a join approval, a room draft's confirm, an event address and an account delete ask the passkey on each request (EveryTime); other approvals skip within the hour
  const step = HC_MODE === "stub" || (fresh && !["approve_join", "approve_joins", "confirm_room", "approve_event_url", "account_delete"].includes(action)) ? "skip" : myCreds.length ? "assert" : "register";
  const challenge = b64u(randomBytes(32));
  db.humanChecks.set(id, { id, action, target, targets, account: acct.id, step, used: false, expires: Date.now() + 300e3 });
  const out = { id, expires_at: later(300), mode: HC_MODE, turnstile_site_key: HC_MODE === "real" ? TURNSTILE_TEST_SITE_KEY : null, webauthn: { step } };
  if (step === "register") out.webauthn.options = { challenge, rp: { name: "bot-link", id: "localhost" }, user: { id: b64u(Buffer.from(acct.id.replace(/-/g, ""), "hex")), name: acct.email, displayName: acct.display_name }, pubKeyCredParams: [{ type: "public-key", alg: -8 }, { type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], authenticatorSelection: { userVerification: "preferred", residentKey: "discouraged" }, timeout: 60000, attestation: "none" };
  if (step === "assert") out.webauthn.options = { challenge, rpId: "localhost", allowCredentials: myCreds.map((c) => ({ type: "public-key", id: c.id })), userVerification: "preferred", timeout: 60000 };
  return out;
}
function consumeHumanCheck(sess, proof, action, target, targets = null) {
  const hc = proof && db.humanChecks.get(proof.id);
  if (!hc || hc.used || hc.expires < Date.now() || hc.account !== sess.account_id || hc.action !== action || (hc.target && target && hc.target !== target) || JSON.stringify(hc.targets ?? null) !== JSON.stringify(targets ?? null)) throw new E(403, "human_check_failed", "Human check failed.");
  if (HC_MODE === "stub") { if (proof.stub !== true) throw new E(403, "human_check_failed", "Human check failed."); }
  else {
    if (!proof.turnstile_token) throw new E(403, "human_check_failed", "Human check failed.");
    if (hc.step !== "skip") {
      if (!proof.webauthn?.id || !proof.webauthn?.response) throw new E(403, "human_check_failed", "Human check failed.");
      if (hc.step === "register") db.creds.set(proof.webauthn.id, { id: proof.webauthn.id, account: sess.account_id });
      sess.uv_at = Date.now();
    }
  }
  return () => { hc.used = true; };
}

// ── routing ──────────────────────────────────────────────────────────────────
const routes = [];
const route = (method, re, fn, opts = {}) => routes.push({ method, re, fn, ...opts });

route("GET", /^\/app\/v1\/auth\/providers$/, () => ({ providers: PROVIDERS }), { open: true });
route("POST", /^\/app\/v1\/auth\/dev-login$/, ({ body, res }) => {
  if (!PROVIDERS.includes("dev")) throw new E(404, "not_found", "Not found.");
  if (!body?.email || !/^[^@\s]+@[^@\s]+$/.test(body.email)) throw new E(400, "bad_request", "Enter a valid email.");
  const a = accountByEmail(body.email.toLowerCase(), body.display_name);
  const tok = b64u(randomBytes(32));
  db.sessions.set(tok, { account_id: a.id, csrf: b64u(randomBytes(18)), uv_at: null, created_at: Date.now() });
  res.setHeader("Set-Cookie", `bl_session=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
  return appMe(db.sessions.get(tok), null);
}, { open: true, nocsrf: true });
route("GET", /^\/app\/v1\/auth\/(github|google)\/start$/, ({ res, url }) => {
  // Mock: pretend the provider round trip happened with a fixed account per provider.
  const p = url.pathname.split("/")[4];
  const a = accountByEmail(`${p}-user@example.com`, p === "github" ? "Octo Person" : "Gmail Person");
  const tok = b64u(randomBytes(32));
  db.sessions.set(tok, { account_id: a.id, csrf: b64u(randomBytes(18)), uv_at: null, created_at: Date.now() });
  res.writeHead(302, { Location: url.searchParams.get("return_to") || "/rooms", "Set-Cookie": `bl_session=${tok}; HttpOnly; SameSite=Lax; Path=/` });
  res.end();
  return undefined;
}, { open: true, raw: true });
route("POST", /^\/app\/v1\/auth\/logout$/, ({ token }) => { db.sessions.delete(token); return { ok: true }; });

function appMe(sess, deviceId) {
  const a = db.accounts.get(sess.account_id);
  const d = deviceId && db.devices.get(deviceId);
  return { account: { id: a.id, email: a.email, display_name: a.display_name, avatar_url: a.avatar_url }, csrf_token: sess.csrf,
    device: d && d.account_id === a.id ? devicePublic(d) : null, webauthn_registered: [...db.creds.values()].some((c) => c.account === a.id),
    uv_fresh: !!(sess.uv_at && Date.now() - sess.uv_at < 3600e3), human_check_mode: HC_MODE, wakes_paused: !!a.wakes_paused, paywall: PAYWALL, ...(ADMIN_EMAILS.includes(a.email) ? { is_admin: true } : {}) };
}
route("GET", /^\/app\/v1\/me$/, ({ sess, url }) => appMe(sess, url.searchParams.get("device_id")));
route("GET", /^\/app\/v1\/devices$/, ({ sess }) => ({ devices: [...db.devices.values()].filter((d) => d.account_id === sess.account_id).map(devicePublic) }));
route("POST", /^\/app\/v1\/devices$/, ({ sess, body, res }) => {
  const ex = db.devices.get(body.id);
  if (ex) { if (ex.ed25519_pk !== body.ed25519_pk || ex.account_id !== sess.account_id) throw new E(409, "id_conflict", "Id in use."); return devicePublic(ex); }
  if ([...db.devices.values()].some((d) => d.ed25519_pk === body.ed25519_pk)) throw new E(409, "key_in_use", "Key in use.");
  const first = ![...db.devices.values()].some((x) => x.account_id === sess.account_id);
  const d = { id: body.id, ed25519_pk: body.ed25519_pk, label: body.label, account_id: sess.account_id, created_at: now(), approved: first };
  db.devices.set(d.id, d);
  // A new browser for a person already in rooms → attention new_device.
  syncDeviceAttention(sess.account_id, d.id);
  res.statusCode = 201;
  return devicePublic(d);
});
route("GET", /^\/app\/v1\/devices\/([0-9a-f-]+)\/pending-rooms$/, ({ sess, m }) => {
  const d = db.devices.get(m[1]);
  if (!d || d.account_id !== sess.account_id) throw new E(404, "not_found", "Not found.");
  return { rooms: [...db.rooms.values()].filter((r) => !r.deleted && inRoom(r, sess.account_id) && !r.signers.has(d.ed25519_pk)).map((r) => ({ room_id: r.id, head_seq: r.entries.length - 1, head_hash: r.headHash })) };
});
route("POST", /^\/app\/v1\/devices\/([0-9a-f-]+)\/certify$/, ({ sess, m, body }) => {
  const d = db.devices.get(m[1]);
  if (!d || d.account_id !== sess.account_id) throw new E(404, "not_found", "Not found.");
  const commit = consumeHumanCheck(sess, body.human_check, "approve_device", d.id);
  const snapshot = body.entries.map((x) => { const r = db.rooms.get(x.room_id); return [r, r.entries.length, r.headHash]; });
  try {
    for (const x of body.entries) { const r = db.rooms.get(x.room_id); appendEntry(r, x.roster_entry, { op: "device_add", device: d.ed25519_pk, account: sess.account_id }); r.signers.add(d.ed25519_pk); r.people.get(sess.account_id).devices.add(d.ed25519_pk); }
  } catch (e) { for (const [r, len, hh] of snapshot) { r.entries.length = len; r.headHash = hh; } throw e; }
  commit();
  d.approved = true;
  syncDeviceAttention(sess.account_id, d.id);
  return { ok: true };
});
route("POST", /^\/app\/v1\/devices\/([0-9a-f-]+)\/ask$/, ({ sess, m }) => {
  const d = db.devices.get(m[1]);
  if (!d || d.account_id !== sess.account_id) throw new E(404, "not_found", "Not found.");
  syncDeviceAttention(sess.account_id, d.id);
  return devicePublic(d);
});
route("POST", /^\/app\/v1\/human-check$/, ({ sess, body }) => newHumanCheck(sess, body.action, body.target_id, batchMock.targets(body)));

// rooms
// newest last message first; rooms with none after them, newest room first (db.rooms keeps creation order), as the server
route("GET", /^\/app\/v1\/rooms$/, ({ sess }) => ({ rooms: [...db.rooms.values()].map((r, i) => ({ r, i })).filter(({ r }) => !r.deleted && inRoom(r, sess.account_id))
  .sort((a, b) => (b.r.last_message_at || "").localeCompare(a.r.last_message_at || "") || b.i - a.i)
  .map(({ r }) => ({ ...roomSummary(r, sess.account_id), last_message_at: r.last_message_at || null })) }));
// POST /app/v1/rooms, and step 4 of a room draft's confirm (mock-drafts.mjs): checks and builds the room; storeRoom
// keeps it. Returns {existing} for a retry of the same room (same id, same genesis).
function buildRoom(sess, body) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(body?.name || "")) throw new E(400, "bad_request", "Bad room name.");
  const ex = db.rooms.get(body.id);
  if (ex) { if (ex.entries[0].entry === body.genesis.entry) return { existing: ex }; throw new E(409, "id_conflict", "Id in use."); }
  if ([...db.rooms.values()].some((r) => !r.deleted && r.owner === sess.account_id && r.name === body.name)) throw new E(409, "name_taken", "Name taken.");
  const bytes = Buffer.from(body.genesis.entry, "base64url");
  const g = JSON.parse(bytes.toString());
  if (!edOk(body.genesis.signer, body.genesis.sig, Buffer.concat([Buffer.from("botlink-roster-v1\n"), bytes])) || g.op !== "genesis" || g.seq !== 0 || g.prev !== null || g.room !== body.id || g.name !== body.name || g.owner !== sess.account_id || g.device !== body.genesis.signer)
    throw new E(400, "roster_invalid", "Genesis doesn't check out.", { rule: "genesis" });
  const room = { id: body.id, name: body.name, purpose: body.purpose || "", owner: sess.account_id, entries: [{ ...body.genesis }], headHash: sha256hex(bytes), fp: fp16(bytes),
    people: new Map([[sess.account_id, { account_id: sess.account_id, devices: new Set([g.device]) }]]), signers: new Set([g.device]), members: new Map(), activity: [], deleted: false };
  for (const w of body.entries || []) {
    const e = appendEntry(room, w, { op: "device_add", account: sess.account_id });
    const dev = [...db.devices.values()].find((x) => x.ed25519_pk === e.device && x.account_id === sess.account_id);
    if (!dev || !dev.approved || w.signer !== g.device) throw new E(400, "roster_invalid", "Only browsers you already approved can be added here.", { rule: "request_match" });
    room.signers.add(e.device); room.people.get(sess.account_id).devices.add(e.device);
  }
  return { room };
}
function storeRoom(sess, room) {
  db.rooms.set(room.id, room);
  chatInvite(room, sess.account_id);
  syncDeviceAttention(sess.account_id);
  changed();
}
route("POST", /^\/app\/v1\/rooms$/, ({ sess, body, res }) => {
  const { room, existing } = buildRoom(sess, body);
  if (existing) return roomDetail(existing, sess.account_id);
  storeRoom(sess, room);
  res.statusCode = 201;
  return roomDetail(room, sess.account_id);
});
const myRoom = (sess, id) => { const r = db.rooms.get(id); if (!r || r.deleted || !inRoom(r, sess.account_id)) throw new E(404, "not_found", "Not found."); return r; };
route("GET", /^\/app\/v1\/rooms\/([0-9a-f-]{36})$/, ({ sess, m, url }) => roomDetail(myRoom(sess, m[1]), sess.account_id, url.searchParams.get("device_id")));
route("PATCH", /^\/app\/v1\/rooms\/([0-9a-f-]{36})$/, ({ sess, m, body }) => { const r = myRoom(sess, m[1]); if (r.owner !== sess.account_id) throw new E(403, "forbidden", "Owner only."); r.purpose = String(body.purpose || "").slice(0, 140); changed(); return roomDetail(r, sess.account_id); });
route("DELETE", /^\/app\/v1\/rooms\/([0-9a-f-]{36})$/, ({ sess, m }) => { const r = myRoom(sess, m[1]); if (r.owner !== sess.account_id) throw new E(403, "forbidden", "Owner only."); r.deleted = true; changed(); return { ok: true }; });
route("GET", /^\/app\/v1\/rooms\/([0-9a-f-]{36})\/roster$/, ({ sess, m }) => { const r = myRoom(sess, m[1]); return { room_id: r.id, head_seq: r.entries.length - 1, entries: r.entries, members: [...r.members.values()].map((x) => { const v = memberView(r, x); return { member_id: v.id, name: v.name, app: v.app, job: v.job, turn: v.turn, turn_label: v.turn_label, person_name: v.person_name, folder: v.folder, stuck: v.stuck }; }) }; });
route("POST", /^\/app\/v1\/rooms\/([0-9a-f-]{36})\/roster$/, ({ sess, m, body }) => {
  const r = myRoom(sess, m[1]);
  const e = appendEntry(r, body.roster_entry);
  if (e.op === "member_remove") { const mem = r.members.get(e.member); if (mem) { r.members.delete(e.member); activity(r, { kind: "removed", from_name: mem.name }); membershipAttention(r, mem, "member_left", "removed", sess.account_id); } }
  else if (e.op === "person_remove") {
    for (const [id, mem] of r.members) if (mem.account_id === e.account) r.members.delete(id);
    const p = r.people.get(e.account); if (p) for (const d of p.devices) r.signers.delete(d);
    r.people.delete(e.account);
    activity(r, { kind: "person_left", person_name: db.accounts.get(e.account).display_name });
  } else throw new E(400, "bad_request", "Only removes go here.");
  changed();
  return inRoom(r, sess.account_id) ? roomDetail(r, sess.account_id) : { ok: true };
});
route("GET", /^\/app\/v1\/rooms\/([0-9a-f-]{36})\/activity$/, ({ sess, m, url }) => {
  const r = myRoom(sess, m[1]);
  const before = url.searchParams.get("before"); const limit = Number(url.searchParams.get("limit") || 50);
  return { items: r.activity.filter((a) => !before || a.at < before).slice(0, limit) };
});
route("GET", /^\/app\/v1\/rooms\/([0-9a-f-]{36})\/chat-invite$/, ({ sess, m }) => { const r = myRoom(sess, m[1]); return inviteView(r, chatInvite(r, sess.account_id)); });
route("POST", /^\/app\/v1\/rooms\/([0-9a-f-]{36})\/chat-invite$/, ({ sess, m, body }) => {
  const r = myRoom(sess, m[1]); const inv = chatInvite(r, sess.account_id);
  if (body.action === "renew") Object.assign(inv, { code: code(10), expires_at: later(86400), use_count: 0, off: false });
  else if (body.action === "off") inv.off = true; else if (body.action === "on") inv.off = false; else throw new E(400, "bad_request", "Bad action.");
  return inviteView(r, inv);
});
route("GET", /^\/app\/v1\/rooms\/([0-9a-f-]{36})\/person-invites$/, ({ sess, m }) => {
  const r = myRoom(sess, m[1]); if (r.owner !== sess.account_id) throw new E(403, "forbidden", "Owner only.");
  return { invites: [...db.personInvites.values()].filter((p) => p.room_id === r.id).reverse().map(pinvView) };
});
const pinvView = (p) => ({ id: p.id, room_id: p.room_id, url: `${ORIGIN}/p/${p.code}`, expires_at: p.expires_at, used: !!p.used_by, used_by_name: p.used_by ? db.accounts.get(p.used_by).display_name : null });
route("POST", /^\/app\/v1\/rooms\/([0-9a-f-]{36})\/person-invites$/, ({ sess, m, body, res }) => {
  const r = myRoom(sess, m[1]); if (r.owner !== sess.account_id) throw new E(403, "forbidden", "Owner only.");
  const ex = db.personInvites.get(body.id); if (ex) return pinvView(ex);
  const p = { id: body.id, room_id: r.id, code: code(16), expires_at: later(7 * 86400), used_by: null };
  db.personInvites.set(p.id, p); res.statusCode = 201; return pinvView(p);
});
const pinvByCode = (c) => { const p = [...db.personInvites.values()].find((x) => x.code === c.toUpperCase()); const r = p && db.rooms.get(p.room_id); if (!p || p.used_by || p.expires_at < now() || !r || r.deleted) throw new E(404, "invite_invalid", "This invite can't be used."); return [p, r]; };
route("GET", /^\/app\/v1\/person-invites\/([A-Za-z0-9]{16})$/, ({ sess, m }) => {
  const [p, r] = pinvByCode(m[1]);
  return { room: roomSummary(r, sess.account_id), owner_name: db.accounts.get(r.owner).display_name, expires_at: p.expires_at }; // no member names before approval
});
route("POST", /^\/app\/v1\/person-invites\/([A-Za-z0-9]{16})\/accept$/, ({ sess, m, body, res }) => {
  const [p, r] = pinvByCode(m[1]);
  if (inRoom(r, sess.account_id)) throw new E(409, "already_in_room", "Already in.");
  const d = db.devices.get(body.device_id); if (!d || d.account_id !== sess.account_id) throw new E(400, "bad_request", "Unknown device.");
  p.used_by = sess.account_id;
  const a = db.accounts.get(sess.account_id);
  const pr = { id: uuid(), room_id: r.id, room_name: r.name, account_id: a.id, display_name: a.display_name, email: a.email, provider: a.provider, device_pk: d.ed25519_pk, device_fingerprint: deviceFp(d.ed25519_pk), status: "pending", created_at: now() };
  db.personRequests.set(pr.id, pr); res.statusCode = 201; changed();
  return pr;
});

// what needs you + approvals
route("GET", /^\/app\/v1\/needs-you$/, ({ sess }) => ({
  join_requests: [...db.joinRequests.values()].filter((j) => j.status === "pending" && j.for_account === sess.account_id && Date.parse(j.expires_at) > Date.now()).map(({ for_account, status, session_id, turn_raw, readdressed_from, ...c }) => c),
  person_requests: [...db.personRequests.values()].filter((p) => p.status === "pending" && db.rooms.get(p.room_id).owner === sess.account_id),
  attention: [...db.attention.values()].filter((a) => !a.resolved && a.account === sess.account_id).map(({ account, resolved, ...a }) => ({ ...a, room_name: a.room_id ? db.rooms.get(a.room_id)?.name ?? null : null })),
  ended_join_requests: notifyMock.ended(sess.account_id),
  event_urls: eventUrlMock.needs(sess.account_id),
}));
route("POST", /^\/app\/v1\/join-requests\/([0-9a-f-]{36})\/approve$/, ({ sess, m, body }) => {
  const j = db.joinRequests.get(m[1]);
  if (!j || j.for_account !== sess.account_id) throw new E(404, "not_found", "Not found.");
  if (j.status !== "pending") throw new E(409, "already_decided", "Already decided.", { status: j.status });
  const r = db.rooms.get(j.room_id);
  const commit = consumeHumanCheck(sess, body.human_check, "approve_join", j.id);
  if (j.kind === "claim") {
    appendEntry(r, body.roster_entry, { op: "member_rekey", member: j.member_id, ed: j.ed25519_pk, x: j.x25519_pk });
    const mem = r.members.get(j.member_id); mem.ed = j.ed25519_pk; mem.x = j.x25519_pk; mem.machine = j.machine;
    activity(r, { kind: "moved", from_name: mem.name });
  } else {
    if (r.members.size >= 20) throw new E(409, "room_full", "Room full.");
    appendEntry(r, body.roster_entry, { op: "member_add", member: j.member_id, account: sess.account_id, name: j.name, app: j.app, ed: j.ed25519_pk, x: j.x25519_pk });
    r.members.set(j.member_id, { id: j.member_id, name: j.name, app: j.app, app_name: j.app_name ?? null, job: j.job, folder: j.folder, turn: j.turn_raw, account_id: sess.account_id, ed: j.ed25519_pk, x: j.x25519_pk, joined_at: now() });
    activity(r, { kind: "joined", from_name: j.name });
    membershipAttention(r, r.members.get(j.member_id), "member_joined", "joined", sess.account_id);
  }
  commit(); j.status = "approved"; changed();
  return memberView(r, r.members.get(j.member_id));
});
route("POST", /^\/app\/v1\/join-requests\/([0-9a-f-]{36})\/reject$/, ({ sess, m }) => {
  const j = db.joinRequests.get(m[1]); if (!j || j.for_account !== sess.account_id) throw new E(404, "not_found", "Not found.");
  if (j.status !== "pending") throw new E(409, "already_decided", "Already decided."); j.status = "rejected"; changed(); return { ok: true };
});
// item 11: another person of the room takes over a join that used someone else's chat invite (once)
const readdressable = (sess, id) => {
  const j = db.joinRequests.get(id); const r = j && db.rooms.get(j.room_id);
  if (!j || j.kind !== "join" || j.status !== "pending" || j.for_account === sess.account_id || j.readdressed_from || !r || r.deleted || !inRoom(r, sess.account_id)) throw new E(404, "not_found", "Not found.");
  return j;
};
route("GET", /^\/app\/v1\/join-requests\/([0-9a-f-]{36})\/readdress$/, ({ sess, m }) => {
  let j; try { j = readdressable(sess, m[1]); } catch { return { offer: null }; }
  return { offer: { id: j.id, room_id: j.room_id, room_name: j.room_name, name: j.name, app: j.app, app_name: j.app_name ?? null, machine: j.machine, folder: j.folder, invite_owner_name: db.accounts.get(j.for_account).display_name } };
});
route("POST", /^\/app\/v1\/join-requests\/([0-9a-f-]{36})\/readdress$/, ({ sess, m }) => {
  const j = readdressable(sess, m[1]);
  const from = db.accounts.get(j.for_account).display_name;
  Object.assign(j, { readdressed_from: j.for_account, for_account: sess.account_id, invite_label: `${from}'s chat invite for #${j.room_name} (you made it yours)`, readdressed_from_name: from });
  changed(); return { ok: true, id: j.id };
});
route("POST", /^\/app\/v1\/person-requests\/([0-9a-f-]{36})\/approve$/, ({ sess, m, body }) => {
  const p = db.personRequests.get(m[1]); const r = p && db.rooms.get(p.room_id);
  if (!p || r.owner !== sess.account_id) throw new E(404, "not_found", "Not found.");
  if (p.status !== "pending") throw new E(409, "already_decided", "Already decided.");
  const commit = consumeHumanCheck(sess, body.human_check, "approve_person", p.id);
  appendEntry(r, body.roster_entry, { op: "person_add", account: p.account_id, device: p.device_pk });
  r.people.set(p.account_id, { account_id: p.account_id, devices: new Set([p.device_pk]) }); r.signers.add(p.device_pk);
  activity(r, { kind: "person_joined", person_name: p.display_name });
  commit(); p.status = "approved"; chatInvite(r, p.account_id); changed();
  return roomDetail(r, sess.account_id);
});
route("POST", /^\/app\/v1\/person-requests\/([0-9a-f-]{36})\/reject$/, ({ sess, m }) => {
  const p = db.personRequests.get(m[1]); if (!p || db.rooms.get(p.room_id).owner !== sess.account_id) throw new E(404, "not_found", "Not found.");
  if (p.status !== "pending") throw new E(409, "already_decided", "Already decided."); p.status = "rejected"; changed(); return { ok: true };
});
// security review: mute a member for my chats; pause all my chats (wakes only; the mock just records them)
route("POST", /^\/app\/v1\/members\/([0-9a-f-]{36})\/mute$/, ({ sess, m, body }) => {
  const r = [...db.rooms.values()].find((x) => !x.deleted && x.members.has(m[1]) && inRoom(x, sess.account_id));
  if (!r) throw new E(404, "not_found", "Not found.");
  if (r.members.get(m[1]).account_id === sess.account_id) throw new E(403, "own_member", "That's your own chat.");
  if (typeof body.muted !== "boolean") throw new E(400, "bad_request", "muted is required.");
  const k = `${sess.account_id}>${m[1]}`; if (body.muted) db.mutes.add(k); else db.mutes.delete(k);
  changed(); return { member_id: m[1], muted: body.muted };
});
route("POST", /^\/app\/v1\/me\/sessions\/sign-out-others$/, ({ sess }) => {
  let n = 0; for (const [tok, x] of db.sessions) if (x !== sess && x.account_id === sess.account_id) { db.sessions.delete(tok); n++; }
  // like the server (account_guard.go): it also cancels a waiting account delete
  const cancelled = !!db.pendingDeletes?.delete(sess.account_id);
  if (cancelled) changed();
  return { signed_out: n, delete_cancelled: cancelled, first_passkey_removed: false };
});
route("POST", /^\/app\/v1\/me\/pause$/, ({ sess, body }) => {
  if (typeof body.paused !== "boolean") throw new E(400, "bad_request", "paused is required.");
  const a = db.accounts.get(sess.account_id); a.wakes_paused = body.paused ? now() : null;
  return { paused: !!a.wakes_paused, paused_at: a.wakes_paused };
});
route("POST", /^\/app\/v1\/members\/([0-9a-f-]{36})\/unstick$/, ({ sess, m }) => {
  for (const r of db.rooms.values()) { const mem = r.members.get(m[1]); if (mem) { if (mem.account_id !== sess.account_id) throw new E(403, "forbidden", "Not yours."); mem.stuck = false; for (const a of db.attention.values()) if (a.kind === "stuck" && a.subject_id === mem.id) a.resolved = true; changed(); return { requeued: 2 }; } }
  throw new E(404, "not_found", "Not found.");
});
route("POST", /^\/app\/v1\/attention\/([0-9a-f-]{36})\/dismiss$/, ({ sess, m }) => { const a = db.attention.get(m[1]); if (!a || a.account !== sess.account_id) throw new E(404, "not_found", "Not found."); a.resolved = true; changed(); return { ok: true }; });
route("GET", /^\/app\/v1\/events$/, ({ res }) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  res.write(": hello\n\n");
  sse.add(res);
  const hb = setInterval(() => res.write(": hb\n\n"), 20000);
  res.on("close", () => { clearInterval(hb); sse.delete(res); });
  return undefined;
}, { raw: true });

// ── admin area (owner only; same gate as server/internal/adminapi: 404 for everyone else) ──────────────────
const NOT_FOUND = () => new E(404, "not_found", "Not found.");
function adminGate({ sess, req }, needUnlock) {
  if (!ADMIN_EMAILS.length || !sess || !ADMIN_EMAILS.includes(db.accounts.get(sess.account_id).email)) throw NOT_FOUND();
  if (req.method !== "GET" && (req.headers["x-csrf-token"] !== sess.csrf || req.headers.origin !== ORIGIN)) throw new E(403, "csrf_failed", "CSRF check failed.");
  if (needUnlock && !(sess.admin_until > Date.now())) throw new E(403, "admin_locked", "Confirm it's you to open the admin area.", { unlock_minutes: 30 });
}
const maskEmail = (e) => { const [l, d] = e.split("@"); return `${l.slice(0, 2)}•••@${d}`; };
function adminOverview(sess) {
  const zero = () => ({ waiting: 0, shown: 0, done: 0, stuck: 0, needs_resend: 0, expired: 0 });
  const rooms = [...db.rooms.values()].filter((r) => !r.deleted);
  const members = rooms.flatMap((r) => [...r.members.values()].map((m) => ({ r, m })));
  const perRoom = rooms.map((r, i) => {
    const st = zero(); const k = r.members.size;
    Object.assign(st, { waiting: k ? 1 + i : 0, shown: k * 6, done: k * 14, stuck: [...r.members.values()].filter((m) => m.stuck).length, expired: k ? 1 : 0 });
    return { room_id: r.id, room_name: r.name, states: st };
  }).filter((x) => Object.values(x.states).some(Boolean));
  const total = zero(); for (const x of perRoom) for (const k of Object.keys(total)) total[k] += x.states[k];
  const labelOf = (m) => memberView(rooms.find((r) => r.members.has(m.id)), m).turn_label;
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  return {
    generated_at: now(), unlocked_until: new Date(sess.admin_until).toISOString(),
    totals: { accounts: db.accounts.size, rooms: rooms.length, members: members.length, messages_24h: members.length * 9, self_tests_24h: members.length ? 1 : 0, people_active_24h: db.sessions.size ? new Set([...db.sessions.values()].map((x) => x.account_id)).size : 0 },
    accounts: { total: db.accounts.size, items: [...db.accounts.values()].reverse().map((a, i) => ({ id: a.id, display_name: a.display_name, email: ADMIN_EMAILS.includes(a.email) ? a.email : maskEmail(a.email), is_admin: ADMIN_EMAILS.includes(a.email), created_at: ago(3600 * (i + 1)), last_seen_at: i % 3 === 2 ? null : ago(60 * (i + 1)), rooms: rooms.filter((r) => r.people.has(a.id)).length })) },
    rooms: { total: rooms.length, items: rooms.map((r, i) => ({ id: r.id, name: r.name, owner_name: db.accounts.get(r.owner).display_name, created_at: ago(7200 * (i + 1)), member_count: r.members.size, people_count: r.people.size })) },
    members: { total: members.length, items: members.map(({ r, m }, i) => ({ id: m.id, room_id: r.id, room_name: r.name, name: m.name, app: m.app, app_name: m.app_name ?? null, turn: m.turn, turn_label: labelOf(m), person_name: db.accounts.get(m.account_id).display_name, last_active_at: i % 4 === 3 ? null : ago(20 * (i + 1)), listening: i % 2 === 0, holder_present: i % 3 !== 2, stuck: !!m.stuck, joined_at: m.joined_at, removed: false, removed_at: null })) },
    copies: { total, per_room: perRoom, stuck_reasons: { attempts: total.stuck, wakes: 0, undecryptable: 0, bad_signature: 0, cannot_wake: 0 } },
    push: { always_on_members: 1, pending: 2, retrying: 1, failed: 3, failed_24h: 1, error_classes: [{ class: "timeout", count: 2 }, { class: "http_5xx", count: 1 }],
      recent_failures: members.length ? [{ room_name: members[0].r.name, member_name: members[0].m.name, tries: 8, error_class: "timeout", created_at: ago(5400) }] : [] },
    rate_limits: [["send:m", 60, 30, 1, 4], ["send:md", 86400, 1000, 0, 0], ["send:r", 60, 300, 0, 0], ["join:k", 3600, 5, 0, 0], ["join:i", 3600, 10, 0, 0], ["invfail:ip", 3600, 20, 2, 0], ["ask:m", 3600, 10, 0, 0], ["approve:a", 3600, 60, 0, 0], ["pinv:a", 86400, 20, 0, 0], ["dash:s", 60, 600, 0, 0], ["selftest:m", 3600, 10, 0, 0]]
      .map(([limit, window_s, max, hit, away]) => ({ limit, window_s, max, windows_at_limit_24h: hit, turned_away_24h: away, last_at: hit ? ago(900) : null, turned_away_this_copy: away ? 1 : 0 })),
    server: { copy_id: "mock", env: "dev", started_at: STARTED, uptime_s: Math.round((Date.now() - Date.parse(STARTED)) / 1000), ready: true, db_ok: true, listen_connected: true,
      open_polls: { inbox: 2, wait: 3 }, goroutines: 41, rss_bytes: 52 << 20,
      counters: { http_requests: 1843, http_4xx: 12, http_429: 4, http_5xx: 1, stuck: total.stuck, inbox_retries: 2, listen_reconnects: 0, push: { ok: 31, error: 3 } } },
    errors: { scope: "this_copy", copy_id: "mock", total: 1, items: [{ at: ago(1800), method: "POST", route: "POST /api/v1/me/inbox/lease", status: 503, request_id: "4f1c9a7be20d33aa61c0e5d2" }] },
  };
}
route("GET", /^\/app\/v1\/admin\/overview$/, (c) => { adminGate(c, true); return adminOverview(c.sess); }, { open: true, nocsrf: true });
route("GET", /^\/app\/v1\/admin\/status$/, (c) => { adminGate(c, false); const on = c.sess.admin_until > Date.now(); return { unlocked: on, unlocked_until: on ? new Date(c.sess.admin_until).toISOString() : null, unlock_minutes: 30 }; }, { open: true, nocsrf: true });
route("POST", /^\/app\/v1\/admin\/human-check$/, (c) => { adminGate(c, false); return newHumanCheck(c.sess, "admin", null); }, { open: true, nocsrf: true });
route("POST", /^\/app\/v1\/admin\/unlock$/, (c) => {
  adminGate(c, false);
  consumeHumanCheck(c.sess, c.body?.human_check, "admin", null)();
  c.sess.admin_until = Date.now() + 30 * 60e3;
  return { unlocked_until: new Date(c.sess.admin_until).toISOString() };
}, { open: true, nocsrf: true });
route("POST", /^\/app\/v1\/admin\/lock$/, (c) => { adminGate(c, false); c.sess.admin_until = 0; return { ok: true }; }, { open: true, nocsrf: true });
// any other /app/v1/admin/* path or method: the unknown-route 404 (falls through the router)

if (PAYWALL) installPlans({ route, E, adminGate, getAccount: (id) => db.accounts.get(id), accountByEmail, findAccountByEmail: (e) => [...db.accounts.values()].find((a) => a.email === e), maskEmail, ORIGIN });

installRecovery({ route, E, getDb: () => db, uuid, now, changed, appendEntry, consumeHumanCheck, newHumanCheck, syncDeviceAttention, devicePublic, accountByEmail, edOk });
installAccount({ route, E, getDb: () => db, appendEntry, consumeHumanCheck, changed, hcMode: HC_MODE, paywall: PAYWALL });
installStorage({ route, E, adminGate, getDb: () => db, maskEmail, adminEmails: ADMIN_EMAILS });
const notifyMock = installNotify({ route, E, getDb: () => db, changed });
installDrafts({ route, E, getDb: () => db, uuid, now, later, code, rawPk, memberFp, accountByEmail, appendEntry, consumeHumanCheck, buildRoom, storeRoom, roomDetail, activity, origin: ORIGIN });
const eventUrlMock = installEventUrls({ route, E, getDb: () => db, uuid, now, later, rawPk, accountByEmail, consumeHumanCheck, changed, origin: ORIGIN });
const batchMock = installBatch({ route, E, getDb: () => db, uuid, now, rawPk, deviceFp, appendEntry, consumeHumanCheck, activity, membershipAttention, changed });

// ── test hooks (never part of the real API) ──────────────────────────────────
route("POST", /^\/__mock\/reset$/, () => { reset(); return { ok: true }; }, { open: true, nocsrf: true });
route("POST", /^\/__mock\/join$/, ({ body }) => {
  const r = [...db.rooms.values()].find((x) => (body.room_id ? x.id === body.room_id : x.name === body.room) && !x.deleted);
  if (!r) throw new E(404, "not_found", "No room.");
  const forAcct = body.for_email ? accountByEmail(body.for_email).id : r.owner;
  const inv = chatInvite(r, forAcct); inv.use_count++;
  let memberId = uuid(), name = body.name || "bugfix";
  if (body.kind === "claim") { const mem = [...r.members.values()].find((x) => x.name === name); if (!mem) throw new E(404, "member_not_found", "No member."); memberId = mem.id; }
  const ed = body.ed || rawPk(), x = body.x || rawPk();
  const j = { id: uuid(), kind: body.kind || "join", room_id: r.id, room_name: r.name, member_id: memberId, name, job: body.job ?? "Fixed the checkout double-charge bug (commit a1b2c3). Knows the payment flow.", app: body.app || "claude-code", app_name: body.app_name ?? null,
    machine: body.machine || "adams-macbook", folder: body.folder || "~/acme", turn: body.turn || "wake", turn_raw: body.turn || "wake", match_code: body.match_code || code(6), ed25519_pk: ed, x25519_pk: x,
    invite_label: `your chat invite for #${r.name}`, created_at: now(), expires_at: later(body.expires_in_s || 900), for_account: forAcct, status: "pending" };
  db.joinRequests.set(j.id, j); changed();
  return { id: j.id, match_code: j.match_code, fingerprint: memberFp(ed, x), member_id: memberId };
}, { open: true, nocsrf: true });
route("POST", /^\/__mock\/attention$/, ({ body }) => {
  const r = body.room ? [...db.rooms.values()].find((x) => x.name === body.room && !x.deleted) : null;
  const acct = body.email ? accountByEmail(body.email).id : r.owner;
  const mem = r && body.member ? [...r.members.values()].find((x) => x.name === body.member) : null;
  if (mem && body.kind === "stuck") mem.stuck = true;
  const id = uuid();
  db.attention.set(id, { id, kind: body.kind, account: acct, room_id: r?.id ?? null, subject_id: mem?.id || uuid(), member_name: mem?.name ?? body.member ?? null, app: mem?.app ?? null, data: body.data || (body.kind === "stuck" ? { count: 3, reason: "attempts" } : {}), created_at: now() });
  changed(); return { id };
}, { open: true, nocsrf: true });
route("POST", /^\/__mock\/activity$/, ({ body }) => {
  const r = [...db.rooms.values()].find((x) => x.name === body.room && !x.deleted);
  for (const it of body.items || []) r.activity.unshift({ at: it.at || now(), kind: it.kind || "message", from_name: it.from ?? null, to_name: it.to ?? null, person_name: it.person ?? null });
  r.activity.sort((a, b) => (a.at < b.at ? 1 : -1));
  for (const a of r.activity) if (a.kind === "message" && !(r.last_message_at > a.at)) r.last_message_at = a.at; // rooms.last_message_at
  changed(); return { ok: true };
}, { open: true, nocsrf: true });
route("POST", /^\/__mock\/turn$/, ({ body }) => {
  const r = [...db.rooms.values()].find((x) => x.name === body.room && !x.deleted);
  const mem = [...r.members.values()].find((x) => x.name === body.member); mem.turn = body.turn; changed(); return { ok: true };
}, { open: true, nocsrf: true });

// ── server ───────────────────────────────────────────────────────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png", ".ico": "image/vnd.microsoft.icon" };
const send = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const cookie = (req, name) => (req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1];

async function serveFile(res, file, type, extra = {}) {
  const body = withSource(file, await readFile(file));
  res.writeHead(200, { "Content-Type": type, ...extra });
  res.end(body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  try {
    if (p.startsWith("/app/v1/") || p.startsWith("/__mock/")) {
      const r = routes.find((x) => x.method === req.method && x.re.test(p));
      if (!r) return send(res, 404, { error: { code: "not_found", message: "Not found." } });
      let body = null;
      if (req.method !== "GET") { let raw = ""; for await (const c of req) raw += c; body = raw ? JSON.parse(raw) : {}; }
      const token = cookie(req, "bl_session");
      const sess = token && db.sessions.get(token);
      if (!r.open && !sess) return send(res, 401, { error: { code: "unauthenticated", message: "Please sign in." } });
      if (req.method !== "GET" && !r.nocsrf && !r.open) {
        if (req.headers["x-csrf-token"] !== sess.csrf || req.headers.origin !== ORIGIN) return send(res, 403, { error: { code: "csrf_failed", message: "CSRF check failed." } });
      }
      const out = await r.fn({ req, res, url, body, sess, token, m: r.re.exec(p) });
      if (r.raw || out === undefined) return;
      return send(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out);
    }
    const docs = { "/agents.md": [join(ROOT, "docs", "agents.md"), "text/markdown; charset=utf-8"], "/llms.txt": [join(ROOT, "docs", "llms.txt"), "text/plain; charset=utf-8"], "/envelope.md": [join(ROOT, "crypto", "ENVELOPE.md"), "text/markdown; charset=utf-8"], "/api/openapi.yaml": [join(ROOT, "api", "openapi.yaml"), "application/yaml"] };
    if (docs[p]) return serveFile(res, ...docs[p]);
    if (p === "/healthz") { res.end("ok"); return; }
    if (p.startsWith("/assets/")) {
      const file = normalize(join(PUBLIC, p));
      if (!file.startsWith(PUBLIC)) { res.writeHead(404); return res.end(); }
      try { await stat(file); } catch { res.writeHead(404); return res.end("not found"); }
      return serveFile(res, file, MIME[extname(file)] || "application/octet-stream", { "Cache-Control": "public, max-age=300" });
    }
    if (/^\/[\w-][\w.-]*\.\w+$/.test(p) && p !== "/index.html" && (PAYWALL || !PAID_FILES.has(p))) { // other files at the root of web/public (favicon, manifest…), like the Go server
      const file = join(PUBLIC, p);
      try { if ((await stat(file)).isFile()) return serveFile(res, file, MIME[extname(file)] || "application/octet-stream", { "Cache-Control": "public, max-age=300" }); } catch { /* 404 below */ }
    }
    if (SPA.some((re) => re.test(p.replace(/\/$/, "") || "/"))) {
      return serveFile(res, join(PUBLIC, "index.html"), MIME[".html"], { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", ...(p === "/" ? {} : { "X-Robots-Tag": "noindex" }) });
    }
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found");
  } catch (e) {
    if (e instanceof E) {
      if (e.retryAfter) res.setHeader("Retry-After", String(e.retryAfter));
      return send(res, e.status, { error: { code: e.code, message: e.message, ...(e.retryAfter ? { retry_after_s: e.retryAfter } : {}), ...(e.details ? { details: e.details } : {}) } });
    }
    console.error(e);
    send(res, 500, { error: { code: "internal", message: "Something went wrong." } });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`mock bot-link on ${ORIGIN} (human check: ${HC_MODE}, paywall: ${PAYWALL ? "on" : "off"}, providers: ${PROVIDERS.join(",")})`));
