// npm 12 (21 Nov 2026) refuses `npx -y <tarball URL>` unless the command allows it: `allow-remote` defaults to "none"
// and the run ends with EALLOWREMOTE. Every command bot-link printed or documented was that form, so all of them
// failed for a user on npm 12. `--allow-remote=all` fixes it and changes nothing on npm 8 to 11
// (scripts/npm-matrix.mjs; its runs are in scripts/npm-matrix-results/); it must stand before the URL, since npx hands
// everything after the package to the client. One function writes the prefix on each side (client npxRun, server
// clientcmd.Npx); this test fails on any other way of writing it in what bot-link prints or documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NPX_URL_FLAG, npxRun } from "../src/version.js";

const REPO = join(import.meta.dirname, "..", "..");

test("npxRun: a tarball URL gets --allow-remote=all before it; a file or a registry name gets nothing", () => {
  assert.equal(NPX_URL_FLAG, "--allow-remote=all");
  assert.equal(npxRun("https://api.botlink.dev/dl/botlink-0123456789abcdef.tgz"), "npx -y --allow-remote=all https://api.botlink.dev/dl/botlink-0123456789abcdef.tgz");
  assert.equal(npxRun("http://127.0.0.1:8811/dl/botlink.tgz"), "npx -y --allow-remote=all http://127.0.0.1:8811/dl/botlink.tgz");
  assert.equal(npxRun("@botlink/cli@1.0.1"), "npx -y @botlink/cli@1.0.1");
  assert.equal(npxRun("file:/tmp/botlink.tgz"), "npx -y file:/tmp/botlink.tgz");
});

/** Records of what was printed at the time (changelogs, eval transcripts, evidence): history, not instructions. */
const HISTORY = [/^client\/scripts\/npm-matrix-results\//, /^evals\/(results|runs|legacy)\//, /^evals\/RESULTS\.md$/, /^realworld-evidence\//, /^(CONTRACT-CHANGES|RELEASE-NOTES|REAL-WORLD-TEST|NPM-PUBLISH)\.md$/];
/** Tests assert on the output; the fake server mirrors the real one's words, so it is checked like product code. */
const TESTS = [/\.test\.(ts|mjs|sh)$/, /_test\.go$/, /^client\/test\/fixtures\//];
/** The two functions that write the prefix. */
const BUILDERS = new Set(["client/src/version.ts", "server/internal/clientcmd/clientcmd.go"]);
/** `npx -y` (or `--yes`) followed by a URL, a placeholder or a template, without the flag in front of it. */
const BAD = /npx (?:-y|--yes) (?!--allow-remote=all\b)(?:https?:|\$\{|%|\{\{|"|'|<|\$)/;
/** `npx <URL>` with no -y at all: it would also ask before installing. */
const BARE_URL = /npx (?:https?:|<[^>]*(?:url|URL|origin|ORIGIN))/;

test("every `npx -y <url>` bot-link prints or documents carries --allow-remote=all before the URL (npm 12)", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf-8" }).split("\0").filter(Boolean);
  assert.ok(files.length > 100, "git ls-files listed the repo");
  const bad: string[] = [];
  for (const f of files) {
    if (HISTORY.some((r) => r.test(f)) || TESTS.some((r) => r.test(f)) || BUILDERS.has(f)) continue;
    if (/\.(png|jpe?g|gif|ico|woff2?|ttf|tgz|gz|zip|pdf|webp|mp4)$/.test(f)) continue;
    let text: string;
    try {
      text = readFileSync(join(REPO, f), "utf-8");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      if (BAD.test(line) || BARE_URL.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  assert.deepEqual(
    bad,
    [],
    "write the command with npxRun(<spec>) (client/src/version.ts) or clientcmd.Npx(<url>) (server/internal/clientcmd), and in a doc as " +
      "`npx -y --allow-remote=all <url>`: npm 12 refuses a tarball URL without it (EALLOWREMOTE), and the flag must stand before the URL " +
      "(after it, npx hands it to the client):\n" + bad.join("\n"),
  );
});

test("the builders themselves: only npxRun writes `npx -y` in version.ts, only Npx in clientcmd.go", () => {
  const ts = readFileSync(join(REPO, "client/src/version.ts"), "utf-8").split("\n");
  const tsCode = ts.filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l) && /`npx -y /.test(l));
  assert.equal(tsCode.length, 1, tsCode.join("\n"));
  assert.match(tsCode[0], /`npx -y \$\{NPX_URL_FLAG\} \$\{spec\}` : `npx -y \$\{spec\}`/);
  const go = readFileSync(join(REPO, "server/internal/clientcmd/clientcmd.go"), "utf-8").split("\n").filter((l) => !/^\s*\/\//.test(l) && /"npx -y /.test(l));
  assert.deepEqual(go.map((l) => l.trim()), ['return "npx -y " + URLFlag + " " + url', 'return "npx -y " + url']);
});
