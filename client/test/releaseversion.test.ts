/**
 * Every client release has its own version (incident 21 Nov 2026: prod's client changed while package.json still said
 * 1.0.0, so nothing could tell a chat's cached old copy from the new one). release-fingerprint.json records the
 * version released last and a fingerprint of the client's files; scripts/release-version.mjs refuses a changed client
 * under the same version. This file checks the repo's own client, then the rule in a throwaway copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "release-version.mjs");
const run = (root: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, "--root", root], { encoding: "utf-8" });
  return { code: r.status, out: r.stdout + r.stderr };
};
const pj = (root: string) => JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

test("this client: unchanged since its version was recorded (else: client changed since <v> was released, bump it)", () => {
  const r = run(ROOT, "check");
  assert.equal(r.code, 0, r.out);
  const rec = JSON.parse(readFileSync(join(ROOT, "release-fingerprint.json"), "utf-8"));
  assert.equal(rec.version, pj(ROOT).version);
});

function copy() {
  const d = mkdtempSync(join(process.env.BOTLINK_TEST_BASE!, "relver-"));
  for (const f of ["src", "package.json", "package-lock.json", "tsconfig.json", "README.md", "LICENSE", "release-fingerprint.json"]) cpSync(join(ROOT, f), join(d, f), { recursive: true });
  return d;
}

test("a changed source file under the same version: refused, naming the version and the one command that fixes it", () => {
  const d = copy();
  const v = pj(d).version;
  writeFileSync(join(d, "src", "version.ts"), readFileSync(join(d, "src", "version.ts"), "utf-8") + "\n// changed\n");
  const r = run(d, "check");
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`client changed since ${v.replace(/\./g, "\\.")} was released: bump the version in package\\.json and run \`cd client && npm run release:bump\``));
  // recording the changed files under the released version is refused too: only a new version records them
  const rec = run(d, "record");
  assert.equal(rec.code, 1);
  assert.match(rec.out, /a changed client needs a new version/);
});

test("release:bump: next patch version in package.json, package-lock.json and the README's pinned lines, recorded; then the check passes", () => {
  const d = copy();
  const v = pj(d).version as string;
  const [a, b, c] = v.split(".").map(Number);
  const next = `${a}.${b}.${c + 1}`;
  writeFileSync(join(d, "src", "version.ts"), readFileSync(join(d, "src", "version.ts"), "utf-8") + "\n// changed\n");
  const depsBefore = JSON.stringify(Object.entries(JSON.parse(readFileSync(join(d, "package-lock.json"), "utf-8")).packages).filter(([k]) => k));
  const r = run(d, "bump");
  assert.equal(r.code, 0, r.out);
  assert.equal(pj(d).version, next);
  const lock = JSON.parse(readFileSync(join(d, "package-lock.json"), "utf-8"));
  assert.equal(lock.version, next);
  assert.equal(lock.packages[""].version, next);
  const readme = readFileSync(join(d, "README.md"), "utf-8");
  assert.ok(readme.includes(`@botlink/cli@${next}`));
  assert.ok(!readme.includes(`@botlink/cli@${v}`));
  // only the package's own version moved (a dependency at the same version string is untouched)
  assert.equal(JSON.stringify(Object.entries(lock.packages).filter(([k]) => k)), depsBefore);
  assert.equal(run(d, "check").code, 0);
});

test("a version set by hand but not recorded, or a bump below the recorded release: refused with the command", () => {
  const d = copy();
  const p = pj(d);
  writeFileSync(join(d, "package.json"), JSON.stringify({ ...p, version: "9.9.9" }, null, 2) + "\n");
  const r = run(d, "check");
  assert.equal(r.code, 1);
  assert.match(r.out, /client version is 9\.9\.9 but release-fingerprint\.json records .*npm run release:record/);
  assert.equal(run(d, "record").code, 0);
  assert.equal(run(d, "check").code, 0);
  assert.equal(run(d, "bump", "1.0.0").code, 1);
});
