/**
 * The signed note "my human said yes" (crypto/ENVELOPE.md §4a, SPEC §7.3b). Pure: no files, no network, no clock
 * unless the caller passes one. Imported by the client and, for the room report, by anything that holds a room's
 * verified member list.
 *
 * A note rides inside a sealed message (its plaintext `note` field). The message signature covers only the
 * ciphertext, so only the recipient can check who sent the words. The note carries its own signature by the
 * approving member's key over its exact body bytes, so anyone holding the room's signed member list can check it
 * without any key to open messages and without trusting the server.
 *
 * What it proves: the approving chat's client, holding that member's key, recorded a yes it saw typed by its human
 * (in the chat, caught by the prompt hook, or in the human's own terminal). It does not prove the human understood
 * the request, and a computer that is taken over can sign anything with its own key. Evidence, not enforcement.
 */
import { HEX32, HEX_SIG, UUID, b64urlDecode, b64urlEncode, parseStrictJson, signCtx, utf8Strict, verifyCtx } from "./crypto.js";
import { PREV_KEY_GRACE_S, PREV_KEY_SKEW_S } from "./envelope.js";
import type { RosterState } from "./roster.js";

export const CTX_YES = "botlink-yes-v1";
export const NOTE_BODY_MAX = 2048;
export const SUMMARY_MAX = 200;
export const PERSON_MAX = 80;

export const ACTIONS = ["read_files", "run_command", "change_files", "send_outside", "spend_money", "other"] as const;
export type Action = (typeof ACTIONS)[number];
/** What a person reads for each action. */
export const ACTION_SAYS: Record<Action, string> = {
  read_files: "read files",
  run_command: "run a command",
  change_files: "change files",
  send_outside: "send something outside the room",
  spend_money: "spend money",
  other: "something else",
};
/** The words a chat may use for an action ("run a command", "run-command", "run_command"). */
export function parseAction(s: unknown): Action | null {
  const k = String(s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/^(?:to_)?/, "");
  if ((ACTIONS as readonly string[]).includes(k)) return k as Action;
  for (const a of ACTIONS) if (ACTION_SAYS[a].replace(/\s+/g, "_") === k) return a;
  return null;
}

/** The settings a standing grant can give (perms.ts levels above muted). */
export const GRANT_SETTINGS = ["answer", "files", "tasks"] as const;
export type GrantSetting = (typeof GRANT_SETTINGS)[number];

const FP16 = /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;
/** No control characters, no line breaks, no invisible format characters: one line a person reads as it is. */
const ONE_LINE_BAD = new RegExp("[\\x00-\\x1f\\x7f-\\x9f\\u2028\\u2029\\p{Cf}]", "u");

export interface NoteBy {
  /** the approving member (the chat whose human said yes): its id, its key's fingerprint, its person's account */
  member: string;
  fp: string;
  account: string;
  /** the person's name as the approving client knew it (checked against the signed member list when it has one) */
  person: string | null;
}
export interface YesBody {
  v: 1;
  kind: "yes";
  /** the id of the message that carries this note */
  id: string;
  room: string;
  at: number;
  by: NoteBy;
  /** where the human said it: typed in the chat (caught by the prompt hook) or in their own terminal */
  how: "chat" | "terminal";
  /** the request: its message id, its sender and that sender's key, and sha256 of its text */
  request: { id: string; from: string; from_fp: string; text_sha256: string };
  action: Action;
  /** what the human was shown (written by the approving chat, at most 200 characters, one line) */
  summary: string;
}
export interface AllowBody {
  v: 1;
  kind: "allow";
  id: string;
  room: string;
  at: number;
  by: NoteBy;
  how: "chat" | "terminal";
  /** the member that was given more, and what */
  grant: { member: string; fp: string; setting: GrantSetting; while_away: boolean };
}
export type NoteBody = YesBody | AllowBody;

/** On the wire, inside a message's sealed plaintext as `note`. `device` is reserved for a later countersignature by
 *  the person's browser device; v1 never makes one and never checks one. */
export interface NoteWire {
  v: 1;
  body: string;
  sig: string;
  device?: null | { pk: string; sig: string };
}

const keysAre = (o: any, keys: string[]) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
/** One line of 1..max characters a person reads as it is (a summary, a person's name in a note). */
export const isLine = (s: unknown, max: number): s is string => typeof s === "string" && s.length > 0 && [...s].length <= max && s.trim() === s && !ONE_LINE_BAD.test(s);

/** Why a body is malformed, or null. */
export function bodyProblem(b: any): string | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "not an object";
  if (b.v !== 1) return "v";
  const common = ["v", "kind", "id", "room", "at", "by", "how"];
  if (b.kind === "yes") {
    if (!keysAre(b, [...common, "request", "action", "summary"])) return "fields";
  } else if (b.kind === "allow") {
    if (!keysAre(b, [...common, "grant"])) return "fields";
  } else return "kind";
  if (typeof b.id !== "string" || !UUID.test(b.id)) return "id";
  if (typeof b.room !== "string" || !UUID.test(b.room)) return "room";
  if (!Number.isSafeInteger(b.at) || b.at <= 0) return "at";
  if (b.how !== "chat" && b.how !== "terminal") return "how";
  const by = b.by;
  if (!keysAre(by, ["member", "fp", "account", "person"])) return "by";
  if (typeof by.member !== "string" || !UUID.test(by.member) || typeof by.fp !== "string" || !FP16.test(by.fp) || typeof by.account !== "string" || !UUID.test(by.account)) return "by";
  if (by.person !== null && !isLine(by.person, PERSON_MAX)) return "by.person";
  if (b.kind === "yes") {
    const r = b.request;
    if (!keysAre(r, ["id", "from", "from_fp", "text_sha256"])) return "request";
    if (typeof r.id !== "string" || !UUID.test(r.id) || typeof r.from !== "string" || !UUID.test(r.from) || typeof r.from_fp !== "string" || !FP16.test(r.from_fp) || typeof r.text_sha256 !== "string" || !HEX32.test(r.text_sha256)) return "request";
    if (!(ACTIONS as readonly string[]).includes(b.action)) return "action";
    if (!isLine(b.summary, SUMMARY_MAX)) return "summary";
  } else {
    const g = b.grant;
    if (!keysAre(g, ["member", "fp", "setting", "while_away"])) return "grant";
    if (typeof g.member !== "string" || !UUID.test(g.member) || typeof g.fp !== "string" || !FP16.test(g.fp) || typeof g.while_away !== "boolean") return "grant";
    if (!(GRANT_SETTINGS as readonly string[]).includes(g.setting)) return "grant.setting";
  }
  return null;
}

/** The exact body bytes (fields in the documented order) and the note that carries them, signed with the member's
 *  seed. Throws when the body is malformed. */
export function makeNote(b: NoteBody, seedHex: string): NoteWire {
  const bad = bodyProblem(b);
  if (bad) throw new Error(`note body: bad ${bad}`);
  const by = { member: b.by.member, fp: b.by.fp, account: b.by.account, person: b.by.person };
  const common = { v: 1, kind: b.kind, id: b.id, room: b.room, at: b.at, by, how: b.how };
  const ordered =
    b.kind === "yes"
      ? { ...common, request: { id: b.request.id, from: b.request.from, from_fp: b.request.from_fp, text_sha256: b.request.text_sha256 }, action: b.action, summary: b.summary }
      : { ...common, grant: { member: b.grant.member, fp: b.grant.fp, setting: b.grant.setting, while_away: b.grant.while_away } };
  const bytes = Buffer.from(JSON.stringify(ordered), "utf-8");
  if (bytes.byteLength > NOTE_BODY_MAX) throw new Error("note body: too long");
  return { v: 1, body: b64urlEncode(bytes), sig: signCtx(CTX_YES, bytes, seedHex) };
}

/** Rule codes, in the order they are checked (crypto/vectors/yes-note.json uses them). */
export type NoteRule =
  | "bad_wire" // the note object: v 1, body a base64url string, sig 128 hex, nothing else but the reserved device
  | "bad_body" // body bytes: base64url, at most 2048, strict UTF-8 JSON without duplicate keys, exact fields and values
  | "room" // body.room is not this room (or not the room of the message that carries it)
  | "signer" // by.member is not an active member, by.account is not its person, by.fp is not one of its keys, or an earlier key outside check 1b's window
  | "sig" // the Ed25519 signature over "botlink-yes-v1\n" + body bytes does not verify with that key
  | "sender" // the message that carries it was not sent by by.member with by.fp
  | "id" // body.id is not the id of the message that carries it (nor the message it re-sends)
  | "person" // by.person differs from the person's name in the signed member list
  | "request"; // the approving chat is the requester (yes), or the member it grants to (allow)

export interface NoteHeader {
  id: string;
  room: string;
  from: string;
  from_fp: string;
}

export type NoteCheck =
  | {
      ok: true;
      kind: NoteBody["kind"];
      body: NoteBody;
      signer: { name: string; account: string; person: string | null; person_signed: boolean; earlier_key?: { fp: string; until_at: number } };
      device: "absent" | "not_checked";
    }
  | { ok: false; rule: NoteRule; reason: string };

const no = (rule: NoteRule, reason: string): NoteCheck => ({ ok: false, rule, reason });

/**
 * Check a note against a VERIFIED member list (roster.ts verifyRoster). `header`: the signed header of the message
 * that carries it, when there is one (ENVELOPE §4; null for a note checked on its own). `now` (unix seconds) bounds
 * an earlier key as check 1b does; `resendOf`: the carrying message's plaintext `resend_of`.
 */
export function verifyNote(note: unknown, header: NoteHeader | null, roster: RosterState, o: { now?: number; resendOf?: string | null } = {}): NoteCheck {
  const n = note as any;
  if (!n || typeof n !== "object" || Array.isArray(n) || n.v !== 1 || typeof n.body !== "string" || typeof n.sig !== "string" || !HEX_SIG.test(n.sig)) return no("bad_wire", "not a v1 note");
  if (Object.keys(n).some((k) => !["v", "body", "sig", "device"].includes(k))) return no("bad_wire", "unknown field in the note");
  let bytes: Buffer;
  let b: any;
  try {
    bytes = b64urlDecode(n.body);
    if (bytes.byteLength > NOTE_BODY_MAX) throw new Error("too long");
    b = parseStrictJson(utf8Strict(bytes));
  } catch {
    return no("bad_body", "the note's body is not valid");
  }
  const bad = bodyProblem(b);
  if (bad) return no("bad_body", `the note's body has a bad ${bad}`);
  const body = b as NoteBody;
  if (body.room !== roster.room || (header && header.room !== body.room)) return no("room", "the note is for another room");
  const m = roster.members.get(body.by.member);
  if (!m) return no("signer", "the chat that signed it is not in the signed member list");
  if (m.account !== body.by.account) return no("signer", "the note names another person for that chat");
  let key: { ed: string; earlier?: { fp: string; until_at: number } } | null = null;
  if (body.by.fp === m.fp) key = { ed: m.ed };
  else {
    const p = m.prev_keys.find((k) => k.fp === body.by.fp);
    if (!p) return no("signer", "the note names a key that chat never had");
    key = { ed: p.ed, earlier: { fp: p.fp, until_at: p.until_at } };
  }
  if (!verifyCtx(CTX_YES, bytes, n.sig, key.ed)) return no("sig", "the signature does not verify");
  if (key.earlier) {
    // ENVELOPE §4 check 1b: the earlier key spoke for the member until its move, and only for a message's lifetime after
    const now = o.now ?? Math.floor(Date.now() / 1000);
    if (body.at > key.earlier.until_at + PREV_KEY_SKEW_S) return no("signer", "signed with a key that chat gave up before");
    if (now > key.earlier.until_at + PREV_KEY_GRACE_S) return no("signer", "signed with a key that chat gave up too long ago");
  }
  if (header && (header.from !== body.by.member || header.from_fp !== body.by.fp)) return no("sender", "the note came in a message from another chat than the one that signed it");
  if (header && body.id !== header.id && !(o.resendOf && body.id === o.resendOf)) return no("id", "the note belongs to another message");
  const signedName = roster.people.get(m.account)?.name ?? null;
  if (signedName !== null && body.by.person !== signedName) return no("person", "the person's name differs from the signed member list");
  if (body.kind === "yes" && body.request.from === body.by.member) return no("request", "a chat cannot say yes to its own request");
  if (body.kind === "allow" && body.grant.member === body.by.member) return no("request", "a chat cannot give itself more");
  return {
    ok: true,
    kind: body.kind,
    body,
    signer: { name: m.name, account: m.account, person: signedName ?? body.by.person, person_signed: signedName !== null, ...(key.earlier ? { earlier_key: key.earlier } : {}) },
    device: n.device === undefined || n.device === null ? "absent" : "not_checked",
  };
}
