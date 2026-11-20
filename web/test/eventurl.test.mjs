// An event address a person approves (docs/protocol/event-url-approval.md §2-4): the rules that need no page.
// The host shown large is the server's `host` exactly (what bot-link dials), and it must equal both the browser's parse
// of the address and the host as written in it; an encoded (xn--) name is never offered for approval; the request is
// checked against itself and compared before the passkey step and before sending; our sentences.
//   node --test web/test/eventurl.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVE_ACTION, EVENTS, WARNING, COMPARE, ENCODED, lasts, CHANGED, BLOCKED, UNREACHABLE, HC_FAILED, approvedText, stopBody, tooMany,
  hostView, writtenHost, sameRequest, requestProblems, REQUEST_FIELDS,
} from "../public/assets/js/eventurl.js";
import * as all from "../public/assets/js/eventurl.js";

const item = (over = {}) => ({
  id: "01933b6e-0000-7000-8000-000000000001",
  member: { id: "01933b6e-0000-7000-8000-0000000000aa", name: "planner" },
  room: { id: "01933b6e-0000-7000-8000-0000000000bb", name: "acme" },
  url: "https://hooks.example.com/routine/abc?key=k1", host: "hooks.example.com", name: "message.received", urgent_only: false,
  created_at: "2026-11-17T10:00:00Z", expires_at: "2026-11-18T10:00:00Z", ...over,
});

test("the human check action is the contract's", () => assert.equal(APPROVE_ACTION, "approve_event_url"));

test("no Unicode form of a host is made anywhere (security review: a look-alike shown large)", () => {
  assert.equal(all.unicodeHost, undefined);
  assert.equal(all.LOOKALIKE, undefined);
});

test("the host shown is the server's host byte for byte, never the name before an @", () => {
  const v = hostView("https://good.example@evil.example/", { serverHost: "evil.example" });
  assert.deepEqual(v.problems, []);
  assert.equal(v.host, "evil.example");
  assert.equal(v.userinfo, true);
  assert.deepEqual(hostView("https://good.example@evil.example/", { serverHost: "good.example" }).problems, ["host"]);
  assert.equal(hostView("https://hooks.example.com/a", { serverHost: "hooks.example.com" }).userinfo, false);
});

test("an encoded (xn--) host is shown as it is and never offered for approval", () => {
  for (const h of ["xn--80ak6aa92e.com", "xn--pypal-4ve.com", "hooks.xn--p1ai", "XN--80ak6aa92e.com"]) {
    const v = hostView(`https://${h}/hook`, { serverHost: h.toLowerCase() });
    assert.equal(v.host, h.toLowerCase(), h);
    assert.deepEqual(v.problems, ["encoded"], h);
    assert.equal(v.encoded, true, h);
  }
  assert.ok(hostView("https://аpple.com/", { serverHost: "xn--pple-43d.com" }).problems.includes("host"), "a host written in Unicode");
  assert.equal(hostView("https://notxn--.example/", { serverHost: "notxn--.example" }).encoded, false);
});

test("a host the browser's parser rewrites is refused: number forms, a trailing dot, percent-encoding, backslashes", () => {
  for (const h of ["16843009", "0x01010101", "1.1.257", "001.001.001.001", "1.1.1.1.", "0x1.1.1.1", "1.1.1.0x1"]) {
    assert.deepEqual(hostView(`https://${h}/x`, { serverHost: "1.1.1.1" }).problems, ["host"], `${h} vs 1.1.1.1`);
    assert.deepEqual(hostView(`https://${h}/x`, { serverHost: h }).problems, ["host"], `${h} vs itself`);
  }
  assert.deepEqual(hostView("https://1.1.1.1/x", { serverHost: "1.1.1.1" }).problems, []);
  assert.deepEqual(hostView("https://%65vil.example/", { serverHost: "evil.example" }).problems, ["host"]);
  assert.deepEqual(hostView("https://evil.example\\.good.example/", { serverHost: "evil.example" }).problems, ["host"]);
  assert.deepEqual(hostView("https:\\\\evil.example/", { serverHost: "evil.example" }).problems, ["host"]);
  assert.deepEqual(hostView("https://[0:0::1]/", { serverHost: "[::1]" }).problems, ["host"]);
  assert.deepEqual(hostView("https://[::1]:8443/", { serverHost: "[::1]" }).problems, []);
});

test("the server's host is compared as a string, with no second parse", () => {
  assert.deepEqual(hostView("https://evil.example/", { serverHost: "EVIL.example" }).problems, ["host"]);
  assert.deepEqual(hostView("https://evil.example/", { serverHost: "evil.example." }).problems, ["host"]);
  assert.deepEqual(hostView("https://evil.example/", {}).problems, ["host"], "no host from the server");
  assert.deepEqual(hostView("https://Hooks.EXAMPLE.com:8443/x", { serverHost: "hooks.example.com" }).problems, [], "upper case as written is the same host");
  assert.equal(hostView("https://Hooks.EXAMPLE.com:8443/x", { serverHost: "hooks.example.com" }).port, "8443");
});

test("the host as written in the address", () => {
  assert.equal(writtenHost("https://Good.Example@Evil.Example:8443/a?b#c"), "evil.example");
  assert.equal(writtenHost("https://[::1]:8443/"), "[::1]");
  assert.equal(writtenHost("https://16843009/"), "16843009");
  assert.equal(writtenHost("https:\\\\evil.example/"), null);
  assert.equal(writtenHost("javascript:alert(1)"), null);
});

test("HTML, a long query and a javascript: look in the path leave the host alone", () => {
  const v = hostView(`https://evil.example/<img src=x onerror=alert(1)>/javascript:alert(1)?q=${"a".repeat(500)}`, { serverHost: "evil.example" });
  assert.deepEqual(v.problems, []);
  assert.equal(v.host, "evil.example");
});

test("an address that is not https with a host cannot be approved", () => {
  for (const u of ["javascript:alert(1)", "javascript://evil.example/%0aalert(1)", "data:text/html,hi", "not a url", "", "https://", "ftp://evil.example/"]) {
    assert.ok(hostView(u, { serverHost: "evil.example" }).problems.length > 0, u);
  }
  assert.deepEqual(hostView("http://evil.example/", { serverHost: "evil.example" }).problems, ["scheme"]);
  assert.deepEqual(hostView("http://evil.example/", { serverHost: "evil.example", allowHttp: true }).problems, []);
  assert.ok(hostView("https://evil‮.example/", { serverHost: "evil‮.example" }).problems.length > 0, "a direction-changing character in the host");
});

test("a request is the same only when everything shown and approved is the same", () => {
  assert.ok(sameRequest(item(), item()));
  assert.ok(sameRequest(item(), item({ expires_at: "2026-11-18T11:00:00Z" })), "the time it runs out is not what is approved");
  for (const [k, v] of [["url", "https://hooks.example.com/routine/abd?key=k1"], ["host", "other.example"], ["name", "roster.changed"], ["urgent_only", true], ["id", "01933b6e-0000-7000-8000-000000000002"]]) {
    assert.ok(!sameRequest(item(), item({ [k]: v })), k);
  }
  assert.ok(!sameRequest(item(), item({ member: { id: item().member.id, name: "other" } })), "member name");
  assert.ok(!sameRequest(item(), item({ room: { id: "01933b6e-0000-7000-8000-0000000000cc", name: "acme" } })), "room id");
  assert.ok(!sameRequest(item(), null) && !sameRequest(null, item()));
  assert.deepEqual(REQUEST_FIELDS, ["id", "url", "host", "name", "urgent_only", "member.id", "member.name", "room.id", "room.name"]);
});

test("a request checked against itself", () => {
  assert.deepEqual(requestProblems(item(), item().id), []);
  assert.deepEqual(requestProblems(item(), "01933b6e-0000-7000-8000-000000000009"), ["id"]);
  assert.deepEqual(requestProblems(item({ name: "roster.changed" }), item().id), ["name"], "a person approves message.received only");
  assert.deepEqual(requestProblems(item({ member: { id: "x", name: "planner" } }), item().id), ["member"]);
  assert.deepEqual(requestProblems(item({ room: null }), item().id), ["room"]);
  assert.deepEqual(requestProblems(item({ url: "https://good.example@evil.example/", host: "good.example" }), item().id), ["host"]);
  assert.deepEqual(requestProblems(item({ url: "https://xn--pypal-4ve.com/x", host: "xn--pypal-4ve.com" }), item().id), ["encoded"]);
  assert.deepEqual(requestProblems(item({ url: "javascript:alert(1)" }), item().id), ["url"]);
  assert.deepEqual(requestProblems(null, item().id), ["request"]);
});

test("our sentences: the reviewed words, one place each, plain", () => {
  const ev = EVENTS["message.received"];
  assert.equal(ev.heading("planner"), "planner asks bot-link to call an address when a message waits for it.");
  assert.equal(ev.sent("planner"), "bot-link will call this address each time a message waits for planner. It sends which room and which chat, who wrote, whether the message was to this chat alone or to the room, whether it needs an answer, and how many wait, with their ids and the time. It never sends the message text.");
  assert.deepEqual(Object.keys(EVENTS), ["message.received"]);
  assert.equal(WARNING, "bot-link could not check that this address is yours. Approve only if you made this address yourself, for example the trigger of a routine in your chat app.");
  assert.equal(COMPARE, "The host alone doesn't show it is yours. Compare the whole address with the one your app shows for your routine.");
  assert.equal(lasts("planner"), "It stays for as long as planner keeps renewing it, until you stop it here.");
  assert.equal(approvedText("planner"), "Approved. bot-link calls this address when a message waits for planner. If one waits now, it has just called it.");
  assert.equal(stopBody("planner"), "bot-link stops calling this address. planner will not be woken through it any more. planner can ask you again.");
  assert.match(ENCODED, /encoded name/);
  assert.match(ENCODED, /not shown on purpose/);
  assert.equal(CHANGED, "This request changed after you opened it. Nothing was approved.");
  assert.equal(BLOCKED, "bot-link may not call this address (it does not point to a public https address). Nothing was approved.");
  assert.equal(UNREACHABLE, "bot-link could not reach this address, so nothing was approved.");
  assert.equal(HC_FAILED, "The passkey step did not count, so nothing was approved.");
  assert.equal(tooMany("planner"), "planner already has six addresses. Stop one first.");
  const texts = [WARNING, COMPARE, ENCODED, lasts("x"), CHANGED, BLOCKED, UNREACHABLE, HC_FAILED, approvedText("x"), stopBody("x"), tooMany("x"), ev.heading("x"), ev.sent("x")];
  for (const s of texts) {
    assert.doesNotMatch(s, /[—–]/, `a dash in ${s}`);
    assert.doesNotMatch(s, /\b(receipts?|seen|answered|webhooks?|delivered|delivery|leases?|envelopes?|epochs?|chatgpt|every time|guarantee)\b/i, s);
  }
});
