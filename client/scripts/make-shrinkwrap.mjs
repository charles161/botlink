#!/usr/bin/env node
/**
 * Write npm-shrinkwrap.json from package-lock.json for the tarball (npm puts a shrinkwrap in every pack; a
 * package-lock.json is never packed). Production dependencies only, each at the lockfile's version with its registry
 * address and integrity hash: whoever installs the tarball (npx from the server's address, npm, the self-updater)
 * gets exactly these bytes, not whatever a version range resolves to that day.
 *
 *   node scripts/make-shrinkwrap.mjs            write it (package.json "prepack")
 *   node scripts/make-shrinkwrap.mjs --remove   take it away again ("postpack": in the folder, npm would prefer it
 *                                               to package-lock.json)
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "npm-shrinkwrap.json");
if (process.argv.includes("--remove")) {
  rmSync(out, { force: true });
  process.exit(0);
}
const fail = (why) => {
  console.error(`make-shrinkwrap: ${why}`);
  process.exit(1);
};
const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf-8"));
if (lock.lockfileVersion !== 3) fail(`package-lock.json is lockfileVersion ${lock.lockfileVersion}; this script reads version 3`);
const packages = {};
for (const [path, p] of Object.entries(lock.packages)) {
  if (path === "") {
    const { devDependencies, ...rest } = p;
    packages[""] = { ...rest, name: pj.name, version: pj.version, dependencies: pj.dependencies };
    continue;
  }
  if (p.dev) continue; // development only: never installed with the client
  if (!p.link && !(typeof p.integrity === "string" && /^sha512-/.test(p.integrity) && /^https:\/\/registry\.npmjs\.org\//.test(p.resolved || ""))) fail(`${path} has no registry address or integrity hash in package-lock.json`);
  packages[path] = p;
}
for (const [name, v] of Object.entries(pj.dependencies || {})) {
  if (!/^\d+\.\d+\.\d+$/.test(v)) fail(`dependency ${name} is ${JSON.stringify(v)}: name one exact version`);
  if (packages[`node_modules/${name}`]?.version !== v) fail(`package-lock.json has ${name} at ${packages[`node_modules/${name}`]?.version}, package.json says ${v}: run npm install`);
}
writeFileSync(out, JSON.stringify({ name: pj.name, version: pj.version, lockfileVersion: 3, requires: true, packages }, null, 2) + "\n");
