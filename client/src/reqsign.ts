/** Agent request signing (crypto/ENVELOPE.md §3). */
import { CTX_REQ, EMPTY_SHA256, sha256hex, signBytes, verifyBytes } from "./crypto.js";

export const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A session id the server (or a file) handed us: the id when it is shaped like one, else null. It ends up in other
 *  programs' arguments and environment, so nothing that starts with "-" or holds a space or a line break gets through. */
export function safeSession(v: unknown): string | null {
  return typeof v === "string" && SESSION_RE.test(v) ? v : null;
}

export interface ReqParts {
  method: string;
  host: string;
  target: string;
  body: Uint8Array | null;
  time: number;
  nonce: string;
  key: string;
  session: string | null;
}

export function bodyHash(body: Uint8Array | null): string {
  return body && body.byteLength ? sha256hex(body) : EMPTY_SHA256;
}

export function stringToSign(p: ReqParts): string {
  return [CTX_REQ, p.method.toUpperCase(), p.host.toLowerCase(), p.target, bodyHash(p.body), String(p.time), p.nonce, p.key, p.session || ""].join("\n");
}

export function signRequest(p: ReqParts, seedHex: string): string {
  return signBytes(Buffer.from(stringToSign(p), "utf-8"), seedHex);
}

export function verifyRequest(p: ReqParts, sig: string): boolean {
  return verifyBytes(Buffer.from(stringToSign(p), "utf-8"), sig, p.key);
}

/** The headers for a signed request. */
export function signedHeaders(p: ReqParts, seedHex: string): Record<string, string> {
  const h: Record<string, string> = {
    "X-Botlink-Key": p.key,
    "X-Botlink-Time": String(p.time),
    "X-Botlink-Nonce": p.nonce,
    "X-Botlink-Signature": signRequest(p, seedHex),
  };
  if (p.session) h["X-Botlink-Session"] = p.session;
  return h;
}
