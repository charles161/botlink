/**
 * Fix-all CLIENTGLUE item 2b: after an update (a normal one, or the one a "too old" answer starts), the long-running
 * parts must not keep running the old copy. A supervised listener and watch notice that a newer release is installed
 * under `current` and restart through what already restarts them: the listener's supervisor (`listen … --supervise`)
 * and the service manager (watch's unit: systemd Restart=on-failure, launchd KeepAlive). Exit code 75 = "restart me
 * on the new copy".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as L from "../src/listen.js";
import * as W from "../src/watch.js";
import * as upd from "../src/update.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

let n = 0;
const S = () => `66666666-aaaa-4bbb-8ccc-${String(++n).padStart(12, "0")}`;
async function member(label: string): Promise<{ h: string; m: st.MemberRec }> {
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
  return { h, m };
}
const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !ok()) await new Promise((r) => setTimeout(r, 100));
  return ok();
};

test("a listener told a newer copy is installed stops cleanly with 75 (restart me) and leaves the turn alone", async () => {
  const { h, m } = await member("lrest");
  await on(h, async () => {
    const lines: string[] = [];
    let asked = 0;
    const code = await L.listenOnMessage(st.loadMember(m.id)!, "true", { say: (s) => lines.push(s), maxMs: 20_000, checkEveryMs: 200, restartWhen: () => ++asked >= 2 });
    assert.equal(code, L.RESTART_FOR_UPDATE);
    assert.equal(L.runningListener(m.id), null, "its lock is gone, so the restarted one can take it");
    assert.ok(lines.some((l) => /bot-link was updated; restarting this listener on the new copy/.test(l)), JSON.stringify(lines));
    // the room keeps seeing it listening: the restarted listener comes straight back
    const turns = f.turnLog.filter((t) => t.member === m.id).map((t) => t.turn);
    assert.deepEqual(turns, ["listening"], JSON.stringify(turns));
  });
});

test("a listener with nothing new keeps listening", async () => {
  const { h, m } = await member("lstay");
  await on(h, async () => {
    const code = await L.listenOnMessage(st.loadMember(m.id)!, "true", { say: () => {}, maxMs: 1500, checkEveryMs: 100, restartWhen: () => false });
    assert.equal(code, 0);
  });
});

test("watch told a newer copy is installed stops its waits and asks to be restarted; otherwise it keeps going", async () => {
  const lines: string[] = [];
  const w = new W.Watcher({ say: (s) => lines.push(s), tickMs: 50, checkEveryMs: 0, restartWhen: () => true, runForMs: 20_000 });
  const t0 = Date.now();
  await w.run();
  assert.ok(Date.now() - t0 < 5000, "it did not wait for runForMs");
  assert.equal(w.restarting, true);
  assert.ok(lines.some((l) => /bot-link was updated; watch restarts on the new copy/.test(l)), JSON.stringify(lines));
  const w2 = new W.Watcher({ say: () => {}, tickMs: 50, checkEveryMs: 0, restartWhen: () => false, runForMs: 400 });
  await w2.run();
  assert.equal(w2.restarting, false);
});

/** An install of this client under <home>/.botlink/client/<name> (dist + package.json; its dependencies linked). */
function install(h: string, name: string): string {
  const d = join(h, ".botlink", "client", name);
  mkdirSync(d, { recursive: true });
  cpSync(join(ROOT, "dist"), join(d, "dist"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(d, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(d, "node_modules"));
  writeFileSync(join(d, ".counter"), `${name === "v1" ? 1 : 2}\n`);
  return d;
}

test("end to end: a supervised listener started from the stable path restarts once on the new copy after an update", { timeout: 90_000 }, async () => {
  const { h, m } = await member("le2e");
  const env = { ...process.env, HOME: h, BOTLINK_HOME: join(h, ".botlink"), BOTLINK_NO_UPDATE: "1", BOTLINK_RESTART_CHECK_MS: "300" };
  const log = join(h, "listen.log");
  let sup = 0;
  await on(h, async () => {
    upd.swapCurrent(install(h, "v1"));
    const fd = openSync(log, "a");
    L.recordWakePath(m.id, { kind: "detached", command: "true", at: Date.now() }); // what --detach records
    const child = spawn(process.execPath, [join(h, ".botlink", "client", "current", "dist", "cli.js"), "listen", "--member-id", m.id, "--on-message", "true", "--supervise"], { cwd: h, env, detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    child.unref();
    sup = child.pid!;
    try {
      assert.ok(await until(() => !!L.runningListener(m.id), 20_000), `the listener did not start: ${readFileSync(log, "utf-8")}`);
      const p1 = L.runningListener(m.id)!.pid;
      // an update lands: `current` now points at a newer install
      upd.swapCurrent(install(h, "v2"));
      assert.ok(await until(() => { const l = L.runningListener(m.id); return !!l && l.pid !== p1; }, 20_000), `no restart: ${readFileSync(log, "utf-8")}`);
      const p2 = L.runningListener(m.id)!.pid;
      // the restarted listener runs the new copy: it does not restart again (an old copy would, every 300 ms)
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(L.runningListener(m.id)?.pid, p2, readFileSync(log, "utf-8"));
      const text = readFileSync(log, "utf-8");
      assert.equal(text.match(/restarting this listener on the new copy/g)?.length, 1, text);
      assert.ok(st.pidAlive(sup), "the supervisor keeps running");
    } finally {
      await L.stopListener(st.loadMember(m.id)!, 10_000);
      await until(() => !st.pidAlive(sup), 10_000);
      if (st.pidAlive(sup)) process.kill(sup, "SIGTERM");
    }
  });
  assert.ok(existsSync(log));
});
