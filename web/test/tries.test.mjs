// Join requests from one place shown as one card (web/public/assets/js/tries.js): which requests share a card, which
// one the card shows and acts on, how many different codes wait, and the batch units built from them.
//   node --test web/test/tries.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinTries, placeKey, codesWaiting, triesKey } from "../public/assets/js/tries.js";
import { batchRooms } from "../public/assets/js/batch.js";

const ROOM = "01933b6e-0000-7000-8000-000000000001";
const ROOM2 = "01933b6e-0000-7000-8000-000000000002";
let n = 0;
const at = (ageS) => new Date(Date.now() - ageS * 1000).toISOString();
const req = (over = {}) => {
  n += 1;
  const tail = String(n).padStart(12, "0");
  return {
    id: `01933b6e-1111-7000-8000-${tail}`, kind: "join", room_id: ROOM, room_name: "neon", name: `chat-${n}`,
    app: "other", app_name: "OpenCode", machine: "Charless-MacBook-Air.local", folder: "~/Documents/Default Project",
    match_code: `K7Q2M${"ABCDEFGHJK"[n % 10]}`, created_at: at(600 - n), expires_at: at(-600), ...over,
  };
};

test("four tries from one computer, folder and app are one card that shows the newest", () => {
  const a = req({ name: "opencode", created_at: at(600) });
  const b = req({ name: "opencode-2", created_at: at(420) });
  const c = req({ name: "opencode-mj", created_at: at(240) });
  const d = req({ name: "sec-research", created_at: at(60) });
  const units = joinTries([a, b, c, d]);
  assert.equal(units.length, 1);
  assert.equal(units[0].newest.id, d.id);
  assert.deepEqual(units[0].older.map((x) => x.name), ["opencode-mj", "opencode-2", "opencode"]);
  assert.equal(units[0].all.length, 4);
  assert.equal(codesWaiting(units[0]), 4);
});

test("the newest is by created time, not list order; a tie goes to the later one in the list", () => {
  const a = req({ created_at: at(10) });
  const b = req({ created_at: at(300) });
  assert.equal(joinTries([a, b])[0].newest.id, a.id);
  const t = at(50);
  const c = req({ created_at: t, room_id: ROOM2 });
  const d = req({ created_at: t, room_id: ROOM2 });
  assert.equal(joinTries([c, d])[0].newest.id, d.id);
});

test("a single request is its own unit with nothing older", () => {
  const a = req();
  const units = joinTries([a]);
  assert.equal(units.length, 1);
  assert.equal(units[0].newest, a);
  assert.deepEqual(units[0].older, []);
});

test("different computers, folders, apps or rooms never share a card", () => {
  const base = req();
  const others = [
    req({ machine: "other-mac" }), req({ folder: "~/elsewhere" }), req({ app: "claude-code", app_name: null }),
    req({ app_name: "Kilo" }), req({ room_id: ROOM2 }),
  ];
  const units = joinTries([base, ...others]);
  assert.equal(units.length, 6);
  for (const u of units) assert.equal(u.older.length, 0);
});

test("requests missing the computer or the folder are never grouped, not even with each other", () => {
  const list = [req({ machine: null }), req({ machine: null }), req({ machine: "" }), req({ folder: null }), req({ folder: undefined }), req({ app: "" })];
  for (const c of list) assert.equal(placeKey(c), null);
  assert.equal(joinTries(list).length, list.length);
});

test("moves never share a card with joins (or with each other)", () => {
  const j = req();
  const m1 = req({ kind: "claim" });
  const m2 = req({ kind: "claim" });
  assert.equal(placeKey(m1), null);
  const units = joinTries([j, m1, m2]);
  assert.equal(units.length, 3);
});

test("a unit keeps the place of its first request in the list, so a new try never moves the card", () => {
  const x = req({ machine: "box-x", created_at: at(500) });
  const a = req({ created_at: at(400) });
  const y = req({ machine: "box-y", created_at: at(300) });
  const b = req({ created_at: at(10) });
  const units = joinTries([x, a, y, b]);
  assert.deepEqual(units.map((u) => u.newest.id), [x.id, b.id, y.id]);
});

test("a copied place inside the group: its own code is counted, the newest stays the one shown", () => {
  const mine = req({ name: "opencode", match_code: "NZXQCU", created_at: at(30) });
  const copy = req({ name: "opencode-x", match_code: "QJPS8X", created_at: at(90) });
  const [u] = joinTries([copy, mine]);
  assert.equal(u.newest.id, mine.id);
  assert.deepEqual(u.older.map((x) => x.id), [copy.id]);
  assert.equal(codesWaiting(u), 2);
  // the same code twice is one code
  const same = req({ match_code: "NZXQCU", created_at: at(5), room_id: ROOM2 });
  const same2 = req({ match_code: "NZXQCU", created_at: at(6), room_id: ROOM2 });
  assert.equal(codesWaiting(joinTries([same, same2])[0]), 1);
});

test("the card's key is the same for every try of one place and differs between places", () => {
  const a = req(), b = req();
  assert.equal(triesKey(joinTries([a])[0]), triesKey(joinTries([a, b])[0]));
  assert.notEqual(triesKey(joinTries([a])[0]), triesKey(joinTries([req({ folder: "~/x" })])[0]));
  assert.match(triesKey(joinTries([a])[0]), /^[a-z0-9-]+$/);
});

test("batch units: one room with only one group of tries is not a batch; a group and another chat are", () => {
  const tries = [req({ created_at: at(300) }), req({ created_at: at(200) }), req({ created_at: at(100) })];
  const units = joinTries(tries).map((u) => u.newest);
  assert.equal(batchRooms(units).size, 0);
  const other = req({ machine: "another-box" });
  const units2 = joinTries([...tries, other]).map((u) => u.newest);
  assert.equal(batchRooms(units2).get(ROOM).length, 2);
});
