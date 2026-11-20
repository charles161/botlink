/**
 * The npm line. `@botlink/cli` is published from 1.0.0 on (20 Nov 2026): the client README names it, pinned to the
 * package's version; the invite text and agent docs still name the server's address. And the package itself: the right
 * fields, and a packed listing with no tests, sources, keys or secrets (PUBLISHING.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASE_KEYS } from "../src/release.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(ROOT, "..");
const pj = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const FROM_NPM = /npx\s+(-y\s+)?@botlink\/cli|npm\s+(install|i)\s+(-g\s+)?@botlink\/cli|pnpm\s+(add|dlx)\s+@botlink\/cli|yarn\s+(global\s+add|dlx)\s+@botlink\/cli/;

test("the invite text and the agent docs still name the server's address, not npm (moving them is a separate change: NPM-PUBLISH.md)", () => {
  const files = [join(REPO, "docs", "agents.md"), join(REPO, "docs", "llms.txt"), join(REPO, "server", "internal", "pages", "pages.go"), join(REPO, "deploy", "public-repo", "files", "README.md")];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const bad = readFileSync(f, "utf-8").split("\n").filter((l) => FROM_NPM.test(l));
    assert.deepEqual(bad, [], f);
  }
});

// 20 Nov 2026, found before the first publish: this README is the package's page on npmjs.com, and it said the client
// was "not on the npm registry yet" and "don't install @botlink/cli from npm". A published version cannot be changed.
test("the client README (the package's page on npm) names the npm command pinned to this version, and does not say the client is missing from npm", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  assert.doesNotMatch(readme, /not\*{0,2} on the npm registry|holds no client|don't install `@botlink\/cli`/);
  const npmLines = readme.split("\n").filter((l) => FROM_NPM.test(l));
  assert.ok(npmLines.some((l) => / join /.test(l)), "no npm join line in the README");
  // npx caches by spec: an unpinned line would run whatever copy npx fetched first
  for (const l of npmLines) assert.ok(l.includes(`@botlink/cli@${pj.version}`), `not pinned to ${pj.version}: ${l}`);
  // the bare name on npm is someone else's: the warning stays
  assert.match(readme, /Never run a bare `npx botlink`/);
  // the server's own address stays named: it is what an invite page prints
  assert.match(readme, /https:\/\/api\.botlink\.dev\/dl\/botlink\.tgz/);
});

test("package.json is ready to publish: one bin, files allow-list, version from package.json, a guard against a plain npm publish", () => {
  assert.deepEqual(pj.bin, { botlink: "dist/cli.js" });
  assert.deepEqual(pj.files, ["dist", "README.md", "LICENSE", "npm-shrinkwrap.json"]);
  assert.equal(pj.private, undefined);
  assert.match(pj.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
  assert.equal(pj.engines.node, ">=20");
  assert.match(pj.scripts.prepublishOnly, /prepublish-check/);
  assert.match(pj.scripts["pack:npm"], /pack-npm\.mjs/);
});

test("npm pack --dry-run: only the built client, README, LICENSE and package.json; no tests, sources, keys or secrets; sane size", () => {
  assert.ok(existsSync(join(ROOT, "dist", "cli.js")), "build first (npm test does)");
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  const info = JSON.parse(out)[0];
  const paths: string[] = info.files.map((f: { path: string }) => f.path);
  for (const p of paths) assert.match(p, /^(dist\/[\w-]+\.js|README\.md|LICENSE|package\.json|npm-shrinkwrap\.json)$/, `unexpected file in the package: ${p}`);
  for (const must of ["dist/cli.js", "dist/update.js", "dist/release.js", "README.md", "LICENSE", "package.json"]) assert.ok(paths.includes(must), must);
  assert.ok(info.unpackedSize < 3 * 1024 * 1024, `unpacked ${info.unpackedSize} bytes`);
  assert.ok(info.entryCount < 120, `${info.entryCount} files`);
  // no private key material, no test keys: the only key in the package is the pinned public release key
  for (const p of paths.filter((x) => x.startsWith("dist/"))) {
    const t = readFileSync(join(ROOT, p), "utf-8");
    assert.doesNotMatch(t, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, p);
    // allowed 64-hex values: the pinned public release key, and sha256 of the empty string (a constant in crypto.ts)
    const known = new Set([...RELEASE_KEYS.map((k) => k.pk), createHash("sha256").update("").digest("hex")]);
    for (const hex of t.match(/\b[0-9a-f]{64}\b/g) || []) assert.ok(known.has(hex), `${p}: a 64-hex value that is not the pinned release key`);
  }
});

test("PUBLISHING.md: the exact command, what the npm copy does on first run, and the drift risk of two install paths", () => {
  const p = join(ROOT, "PUBLISHING.md");
  assert.ok(existsSync(p), "client/PUBLISHING.md");
  const t = readFileSync(p, "utf-8");
  assert.match(t, /npm run pack:npm/);
  assert.match(t, /npm publish botlink-cli-\S+\.tgz --access public/);
  assert.match(t, /signed/);
  assert.match(t, /drift/i);
  assert.doesNotMatch(t, /—/);
});
