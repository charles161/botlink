// The rooms home's last message line (web/public/assets/js/lastmsg.js) and the relative time it reuses (dom.js ago):
// just now, N min ago, N h ago, yesterday, N days ago, then a date. Each boundary on both sides.
//   node --test web/test/lastmsg.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ago } from "../public/assets/js/dom.js";
import { lastMessageText, LAST_MESSAGE_TICK_MS } from "../public/assets/js/lastmsg.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const before = (s) => new Date(NOW - s * 1000).toISOString();
const MIN = 60, H = 3600, D = 86400;

test("relative time at each boundary", () => {
  const cases = [
    [0, "just now"],
    [44, "just now"],
    [45, "1 min ago"],
    [89, "1 min ago"],
    [90, "2 min ago"],
    [59 * MIN + 29, "59 min ago"],
    [59 * MIN + 30, "1 h ago"],
    [89 * MIN, "1 h ago"],
    [90 * MIN, "2 h ago"],
    [23 * H + 29 * MIN, "23 h ago"],
    [23 * H + 30 * MIN, "yesterday"],
    [D + 11 * H + 29 * MIN, "yesterday"],
    [D + 12 * H, "2 days ago"],
    [6 * D + 11 * H, "6 days ago"],
  ];
  for (const [s, want] of cases) assert.equal(ago(before(s), NOW), want, `${s} s before`);
});

test("a week and older: a date, not a count", () => {
  for (const s of [6 * D + 12 * H, 30 * D, 400 * D]) {
    const got = ago(before(s), NOW);
    assert.doesNotMatch(got, /ago|yesterday|just now/, `${s} s before: ${got}`);
    assert.match(got, /\d/, `${s} s before: ${got}`);
  }
});

test("a time slightly ahead of this computer's clock is just now, never a negative count", () => {
  assert.equal(ago(new Date(NOW + 30_000).toISOString(), NOW), "just now");
  assert.equal(ago(new Date(NOW + 10 * 60_000).toISOString(), NOW), "just now");
});

test("the line: Last message + the relative time; none yet when the room has none", () => {
  assert.equal(lastMessageText(before(5 * MIN), NOW), "Last message 5 min ago");
  assert.equal(lastMessageText(before(10), NOW), "Last message just now");
  assert.equal(lastMessageText(before(30 * H), NOW), "Last message yesterday");
  assert.equal(lastMessageText(null, NOW), "No messages yet");
  assert.equal(lastMessageText(undefined, NOW), "No messages yet");
  assert.equal(lastMessageText("", NOW), "No messages yet");
});

test("the words stay within the product's rules: no em dash, nothing about reading, being seen or online", () => {
  const texts = [lastMessageText(null, NOW), ...[0, 5 * MIN, 3 * H, 30 * H, 3 * D].map((s) => lastMessageText(before(s), NOW))];
  for (const t of texts) {
    assert.doesNotMatch(t, /—/, t);
    assert.doesNotMatch(t, /\b(active|online|seen|read|last seen)\b/i, t);
  }
});

test("the text is recomputed slowly from the time already loaded, not on a fast loop", () => {
  assert.ok(LAST_MESSAGE_TICK_MS >= 30_000, `tick ${LAST_MESSAGE_TICK_MS} ms`);
});
