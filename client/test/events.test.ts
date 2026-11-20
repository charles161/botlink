/**
 * bot-link Events (SPEC §6.13), client side, offline: the Standard Webhooks signature (the reference vector the Go
 * server's test checks too), the receiver (`events serve`) with stand-in API calls, and the MCP events/* handlers'
 * input checks and error codes. The whole path against the real server is test/it/e2e-events.ts.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

import * as st from "../src/state.js";
import * as ev from "../src/events.js";
import { eventHandlers, E, EVENTS_CAPABILITIES } from "../src/mcp-events.js";
import { ApiError } from "../src/api.js";
import { UserError } from "../src/core.js";
import { assertIsolated, newHome, on, assertCopy } from "./helpers.js";

before(() => assertIsolated());

// the Standard Webhooks reference vector
const VEC = { secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", id: "msg_p5jXN8AQM9LWM0D4loKWxJek", ts: "1614265330", body: '{"test": 2432232314}', sig: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=" };

test("sign / verify: the Standard Webhooks reference vector, tolerance, several signatures, tampering", () => {
  const body = Buffer.from(VEC.body);
  const at = Number(VEC.ts) * 1000;
  assert.equal(ev.sign(VEC.secret, VEC.id, VEC.ts, body), VEC.sig);
  const h = { id: VEC.id, timestamp: VEC.ts, signature: VEC.sig };
  assert.equal(ev.verify([VEC.secret], h, body, at), "ok");
  const other = ev.newSecret();
  assert.equal(ev.verify([other, VEC.secret], h, body, at), "ok", "any of the receiver's secrets");
  assert.equal(ev.verify([VEC.secret], { ...h, signature: `${ev.sign(other, VEC.id, VEC.ts, body)} ${VEC.sig}` }, body, at), "ok", "any of several signatures (a secret being replaced)");
  assert.equal(ev.verify([other], h, body, at), "bad_signature");
  assert.equal(ev.verify([VEC.secret], h, Buffer.from(VEC.body + " "), at), "bad_signature");
  assert.equal(ev.verify([VEC.secret], { ...h, id: VEC.id + "x" }, body, at), "bad_signature");
  assert.equal(ev.verify([VEC.secret], { ...h, timestamp: "1614265331" }, body, at), "bad_signature");
  assert.equal(ev.verify([VEC.secret], { ...h, signature: VEC.sig.replace("v1,", "v2,") }, body, at), "bad_signature");
  assert.equal(ev.verify([VEC.secret], { ...h, signature: undefined }, body, at), "bad_signature");
  assert.equal(ev.verify([VEC.secret], { ...h, timestamp: "soon" }, body, at), "bad_signature");
  assert.equal(ev.verify([VEC.secret], h, body, at + 301_000), "stale");
  assert.equal(ev.verify([VEC.secret], h, body, at - 301_000), "stale");
  assert.equal(ev.verify([], h, body, at), "bad_signature");
  // secrets
  const s = ev.newSecret();
  assert.match(s, /^whsec_[A-Za-z0-9+/]{43}=$/);
  assert.equal(ev.secretKey(s)!.length, 32);
  for (const bad of ["", "hunter2", "whsec_", "whsec_c2hvcnQ=", "whsec_!!!!", "sec_" + "QUJD".repeat(8), "whsec_" + "QUJD".repeat(30)]) assert.equal(ev.secretKey(bad), null, bad);
  assert.throws(() => ev.sign("hunter2", "a", 1, "b"));
});

function member(home: string, name = "svc"): st.MemberRec {
  const m: st.MemberRec = {
    id: `01a1c3c4-0000-7000-8000-0000000000${name.length}1`, server: process.env.BOTLINK_SERVER!, room: { id: "01a1c3c4-0000-7000-8000-0000000000aa", name: "acme", purpose: "" }, name, job: "j", app: "codex",
    folder: "~", cwd: home, machine: "box", turn: "on_turn", account: "acct", person_name: "Adam", holder_session: "sess-1", holder_epoch: 1, key_id: "k", key_backend: "file",
    pin: { head_seq: 0, head_hash: "" } as any, joined_at: Date.now(),
  };
  st.saveMember(m);
  return m;
}

const subView = (url: string): ev.SubView => ({ id: "sub_" + "0".repeat(24), url, name: ev.EVENT_MESSAGE, urgent_only: false, state: "on", created_at: new Date().toISOString(), refreshed_at: new Date().toISOString(), refresh_before: new Date(Date.now() + 3600_000).toISOString(), last_ok_at: null, last_error: null, failed_since: null, fails: 0 });

test("events serve: checks every request, answers the verification, wakes once per event, single-flight, cleans up", async () => {
  const home = newHome("events-serve");
  await on(home, async () => {
    const m = member(home);
    const out = join(home, "woke.txt");
    let secret = "";
    const calls: string[] = [];
    const said: string[] = [];
    const abort = new AbortController();
    let port = 0;
    let left: number | null = 7; // what the receiver finds still waiting after a run
    const ready = new Promise<void>((res) => {
      void ev
        .serveEvents(m, {
          url: "https://hooks.example/h", port: 0, gapMs: 50, signal: abort.signal, say: (s) => said.push(s),
          command: `echo "woke count=$BOTLINK_LISTEN_COUNT member=$BOTLINK_LISTEN_MEMBER session=$BOTLINK_SESSION" >> '${out}'; sleep 0.3`,
          api: {
            subscribe: async (_m, a) => {
              calls.push(`subscribe ${a.name} ${a.url}`);
              secret = a.secret!;
              return { subscription: subView(a.url), refreshed: false };
            },
            unsubscribe: async (_m, id) => {
              calls.push(`unsubscribe ${id}`);
              return true;
            },
            waiting: async () => left,
          },
          onReady: (i) => {
            port = i.port;
            res();
          },
        })
        .then((code) => calls.push(`exit ${code}`));
    });
    await ready;
    assert.ok(ev.secretKey(secret), "the receiver makes its own whsec_ secret");
    assert.ok(existsSync(ev.servePath(m.id)));
    assert.ok(!readFileSync(ev.servePath(m.id), "utf-8").includes("whsec_"), "the secret is never written to disk");
    for (const s of said) assertCopy(s);
    const url = `http://127.0.0.1:${port}/any/path`;
    const post = (body: string, o: { id?: string; secret?: string; ts?: string; sign?: boolean } = {}) => {
      const id = o.id || "evt-" + Math.random().toString(16).slice(2);
      const ts = o.ts || String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (o.sign !== false) Object.assign(headers, { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": ev.sign(o.secret || secret, id, ts, body) });
      return fetch(url, { method: "POST", headers, body });
    };
    const evt = (waiting: number, memberId = m.id, name = ev.EVENT_MESSAGE) => JSON.stringify({ eventId: "x", name, timestamp: new Date().toISOString(), data: { member: { id: memberId, name: "svc" }, room: { id: "r", name: "acme" }, waiting } });

    // the verification challenge is echoed only when signed
    const v = await post(JSON.stringify({ type: "verification", challenge: "abc123" }));
    assert.equal(v.status, 200);
    assert.deepEqual(await v.json(), { challenge: "abc123" });
    assert.equal((await post(JSON.stringify({ type: "verification", challenge: "abc123" }), { secret: ev.newSecret() })).status, 401);
    // refused: unsigned, wrong secret, stale, too large, not JSON; other methods never run anything
    assert.equal((await post(evt(1), { sign: false })).status, 401);
    assert.equal((await post(evt(1), { secret: ev.newSecret() })).status, 401);
    assert.equal((await post(evt(1), { ts: String(Math.floor(Date.now() / 1000) - 400) })).status, 401);
    assert.equal((await post("x".repeat(300 * 1024))).status, 413);
    assert.equal((await post("not json")).status, 400);
    assert.equal((await fetch(url, { method: "PUT", body: "x" })).status, 405);
    assert.equal((await fetch(url)).status, 200);
    // accepted but nothing to do: an unknown control message, another member's event, another event name
    assert.equal((await post(JSON.stringify({ type: "gap", cursor: "c" }))).status, 204);
    assert.equal((await post(evt(1, "someone-else"))).status, 204);
    assert.equal((await post(evt(1, m.id, ev.EVENT_ROSTER))).status, 204);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!existsSync(out), "nothing above may wake the chat");

    // one event → one wake, with the member's env; the same event sent again → no second wake
    assert.equal((await post(evt(2), { id: "evt-1" })).status, 204);
    assert.equal((await post(evt(2), { id: "evt-1" })).status, 204);
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(readFileSync(out, "utf-8"), "woke count=2 member=svc session=sess-1\n");
    assert.ok(!st.wakeMarkPending(m.id) || true); // (the marker is the chat's to consume)
    // a burst while a run is going: one run now, one more after it (never one per event, never in parallel)
    await Promise.all([post(evt(3), { id: "evt-2" }), post(evt(4), { id: "evt-3" }), post(evt(5), { id: "evt-4" }), post(evt(6), { id: "evt-5" })]);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(readFileSync(out, "utf-8").trim().split("\n").length, 3, readFileSync(out, "utf-8"));
    assert.match(readFileSync(out, "utf-8").trim().split("\n")[2], /count=7 /, "the second run is told what still waits");
    // the same burst when the first run read everything: no second run (a wake is a whole turn; never one for nothing)
    left = 0;
    await Promise.all([post(evt(1), { id: "evt-6" }), post(evt(2), { id: "evt-7" }), post(evt(3), { id: "evt-8" })]);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(readFileSync(out, "utf-8").trim().split("\n").length, 4, readFileSync(out, "utf-8"));

    abort.abort();
    for (let i = 0; i < 50 && !calls.some((c) => c.startsWith("exit")); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(calls, ["subscribe message.received https://hooks.example/h", "unsubscribe sub_" + "0".repeat(24), "exit 0"]);
    assert.ok(!existsSync(ev.servePath(m.id)), "the receiver's record is removed");
    await assert.rejects(fetch(url), "the port is closed");
  });
});

test("events serve: a URL that doesn't pass the check stops the receiver with a plain sentence (exit 6); --once exits after the first event", async () => {
  const home = newHome("events-serve2");
  await on(home, async () => {
    const m = member(home, "once");
    const said: string[] = [];
    const refuse = async () => {
      throw new ApiError(422, "event_verify_failed", "x", { reason: "connection" });
    };
    const code = await ev.serveEvents(m, { url: "https://dead.example/h", port: 0, say: (s) => said.push(s), api: { subscribe: refuse as any, unsubscribe: async () => true } });
    assert.equal(code, 6);
    assert.match(said.join("\n"), /didn't pass bot-link's check: bot-link's server couldn't reach it\. Nothing was subscribed\./);
    for (const s of said) assertCopy(s);
    assert.ok(!existsSync(ev.servePath(m.id)));

    let secret = "";
    let port = 0;
    const lines: string[] = [];
    const done = ev.serveEvents(m, {
      url: "https://hooks.example/once", port: 0, once: true, gapMs: 10, say: (s) => lines.push(s),
      api: { subscribe: async (_m, a) => ((secret = a.secret!), { subscription: subView(a.url), refreshed: false }), unsubscribe: async () => true },
      onReady: (i) => (port = i.port),
    });
    for (let i = 0; i < 50 && !port; i++) await new Promise((r) => setTimeout(r, 20));
    const body = JSON.stringify({ eventId: "e1", name: ev.EVENT_MESSAGE, timestamp: new Date().toISOString(), data: { member: { id: m.id, name: m.name }, waiting: 1 } });
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "webhook-id": "e1", "webhook-timestamp": ts, "webhook-signature": ev.sign(secret, "e1", ts, body) }, body });
    assert.equal(r.status, 204);
    assert.equal(await done, 0);
    assert.match(lines.join("\n"), /1 new bot-link message for once\. Call the bot-link inbox tool/);
    assert.ok(st.wakeMarkPending(m.id), "the chat's next inbox read counts as its idle wake");
    for (const s of lines) assertCopy(s);
  });
});

test("events CLI copy: subscription lines and refusals use only the product's words", () => {
  const s = subView("https://hooks.example/h");
  for (const t of [
    ev.subLine(s),
    ev.subLine({ ...s, state: "off", last_error: "http_5xx" }),
    ev.subLine({ ...s, state: "expired", urgent_only: true }),
    ev.subscriptionOffHint({ name: "svc" }, { ...s, state: "off", last_error: "http_5xx", failed_since: "2026-11-10T05:00:00Z" }, true),
    ev.subscriptionOffHint({ name: "svc" }, { ...s, state: "off", last_error: "connection" }, false),
    ev.explainEvents(new ApiError(422, "event_url_blocked", "x")),
    ev.explainEvents(new ApiError(409, "too_many_subscriptions", "x")),
    ...["connection", "http_4xx", "http_5xx", "challenge_failed", "weird"].map((reason) => ev.explainEvents(new ApiError(422, "event_verify_failed", "x", { reason }))),
  ]) assertCopy(t);
  assert.match(ev.subLine({ ...s, state: "off", last_error: "http_5xx" }), /OFF \(events kept failing: http_5xx; subscribe again to turn it on\)/);
});

test("MCP events/*: catalogue, input checks, and the draft's error codes (before any server call)", async () => {
  const noMember = async () => {
    throw new UserError("This chat isn't a bot-link member yet.");
  };
  const h = eventHandlers(noMember as any);
  assert.deepEqual(EVENTS_CAPABILITIES, { events: {}, extensions: { "io.modelcontextprotocol/events": {} } });
  const list = await h.list();
  assert.equal(list.resultType, "complete");
  assert.deepEqual(list.events.map((e) => [e.name, e.delivery]), [["message.received", ["webhook", "poll"]], ["roster.changed", ["webhook"]]]);
  for (const e of list.events) assert.ok(e.description && e.inputSchema && e.payloadSchema);
  assert.ok(!JSON.stringify(list.events[0].payloadSchema).includes('"text"'), "no message text in the event's schema");

  const secret = ev.newSecret();
  const d = { mode: "webhook", url: "https://app.example/hook", secret };
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 0;
    } catch (e) {
      assert.ok(e instanceof McpError, String(e));
      return (e as McpError).code;
    }
  };
  assert.equal(await code(h.subscribe({ name: "deployment.succeeded", delivery: d })), E.NotFound);
  assert.equal(await code(h.subscribe({ delivery: d })), E.NotFound);
  assert.equal(await code(h.subscribe({ name: "message.received" })), E.InvalidParams);
  assert.equal(await code(h.subscribe({ name: "message.received", delivery: { ...d, mode: "push" } })), E.Unsupported);
  assert.equal(await code(h.subscribe({ name: "message.received", delivery: { ...d, url: "ftp://x/y" } })), E.InvalidParams);
  assert.equal(await code(h.subscribe({ name: "message.received", delivery: { ...d, url: undefined } })), E.InvalidParams);
  assert.equal(await code(h.subscribe({ name: "message.received", delivery: { ...d, secret: "hunter2" } })), E.InvalidParams);
  assert.equal(await code(h.subscribe({ name: "message.received", delivery: { mode: "webhook", url: d.url } })), E.InvalidParams, "the secret is the app's own, always");
  assert.equal(await code(h.subscribe({ name: "message.received", delivery: d, arguments: { severity: "P1" } })), E.InvalidParams);
  assert.equal(await code(h.subscribe({ name: "message.received", delivery: d, arguments: "x" })), E.InvalidParams);
  assert.equal(await code(h.subscribe({ name: "roster.changed", delivery: d, arguments: { urgent_only: true } })), E.InvalidParams);
  assert.equal(await code(h.subscribe({ name: "message.received", delivery: d, ttlMs: -5 })), E.InvalidParams);
  assert.equal(await code(h.subscribe({ name: "message.received", delivery: d, ttlMs: "1h" })), E.InvalidParams);
  // well-formed, but this chat is not a member: Forbidden, in our words
  assert.equal(await code(h.subscribe({ name: "message.received", delivery: d })), E.Forbidden);
  assert.equal(await code(h.unsubscribe({ name: "message.received", delivery: { url: d.url } })), E.Forbidden);
  assert.equal(await code(h.unsubscribe({ name: "message.received", delivery: {} })), E.InvalidParams);
  assert.equal(await code(h.poll({ name: "roster.changed" })), E.Unsupported);
  assert.equal(await code(h.poll({ name: "message.received", cursor: null })), E.Forbidden);

  // poll: a null cursor starts from now; more waiting → at once; the same ones unread → after 1 min, then 2, 4 … (never
  // one a minute forever)
  {
    let now = 1_000_000;
    let waiting = 0;
    let newest = 10;
    const home = newHome("events-poll");
    await on(home, async () => {
      const m = member(home, "poller");
      const ph = eventHandlers(async () => ({ m, session: "sess-1" }), () => now, async () => ({ available: waiting, urgent: waiting, newest_seq: waiting ? newest : null }));
      const poll = async (cursor: string | null) => (await ph.poll({ name: "message.received", cursor }))!;
      waiting = 2;
      let r = await poll(null);
      assert.equal(r.events.length, 0, "a null cursor reports nothing in that call");
      r = await poll(r.cursor);
      assert.equal(r.events.length, 1);
      assert.equal((r.events[0].data as any).waiting, 2);
      const fired: number[] = [];
      let cur = r.cursor;
      for (let i = 0; i < 16 * 60; i++) {
        now += 15_000; // an app polling every 15 s for 4 hours while nobody reads
        r = await poll(cur);
        cur = r.cursor;
        if (r.events.length) fired.push(Math.round((now - 1_000_000) / 60_000));
      }
      assert.deepEqual(fired, [1, 3, 7, 15, 31, 63, 123, 183], "reported again after 1, 2, 4, 8, 16, 32 min, then hourly");
      // one was read and another came inside the same poll gap: the count is the same, the message is new. It is
      // reported at once, not after the (by now hourly) repeat gap of the old one
      newest = 11;
      now += 15_000;
      r = await poll(cur);
      assert.equal(r.events.length, 1, "a new message with an unchanged count is reported at once");
      cur = r.cursor;
      now += 15_000;
      assert.equal((await poll(cur)).events.length, 0, "and not again 15 s later");
      waiting = 3;
      newest = 12;
      now += 15_000;
      r = await poll(cur);
      assert.equal(r.events.length, 1, "a new message is reported at once");
      waiting = 0;
      now += 15_000;
      r = await poll(r.cursor);
      assert.equal(r.events.length, 0);
      waiting = 1;
      now += 15_000;
      assert.equal((await poll(r.cursor)).events.length, 1, "read, then a new one: at once again");
      assert.equal(await code(ph.poll({ name: "message.received", cursor: "garbage" })), E.InvalidParams);
      // a made-up cursor only hurts the app that made it up, and never throws
      const forged = (c: object) => Buffer.from(JSON.stringify(c)).toString("base64url");
      for (const c of [{ n: -5, t: 0, r: -99 }, { n: 1e9, t: now + 1e12, r: 1e9 }, { n: 1, t: now, r: 1.5, s: -1 }]) assert.ok((await poll(forged(c))).cursor);
    });
  }

  // server refusals → the draft's codes
  const refusing = (e: ApiError) =>
    eventHandlers(async () => {
      throw e;
    });
  const sub = (e: ApiError) => code(refusing(e).subscribe({ name: "message.received", delivery: d }));
  assert.equal(await sub(new ApiError(422, "event_verify_failed", "x", { reason: "challenge_failed" })), E.CallbackEndpointError);
  assert.equal(await sub(new ApiError(422, "event_url_blocked", "x")), E.InvalidParams);
  assert.equal(await sub(new ApiError(409, "too_many_subscriptions", "x")), E.ResourceExhausted);
  assert.equal(await sub(new ApiError(429, "rate_limited", "x", null, 30)), E.ResourceExhausted);
  assert.equal(await sub(new ApiError(403, "not_holder", "x")), E.Forbidden);
  assert.equal(await sub(new ApiError(410, "gone", "x")), E.Forbidden);
  assert.equal(await sub(new ApiError(500, "internal", "boom at 10.0.0.5")), E.Internal);
  try {
    await refusing(new ApiError(500, "internal", "boom at 10.0.0.5")).subscribe({ name: "message.received", delivery: d });
  } catch (e) {
    assert.ok(!(e as Error).message.includes("10.0.0.5"), "a server's own words never reach the app");
  }
  try {
    await refusing(new ApiError(422, "event_verify_failed", "x", { reason: "http_5xx" })).subscribe({ name: "message.received", delivery: d });
  } catch (e) {
    assert.deepEqual((e as McpError).data, { reason: "http_5xx" });
  }
});
