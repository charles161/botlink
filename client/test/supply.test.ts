/**
 * Supply chain: the client's dependencies are the same bytes for everyone. The tarball (the one the server hands
 * out, and @botlink/cli on npm) ships npm-shrinkwrap.json: every production dependency at one version with its
 * integrity hash. package.json names exact versions too, and the updater installs with `npm ci` when a lock is there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pj = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf-8"));

test("package.json names exact versions of its dependencies, the ones the lockfile has", () => {
  for (const [name, range] of Object.entries(pj.dependencies as Record<string, string>)) {
    assert.match(range, /^\d+\.\d+\.\d+$/, `${name}: ${range} is a range, not one version`);
    assert.equal(lock.packages[`node_modules/${name}`].version, range, name);
  }
});

test("the tarball carries npm-shrinkwrap.json: production dependencies only, each pinned with its integrity hash", () => {
  const work = mkdtempSync(join(tmpdir(), "bl-supply-"));
  try {
    // what `npm pack` runs before it packs (package.json prepack), without the rebuild
    assert.match(pj.scripts.prepack, /node scripts\/make-shrinkwrap\.mjs/);
    assert.match(pj.scripts.postpack, /node scripts\/make-shrinkwrap\.mjs --remove/);
    execFileSync(process.execPath, [join(ROOT, "scripts", "make-shrinkwrap.mjs")], { cwd: ROOT });
    let tgz: string;
    try {
      tgz = execFileSync("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", work], { cwd: ROOT, encoding: "utf-8" }).trim().split("\n").pop()!;
    } finally {
      execFileSync(process.execPath, [join(ROOT, "scripts", "make-shrinkwrap.mjs"), "--remove"], { cwd: ROOT });
    }
    assert.ok(!existsSync(join(ROOT, "npm-shrinkwrap.json")), "the generated file is not left in the folder (npm ci would prefer it)");
    const names = execFileSync("tar", ["-tzf", join(work, tgz)], { encoding: "utf-8" }).split("\n");
    assert.ok(names.includes("package/npm-shrinkwrap.json"), names.join(" "));
    const sw = JSON.parse(execFileSync("tar", ["-xzOf", join(work, tgz), "package/npm-shrinkwrap.json"], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }));
    assert.equal(sw.lockfileVersion, 3);
    assert.equal(sw.packages[""].devDependencies, undefined);
    assert.deepEqual(sw.packages[""].dependencies, pj.dependencies);
    const deps = Object.entries(sw.packages as Record<string, any>).filter(([k]) => k !== "");
    assert.ok(deps.length > 20, `only ${deps.length} packages`);
    for (const [k, p] of deps) {
      assert.ok(!p.dev, `${k} is a development dependency`);
      assert.match(p.version, /^\d+\.\d+\.\d+/, k);
      assert.match(p.resolved, /^https:\/\/registry\.npmjs\.org\//, `${k} does not come from the npm registry`);
      assert.match(p.integrity, /^sha512-/, `${k} has no integrity hash`);
    }
    // exactly the production packages of the lockfile, at the same versions
    const want = Object.entries(lock.packages as Record<string, any>).filter(([k, p]) => k !== "" && !p.dev).map(([k, p]) => `${k}@${p.version}`).sort();
    assert.deepEqual(deps.map(([k, p]) => `${k}@${p.version}`).sort(), want);
    for (const d of Object.keys(pj.dependencies)) assert.ok(sw.packages[`node_modules/${d}`], d);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the npm package (@botlink/cli) keeps the lock under its own name; the updater installs from a lock with `npm ci`", () => {
  const packNpm = readFileSync(join(ROOT, "scripts", "pack-npm.mjs"), "utf-8");
  assert.match(packNpm, /npm-shrinkwrap\.json/, "pack-npm renames the package inside the lock too");
  const update = readFileSync(join(ROOT, "src", "update.ts"), "utf-8");
  assert.match(update, /npm-shrinkwrap\.json/);
  assert.match(update, /\["ci", "--omit=dev", "--ignore-scripts"/);
});
