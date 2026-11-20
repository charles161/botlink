/**
 * Tests that run the command line spawn dist/cli.js. Run against a dist built from older code, they fail every time
 * with a misleading message (fix-all review, 16 Nov 2026: memberend.test.ts "status shows the member as used by
 * another chat" was a dist without the code under test, not a race). scripts/run-tests.mjs builds first when any
 * source file is newer than the build; this pins the rule it uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// @ts-ignore: a plain .mjs script module
import { distStale } from "../scripts/dist-fresh.mjs";

function tree() {
  const d = mkdtempSync(join(process.env.BOTLINK_TEST_BASE!, "distfresh-"));
  mkdirSync(join(d, "src", "sub"), { recursive: true });
  mkdirSync(join(d, "dist"), { recursive: true });
  writeFileSync(join(d, "src", "a.ts"), "export {};\n");
  writeFileSync(join(d, "src", "sub", "b.ts"), "export {};\n");
  writeFileSync(join(d, "dist", "cli.js"), "//\n");
  const t = (p: string, s: number) => utimesSync(join(d, p), s, s);
  return { d, t };
}

test("dist built after every source file: fresh", () => {
  const { d, t } = tree();
  t("src/a.ts", 1000), t("src/sub/b.ts", 1000), t("dist/cli.js", 2000);
  assert.equal(distStale(d), null);
});

test("a source file (any depth) newer than the build, or no build at all: stale, naming the file", () => {
  const { d, t } = tree();
  t("src/a.ts", 1000), t("dist/cli.js", 2000), t("src/sub/b.ts", 3000);
  assert.match(String(distStale(d)), /src\/sub\/b\.ts is newer than dist\/cli\.js/);
  const e = tree();
  e.t("src/a.ts", 1000);
  writeFileSync(join(e.d, "dist", "cli.js"), "");
  rmSync(join(e.d, "dist"), { recursive: true });
  assert.match(String(distStale(e.d)), /no dist\/cli\.js/);
});
