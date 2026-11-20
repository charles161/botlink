// The /create/<id> page's pure rules (web/public/assets/js/draft.js) and the signing it shares with "Start a room"
// and the approval (room-start.js, roster.js): the code a person types, chat text shown inert, the card checked
// against itself, and the whole signed chain (genesis, device_add, member_add) verifying from genesis.
//   node --test web/test/draft.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCode, inertText, cardProblems, sameCard, CARD_FIELDS } from "../public/assets/js/draft.js";
import { signRoomStart } from "../public/assets/js/room-start.js";
import { memberAddOp } from "../public/assets/js/roster.js";
import { signRosterEntry, verifyRoster, toHex, uuidv7 } from "../public/assets/js/crypto.js";

const hex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
const card = (over = {}) => ({
  id: "01933b6e-0000-7000-8000-000000000001", room_name: "acme", room_purpose: "Ship it", name: "bugfix", job: "Fixes bugs",
  app: "claude-code", app_name: null, machine: "adams-macbook", folder: "~/acme", turn: "wake",
  member_id: "01933b6e-0000-7000-8000-0000000000aa", ed25519_pk: hex(32), x25519_pk: hex(32),
  expires_at: new Date(Date.now() + 600e3).toISOString(), name_taken: false, ...over,
});

test("the code: case, spaces and one dash between the groups are ignored; anything else is not a code", () => {
  for (const s of ["K7Q2MX", "k7q2mx", "K7Q-2MX", "k7q-2mx", " K7Q 2MX ", "k7q2mX"]) assert.equal(normalizeCode(s), "K7Q2MX", s);
  for (const s of ["", "K7Q2M", "K7Q2MXX", "K7-Q2MX", "K7Q--2MX", "K7Q_2MX", "K7Q2M!", null, undefined, "КЗQ2MX"]) assert.equal(normalizeCode(s), null, String(s));
});

test("chat text: control, bidi and invisible characters become visible marks; ordinary text stays as written", () => {
  assert.equal(inertText("ship <b>it</b> & [x](javascript:alert(1))"), "ship <b>it</b> & [x](javascript:alert(1))");
  assert.equal(inertText("abc\u202Edcba"), "abc[U+202E]dcba");
  assert.equal(inertText("a\u2066b\u2069c\u200Bd\u200Fe\uFEFFf"), "a[U+2066]b[U+2069]c[U+200B]d[U+200F]e[U+FEFF]f");
  assert.equal(inertText("line\nnext\ttab\u0007"), "line[U+000A]next[U+0009]tab[U+0007]");
  assert.equal(inertText("tag\u{E0041}"), "tag[U+E0041]");
  assert.equal(inertText("naïve café 日本 مرحبا"), "naïve café 日本 مرحبا");
  assert.equal(inertText(null), "");
});

test("the card checks out against itself; a wrong id, member id, name, app or key does not", () => {
  const c = card();
  assert.deepEqual(cardProblems(c, c.id), []);
  assert.match(cardProblems(c, "01933b6e-0000-7000-8000-000000000002").join(), /id/);
  assert.match(cardProblems(card({ member_id: "nope" }), c.id).join(), /member_id/);
  assert.match(cardProblems(card({ name: "Bad Name" }), c.id).join(), /name/);
  assert.match(cardProblems(card({ app: "evil" }), c.id).join(), /app/);
  assert.match(cardProblems(card({ ed25519_pk: "ab" }), c.id).join(), /ed25519_pk/);
  assert.match(cardProblems(card({ x25519_pk: hex(32).toUpperCase() }), c.id).join(), /x25519_pk/);
  assert.match(cardProblems(card({ expires_at: "soon" }), c.id).join(), /expires_at/);
  // the room name is the chat's proposal: a bad one is no card problem (the person picks another name)
  assert.deepEqual(cardProblems(card({ room_name: "<b>x</b>" }), c.id), []);
});

test("the same card: every field the person sees counts; name_taken and expires_at do not", () => {
  const a = card();
  assert.ok(sameCard(a, { ...a }));
  assert.ok(sameCard(a, { ...a, name_taken: true, expires_at: new Date().toISOString() }));
  for (const f of CARD_FIELDS) assert.ok(!sameCard(a, { ...a, [f]: `${a[f]}x` }), f);
  assert.ok(CARD_FIELDS.includes("ed25519_pk") && CARD_FIELDS.includes("member_id") && CARD_FIELDS.includes("room_purpose"));
});

test("genesis, device_add for each approved browser, then member_add at the next seq: the chain verifies from genesis", async () => {
  const mk = async (label) => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return { id: uuidv7(), pk: toHex(await crypto.subtle.exportKey("raw", keyPair.publicKey)), label, keyPair };
  };
  const me = await mk("Chrome on Mac"), other = await mk("Firefox on Linux");
  const owner = uuidv7(), id = uuidv7(), c = card();
  const start = await signRoomStart(me, { id, name: "acme", purpose: "Ship it", owner, others: [{ id: other.id, ed25519_pk: other.pk, label: other.label }] });
  assert.equal(start.room.id, id);
  assert.equal(start.room.name, "acme");
  assert.equal(start.room.purpose, "Ship it");
  assert.equal(start.room.entries.length, 1);
  assert.equal(start.headSeq, 1);
  const m = await signRosterEntry(me, { room: id, seq: start.headSeq + 1, prev: start.headHash, ...memberAddOp(c, owner) });
  const v = await verifyRoster(id, [start.room.genesis, ...start.room.entries, m.wire]);
  assert.equal(v.owner, owner);
  assert.equal(v.headSeq, 2);
  const mem = v.members.get(c.member_id);
  assert.deepEqual({ name: mem.name, app: mem.app, ed: mem.ed, x: mem.x, account: mem.account }, { name: c.name, app: c.app, ed: c.ed25519_pk, x: c.x25519_pk, account: owner });
  assert.ok(v.people.get(owner).devices.has(other.pk));
  assert.deepEqual(Object.keys(m.body).sort(), ["account", "app", "at", "by", "ed", "member", "name", "op", "prev", "room", "seq", "v", "x"]);
});
