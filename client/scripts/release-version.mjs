#!/usr/bin/env node
/**
 * Every client release has its own version (incident 21 Nov 2026: the client changed, its version stayed 1.0.0, and a
 * chat kept running the old copy from npx's cache with nothing to tell it apart). release-fingerprint.json records
 * the version that was released last and a fingerprint of the files the client is built and shipped from; this
 * script refuses a tree whose files changed while the version did not.
 *
 *   node scripts/release-version.mjs check           exit 1 when the client changed since the recorded release
 *   node scripts/release-version.mjs bump [x.y.z]    next patch version (or x.y.z) in package.json, package-lock.json
 *                                                    and the README's pinned lines, then record it   (npm run release:bump)
 *   node scripts/release-version.mjs record          record package.json's version; refused while it is the recorded
 *                                                    version and the files differ (a changed client needs a new version)
 *   all take --root <client dir> (tests)
 *
 * The fingerprint covers what decides the shipped bytes: src/**, package.json, package-lock.json, tsconfig.json,
 * README.md, LICENSE and scripts/make-shrinkwrap.mjs. deploy/lib/build.sh checks the same rule on the built tarball
 * against the release that is live before it switches anything.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const rootArg = args.includes("--root") ? args[args.indexOf("--root") + 1] : null;
const root = resolve(rootArg || join(dirname(fileURLToPath(import.meta.url)), ".."));
const cmd = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--root") || "check";
const RECORD = join(root, "release-fingerprint.json");
const BUMP_CMD = "cd client && npm run release:bump";

const die = (msg) => {
  console.error(`release-version: ${msg}`);
  process.exit(1);
};

function files() {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.isFile()) out.push(p);
    }
  };
  walk(join(root, "src"));
  for (const f of ["package.json", "package-lock.json", "tsconfig.json", "README.md", "LICENSE", join("scripts", "make-shrinkwrap.mjs")]) {
    if (existsSync(join(root, f))) out.push(join(root, f));
  }
  return out.map((p) => relative(root, p).split(sep).join("/")).sort();
}

function fingerprint() {
  const h = createHash("sha256");
  for (const f of files()) h.update(`${f}\0${createHash("sha256").update(readFileSync(join(root, f))).digest("hex")}\n`);
  return h.digest("hex");
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));
const version = () => String(readJson(join(root, "package.json")).version || "");
const recorded = () => {
  try {
    return readJson(RECORD);
  } catch {
    return null;
  }
};
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function write(v) {
  writeFileSync(RECORD, JSON.stringify({ about: "the client version released last and a fingerprint of its files (scripts/release-version.mjs); a changed client needs a new version: " + BUMP_CMD, version: v, fingerprint: fingerprint() }, null, 2) + "\n");
}

function check() {
  const r = recorded();
  const v = version();
  if (!r) return `no release-fingerprint.json: run \`${BUMP_CMD}\``;
  const fp = fingerprint();
  if (r.fingerprint === fp && r.version === v) return null;
  if (r.version === v) return `client changed since ${v} was released: bump the version in package.json and run \`${BUMP_CMD}\` (it bumps the patch version, updates the pinned README lines and records the new fingerprint)`;
  return `client version is ${v} but release-fingerprint.json records ${r.version}: run \`${BUMP_CMD}\` (or, with package.json already at the version you want, \`npm run release:record\`)`;
}

function record() {
  const r = recorded();
  const v = version();
  if (!SEMVER.test(v)) die(`version ${JSON.stringify(v)} is not a release (x.y.z)`);
  if (r && r.version === v && r.fingerprint !== fingerprint()) die(`the client changed since ${v} was released; a changed client needs a new version: run \`${BUMP_CMD}\``);
  if (r && SEMVER.test(r.version) && cmpSemver(v, r.version) < 0) die(`version ${v} is below the recorded release ${r.version}`);
  write(v);
  console.log(`recorded client ${v}`);
}

function cmpSemver(a, b) {
  const x = a.match(SEMVER).slice(1).map(Number), y = b.match(SEMVER).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function bump(to) {
  const pjPath = join(root, "package.json");
  const pj = readJson(pjPath);
  const old = String(pj.version);
  const m = old.match(SEMVER);
  if (!m) die(`package.json version ${JSON.stringify(old)} is not x.y.z`);
  const next = to || `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
  if (!SEMVER.test(next)) die(`${JSON.stringify(next)} is not x.y.z`);
  if (cmpSemver(next, old) <= 0) die(`${next} is not above ${old}`);
  const r = recorded();
  if (r && SEMVER.test(r.version) && cmpSemver(next, r.version) <= 0) die(`${next} is not above the recorded release ${r.version}`);
  const setVersion = (path, edit) => {
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf-8");
    writeFileSync(path, edit(text));
  };
  // only the package's own "version" lines: the first one in package.json, the root ones in package-lock.json
  setVersion(pjPath, (t) => t.replace(/^(  "version": )"[^"]*"/m, `$1"${next}"`));
  setVersion(join(root, "package-lock.json"), (t) => {
    const lock = JSON.parse(t);
    lock.version = next;
    if (lock.packages?.[""]) lock.packages[""].version = next;
    return JSON.stringify(lock, null, 2) + "\n";
  });
  setVersion(join(root, "README.md"), (t) => t.split(`@botlink/cli@${old}`).join(`@botlink/cli@${next}`));
  if (version() !== next) die("could not set the version in package.json");
  write(next);
  console.log(`client ${old} -> ${next}; recorded. Commit client/package.json, client/package-lock.json, client/README.md and client/release-fingerprint.json.`);
}

switch (cmd) {
  case "check": {
    const bad = check();
    if (bad) die(bad);
    console.log(`client ${version()}: unchanged since it was recorded`);
    break;
  }
  case "record":
    record();
    break;
  case "bump":
    bump(args.find((a, i) => SEMVER.test(a) && args[i - 1] !== "--root"));
    break;
  default:
    die("usage: release-version.mjs check | bump [x.y.z] | record   [--root <client dir>]");
}
