/**
 * First-class Grok Bot harness detection & support:
 * - Real Grok Bot Linux VMs set CURSOR_AGENT / CURSOR_CONVERSATION_ID alongside GROK_BOT_CLAIM_PRINCIPAL,
 *   SAND_SUPERVISOR_ENABLED / SAND_BOX_* and hostname `grok-bot-vm-<digits>` (observed on the operator's live VM, 23 Nov 2026).
 * - bot-link must detect `grok-bot` AHEAD of `cursor` so Grok Bot joins with the Grok Bot icon/label (`other` + `"Grok Bot"`),
 *   never auto-detects as Cursor, never offers Cursor hooks/watch resume, and gives accurate Grok Bot listening facts.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as h from "../src/harnesses.js";
import { appFromEnv, appsFromEnv, detectApp, isGrokBotEnv, isGrokBotHost } from "../src/session.js";
import { envFacts } from "../src/listening.js";
import { restartLine, wakeReadyFor } from "../src/cli.js";
import { wakeTarget } from "../src/watch.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

const KEYS = [
  "GROK_BOT_CLAIM_PRINCIPAL",
  "SAND_SUPERVISOR_ENABLED",
  "SAND_MANIFEST_V2",
  "SAND_BOX_BOOT_ID",
  "SAND_BOX_CLUSTER",
  "CURSOR_AGENT",
  "CURSOR_AGENT_SOCKET",
  "CURSOR_CONVERSATION_ID",
  "CURSOR_REQUEST_ID",
  "CURSOR_TRACE_ID",
  "BOTLINK_APP",
  "BOTLINK_SESSION",
  "T3CODE_THREAD_ID",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "ANTIGRAVITY_CONVERSATION_ID",
  "ANTIGRAVITY_AGENT",
];
const saved: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function setEnv(o: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, o);
}
afterEach(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

test("Grok Bot: detected ahead of Cursor from GROK_BOT_* env, SAND_* VM markers, or grok-bot-vm-* hostname", () => {
  // Real Grok Bot VM env carries BOTH CURSOR_AGENT/CURSOR_CONVERSATION_ID and GROK_BOT_CLAIM_PRINCIPAL
  setEnv({
    CURSOR_AGENT: "1",
    CURSOR_CONVERSATION_ID: "cur-conv-1234",
    GROK_BOT_CLAIM_PRINCIPAL: "principal-abc",
  });
  assert.equal(isGrokBotEnv(process.env), true);
  assert.equal(appsFromEnv(process.env)[0], "grok-bot");
  assert.equal(appFromEnv(process.env), "grok-bot");
  assert.equal(detectApp("plain-host"), "grok-bot");

  // SAND_SUPERVISOR_ENABLED + SAND_BOX_* also detects Grok Bot ahead of Cursor
  setEnv({
    CURSOR_AGENT: "1",
    SAND_SUPERVISOR_ENABLED: "1",
    SAND_BOX_BOOT_ID: "boot-1",
  });
  assert.equal(isGrokBotEnv(process.env), true);
  assert.equal(detectApp("plain-host"), "grok-bot");

  // Hostname fallback `grok-bot-vm-<digits>` wins over CURSOR_AGENT even without GROK_BOT_* env
  setEnv({ CURSOR_AGENT: "1", CURSOR_CONVERSATION_ID: "cur-conv-5678" });
  assert.equal(isGrokBotEnv(process.env), false);
  assert.equal(isGrokBotHost("grok-bot-vm-27056201"), true);
  assert.equal(isGrokBotHost("macbook-pro"), false);
  assert.equal(detectApp("grok-bot-vm-27056201"), "grok-bot");
  // Plain Cursor machine without Grok Bot signals stays cursor
  assert.equal(detectApp("macbook-pro"), "cursor");

  // Explicit BOTLINK_APP always wins
  setEnv({ GROK_BOT_CLAIM_PRINCIPAL: "principal-abc", BOTLINK_APP: "cursor" });
  assert.equal(detectApp("grok-bot-vm-27056201"), "cursor");

  // Explicit BOTLINK_APP=grok-bot works anywhere
  setEnv({ BOTLINK_APP: "grok-bot" });
  assert.equal(detectApp("macbook-pro"), "grok-bot");
});

test("Grok Bot: wire app is other + app_name Grok Bot; no Cursor hooks/watch; accurate Grok Bot envFacts", () => {
  assert.equal(st.wireApp("grok-bot"), "other");
  assert.equal(st.KNOWN_APP_NAME["grok-bot"], "Grok Bot");
  assert.equal(h.LABELS["grok-bot"], "Grok Bot");
  assert.equal(wakeReadyFor("grok-bot"), false);
  assert.match(restartLine("grok-bot"), /no tools for this app|command line|commands above/i);
  assert.doesNotMatch(restartLine("grok-bot"), /Cursor/);
  const facts = envFacts({ app: "grok-bot", holder_session: null });
  assert.match(facts, /app: Grok Bot/);
  assert.match(facts, /background command does not start a new turn|wait --max-s|events subscribe/i);
});

test("Grok Bot: join sends app other + app_name Grok Bot automatically without --app-name and never uses Cursor watch", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `grokauto${Math.floor(Math.random() * 1e4)}`);
  const url = `http://localhost:8811/i/${f.invite(room, adam)}`;
  const home = newHome("grok-auto-join");
  await on(home, async () => {
    const r = await core.joinCreate({
      invite: url,
      name: "bob-auto",
      job: "Grok Bot assistant",
      app: "grok-bot",
      turn: "on_turn",
      session: null,
      cwd: home,
      folder: "~",
      machine: "grok-bot-vm-27056201",
    });
    const j = f.joins.get(r.req.id)!;
    assert.equal(j.body.app, "other");
    assert.equal(j.body.app_name, "Grok Bot");
    assert.equal(j.body.turn, "on_turn");
    f.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 3000, app: "grok-bot", session: null, cwd: home });
    assert.equal(w.status, "approved", w.text);
    const m = (w as any).member as st.MemberRec;
    assert.equal(m.app, "grok-bot");
    assert.equal(m.app_name, "Grok Bot");
    assert.equal(wakeTarget(m), null, "watch never resumes Grok Bot as Cursor");
    assert.match(await core.rosterText(m, null), /bob-auto \(this chat\) · Grok Bot/);
  });
});
