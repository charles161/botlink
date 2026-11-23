/**
 * First-class Antigravity harness detection & support:
 * - Detects Antigravity from ANTIGRAVITY_* env vars (ANTIGRAVITY_CONVERSATION_ID, ANTIGRAVITY_AGENT,
 *   ANTIGRAVITY_TRAJECTORY_ID, ANTIGRAVITY_APP_DATA_DIR, ANTIGRAVITY_LS_VERSION) and ancestor comm `agy` / `antigravity`.
 * - Resolves session id from ANTIGRAVITY_CONVERSATION_ID (overridden by explicit --session / BOTLINK_SESSION).
 * - Reports wire app "other" with clean display label "Antigravity" (no --app-name prompt needed).
 * - Never assumes Claude/Codex/Cursor hooks wake it; reports Antigravity CLI facts cleanly.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as h from "../src/harnesses.js";
import { appFromEnv, appOfComm, appsFromEnv, currentSession, detectApp, antigravityConvFromEnv } from "../src/session.js";
import { envFacts } from "../src/listening.js";
import { restartLine, wakeReadyFor } from "../src/cli.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

const KEYS = [
  "ANTIGRAVITY_AGENT",
  "ANTIGRAVITY_CONVERSATION_ID",
  "ANTIGRAVITY_TRAJECTORY_ID",
  "ANTIGRAVITY_APP_DATA_DIR",
  "ANTIGRAVITY_LS_VERSION",
  "BOTLINK_APP",
  "BOTLINK_SESSION",
  "T3CODE_THREAD_ID",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CURSOR_AGENT",
  "CURSOR_CONVERSATION_ID",
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

const CONV = "ea0681b8-c74e-4d22-beb2-0d9f3a09c7aa";

test("Antigravity: detected from ANTIGRAVITY_* env vars and agy/antigravity process comm", () => {
  setEnv({ ANTIGRAVITY_CONVERSATION_ID: CONV, ANTIGRAVITY_AGENT: "1" });
  assert.equal(antigravityConvFromEnv(), CONV);
  assert.deepEqual(appsFromEnv(process.env), ["antigravity"]);
  assert.equal(appFromEnv(process.env), "antigravity");
  assert.equal(detectApp(), "antigravity");

  setEnv({ ANTIGRAVITY_APP_DATA_DIR: "/tmp/agy-data" });
  assert.equal(detectApp(), "antigravity");

  setEnv({ BOTLINK_APP: "antigravity" });
  assert.equal(detectApp(), "antigravity");

  // Explicit BOTLINK_APP wins over env
  setEnv({ ANTIGRAVITY_CONVERSATION_ID: CONV, BOTLINK_APP: "claude-code" });
  assert.equal(detectApp(), "claude-code");

  // Process comm detection
  assert.equal(appOfComm("agy"), "antigravity");
  assert.equal(appOfComm("antigravity"), "antigravity");
  assert.equal(appOfComm("antigravity-cli"), "antigravity");
});

test("Antigravity: session id comes from ANTIGRAVITY_CONVERSATION_ID; BOTLINK_SESSION and explicit override", () => {
  setEnv({ ANTIGRAVITY_CONVERSATION_ID: CONV, ANTIGRAVITY_AGENT: "1" });
  assert.equal(currentSession().id, CONV);

  setEnv({ ANTIGRAVITY_CONVERSATION_ID: CONV, BOTLINK_SESSION: "explicit-env-agy-1" });
  assert.equal(currentSession().id, "explicit-env-agy-1");

  assert.equal(currentSession(undefined, "explicit-arg-agy-2").id, "explicit-arg-agy-2");
});

test("Antigravity: wire app is other with clean label Antigravity; no hooks assumed; envFacts clear", () => {
  assert.equal(st.wireApp("antigravity"), "other");
  assert.equal(st.KNOWN_APP_NAME.antigravity, "Antigravity");
  assert.equal(h.LABELS.antigravity, "Antigravity");
  assert.equal(wakeReadyFor("antigravity"), false);
  assert.match(restartLine("antigravity"), /no tools for this app|command line|commands above/i);
  assert.match(envFacts({ app: "antigravity", holder_session: CONV }), /app: Antigravity/);
});

test("Antigravity: join sends app other + app_name Antigravity without needing --app-name", async () => {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `agyroom${Math.floor(Math.random() * 1e4)}`);
  const url = `http://localhost:8811/i/${f.invite(room, adam)}`;
  const home = newHome("agy-join");
  await on(home, async () => {
    const r = await core.joinCreate({
      invite: url,
      name: "agy-agent",
      job: "antigravity engineer",
      app: "antigravity",
      turn: "on_turn",
      session: CONV,
      cwd: home,
      folder: "~",
      machine: "lab",
    });
    const j = f.joins.get(r.req.id)!;
    assert.equal(j.body.app, "other");
    assert.equal(j.body.app_name, "Antigravity");
    f.approve(r.req.id);
    const w = await core.joinWait({ maxMs: 3000, app: "antigravity", session: CONV, cwd: home });
    assert.equal(w.status, "approved", w.text);
    const m = (w as any).member as st.MemberRec;
    assert.equal(m.app, "antigravity");
    assert.equal(m.app_name, "Antigravity");
    assert.match(await core.rosterText(m, CONV), /agy-agent \(this chat\) · Antigravity/);
  });
});
