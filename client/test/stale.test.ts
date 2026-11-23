// Incident 21 Nov 2026: the founder's OpenCode ran last release's client from npx's cache (npx keys its cache on the
// spec string and never fetches a URL spec again), asked to join with the old code, and nothing told the chat or its
// human that the copy was old. From this release on a copy knows its release (its version: one per release), sends
// it, reads the server's current client from the answers it gets anyway, and when it is behind: an npx copy says the
// exact command once; a join, a room draft and a move are refused before anything is made; an installed copy starts
// one signed update. Nothing is said while the copy is current.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import * as st from "../src/state.js";
import { tools } from "../src/mcp.js";
import { explain } from "../src/core.js";
import { cmpVersion, resetStaleForTests, setMcpMode, takeStaleLine } from "../src/stale.js";
import { VERSION } from "../src/version.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
let f: FakeServer;
let URL_NEW = "";
before(async () => {
  assertIsolated();
  f = await startFake();
  URL_NEW = `${f.url}/dl/botlink-0123456789abcdef.tgz`;
});
after(async () => f.stop());

let n = 0;
async function invite() {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `stale${++n}${Math.floor(Math.random() * 1e4)}`, "p");
  return `http://localhost:8811/i/${f.invite(room, adam)}`;
}

/** Run the command line as a separate process (the fake answers from this one). */
function cli(home: string, args: string[], env: Record<string, string | undefined> = {}, cli = CLI): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const e: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: f.url, OPENCODE: "1", OPENCODE_PID: "4242" };
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
    else e[k] = v;
    const p = spawn(process.execPath, [cli, ...args], { cwd: home, env: e });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill(), 60_000);
    p.on("close", (code) => {
      clearTimeout(t);
      res({ code, out, err });
    });
  });
}
const npx = { BOTLINK_SELF_INSTALL: "1" }; // runs as an npx copy (update.ts runKind)
const newer = () => {
  const [a] = VERSION.split(".").map(Number);
  return `${a + 1}.0.0`;
};

test("versions order as semver (1.0.0-dev < 1.0.0 < 1.0.1 < 1.0.10); junk is not a version", () => {
  assert.equal(cmpVersion("1.0.0", "1.0.1"), -1);
  assert.equal(cmpVersion("1.0.10", "1.0.9"), 1);
  assert.equal(cmpVersion("1.0.0-dev", "1.0.0"), -1);
  assert.equal(cmpVersion("1.0.1", "1.0.1"), 0);
  assert.equal(cmpVersion("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
  assert.equal(cmpVersion("latest", "1.0.0"), null);
});

test("every call says which client this is and asks to be refused when it is behind (X-Botlink-Client-Version, X-Botlink-Client-Stale)", async () => {
  f.client = null;
  const h = newHome("stale-hdr");
  const inv = await invite();
  const before = f.clientHeaders.length;
  await cli(h, ["join", inv], npx);
  const seen = f.clientHeaders.slice(before).filter((x) => x.path.startsWith("/api/v1/"));
  assert.ok(seen.length >= 1);
  for (const x of seen) {
    assert.equal(x.version, VERSION);
    assert.equal(x.stale, "refuse");
  }
});

test("current copy: nothing is said, the join goes out", async () => {
  f.client = { version: VERSION, url: URL_NEW, release: 5 };
  const h = newHome("stale-cur");
  const inv = await invite();
  const joins = f.joins.size;
  const r = await cli(h, ["join", inv, "--name", "deepseek", "--job", "answers", "--app-name", "OpenCode"], npx);
  assert.equal(f.joins.size, joins + 1, r.out + r.err);
  assert.doesNotMatch(r.out + r.err, /out of date|older than the current release/);
});

test("the founder's case, one release later: an npx copy behind the server asks to join: told to update with the exact command; no join request is made", async () => {
  f.client = { version: newer(), url: URL_NEW, release: 6 };
  const h = newHome("stale-join");
  const inv = await invite();
  const joins = f.joins.size;
  const r = await cli(h, ["join", inv, "--name", "deepseek", "--job", "answers", "--app-name", "OpenCode"], npx);
  const all = r.out + r.err;
  assert.notEqual(r.code, 0);
  assert.equal(f.joins.size, joins, "no join request from the stale copy");
  assert.match(all, new RegExp(`This bot-link client \\(${VERSION.replace(/\./g, "\\.")}\\) is out of date: its server hands out ${newer().replace(/\./g, "\\.")}, so nothing was sent\\. Run exactly:`));
  assert.ok(all.includes(`npx -y --allow-remote=all ${URL_NEW} join ${inv} --name deepseek --job answers --app-name OpenCode`), all);
  assert.match(all, /Do not retry the old command: it runs the old copy again\./);
  assert.doesNotMatch(all, /older than the current release/, "one message, not two");
  // nothing kept on this computer for a request that was never made
  assert.deepEqual(await on(h, () => st.allRequests()), []);
});

test("an npx copy behind the server, any other command: one line with the exact command, once; the command still runs", async () => {
  f.client = { version: newer(), url: URL_NEW };
  const h = newHome("stale-line");
  const inv = await invite();
  const r = await cli(h, ["join", inv], npx); // the preview (no name yet): reading is never refused
  assert.match(r.out, /ROOM PREVIEW/);
  const lines = r.err.split("\n").filter((l) => /older than the current release/.test(l));
  assert.equal(lines.length, 1, r.err);
  assert.equal(lines[0], `bot-link: this copy (${VERSION}) is older than the current release (${newer()}). Run exactly: npx -y --allow-remote=all ${URL_NEW} join ${inv}  (do not run the old command again: npx keeps the old copy for it)`);
});

test("a checkout behind the server (a developer's build): nothing is said", async () => {
  f.client = { version: newer(), url: URL_NEW };
  const h = newHome("stale-dev");
  const r = await cli(h, ["join", await invite()], { BOTLINK_SELF_INSTALL: undefined });
  assert.doesNotMatch(r.err, /older than the current release/);
});

test("a URL that is not bot-link's is never printed as a command", async () => {
  f.client = { version: newer(), url: "https://evil.example/dl/botlink-0123456789abcdef.tgz" };
  const h = newHome("stale-evil");
  const r = await cli(h, ["join", await invite()], npx);
  assert.doesNotMatch(r.out + r.err, /evil\.example/);
});

test("the tools (MCP), behind: a join is refused with what to do from a shell and in the app's MCP settings; other tools carry one line, once", async () => {
  f.client = { version: newer(), url: URL_NEW };
  const inv = await invite();
  const h = newHome("stale-mcp");
  await on(
    h,
    async () => {
      resetStaleForTests();
      setMcpMode();
      const t = tools({ app: "opencode", session: () => null });
      const joins = f.joins.size;
      const out = await t.join({ invite: inv, name: "deepseek", job: "answers" }).catch((e) => explain(e));
      assert.equal(f.joins.size, joins);
      assert.match(out, /is out of date: its server hands out/);
      assert.ok(out.includes(`npx -y --allow-remote=all ${URL_NEW} <the command>`), out);
      assert.ok(out.includes(`change the bot-link command to \`npx -y --allow-remote=all ${URL_NEW} mcp\` and restart the app`), out);
      assert.equal(takeStaleLine(), null, "the refusal said it: no second line");
      resetStaleForTests();
      setMcpMode();
      // (serve()'s wrap adds takeStaleLine() to each tool's result)
      assert.match(await t.join({ invite: inv }), /ROOM PREVIEW/);
      assert.equal(takeStaleLine(), `bot-link: this chat's bot-link tools run an old copy (${VERSION}; the current release is ${newer()}). Tell your human: in this app's MCP settings, change the bot-link command to \`npx -y --allow-remote=all ${URL_NEW} mcp\` and restart the app.`);
      await t.join({ invite: inv });
      assert.equal(takeStaleLine(), null, "once per process");
      resetStaleForTests();
    },
    npx,
  );
});

test("an installed copy behind the server: one signed update starts (recorded), at most once per 30 minutes; nothing printed", async () => {
  f.client = { version: newer(), url: URL_NEW };
  const h = newHome("stale-inst");
  const dir = join(h, ".botlink", "client", `${VERSION}-test`);
  mkdirSync(dir, { recursive: true });
  cpSync(join(ROOT, "dist"), join(dir, "dist"), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(dir, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  symlinkSync(`${VERSION}-test`, join(h, ".botlink", "client", "current"));
  const inst = join(h, ".botlink", "client", "current", "dist", "cli.js");
  const env = { BOTLINK_NO_UPDATE: undefined, BOTLINK_UPDATE_ORIGIN: f.url, BOTLINK_SELF_INSTALL: undefined };
  const inv = await invite();
  const r1 = await cli(h, ["join", inv], env, inst);
  assert.doesNotMatch(r1.err, /older than the current release/);
  const state = () => JSON.parse(readFileSync(join(h, ".botlink", "client", "update.json"), "utf-8"));
  const at = state().behind_update_at;
  assert.ok(at > 0, JSON.stringify(state()));
  assert.equal(state().server_client.version, newer());
  await cli(h, ["join", inv], env, inst);
  assert.equal(state().behind_update_at, at, "not again within 30 minutes");
});
