/**
 * Fix-all CLIENTGLUE item 1: the chat's `status` tool shows a failed update (or the server's "too old" answer) with
 * the command that fixes it, the same lines `botlink status` shows, and says nothing about updates when all is well.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as upd from "../src/update.js";
import { tools } from "../src/mcp.js";
import { FakeServer } from "./fake-server.js";
import { assertCopy, assertIsolated, newHome, on, startFake } from "./helpers.js";

let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

let n = 0;
const S = () => `55555555-aaaa-4bbb-8ccc-${String(++n).padStart(12, "0")}`;

async function member(label: string): Promise<{ h: string; s: string; m: st.MemberRec }> {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `${label}${Math.floor(Math.random() * 1e6)}`, "p");
  const invite = `http://localhost:8811/i/${f.invite(room, adam)}`;
  const h = newHome(label);
  const s = S();
  const m = await on(h, async () => {
    const r = await core.joinCreate({ invite, name: "cc", job: "answers", app: "claude-code", turn: "on_turn", session: s, cwd: h, folder: "~", machine: "m" });
    f.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 5000, app: "claude-code", session: s, cwd: h });
    return (w as any).member as st.MemberRec;
  });
  return { h, s, m };
}

const writeState = (s: upd.UpdateState) => {
  mkdirSync(upd.clientDir(), { recursive: true });
  writeFileSync(join(upd.clientDir(), "update.json"), JSON.stringify(s));
};
const at = Date.parse("2026-11-15T10:00:00Z");

test("status tool: a failed update is shown with the command that fixes it", async () => {
  const { h, s } = await member("stfail");
  await on(h, async () => {
    writeState({ last: { at, from: "1.0.0-dev (ab12cd34)", to: "1.0.0-dev (ef56ab78)", ok: false, reason: "signature", detail: "the release signature is not from bot-link's release key" } });
    const out = await tools({ app: "claude-code", session: () => s }).status({});
    assert.match(out, /This chat is cc in #/);
    assert.match(out, /did not match bot-link's release key/);
    assert.match(out, /Nothing was installed/);
    assert.match(out, /[Rr]un `[^`]* update`/);
    assertCopy(out);
  });
});

test("status tool: the server's 'too old' answer is shown with its fix", async () => {
  const { h, s } = await member("stold");
  await on(h, async () => {
    writeState({ too_old: { at, need: "release 7", server: f.url } });
    const out = await tools({ app: "claude-code", session: () => s }).status({});
    assert.match(out, /too old to talk to its server/);
    assert.match(out, /update`/);
  });
});

test("status tool: a chat that is not a member still hears about a failed update", async () => {
  const h = newHome("stnone");
  await on(h, async () => {
    writeState({ last: { at, from: "1.0.0-dev", ok: false, reason: "disk", detail: "ENOSPC" } });
    const out = await tools({ app: "claude-code", session: () => S() }).status({});
    assert.match(out, /is not a bot-link member here/);
    assert.match(out, /the disk is full/);
  });
});

test("status tool: nothing about updates when all is well (a good update, or none ran)", async () => {
  const { h, s } = await member("stok");
  await on(h, async () => {
    const t = tools({ app: "claude-code", session: () => s });
    const none = await t.status({});
    writeState({ last: { at, from: "1.0.0-dev (ab12cd34)", to: "1.0.0-dev (ef56ab78)", ok: true }, last_ok_at: at });
    const ok = await t.status({});
    for (const out of [none, ok]) {
      assert.match(out, /This chat is cc in #/);
      assert.doesNotMatch(out, /update|up to date|too old/i, out);
    }
  });
});
