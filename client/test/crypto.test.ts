import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as c from "../src/crypto.js";
import { stringToSign, signRequest, verifyRequest, bodyHash } from "../src/reqsign.js";
import { sealEnvelope, openEnvelope, EnvelopeError, type SealInput } from "../src/envelope.js";
import { verifyRoster, RosterError, checkPin, pinOf, selfCheck, makeEntry, entryHash } from "../src/roster.js";
import { assertIsolated } from "./helpers.js";

const V = (n: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "crypto", "vectors", n), "utf-8"));

test("isolated environment", () => assertIsolated());

test("vectors: fingerprints", async () => {
  await c.ready();
  const f = V("fingerprints.json");
  for (const x of f.fp16) assert.equal(c.fp16(x.input_utf8), x.fp);
  for (const m of f.member) assert.equal(c.memberFingerprint(m.ed, m.x), m.fp);
  for (const d of f.device) assert.equal(c.deviceFingerprint(d.pk), d.fp);
  assert.equal(f.base32_alphabet, c.BASE32);
  assert.equal(c.BASE32.length, 32);
});

test("vectors: request signing", async () => {
  await c.ready();
  const r = V("req-sign.json");
  assert.equal(c.edPkFromSeed(r.seed), r.key);
  for (const k of r.cases) {
    const p = { method: k.method, host: k.host, target: k.target, body: Buffer.from(k.body, "utf-8"), time: k.time, nonce: k.nonce, key: r.key, session: k.session || null };
    assert.equal(bodyHash(p.body), k.body_sha256);
    assert.equal(stringToSign(p), k.string_to_sign, k.name);
    assert.equal(signRequest(p, r.seed), k.sig, k.name);
    assert.ok(verifyRequest(p, k.sig));
    assert.ok(!verifyRequest({ ...p, nonce: "0".repeat(32) }, k.sig), "nonce is bound");
    assert.ok(!verifyRequest({ ...p, session: "other" }, k.sig), "session is bound");
  }
  assert.ok(stringToSign({ method: "get", host: "h", target: "/", body: null, time: 1, nonce: "n", key: "k", session: null }).endsWith("\nk\n"), "empty session is an empty last line, no trailing newline");
});

test("vectors: roster valid + every invalid variant with its rule", async () => {
  await c.ready();
  const r = V("roster.json");
  const st = verifyRoster(r.room_id, r.valid.entries);
  assert.equal(st.room_fp, r.valid.expect.room_fp);
  assert.equal(st.head_seq, r.valid.expect.head_seq);
  assert.equal(st.head_hash, r.valid.expect.head_hash);
  assert.deepEqual([...st.members.values()].map((m) => ({ id: m.id, account: m.account, name: m.name, app: m.app, ed: m.ed, x: m.x, fp: m.fp })), r.valid.expect.members);
  assert.equal(r.invalid.length >= 6, true);
  for (const v of r.invalid) {
    assert.throws(() => verifyRoster(r.room_id, v.entries), (e: unknown) => e instanceof RosterError && e.rule === v.expect.rule && e.seq === v.expect.seq, v.name);
  }
});

test("vectors: envelope opens; tampered header fails", async () => {
  await c.ready();
  const e = V("envelope.json");
  const ctx = { me: e.recipient.member, myFp: e.recipient.fp, xSk: e.recipient.x_sk, room: e.room_id, senderEd: (id: string) => (id === e.sender.member ? e.sender.ed : null) };
  const o = openEnvelope(e.envelope, ctx);
  assert.equal(JSON.stringify(o.plain), e.plaintext_json);
  assert.equal(Buffer.from(e.envelope.h, "base64url").toString("utf-8"), e.header_json);
  assert.throws(() => openEnvelope(e.invalid[0].envelope, ctx), (x: unknown) => x instanceof EnvelopeError && x.reason === "bad_signature");
  assert.throws(() => openEnvelope(e.envelope, { ...ctx, senderEd: () => e.invalid[1].verify_with }), (x: unknown) => x instanceof EnvelopeError && x.reason === "bad_signature");
});

test("vectors: push signature", () => {
  const p = V("push.json");
  for (const k of p.cases) {
    assert.equal(c.pushSignature(p.secret, k.t, Buffer.from(k.body)), k.v1);
    assert.ok(c.verifyPushHeader(p.secret, k.header, Buffer.from(k.body), k.t + 10));
    assert.ok(!c.verifyPushHeader(p.secret, k.header, Buffer.from(k.body), k.t + 301), "older than 300 s");
    assert.ok(!c.verifyPushHeader(p.secret, k.header, Buffer.from(k.body + " "), k.t));
  }
});

test("strict JSON rejects duplicate keys, comments, trailing commas", () => {
  assert.deepEqual(c.parseStrictJson('{"a":1,"b":{"a":2}}'), { a: 1, b: { a: 2 } });
  assert.throws(() => c.parseStrictJson('{"a":1,"a":2}'));
  assert.throws(() => c.parseStrictJson('{"a":{"x":1,"x":1}}'));
  assert.throws(() => c.parseStrictJson('{"a":1,}'));
  assert.throws(() => c.parseStrictJson('{"a":1 /* c */}'));
  assert.deepEqual(c.parseStrictJson('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }], "same key in sibling objects is fine");
});

test("uuidv7 shape + monotonic prefix", () => {
  const a = c.uuidv7(1000), b = c.uuidv7(2000);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a < b);
});

// ------------------------------------------------------------------ envelope receiver checks
async function pair() {
  await c.ready();
  const s = c.genKeys(), r = c.genKeys(), o = c.genKeys();
  const ids = { room: c.uuidv7(), from: c.uuidv7(), to: c.uuidv7(), other: c.uuidv7(), id: c.uuidv7() };
  const base: SealInput = {
    id: ids.id, room: ids.room, from: ids.from, fromFp: c.memberFingerprint(s.ed, s.x), to: ids.to, toFp: c.memberFingerprint(r.ed, r.x), toX: r.x, scope: "member",
    inReplyTo: null, sentAt: 1762339200, expiresAt: 1762339200 + 3600, intent: "question", text: "what's the status of the checkout fix?", neededBy: null, resendOf: null, senderSeed: s.ed_sk,
  };
  const ctx = { me: ids.to, myFp: base.toFp, xSk: r.x_sk, room: ids.room, senderEd: (id: string) => (id === ids.from ? s.ed : id === ids.other ? o.ed : null) };
  return { s, r, o, ids, base, ctx };
}

test("envelope: round trip and every receiver check", async () => {
  const { s, r, o, ids, base, ctx } = await pair();
  const env = sealEnvelope(base);
  assert.equal(openEnvelope(env, ctx).plain.text, base.text);
  // 1. sender not in verified roster / wrong key
  assert.throws(() => openEnvelope(env, { ...ctx, senderEd: () => null }), /not in the verified/);
  assert.throws(() => openEnvelope(env, { ...ctx, senderEd: () => o.ed }), /signature/);
  // 2. not to me / not my key / other room
  assert.throws(() => openEnvelope(env, { ...ctx, me: ids.other }), /not addressed/);
  assert.throws(() => openEnvelope(env, { ...ctx, myFp: "0000-0000-0000-0000" }), /not addressed/);
  assert.throws(() => openEnvelope(env, { ...ctx, room: c.uuidv7() }), /not addressed/);
  // 3. ciphertext swapped for another sealed box: ct_sha256 mismatch
  const other = sealEnvelope({ ...base, text: "different" });
  assert.throws(() => openEnvelope({ ...env, ct: other.ct }, ctx), /does not match the signed header/);
  // 3b. sealed to someone else's key: can't open
  const toOther = sealEnvelope({ ...base, toX: c.genKeys().x });
  assert.throws(() => openEnvelope(toOther, ctx), (e: unknown) => e instanceof EnvelopeError && e.reason === "undecryptable");
  // 4. re-wrap: member O takes S's ciphertext and signs its own header around it -> plaintext copy says from S
  const hdr = JSON.parse(Buffer.from(env.h, "base64url").toString());
  hdr.from = ids.other;
  hdr.from_fp = c.memberFingerprint(o.ed, o.x);
  const hb = Buffer.from(JSON.stringify(hdr));
  const rewrapped = { v: 3 as const, h: c.b64urlEncode(hb), ct: env.ct, sig: c.signCtx(c.CTX_ENV, hb, o.ed_sk) };
  assert.throws(() => openEnvelope(rewrapped, ctx), /sealed header copy/);
  // header with a duplicate key is refused even with a valid signature
  const dupTxt = Buffer.from(env.h, "base64url").toString().replace('"v":3,', '"v":3,"v":3,');
  const db = Buffer.from(dupTxt);
  assert.throws(() => openEnvelope({ v: 3, h: c.b64urlEncode(db), ct: env.ct, sig: c.signCtx(c.CTX_ENV, db, s.ed_sk) }, ctx), /malformed/);
  void r;
});

test("envelope: domain separation (a roster signature never verifies as an envelope)", async () => {
  const { s, base, ctx } = await pair();
  const env = sealEnvelope(base);
  const hb = Buffer.from(env.h, "base64url");
  const forged = { ...env, sig: c.signCtx(c.CTX_ROSTER, hb, s.ed_sk) };
  assert.throws(() => openEnvelope(forged, ctx), /signature/);
});

// ------------------------------------------------------------------ roster pins + self-check
test("roster: pins catch rollback, fork and key swaps; rekey is reported as a move", async () => {
  await c.ready();
  const room = c.uuidv7();
  const dev = c.keysFromSeeds(c.sha256hex("d"), c.sha256hex("dx"));
  const owner = c.uuidv7();
  const k1 = c.genKeys(), k2 = c.genKeys(), k1b = c.genKeys();
  const m1 = c.uuidv7(), m2 = c.uuidv7();
  const E: any[] = [makeEntry({ room, op: "genesis", name: "acme", owner, device: dev.ed }, 0, null, dev.ed, dev.ed_sk)];
  const add = (f: any) => E.push(makeEntry({ room, ...f }, E.length, entryHash(E[E.length - 1]), dev.ed, dev.ed_sk));
  add({ op: "member_add", member: m1, account: owner, name: "bugfix", app: "claude-code", ed: k1.ed, x: k1.x });
  add({ op: "member_add", member: m2, account: owner, name: "deployer", app: "codex", ed: k2.ed, x: k2.x });
  const st2 = verifyRoster(room, E);
  const pin = pinOf(st2);
  assert.deepEqual(checkPin(pin, st2), { ok: true, moved: [] });
  // rollback: fewer entries than pinned
  assert.equal(checkPin(pin, verifyRoster(room, E.slice(0, 2))).ok, false);
  // fork: same length, different seq 2
  const F = [...E.slice(0, 2), makeEntry({ room, op: "member_add", member: m2, account: owner, name: "deployer", app: "codex", ed: c.genKeys().ed, x: k2.x }, 2, entryHash(E[1]), dev.ed, dev.ed_sk)];
  assert.equal(checkPin(pin, verifyRoster(room, F)).ok, false);
  // a different genesis (fake room)
  const G = [makeEntry({ room, op: "genesis", name: "acme", owner, device: dev.ed }, 0, null, dev.ed, dev.ed_sk, 1)];
  assert.equal(checkPin(pin, verifyRoster(room, G)).ok, false);
  // a rekey later: allowed, reported as moved
  add({ op: "member_rekey", member: m1, ed: k1b.ed, x: k1b.x });
  const st3 = verifyRoster(room, E);
  const pc = checkPin(pin, st3);
  assert.ok(pc.ok && pc.moved.length === 1 && pc.moved[0].name === "bugfix");
  // self-check: my keys must be there, set by the expected op
  assert.equal(selfCheck(st3, E, { member: m2, ed: k2.ed, x: k2.x }, "join", owner), null);
  assert.match(String(selfCheck(st3, E, { member: m1, ed: k1.ed, x: k1.x }, "join", owner)), /different key/);
  assert.equal(selfCheck(st3, E, { member: m1, ed: k1b.ed, x: k1b.x }, "claim", owner), null);
  assert.match(String(selfCheck(st3, E, { member: c.uuidv7(), ed: k1.ed, x: k1.x }, "join", owner)), /not in the verified/);
  // ENVELOPE §5.4: signed for the account the invite belongs to, not merely "a device of the account the entry names"
  assert.match(String(selfCheck(st3, E, { member: m2, ed: k2.ed, x: k2.x }, "join", c.uuidv7())), /someone else/);
});

test("self-check: a valid member_add by another person of the room, as their own chat, fails for the invite's account", async () => {
  await c.ready();
  const room = c.uuidv7();
  const od = c.genKeys(), ed = c.genKeys();
  const owner = c.uuidv7(), eve = c.uuidv7();
  const me = c.genKeys(), mid = c.uuidv7();
  const E: any[] = [makeEntry({ room, op: "genesis", name: "acme", owner, device: od.ed }, 0, null, od.ed, od.ed_sk)];
  const add = (f: any, s: { ed: string; ed_sk: string }) => E.push(makeEntry({ room, ...f }, E.length, entryHash(E[E.length - 1]), s.ed, s.ed_sk));
  add({ op: "person_add", account: eve, name: "Eve", device: ed.ed }, od);
  // the attack: Eve's device signs this chat's keys as EVE's member (a valid roster: every replay rule holds)
  add({ op: "member_add", member: mid, account: eve, name: "victim", app: "codex", ed: me.ed, x: me.x }, ed);
  const v = verifyRoster(room, E);
  const mine = { member: mid, ed: me.ed, x: me.x };
  assert.match(String(selfCheck(v, E, mine, "join", owner)), /someone else/, "the chat used the owner's invite");
  assert.equal(selfCheck(v, E, mine, "join", eve), null, "Eve's own invite (or Eve took the request over): fine");
});

test("roster: a member removes only itself; owner device can remove anyone; friend's device can't add for the owner", async () => {
  await c.ready();
  const room = c.uuidv7();
  const od = c.genKeys(), fd = c.genKeys();
  const owner = c.uuidv7(), friend = c.uuidv7();
  const k1 = c.genKeys(), k2 = c.genKeys();
  const m1 = c.uuidv7(), m2 = c.uuidv7();
  const E: any[] = [makeEntry({ room, op: "genesis", name: "acme", owner, device: od.ed }, 0, null, od.ed, od.ed_sk)];
  const add = (f: any, signer: { ed: string; ed_sk: string }) => {
    const e = makeEntry({ room, ...f }, E.length, entryHash(E[E.length - 1]), signer.ed, signer.ed_sk);
    verifyRoster(room, [...E, e]);
    E.push(e);
  };
  add({ op: "person_add", account: friend, name: "Priya", device: fd.ed }, od);
  add({ op: "member_add", member: m1, account: owner, name: "a", app: "codex", ed: k1.ed, x: k1.x }, od);
  add({ op: "member_add", member: m2, account: friend, name: "b", app: "cursor", ed: k2.ed, x: k2.x }, fd);
  assert.throws(() => add({ op: "member_remove", member: m1 }, k2), (e: unknown) => e instanceof RosterError && e.rule === "signer");
  assert.throws(() => add({ op: "member_remove", member: m1 }, fd), (e: unknown) => e instanceof RosterError && e.rule === "signer");
  add({ op: "member_remove", member: m2 }, od);
  add({ op: "member_remove", member: m1 }, k1);
  assert.equal(verifyRoster(room, E).members.size, 0);
  assert.throws(() => add({ op: "member_add", member: c.uuidv7(), account: owner, name: "c", app: "codex", ed: c.genKeys().ed, x: c.genKeys().x }, fd), (e: unknown) => e instanceof RosterError && e.rule === "signer");
  assert.throws(() => add({ op: "member_add", member: c.uuidv7(), account: owner, name: "Bad Name", app: "codex", ed: c.genKeys().ed, x: c.genKeys().x }, od), (e: unknown) => e instanceof RosterError && e.rule === "op");
  assert.throws(() => add({ op: "person_remove", account: friend }, k1), (e: unknown) => e instanceof RosterError && e.rule === "signer");
  add({ op: "person_remove", account: friend }, fd); // leaving
});
