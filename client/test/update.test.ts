/** Self-update (SPEC §7.6): check the signed /dl/botlink.manifest.json, verify signature + counter + sha256, unpack, swap ~/.botlink/client/current atomically. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as upd from "../src/update.js";
import * as rel from "../src/release.js";
import { staleCliPaths, staleApps, migrateToShim } from "../src/setup.js";
import * as h from "../src/harnesses.js";
import { shellQuote } from "../src/span.js";
import { assertIsolated, newHome, on, PORT_BASE } from "./helpers.js";

before(() => assertIsolated());

/** npm-pack-shaped tarball: package/package.json + package/dist/cli.js (+ extra entries). */
function tarball(label: string, version: string, o: { deps?: Record<string, string>; link?: boolean; name?: string } = {}): Buffer {
  const d = newHome(`tgz-${label}`);
  const pkg = join(d, "package");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: o.name ?? "botlink", version, type: "module", dependencies: o.deps ?? {} }));
  writeFileSync(join(pkg, "dist", "cli.js"), `// bot-link ${version}\n`);
  if (o.link) symlinkSync("/etc/passwd", join(pkg, "dist", "evil"));
  const out = join(d, "b.tgz");
  const r = spawnSync("tar", ["-czf", out, "-C", d, "package"]);
  assert.equal(r.status, 0);
  return readFileSync(out);
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// a throwaway release key: the client trusts it only through the development override (BOTLINK_DEV=1 + BOTLINK_UPDATE_PUBKEY)
const rawPk = (k: KeyObject) => Buffer.from(k.export({ type: "spki", format: "der" })).subarray(12).toString("hex");
const testKey = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519");
const testPk = rawPk(testKey.publicKey);

/** A signed manifest file as deploy/release-sign.mjs writes it. */
function manifestDoc(o: { tgz: Buffer; version: string; counter: number; sha?: string; name?: string; key?: KeyObject; keyId?: string }) {
  const manifest = JSON.stringify({ v: 1, name: o.name ?? "botlink", version: o.version, sha256: o.sha ?? sha(o.tgz), size: o.tgz.length, counter: o.counter, signed_at: Math.floor(Date.now() / 1000) });
  const key = o.key ?? testKey.privateKey;
  const sig = edSign(null, Buffer.from(rel.MANIFEST_DOMAIN + manifest, "utf-8"), key).toString("base64");
  return { manifest, sig, key: o.keyId ?? rel.keyId(testPk) };
}

let srv: Server;
let port = 0;
/** What the fake serves. counter: the release number (default: a new, higher one for every new tarball). */
let served: { tgz: Buffer; sha?: string; version: string; counter?: number; unsigned?: boolean; signedBy?: KeyObject; tamper?: (doc: any) => any } = { tgz: Buffer.alloc(0), version: "" };
let hits = { info: 0, tgz: 0 };
const counters = new Map<string, number>();
let lastCounter = 0;
const counterFor = (s: string) => counters.get(s) ?? (counters.set(s, ++lastCounter), lastCounter);

before(async () => {
  srv = createServer((req, res) => {
    if (req.url === "/dl/botlink.json") {
      // the old, unsigned answer: still served by an older server; a client must never install from it
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: 1, version: served.version, sha256: served.sha ?? sha(served.tgz), size: served.tgz.length, url: `http://127.0.0.1:${port}/dl/botlink.tgz` }));
    } else if (req.url === "/dl/botlink.manifest.json") {
      hits.info++;
      if (served.unsigned) {
        res.writeHead(404);
        res.end();
        return;
      }
      let doc: any = manifestDoc({ tgz: served.tgz, version: served.version, sha: served.sha, counter: served.counter ?? counterFor(served.sha ?? sha(served.tgz)), key: served.signedBy });
      if (served.tamper) doc = served.tamper(doc);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(doc));
    } else if (req.url === "/dl/botlink.tgz") {
      hits.tgz++;
      res.writeHead(200, { "content-type": "application/gzip", "content-length": served.tgz.length });
      res.end(served.tgz);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  for (const p of [PORT_BASE + 3, PORT_BASE + 2]) {
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
  assert.ok(port, `ports ${PORT_BASE + 2}/${PORT_BASE + 3} busy`);
});
after(() => new Promise<void>((ok) => srv.close(() => ok())));

/** A computer: temp HOME, updates on, against the fake, this checkout treated as an installed copy. */
const env = (extra: Record<string, string | undefined> = {}) => ({
  BOTLINK_NO_UPDATE: undefined,
  BOTLINK_DEV: "1",
  BOTLINK_SELF_INSTALL: "1",
  BOTLINK_UPDATE_ORIGIN: `http://127.0.0.1:${port}`,
  BOTLINK_UPDATE_PUBKEY: testPk,
  BOTLINK_UPDATE_EVERY_S: undefined,
  ...extra,
});

test("update: installs what the server serves (sha256 checked), swaps current, then 'up to date' and throttled", async () => {
  const home = newHome("upd");
  served = { tgz: tarball("a", "1.2.3"), version: "1.2.3" };
  await on(home, async () => {
    const r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "updated", JSON.stringify(r));
    const s = sha(served.tgz);
    const dir = join(home, ".botlink", "client", `1.2.3-${s.slice(0, 12)}`);
    assert.equal(readlinkSync(upd.currentDir()), `1.2.3-${s.slice(0, 12)}`, "relative link");
    assert.equal(realpathSync(upd.currentDir()), realpathSync(dir));
    assert.equal(readFileSync(join(upd.currentDir(), "dist", "cli.js"), "utf-8"), "// bot-link 1.2.3\n");
    assert.equal(upd.installSha(dir), s);
    assert.equal(statSync(dir).mode & 0o777, 0o700, "private version dir");
    assert.equal(upd.loadState().installed?.sha256, s);
    assert.equal(upd.shimCli(), join(home, ".botlink", "client", "current", "dist", "cli.js"));
    assert.ok(!readdirSync(join(home, ".botlink", "client")).some((f) => f.startsWith(".dl-") || f.startsWith(".current.")), "no leftovers");
    // same again: nothing to do
    assert.equal((await upd.runUpdate({ force: true })).status, "current");
    // throttled without force (6 h by default), due again with a 0 s period
    const before = hits.info;
    assert.deepEqual(await upd.runUpdate(), { status: "skipped", why: "checked recently" });
    assert.equal(hits.info, before, "no request while throttled");
    assert.equal(upd.due(), false);
    process.env.BOTLINK_UPDATE_EVERY_S = "0";
    assert.equal(upd.due(), true);
    delete process.env.BOTLINK_UPDATE_EVERY_S;
    // a new release: swapped to it, the old dir kept (a running process may still load from it)
    served = { tgz: tarball("b", "1.2.4"), version: "1.2.4" };
    const r2 = await upd.runUpdate({ force: true });
    assert.equal(r2.status, "updated");
    assert.ok(readlinkSync(upd.currentDir()).startsWith("1.2.4-"));
    assert.ok(existsSync(dir), "previous version kept");
  }, env());
});

test("update: a tarball whose sha256 doesn't match what the server published is refused; current stays", async () => {
  const home = newHome("upd-bad");
  await on(home, async () => {
    served = { tgz: tarball("c", "2.0.0"), version: "2.0.0" };
    assert.equal((await upd.runUpdate({ force: true })).status, "updated");
    const was = readlinkSync(upd.currentDir());
    served = { tgz: tarball("d", "2.0.1"), version: "2.0.1", sha: "0".repeat(64) };
    const r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "refused");
    assert.match((r as any).why, /sha256 mismatch/);
    assert.equal(readlinkSync(upd.currentDir()), was, "current unchanged");
    assert.ok(!readdirSync(join(home, ".botlink", "client")).some((f) => f.startsWith("2.0.1") || f.startsWith(".dl-")), "nothing left behind");
    assert.match(upd.loadState().error || "", /refused: sha256 mismatch/);
    // a tarball with a symlink in it, or not bot-link: refused too
    served = { tgz: tarball("e", "2.0.2", { link: true }), version: "2.0.2" };
    assert.match(((await upd.runUpdate({ force: true })) as any).why, /links or special files/);
    served = { tgz: tarball("f", "2.0.3", { name: "evil" }), version: "2.0.3" };
    assert.match(((await upd.runUpdate({ force: true })) as any).why, /not the bot-link client/);
    assert.equal(readlinkSync(upd.currentDir()), was);
  }, env());
});

test("update: only a release signed with the pinned release key is installed (unsigned, wrong key, changed text: refused)", async () => {
  const home = newHome("upd-sig");
  await on(home, async () => {
    served = { tgz: tarball("s1", "5.0.0"), version: "5.0.0" };
    assert.equal((await upd.runUpdate({ force: true })).status, "updated");
    const was = readlinkSync(upd.currentDir());
    const tgzBefore = hits.tgz;
    // a server that publishes no signed manifest (only the old unsigned botlink.json): nothing is installed
    served = { tgz: tarball("s2", "5.0.1"), version: "5.0.1", unsigned: true };
    let r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "refused", JSON.stringify(r));
    assert.match((r as any).why, /not signed/);
    // signed by a key the client does not pin
    served = { tgz: tarball("s3", "5.0.2"), version: "5.0.2", signedBy: otherKey.privateKey };
    r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "refused");
    assert.match((r as any).why, /not from bot-link's release key/);
    // the signed text changed on the way (another tarball's hash put in)
    served = { tgz: tarball("s4", "5.0.3"), version: "5.0.3", tamper: (d) => ({ ...d, manifest: d.manifest.replace(/"sha256":"[0-9a-f]{64}"/, `"sha256":"${"a".repeat(64)}"`) }) };
    r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "refused");
    assert.match((r as any).why, /not from bot-link's release key/);
    // no signature at all
    served = { tgz: tarball("s5", "5.0.4"), version: "5.0.4", tamper: (d) => ({ manifest: d.manifest }) };
    assert.match(((await upd.runUpdate({ force: true })) as any).why, /not signed/);
    assert.equal(hits.tgz, tgzBefore, "a tarball is never downloaded for a release that failed the signature check");
    assert.equal(readlinkSync(upd.currentDir()), was, "current unchanged");
    assert.match(upd.loadState().error || "", /^refused:/);
  }, env());
  // the development key override counts only with BOTLINK_DEV=1: an install never trusts a key from its environment
  await on(newHome("upd-sig-nodev"), async () => {
    assert.deepEqual(rel.releaseKeys(), rel.RELEASE_KEYS);
  }, env({ BOTLINK_DEV: undefined }));
  await on(newHome("upd-sig-dev"), async () => {
    assert.deepEqual(rel.releaseKeys().map((k) => k.pk), [testPk]);
  }, env());
});

test("update: an older signed release is refused (no rollback), and so is a second release with the same number", async () => {
  const home = newHome("upd-rollback");
  await on(home, async () => {
    const old = tarball("r1", "6.0.0");
    served = { tgz: old, version: "6.0.0", counter: 100 };
    assert.equal((await upd.runUpdate({ force: true })).status, "updated");
    served = { tgz: tarball("r2", "6.0.1"), version: "6.0.1", counter: 101 };
    assert.equal((await upd.runUpdate({ force: true })).status, "updated");
    const was = readlinkSync(upd.currentDir());
    assert.equal(upd.loadState().counter, 101);
    // the server (or whoever sits in front of it) replays the older release, validly signed
    served = { tgz: old, version: "6.0.0", counter: 100 };
    let r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "refused", JSON.stringify(r));
    assert.match((r as any).why, /older than the one this computer already has/);
    assert.equal(readlinkSync(upd.currentDir()), was, "current unchanged");
    // another tarball under the number already taken
    served = { tgz: tarball("r3", "6.0.2"), version: "6.0.2", counter: 101 };
    r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "refused");
    assert.match((r as any).why, /same release number/);
    assert.equal(readlinkSync(upd.currentDir()), was);
    // the update state file is lost: the installed copy still remembers its number
    rmSync(join(upd.clientDir(), "update.json"));
    served = { tgz: old, version: "6.0.0", counter: 100 };
    r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "refused");
    assert.equal(readlinkSync(upd.currentDir()), was);
    // a newer one goes through
    served = { tgz: tarball("r4", "6.0.3"), version: "6.0.3", counter: 102 };
    assert.equal((await upd.runUpdate({ force: true })).status, "updated");
  }, env());
});

test("update: the signed manifest must describe the tarball that arrives (size, name and version too)", async () => {
  await on(newHome("upd-bind"), async () => {
    const a = tarball("b1", "7.0.0");
    // signed for another package version than the tarball holds
    served = { tgz: a, version: "7.9.9" };
    const r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "refused", JSON.stringify(r));
    assert.match((r as any).why, /not the release that was signed/);
    assert.ok(!existsSync(upd.currentDir()));
  }, env());
});

test("update: a plain-http origin is refused unless it is this computer in development", async () => {
  await on(newHome("upd-http"), async () => {
    assert.equal(upd.updateBlocked(), "the update address is not https");
  }, env({ BOTLINK_UPDATE_ORIGIN: "http://updates.example.test" }));
});

test("update: off switch, local server, checkout, busy lock and offline all leave things alone, quietly", async () => {
  const home = newHome("upd-off");
  served = { tgz: tarball("g", "3.0.0"), version: "3.0.0" };
  await on(home, async () => assert.deepEqual(await upd.runUpdate({ force: true }), { status: "skipped", why: "BOTLINK_NO_UPDATE=1" }), env({ BOTLINK_NO_UPDATE: "1" }));
  await on(home, async () => assert.deepEqual(await upd.runUpdate({ force: true }), { status: "skipped", why: "local server" }), env({ BOTLINK_DEV: undefined }));
  await on(home, async () => assert.deepEqual(await upd.runUpdate({ force: true }), { status: "skipped", why: "running from a checkout" }), env({ BOTLINK_SELF_INSTALL: undefined }));
  await on(home, async () => {
    mkdirSync(upd.clientDir(), { recursive: true });
    writeFileSync(join(upd.clientDir(), "update.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    assert.deepEqual(await upd.runUpdate({ force: true }), { status: "busy" });
    // a lock whose process is gone is stale: taken over
    writeFileSync(join(upd.clientDir(), "update.lock"), JSON.stringify({ pid: 999999, at: Date.now() }));
    assert.equal((await upd.runUpdate({ force: true })).status, "updated");
    assert.ok(!existsSync(join(upd.clientDir(), "update.lock")), "lock released");
  }, env());
  await on(newHome("upd-offline"), async () => {
    const r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "offline");
    assert.ok(!existsSync(upd.currentDir()));
    assert.match(upd.loadState().error || "", /^check:/);
  }, env({ BOTLINK_UPDATE_ORIGIN: `http://127.0.0.1:${PORT_BASE + 9}` }));
});

test("update: dependencies that differ from every copy here are installed with npm (production only)", async () => {
  const home = newHome("upd-deps");
  const npmLog = join(home, "npm.log");
  const fakeNpm = join(home, "fake-npm.sh");
  writeFileSync(fakeNpm, `#!/bin/sh\necho "$@" > ${JSON.stringify(npmLog)}\nmkdir -p node_modules/leftpad && echo ok > node_modules/leftpad/index.js\n`);
  chmodSync(fakeNpm, 0o755);
  served = { tgz: tarball("h", "4.0.0", { deps: { leftpad: "9.9.9" } }), version: "4.0.0" };
  await on(home, async () => {
    const r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "updated", JSON.stringify(r));
    assert.match(readFileSync(npmLog, "utf-8"), /install --omit=dev --ignore-scripts/);
    assert.ok(existsSync(join(upd.currentDir(), "node_modules", "leftpad", "index.js")));
  }, env({ BOTLINK_NPM: fakeNpm }));
  // npm fails: nothing installed, current unchanged, reported as "try later"
  const home2 = newHome("upd-npmfail");
  served = { tgz: tarball("i", "4.0.1", { deps: { leftpad: "9.9.9" } }), version: "4.0.1" };
  await on(home2, async () => {
    const r = await upd.runUpdate({ force: true });
    assert.equal(r.status, "offline");
    assert.ok(!existsSync(upd.currentDir()));
  }, env({ BOTLINK_NPM: "/bin/false" }));
});

test("update: swapping current is atomic (a reader in another process never sees it missing)", async () => {
  const home = newHome("upd-swap");
  await on(home, async () => {
    const cd = upd.clientDir();
    for (const v of ["a", "b"]) mkdirSync(join(cd, v, "dist"), { recursive: true }), writeFileSync(join(cd, v, "dist", "cli.js"), v);
    upd.swapCurrent(join(cd, "a"));
    const reader = spawn(process.execPath, ["-e", `const fs=require("fs");let miss=0,n=0;const end=Date.now()+1500;while(Date.now()<end){n++;try{fs.readFileSync(${JSON.stringify(join(cd, "current", "dist", "cli.js"))})}catch{miss++}}console.log(JSON.stringify({miss,n}))`], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    reader.stdout.on("data", (d) => (out += d));
    const done = new Promise((ok) => reader.on("exit", ok));
    const end = Date.now() + 1200;
    let swaps = 0;
    while (Date.now() < end) {
      upd.swapCurrent(join(cd, swaps % 2 ? "a" : "b"));
      swaps++;
      if (swaps % 50 === 0) await new Promise((r) => setImmediate(r));
    }
    await done;
    const { miss, n } = JSON.parse(out);
    assert.ok(swaps > 100 && n > 100, `swaps ${swaps}, reads ${n}`);
    assert.equal(miss, 0, "current was never missing");
  });
});

test("update: a swap keeps the old link itself under a second name until the next swap (ext4 frees it under a walk otherwise)", async () => {
  const home = newHome("upd-swap-prev");
  await on(home, async () => {
    const cd = upd.clientDir();
    const prev = join(cd, ".previous-current");
    for (const v of ["a", "b"]) mkdirSync(join(cd, v, "dist"), { recursive: true });
    upd.swapCurrent(join(cd, "a"));
    assert.ok(!existsSync(prev), "nothing to keep on the first swap");
    const ino = lstatSync(upd.currentDir()).ino;
    upd.swapCurrent(join(cd, "b"));
    assert.ok(lstatSync(prev).isSymbolicLink(), "the link itself, not the directory it points at");
    assert.equal(lstatSync(prev).ino, ino, "the same link `current` was, not a copy");
    assert.equal(readlinkSync(prev), "a");
    upd.swapCurrent(join(cd, "a"));
    assert.equal(readlinkSync(prev), "b", "only the one before");
    assert.equal(readlinkSync(upd.currentDir()), "a");
  });
});

test("restart notice: once per process, only when current differs from the running copy", async () => {
  const home = newHome("upd-notice");
  served = { tgz: tarball("j", "5.0.0"), version: "5.0.0" };
  await on(home, async () => {
    upd.resetToldForTests();
    assert.equal(upd.restartNotice("Claude Code"), null, "no current yet");
    await upd.runUpdate({ force: true });
    const n = upd.restartNotice("Claude Code");
    assert.match(n || "", /^bot-link updated to 5\.0\.0 \([0-9a-f]{8}\)\. Tell your human: "bot-link updated, restart Claude Code to apply\."/);
    assert.equal(upd.restartNotice("Claude Code"), null, "once");
  }, env());
  upd.resetToldForTests();
  await on(home, async () => assert.equal(upd.restartNotice("Codex"), null, "a checkout never says it"), env({ BOTLINK_SELF_INSTALL: undefined }));
});

test("configs launch the stable shim: up writes ~/.botlink/client/current; an npx-cache install is migrated", async () => {
  const home = newHome("upd-shim");
  served = { tgz: tarball("k", "1.5.0"), version: "1.5.0" };
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({}));
  await on(home, async () => {
    assert.equal((await upd.runUpdate({ force: true })).status, "updated");
    const shim = upd.shimCli();
    assert.equal(h.cliPath(), shim, "an installed copy launches through current");
    // an install made by an old client from the npx cache
    const npx = join(home, ".npm", "_npx", "0123abcd", "node_modules", "botlink");
    mkdirSync(join(npx, "dist"), { recursive: true });
    writeFileSync(join(npx, "package.json"), JSON.stringify({ name: "botlink", version: "1.0.0-dev" }));
    writeFileSync(join(npx, "dist", "cli.js"), "//");
    const old = join(npx, "dist", "cli.js");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { botlink: { type: "stdio", command: process.execPath, args: [old, "mcp", "--app", "claude-code"], env: {} } } }, null, 2));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(old)} hook claude-code session-start` }] }] } }, null, 2));
    assert.deepEqual(staleCliPaths(readFileSync(join(home, ".claude.json"), "utf-8")), [old]);
    assert.deepEqual(staleCliPaths(JSON.stringify({ args: [shim] })), [], "the shim itself is not stale");
    assert.deepEqual(staleCliPaths(JSON.stringify({ args: ["/src/botlink/client/dist/cli.js"] })), [], "a checkout is left alone");
    assert.deepEqual(staleCliPaths(`'node' '${join(home, ".botlink", "app", "dist", "cli.js")}' hook codex stop`), [join(home, ".botlink", "app", "dist", "cli.js")], "the old ~/.botlink/app copy");
    assert.deepEqual(staleApps(), ["claude-code"]);
    const lines = migrateToShim();
    assert.ok(lines.length, "setup ran");
    const cj = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
    assert.equal(cj.mcpServers.botlink.args[0], shim);
    const cs = readFileSync(join(home, ".claude", "settings.json"), "utf-8");
    assert.ok(!cs.includes(old), "old hook command replaced, not duplicated");
    assert.ok(cs.includes(shim));
    assert.deepEqual(staleApps(), [], "nothing left to migrate");
    assert.deepEqual(migrateToShim(), [], "idempotent");
  }, env({ CLAUDE_CONFIG_DIR: undefined }));
});
