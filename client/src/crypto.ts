/**
 * bot-link v1 crypto primitives (crypto/ENVELOPE.md §0-§2). Kept from botlink-mcp `cloud/crypto.ts`:
 * libsodium Ed25519 (32-byte seed), X25519, sealed boxes, the member fingerprint, sealFile/openFile.
 * Cut: canonical() signing, prekeys, proof of work, the firewall body codec, capability tokens.
 *
 * Every signature here is `Ed25519(sk, CONTEXT || "\n" || bytes)` except request signing, whose string already
 * starts with its context line (ENVELOPE §3).
 */
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as nodeVerify } from "node:crypto";
import sodiumMod from "libsodium-wrappers";
import * as jsonc from "jsonc-parser";

const sodium: any = (sodiumMod as any).default ?? sodiumMod;
let _ready = false;

export const CTX_REQ = "botlink-req-v1";
export const CTX_ENV = "botlink-env-v1";
export const CTX_ROSTER = "botlink-roster-v1";
export const CTX_PUSH = "botlink-push-v1";
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const BASE32 = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Initialise libsodium's WASM once. Every sodium function here needs it. */
export async function ready(): Promise<void> {
  if (_ready) return;
  await sodium.ready;
  _ready = true;
}

function need() {
  if (!_ready) throw new Error("crypto not initialised: await ready() first");
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const HEX32 = /^[0-9a-f]{64}$/;
export const HEX_SIG = /^[0-9a-f]{128}$/;

export function unhex(h: string, n = 32): Uint8Array {
  if (typeof h !== "string" || !/^[0-9a-fA-F]*$/.test(h) || h.length !== n * 2) throw new Error(`key must be ${n} bytes of hex`);
  return new Uint8Array(Buffer.from(h, "hex"));
}

export function sha256hex(b: Uint8Array | string): string {
  return createHash("sha256").update(typeof b === "string" ? Buffer.from(b, "utf-8") : b).digest("hex");
}

// ------------------------------------------------------------------ base64 flavours (ENVELOPE §0)
export function b64urlEncode(b: Uint8Array | string): string {
  return Buffer.from(typeof b === "string" ? Buffer.from(b, "utf-8") : b).toString("base64url");
}
const B64URL = /^[A-Za-z0-9_-]*$/;
export function b64urlDecode(s: string): Buffer {
  if (typeof s !== "string" || !B64URL.test(s) || s.length % 4 === 1) throw new Error("not base64url");
  const b = Buffer.from(s, "base64url");
  if (b.toString("base64url") !== s) throw new Error("not canonical base64url");
  return b;
}
const B64STD = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export function b64stdDecode(s: string): Buffer {
  if (typeof s !== "string" || !B64STD.test(s)) throw new Error("not base64");
  return Buffer.from(s, "base64");
}

// ------------------------------------------------------------------ keys
export interface MemberKeys {
  ed_sk: string; // 32-byte seed (hex)
  ed: string;
  x_sk: string;
  x: string;
}

export function edPkFromSeed(seedHex: string): string {
  need();
  return hex(sodium.crypto_sign_seed_keypair(unhex(seedHex)).publicKey);
}

export function xPkFromSk(skHex: string): string {
  need();
  return hex(sodium.crypto_scalarmult_base(unhex(skHex)));
}

export function keysFromSeeds(edSeed: string, xSk: string): MemberKeys {
  return { ed_sk: edSeed, ed: edPkFromSeed(edSeed), x_sk: xSk, x: xPkFromSk(xSk) };
}

export function genKeys(): MemberKeys {
  return keysFromSeeds(randomBytes(32).toString("hex"), randomBytes(32).toString("hex"));
}

function edSecretKey(seedHex: string): Uint8Array {
  return sodium.crypto_sign_seed_keypair(unhex(seedHex)).privateKey; // 64 bytes (seed || pk)
}

// ------------------------------------------------------------------ signatures
export function signBytes(msg: Uint8Array, seedHex: string): string {
  need();
  return hex(sodium.crypto_sign_detached(msg, edSecretKey(seedHex)));
}

export function verifyBytes(msg: Uint8Array, sigHex: string, pkHex: string): boolean {
  if (typeof sigHex !== "string" || !HEX_SIG.test(sigHex) || typeof pkHex !== "string" || !HEX32.test(pkHex)) return false;
  if (!_ready) return verifyBytesNode(msg, sigHex, pkHex);
  try {
    return sodium.crypto_sign_verify_detached(Buffer.from(sigHex, "hex"), msg, unhex(pkHex));
  } catch {
    return false;
  }
}

/** Ed25519 verify with node:crypto only (hooks start fast without libsodium's WASM). */
export function verifyBytesNode(msg: Uint8Array, sigHex: string, pkHex: string): boolean {
  try {
    if (!HEX_SIG.test(sigHex) || !HEX32.test(pkHex)) return false;
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pkHex, "hex")]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return nodeVerify(null, Buffer.from(msg), key, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

/** CONTEXT || "\n" || bytes */
export function withContext(ctx: string, bytes: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(ctx + "\n", "ascii"), Buffer.from(bytes)]);
}

export function signCtx(ctx: string, bytes: Uint8Array, seedHex: string): string {
  return signBytes(withContext(ctx, bytes), seedHex);
}

export function verifyCtx(ctx: string, bytes: Uint8Array, sigHex: string, pkHex: string): boolean {
  return verifyBytes(withContext(ctx, bytes), sigHex, pkHex);
}

// ------------------------------------------------------------------ sealed boxes
export function seal(body: Uint8Array, recipientX25519Hex: string): string {
  need();
  return Buffer.from(sodium.crypto_box_seal(body, unhex(recipientX25519Hex))).toString("base64");
}

export function openSealedBytes(ct: Uint8Array, x25519SkHex: string): Uint8Array {
  need();
  const sk = unhex(x25519SkHex);
  const pk = sodium.crypto_scalarmult_base(sk);
  return sodium.crypto_box_seal_open(ct, pk, sk);
}

// ------------------------------------------------------------------ fingerprints (ENVELOPE §2)
const group4 = (s: string) => s.match(/.{4}/g)!.join("-");

export function fp16(bytes: Uint8Array | string): string {
  return group4(sha256hex(bytes).slice(0, 16));
}

/** identical to botlink-mcp `fingerprint()` */
export function memberFingerprint(ed: string, x: string): string {
  return fp16(`${(ed || "").toLowerCase()}|${(x || "").toLowerCase()}`);
}

export function deviceFingerprint(devicePk: string): string {
  return fp16(`botlink-device-v1|${(devicePk || "").toLowerCase()}`);
}

export function roomFingerprint(genesisEntryBytes: Uint8Array): string {
  return fp16(genesisEntryBytes);
}

// ------------------------------------------------------------------ ids
/** UUIDv7 (RFC 9562): 48-bit unix ms, version 7, variant 10, random rest. Lowercase canonical. */
export function uuidv7(nowMs = Date.now()): string {
  const b = randomBytes(16);
  const ms = BigInt(nowMs);
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function nonceHex(): string {
  return randomBytes(16).toString("hex");
}

// ------------------------------------------------------------------ strict JSON (ENVELOPE §0: reject duplicate keys)
/** JSON.parse that also rejects duplicate object keys, comments and trailing commas. Throws on anything else. */
export function parseStrictJson(text: string): any {
  const errors: jsonc.ParseError[] = [];
  const stack: Set<string>[] = [];
  let dup: string | null = null;
  jsonc.visit(
    text,
    {
      onObjectBegin: () => {
        stack.push(new Set());
      },
      onObjectEnd: () => {
        stack.pop();
      },
      onObjectProperty: (prop) => {
        const s = stack[stack.length - 1];
        if (s.has(prop)) dup = dup ?? prop;
        s.add(prop);
      },
      onComment: () => {
        errors.push({ error: 1 as jsonc.ParseErrorCode, offset: 0, length: 0 });
      },
      onError: (error, offset, length) => {
        errors.push({ error, offset, length });
      },
    },
    { disallowComments: true, allowTrailingComma: false },
  );
  if (errors.length) throw new Error("invalid JSON");
  if (dup !== null) throw new Error(`duplicate key ${JSON.stringify(dup)}`);
  return JSON.parse(text);
}

/** Decode bytes as strict UTF-8 (invalid sequences throw). */
export function utf8Strict(b: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(b);
}

// ------------------------------------------------------------------ push (ENVELOPE §7)
export function pushSignature(secretHex: string, t: number, rawBody: Uint8Array): string {
  const mac = createHmac("sha256", Buffer.from(secretHex, "hex"));
  mac.update(Buffer.from(`${CTX_PUSH}\n${t}\n`, "ascii"));
  mac.update(rawBody);
  return mac.digest("hex");
}

export function verifyPushHeader(secretHex: string, header: string, rawBody: Uint8Array, nowS = Math.floor(Date.now() / 1000)): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header || "");
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowS - t) > 300) return false;
  const want = Buffer.from(pushSignature(secretHex, t, rawBody), "hex");
  return timingSafeEqual(want, Buffer.from(m[2], "hex"));
}

// ------------------------------------------------------------------ attachments (kept, unused in v1)
export const BLOB_AAD = "botlink/blob/1";
const BLOB_NONCE = 24;

export function sealFile(plain: Uint8Array, keyHex: string): Uint8Array {
  need();
  const nonce = new Uint8Array(randomBytes(BLOB_NONCE));
  const ct: Uint8Array = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, Buffer.from(BLOB_AAD, "ascii"), null, nonce, unhex(keyHex));
  const out = new Uint8Array(BLOB_NONCE + ct.byteLength);
  out.set(nonce, 0);
  out.set(ct, BLOB_NONCE);
  return out;
}

export function openFile(blob: Uint8Array, keyHex: string): Uint8Array {
  need();
  if (blob.byteLength < BLOB_NONCE + 16) throw new Error("attachment too short");
  return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, blob.subarray(BLOB_NONCE), Buffer.from(BLOB_AAD, "ascii"), blob.subarray(0, BLOB_NONCE), unhex(keyHex));
}
