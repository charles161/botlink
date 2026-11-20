/**
 * Roster: the owner-device-signed, hash-chained member list (crypto/ENVELOPE.md §5).
 * The client never trusts the server's view: it replays the log from seq 0 and uses only the result.
 */
import { CTX_ROSTER, HEX32, UUID, b64urlDecode, b64urlEncode, parseStrictJson, roomFingerprint, sha256hex, signCtx, utf8Strict, verifyCtx, memberFingerprint } from "./crypto.js";

export interface SignedEntry {
  seq: number;
  entry: string;
  sig: string;
  signer: string;
}

export type App = "claude-code" | "codex" | "cursor" | "other";
export const APPS: App[] = ["claude-code", "codex", "cursor", "other"];
export const MEMBER_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
export const ROOM_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface RosterMember {
  id: string;
  account: string;
  name: string;
  app: App;
  ed: string;
  x: string;
  fp: string;
  added_seq: number;
  /** seq of the last member_add/member_rekey that set these keys */
  keys_seq: number;
  /** signer of the member_add */
  added_by: string;
  /**
   * The keys this member had before a member_rekey, newest last: each was the member's key from its own entry up to
   * (not including) the rekey at `until_seq`, signed at `until_at` (unix seconds, the rekey entry's own time).
   * A message the member signed with one of them before that moment is still its message (ENVELOPE §4, check 1b).
   */
  prev_keys: { ed: string; fp: string; until_seq: number; until_at: number }[];
}

export interface RosterState {
  room: string;
  room_name: string;
  owner: string;
  room_fp: string;
  /** account -> its current device keys */
  people: Map<string, { name: string | null; devices: Set<string> }>;
  members: Map<string, RosterMember>;
  removed: Set<string>;
  head_seq: number;
  head_hash: string;
  /** sha256 hex of every entry's bytes, by seq (rollback checks) */
  hashes: string[];
  /** member ids whose keys changed by member_rekey, with the seq */
  rekeys: { member: string; seq: number }[];
  /** members that are gone: left (own key signed), removed (a person's browser), or their person left */
  removals: { member: string; name: string; app: App; seq: number; how: "left" | "removed" | "person_left" }[];
}

/** Shared rule codes (also used in crypto/vectors/roster.json and by the server's `roster_invalid` details.rule). */
export type RosterRule =
  | "bad_wire" // wire object malformed (seq/entry/sig/signer shape)
  | "bad_entry" // entry bytes not strict UTF-8 JSON / missing or malformed common fields
  | "seq" // §5.3.1 seq not contiguous from 0, or entry.seq != wire.seq
  | "room" // §5.3.1 entry.room != room id
  | "by" // §5.3.1 entry.by != wire.signer
  | "prev" // §5.3.2 prev != sha256(previous entry bytes) (or not null at seq 0)
  | "sig" // §5.3.3 signature does not verify
  | "signer" // §5.3.4 signer not allowed for this op
  | "op"; // §5.3.5 op-specific validity (duplicates, unknown refs, owner removal, bad fields, unknown op)

export class RosterError extends Error {
  constructor(public rule: RosterRule, public seq: number, msg: string) {
    super(`roster entry ${seq}: ${msg}`);
  }
}

const isStr = (v: unknown, max = 10_000): v is string => typeof v === "string" && v.length <= max;

function fail(rule: RosterRule, seq: number, msg: string): never {
  throw new RosterError(rule, seq, msg);
}

/** Verify a whole log. Throws RosterError on the first failure (the whole roster is then invalid). */
export function verifyRoster(roomId: string, entries: SignedEntry[]): RosterState {
  if (!Array.isArray(entries) || entries.length === 0) fail("seq", 0, "empty roster");
  const st: RosterState = {
    room: roomId, room_name: "", owner: "", room_fp: "", people: new Map(), members: new Map(), removed: new Set(),
    head_seq: -1, head_hash: "", hashes: [], rekeys: [], removals: [],
  };
  let prevHash: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const w = entries[i];
    if (!w || typeof w !== "object" || !Number.isInteger(w.seq) || typeof w.entry !== "string" || typeof w.sig !== "string" || typeof w.signer !== "string" || !HEX32.test(w.signer)) {
      fail("bad_wire", i, "malformed wire entry");
    }
    if (w.seq !== i) fail("seq", i, `expected seq ${i}, got ${w.seq}`);
    let bytes: Buffer;
    let e: any;
    try {
      bytes = b64urlDecode(w.entry);
      if (bytes.byteLength > 4096) throw new Error("too long");
      e = parseStrictJson(utf8Strict(bytes));
    } catch {
      fail("bad_entry", i, "entry bytes are not valid JSON");
    }
    if (!e || typeof e !== "object" || Array.isArray(e) || e.v !== 1 || typeof e.room !== "string" || !Number.isInteger(e.seq) || !Number.isInteger(e.at) || typeof e.op !== "string" || typeof e.by !== "string") {
      fail("bad_entry", i, "missing common fields");
    }
    if (e.seq !== w.seq) fail("seq", i, "entry seq differs from wire seq");
    if (e.room !== roomId) fail("room", i, "entry is for another room");
    if (e.by !== w.signer) fail("by", i, "entry.by differs from signer");
    if (i === 0 ? e.prev !== null : e.prev !== prevHash) fail("prev", i, "hash chain broken");
    if (!verifyCtx(CTX_ROSTER, bytes, w.sig, w.signer)) fail("sig", i, "signature does not verify");
    apply(st, e, i, bytes);
    prevHash = sha256hex(bytes);
    st.hashes.push(prevHash);
    st.head_seq = i;
    st.head_hash = prevHash;
  }
  return st;
}

function deviceOwner(st: RosterState, pk: string): string | null {
  for (const [acct, p] of st.people) if (p.devices.has(pk)) return acct;
  return null;
}
const ownerDevice = (st: RosterState, pk: string) => !!st.people.get(st.owner)?.devices.has(pk);
const deviceOf = (st: RosterState, acct: string, pk: string) => !!st.people.get(acct)?.devices.has(pk);

function activeByName(st: RosterState, name: string, except?: string) {
  for (const m of st.members.values()) if (m.name === name && m.id !== except) return m;
  return null;
}
function activeByEd(st: RosterState, ed: string, except?: string) {
  for (const m of st.members.values()) if (m.ed === ed && m.id !== except) return m;
  return null;
}

function apply(st: RosterState, e: any, seq: number, bytes: Buffer) {
  const by: string = e.by;
  switch (e.op) {
    case "genesis": {
      if (seq !== 0) fail("op", seq, "genesis after seq 0");
      if (!isStr(e.name) || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(e.name) || !isStr(e.owner) || !UUID.test(e.owner) || !isStr(e.device) || !HEX32.test(e.device)) fail("op", seq, "bad genesis fields");
      if (by !== e.device) fail("signer", seq, "genesis must be signed by its device");
      st.owner = e.owner;
      st.room_name = e.name;
      st.room_fp = roomFingerprint(bytes);
      st.people.set(e.owner, { name: null, devices: new Set([e.device]) });
      return;
    }
    case "device_add": {
      if (seq === 0) fail("op", seq, "first entry must be genesis");
      if (!UUID.test(e.account) || !HEX32.test(e.device) || !isStr(e.label, 200)) fail("op", seq, "bad device_add fields");
      if (!(deviceOf(st, e.account, by) || ownerDevice(st, by))) fail("signer", seq, "device_add not signed by that person's device or an owner device");
      const p = st.people.get(e.account);
      if (!p) fail("op", seq, "device_add for someone not in the room");
      if (deviceOwner(st, e.device)) fail("op", seq, "device already in the room");
      p.devices.add(e.device);
      return;
    }
    case "device_remove": {
      if (seq === 0) fail("op", seq, "first entry must be genesis");
      if (!UUID.test(e.account) || !HEX32.test(e.device)) fail("op", seq, "bad device_remove fields");
      if (!(deviceOf(st, e.account, by) || ownerDevice(st, by))) fail("signer", seq, "device_remove not signed by that person's device or an owner device");
      const p = st.people.get(e.account);
      if (!p || !p.devices.has(e.device)) fail("op", seq, "device_remove of an unknown device");
      p.devices.delete(e.device);
      return;
    }
    case "person_add": {
      if (seq === 0) fail("op", seq, "first entry must be genesis");
      if (!UUID.test(e.account) || !isStr(e.name, 80) || !e.name.length || !HEX32.test(e.device)) fail("op", seq, "bad person_add fields");
      if (!ownerDevice(st, by)) fail("signer", seq, "person_add not signed by an owner device");
      if (st.people.has(e.account)) fail("op", seq, "person already in the room");
      if (deviceOwner(st, e.device)) fail("op", seq, "device already in the room");
      st.people.set(e.account, { name: e.name, devices: new Set([e.device]) });
      return;
    }
    case "person_remove": {
      if (seq === 0) fail("op", seq, "first entry must be genesis");
      if (!UUID.test(e.account)) fail("op", seq, "bad person_remove fields");
      if (!(ownerDevice(st, by) || deviceOf(st, e.account, by))) fail("signer", seq, "person_remove not signed by an owner device or the person's device");
      if (e.account === st.owner) fail("op", seq, "the owner cannot be removed");
      if (!st.people.has(e.account)) fail("op", seq, "person_remove of someone not in the room");
      st.people.delete(e.account);
      for (const m of [...st.members.values()]) if (m.account === e.account) {
        st.members.delete(m.id);
        st.removed.add(m.id);
        st.removals.push({ member: m.id, name: m.name, app: m.app, seq, how: by === m.ed ? "left" : deviceOf(st, e.account, by) ? "person_left" : "removed" });
      }
      return;
    }
    case "member_add": {
      if (seq === 0) fail("op", seq, "first entry must be genesis");
      if (!UUID.test(e.member) || !UUID.test(e.account) || !isStr(e.name) || !MEMBER_NAME.test(e.name) || !APPS.includes(e.app) || !HEX32.test(e.ed) || !HEX32.test(e.x)) {
        fail("op", seq, "bad member_add fields");
      }
      if (!deviceOf(st, e.account, by)) fail("signer", seq, "member_add not signed by a device of that person");
      if (!st.people.has(e.account)) fail("op", seq, "member_add for someone not in the room");
      if (st.members.has(e.member)) fail("op", seq, "duplicate member id");
      if (activeByName(st, e.name)) fail("op", seq, "duplicate member name");
      if (activeByEd(st, e.ed)) fail("op", seq, "duplicate member key");
      st.members.set(e.member, { id: e.member, account: e.account, name: e.name, app: e.app, ed: e.ed, x: e.x, fp: memberFingerprint(e.ed, e.x), added_seq: seq, keys_seq: seq, added_by: by, prev_keys: [] });
      return;
    }
    case "member_rekey": {
      if (seq === 0) fail("op", seq, "first entry must be genesis");
      if (!UUID.test(e.member) || !HEX32.test(e.ed) || !HEX32.test(e.x)) fail("op", seq, "bad member_rekey fields");
      const m = st.members.get(e.member);
      if (!m) fail("op", seq, "member_rekey of an unknown member");
      if (!deviceOf(st, m.account, by)) fail("signer", seq, "member_rekey not signed by a device of the member's person");
      if (activeByEd(st, e.ed, m.id)) fail("op", seq, "duplicate member key");
      m.prev_keys.push({ ed: m.ed, fp: m.fp, until_seq: seq, until_at: e.at });
      m.ed = e.ed;
      m.x = e.x;
      m.fp = memberFingerprint(e.ed, e.x);
      m.keys_seq = seq;
      st.rekeys.push({ member: m.id, seq });
      return;
    }
    case "member_remove": {
      if (seq === 0) fail("op", seq, "first entry must be genesis");
      if (!UUID.test(e.member)) fail("op", seq, "bad member_remove fields");
      const m = st.members.get(e.member);
      if (!m) fail("op", seq, "member_remove of an unknown member");
      if (!(by === m.ed || deviceOf(st, m.account, by) || ownerDevice(st, by))) fail("signer", seq, "member_remove not signed by the member, its person's device or an owner device");
      st.members.delete(m.id);
      st.removed.add(m.id);
      st.removals.push({ member: m.id, name: m.name, app: m.app, seq, how: by === m.ed ? "left" : "removed" });
      return;
    }
    default:
      fail("op", seq, `unknown op ${JSON.stringify(String(e.op)).slice(0, 40)}`);
  }
}

// ------------------------------------------------------------------ building entries (leave; tests; fake server)
export function makeEntry(fields: Record<string, unknown>, seq: number, prevHash: string | null, signerPk: string, signerSeed: string, at = Math.floor(Date.now() / 1000)): SignedEntry {
  // common fields keep their documented order; op fields follow
  const ordered: Record<string, unknown> = { v: 1, room: fields.room, seq, prev: prevHash, at, op: fields.op, by: signerPk };
  for (const [k, v] of Object.entries(fields)) if (!(k in ordered)) ordered[k] = v;
  const bytes = Buffer.from(JSON.stringify(ordered), "utf-8");
  return { seq, entry: b64urlEncode(bytes), sig: signCtx(CTX_ROSTER, bytes, signerSeed), signer: signerPk };
}

export function entryBytes(w: SignedEntry): Buffer {
  return b64urlDecode(w.entry);
}

export function entryHash(w: SignedEntry): string {
  return sha256hex(entryBytes(w));
}

export function decodeEntry(w: SignedEntry): any {
  return JSON.parse(entryBytes(w).toString("utf-8"));
}

// ------------------------------------------------------------------ pins (ENVELOPE §5.4)
export interface Pin {
  room_fp: string;
  head_seq: number;
  head_hash: string;
  /** member id -> fingerprint we last accepted */
  keys: Record<string, string>;
}

export type PinCheck =
  | { ok: true; moved: { member: string; name: string; fp: string }[] }
  | { ok: false; why: string };

/** Compare a freshly verified roster with what we pinned: same genesis, append-only, keys only change via rekey. */
export function checkPin(pin: Pin | null, st: RosterState): PinCheck {
  if (!pin) return { ok: true, moved: [] };
  if (pin.room_fp !== st.room_fp) return { ok: false, why: "room fingerprint changed" };
  if (st.head_seq < pin.head_seq || st.hashes[pin.head_seq] !== pin.head_hash) return { ok: false, why: "member list was rewritten (rollback or fork)" };
  const moved: { member: string; name: string; fp: string }[] = [];
  for (const [id, fp] of Object.entries(pin.keys)) {
    const m = st.members.get(id);
    if (!m || m.fp === fp) continue;
    // the key changed: only acceptable through a member_rekey after the pinned head
    if (!st.rekeys.some((r) => r.member === id && r.seq > pin.head_seq)) return { ok: false, why: `key of ${m.name} changed without a move` };
    moved.push({ member: id, name: m.name, fp: m.fp });
  }
  return { ok: true, moved };
}

export function pinOf(st: RosterState): Pin {
  const keys: Record<string, string> = {};
  for (const m of st.members.values()) keys[m.id] = m.fp;
  return { room_fp: st.room_fp, head_seq: st.head_seq, head_hash: st.head_hash, keys };
}

/**
 * Approval self-check (ENVELOPE §5.4): a member_add (join) or member_rekey (claim) with MY member id and MY keys,
 * signed by a current device of the inviting person's account. `account` is that account, as the client learned it
 * before the approval (required: without it a valid entry signed by ANOTHER person of the room, for their own
 * account, would pass).
 */
export function selfCheck(st: RosterState, entries: SignedEntry[], me: { member: string; ed: string; x: string }, kind: "join" | "claim", account: string): string | null {
  const m = st.members.get(me.member);
  if (!m) return "this chat is not in the verified member list";
  if (m.ed !== me.ed || m.x !== me.x) return "the member list has a different key for this chat";
  // find the entry that set these keys and check its signer was a device of the member's account at that time
  const e = decodeEntry(entries[m.keys_seq]);
  const wantOp = kind === "join" ? "member_add" : "member_rekey";
  if (e.op !== wantOp && !(kind === "claim" && e.op === "member_add")) return "the approval is not the expected kind";
  if (!account || m.account !== account) return "the approval was made for someone else";
  // replay up to keys_seq - 1 to learn who the devices were at that point
  const before = verifyRoster(st.room, entries.slice(0, m.keys_seq));
  if (!before.people.get(m.account)?.devices.has(e.by)) return "the approval was not signed by a device of the inviting person";
  return null;
}

/**
 * The self-check for a room this chat asked for (docs/protocol/room-drafts.md §6): the roster verified from genesis
 * (`st`), and in it this chat's own member_add, with its keys, the draft's member id and its name, for the room's
 * owner (the genesis account) and signed by a device of that owner. `approver`: the account the server says confirmed
 * it, when it says one: it must be the owner too.
 */
export function createSelfCheck(st: RosterState, entries: SignedEntry[], me: { member: string; ed: string; x: string; name: string }, approver?: string | null): string | null {
  if (!st.owner) return "the member list has no owner";
  if (approver && approver !== st.owner) return "the room was confirmed by someone other than its owner";
  const m = st.members.get(me.member);
  if (m && m.name !== me.name) return "the member list has another name for this chat";
  return selfCheck(st, entries, { member: me.member, ed: me.ed, x: me.x }, "join", st.owner);
}

// ------------------------------------------------------------------ membership changes (SPEC §6.10a)
/** What a chat last knew about the room's members (local only): member id -> name/app/key fingerprint. */
export interface RosterSnap {
  head_seq: number;
  members: Record<string, { name: string; app: App; fp: string }>;
}

export function snapOf(st: RosterState): RosterSnap {
  const members: RosterSnap["members"] = {};
  for (const m of st.members.values()) members[m.id] = { name: m.name, app: m.app, fp: m.fp };
  return { head_seq: st.head_seq, members };
}

export interface RosterDiff {
  joined: RosterMember[];
  gone: { member: string; name: string; app: App; how: "left" | "removed" | "person_left" }[];
}

/** Members that joined / are gone since `snap` (self excluded). Joins and departures in between cancel out. */
export function rosterDiff(snap: RosterSnap, st: RosterState, self: string): RosterDiff {
  const joined = [...st.members.values()].filter((m) => m.id !== self && !snap.members[m.id]);
  const gone: RosterDiff["gone"] = [];
  for (const [id, was] of Object.entries(snap.members)) {
    if (id === self || st.members.has(id)) continue;
    const r = [...st.removals].reverse().find((x) => x.member === id);
    gone.push({ member: id, name: was.name, app: was.app, how: r?.how ?? "removed" });
  }
  return { joined, gone };
}
