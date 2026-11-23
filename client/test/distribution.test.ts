/**
 * deploy/NEEDS.md item 5: `botlink` is NOT on the npm registry. Nothing the client prints, and nothing in the agent
 * docs, may tell a chat to run a bare `npx botlink …` (E404 today; whoever registers the name would run code on every
 * machine that follows it). Follow-up commands use the command this copy was actually run with.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { selfCmd, clientUrl, originFromSpec, DEFAULT_CLIENT_URL } from "../src/version.js";
import { assertIsolated, newHome } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const BARE = /npx\s+(-y\s+)?botlink\b(?![-.\w/])/;

before(() => assertIsolated());

test("selfCmd: never a bare `npx botlink`; a checkout prints its absolute path, BOTLINK_CLIENT_URL / the tarball URL otherwise", () => {
  const saved = process.env.BOTLINK_CLIENT_URL, server = process.env.BOTLINK_SERVER;
  try {
    delete process.env.BOTLINK_CLIENT_URL;
    // production's download only for production or an unknown server (staging tester, 17 Nov 2026; selfcmd.test.ts)
    assert.equal(clientUrl(), null, "a copy pointed at another server (here the test's) never names production's client");
    delete process.env.BOTLINK_SERVER;
    assert.equal(clientUrl(), DEFAULT_CLIENT_URL);
    assert.equal(DEFAULT_CLIENT_URL, "https://api.botlink.dev/dl/botlink.tgz");
    assert.equal(selfCmd(), `node ${join(ROOT, "dist", "cli.js")}`, "a checkout runs itself by absolute path");
    process.env.BOTLINK_CLIENT_URL = "https://dl.botlink.dev/dl/botlink.tgz";
    assert.equal(clientUrl(), "https://dl.botlink.dev/dl/botlink.tgz");
    assert.equal(selfCmd(), "npx -y --allow-remote=all https://dl.botlink.dev/dl/botlink.tgz");
    // an address that isn't one of bot-link's hosts is never printed as "run this" (security review 2026-11-12)
    process.env.BOTLINK_CLIENT_URL = "https://api.example.test/dl/botlink.tgz";
    assert.equal(clientUrl(), DEFAULT_CLIENT_URL);
    process.env.BOTLINK_SERVER = "https://test.botlink.dev";
    assert.equal(clientUrl(), null, "nor for staging, when the given address is refused");
    assert.equal(originFromSpec("https://api.botlink.dev/dl/botlink.tgz"), "https://api.botlink.dev");
    // the versioned name the server hands out (launch plan #3)
    assert.equal(originFromSpec("https://api.botlink.dev/dl/botlink-0123456789abcdef.tgz"), "https://api.botlink.dev");
    assert.equal(originFromSpec("https://api.botlink.dev/dl/botlink-zz.tgz"), null);
  } finally {
    if (saved === undefined) delete process.env.BOTLINK_CLIENT_URL;
    else process.env.BOTLINK_CLIENT_URL = saved;
    if (server === undefined) delete process.env.BOTLINK_SERVER;
    else process.env.BOTLINK_SERVER = server;
  }
});

test("CLI output (help, join/claim/listen usage and hints) never says `npx botlink`; with BOTLINK_CLIENT_URL it says `npx -y <url>`", () => {
  const home = newHome("dist");
  const env = { ...process.env, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_CLIENT_URL: "https://dl.botlink.dev/dl/botlink.tgz" };
  const outs = [["--help"], ["join"], ["claim"], ["listen", "--on-message", ""], ["claim", "nobody"]].map((a) => {
    const r = spawnSync(process.execPath, [CLI, ...a], { env, encoding: "utf-8" });
    return r.stdout + r.stderr;
  });
  for (const o of outs) assert.ok(!BARE.test(o), o);
  assert.match(outs[0], /npx -y --allow-remote=all https:\/\/dl\.botlink\.dev\/dl\/botlink\.tgz join <invite>/);
  assert.match(outs[1], /Usage: npx -y --allow-remote=all https:\/\/dl\.botlink\.dev\/dl\/botlink\.tgz join/);
});

test("no source file, agent doc or invite page text tells anyone to run a bare `npx botlink`", () => {
  const files = [
    ...readdirSync(join(ROOT, "src")).map((f) => join(ROOT, "src", f)),
    join(ROOT, "..", "docs", "agents.md"),
    join(ROOT, "..", "docs", "llms.txt"),
    join(ROOT, "..", "server", "internal", "pages", "pages.go"),
  ];
  for (const f of files) {
    const lines = readFileSync(f, "utf-8").split("\n");
    // the warnings themselves ("never a bare `npx botlink`") are the only allowed mentions
    const bad = lines.filter((l) => BARE.test(l) && !/never|NEVER|isn't ours|not on npm|not from the npm registry/.test(l));
    assert.deepEqual(bad, [], f);
  }
});

test("npm package @botlink/cli (npm refused the bare name): its installs count as bot-link's own, like the /dl tarball 'botlink'; botlink-mcp 0.x never", async () => {
  const { isBotlinkPackage } = await import("../src/span.js");
  const { PACKAGE_NAMES, NPM_NAME } = await import("../src/version.js");
  assert.deepEqual(PACKAGE_NAMES, ["botlink", "@botlink/cli"]);
  assert.equal(NPM_NAME, "@botlink/cli");
  const base = mkdtempSync(join(tmpdir(), "bl-pkgname-"));
  const mk = (dir: string, name: string, version: string) => {
    mkdirSync(join(base, dir, "dist"), { recursive: true });
    writeFileSync(join(base, dir, "package.json"), JSON.stringify({ name, version }));
    writeFileSync(join(base, dir, "dist", "cli.js"), "//");
    return join(base, dir, "dist", "cli.js");
  };
  try {
    assert.equal(isBotlinkPackage(mk("a", "botlink", "1.0.0-dev")), true);
    assert.equal(isBotlinkPackage(mk("b", "@botlink/cli", "1.0.0")), true);
    assert.equal(isBotlinkPackage(mk("c", "botlink", "0.9.3")), false, "botlink-mcp is another product");
    assert.equal(isBotlinkPackage(mk("d", "@someone/cli", "1.0.0")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
