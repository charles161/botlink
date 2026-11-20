/** Message envelope v3 (crypto/ENVELOPE.md §4). */
import type { NoteWire } from "./yesnote.js";
import { CTX_ENV, UUID, b64stdDecode, b64urlDecode, b64urlEncode, HEX32, memberFingerprint, openSealedBytes, parseStrictJson, seal, sha256hex, signCtx, utf8Strict, verifyCtx } from "./crypto.js";

export type Scope = "member" | "room" | "self";
export type Intent = "task" | "question" | "fyi" | "answer" | "pass_to_human" | "handover";
export const INTENTS: Intent[] = ["task", "question", "fyi", "answer", "pass_to_human", "handover"];
export const MAX_ENVELOPE = 64 * 1024;
export const MAX_PLAINTEXT = 60 * 1024;
export const MAX_TEXT = 48 * 1024;
export const MAX_HANDOVER_ENVELOPE = 8 * 1024;

export interface Envelope {
  v: 3;
  h: string;
  ct: string;
  sig: string;
}

export interface Header {
  v: 3;
  id: string;
  room: string;
  from: string;
  from_fp: string;
  to: string;
  to_fp: string;
  scope: Scope;
  in_reply_to: string | null;
  sent_at: number;
  expires_at: number;
  ct_sha256: string;
}

export interface Plaintext {
  v: 3;
  id: string;
  room: string;
  from: string;
  to: string;
  scope: Scope;
  in_reply_to: string | null;
  intent: Intent;
  text: string;
  needed_by: number | null;
  resend_of: string | null;
  /** a signed note (yesnote.ts, ENVELOPE §4a): only bot-link's own code puts one here; receivers check it themselves */
  note?: unknown;
}

export interface SealInput {
  id: string;
  room: string;
  from: string;
  fromFp: string;
  to: string;
  toFp: string;
  toX: string;
  scope: Scope;
  inReplyTo: string | null;
  sentAt: number;
  expiresAt: number;
  intent: Intent;
  text: string;
  neededBy: number | null;
  resendOf: string | null;
  senderSeed: string;
  note?: NoteWire;
}

export class EnvelopeError extends Error {
  constructor(public reason: "bad_signature" | "undecryptable", msg: string) {
    super(msg);
  }
}

export function sealEnvelope(i: SealInput): Envelope {
  if (Buffer.byteLength(i.text, "utf-8") > MAX_TEXT) throw new Error(`message text is over ${MAX_TEXT / 1024} KB`);
  const pt: Plaintext = {
    v: 3, id: i.id, room: i.room, from: i.from, to: i.to, scope: i.scope, in_reply_to: i.inReplyTo,
    intent: i.intent, text: i.text, needed_by: i.neededBy, resend_of: i.resendOf, ...(i.note ? { note: i.note } : {}),
  };
  const ptBytes = Buffer.from(JSON.stringify(pt), "utf-8");
  if (ptBytes.byteLength > MAX_PLAINTEXT) throw new Error("message is too large");
  const ct = seal(ptBytes, i.toX);
  const hdr: Header = {
    v: 3, id: i.id, room: i.room, from: i.from, from_fp: i.fromFp, to: i.to, to_fp: i.toFp, scope: i.scope,
    in_reply_to: i.inReplyTo, sent_at: i.sentAt, expires_at: i.expiresAt, ct_sha256: sha256hex(Buffer.from(ct, "base64")),
  };
  const hBytes = Buffer.from(JSON.stringify(hdr), "utf-8");
  return { v: 3, h: b64urlEncode(hBytes), ct, sig: signCtx(CTX_ENV, hBytes, i.senderSeed) };
}

/** Decode + shape-check a header WITHOUT trusting it (signature not yet checked). */
export function peekHeader(env: Envelope): Header {
  const hBytes = b64urlDecode(env.h);
  const h = parseStrictJson(utf8Strict(hBytes));
  checkHeaderShape(h);
  return h;
}

function checkHeaderShape(h: any) {
  const ok =
    h && typeof h === "object" && h.v === 3 && UUID.test(h.id) && UUID.test(h.room) && UUID.test(h.from) && UUID.test(h.to) &&
    typeof h.from_fp === "string" && typeof h.to_fp === "string" && ["member", "room", "self"].includes(h.scope) &&
    (h.in_reply_to === null || UUID.test(h.in_reply_to)) && Number.isInteger(h.sent_at) && Number.isInteger(h.expires_at) &&
    typeof h.ct_sha256 === "string" && HEX32.test(h.ct_sha256);
  if (!ok) throw new EnvelopeError("bad_signature", "malformed header");
}

export interface OpenContext {
  /** my member id, fingerprint, x secret, the room I pinned */
  me: string;
  myFp: string;
  xSk: string;
  room: string;
  /** sender's ed key from the VERIFIED roster (null = not an active member there) */
  senderEd: (memberId: string) => string | null;
  /** the keys that sender had before a member_rekey, from the same verified roster (check 1b) */
  senderPrev?: (memberId: string) => { ed: string; fp: string; until_at: number }[];
  /** now, unix seconds (tests) */
  now?: number;
}

/** A sender's clock and the clock of the browser that signed its move may differ by this much (seconds). */
export const PREV_KEY_SKEW_S = 300;
/** No message lives longer than 7 days on the server (SPEC §3), so no earlier key is accepted after that. */
export const PREV_KEY_GRACE_S = 7 * 86400;

/** Receiver checks 1-4 (ENVELOPE §4). Check 5 (ledger) is the caller's. */
export function openEnvelope(env: Envelope, c: OpenContext): { header: Header; plain: Plaintext; earlierKey?: { fp: string; until_at: number } } {
  if (!env || env.v !== 3 || typeof env.h !== "string" || typeof env.ct !== "string" || typeof env.sig !== "string") {
    throw new EnvelopeError("bad_signature", "not a v3 message");
  }
  let hBytes: Buffer;
  let h: Header;
  try {
    hBytes = b64urlDecode(env.h);
    h = parseStrictJson(utf8Strict(hBytes));
    checkHeaderShape(h);
  } catch (e) {
    if (e instanceof EnvelopeError) throw e;
    throw new EnvelopeError("bad_signature", "malformed header");
  }
  // 1. sender is an active member of the verified roster and the signature verifies with its roster key
  const ed = c.senderEd(h.from);
  if (!ed) throw new EnvelopeError("bad_signature", "sender is not in the verified member list");
  let earlierKey: { fp: string; until_at: number } | undefined;
  if (!verifyCtx(CTX_ENV, hBytes, env.sig, ed)) {
    // 1b. the sender moved (member_rekey) after it sent this: the signed member list says which key was its key
    // until then. Accepted only when the header names that earlier key, the signature verifies with it, the
    // message says it was sent before the move, and the move is at most a message's lifetime ago. Anything else
    // signed with a key the sender no longer has is refused, as before.
    const now = c.now ?? Math.floor(Date.now() / 1000);
    const k = (c.senderPrev?.(h.from) || []).find((p) => p.fp === h.from_fp && verifyCtx(CTX_ENV, hBytes, env.sig, p.ed));
    if (!k) throw new EnvelopeError("bad_signature", "signature does not verify");
    if (h.sent_at > k.until_at + PREV_KEY_SKEW_S) throw new EnvelopeError("bad_signature", "signed with a key the sender gave up before this was sent");
    if (now > k.until_at + PREV_KEY_GRACE_S) throw new EnvelopeError("bad_signature", "signed with a key the sender gave up too long ago");
    earlierKey = { fp: k.fp, until_at: k.until_at };
  }
  // 2. addressed to me, my key, my room
  if (h.to !== c.me || h.to_fp !== c.myFp || h.room !== c.room) throw new EnvelopeError("bad_signature", "not addressed to this member");
  // 3. ciphertext bound + opens
  let ct: Buffer;
  try {
    ct = b64stdDecode(env.ct);
  } catch {
    throw new EnvelopeError("undecryptable", "ciphertext is not base64");
  }
  if (sha256hex(ct) !== h.ct_sha256) throw new EnvelopeError("bad_signature", "ciphertext does not match the signed header");
  let pt: Plaintext;
  try {
    pt = parseStrictJson(utf8Strict(openSealedBytes(ct, c.xSk)));
  } catch {
    throw new EnvelopeError("undecryptable", "cannot open");
  }
  // 4. bound header copy
  const same = pt && pt.v === 3 && pt.id === h.id && pt.room === h.room && pt.from === h.from && pt.to === h.to && pt.scope === h.scope && (pt.in_reply_to ?? null) === h.in_reply_to;
  if (!same) throw new EnvelopeError("bad_signature", "sealed header copy does not match");
  if (typeof pt.text !== "string" || !INTENTS.includes(pt.intent)) throw new EnvelopeError("undecryptable", "malformed plaintext");
  return { header: h, plain: pt, ...(earlierKey ? { earlierKey } : {}) };
}

export { memberFingerprint };
