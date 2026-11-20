/**
 * Blocker 9: a failed background update is shown (botlink status, once in a chat's tool output) in plain words with
 * the one command that fixes it, cleared by the next good update, never retried in a tight loop; and a server
 * that says "this client is too old" (426 client_too_old) gets one signed self-update attempt and a clear sentence.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as upd from "../src/update.js";
import * as rel from "../src/release.js";
import { updateStatusLines } from "../src/updatenote.js";
import { ClientTooOld, resetTooOldForTests } from "../src/tooold.js";
import { Api, ApiError } from "../src/api.js";
import { HostError } from "../src/hosts.js";
import { VERSION } from "../src/version.js";
import * as core from "../src/core.js";
import { assertCopy, assertIsolated, newHome, on, PORT_BASE } from "./helpers.js";

before(() => assertIsolated());

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FRIGHT = /attack|compromis|tamper|malicious|hack|danger|warning|alert|breach|!/i;

function tarball(label: string, version: string, o: { deps?: Record<string, string> } = {}): Buffer {
  const d = newHome(`un-tgz-${label}`);
  const pkg = join(d, "package");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "botlink", version, type: "module", dependencies: o.deps ?? {} }));
  writeFileSync(join(pkg, "dist", "cli.js"), `// bot-link ${version}\n`);
  const out = join(d, "b.tgz");
  assert.equal(spawnSync("tar", ["-czf", out, "-C", d, "package"]).status, 0);
  return readFileSync(out);
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const rawPk = (k: KeyObject) => Buffer.from(k.export({ type: "spki", format: "der" })).subarray(12).toString("hex");
const testKey = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519");
const testPk = rawPk(testKey.publicKey);

let served: { tgz: Buffer; version: string; counter: number; unsigned?: boolean; signedBy?: KeyObject } = { tgz: Buffer.alloc(0), version: "", counter: 1 };
let hits = { manifest: 0, tgz: 0, api: 0 };
let apiSaw: string | undefined;
let apiSawRelease: string | undefined;
let srv: Server;
let port = 0;

before(async () => {
  srv = createServer((req, res) => {
    if (req.url === "/dl/botlink.manifest.json") {
      hits.manifest++;
      if (served.unsigned) {
        res.writeHead(404);
        res.end();
        return;
      }
      const manifest = JSON.stringify({ v: 1, name: "botlink", version: served.version, sha256: sha(served.tgz), size: served.tgz.length, counter: served.counter, signed_at: 1 });
      const sig = edSign(null, Buffer.from(rel.MANIFEST_DOMAIN + manifest, "utf-8"), served.signedBy ?? testKey.privateKey).toString("base64");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ manifest, sig, key: rel.keyId(testPk) }));
    } else if (req.url === "/dl/botlink.tgz") {
      hits.tgz++;
      res.writeHead(200, { "content-type": "application/gzip", "content-length": served.tgz.length });
      res.end(served.tgz);
    } else if (req.url?.startsWith("/api/v1/")) {
      // a server with a minimum client version above this client
      hits.api++;
      apiSaw = req.headers["x-botlink-client-version"] as string | undefined;
      apiSawRelease = req.headers["x-botlink-client-release"] as string | undefined;
      res.writeHead(426, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "client_too_old", message: "This copy of bot-link is too old for this server (it needs release 9 or newer). Run: botlink update.", details: { min_release: 9, update: "botlink update" } } }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  // longer than any pause in these tests: fetch reuses a kept-alive socket the server would otherwise close under it
  srv.keepAliveTimeout = 120_000;
  for (const p of [PORT_BASE + 4, PORT_BASE + 5]) {
    try {
      await new Promise<void>((ok, bad) => {
        srv.once("error", bad);
        srv.listen(p, "127.0.0.1", () => ok());
      });
      port = p;
      break;
    } catch {
      /* next */
    }
  }
  assert.ok(port, "no free port");
});
after(() => new Promise<void>((ok) => {
  srv.close(() => ok());
  srv.closeAllConnections();
}));

const env = (extra: Record<string, string | undefined> = {}) => ({
  BOTLINK_NO_UPDATE: undefined,
  BOTLINK_DEV: "1",
  BOTLINK_SELF_INSTALL: "1",
  BOTLINK_UPDATE_ORIGIN: `http://127.0.0.1:${port}`,
  BOTLINK_UPDATE_PUBKEY: testPk,
  BOTLINK_UPDATE_EVERY_S: undefined,
  ...extra,
});
const lines = () => updateStatusLines(upd.loadState()).join("\n");
let counter = 10;
const release = (label: string, version: string, o: Partial<typeof served> = {}) => (served = { tgz: tarball(label, version), version, counter: ++counter, ...o });

test("a refused signature is recorded and shown in plain, calm words: nothing installed, don't install by hand from there", async () => {
  await on(newHome("un-sig"), async () => {
    release("ok", "1.0.0");
    assert.equal((await upd.runUpdate({ force: true })).status, "updated");
    release("bad", "1.0.1", { signedBy: otherKey.privateKey });
    assert.equal((await upd.runUpdate({ force: true })).status, "refused");
    const last = upd.loadState().last!;
    assert.equal(last.ok, false);
    assert.equal(last.reason, "signature");
    assert.match(last.from, /^1\.0\.0/);
    assert.ok(last.at > Date.now() - 60_000);
    const t = lines();
    assert.match(t, /did not match bot-link's release key/);
    assert.match(t, /Nothing was installed/);
    assert.match(t, /Do not install bot-link by hand from that address/);
    assert.match(t, /update`/, "the command that fixes it");
    assert.doesNotMatch(t, FRIGHT);
    assert.doesNotMatch(t, /—/);
    assertCopy(t);
  }, env());
});

test("each reason gets its own sentence and fix: no network, no signed release, older release, disk, permission", async () => {
  // no network
  await on(newHome("un-net"), async () => {
    assert.equal((await upd.runUpdate({ force: true })).status, "offline");
    assert.equal(upd.loadState().last?.reason, "network");
    assert.match(lines(), /couldn't reach its server/);
  }, env({ BOTLINK_UPDATE_ORIGIN: `http://127.0.0.1:${PORT_BASE + 9}` }));
  // the server publishes no signed release
  await on(newHome("un-unsigned"), async () => {
    release("u", "1.1.0", { unsigned: true });
    assert.equal((await upd.runUpdate({ force: true })).status, "refused");
    assert.equal(upd.loadState().last?.reason, "unsigned");
    assert.match(lines(), /no signed release/);
    assert.doesNotMatch(lines(), FRIGHT);
  }, env());
  // older than installed
  await on(newHome("un-older"), async () => {
    release("o1", "1.2.0", { counter: 500 });
    assert.equal((await upd.runUpdate({ force: true })).status, "updated");
    release("o2", "1.1.9", { counter: 400 });
    assert.equal((await upd.runUpdate({ force: true })).status, "refused");
    assert.equal(upd.loadState().last?.reason, "older");
    assert.match(lines(), /older than the one installed/);
  }, env());
  // the disk is full (npm says so while installing the dependencies)
  const hd = newHome("un-disk");
  const npm = join(hd, "npm-full.sh");
  writeFileSync(npm, `#!/bin/sh\necho "npm ERR! code ENOSPC" >&2\necho "npm ERR! nospc ENOSPC: no space left on device, write" >&2\nexit 1\n`);
  chmodSync(npm, 0o755);
  await on(hd, async () => {
    served = { tgz: tarball("d", "1.3.0", { deps: { leftpad: "9.9.9" } }), version: "1.3.0", counter: ++counter };
    const r = await upd.runUpdate({ force: true });
    assert.notEqual(r.status, "updated");
    assert.equal(upd.loadState().last?.reason, "disk");
    assert.match(lines(), /disk is full/);
  }, env({ BOTLINK_NPM: npm }));
  // bot-link may not write its own folder (made by another user, e.g. with sudo)
  const hp = newHome("un-perm");
  await on(hp, async () => {
    mkdirSync(upd.clientDir(), { recursive: true });
    writeFileSync(join(upd.clientDir(), "update.json"), "{}\n");
    chmodSync(upd.clientDir(), 0o500);
    try {
      release("p", "1.4.0");
      const r = await upd.runUpdate({ force: true });
      assert.equal(r.status, "failed", JSON.stringify(r));
    } finally {
      chmodSync(upd.clientDir(), 0o700);
    }
    // the record could not be written into the read-only folder; the text still comes from the result next time
  }, env());
});

test("a permission failure is recorded when the state file can still be written", async () => {
  const hp = newHome("un-perm2");
  await on(hp, async () => {
    release("p2", "1.5.0");
    mkdirSync(upd.clientDir(), { recursive: true });
    // a stale download folder bot-link can't write into stands where the unpack goes: EACCES while unpacking
    const r0 = await upd.runUpdate({ force: true });
    assert.equal(r0.status, "updated");
    release("p3", "1.5.1");
    const dst = join(upd.clientDir(), `1.5.1-${sha(served.tgz).slice(0, 12)}`);
    mkdirSync(join(dst, "x"), { recursive: true });
    chmodSync(dst, 0o500);
    try {
      const r = await upd.runUpdate({ force: true });
      assert.equal(r.status, "failed", JSON.stringify(r));
      assert.equal(upd.loadState().last?.reason, "permission");
      assert.match(lines(), /may not write to/);
      assert.match(lines(), /chown/);
    } finally {
      chmodSync(dst, 0o700);
    }
  }, env());
});

test("the next good update clears the failure; a failure is not retried before the 6 h throttle", async () => {
  await on(newHome("un-clear"), async () => {
    release("c1", "2.0.0", { signedBy: otherKey.privateKey });
    assert.equal((await upd.runUpdate({ force: true })).status, "refused");
    assert.match(lines(), /did not match/);
    // no tight loop: the background check (not forced) waits for the throttle, and nothing is fetched
    const before = hits.manifest;
    assert.deepEqual(await upd.runUpdate(), { status: "skipped", why: "checked recently" });
    assert.equal(upd.due(), false);
    assert.equal(upd.maybeSpawnCheck(), false);
    assert.equal(hits.manifest, before);
    // a good release
    release("c2", "2.0.1");
    assert.equal((await upd.runUpdate({ force: true })).status, "updated");
    const s = upd.loadState();
    assert.equal(s.last?.ok, true);
    assert.equal(s.error, undefined);
    assert.doesNotMatch(lines(), /did not match|couldn't/);
    assert.match(lines(), /2\.0\.1/);
  }, env());
});

test("botlink status shows the last failed update and the command that fixes it", async () => {
  const home = newHome("un-status");
  await on(home, async () => {
    release("st", "3.0.0", { signedBy: otherKey.privateKey });
    assert.equal((await upd.runUpdate({ force: true })).status, "refused");
  }, env());
  const r = spawnSync(process.execPath, [join(ROOT, "dist", "cli.js"), "status"], { encoding: "utf-8", env: { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_NO_UPDATE: "1" }, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /did not match bot-link's release key/);
  assert.match(r.stdout, /update`/);
});

test("a chat is told once per process, in the next tool result (not for a short network outage)", async () => {
  await on(newHome("un-mcp"), async () => {
    upd.resetToldForTests();
    release("m1", "4.0.0");
    const r1 = await upd.runUpdate({ force: true });
    assert.equal(r1.status, "updated", JSON.stringify(r1));
    upd.restartNotice("Claude Code"); // "bot-link updated …, restart": once
    assert.equal(upd.restartNotice("Claude Code"), null, "all good: nothing more to say");
    release("m2", "4.0.1", { signedBy: otherKey.privateKey });
    await upd.runUpdate({ force: true });
    const n = upd.restartNotice("Claude Code");
    assert.match(n || "", /did not match bot-link's release key/);
    assertCopy(n!);
    assert.equal(upd.restartNotice("Claude Code"), null, "once");
  }, env());
  await on(newHome("un-mcp-net"), async () => {
    upd.resetToldForTests();
    release("m3", "4.1.0");
    assert.equal((await upd.runUpdate({ force: true })).status, "updated");
    upd.restartNotice("Claude Code");
    process.env.BOTLINK_UPDATE_ORIGIN = `http://127.0.0.1:${PORT_BASE + 9}`;
    assert.equal((await upd.runUpdate({ force: true })).status, "offline");
    assert.equal(upd.restartNotice("Claude Code"), null, "a network failure right after a good check is not news");
  }, env());
});

test("426 client_too_old: one clear sentence, one signed self-update attempt, no retry, no loop", async () => {
  const home = newHome("un-old");
  await on(home, async () => {
    resetTooOldForTests();
    release("t1", "9.0.0");
    const api = new Api(`http://127.0.0.1:${port}`);
    const m0 = hits.manifest, a0 = hits.api;
    let e1: unknown;
    try {
      await api.call({ method: "GET", path: "/api/v1/me", retryForMs: 5000 });
    } catch (e) {
      e1 = e;
    }
    assert.ok(e1 instanceof ClientTooOld, String(e1));
    assert.ok(e1 instanceof HostError, "shown as is by core.explain");
    assert.equal(hits.api - a0, 1, "a 426 is not retried");
    assert.equal(apiSaw, VERSION, "the client says its version (for logs)");
    assert.equal(apiSawRelease, undefined, "a checkout has no release number and sends none");
    const msg = (e1 as Error).message;
    assert.match(msg, /^This copy of bot-link \([^)]+\) is too old to talk to its server \(it needs release 9 or newer\)\./);
    assert.match(msg, /update`/);
    assert.match(msg, /updating itself now/);
    assert.equal(core.explain(e1), msg);
    assertCopy(msg);
    // the one update attempt runs in the background, through the normal signed path
    for (let i = 0; i < 150 && hits.manifest === m0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(hits.manifest - m0, 1, "one update attempt");
    for (let i = 0; i < 150 && !upd.loadState().last; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(upd.loadState().last?.ok, true, JSON.stringify(upd.loadState()));
    // a second refused call: no second attempt (this process, and the next 30 minutes on this computer)
    const m1 = hits.manifest;
    await assert.rejects(api.call({ method: "GET", path: "/api/v1/me" }), ClientTooOld);
    resetTooOldForTests(); // a new process
    await assert.rejects(api.call({ method: "GET", path: "/api/v1/me" }), ClientTooOld);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(hits.manifest, m1, "no loop");
    assert.match(lines(), /too old to talk to its server/);
  }, env());
});

test("426 where updates are off: the sentence names the command, nothing is started", async () => {
  await on(newHome("un-old-off"), async () => {
    resetTooOldForTests();
    const m0 = hits.manifest;
    const e = await new Api(`http://127.0.0.1:${port}`).call({ method: "GET", path: "/api/v1/me" }).catch((x) => x);
    assert.ok(e instanceof ClientTooOld);
    assert.match(e.message, /too old to talk to its server/);
    assert.match(e.message, /update`/);
    assert.doesNotMatch(e.message, /updating itself now/);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(hits.manifest, m0);
  }, env({ BOTLINK_NO_UPDATE: "1" }));
});

test("an older client (no 426 handling) shows the server's own sentence, quoted, and does not retry it", () => {
  const msg = "This copy of bot-link is too old for this server (it needs release 9 or newer). Run: botlink update. Or run the install command from the invite page again. Then restart the app it runs in.";
  const t = core.explain(new ApiError(426, "client_too_old", msg));
  assert.match(t, /too old for this server/);
  assert.match(t, /botlink update/);
});

test("the client sends the release number of the copy that runs (its install's .counter), none without one", async () => {
  // an install made by a signed update carries the release it came from; the running copy says that number
  const home = newHome("un-rel");
  await on(home, async () => {
    release("r1", "1.0.0-dev");
    const r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "updated", JSON.stringify(r));
    assert.equal(upd.installCounter((r as any).dir), counter, "the install keeps its release number");
    assert.equal(upd.releaseOf((r as any).dir), counter);
    assert.equal(upd.releaseOf(join(home, "nowhere")), 0, "no install: no number");
    // this test process runs from a checkout: no number, so no header (see the 426 test above)
    assert.equal(upd.runningRelease(), 0);
    upd.setRunningReleaseForTests(counter);
    try {
      resetTooOldForTests();
      process.env.BOTLINK_NO_UPDATE = "1"; // no background update from this call (on() puts it back)
      const e = await new Api(`http://127.0.0.1:${port}`).call({ method: "GET", path: "/api/v1/me" }).catch((x) => x);
      assert.ok(e instanceof ClientTooOld);
      assert.equal(apiSawRelease, String(counter), "the release number goes with every agent API call");
      assert.equal(apiSaw, VERSION);
      assert.match(e.message, new RegExp(`^This copy of bot-link \\(\\S+, release ${counter}\\) is too old to talk to its server \\(it needs release 9 or newer\\)`));
    } finally {
      upd.setRunningReleaseForTests(null);
    }
  }, env({ BOTLINK_NO_UPDATE: undefined }));
});
