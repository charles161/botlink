// Founder's standing rule, made a check (17 Nov 2026): a red test in roomtool.test.ts sent one real POST to
// api.botlink.dev. Every test process, and every client process a test starts, runs with test/netguard.mjs
// (NODE_OPTIONS=--import, set by scripts/run-tests.mjs; the guard puts itself into the env of every child it spawns):
// a connection to anything but loopback is refused before a packet leaves, said on stderr with the host, and
// recorded. The run fails when anything was refused outside a test that asked for it (run-tests.mjs).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { connect } from "node:net";
import { join } from "node:path";

import { assertIsolated, newHome } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const GUARD = join(import.meta.dirname, "netguard.mjs");

before(() => assertIsolated());

const records = (log: string) => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Run with the guard's record going to `log` (not the run's own record: these attempts are on purpose). */
async function withLog<T>(log: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.BOTLINK_NET_GUARD_LOG;
  process.env.BOTLINK_NET_GUARD_LOG = log;
  try {
    return await fn();
  } finally {
    process.env.BOTLINK_NET_GUARD_LOG = saved;
  }
}

test("this test process runs under the guard: fetch, https and a raw socket to a real host are refused before connecting, and recorded", async () => {
  assert.equal((globalThis as any).__botlinkNetGuard, true, "run-tests.mjs loads test/netguard.mjs into every test process");
  assert.ok(String(process.env.NODE_OPTIONS).includes("netguard.mjs"), String(process.env.NODE_OPTIONS));
  const log = join(newHome("ng-self"), "guard.jsonl");
  await withLog(log, async () => {
    const e = await fetch("https://api.botlink.dev/healthz").then(() => null, (x) => x);
    assert.ok(e, "fetch to production must not succeed");
    assert.equal(e.cause?.code, "BOTLINK_NET_GUARD", String(e.cause || e));
    assert.match(String(e.cause.message), /api\.botlink\.dev/);
    const h = await new Promise<any>((res) => request("https://app.botlink.dev/", (r) => res(r)).on("error", res).end());
    assert.equal(h.code, "BOTLINK_NET_GUARD");
    const s = await new Promise<any>((res) => connect({ host: "192.0.2.1", port: 443 }).on("error", res).on("connect", () => res(null)));
    assert.equal(s?.code, "BOTLINK_NET_GUARD");
  });
  assert.deepEqual(records(log).map((r) => r.host), ["api.botlink.dev", "app.botlink.dev", "192.0.2.1"]);
  // loopback still works (the fake servers): a refused port is a normal error, not the guard
  const lo = await new Promise<any>((res) => connect({ host: "127.0.0.1", port: 9 }).on("error", res).on("connect", () => res(null)));
  assert.notEqual(lo?.code, "BOTLINK_NET_GUARD");
});

/** A client process started the way tests start them, but with an env built from nothing (no NODE_OPTIONS): the guard
 *  in this process puts itself into the child. Waits for the guard's record, then stops the child (no timeout waited). */
async function clientAttempt(args: string[], extra: Record<string, string> = {}, loud = true): Promise<{ recs: any[]; stderr: string }> {
  const home = newHome("ng-child");
  const log = join(home, "guard.jsonl");
  const ch = spawn(process.execPath, [CLI, ...args], {
    cwd: home,
    env: { PATH: process.env.PATH || "", HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_KEYCHAIN: "0", BOTLINK_NET_GUARD_LOG: log, ...extra },
  });
  let stderr = "";
  ch.stdout.on("data", () => {});
  ch.stderr.on("data", (b) => (stderr += b));
  // "close": the child exited AND its stdout/stderr are drained (after "exit" a pipe may still hold the last line)
  const closed = new Promise<void>((r) => ch.on("close", () => r()));
  let done = false;
  void closed.then(() => (done = true));
  // until the refusal is complete: the record, and (unless record mode) the loud line that comes before it; bounded
  const complete = () => records(log).length > 0 && (!loud || /refused a connection/.test(stderr));
  for (let i = 0; i < 600 && !complete() && !done; i++) await new Promise((r) => setTimeout(r, 50));
  if (!done) ch.kill("SIGTERM");
  await closed;
  return { recs: records(log), stderr };
}

for (const [label, args, extra] of [
  ["create-room (no BOTLINK_SERVER, no members: production)", ["create-room", "--room", "guarded", "--purpose", "p", "--name", "g", "--job", "j", "--app", "claude-code", "--session", "55555555-aaaa-4bbb-8ccc-00000000aaaa"], {}],
  ["join with a production invite", ["join", "https://app.botlink.dev/i/acme-K7Q2MX9PR4", "--name", "g", "--job", "j", "--app", "claude-code"], {}],
  ["update (a self-installed copy updates from production)", ["update"], { BOTLINK_SELF_INSTALL: "1" }],
] as const) {
  test(`a client process a test starts is guarded too: ${label} is refused before it connects, with the host said`, async () => {
    const { recs, stderr } = await clientAttempt([...args], { ...extra });
    assert.ok(recs.length > 0, `the guard saw no attempt (stderr: ${stderr})`);
    assert.equal(recs[0].host, "api.botlink.dev", JSON.stringify(recs));
    assert.notEqual(recs[0].pid, process.pid, "refused in the child process");
    assert.match(stderr, /bot-link test network guard: refused a connection to api\.botlink\.dev:443/);
  });
}

test("record mode: the attempt is recorded (what would have gone out) and still refused, without the loud line", async () => {
  const { recs, stderr } = await clientAttempt(["join", "https://app.botlink.dev/i/acme-K7Q2MX9PR4", "--name", "g", "--job", "j", "--app", "claude-code"], { BOTLINK_NET_GUARD: "record" }, false);
  assert.equal(recs[0]?.host, "api.botlink.dev");
  assert.equal(recs[0]?.blocked, true);
  assert.doesNotMatch(stderr, /refused a connection/);
});

test("the guard is test code: the packed tarball does not contain it", () => {
  assert.ok(existsSync(GUARD));
  // (npm's own update check would ask the registry: the guard refused it once; offline and without the check it asks nothing)
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"], { cwd: ROOT, encoding: "utf-8", env: { ...process.env, npm_config_update_notifier: "false" } });
  const files: string[] = JSON.parse(out)[0].files.map((x: any) => x.path);
  assert.ok(files.includes("dist/cli.js"), files.join(", "));
  assert.deepEqual(files.filter((p) => /netguard|(^|\/)test\//.test(p)), []);
  writeFileSync(join(newHome("ng-pack"), "files.json"), JSON.stringify(files));
});
