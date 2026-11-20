// bot-link web crypto: encodings, fingerprints, browser device key, signed member list (roster).
// Normative source: crypto/ENVELOPE.md (§0 encodings, §1 device key, §2 fingerprints, §5 roster).
// WebCrypto Ed25519 only (no fallback library); browsers without it get "use a recent browser".

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

// ── encodings ───────────────────────────────────────────────────────────────
export const utf8 = (s) => enc.encode(s);
export const fromUtf8 = (b) => dec.decode(b);

export function toHex(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
export function fromHex(hex) {
  if (typeof hex !== "string" || hex.length % 2 || /[^0-9a-f]/.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function b64urlEncode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s) {
  if (typeof s !== "string" || /[^A-Za-z0-9_-]/.test(s)) throw new Error("bad base64url");
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : s.length % 4 === 1 ? null : "";
  if (pad === null) throw new Error("bad base64url length");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const concat = (...parts) => {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
export async function sha256Hex(bytes) { return toHex(await sha256(bytes)); }

/** fp16: first 16 hex chars of sha256, grouped 4-4-4-4 (ENVELOPE §0). */
export async function fp16(bytes) {
  const h = (await sha256Hex(bytes)).slice(0, 16);
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`;
}
/** Member fingerprint: fp16(utf8(lower(ed) + "|" + lower(x))). */
export const memberFingerprint = (edHex, xHex) => fp16(utf8(`${edHex.toLowerCase()}|${xHex.toLowerCase()}`));
/** Device fingerprint: fp16(utf8("botlink-device-v1|" + lower(pk))). */
export const deviceFingerprint = (pkHex) => fp16(utf8(`botlink-device-v1|${pkHex.toLowerCase()}`));
/** Room fingerprint: fp16(genesis entry bytes). */
export const roomFingerprint = (genesisBytes) => fp16(genesisBytes);

// ── ids ─────────────────────────────────────────────────────────────────────
/** UUIDv7 (RFC 9562): 48-bit unix ms, version 7, variant 10, random rest. Lowercase canonical. */
export function uuidv7() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = (ms >>> 24) & 0xff;
  b[3] = (ms >>> 16) & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ── Ed25519 ─────────────────────────────────────────────────────────────────
export async function ed25519Supported() {
  try {
    if (!globalThis.crypto?.subtle) return false;
    const k = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    await crypto.subtle.sign("Ed25519", k.privateKey, new Uint8Array(1));
    return true;
  } catch { return false; }
}
export async function ed25519Verify(pkHex, sigHex, msg) {
  try {
    const key = await crypto.subtle.importKey("raw", fromHex(pkHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, fromHex(sigHex), msg);
  } catch { return false; }
}

// ── browser device key (IndexedDB db "botlink", store "device") ─────────────
const DB = "botlink", STORE = "device", SELF = "self";
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
/** Returns {id, pk, label, keyPair} or null. */
export async function loadDevice() {
  try { return (await idbDo("readonly", (s) => s.get(SELF))) || null; } catch { return null; }
}
/** Creates and stores a non-extractable Ed25519 device key (ENVELOPE §1). */
export async function createDevice(label) {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  const pk = toHex(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const dev = { id: uuidv7(), pk, label, keyPair, created_at: Date.now() };
  await idbDo("readwrite", (s) => s.put(dev, SELF));
  return dev;
}
export async function forgetDevice() { await idbDo("readwrite", (s) => s.delete(SELF)); }

export function deviceLabel(ua = navigator.userAgent) {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? (/Pixel/.test(ua) ? "Pixel" : "Android")
    : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "this computer";
  return `${browser} on ${os}`;
}

// ── strict JSON (rejects duplicate keys; ENVELOPE §0) ──────────────────────
export function strictParse(text) {
  let i = 0;
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  const fail = (m) => { throw new Error(`json: ${m} at ${i}`); };
  const str = () => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; i++; }
    if (text[i] !== '"') fail("unterminated string");
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const val = () => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++; const o = {}; const seen = new Set(); ws();
      if (text[i] === "}") { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') fail("key");
        const k = str(); if (seen.has(k)) fail(`duplicate key ${k}`); seen.add(k);
        ws(); if (text[i] !== ":") fail(":"); i++;
        o[k] = val(); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return o; }
        fail("object");
      }
    }
    if (c === "[") {
      i++; const a = []; ws();
      if (text[i] === "]") { i++; return a; }
      for (;;) {
        a.push(val()); ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return a; }
        fail("array");
      }
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) fail("value");
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const v = val(); ws();
  if (i !== text.length) fail("trailing data");
  return v;
}

// ── roster (ENVELOPE §5) ────────────────────────────────────────────────────
const ROSTER_CTX = utf8("botlink-roster-v1\n");
const HEX32 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MEMBER_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const ROOM_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const APPS = new Set(["claude-code", "codex", "cursor", "other"]);

/**
 * Build and sign one roster entry with this browser's device key.
 * `fields` = op-specific fields (e.g. {op:"member_add", member, account, name, app, ed, x}).
 * Returns the wire form {seq, entry, sig, signer} plus the raw bytes (for hashing).
 */
export async function signRosterEntry(device, { room, seq, prev, ...fields }) {
  const body = { v: 1, room, seq, prev: prev ?? null, at: Math.floor(Date.now() / 1000), ...fields, by: device.pk };
  const bytes = utf8(JSON.stringify(body));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", device.keyPair.privateKey, concat(ROSTER_CTX, bytes)));
  return { wire: { seq, entry: b64urlEncode(bytes), sig: toHex(sig), signer: device.pk }, bytes, body };
}

export class RosterError extends Error {
  constructor(rule, seq, msg) { super(`entry ${seq}: ${msg}`); this.seq = seq; this.rule = rule; }
}

/**
 * Verify a whole roster log (ENVELOPE §5.3). Throws RosterError {rule, seq} on the first failure.
 * Rule codes and check order are shared with client/ and server/ (crypto/vectors/README.md):
 * bad_wire → seq → bad_entry → seq → room → by → prev → sig → op shape → signer → op rules.
 * Returns {owner, roomName, people: Map(account → {name, devices:Set}), members: Map(id → {...}),
 *          headSeq, headHash, roomFp}.
 */
export async function verifyRoster(roomId, entries) {
  const fail = (rule, seq, msg) => { throw new RosterError(rule, seq, msg); };
  if (!Array.isArray(entries) || !entries.length) fail("seq", 0, "empty roster");
  const st = { owner: null, roomName: "", people: new Map(), members: new Map() };
  const isStr = (v, max = Infinity) => typeof v === "string" && [...v].length <= max;
  const deviceOf = (acct, pk) => st.people.get(acct)?.devices.has(pk) ?? false;
  const ownerDevice = (pk) => st.owner !== null && deviceOf(st.owner, pk);
  const deviceOwner = (pk) => { for (const [a, p] of st.people) if (p.devices.has(pk)) return a; return null; };
  const activeByName = (n) => [...st.members.values()].some((m) => m.name === n);
  const activeByEd = (ed, except) => [...st.members.values()].some((m) => m.ed === ed && m.id !== except);
  let prevHash = null, roomFp = null;

  for (let i = 0; i < entries.length; i++) {
    const w = entries[i];
    if (!w || typeof w !== "object" || !Number.isInteger(w.seq) || typeof w.entry !== "string" || typeof w.sig !== "string" || typeof w.signer !== "string" || !HEX32.test(w.signer)) fail("bad_wire", i, "malformed wire entry");
    if (w.seq !== i) fail("seq", i, `expected seq ${i}, got ${w.seq}`);
    let bytes, e;
    try {
      bytes = b64urlDecode(w.entry);
      if (bytes.byteLength > 4096) throw new Error("too long");
      e = strictParse(fromUtf8(bytes));
    } catch { fail("bad_entry", i, "entry bytes are not valid JSON"); }
    if (!e || typeof e !== "object" || Array.isArray(e) || e.v !== 1 || typeof e.room !== "string" || !Number.isInteger(e.seq) || !Number.isInteger(e.at) || typeof e.op !== "string" || typeof e.by !== "string") fail("bad_entry", i, "missing common fields");
    if (e.seq !== w.seq) fail("seq", i, "entry seq differs from wire seq");
    if (e.room !== roomId) fail("room", i, "entry is for another room");
    if (e.by !== w.signer) fail("by", i, "entry.by differs from signer");
    if (i === 0 ? e.prev !== null : e.prev !== prevHash) fail("prev", i, "hash chain broken");
    if (!/^[0-9a-f]{128}$/.test(w.sig) || !(await ed25519Verify(w.signer, w.sig, concat(ROSTER_CTX, bytes)))) fail("sig", i, "signature does not verify");
    const by = e.by, seq = i;
    if (e.op !== "genesis" && seq === 0) fail("op", seq, "first entry must be genesis");
    switch (e.op) {
      case "genesis": {
        if (seq !== 0) fail("op", seq, "genesis after seq 0");
        if (!isStr(e.name) || !ROOM_NAME.test(e.name) || !isStr(e.owner) || !UUID.test(e.owner) || !isStr(e.device) || !HEX32.test(e.device)) fail("op", seq, "bad genesis fields");
        if (by !== e.device) fail("signer", seq, "genesis must be signed by its device");
        st.owner = e.owner; st.roomName = e.name; roomFp = await roomFingerprint(bytes);
        st.people.set(e.owner, { name: null, devices: new Set([e.device]) });
        break;
      }
      case "device_add": {
        if (!UUID.test(e.account) || !HEX32.test(e.device) || !isStr(e.label, 200)) fail("op", seq, "bad device_add fields");
        if (!(deviceOf(e.account, by) || ownerDevice(by))) fail("signer", seq, "signer may not add this device");
        const p = st.people.get(e.account);
        if (!p) fail("op", seq, "device_add for someone not in the room");
        if (deviceOwner(e.device)) fail("op", seq, "device already in the room");
        p.devices.add(e.device);
        break;
      }
      case "device_remove": {
        if (!UUID.test(e.account) || !HEX32.test(e.device)) fail("op", seq, "bad device_remove fields");
        if (!(deviceOf(e.account, by) || ownerDevice(by))) fail("signer", seq, "signer may not remove this device");
        const p = st.people.get(e.account);
        if (!p || !p.devices.has(e.device)) fail("op", seq, "device_remove of an unknown device");
        p.devices.delete(e.device);
        break;
      }
      case "person_add": {
        if (!UUID.test(e.account) || !isStr(e.name, 80) || !e.name.length || !HEX32.test(e.device)) fail("op", seq, "bad person_add fields");
        if (!ownerDevice(by)) fail("signer", seq, "only the owner can add people");
        if (st.people.has(e.account)) fail("op", seq, "person already in the room");
        if (deviceOwner(e.device)) fail("op", seq, "device already in the room");
        st.people.set(e.account, { name: e.name, devices: new Set([e.device]) });
        break;
      }
      case "person_remove": {
        if (!UUID.test(e.account)) fail("op", seq, "bad person_remove fields");
        if (!(ownerDevice(by) || deviceOf(e.account, by))) fail("signer", seq, "signer may not remove this person");
        if (e.account === st.owner) fail("op", seq, "the owner cannot be removed");
        if (!st.people.has(e.account)) fail("op", seq, "person not in the room");
        st.people.delete(e.account);
        for (const [id, m] of st.members) if (m.account === e.account) st.members.delete(id);
        break;
      }
      case "member_add": {
        if (!UUID.test(e.member) || !UUID.test(e.account) || !isStr(e.name) || !MEMBER_NAME.test(e.name) || !APPS.has(e.app) || !HEX32.test(e.ed) || !HEX32.test(e.x)) fail("op", seq, "bad member_add fields");
        if (!deviceOf(e.account, by)) fail("signer", seq, "only that person's browser can add their chat");
        if (!st.people.has(e.account)) fail("op", seq, "member_add for someone not in the room");
        if (st.members.has(e.member)) fail("op", seq, "duplicate member id");
        if (activeByName(e.name)) fail("op", seq, "duplicate member name");
        if (activeByEd(e.ed)) fail("op", seq, "duplicate member key");
        st.members.set(e.member, { id: e.member, account: e.account, name: e.name, app: e.app, ed: e.ed, x: e.x, seq });
        break;
      }
      case "member_rekey": {
        if (!UUID.test(e.member) || !HEX32.test(e.ed) || !HEX32.test(e.x)) fail("op", seq, "bad member_rekey fields");
        const m = st.members.get(e.member);
        if (!m) fail("op", seq, "member_rekey of an unknown member");
        if (!deviceOf(m.account, by)) fail("signer", seq, "only that person's browser can move their chat");
        if (activeByEd(e.ed, m.id)) fail("op", seq, "duplicate member key");
        m.ed = e.ed; m.x = e.x; m.seq = seq;
        break;
      }
      case "member_remove": {
        if (!UUID.test(e.member)) fail("op", seq, "bad member_remove fields");
        const m = st.members.get(e.member);
        if (!m) fail("op", seq, "member_remove of an unknown member");
        if (!(by === m.ed || deviceOf(m.account, by) || ownerDevice(by))) fail("signer", seq, "signer may not remove this member");
        st.members.delete(m.id);
        break;
      }
      default: fail("op", seq, "unknown op");
    }
    prevHash = await sha256Hex(bytes);
  }
  return { owner: st.owner, roomName: st.roomName, people: st.people, members: st.members, headSeq: entries.length - 1, headHash: prevHash, roomFp };
}
