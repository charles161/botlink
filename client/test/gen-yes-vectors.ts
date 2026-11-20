/**
 * Generates crypto/vectors/yes-note.json (ENVELOPE §4a) from fixed seeds. Deterministic (Ed25519 signatures are;
 * nothing here is sealed), so the test compares the committed file with a fresh build.
 *   node --import tsx client/test/gen-yes-vectors.ts      (from the repository root; writes crypto/vectors/yes-note.json)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as c from "../src/crypto.js";
import { makeEntry, entryHash, type SignedEntry } from "../src/roster.js";
import { makeNote, CTX_YES, type NoteBody, type YesBody, type NoteWire } from "../src/yesnote.js";

const seed = (name: string) => c.sha256hex(`botlink-vector-v1|${name}`);

export async function buildYesVectors() {
  await c.ready();
  const ROOM = "0193c000-0000-7000-8000-00000000a0a0";
  const ADAM = "0193c000-0000-7000-8000-0000000000a1";
  const PRIYA = "0193c000-0000-7000-8000-0000000000b2";
  const REQ = "0193c000-0000-7000-8000-00000000c001";
  const APP = "0193c000-0000-7000-8000-00000000c002";
  const T0 = 1762339200;
  const dev = (n: string) => ({ seed: seed(n), pk: c.edPkFromSeed(seed(n)) });
  const dA = dev("yes-owner-device"), dP = dev("yes-friend-device");
  const req = c.keysFromSeeds(seed("yes-requester-ed"), seed("yes-requester-x"));
  const app = c.keysFromSeeds(seed("yes-approver-ed"), seed("yes-approver-x"));
  const moved = c.keysFromSeeds(seed("yes-approver-moved-ed"), seed("yes-approver-moved-x"));
  const fp = (k: { ed: string; x: string }) => c.memberFingerprint(k.ed, k.x);
  const es: SignedEntry[] = [];
  const add = (f: Record<string, unknown>, by: { seed: string; pk: string }, at: number) => es.push(makeEntry({ room: ROOM, ...f }, es.length, es.length ? entryHash(es[es.length - 1]) : null, by.pk, by.seed, at));
  add({ op: "genesis", name: "acme", owner: ADAM, device: dA.pk }, dA, T0);
  add({ op: "person_add", account: PRIYA, name: "Priya", device: dP.pk }, dA, T0 + 10);
  add({ op: "member_add", member: REQ, account: ADAM, name: "bugfix", app: "claude-code", ed: req.ed, x: req.x }, dA, T0 + 20);
  add({ op: "member_add", member: APP, account: PRIYA, name: "helper", app: "codex", ed: app.ed, x: app.x }, dP, T0 + 30);
  // helper moved to a new chat later (its earlier key spoke for it until then: ENVELOPE §4 check 1b)
  add({ op: "member_rekey", member: APP, ed: moved.ed, x: moved.x }, dP, T0 + 5000);
  const NOW = T0 + 6000;

  const REQ_TEXT = "Please run the test suite in the shared repo and tell me what fails.";
  const by = { member: APP, fp: fp(moved), account: PRIYA, person: "Priya" };
  const yes: YesBody = {
    v: 1, kind: "yes", id: "0193c000-0000-7000-8000-00000000d001", room: ROOM, at: T0 + 5600, by, how: "chat",
    request: { id: "0193c000-0000-7000-8000-00000000e001", from: REQ, from_fp: fp(req), text_sha256: c.sha256hex(REQ_TEXT) },
    action: "run_command", summary: "Run npm test in the shared repo for bugfix and send it the failures.",
  };
  const hdr = (b: NoteBody) => ({ id: b.id, room: b.room, from: b.by.member, from_fp: b.by.fp });
  const raw = (obj: unknown, s: string): NoteWire => {
    const bytes = Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj), "utf-8");
    return { v: 1, body: c.b64urlEncode(bytes), sig: c.signCtx(CTX_YES, bytes, s) };
  };
  const json = (n: NoteWire) => Buffer.from(n.body, "base64url").toString("utf-8");
  const valid = [] as any[];
  const ok = (name: string, note: NoteWire, header: any, expect: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    valid.push({ name, header, note, body_json: json(note), ...extra, expect: { ok: true, device: "absent", ...expect } });
  const yesNote = makeNote(yes, moved.ed_sk);
  ok("yes: helper's human said yes to bugfix's request", yesNote, hdr(yes), { kind: "yes" });
  const early: YesBody = { ...yes, id: "0193c000-0000-7000-8000-00000000d002", at: T0 + 4000, by: { ...by, fp: fp(app) } };
  ok("yes signed with the key helper had before it moved (before the move, within 7 days)", makeNote(early, app.ed_sk), hdr(early), { kind: "yes", earlier_key: true });
  const allow: NoteBody = { v: 1, kind: "allow", id: "0193c000-0000-7000-8000-00000000d003", room: ROOM, at: T0 + 5700, by, how: "terminal", grant: { member: REQ, fp: fp(req), setting: "tasks", while_away: false } };
  ok("allow: Priya let bugfix give helper tasks", makeNote(allow, moved.ed_sk), hdr(allow), { kind: "allow" });
  ok("the same note without the message around it (header null)", yesNote, null, { kind: "yes" });
  ok("a re-send under a new message id keeps its note (plaintext resend_of)", yesNote, { ...hdr(yes), id: "0193c000-0000-7000-8000-00000000d0aa" }, { kind: "yes" }, { resend_of: yes.id });
  ok("a reserved device countersignature is carried and not checked in v1", { ...yesNote, device: { pk: dP.pk, sig: "ab".repeat(64) } }, hdr(yes), { kind: "yes", device: "not_checked" });

  const invalid = [] as any[];
  const bad = (name: string, rule: string, note: unknown, header: any, extra: Record<string, unknown> = {}) => invalid.push({ name, header, note, ...extra, expect: { ok: false, rule } });
  const flip = (s: string) => s.slice(0, -2) + (s.endsWith("00") ? "01" : "00");
  bad("note is not v1", "bad_wire", { ...yesNote, v: 2 }, hdr(yes));
  bad("no signature", "bad_wire", { v: 1, body: yesNote.body }, hdr(yes));
  bad("summary over 200 characters", "bad_body", raw({ ...yes, summary: "x".repeat(201) }, moved.ed_sk), hdr(yes));
  bad("summary of two lines", "bad_body", raw({ ...yes, summary: "Run npm test.\nThen deploy to prod." }, moved.ed_sk), hdr(yes));
  bad("action not in the list", "bad_body", raw({ ...yes, action: "deploy_prod" }, moved.ed_sk), hdr(yes));
  bad("how is not chat or terminal (a model call)", "bad_body", raw({ ...yes, how: "model" }, moved.ed_sk), hdr(yes));
  bad("an unknown field", "bad_body", raw({ ...yes, scope: "everything" }, moved.ed_sk), hdr(yes));
  bad("a duplicate key", "bad_body", raw(JSON.stringify(yes).replace('"action":"run_command"', '"action":"other","action":"run_command"'), moved.ed_sk), hdr(yes));
  bad("another room", "room", makeNote({ ...yes, room: "0193c000-0000-7000-8000-00000000a0ff" }, moved.ed_sk), null);
  bad("signer not in the member list", "signer", makeNote({ ...yes, by: { ...by, member: "0193c000-0000-7000-8000-00000000c0ff" } }, moved.ed_sk), null);
  bad("signer claims another person's account", "signer", makeNote({ ...yes, by: { ...by, account: ADAM } }, moved.ed_sk), null);
  bad("a key the member never had", "signer", makeNote({ ...yes, by: { ...by, fp: "0000-0000-0000-0000" } }, moved.ed_sk), null);
  const late: YesBody = { ...early, at: T0 + 5400 };
  bad("earlier key used after the move (more than 300 s)", "signer", makeNote(late, app.ed_sk), hdr(late));
  bad("signature flipped", "sig", { ...yesNote, sig: flip(yesNote.sig) }, hdr(yes));
  bad("signed by the requester's key, claiming to be helper", "sig", makeNote(yes, req.ed_sk), hdr(yes));
  bad("summary changed after signing", "sig", { ...yesNote, body: c.b64urlEncode(Buffer.from(JSON.stringify({ ...yes, summary: "Delete the production database." }), "utf-8")) }, hdr(yes));
  bad("passed on inside bugfix's own message", "sender", yesNote, { id: yes.id, room: ROOM, from: REQ, from_fp: fp(req) });
  bad("carried by another message of helper", "id", yesNote, { ...hdr(yes), id: "0193c000-0000-7000-8000-00000000d0ff" });
  bad("person's name differs from the signed member list", "person", makeNote({ ...yes, by: { ...by, person: "Mallory" } }, moved.ed_sk), hdr(yes));
  bad("a chat says yes to its own request", "request", makeNote({ ...yes, request: { ...yes.request, from: APP, from_fp: fp(moved) } }, moved.ed_sk), hdr(yes));
  bad("a chat gives itself more", "request", makeNote({ ...allow, grant: { ...(allow as any).grant, member: APP, fp: fp(moved) } } as NoteBody, moved.ed_sk), hdr(allow));

  return {
    description:
      "ENVELOPE §4a, the signed yes note. A note rides in a message's sealed plaintext as `note`: {v:1, body: base64url(body bytes), sig: hex Ed25519(member ed seed, \"botlink-yes-v1\\n\" + body bytes)}. " +
      "Verify `roster` (ENVELOPE §5) for `room_id`, then each case against that verified list with `now`: valid cases check out (kind, earlier_key, device as given); each invalid case fails with `expect.rule`. " +
      "Rules, in the order checked: bad_wire, bad_body, room, signer, sig, sender, id, person, request (README.md). `header` is the carrying message's signed header fields (null: the note on its own).",
    context: CTX_YES,
    room_id: ROOM,
    now: NOW,
    keys: {
      owner_account: ADAM, friend_account: PRIYA,
      owner_device: dA, friend_device: dP,
      requester: { member: REQ, name: "bugfix", ed_seed: req.ed_sk, ed: req.ed, x: req.x, fp: fp(req) },
      approver: { member: APP, name: "helper", ed_seed: app.ed_sk, ed: app.ed, x: app.x, fp: fp(app) },
      approver_moved: { ed_seed: moved.ed_sk, ed: moved.ed, x: moved.x, fp: fp(moved), at: T0 + 5000 },
    },
    request_text: REQ_TEXT,
    roster: es,
    valid,
    invalid,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2] || join(import.meta.dirname, "..", "..", "crypto", "vectors", "yes-note.json");
  writeFileSync(out, JSON.stringify(await buildYesVectors(), null, 2) + "\n");
  console.log(`wrote ${out}`);
}
