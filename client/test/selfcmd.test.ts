// Staging tester, 17 Nov 2026: a client run from a downloaded tarball (`npx -y ./botlink.tgz …` with
// BOTLINK_SERVER=https://test.botlink.dev, deploy/STAGING.md) told its chat to run `npx -y
// https://api.botlink.dev/dl/botlink.tgz`: the PRODUCTION client. npx records a local tarball as
// `file:<path relative to the _npx/<hash> folder>`, which selfCmd() did not read, and clientUrl() fell back to
// production whatever server the copy talks to. What a chat is told to run must be the thing that runs THIS copy
// against THIS server; a copy that can't name it says so in words, never production for another server.
//
// Each case is a real copy of dist/ laid out the way it is installed (an npx cache with its install record, a global
// install, a self-updated install), asked from its own process (PKG_ROOT is where the module file is).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, startFake } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const PROD = "https://api.botlink.dev/dl/botlink.tgz";
const RUN_AGAIN = "<the command you started bot-link with>";
let f: FakeServer;
before(async () => {
  assertIsolated();
  f = await startFake();
});
after(async () => f.stop());

/** A copy of this build at `root` (dist + package.json; dependencies through a node_modules link). */
function copyAt(root: string) {
  mkdirSync(root, { recursive: true });
  cpSync(join(ROOT, "dist"), join(root, "dist"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(root, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
}

/** An npx cache install as npx makes it: <base>/_npx/<hash>/node_modules/botlink plus the install record. */
function npxCopy(home: string, spec: string): { root: string; hashDir: string } {
  const hashDir = join(home, ".npm", "_npx", "c1f4c78d2534a540");
  const root = join(hashDir, "node_modules", "botlink");
  copyAt(root);
  writeFileSync(join(hashDir, "package.json"), JSON.stringify({ dependencies: { botlink: spec } }));
  return { root, hashDir };
}

/** What a copy says about itself, asked from its own process. `script`: where the asking script sits (argv[1]). */
function ask(root: string, home: string, env: Record<string, string | undefined>, script = join(home, "ask.mjs")) {
  writeFileSync(script, `const v = await import(${JSON.stringify(`file://${root}/dist/version.js`)});
const u = await import(${JSON.stringify(`file://${root}/dist/update.js`)});
console.log(JSON.stringify({ selfCmd: v.selfCmd(), clientUrl: v.clientUrl(), updateOrigin: u.updateOrigin(), updateBlocked: u.updateBlocked() }));`);
  const e: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, BOTLINK_HOME: join(home, ".botlink"), PATH: process.env.PATH || "" };
  delete e.BOTLINK_SERVER;
  delete e.BOTLINK_CLIENT_URL;
  delete e.BOTLINK_NO_UPDATE;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
  else e[k] = v;
  const r = spawnSync(process.execPath, [script], { cwd: home, env: e, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as { selfCmd: string; clientUrl: string | null; updateOrigin: string; updateBlocked: string | null };
}

test("an https spec on bot-link's host: the same `npx -y <url>`", () => {
  const home = newHome("sc-https");
  const { root } = npxCopy(home, PROD);
  const r = ask(root, home, {});
  assert.equal(r.selfCmd, `npx -y ${PROD}`);
  assert.equal(r.clientUrl, PROD);
  assert.equal(r.updateOrigin, "https://api.botlink.dev");
});

test("an https spec on the BOTLINK_SERVER host (staging): that address, never production", () => {
  const home = newHome("sc-staging-url");
  const { root } = npxCopy(home, "https://test.botlink.dev/dl/botlink.tgz");
  const r = ask(root, home, { BOTLINK_SERVER: "https://test.botlink.dev" });
  assert.equal(r.selfCmd, "npx -y https://test.botlink.dev/dl/botlink.tgz");
  assert.equal(r.updateOrigin, "https://test.botlink.dev");
});

test("a local tarball with BOTLINK_SERVER staging: `npx -y file:<absolute path>` (what npx records is relative); no production anywhere", () => {
  const home = newHome("sc-file-staging");
  writeFileSync(join(home, "botlink.tgz"), "x");
  const { root } = npxCopy(home, "file:../../../botlink.tgz"); // exactly what npx 10 writes for `npx -y ./botlink.tgz` run in <home>
  const r = ask(root, home, { BOTLINK_SERVER: "https://test.botlink.dev" });
  assert.equal(r.selfCmd, `npx -y file:${join(home, "botlink.tgz")}`);
  assert.match(r.selfCmd, /^npx -y file:\//, "the file: form with an absolute path runs from any folder (a bare absolute path does not)");
  assert.equal(r.clientUrl, null, "this copy has no download address for its server; production is not it");
  assert.equal(r.updateOrigin, "https://test.botlink.dev", "it updates from the server it talks to");
  assert.ok(!JSON.stringify(r).includes("api.botlink.dev"), JSON.stringify(r));
});

test("a local tarball with no BOTLINK_SERVER: `npx -y file:<absolute path>`; an absolute record is used as it is", () => {
  const home = newHome("sc-file");
  writeFileSync(join(home, "botlink.tgz"), "x");
  const { root } = npxCopy(home, `file:${join(home, "botlink.tgz")}`);
  assert.equal(ask(root, home, {}).selfCmd, `npx -y file:${join(home, "botlink.tgz")}`);
});

test("a local tarball that is gone: words, never production for another server; and it never updates from production by guess", () => {
  const home = newHome("sc-file-gone");
  const { root } = npxCopy(home, "file:../../../gone.tgz");
  const s = ask(root, home, { BOTLINK_SERVER: "https://test.botlink.dev" });
  assert.equal(s.selfCmd, RUN_AGAIN);
  assert.ok(!JSON.stringify(s).includes("api.botlink.dev"), JSON.stringify(s));
  // the server this copy talks to is known only from its members: it updates from there
  mkdirSync(join(home, ".botlink", "members"), { recursive: true });
  writeFileSync(join(home, ".botlink", "members", "m1.json"), JSON.stringify({ id: "0193b000-0000-7000-8000-000000000001", server: "https://test.botlink.dev", name: "a", room: { id: "r", name: "r" } }));
  const m = ask(root, home, {});
  assert.equal(m.updateOrigin, "https://test.botlink.dev");
  assert.equal(m.selfCmd, RUN_AGAIN, "its members talk to staging: production is not its command");
  rmSync(join(home, ".botlink", "members"), { recursive: true, force: true });
  // nothing says which server: no update from production by guess
  const n = ask(root, home, {});
  assert.match(String(n.updateBlocked), /installed from a file on this computer/);
});

test("a global install (`botlink` on PATH): `botlink`", () => {
  const home = newHome("sc-global");
  const root = join(home, "prefix", "lib", "node_modules", "botlink");
  copyAt(root);
  mkdirSync(join(home, "prefix", "bin"), { recursive: true });
  const r = ask(root, home, {}, join(home, "prefix", "bin", "botlink"));
  assert.equal(r.selfCmd, "botlink");
});

test("a self-updated install under ~/.botlink/client: the stable shim", () => {
  const home = newHome("sc-client");
  const v = join(home, ".botlink", "client", "1.0.0-dev-0123456789ab");
  copyAt(v);
  writeFileSync(join(v, ".source"), "file:/somewhere/botlink.tgz\n");
  symlinkSync("1.0.0-dev-0123456789ab", join(home, ".botlink", "client", "current"));
  const r = ask(v, home, { BOTLINK_SERVER: "https://test.botlink.dev" });
  assert.equal(r.selfCmd, `node ${join(home, ".botlink", "client", "current", "dist", "cli.js")}`);
  assert.equal(r.updateOrigin, "https://test.botlink.dev");
});

test("end to end: create-room from a local-tarball install against a server that is not production names no api.botlink.dev", async () => {
  const home = newHome("sc-e2e");
  writeFileSync(join(home, "botlink.tgz"), "x");
  const { root } = npxCopy(home, "file:../../../botlink.tgz");
  // (a child that runs while this process keeps serving the fake: spawnSync would block the server it calls)
  const { spawn } = await import("node:child_process");
  const r = await new Promise<{ status: number | null; out: string }>((res) => {
    const ch = spawn(process.execPath, [join(root, "dist", "cli.js"), "create-room", "--room", "stagingroom", "--purpose", "try it", "--name", "tester", "--job", "tests", "--app", "claude-code", "--session", "55555555-aaaa-4bbb-8ccc-00000000e2e0"], {
      cwd: home, env: { ...(process.env as Record<string, string>), HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, BOTLINK_NO_UPDATE: "1" },
    });
    let out = "";
    ch.stdout.on("data", (b) => (out += b));
    ch.stderr.on("data", (b) => (out += b));
    ch.on("exit", (status) => res({ status, out }));
  });
  assert.equal(r.status, 0, r.out);
  assert.ok(!r.out.includes("api.botlink.dev"), r.out);
  assert.ok(r.out.includes(`npx -y file:${join(home, "botlink.tgz")} roster`), r.out);
  assert.ok(r.out.includes(`npx -y file:${join(home, "botlink.tgz")} join --wait`), r.out);
});

// Staging tester rerun 2, 17 Nov 2026 (L.1): `status` from a downloaded tarball printed no command to run bot-link
// again, while --help, join and create-room did. status is what a chat runs to find out where it stands; it names
// the command that runs THIS copy, in every state (no member, no app detected, a member).
test("status from a local-tarball install names the command that runs this copy (`npx -y file:<absolute path>`), never production", () => {
  const home = newHome("sc-status");
  writeFileSync(join(home, "botlink.tgz"), "x");
  const { root } = npxCopy(home, "file:../../../botlink.tgz");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: "https://test.botlink.dev", BOTLINK_NO_UPDATE: "1" };
  const cmd = `npx -y file:${join(home, "botlink.tgz")}`;
  for (const args of [["status"], ["status", "--app", "claude-code"], ["status", "--app", "other"]]) {
    const r = spawnSync(process.execPath, [join(root, "dist", "cli.js"), ...args], { cwd: home, env, encoding: "utf-8" });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
    assert.ok(out.includes(`Run bot-link here with: ${cmd} <command>`), `${args.join(" ")}:\n${out}`);
    assert.ok(out.includes(`${cmd} --help`), out);
    assert.ok(!out.includes("api.botlink.dev"), out);
    assert.match(out, /This chat: .*\nActing as: /, "the first two lines stay as they are");
  }
});
