/**
 * T3 Code as an app (2026-11-11, probed on t3 0.1.9 with its Claude provider): a T3 thread gives its commands
 * T3CODE_THREAD_ID (e.g. "mcp:<uuid>") next to the provider's own markers (CLAUDECODE=1, CLAUDE_CODE_ENTRYPOINT=t3-code,
 * CLAUDE_CODE_SESSION_ID). Before: the chat joined as "Claude Code", was told that app's hooks "may already wake this
 * chat", ended its turn and never listened. Now: the app is "T3 Code" (wire: "other" + app_name), the chat is the T3
 * thread (its id is the session), nothing is assumed to wake it, and `listen --via t3` finds T3's own command line.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as st from "../src/state.js";
import { currentSession, detectApp, t3ThreadFromEnv } from "../src/session.js";
import { t3BaseDir, t3Bin, viaCommand, viaOf } from "../src/listen.js";
import { envFacts } from "../src/listening.js";
import { wakeReadyFor } from "../src/cli.js";

const KEYS = ["T3CODE_THREAD_ID", "T3CODE_HOME", "T3CODE_NPM_LAUNCHER_PATH", "BOTLINK_T3_BIN", "BOTLINK_APP", "BOTLINK_SESSION", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"];
const saved: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function env(o: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, o);
}
afterEach(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const THREAD = "mcp:336690eb-2e19-483b-bea9-038d5412eecc";
const CLAUDE_IN_T3 = { T3CODE_THREAD_ID: THREAD, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "t3-code", CLAUDE_CODE_SESSION_ID: "94f77968-4cef-456c-a52f-c8ff6fd1c96c" };

test("T3: a thread's commands are detected as T3 Code, whichever provider runs under it", () => {
  env(CLAUDE_IN_T3);
  assert.equal(t3ThreadFromEnv(), THREAD);
  assert.equal(detectApp(), "t3");
  env({ T3CODE_THREAD_ID: THREAD, CODEX_THREAD_ID: "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" });
  assert.equal(detectApp(), "t3");
  // an explicit app still wins, and a thread id that is not an id is no signal
  env({ ...CLAUDE_IN_T3, BOTLINK_APP: "claude-code" });
  assert.equal(detectApp(), "claude-code");
  env({ T3CODE_THREAD_ID: "not an id", CLAUDECODE: "1" });
  assert.equal(detectApp(), "claude-code");
});

test("T3: the chat is the T3 thread: its id is the session, over the provider's own ids and a provider hook's", () => {
  env(CLAUDE_IN_T3);
  assert.deepEqual({ id: currentSession().id, app: currentSession().app }, { id: THREAD, app: "t3" });
  assert.equal(currentSession({ session_id: "94f77968-4cef-456c-a52f-c8ff6fd1c96c" }).id, THREAD);
  // BOTLINK_SESSION and an explicit id keep their precedence
  env({ ...CLAUDE_IN_T3, BOTLINK_SESSION: "explicit-env-session-1" });
  assert.equal(currentSession().id, "explicit-env-session-1");
});

test("T3: on the wire it is app other with the name T3 Code; no hooks are assumed to wake it", () => {
  assert.equal(st.wireApp("t3"), "other");
  assert.equal(st.KNOWN_APP_NAME.t3, "T3 Code");
  assert.equal(st.cleanAppName(st.KNOWN_APP_NAME.t3), "T3 Code");
  assert.equal(wakeReadyFor("t3"), false);
  assert.match(envFacts({ app: "t3", holder_session: THREAD }), /app: T3 Code/);
  assert.match(envFacts({ app: "t3", holder_session: THREAD }), /t3 thread send <thread id>/);
});

test("T3: listen --via t3 runs T3's own `thread send`, finds an npx install's launcher and passes T3's data directory", () => {
  const m = { id: "01a1cafc-1f2a-7914-85b0-0b8dc0acf018", name: "t3-chat" } as st.MemberRec;
  const dir = mkdtempSync(join(tmpdir(), "bl-t3-"));
  const launcher = join(dir, "t3.mjs");
  writeFileSync(launcher, "");
  // t3 on PATH: plain `t3`
  const bin = join(dir, "bin");
  st.ensureDir(bin);
  writeFileSync(join(bin, "t3"), "");
  assert.equal(t3Bin({ PATH: bin, T3CODE_NPM_LAUNCHER_PATH: launcher }), "t3");
  // not on PATH: the launcher T3 names for its threads' commands, run with this node
  assert.equal(t3Bin({ PATH: "/nonexistent", T3CODE_NPM_LAUNCHER_PATH: launcher }), `'${process.execPath}' '${launcher}'`);
  assert.equal(t3Bin({ PATH: "/nonexistent", T3CODE_NPM_LAUNCHER_PATH: join(dir, "gone.mjs") }), "t3");
  assert.equal(t3Bin({ PATH: bin, BOTLINK_T3_BIN: "/opt/t3/t3" }), "'/opt/t3/t3'");
  assert.equal(t3BaseDir({}), "");
  assert.equal(t3BaseDir({ T3CODE_HOME: "/home/x/.t3 test" }), " --base-dir '/home/x/.t3 test'");

  env({ T3CODE_HOME: "/home/x/.t3alt", T3CODE_NPM_LAUNCHER_PATH: launcher });
  const saveP = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const cmd = viaCommand("t3", THREAD, m);
    assert.ok(cmd.startsWith(`'${process.execPath}' '${launcher}' thread send '${THREAD}' '`), cmd);
    assert.ok(cmd.endsWith(" --wait --base-dir '/home/x/.t3alt'"), cmd);
    // the stored command is still recognised as this thread's T3 wake
    assert.deepEqual(viaOf(cmd), { via: "t3", id: THREAD });
  } finally {
    process.env.PATH = saveP;
  }
});
