#!/usr/bin/env node
/**
 * Signs a client release so installed clients accept it (client/src/release.ts verifies; SPEC §7.6).
 *
 *   node deploy/release-sign.mjs keygen                       make the release key (once; refuses to overwrite)
 *   node deploy/release-sign.mjs sign --tarball <botlink.tgz>  write botlink.manifest.json next to the tarball
 *   node deploy/release-sign.mjs verify --manifest <file> --tarball <botlink.tgz>
 *   node deploy/release-sign.mjs pubkey                       print the public key and its id (what the client pins)
 *
 * The key lives OUTSIDE the repository and outside anything that is deployed: ~/.botlink-release-key/ (dir 0700,
 * files 0600), or --dir <dir> / BOTLINK_RELEASE_KEY_DIR. This script never prints the private key.
 *
 * The manifest names the tarball by sha256 and carries a counter that only goes up: a client refuses a manifest
 * whose counter is lower than one it already accepted (no rollback to an older, signed release). The counter is kept
 * next to the key (signed.json); signing the same tarball again gives the same counter.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DOMAIN = "botlink-update-manifest-v1\n";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const NAMES = ["botlink", "@botlink/cli"];

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const die = (msg) => {
  console.error(`release-sign: ${msg}`);
  process.exit(1);
};

const keyDir = resolve(opt("dir") || process.env.BOTLINK_RELEASE_KEY_DIR || join(homedir(), ".botlink-release-key"));
const keyFile = join(keyDir, "release-ed25519.pem");
const signedFile = join(keyDir, "signed.json");

const rawPub = (keyObj) => Buffer.from(keyObj.export({ type: "spki", format: "der" })).subarray(SPKI_PREFIX.length);
const keyId = (raw) => createHash("sha256").update(raw).digest("hex").slice(0, 16);
const pubFromRaw = (hex) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, "hex")]), format: "der", type: "spki" });

function loadKey() {
  if (!existsSync(keyFile)) die(`no release key in ${keyDir}. Make one with: node deploy/release-sign.mjs keygen`);
  const priv = createPrivateKey(readFileSync(keyFile));
  const raw = rawPub(createPublicKey(priv));
  return { priv, pk: raw.toString("hex"), id: keyId(raw) };
}

function writePrivate(file, data) {
  const fd = openSync(file, "wx", 0o600); // never overwrites; private from the first byte
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

function atomicWrite(file, data, mode) {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, file);
}

function tarballInfo(tgz) {
  const buf = readFileSync(tgz);
  const pj = spawnSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 });
  if (pj.status !== 0) die("the tarball has no package/package.json");
  const pkg = JSON.parse(pj.stdout);
  if (!NAMES.includes(pkg.name)) die(`the tarball is not the bot-link client (name ${JSON.stringify(pkg.name)})`);
  return { sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length, name: pkg.name, version: String(pkg.version || "0.0.0") };
}

switch (cmd) {
  case "keygen": {
    mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    chmodSync(keyDir, 0o700);
    if (existsSync(keyFile)) die(`${keyFile} already exists. A new key would lock every installed client out of updates; not overwriting.`);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writePrivate(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
    const raw = rawPub(publicKey);
    atomicWrite(join(keyDir, "public.json"), JSON.stringify({ id: keyId(raw), pk: raw.toString("hex") }) + "\n", 0o600);
    console.log(`release key made in ${keyDir} (private key: release-ed25519.pem, 0600; keep a copy offline)`);
    console.log(`public key: ${raw.toString("hex")}`);
    console.log(`key id:     ${keyId(raw)}`);
    console.log("Pin the public key in client/src/release.ts (RELEASE_KEYS).");
    break;
  }
  case "pubkey": {
    const k = loadKey();
    console.log(JSON.stringify({ id: k.id, pk: k.pk }));
    break;
  }
  case "sign": {
    const tgz = opt("tarball");
    if (!tgz) die("sign needs --tarball <botlink.tgz>");
    const k = loadKey();
    const info = tarballInfo(tgz);
    let last = { counter: 0, sha256: "" };
    try {
      last = JSON.parse(readFileSync(signedFile, "utf-8"));
    } catch {
      /* first release */
    }
    const asked = opt("counter");
    let counter;
    if (asked !== undefined) {
      counter = Number(asked);
      if (!Number.isSafeInteger(counter) || counter < 1) die("--counter must be a whole number, 1 or more");
      if (counter < last.counter || (counter === last.counter && info.sha256 !== last.sha256)) die(`--counter ${counter} is not above the last signed release (${last.counter}). Clients would refuse it.`);
    } else counter = info.sha256 === last.sha256 && last.counter ? last.counter : last.counter + 1;
    const manifest = JSON.stringify({ v: 1, name: info.name, version: info.version, sha256: info.sha256, size: info.size, counter, signed_at: Math.floor(Date.now() / 1000) });
    const sig = edSign(null, Buffer.from(DOMAIN + manifest, "utf-8"), k.priv).toString("base64");
    const out = resolve(opt("out") || join(dirname(resolve(tgz)), "botlink.manifest.json"));
    atomicWrite(out, JSON.stringify({ manifest, sig, key: k.id }) + "\n", 0o644);
    atomicWrite(signedFile, JSON.stringify({ counter, sha256: info.sha256, version: info.version, at: new Date().toISOString() }) + "\n", 0o600);
    console.log(`signed ${info.name} ${info.version} sha256 ${info.sha256.slice(0, 16)}… as release ${counter} (key ${k.id})`);
    console.log(`manifest: ${out}  -> serve it at /dl/botlink.manifest.json next to /dl/botlink.tgz`);
    break;
  }
  case "verify": {
    const mf = opt("manifest"), tgz = opt("tarball");
    if (!mf || !tgz) die("verify needs --manifest <file> --tarball <botlink.tgz>");
    const doc = JSON.parse(readFileSync(mf, "utf-8"));
    const pk = opt("pk") || loadKey().pk;
    if (!edVerify(null, Buffer.from(DOMAIN + doc.manifest, "utf-8"), pubFromRaw(pk), Buffer.from(doc.sig, "base64"))) die("the signature does not match this key");
    const m = JSON.parse(doc.manifest);
    const info = tarballInfo(tgz);
    if (m.sha256 !== info.sha256 || m.size !== info.size) die("the manifest is for a different tarball");
    console.log(`ok: release ${m.counter}, ${m.name} ${m.version}, sha256 ${m.sha256.slice(0, 16)}…`);
    break;
  }
  default:
    die("usage: release-sign.mjs keygen | pubkey | sign --tarball <tgz> [--counter N] [--out file] | verify --manifest <file> --tarball <tgz>   (all take --dir <key dir>)");
}
