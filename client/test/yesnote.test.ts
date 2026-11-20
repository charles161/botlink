/**
 * The signed "my human said yes" note (yesnote.ts, crypto/ENVELOPE.md §4a): its format, its inner signature, and the
 * checks anyone holding the room's signed member list can make without any key to open messages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as c from "../src/crypto.js";
import { makeEntry, verifyRoster, entryHash, type SignedEntry } from "../src/roster.js";
import * as yn from "../src/yesnote.js";
import { buildYesVectors } from "./gen-yes-vectors.js";

const VEC = join(import.meta.dirname, "..", "..", "crypto", "vectors", "yes-note.json");
const seed = (n: string) => c.sha256hex(`botlink-yes-test|${n}`);

const ROOM = "0193b000-0000-7000-8000-00000000a0a0";
const ADAM = "0193b000-0000-7000-8000-0000000000a1";
const PRIYA = "0193b000-0000-7000-8000-0000000000b2";
const REQ = "0193b000-0000-7000-8000-00000000c001"; // Adam's chat "bugfix": it asked
const APP = "0193b000-0000-7000-8000-00000000c002"; // Priya's chat "helper": its human said yes
const T0 = 1762339200;

async function world() {
  await c.ready();
  const dA = { seed: seed("dev-adam"), pk: c.edPkFromSeed(seed("dev-adam")) };
  const dP = { seed: seed("dev-priya"), pk: c.edPkFromSeed(seed("dev-priya")) };
  const req = c.keysFromSeeds(seed("req-ed"), seed("req-x"));
  const app = c.keysFromSeeds(seed("app-ed"), seed("app-x"));
  const es: SignedEntry[] = [];
  const add = (f: Record<string, unknown>, by: { seed: string; pk: string }, at = T0) => es.push(makeEntry({ room: ROOM, ...f }, es.length, es.length ? entryHash(es[es.length - 1]) : null, by.pk, by.seed, at));
  add({ op: "genesis", name: "acme", owner: ADAM, device: dA.pk }, dA);
  add({ op: "person_add", account: PRIYA, name: "Priya", device: dP.pk }, dA);
  add({ op: "member_add", member: REQ, account: ADAM, name: "bugfix", app: "claude-code", ed: req.ed, x: req.x }, dA);
  add({ op: "member_add", member: APP, account: PRIYA, name: "helper", app: "codex", ed: app.ed, x: app.x }, dP);
  return { es, roster: verifyRoster(ROOM, es), req, app, dP };
}

const yesBody = (w: Awaited<ReturnType<typeof world>>, over: Partial<yn.YesBody> = {}): yn.YesBody => ({
  v: 1, kind: "yes", id: "0193b000-0000-7000-8000-00000000d001", room: ROOM, at: T0 + 60,
  by: { member: APP, fp: c.memberFingerprint(w.app.ed, w.app.x), account: PRIYA, person: "Priya" },
  how: "chat",
  request: { id: "0193b000-0000-7000-8000-00000000e001", from: REQ, from_fp: c.memberFingerprint(w.req.ed, w.req.x), text_sha256: c.sha256hex("Run the test suite, please.") },
  action: "run_command", summary: "Run npm test in the shared repo for bugfix.",
  ...over,
});
const hdr = (b: yn.NoteBody) => ({ id: b.id, room: b.room, from: b.by.member, from_fp: b.by.fp });

test("a note made by the approving member checks out with the signed member list alone", async () => {
  const w = await world();
  const b = yesBody(w);
  const n = yn.makeNote(b, w.app.ed_sk);
  assert.deepEqual(Object.keys(n), ["v", "body", "sig"]);
  const r = yn.verifyNote(n, hdr(b), w.roster, { now: T0 + 120 });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.kind, "yes");
  assert.equal(r.signer.name, "helper");
  assert.equal(r.signer.person, "Priya");
  assert.equal(r.signer.person_signed, true);
  assert.equal(r.device, "absent");
  assert.deepEqual(r.body, b);
  // without the message around it (an outsider holding only the member list and the note)
  assert.equal(yn.verifyNote(n, null, w.roster, { now: T0 + 120 }).ok, true);
  // the signed bytes are exactly the body that travels with it, under its own context tag
  assert.ok(c.verifyCtx(yn.CTX_YES, c.b64urlDecode(n.body), n.sig, w.app.ed));
  assert.ok(!c.verifyCtx(c.CTX_ENV, c.b64urlDecode(n.body), n.sig, w.app.ed), "a note signature is never a message signature");
});

test("what does not check out, each with the rule it breaks", async () => {
  const w = await world();
  const b = yesBody(w);
  const n = yn.makeNote(b, w.app.ed_sk);
  const rule = (note: unknown, h: any = hdr(b), o: { now?: number; resendOf?: string | null } = { now: T0 + 120 }) => {
    const r = yn.verifyNote(note, h, w.roster, o);
    return r.ok ? "ok" : r.rule;
  };
  const reBody = (obj: unknown) => c.b64urlEncode(Buffer.from(JSON.stringify(obj), "utf-8"));
  assert.equal(rule({ ...n, sig: n.sig.slice(0, -2) + (n.sig.endsWith("00") ? "01" : "00") }), "sig");
  assert.equal(rule(yn.makeNote(b, w.req.ed_sk)), "sig", "signed with another member's key");
  assert.equal(rule({ ...n, body: reBody({ ...b, summary: "Delete the production database." }) }), "sig", "body changed after signing");
  assert.equal(rule(yn.makeNote({ ...b, by: { ...b.by, member: "0193b000-0000-7000-8000-00000000c0ff" } }, w.app.ed_sk), null), "signer", "not in the member list");
  assert.equal(rule(yn.makeNote({ ...b, by: { ...b.by, account: ADAM } }, w.app.ed_sk)), "signer", "another person's chat");
  assert.equal(rule(yn.makeNote({ ...b, by: { ...b.by, fp: "0000-0000-0000-0000" } }, w.app.ed_sk), null), "signer", "a key the member never had");
  assert.equal(rule(yn.makeNote({ ...b, room: "0193b000-0000-7000-8000-00000000a0ff" }, w.app.ed_sk), null), "room");
  assert.equal(rule(n, { ...hdr(b), from: REQ, from_fp: b.request.from_fp }), "sender", "passed on inside another member's message");
  assert.equal(rule(n, { ...hdr(b), id: "0193b000-0000-7000-8000-00000000d0ff" }), "id", "moved to another message");
  assert.equal(rule(n, { ...hdr(b), id: "0193b000-0000-7000-8000-00000000d0ff" }, { now: T0 + 120, resendOf: b.id }), "ok", "a re-send of the same message keeps its note");
  assert.equal(rule(yn.makeNote({ ...b, by: { ...b.by, person: "Mallory" } }, w.app.ed_sk)), "person", "the person's name differs from the signed list");
  assert.equal(rule(yn.makeNote({ ...b, request: { ...b.request, from: APP } }, w.app.ed_sk)), "request", "a chat says yes to its own request");
  // the body's shape
  assert.throws(() => yn.makeNote({ ...b, summary: "x".repeat(201) }, w.app.ed_sk), /summary/);
  const raw = (obj: unknown, s = w.app.ed_sk) => {
    const bytes = Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj), "utf-8");
    return { v: 1, body: c.b64urlEncode(bytes), sig: c.signCtx(yn.CTX_YES, bytes, s) };
  };
  assert.equal(rule(raw(b)), "ok", "the same bytes, signed by hand");
  assert.equal(rule(raw({ ...b, summary: "x".repeat(201) })), "bad_body");
  assert.equal(rule(raw({ ...b, summary: "line one\nline two" })), "bad_body", "one line");
  assert.equal(rule(raw({ ...b, action: "launch_rockets" })), "bad_body");
  assert.equal(rule(raw({ ...b, how: "model" })), "bad_body");
  assert.equal(rule(raw({ ...b, extra: 1 })), "bad_body", "no unknown fields");
  assert.equal(rule(raw(JSON.stringify(b).replace('"v":1,', '"v":1,"v":1,'))), "bad_body", "duplicate keys");
  assert.equal(rule({ ...n, v: 2 }), "bad_wire");
  assert.equal(rule({ v: 1, body: n.body }), "bad_wire");
  assert.equal(rule("Priya said yes"), "bad_wire");
  // a later countersignature by the person's browser device is reserved: carried, never checked in v1
  const dev = yn.verifyNote({ ...n, device: { pk: w.dP.pk, sig: "ab".repeat(64) } }, hdr(b), w.roster, { now: T0 + 120 });
  assert.equal(dev.ok && dev.device, "not_checked");
});

test("a note signed with the key the member had before it moved: accepted as ENVELOPE §4 check 1b says", async () => {
  const w = await world();
  const moved = c.keysFromSeeds(seed("app-ed-2"), seed("app-x-2"));
  const es = [...w.es];
  es.push(makeEntry({ room: ROOM, op: "member_rekey", member: APP, ed: moved.ed, x: moved.x }, es.length, entryHash(es[es.length - 1]), w.dP.pk, w.dP.seed, T0 + 1000));
  const roster = verifyRoster(ROOM, es);
  const before = yesBody(w, { at: T0 + 500 });
  const r = yn.verifyNote(yn.makeNote(before, w.app.ed_sk), hdr(before), roster, { now: T0 + 2000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.ok && r.signer.earlier_key);
  const after = yesBody(w, { at: T0 + 1400 });
  const r2 = yn.verifyNote(yn.makeNote(after, w.app.ed_sk), hdr(after), roster, { now: T0 + 2000 });
  assert.equal(!r2.ok && r2.rule, "signer", "signed with the earlier key after the move");
  const r3 = yn.verifyNote(yn.makeNote(before, w.app.ed_sk), hdr(before), roster, { now: T0 + 1000 + 8 * 86400 });
  assert.equal(!r3.ok && r3.rule, "signer", "too long after the move");
  // with the new key: fine
  const nb = yesBody(w, { at: T0 + 1500, by: { member: APP, fp: c.memberFingerprint(moved.ed, moved.x), account: PRIYA, person: "Priya" } });
  assert.equal(yn.verifyNote(yn.makeNote(nb, moved.ed_sk), hdr(nb), roster, { now: T0 + 2000 }).ok, true);
});

test("a standing grant note (kind allow) to the member it was given to", async () => {
  const w = await world();
  const a: yn.AllowBody = { v: 1, kind: "allow", id: "0193b000-0000-7000-8000-00000000d002", room: ROOM, at: T0 + 60, by: yesBody(w).by, how: "terminal", grant: { member: REQ, fp: c.memberFingerprint(w.req.ed, w.req.x), setting: "tasks", while_away: false } };
  const r = yn.verifyNote(yn.makeNote(a, w.app.ed_sk), hdr(a), w.roster, { now: T0 + 120 });
  assert.equal(r.ok && r.kind, "allow");
  assert.throws(() => yn.makeNote({ ...a, grant: { ...a.grant, setting: "root" as any } }, w.app.ed_sk), /setting/);
  const self = { ...a, grant: { ...a.grant, member: APP } };
  const r2 = yn.verifyNote(yn.makeNote(self, w.app.ed_sk), hdr(self), w.roster, { now: T0 + 120 });
  assert.equal(!r2.ok && r2.rule, "request", "a chat grants nothing to itself");
});

test("the action words a person reads, and the words a chat may use for them", () => {
  assert.deepEqual([...yn.ACTIONS], ["read_files", "run_command", "change_files", "send_outside", "spend_money", "other"]);
  assert.equal(yn.parseAction("run a command"), "run_command");
  assert.equal(yn.parseAction("Run-Command"), "run_command");
  assert.equal(yn.parseAction("spend money"), "spend_money");
  assert.equal(yn.parseAction("launch"), null);
  assert.equal(yn.ACTION_SAYS.send_outside, "send something outside the room");
});

test("vectors: crypto/vectors/yes-note.json is what the generator makes, and every case checks as it says", async () => {
  const v = JSON.parse(readFileSync(VEC, "utf-8"));
  assert.deepEqual(v, JSON.parse(JSON.stringify(await buildYesVectors())), "regenerate: node --import tsx client/test/gen-yes-vectors.ts");
  const roster = verifyRoster(v.room_id, v.roster);
  assert.ok(v.valid.length >= 3 && v.invalid.length >= 12);
  for (const x of v.valid) {
    const r = yn.verifyNote(x.note, x.header, roster, { now: v.now, resendOf: x.resend_of ?? null });
    assert.equal(r.ok, true, `${x.name}: ${JSON.stringify(r)}`);
    if (r.ok) {
      assert.equal(r.kind, x.expect.kind, x.name);
      assert.equal(r.device, x.expect.device, x.name);
      assert.equal(!!r.signer.earlier_key, !!x.expect.earlier_key, x.name);
      assert.equal(Buffer.from(x.note.body, "base64url").toString("utf-8"), x.body_json, x.name);
    }
  }
  for (const x of v.invalid) {
    const r = yn.verifyNote(x.note, x.header, roster, { now: v.now, resendOf: x.resend_of ?? null });
    assert.equal(r.ok ? "ok" : r.rule, x.expect.rule, x.name);
  }
});
