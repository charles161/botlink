// An event address a person approves (docs/protocol/event-url-approval.md §5): `botlink events subscribe --url …
// --ask-person`, what `events list` and `events unsubscribe` say about requests, the plain refusals, and the outgoing
// check that keeps the approve link out of room messages. The server's answers are faked in fake-events.ts exactly as
// server/internal/agentapi/eventurl.go and events.go give them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as cmd from "../src/events-cmd.js";
import * as ev from "../src/events.js";
import { approveUrlLinkIn, draftLinkIn } from "../src/outscan.js";
import { selfCmd } from "../src/version.js";
import { FakeServer } from "./fake-server.js";
import { APP_ORIGIN } from "./fake-events.js";
import { assertCopy, assertIsolated, newHome, on, startFake } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const REPO = join(import.meta.dirname, "..", "..");
let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

let n = 0;
const S = () => `66666666-aaaa-4bbb-8ccc-${String(++n).padStart(12, "0")}`;
const roomName = (p: string) => `${p}${++n}${Math.floor(Math.random() * 1e4)}`;
const B = () => selfCmd();
const UNTIL = "\\d\\d:\\d\\d UTC on \\d{1,2} [A-Z][a-z]{2}";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function joined(name: string, h: string, person = "Adam") {
  const adam = await f.account(person);
  const room = await f.room(adam, roomName("ev"));
  return on(h, async () => {
    const s = S();
    const r = await core.joinCreate({ invite: `http://localhost:8811/i/${f.invite(room, adam)}`, name, job: "helps", app: "claude-code", turn: "on_turn", session: s, cwd: h, folder: "~", machine: "m" });
    f.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 3000, app: "claude-code", session: s, cwd: h });
    assert.equal(w.status, "approved", w.text);
    return { m: (w as any).member as st.MemberRec, s, adam, room };
  });
}

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof core.UserError, String((e as Error)?.stack || e));
    return (e as Error).message;
  }
  assert.fail("it was not refused");
}

async function cli(argv: string[]): Promise<{ code: number; text: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((res) => {
    const ch = spawn(process.execPath, [CLI, ...argv], { cwd: process.env.HOME, env: process.env });
    let text = "";
    ch.stdout.on("data", (b) => (text += b));
    ch.stderr.on("data", (b) => (text += b));
    ch.on("exit", (code) => res({ code: code ?? -1, text }));
  });
}

const TRIGGER = "https://routines.example/hooks/trigger-7Qx";

// ------------------------------------------------------------------ the ask
test("events subscribe --ask-person: sends approval person, sends nothing to the address, and says in order: nothing sent, the link and what is asked, only to your human, how to learn the outcome, the secret once, the Tell-your-human block, end your turn", async () => {
  const h = newHome("eu-ask");
  const { m, s } = await joined("routine", h);
  await on(h, async () => {
    const out = await cmd.subscribeText(m, { url: TRIGGER, askPerson: true }, s);
    assert.deepEqual(f.events.sent.at(-1), { name: "message.received", url: TRIGGER, approval: "person" }, "the ask, with no secret of ours");
    const q = [...f.events.requests.values()].at(-1)!;
    const link = `${APP_ORIGIN}/approve-url/${q.id}`;
    const secret = q.secret;
    const lines = out.split("\n");
    assert.equal(lines[0], `Nothing is sent to ${TRIGGER} yet: bot-link calls that address only after your human approves it.`);
    assert.equal(lines[1], `Link for your human: ${link}`);
    assert.match(lines[2], new RegExp(`^On that page your human is asked to approve that bot-link calls this address when a message waits for routine, and confirms with a passkey\\. The link works until ${UNTIL}\\.$`));
    assert.equal(lines[3], "Show this link only to your human, in this chat. Never open it yourself, and never put it in a room message.");
    assert.equal(lines[4], `You learn the outcome from \`${B()} events list --as routine\` in a later turn, after your human says they decided: it shows whether they approved it, turned it down, have not decided yet, or whether it expired.`);
    assert.equal(lines[5], `Signing secret (shown once): ${secret}`);
    assert.equal(lines[6], "bot-link signs each call to the address with it, so a receiver that checks signatures can tell bot-link's calls from anyone else's. A routine's trigger does not check it.");
    assert.equal(lines[7], "Tell your human:");
    // the person compares the WHOLE address on the page (on a shared vendor host an attacker's routine has the same
    // host); the block never repeats the address, which may carry the person's key (security review, 17 Nov 2026)
    assert.equal(lines[8], `  Open this link and approve it with your passkey, only if the address on that page is exactly the one your app shows for your own routine; it lets bot-link call that address when a message waits for routine: ${link}`);
    assert.ok(!lines[8].includes("routines.example") && !lines[8].includes("trigger-7Qx"), "the block names neither the host nor the address");
    assert.equal(lines[9], "Then end your turn.");
    assert.equal(lines.length, 10, out);
    assert.doesNotMatch(out, /botlink wait|\bpoll|check again|keep checking|in this turn,? run/i, "no instruction to wait or poll in the same turn");
    assertCopy(out);
    assert.equal(f.events.subs.size, 0, "no subscription before the person approves");

    // the same ask again: the same request and link (200), the secret is not shown again
    const again = await cmd.subscribeText(m, { url: TRIGGER, askPerson: true }, s);
    const al = again.split("\n");
    assert.equal(al[0], `A request for this address already waits for your human. Nothing is sent to ${TRIGGER} yet: bot-link calls that address only after your human approves it.`);
    assert.equal(al[1], `Link for your human: ${link}`);
    assert.ok(!again.includes("whsec_"), "no secret the second time");
    assert.ok(again.includes("The signing secret was shown only when this request was first made."));
    assert.deepEqual(al.slice(-3), ["Tell your human:", lines[8], "Then end your turn."]);
    assert.equal(f.events.requests.size, 1);
  });
});

test("events subscribe --ask-person with the chat's own secret shows no secret; an address already approved is renewed without a new request", async () => {
  const h = newHome("eu-own");
  const { m, s } = await joined("routine", h);
  await on(h, async () => {
    const mine = "whsec_" + Buffer.alloc(32, 7).toString("base64");
    const out = await cmd.subscribeText(m, { url: TRIGGER, askPerson: true, secret: mine }, s);
    assert.ok(!out.includes("whsec_") && !out.includes("Signing secret"), out);
    const q = [...f.events.requests.values()].find((x) => x.member === m.id)!;
    f.events.approve(q.id);
    const renewed = await cmd.subscribeText(m, { url: TRIGGER, askPerson: true, secret: mine }, s);
    assert.match(renewed, /^Renewed: sub_[0-9a-f]{24} /);
    assert.ok(renewed.includes("No new approval was needed: Adam approved this address on the dashboard earlier; bot-link never checked it."), renewed);
    assert.equal([...f.events.requests.values()].filter((x) => x.member === m.id && x.status === "waiting").length, 0);
  });
});

// ------------------------------------------------------------------ the plain subscribe that fails the check
test("events subscribe: an address that did not answer the check is told about --ask-person; a blocked address is not, and nothing is tried again", async () => {
  const h = newHome("eu-check");
  const { m, s } = await joined("routine", h);
  await on(h, async () => {
    let before = f.events.sent.length;
    const t = await refused(cmd.subscribeText(m, { url: TRIGGER }, s));
    assert.equal(t, `That URL didn't pass bot-link's check: it replied, but didn't send the check value back. Nothing was subscribed. The check called that address once. An address that can only answer yes, such as a routine's trigger in a chat app, can't pass this check. If your human set up this address and asked for it, ask them to approve it instead: \`${B()} events subscribe --url ${TRIGGER} --ask-person\`.`);
    assert.equal(f.events.sent.length, before + 1, "asked once, not again by itself");
    assert.equal(f.events.requests.size === 0 || ![...f.events.requests.values()].some((x) => x.member === m.id), true, "no request made by itself");
    assertCopy(t);
    for (const url of ["http://10.0.0.5/hook", "https://127.0.0.1/x"]) {
      before = f.events.sent.length;
      const b = await refused(cmd.subscribeText(m, { url }, s));
      assert.equal(b, "bot-link can't send events to that URL: it must be https and a public address (not this computer or a private network).");
      assert.ok(!b.includes("--ask-person"));
      assert.equal(f.events.sent.length, before + 1);
    }
    // a name that does not resolve: unreachable, and no --ask-person either (the person can't approve that)
    const c = await refused(cmd.subscribeText(m, { url: "https://nowhere.invalid/h" }, s));
    assert.equal(c, "That URL didn't pass bot-link's check: bot-link's server couldn't reach it. Nothing was subscribed.");
    // blocked at the ask: the same words, plus nothing was asked
    const ab = await refused(cmd.subscribeText(m, { url: "http://10.0.0.5/hook", askPerson: true }, s));
    assert.equal(ab, "bot-link can't send events to that URL: it must be https and a public address (not this computer or a private network). Nothing was asked.");
    const ac = await refused(cmd.subscribeText(m, { url: "https://nowhere.invalid/h", askPerson: true }, s));
    assert.equal(ac, "bot-link's server couldn't find that address: its name does not resolve. Nothing was asked.");
  });
});

// ------------------------------------------------------------------ list
test("events list: waiting requests with their link and expiry, approved / turned down / expired in plain words, an approved subscription marked, and the honest line about waking", async () => {
  const h = newHome("eu-list");
  const { m, s } = await joined("routine", h);
  await on(h, async () => {
    const ask = async (url: string) => {
      await cmd.subscribeText(m, { url, askPerson: true }, s);
      return [...f.events.requests.values()].find((x) => x.member === m.id && x.url === url)!;
    };
    const a = await ask(TRIGGER);
    f.events.approve(a.id);
    const r = await ask("https://routines.example/no");
    f.events.reject(r.id);
    const x = await ask("https://routines.example/late");
    const w = await ask("https://routines.example/wait");
    f.events.expire(x.id); // (after the last ask: a new ask deletes this chat's requests that ran out, as the server does)
    const out = await cmd.listText(m, s);
    assertCopy(out);
    const sub = [...f.events.subs.values()].find((y) => y.member === m.id)!;
    const lines = out.split("\n");
    assert.equal(lines[0], `Event subscriptions of routine in #${m.room.name}:`);
    assert.match(lines[1], new RegExp(`^  ${sub.id} · message\\.received → ${esc(TRIGGER)} · on · nothing accepted yet · renew before \\S+ · approved by Adam on the dashboard; bot-link never checked this address$`));
    assert.equal(lines[2], "Addresses this chat asked Adam to approve:");
    const line = (id: string) => lines.find((l) => l.startsWith(`  ${id} · `)) || "";
    assert.match(line(a.id), new RegExp(`^  ${a.id} · ${esc(TRIGGER)} · approved by Adam at ${UNTIL}: bot-link calls it when a message waits for routine \\(subscription ${sub.id}\\)$`));
    assert.match(line(r.id), new RegExp(`^  ${r.id} · https://routines\\.example/no · turned down by Adam at ${UNTIL}: nothing is sent to it\\. Ask again only if your human asks you to\\.$`));
    assert.equal(line(x.id), `  ${x.id} · https://routines.example/late · expired: nobody approved it within 24 hours, so nothing is sent to it. Ask again only if your human still wants it.`);
    assert.match(line(w.id), new RegExp(`^  ${w.id} · https://routines\\.example/wait · waiting for Adam, nothing is sent to it yet · link for your human: ${esc(APP_ORIGIN)}/approve-url/${w.id} · works until ${UNTIL}$`));
    assert.equal(lines.at(-1), `Adam approved an address for routine: bot-link calls it when a message waits. Whether that gives this chat a turn depends on what the address starts; only a wake test that arrived through it shows that (\`${B()} selftest --as routine\`, then end your turn). Until one did, don't tell your human or the room that this chat wakes by itself: new messages show up on its next turn.`);
    assert.doesNotMatch(out, /wakes on its own|woken by itself/);
  });
});

test("events list: an approved subscription that failures turned off says only a new approval turns it on; nothing at all keeps the old text", async () => {
  const h = newHome("eu-off");
  const { m, s } = await joined("routine", h);
  await on(h, async () => {
    const empty = await cmd.listText(m, s);
    assert.equal(empty, `routine in #${m.room.name} has no event subscriptions. Events: message.received, roster.changed. Start one: ${B()} events subscribe --url <https URL>, or run a receiver here: ${B()} events serve --url <the URL that reaches this computer>.`);
    await cmd.subscribeText(m, { url: TRIGGER, askPerson: true }, s);
    const q = [...f.events.requests.values()].find((x) => x.member === m.id)!;
    const sub = f.events.approve(q.id);
    f.events.fail(sub.id);
    const out = await cmd.listText(m, s);
    assert.match(out, new RegExp(`${sub.id} · message\\.received → ${esc(TRIGGER)} · OFF \\(events kept failing: http_5xx; only a new approval turns it on: ${esc(B())} events subscribe --url ${esc(TRIGGER)} --ask-person\\) · renew before \\S+ · approved by Adam on the dashboard; bot-link never checked this address`));
  });
});

// ------------------------------------------------------------------ withdraw
test("events unsubscribe <request id> withdraws a waiting request and says so; a subscription id still removes the subscription", async () => {
  const h = newHome("eu-withdraw");
  const { m, s } = await joined("routine", h);
  await on(h, async () => {
    await cmd.subscribeText(m, { url: TRIGGER, askPerson: true }, s);
    const q = [...f.events.requests.values()].find((x) => x.member === m.id)!;
    assert.equal(await cmd.unsubscribeText(m, { id: q.id }, s), `Withdrew the request ${q.id}: it no longer waits for Adam, and nothing is sent to ${TRIGGER}.`);
    assert.ok(!f.events.requests.has(q.id));
    assert.equal(await cmd.unsubscribeText(m, { id: q.id }, s), `No waiting request ${q.id} (already approved, turned down, expired or withdrawn). An approved address is a subscription: \`${B()} events list\` shows its sub_ id.`);
    // by URL: the waiting request on it
    await cmd.subscribeText(m, { url: TRIGGER, askPerson: true }, s);
    const q2 = [...f.events.requests.values()].find((x) => x.member === m.id && x.status === "waiting")!;
    assert.equal(await cmd.unsubscribeText(m, { url: TRIGGER }, s), `Withdrew the request ${q2.id}: it no longer waits for Adam, and nothing is sent to ${TRIGGER}.`);
    // a subscription
    await cmd.subscribeText(m, { url: TRIGGER, askPerson: true }, s);
    const q3 = [...f.events.requests.values()].find((x) => x.member === m.id && x.status === "waiting")!;
    const sub = f.events.approve(q3.id);
    assert.equal(await cmd.unsubscribeText(m, { id: sub.id }, s), `Removed ${sub.id}: bot-link no longer calls that URL for routine.`);
  });
});

// ------------------------------------------------------------------ refusals
test("refusals in plain words: two waiting per chat, ten per person, six asks an hour, the approval ended, a non-ASCII host, not message.received", async () => {
  const h = newHome("eu-refuse");
  const { m, s } = await joined("routine", h);
  await on(h, async () => {
    await cmd.subscribeText(m, { url: "https://routines.example/1", askPerson: true }, s);
    await cmd.subscribeText(m, { url: "https://routines.example/2", askPerson: true }, s);
    const third = await refused(cmd.subscribeText(m, { url: "https://routines.example/3", askPerson: true }, s));
    assert.equal(third, `bot-link did not ask: routine already has 2 addresses waiting for Adam, the most at a time. Adam approves or turns one down on the dashboard first, or withdraw one of them: \`${B()} events unsubscribe <request id>\` (\`${B()} events list\` shows them).`);
    // ask 4..6 (the same address: the same request), ask 7 is over the hour's limit
    for (let i = 0; i < 3; i++) await cmd.subscribeText(m, { url: "https://routines.example/1", askPerson: true }, s);
    const before = f.events.sent.length;
    const seventh = await refused(cmd.subscribeText(m, { url: "https://routines.example/1", askPerson: true }, s));
    assert.match(seventh, new RegExp(`^bot-link did not ask: routine asked for an address Adam approves 6 times in the last hour, the most allowed \\(an ask that was refused counts too\\)\\. Try again after \\d\\d:\\d\\d UTC, and only if your human still wants it\\.$`));
    assert.equal(f.events.sent.length, before + 1, "a 429 is not tried again (a refused ask counts too)");
  });
  const h2 = newHome("eu-refuse2");
  const j2 = await joined("other", h2);
  await on(h2, async () => {
    f.failNext = { path: /\/api\/v1\/me\/events\/subscriptions$/, status: 409, code: "too_many_requests_waiting", message: "This person already has 10 addresses waiting from their chats. Wait until the person decides.", times: 1 };
    const all = await refused(cmd.subscribeText(j2.m, { url: TRIGGER, askPerson: true }, j2.s));
    assert.equal(all, "bot-link did not ask: Adam already has 10 addresses waiting from their chats, the most at a time. Adam approves or turns one down on the dashboard first.");
    f.failNext = { path: /\/api\/v1\/me\/events\/subscriptions$/, status: 409, code: "approval_ended", message: "The person's approval of this address ended meanwhile. Ask again.", times: 1 };
    const ended = await refused(cmd.subscribeText(j2.m, { url: TRIGGER }, j2.s));
    assert.equal(ended, `bot-link did not renew it: Adam's approval of this address ended just now (Adam stopped it, or it ran out or kept failing). To use it again, ask again: \`${B()} events subscribe --url ${TRIGGER} --ask-person\`, and your human approves it on the dashboard.`);
    const before = f.events.sent.length;
    const idn = await refused(cmd.subscribeText(j2.m, { url: "https://bücher.example/hook", askPerson: true }, j2.s));
    assert.equal(idn, "bot-link did not ask: for an address your human approves, the host must be a plain name or a plain IP address, and this one has characters outside plain ASCII. Nothing was asked.");
    const roster = await refused(cmd.subscribeText(j2.m, { url: TRIGGER, askPerson: true, name: "roster.changed" }, j2.s));
    assert.equal(roster, "--ask-person is only for message.received: your human approves an address that is called when a message waits, nothing else. Nothing was asked.");
    assert.equal(f.events.sent.length, before, "neither left this computer");
    for (const t of [all, ended, idn, roster]) assertCopy(t);
  });
});

// server/internal/events/subs_test.go TestPlainHostForAnAddressAPersonApproves, copied: the client refuses locally
// exactly what events.PlainHost refuses, and nothing it accepts
const PLAIN_OK = [
  "https://hooks.example.com/t?key=abc",
  "https://api.vendor-1.io:8443/x",
  "https://1.1.1.1/x",
  "https://[2606:4700::1111]/x",
  "http://127.0.0.1:9/hook",
  "https://HOOKS.Example.com/x",
  "https://a1.b2.example/x",
];
const PLAIN_REFUSED: [string, string][] = [
  ["https://xn--80ak6aa92e.com/x", "this one has an xn-- part (an international name)"],
  ["https://XN--80AK6AA92E.com/x", "this one has an xn-- part (an international name)"],
  ["https://login.xn--pple-43d.com/x", "this one has an xn-- part (an international name)"],
  ["https://xn--exmple-cua.com/x", "this one has an xn-- part (an international name)"],
  ["https://paypal.xn--com-9o0a.net/x", "this one has an xn-- part (an international name)"],
  ["https://exämple.com/x", "this one has characters outside plain ASCII"],
  ["https://раураl.com/x", "this one has characters outside plain ASCII"],
  ["https://16843009/x", "this one ends in a number a browser reads as an address (write an IP address in full, like 1.2.3.4)"],
  ["https://0x01010101/x", "this one ends in a number a browser reads as an address (write an IP address in full, like 1.2.3.4)"],
  ["https://1.1.257/x", "this one ends in a number a browser reads as an address (write an IP address in full, like 1.2.3.4)"],
  ["https://001.001.001.001/x", "this one ends in a number a browser reads as an address (write an IP address in full, like 1.2.3.4)"],
  ["https://0x7f.1/x", "this one ends in a number a browser reads as an address (write an IP address in full, like 1.2.3.4)"],
  ["https://1.0x1/x", "this one ends in a number a browser reads as an address (write an IP address in full, like 1.2.3.4)"],
  ["https://hooks.example.123/x", "this one ends in a number a browser reads as an address (write an IP address in full, like 1.2.3.4)"],
  ["https://0X1.example.0x1F/x", "this one ends in a number a browser reads as an address (write an IP address in full, like 1.2.3.4)"],
  ["https://1.1.1.1./x", "this one ends with a dot"],
  ["https://hooks.example.com./x", "this one ends with a dot"],
  ["https://hooks..example.com/x", "this one has an empty part (two dots in a row)"],
  ["https://hooks_example.com/x", "this one has characters other than letters, digits, dots and dashes"],
  ["http://[fe80::1%25eth0]/x", "this one is not an IP address written out in full"],
  ["https://user@hooks.example.com/x", "this one has a name and an @ before the host"],
];

test("hosts: the client refuses locally exactly what the server's PlainHost refuses (its own table), in plain words, and nothing it accepts; the server's own refusal reads the same way", async () => {
  for (const ok of PLAIN_OK) assert.equal(cmd.hostFormRefusal(ok), null, ok);
  for (const [url, why] of PLAIN_REFUSED) assert.equal(cmd.hostFormRefusal(url), `bot-link did not ask: for an address your human approves, the host must be a plain name or a plain IP address, and ${why}. Nothing was asked.`, url);
  const h = newHome("eu-host");
  const { m, s } = await joined("routine", h);
  await on(h, async () => {
    const before = f.events.sent.length;
    for (const [url] of PLAIN_REFUSED) assertCopy(await refused(cmd.subscribeText(m, { url, askPerson: true }, s)));
    assert.equal(f.events.sent.length, before, "none of them left this computer");
    // the fake server refuses the same table, with the server's words (so a host the client let through is caught there)
    for (const [url] of PLAIN_REFUSED) assert.equal(f.events.plainHost(url), false, url);
    for (const url of PLAIN_OK) assert.equal(f.events.plainHost(url), true, url);
    f.failNext = { path: /\/api\/v1\/me\/events\/subscriptions$/, status: 422, code: "event_url_blocked", message: "An address your person approves must have a plain host: letters, digits, dots and dashes (no xn-- part, no number a browser reads as an address, no dot at the end), or an IP address written out in full.", times: 1 };
    const srv = await refused(cmd.subscribeText(m, { url: "https://routines.example/hook", askPerson: true }, s));
    assert.equal(srv, "bot-link can't send events to that URL: it must be https and a public address (not this computer or a private network), and for an address your human approves the host must be a plain name or a plain IP address. Nothing was asked.");
  });
});

test("a plain subscribe to an address the person stopped or turned down (409 stopped_by_person): who, which, until when, nothing checked or called, ask with --ask-person; another query or event on it is refused too", async () => {
  const h = newHome("eu-saidno");
  const { m, s } = await joined("routine", h);
  await on(h, async () => {
    assert.equal(ev.PERSON_SAID_NO_CODE, "stopped_by_person");
    const echo = "https://echo.routines.example/hook?key=abc";
    await cmd.subscribeText(m, { url: echo, askPerson: true }, s);
    const q = [...f.events.requests.values()].find((x) => x.member === m.id && x.url === echo)!;
    f.events.stop(f.events.approve(q.id).id);
    const t = await refused(cmd.subscribeText(m, { url: echo }, s));
    assert.match(t, new RegExp(`^Adam stopped this address in the last 24 hours, so bot-link did not check or call it \\(it sends it nothing until ${UNTIL}\\)\\. If your human wants it again, ask with \`${esc(B())} events subscribe --url ${esc(echo)} --ask-person\`; Adam approves it on the dashboard\\.$`));
    assert.doesNotMatch(t, /query|another key|change|without/i, "nothing suggests another query gets past it (the command repeats the address as the chat gave it)");
    // the address without its query: another key, another event, FYIs off, all refused; nothing was checked
    for (const o of [{ url: "https://echo.routines.example/hook?key=other" }, { url: echo, name: "roster.changed" }, { url: echo, urgentOnly: true }]) {
      assert.match(await refused(cmd.subscribeText(m, o, s)), /^Adam stopped this address in the last 24 hours/);
    }
    assert.equal(f.events.challenged.filter((u) => u.startsWith("https://echo.routines.example/hook")).length, 0, "the check never ran on it");
    // asking the person again still works
    assert.match(await cmd.subscribeText(m, { url: echo, askPerson: true }, s), /^Nothing is sent to /);
    // turned down
    const no = "https://echo.routines.example/other";
    await cmd.subscribeText(m, { url: no, askPerson: true }, s);
    f.events.reject([...f.events.requests.values()].find((x) => x.member === m.id && x.url === no && x.status === "waiting")!.id);
    const t2 = await refused(cmd.subscribeText(m, { url: no }, s));
    assert.match(t2, new RegExp(`^Adam turned this address down in the last 24 hours, so bot-link did not check or call it \\(it sends it nothing until ${UNTIL}\\)\\.`));
    // a server answer without until (or a reason the client does not know) still reads plainly
    f.failNext = { path: /\/api\/v1\/me\/events\/subscriptions$/, status: 409, code: "stopped_by_person", message: "x", times: 1 };
    assert.equal(await refused(cmd.subscribeText(m, { url: "https://echo.routines.example/third" }, s)), `Adam stopped (or turned down) this address in the last 24 hours, so bot-link did not check or call it. If your human wants it again, ask with \`${B()} events subscribe --url https://echo.routines.example/third --ask-person\`; Adam approves it on the dashboard.`);
    assertCopy(t);
    assertCopy(t2);
  });
});

// ------------------------------------------------------------------ the outgoing check
test("outgoing check: a room message that carries an approve-url link is stopped with a plain reason; nothing leaves", async () => {
  const id = "0193b2c4-1111-7222-8333-444455556666";
  assert.equal(approveUrlLinkIn(`please approve https://app.botlink.dev/approve-url/${id} thanks`), `https://app.botlink.dev/approve-url/${id}`);
  assert.equal(approveUrlLinkIn(`app.botlink.dev/approve-url/${id.toUpperCase()}`), `app.botlink.dev/approve-url/${id.toUpperCase()}`);
  assert.equal(approveUrlLinkIn(`the approve-url/ page and https://app.botlink.dev/approve/${id}`), null);
  assert.equal(draftLinkIn(`https://app.botlink.dev/approve-url/${id}`), null);
  assert.equal(approveUrlLinkIn(`https://app.botlink.dev/create/${id}`), null);
  const h = newHome("eu-leak");
  const { m, s, adam, room } = await joined("routine", h);
  const h2 = newHome("eu-leak-o");
  await on(h2, async () => {
    const r = await core.joinCreate({ invite: `http://localhost:8811/i/${f.invite(room, adam)}`, name: "other", job: "helps", app: "claude-code", turn: "on_turn", session: S(), cwd: h2, folder: "~", machine: "m" });
    f.approve(r.req.id);
  });
  await on(h, async () => {
    const sent = f.messages.size;
    for (const text of [`Approve it here: http://localhost:8811/approve-url/${id}`, `link app.botlink.dev/approve-url/${id}`]) {
      await assert.rejects(core.send(m, { to: "room", text, intent: "fyi" }, s), (e: any) => {
        assert.equal(e.message, core.APPROVE_URL_STOPPED);
        return true;
      });
    }
    assert.equal(f.messages.size, sent, "nothing left this computer");
    assert.equal(core.APPROVE_URL_STOPPED, "bot-link did not send this: it carries the link for approving an event address. It is only for your human, in this chat; never put it in a room message. Nothing left this computer. Send it again without it.");
  });
});

// ------------------------------------------------------------------ the command line
test("botlink events subscribe --ask-person, list and unsubscribe from the command line; the usage names --ask-person", async () => {
  const h = newHome("eu-cli");
  const { m, s } = await joined("routine", h);
  await on(h, async () => {
    const r = await cli(["events", "subscribe", "--url", TRIGGER, "--ask-person", "--as", "routine", "--session", s]);
    assert.equal(r.code, 0, r.text);
    assert.ok(r.text.startsWith(`Nothing is sent to ${TRIGGER} yet`), r.text);
    assert.match(r.text, /\nTell your human:\n  Open this link [^\n]*\/approve-url\/[0-9a-f-]{36}\nThen end your turn\.\n$/);
    const q = [...f.events.requests.values()].find((x) => x.member === m.id)!;
    const l = await cli(["events", "list", "--as", "routine", "--session", s]);
    assert.equal(l.code, 0, l.text);
    assert.ok(l.text.includes(`${q.id} · ${TRIGGER} · waiting for Adam`), l.text);
    const u = await cli(["events", "unsubscribe", q.id, "--as", "routine", "--session", s]);
    assert.equal(u.code, 0, u.text);
    assert.ok(u.text.startsWith(`Withdrew the request ${q.id}`), u.text);
    const bad = await cli(["events", "subscribe", "--url", TRIGGER, "--as", "routine", "--session", s]);
    assert.equal(bad.code, 1);
    assert.ok(bad.text.includes("--ask-person"), bad.text);
    const help = await cli(["events", "--help"]);
    assert.ok(help.text.includes("--ask-person"), help.text);
  }, { BOTLINK_APP: "claude-code" });
});

test("docs: agents.md shows --ask-person in the events part and in the Grok Bot paragraph, without claiming a real Grok Bot run of it", () => {
  const agents = readFileSync(join(REPO, "docs", "agents.md"), "utf-8");
  const events = agents.slice(agents.indexOf("### Events: be woken with nothing running here"));
  assert.match(events.split("\n## ")[0], /events subscribe --url <[^>]+> --ask-person/);
  const grok = agents.split("\n").find((l) => l.startsWith("**In Grok Bot**"))!;
  assert.match(grok, /--ask-person/);
  assert.match(grok, /not been run end to end with a real Grok Bot|has not been run with a real Grok Bot/);
  // a routine's trigger is asked for with --ask-person from the start: a plain subscribe calls it once to check it,
  // and the trigger starts the routine on any call (security review, 17 Nov 2026)
  const FROM_START = /--ask-person` from the start, never with a plain `(botlink )?events subscribe`: a plain subscribe calls the address once to check it/;
  assert.match(events.split("\n## ")[0], FROM_START);
  assert.match(grok, FROM_START);
  const llms = readFileSync(join(REPO, "docs", "llms.txt"), "utf-8");
  assert.match(llms, /--ask-person/);
  assert.match(llms, FROM_START);
});
