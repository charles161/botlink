#!/usr/bin/env node
/**
 * Runs the client tests in an isolated environment (PLAN rules): CLAUDE_CONFIG_DIR and CODEX_HOME unset, a temp
 * HOME, an isolated XDG dir, the file key store, no harness CLI validation, and BOTLINK_SERVER only ever local.
 *   node scripts/run-tests.mjs [test files...]
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { distStale } from "./dist-fresh.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// tests that run the command line spawn dist/cli.js: never against a build of older code (dist-fresh.mjs)
const stale = distStale(root);
if (stale) {
  process.stderr.write(`run-tests: ${stale}; building first (npm run build)\n`);
  const b = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
const base = mkdtempSync(join(process.env.BOTLINK_TEST_TMP || tmpdir(), "botlink-client-test-"));
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(CLAUDE|CODEX|BOTLINK_|CURSOR)/.test(k) && k !== "BOTLINK_TEST_TMP" && k !== "BOTLINK_TEST_PORT_BASE" && k !== "BOTLINK_IT_SERVER" && k !== "BOTLINK_IT_PORT" && k !== "BOTLINK_IT_PG" && k !== "BOTLINK_IT_DB") delete env[k];
Object.assign(env, {
  HOME: join(base, "home"),
  XDG_CONFIG_HOME: join(base, "xdg-config"),
  XDG_DATA_HOME: join(base, "xdg-data"),
  XDG_STATE_HOME: join(base, "xdg-state"),
  XDG_RUNTIME_DIR: join(base, "xdg-runtime"),
  BOTLINK_TEST_BASE: base,
  BOTLINK_KEYCHAIN: "0",
  BOTLINK_NO_HARNESS_CLI: "1",
  BOTLINK_SERVER: `http://127.0.0.1:${Number(process.env.BOTLINK_TEST_PORT_BASE) || 8820}`, // overwritten per test with the fake's local port; never remote
  BOTLINK_NO_UPDATE: "1", // SPEC §7.6: no self-update checks from tests (update.test.ts turns it on per test)
  BOTLINK_NO_SELFTEST: "1", // r2 SPEC §6.4a: the join's automatic self-test would add a message to every count; selftest.test.ts turns it on
  BOTLINK_DEV: "1", // FINDINGS F4: tests install with a local server on purpose (into temp HOMEs only)
});
// test/netguard.mjs in every test process and every process a test starts: nothing but loopback can be reached
// (founder's rule, 17 Nov 2026: a red test once sent a real request to production). Refusals are recorded here.
const GUARD_LOG = join(base, "netguard.jsonl");
env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --import=${pathToFileURL(join(root, "test", "netguard.mjs")).href}`.trim();
env.BOTLINK_NET_GUARD_LOG = GUARD_LOG;
// npm, as tests run it (npm pack), asks the registry for its own update check unless told not to: offline, no check
Object.assign(env, { npm_config_update_notifier: "false", npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" });
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.ts")).sort().map((f) => join("test", f));
const r = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "--test-reporter=spec", ...files], { cwd: root, env, stdio: "inherit" });
// a test (or a client it started) tried to reach something that is not loopback: the run fails, saying what and where
let refused = [];
try {
  refused = readFileSync(GUARD_LOG, "utf-8").trim().split("\n").filter(Boolean);
} catch {
  /* nothing was refused */
}
if (refused.length) process.stderr.write(`run-tests: the network guard refused ${refused.length} connection(s) to hosts that are not loopback; tests must only reach the fake servers:\n${refused.map((l) => `  ${l}`).join("\n")}\n`);
if (!process.env.BOTLINK_KEEP_TEST_TMP) rmSync(base, { recursive: true, force: true });
process.exit(refused.length ? 1 : r.status ?? 1);
