/**
 * Signed releases (SPEC §7.6): an installed client takes a new copy of itself only when a release manifest names it
 * and the manifest is signed with a release key pinned HERE, in the client. The server (or anything between it and
 * this computer) cannot make a client run code the key holder did not sign: it serves the manifest and the tarball,
 * it does not hold the key. The private key never enters the repository or a deploy (deploy/release-sign.mjs).
 *
 * Manifest file, served at /dl/botlink.manifest.json:
 *   {"manifest": "<JSON text>", "sig": "<base64 Ed25519 over DOMAIN + that exact text>", "key": "<key id>"}
 * Manifest text: {"v":1,"name","version","sha256","size","counter","signed_at"}. `counter` only goes up: a client
 * refuses a manifest whose counter is below the highest it has accepted (no rollback to an older signed release).
 */
import { createHash, createPublicKey, verify } from "node:crypto";

import { PACKAGE_NAMES } from "./version.js";

export const MANIFEST_DOMAIN = "botlink-update-manifest-v1\n";
export const MANIFEST_PATH = "/dl/botlink.manifest.json";

/** The release keys this client trusts (raw Ed25519 public keys, hex). Rotation: add the new key, ship, then drop the old. */
export const RELEASE_KEYS: { id: string; pk: string }[] = [
  { id: "9034fb85e68e3065", pk: "c7665063ece274005c93de51aaba92917a6e9520d177bdb2a7f6fd45bc577a87" },
];

export interface Manifest {
  v: 1;
  name: string;
  version: string;
  sha256: string;
  size: number;
  counter: number;
  signed_at: number;
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HEX32 = /^[0-9a-f]{64}$/;

export const keyId = (pkHex: string) => createHash("sha256").update(Buffer.from(pkHex, "hex")).digest("hex").slice(0, 16);

/**
 * The keys in force. Development only (BOTLINK_DEV=1, never set by an install): BOTLINK_UPDATE_PUBKEY replaces the
 * pinned keys, so tests and a local server can sign with a throwaway key.
 */
export function releaseKeys(): { id: string; pk: string }[] {
  const dev = (process.env.BOTLINK_UPDATE_PUBKEY || "").trim().toLowerCase();
  if (process.env.BOTLINK_DEV === "1" && HEX32.test(dev)) return [{ id: keyId(dev), pk: dev }];
  return RELEASE_KEYS;
}

/** Check a manifest file's signature and shape -> the manifest, or why it is refused. */
export function verifyManifest(doc: unknown, keys = releaseKeys()): { ok: true; m: Manifest } | { ok: false; why: string } {
  const d = doc as { manifest?: unknown; sig?: unknown; key?: unknown } | null;
  if (!d || typeof d.manifest !== "string" || typeof d.sig !== "string" || d.manifest.length > 4096) return { ok: false, why: "the release is not signed" };
  let sig: Buffer;
  try {
    sig = Buffer.from(d.sig, "base64");
  } catch {
    return { ok: false, why: "the release is not signed" };
  }
  if (sig.length !== 64) return { ok: false, why: "the release is not signed" };
  const data = Buffer.from(MANIFEST_DOMAIN + d.manifest, "utf-8");
  const named = typeof d.key === "string" ? keys.filter((k) => k.id === d.key) : [];
  const good = (named.length ? named : keys).some((k) => {
    try {
      return verify(null, data, createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(k.pk, "hex")]), format: "der", type: "spki" }), sig);
    } catch {
      return false;
    }
  });
  if (!good) return { ok: false, why: "the release signature is not from bot-link's release key" };
  let m: Manifest;
  try {
    m = JSON.parse(d.manifest);
  } catch {
    return { ok: false, why: "the signed release can't be read" };
  }
  if (m?.v !== 1 || !PACKAGE_NAMES.includes(m.name) || typeof m.version !== "string" || !HEX32.test(String(m.sha256)) ||
    !Number.isSafeInteger(m.size) || m.size < 1 || !Number.isSafeInteger(m.counter) || m.counter < 1) return { ok: false, why: "the signed release can't be read" };
  return { ok: true, m };
}
