/**
 * Generates crypto/vectors/*.json (ENVELOPE §8) from fixed seeds. Deterministic: re-running produces the same
 * files except envelope.json's `ct` (sealed boxes are randomised; receivers check that it OPENS).
 *   npm run vectors            (writes ../crypto/vectors)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as c from "../src/crypto.js";
import { makeEntry, verifyRoster, RosterError, entryHash, type SignedEntry } from "../src/roster.js";
import { signRequest, stringToSign, bodyHash } from "../src/reqsign.js";
import { sealEnvelope, openEnvelope } from "../src/envelope.js";

const OUT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..", "..", "crypto", "vectors");
const seed = (name: string) => c.sha256hex(`botlink-vector-v1|${name}`);

await c.ready();

const write = (name: string, obj: unknown) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), JSON.stringify(obj, null, 2) + "\n");
};

// ------------------------------------------------------------------ fingerprints.json
const mk = (n: string) => c.keysFromSeeds(seed(`${n}-ed`), seed(`${n}-x`));
const alice = mk("alice-chat");
const bob = mk("bob-chat");
const dev1 = c.edPkFromSeed(seed("owner-device-1"));
write("fingerprints.json", {
  description: "fp16(bytes) = first 16 hex of sha256(bytes) grouped 4-4-4-4. member: utf8(lower(ed)|lower(x)); device: utf8('botlink-device-v1|'+lower(pk)); room: decoded genesis entry bytes (see roster.json).",
  fp16: [
    { input_utf8: "", fp: c.fp16("") },
    { input_utf8: "abc", fp: c.fp16("abc") },
  ],
  member: [
    { ed: alice.ed, x: alice.x, input_utf8: `${alice.ed}|${alice.x}`, fp: c.memberFingerprint(alice.ed, alice.x) },
    { ed: bob.ed, x: bob.x, input_utf8: `${bob.ed}|${bob.x}`, fp: c.memberFingerprint(bob.ed, bob.x) },
    { ed: bob.ed.toUpperCase(), x: bob.x.toUpperCase(), note: "uppercase input is lowercased first", fp: c.memberFingerprint(bob.ed, bob.x) },
  ],
  device: [{ pk: dev1, input_utf8: `botlink-device-v1|${dev1}`, fp: c.deviceFingerprint(dev1) }],
  base32_alphabet: c.BASE32,
});

// ------------------------------------------------------------------ req-sign.json
const reqKeySeed = seed("member-request-key");
const reqKey = c.edPkFromSeed(reqKeySeed);
const reqCases = [
  { name: "post with body and session", method: "POST", host: "localhost:8811", target: "/api/v1/messages", body: '{"id":"0193a1b2-0000-7000-8000-000000000001"}', time: 1762339200, nonce: "00112233445566778899aabbccddeeff", session: "8f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b" },
  { name: "get, empty body, no session", method: "GET", host: "api.botlink.dev", target: "/api/v1/me/roster", body: "", time: 1762339260, nonce: "ffeeddccbbaa99887766554433221100", session: "" },
  { name: "query string kept exactly", method: "get", host: "API.botlink.dev", target: "/api/v1/me/inbox/recent?after_seq=12&limit=5", body: "", time: 1762339261, nonce: "0123456789abcdef0123456789abcdef", session: "codex:019a-77" },
  { name: "non-ascii body", method: "POST", host: "localhost:8811", target: "/api/v1/me/card", body: '{"job":"fixes café bugs — 🚀"}', time: 1762339300, nonce: "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf", session: "" },
];
write("req-sign.json", {
  description: "Agent request signing (ENVELOPE §3). string_to_sign is UTF-8, fields joined by \\n, no trailing newline; method uppercased, host lowercased by the signer. sig = Ed25519(seed, utf8(string_to_sign)). body is the raw UTF-8 body.",
  seed: reqKeySeed,
  key: reqKey,
  cases: reqCases.map((r) => {
    const body = Buffer.from(r.body, "utf-8");
    const p = { method: r.method, host: r.host, target: r.target, body, time: r.time, nonce: r.nonce, key: reqKey, session: r.session || null };
    return { ...r, body_sha256: bodyHash(body), string_to_sign: stringToSign(p), sig: signRequest(p, reqKeySeed) };
  }),
});

// ------------------------------------------------------------------ roster.json
const ROOM = "0193a000-0000-7000-8000-00000000a0a0";
const OWNER = "0193a000-0000-7000-8000-0000000000a1";
const FRIEND = "0193a000-0000-7000-8000-0000000000b2";
const ownerDevSeed = seed("owner-device-1");
const ownerDev = c.edPkFromSeed(ownerDevSeed);
const friendDevSeed = seed("friend-device-1");
const friendDev = c.edPkFromSeed(friendDevSeed);
const M1 = "0193a000-0000-7000-8000-00000000c001";
const M2 = "0193a000-0000-7000-8000-00000000c002";
const m1 = mk("member-1");
const m2 = mk("member-2");
const m1b = mk("member-1-moved");
const T0 = 1762339200;

function chain(specs: { f: Record<string, unknown>; seed: string; pk: string }[], startSeq = 0, start: SignedEntry[] = []): SignedEntry[] {
  const out = [...start];
  let prev: string | null = out.length ? entryHash(out[out.length - 1]) : null;
  specs.forEach((s, i) => {
    const seq = startSeq + i;
    const w = makeEntry({ room: ROOM, ...s.f }, seq, prev, s.pk, s.seed, T0 + seq * 60);
    out.push(w);
    prev = entryHash(w);
  });
  return out;
}

const own = { seed: ownerDevSeed, pk: ownerDev };
const fr = { seed: friendDevSeed, pk: friendDev };
const validSpecs = [
  { f: { op: "genesis", name: "acme", owner: OWNER, device: ownerDev }, ...own },
  { f: { op: "person_add", account: FRIEND, name: "Priya Sharma", device: friendDev }, ...own },
  { f: { op: "member_add", member: M1, account: OWNER, name: "bugfix", app: "claude-code", ed: m1.ed, x: m1.x }, ...own },
  { f: { op: "member_add", member: M2, account: FRIEND, name: "deployer", app: "codex", ed: m2.ed, x: m2.x }, ...fr },
  { f: { op: "member_rekey", member: M1, ed: m1b.ed, x: m1b.x }, ...own },
  { f: { op: "member_remove", member: M2 }, seed: m2.ed_sk, pk: m2.ed },
];
const valid = chain(validSpecs);
const vst = verifyRoster(ROOM, valid);

function invalid(name: string, entries: SignedEntry[], expectRule: string, expectSeq: number, why: string) {
  try {
    verifyRoster(ROOM, entries);
  } catch (e) {
    if (!(e instanceof RosterError)) throw e;
    if (e.rule !== expectRule || e.seq !== expectSeq) throw new Error(`vector ${name}: expected ${expectRule}@${expectSeq}, got ${e.rule}@${e.seq}`);
    return { name, why, entries, expect: { valid: false, rule: expectRule, seq: expectSeq } };
  }
  throw new Error(`vector ${name} unexpectedly valid`);
}

const flipSig = (w: SignedEntry): SignedEntry => ({ ...w, sig: (w.sig[0] === "0" ? "1" : "0") + w.sig.slice(1) });
const head3 = valid.slice(0, 3);
const invalids = [
  invalid("bad_signature", [...valid.slice(0, 2), flipSig(valid[2]), ...valid.slice(3)], "sig", 2, "seq 2's signature has one hex digit changed"),
  invalid("broken_chain", [valid[0], valid[1], makeEntry({ room: ROOM, ...validSpecs[2].f }, 2, "00".repeat(32), own.pk, own.seed, T0 + 120)], "prev", 2, "seq 2's prev is not the hash of seq 1"),
  invalid("seq_gap", [valid[0], valid[1], { ...chain([validSpecs[2]], 3, valid.slice(0, 2)).slice(-1)[0] }], "seq", 2, "seq jumps from 1 to 3"),
  invalid("signer_not_allowed", chain([{ f: { op: "member_add", member: M2, account: OWNER, name: "sneaky", app: "codex", ed: m2.ed, x: m2.x }, ...fr }], 3, head3), "signer", 3, "the friend's device adds a chat for the owner's account"),
  invalid("duplicate_name", chain([{ f: { op: "member_add", member: M2, account: FRIEND, name: "bugfix", app: "codex", ed: m2.ed, x: m2.x }, ...fr }], 3, head3), "op", 3, "a second active member named bugfix"),
  invalid("owner_removed", chain([{ f: { op: "person_remove", account: OWNER }, ...own }], 3, head3), "op", 3, "the owner cannot be person_removed"),
  invalid("wrong_room", [valid[0], makeEntry({ room: "0193a000-0000-7000-8000-00000000ffff", ...validSpecs[1].f }, 1, entryHash(valid[0]), own.pk, own.seed, T0 + 60)], "room", 1, "seq 1 is signed for another room"),
  invalid("by_not_signer", [valid[0], { ...valid[1], signer: friendDev, sig: c.signCtx(c.CTX_ROSTER, Buffer.from(valid[1].entry, "base64url"), friendDevSeed) }], "by", 1, "wire signer differs from entry.by"),
  invalid("duplicate_json_key", [valid[0], (() => {
    const txt = `{"v":1,"room":"${ROOM}","seq":1,"prev":"${entryHash(valid[0])}","at":${T0 + 60},"op":"person_add","by":"${ownerDev}","account":"${FRIEND}","name":"A","name":"B","device":"${friendDev}"}`;
    const b = Buffer.from(txt, "utf-8");
    return { seq: 1, entry: c.b64urlEncode(b), sig: c.signCtx(c.CTX_ROSTER, b, ownerDevSeed), signer: ownerDev };
  })()], "bad_entry", 1, "entry JSON has a duplicate key (strict parser must reject)"),
];

write("roster.json", {
  description: "ENVELOPE §5. Replay `valid.entries` from seq 0; expect `valid.expect`. Each invalid variant must fail with the given rule at the given seq. Rule codes: bad_wire, bad_entry, seq, room, by, prev, sig, signer, op (see README.md).",
  room_id: ROOM,
  keys: {
    owner_account: OWNER, friend_account: FRIEND,
    owner_device: { seed: ownerDevSeed, pk: ownerDev, fp: c.deviceFingerprint(ownerDev) },
    friend_device: { seed: friendDevSeed, pk: friendDev, fp: c.deviceFingerprint(friendDev) },
    member_1: { id: M1, ed_seed: m1.ed_sk, ed: m1.ed, x_sk: m1.x_sk, x: m1.x },
    member_1_moved: { ed_seed: m1b.ed_sk, ed: m1b.ed, x_sk: m1b.x_sk, x: m1b.x },
    member_2: { id: M2, ed_seed: m2.ed_sk, ed: m2.ed, x_sk: m2.x_sk, x: m2.x },
  },
  valid: {
    entries: valid,
    entry_json: valid.map((w) => Buffer.from(w.entry, "base64url").toString("utf-8")),
    expect: {
      valid: true,
      room_name: vst.room_name,
      room_fp: vst.room_fp,
      owner: vst.owner,
      head_seq: vst.head_seq,
      head_hash: vst.head_hash,
      people: [...vst.people].map(([account, p]) => ({ account, devices: [...p.devices] })),
      members: [...vst.members.values()].map((m) => ({ id: m.id, account: m.account, name: m.name, app: m.app, ed: m.ed, x: m.x, fp: m.fp })),
    },
  },
  invalid: invalids,
});

// ------------------------------------------------------------------ envelope.json
const MSG = "0193a1b2-0000-7000-8000-000000000042";
const env = sealEnvelope({
  id: MSG, room: ROOM, from: M1, fromFp: c.memberFingerprint(m1b.ed, m1b.x), to: M2, toFp: c.memberFingerprint(m2.ed, m2.x), toX: m2.x,
  scope: "member", inReplyTo: null, sentAt: T0, expiresAt: T0 + 7 * 86400, intent: "task", text: "Deploy commit a1b2c3 to staging, then smoke-test /checkout. café — ok",
  neededBy: null, resendOf: null, senderSeed: m1b.ed_sk,
});
const opened = openEnvelope(env, { me: M2, myFp: c.memberFingerprint(m2.ed, m2.x), xSk: m2.x_sk, room: ROOM, senderEd: (id) => (id === M1 ? m1b.ed : null) });
const hBytes = Buffer.from(env.h, "base64url");
// a forged variant: header with a different `to` but the original signature
const forgedH = JSON.parse(hBytes.toString("utf-8"));
forgedH.to_fp = "0000-0000-0000-0000";
write("envelope.json", {
  description: "ENVELOPE §4. header_json are the exact signed header bytes (h = base64url(header_json) no padding). sig = Ed25519(sender_seed, 'botlink-env-v1\\n' || header bytes). ct is a sealed box (random): check it OPENS with recipient.x_sk to plaintext_json and sha256(ct bytes) == header.ct_sha256. Envelope signatures are deterministic.",
  sender: { member: M1, ed_seed: m1b.ed_sk, ed: m1b.ed, x: m1b.x, fp: c.memberFingerprint(m1b.ed, m1b.x) },
  recipient: { member: M2, ed: m2.ed, x_sk: m2.x_sk, x: m2.x, fp: c.memberFingerprint(m2.ed, m2.x) },
  room_id: ROOM,
  envelope: env,
  header_json: hBytes.toString("utf-8"),
  signed_bytes_b64: c.withContext(c.CTX_ENV, hBytes).toString("base64"),
  plaintext_json: JSON.stringify(opened.plain),
  plaintext: opened.plain,
  invalid: [
    { name: "tampered_header", why: "to_fp changed after signing: signature must fail", envelope: { ...env, h: c.b64urlEncode(Buffer.from(JSON.stringify(forgedH), "utf-8")) }, expect: "bad_signature" },
    { name: "wrong_sender_key", why: "verify with member_2's ed instead of member_1's: must fail", envelope: env, verify_with: m2.ed, expect: "bad_signature" },
  ],
});

// ------------------------------------------------------------------ push.json
const pushSecret = seed("push-secret");
const pushBodies = [
  '{"v":1,"type":"verify","member_id":"0193a000-0000-7000-8000-00000000c001","challenge":"00112233445566778899aabbccddeeff","push_id":"0193a1b2-0000-7000-8000-0000000000e1","attempt":1,"at":1762339200}',
  '{"v":1,"type":"message","member_id":"0193a000-0000-7000-8000-00000000c001","room_id":"0193a000-0000-7000-8000-00000000a0a0","message_ids":["0193a1b2-0000-7000-8000-000000000042"],"push_id":"0193a1b2-0000-7000-8000-0000000000e2","attempt":2,"at":1762339230}',
];
write("push.json", {
  description: "ENVELOPE §7. v1 = hex(HMAC_SHA256(secret_bytes, 'botlink-push-v1\\n' || t || '\\n' || raw_body)). secret is 32 bytes hex (the key is the decoded bytes). Header: X-Botlink-Push-Signature: t=<t>,v1=<v1>.",
  secret: pushSecret,
  cases: pushBodies.map((body, i) => {
    const t = 1762339200 + i * 30;
    const v1 = c.pushSignature(pushSecret, t, Buffer.from(body, "utf-8"));
    return { t, body, v1, header: `t=${t},v1=${v1}` };
  }),
});

console.log(`vectors written to ${OUT}`);
