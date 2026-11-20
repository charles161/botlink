// Approving several waiting chats of one room together (web/public/assets/js/batch.js, roster.js signChain): which
// requests may be ticked, how a tick is kept or lost when the list is drawn again, the re-read before signing, and the
// chain of member_add entries (the same memberAddOp as a single approval) verifying from genesis.
//   node --test web/test/batch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { BATCH_ACTION, BATCH_MAX, JOIN_FIELDS, sameJoin, joinProblems, batchRooms, createTicks, preSignProblems, lookAlike } from "../public/assets/js/batch.js";
import { signRoomStart } from "../public/assets/js/room-start.js";
import { memberAddOp, signChain } from "../public/assets/js/roster.js";
import { memberFingerprint, verifyRoster, toHex, uuidv7 } from "../public/assets/js/crypto.js";

const hex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
const ROOM = "01933b6e-0000-7000-8000-000000000001";
const ROOM2 = "01933b6e-0000-7000-8000-000000000002";
let n = 0;
const req = (over = {}) => {
  n += 1;
  const tail = String(n).padStart(12, "0");
  return {
    id: `01933b6e-1111-7000-8000-${tail}`, kind: "join", room_id: ROOM, room_name: "acme", member_id: `01933b6e-2222-7000-8000-${tail}`,
    name: `c${hex(4)}x`, job: "Fixes bugs", app: "claude-code", app_name: null, machine: `box-${n}`, folder: "~/acme", turn: "wake",
    match_code: "K7Q2MX", ed25519_pk: hex(32), x25519_pk: hex(32), invite_label: "your chat invite for #acme", readdressed_from_name: null,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600e3).toISOString(), move_to: null, ...over,
  };
};
const device = async (label = "Chrome on Mac") => {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  return { id: uuidv7(), pk: toHex(await crypto.subtle.exportKey("raw", keyPair.publicKey)), label, keyPair };
};

test("the action and the limit are the contract's", () => {
  assert.equal(BATCH_ACTION, "approve_joins");
  assert.equal(BATCH_MAX, 5);
});

test("a card checks out only as a join request with ids, a chat name, an app, two different keys, a code and time left", () => {
  assert.deepEqual(joinProblems(req()), []);
  assert.ok(joinProblems(req({ kind: "claim" })).includes("kind"));
  assert.ok(joinProblems(req({ room_id: "acme" })).includes("room_id"));
  assert.ok(joinProblems(req({ member_id: "x" })).includes("member_id"));
  assert.ok(joinProblems(req({ name: "Bad Name" })).includes("name"));
  assert.ok(joinProblems(req({ app: "chatbot" })).includes("app"));
  assert.ok(joinProblems(req({ ed25519_pk: "zz" })).includes("ed25519_pk"));
  const k = hex(32);
  assert.ok(joinProblems(req({ ed25519_pk: k, x25519_pk: k })).includes("x25519_pk"));
  assert.ok(joinProblems(req({ match_code: "K7Q-2MX" })).includes("match_code"));
  assert.ok(joinProblems(req({ match_code: "O0I1AB" })).includes("match_code"));
  assert.deepEqual(joinProblems(req({ match_code: "K7Q2" })), []); // requests made before r2 keep 4 characters
  assert.ok(joinProblems(req({ expires_at: new Date(Date.now() - 1000).toISOString() })).includes("expires_at"));
  assert.deepEqual(joinProblems(null), ["card"]);
});

test("every field the card shows or the entry carries is compared; a change in any one is a different card", () => {
  for (const f of ["id", "room_id", "member_id", "name", "job", "app", "app_name", "machine", "folder", "match_code", "ed25519_pk", "x25519_pk", "invite_label", "expires_at"]) assert.ok(JOIN_FIELDS.includes(f), f);
  const a = req();
  assert.ok(sameJoin(a, { ...a }));
  for (const f of JOIN_FIELDS) assert.ok(!sameJoin(a, { ...a, [f]: `${a[f]}x` }), f);
  assert.ok(sameJoin({ ...a, app_name: undefined }, { ...a, app_name: null }), "absent and null are the same");
  assert.ok(!sameJoin(a, null) && !sameJoin(null, a));
});

test("only a room with two or more waiting join requests gets tick boxes; moves never count", () => {
  const a = req(), b = req(), c = req({ room_id: ROOM2, room_name: "beta" }), mv = req({ room_id: ROOM2, kind: "claim" }), d = req({ room_id: ROOM2, room_name: "beta" });
  const rooms = batchRooms([a, c, mv, b]);
  assert.deepEqual([...rooms.keys()], [ROOM]);
  assert.deepEqual(rooms.get(ROOM).map((x) => x.id), [a.id, b.id]);
  assert.deepEqual([...batchRooms([a, c, mv, b, d]).keys()], [ROOM, ROOM2]);
  assert.deepEqual(batchRooms([c, mv]).size, 0);
  assert.equal(batchRooms([]).size, 0);
});

test("ticks: nothing ticked at first, at most five per room, each room its own set, untick works", () => {
  const t = createTicks();
  const cards = Array.from({ length: 6 }, () => req());
  assert.equal(t.count(ROOM), 0);
  for (const c of cards.slice(0, 5)) assert.equal(t.tick(c, "fp"), "ok");
  assert.equal(t.tick(cards[5], "fp"), "max");
  assert.equal(t.has(cards[5].id), false);
  assert.equal(t.count(ROOM), 5);
  const other = req({ room_id: ROOM2, room_name: "beta" });
  assert.equal(t.tick(other, "fp"), "ok", "the other room has its own five");
  assert.deepEqual(t.ticked(ROOM2).map((x) => x.card.id), [other.id]);
  assert.ok(t.ticked(ROOM).every((x) => x.card.room_id === ROOM));
  t.untick(cards[0].id);
  assert.equal(t.count(ROOM), 4);
  assert.equal(t.tick(cards[5], "fp"), "ok");
  t.clearRoom(ROOM);
  assert.equal(t.count(ROOM), 0);
  assert.equal(t.count(ROOM2), 1);
});

test("ticks: a card that checks out is the only kind that can be ticked", () => {
  const t = createTicks();
  assert.equal(t.tick(req({ kind: "claim" }), "fp"), "refused");
  assert.equal(t.tick(req({ ed25519_pk: "nope" }), "fp"), "refused");
  assert.equal(t.tick(req(), ""), "refused", "no fingerprint computed yet");
  assert.equal(t.tick(req(), null), "refused");
});

test("ticks: a tick is a copy of what was shown; the caller changing its card object later does not change it", () => {
  const t = createTicks();
  const a = req({ machine: "adams-macbook" });
  t.tick(a, "fp-a");
  a.machine = "elsewhere";
  assert.equal(t.ticked(ROOM)[0].card.machine, "adams-macbook");
  assert.equal(t.ticked(ROOM)[0].fp, "fp-a");
});

test("drawing the list again: an unchanged card keeps its tick, a changed one loses it with a note, a gone one is dropped", () => {
  const t = createTicks();
  const a = req(), b = req(), c = req();
  t.tick(a, "fa"); t.tick(b, "fb"); t.tick(c, "fc");
  const lost = t.reconcile([{ ...a }, { ...b, machine: "laptop-2" }]);
  assert.deepEqual(lost.map((x) => [x.id, x.reason]).sort(), [[b.id, "changed"], [c.id, "gone"]].sort());
  assert.ok(t.has(a.id) && !t.has(b.id) && !t.has(c.id));
  assert.equal(t.note(b.id), "changed");
  assert.equal(t.note(a.id), null);
  t.tick({ ...b, machine: "laptop-2" }, "fb");
  assert.equal(t.note(b.id), null, "ticking it again clears the note");
});

test("before signing: the list read again must hold every ticked card, field for field, with the fingerprint shown", async () => {
  const a = req(), b = req();
  const shown = [{ card: { ...a }, fp: await memberFingerprint(a.ed25519_pk, a.x25519_pk) }, { card: { ...b }, fp: await memberFingerprint(b.ed25519_pk, b.x25519_pk) }];
  assert.deepEqual(await preSignProblems(shown, [a, b, req()]), []);
  assert.deepEqual(await preSignProblems(shown, [a]), [{ id: b.id, name: b.name, reason: "gone" }]);
  assert.deepEqual(await preSignProblems(shown, [a, { ...b, folder: "~/other" }]), [{ id: b.id, name: b.name, reason: "changed" }]);
  const k = hex(32);
  assert.deepEqual(await preSignProblems([{ card: { ...a }, fp: "1111-2222-3333-4444" }], [a]), [{ id: a.id, name: a.name, reason: "changed" }], "a fingerprint other than the one shown");
  const bad = { ...a, ed25519_pk: k, x25519_pk: k };
  assert.deepEqual(await preSignProblems([{ card: bad, fp: await memberFingerprint(k, k) }], [bad]), [{ id: a.id, name: a.name, reason: "changed" }], "a card that no longer checks out");
});

test("the chain: member_add entries at head+1 … head+n, each from memberAddOp, verify from genesis in order", async () => {
  const dev = await device();
  const owner = "01933b6e-0000-7000-8000-0000000000ac";
  const roomId = uuidv7();
  const start = await signRoomStart(dev, { id: roomId, name: "acme", purpose: "", owner, others: [] });
  const cards = [req({ room_id: roomId }), req({ room_id: roomId }), req({ room_id: roomId })];
  const wires = await signChain(dev, { room: roomId, headSeq: start.headSeq, headHash: start.headHash }, cards.map((c) => memberAddOp(c, owner)));
  assert.deepEqual(wires.map((w) => w.seq), [1, 2, 3]);
  const v = await verifyRoster(roomId, [start.room.genesis, ...start.room.entries, ...wires]);
  assert.equal(v.headSeq, 3);
  for (const c of cards) {
    const m = v.members.get(c.member_id);
    assert.ok(m, c.name);
    assert.equal(m.name, c.name); assert.equal(m.account, owner); assert.equal(m.ed, c.ed25519_pk); assert.equal(m.x, c.x25519_pk);
  }
  const entries = wires.map((w) => JSON.parse(Buffer.from(w.entry, "base64url").toString("utf8")));
  assert.deepEqual(entries.map((e) => e.member), cards.map((c) => c.member_id), "in the order given");
  assert.ok(entries.every((e) => e.op === "member_add" && e.by === dev.pk));
});

test("lookalikes: two requests of one room that run in the same place (app, computer, folder), whatever their names", () => {
  const place = { app: "claude-code", app_name: null, machine: "adams-macbook", folder: "~/acme" };
  assert.ok(lookAlike(req({ name: "bugfix", ...place }), req({ name: "deployer", ...place })), "same app, computer and folder");
  assert.ok(!lookAlike(req({ name: "bugfix", ...place }), req({ name: "bugfix2", ...place, folder: "~/acme/web" })), "another folder");
  assert.ok(!lookAlike(req({ name: "bugfix", ...place }), req({ name: "deployer", ...place, machine: "laptop-2" })), "another computer");
  assert.ok(!lookAlike(req({ name: "bugfix", ...place }), req({ name: "deployer", ...place, app: "codex" })), "another app");
  assert.ok(!lookAlike(req({ ...place, app: "other", app_name: "OpenCode" }), req({ ...place, app: "other", app_name: "T3 Code" })), "two different other apps");
  assert.ok(!lookAlike(req({ ...place }), req({ ...place, room_id: ROOM2 })), "only in one room");
  const a = req({ ...place });
  assert.ok(!lookAlike(a, a), "a card is not its own lookalike");
});

test("ticks: a card that runs where a ticked one runs is refused; another place or another room is fine", () => {
  const t = createTicks();
  const place = { machine: "adams-macbook", folder: "~/acme" };
  const a = req({ name: "bugfix", ...place }), b = req({ name: "deployer", ...place }), c = req({ name: "writer", ...place, folder: "~/docs" });
  assert.equal(t.tick(a, "fp"), "ok");
  assert.equal(t.tick(b, "fp"), "lookalike");
  assert.equal(t.has(b.id), false);
  assert.equal(t.tick(c, "fp"), "ok");
  assert.equal(t.tick(req({ ...place, room_id: ROOM2, room_name: "beta" }), "fp"), "ok");
  t.untick(a.id);
  assert.equal(t.tick(b, "fp"), "ok", "once the first is unticked the second may be ticked");
});
