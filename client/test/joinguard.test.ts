// Security review 12 Nov 2026, item 11: the join guard (whose chats a link adds; a request that waits for another
// person than this computer's chats in the room). Pure functions: members are passed in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { whoseLink, wrongPersonWaiting, wrongPersonApproved } from "../src/joinguard.js";

const S = "https://app.botlink.dev";
const room = { id: "01a1cbd8-0000-7000-8000-000000000001", name: "shared" };
const mem = (person_name: string, account: string, over: any = {}) => ({ server: S, room, person_name, account, ...over }) as any;

test("join output says whose chats the link adds", () => {
  assert.match(whoseLink("Charles"), /adds Charles's own chats/);
  assert.match(whoseLink("Charles"), /person invite/);
});

test("waiting for another person than this computer's chats in the room: say so, stop", () => {
  const t = wrongPersonWaiting(S, room, "Charles", [mem("Victor", "acct-v")]);
  assert.ok(t);
  assert.match(t!, /other chats in #shared are Victor's/);
  assert.match(t!, /Not waiting for Charles\.$/);
});

test("not judged: no chats here, the approver's own chats, chats of several people, another room or server", () => {
  assert.equal(wrongPersonWaiting(S, room, "Charles", []), null);
  assert.equal(wrongPersonWaiting(S, room, "Charles", [mem("Charles", "acct-c")]), null);
  assert.equal(wrongPersonWaiting(S, room, "Charles", [mem("Victor", "acct-v"), mem("Charles", "acct-c")]), null);
  assert.equal(wrongPersonWaiting(S, room, "Charles", [mem("Victor", "acct-v", { room: { id: "other", name: "x" } })]), null);
  assert.equal(wrongPersonWaiting(S, room, "Charles", [mem("Victor", "acct-v", { server: "http://other" })]), null);
});

test("approved as another account's chat than this computer's: refuse with what to do", () => {
  const t = wrongPersonApproved(S, room, "acct-c", "Charles", [mem("Victor", "acct-v")]);
  assert.match(t!, /Charles approved this chat as Charles's chat, but this computer's other chats in #shared are Victor's/);
  assert.equal(wrongPersonApproved(S, room, "acct-v", "Victor", [mem("Victor", "acct-v")]), null);
  assert.equal(wrongPersonApproved(S, room, "acct-c", "Charles", []), null);
});
