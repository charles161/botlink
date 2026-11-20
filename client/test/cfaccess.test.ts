/**
 * A staging server behind Cloudflare Access admits only requests that carry a service token in two headers. With
 * BOTH BOTLINK_CF_ACCESS_CLIENT_ID and BOTLINK_CF_ACCESS_CLIENT_SECRET set, every request the client makes to its
 * bot-link server carries CF-Access-Client-Id / CF-Access-Client-Secret (client/src/net.ts, the one place that
 * fetches). Never to another host, never followed through a redirect, never written anywhere.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as st from "../src/state.js";
import * as core from "../src/core.js";
import * as upd from "../src/update.js";
import { serverFetch, accessHeaders } from "../src/net.js";
import { FakeServer } from "./fake-server.js";
import { assertIsolated, newHome, on, startFake, PORT_BASE } from "./helpers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "dist", "cli.js");
const ID = "cfid-SENTINEL-7d1e0c";
const SECRET = "cfsecret-SENTINEL-93ab44";
const BOTH = { BOTLINK_CF_ACCESS_CLIENT_ID: ID, BOTLINK_CF_ACCESS_CLIENT_SECRET: SECRET };

let f: FakeServer;
let other: Server;
let otherSaw: { id?: string; secret?: string }[] = [];
let otherUrl = "";
before(async () => {
  assertIsolated();
  f = await startFake();
  other = createServer((req, res) => {
    otherSaw.push({ id: req.headers["cf-access-client-id"] as string | undefined, secret: req.headers["cf-access-client-secret"] as string | undefined });
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `${f.url}/healthz` });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  for (const p of [PORT_BASE + 6, PORT_BASE + 7]) {
    try {
      await new Promise<void>((ok, bad) => {
        other.once("error", bad);
        other.listen(p, "127.0.0.1", () => ok());
      });
      otherUrl = `http://127.0.0.1:${p}`;
      break;
    } catch {
      /* next */
    }
  }
  assert.ok(otherUrl);
});
after(async () => {
  await f.stop();
  await new Promise<void>((ok) => other.close(() => ok()));
});

/** the CLI as a child process, without blocking this process (the fake server answers from here) */
function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  c.stdout.on("data", (b) => (stdout += b));
  c.stderr.on("data", (b) => (stderr += b));
  return new Promise((res) => c.on("exit", () => res({ stdout, stderr })));
}

async function joined(label: string) {
  const adam = await f.account("Adam");
  const room = await f.room(adam, `${label}${Math.floor(Math.random() * 1e6)}`, "p");
  const h = newHome(label);
  const s = "aaaaaaaa-cfac-4bbb-8ccc-000000000001";
  const m = await on(h, async () => {
    const r = await core.joinCreate({ invite: `http://localhost:8811/i/${f.invite(room, adam)}`, name: "cc", job: "", app: "claude-code", turn: "on_turn", session: s, cwd: h, folder: "~", machine: "m" });
    f.approve(r.req.id);
    return ((await core.joinWait({ maxMs: 5000, app: "claude-code", session: s, cwd: h })) as any).member as st.MemberRec;
  }, BOTH);
  return { h, s, m };
}

test("both set: every call to the configured server carries the two headers (join, roster, wait)", async () => {
  f.access.length = 0;
  const { h, m } = await joined("cfboth");
  await on(h, () => core.refreshRoster(st.loadMember(m.id)!), BOTH);
  const api = f.access.filter((a) => a.path.startsWith("/api/v1/"));
  assert.ok(api.length >= 3, JSON.stringify(api));
  for (const a of api) assert.deepEqual([a.id, a.secret], [ID, SECRET], a.path);
});

test("only one set, or none: neither header is sent, and a half setting is said once on stderr", async () => {
  const { h } = await joined("cfhalf");
  assert.deepEqual(await on(h, () => accessHeaders(f.url), { BOTLINK_CF_ACCESS_CLIENT_ID: undefined, BOTLINK_CF_ACCESS_CLIENT_SECRET: undefined }), {});
  f.access.length = 0;
  const r = await cli(["inbox", "--as", "cc", "--session", "aaaaaaaa-cfac-4bbb-8ccc-000000000001"], { ...process.env, HOME: h, BOTLINK_HOME: join(h, ".botlink"), BOTLINK_SERVER: f.url, BOTLINK_CF_ACCESS_CLIENT_ID: ID });
  const api = f.access.filter((x) => x.path.startsWith("/api/v1/"));
  assert.ok(api.length >= 1, `${JSON.stringify(api)} ${r.stdout} ${r.stderr}`);
  for (const x of api) assert.deepEqual([x.id, x.secret], [undefined, undefined]);
  assert.equal(r.stderr.match(/BOTLINK_CF_ACCESS_CLIENT_ID is set but BOTLINK_CF_ACCESS_CLIENT_SECRET is not/g)?.length, 1, r.stderr);
  assert.ok(!r.stderr.includes(ID), "the value itself is never printed");
});

test("never to another host, and never through a redirect", async () => {
  await on(newHome("cfother"), async () => {
    otherSaw = [];
    await serverFetch(`${otherUrl}/x`, { method: "GET" });
    assert.deepEqual(otherSaw, [{ id: undefined, secret: undefined }], "another origin gets neither header");
  }, { ...BOTH, BOTLINK_SERVER: f.url });
  // the configured server answers with a redirect to another address: it is never followed (so the headers can't go on)
  await on(newHome("cfredir"), async () => {
    otherSaw = [];
    f.access.length = 0;
    await assert.rejects(serverFetch(`${otherUrl}/redirect`, { method: "GET", redirect: "follow" }));
    assert.deepEqual(otherSaw, [{ id: ID, secret: SECRET }], "the configured server got them");
    assert.equal(f.access.length, 0, "the redirect target was never asked");
  }, { ...BOTH, BOTLINK_SERVER: otherUrl });
});

test("the values are never written: status, a failing request and an update check leave them in no output and no file", async () => {
  const { h, m } = await joined("cfleak");
  const env = { ...process.env, HOME: h, BOTLINK_HOME: join(h, ".botlink"), BOTLINK_SERVER: f.url, ...BOTH };
  const outs: string[] = [];
  const run = async (args: string[]) => {
    const r = await cli(args, env);
    outs.push(r.stdout, r.stderr);
  };
  f.access.length = 0;
  await run(["status", "--session", "aaaaaaaa-cfac-4bbb-8ccc-000000000001"]);
  f.failNext = { path: /\/api\/v1\/me\/roster$/, status: 403, code: "forbidden", times: 1 };
  await run(["roster", "--as", "cc", "--session", "aaaaaaaa-cfac-4bbb-8ccc-000000000001"]);
  assert.ok(f.access.some((a) => a.path === "/api/v1/me/roster" && a.id === ID), "the CLI's calls carried them");
  assert.ok(/isn't allowed/.test(outs.join("\n")), `the failing request was explained: ${outs.join(" | ").slice(0, 300)}`);
  f.failNext = null;
  await on(h, async () => {
    try {
      core.explain(await core.refreshRoster(st.loadMember(m.id)!).then(() => null, (e) => e));
    } catch {
      /* the text is checked below */
    }
    const u = await upd.runUpdate({ force: true });
    outs.push(JSON.stringify(u));
  }, { ...BOTH, BOTLINK_NO_UPDATE: undefined, BOTLINK_SELF_INSTALL: "1", BOTLINK_DEV: "1", BOTLINK_UPDATE_ORIGIN: f.url });
  assert.ok(f.access.some((a) => a.path === "/dl/botlink.manifest.json" && a.id === ID), "the update check carried them");
  for (const o of outs) assert.ok(!o.includes(ID) && !o.includes(SECRET), `an output holds a value: ${o.slice(0, 200)}`);
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const p of walk(h)) {
    const t = readFileSync(p).toString("latin1");
    assert.ok(!t.includes(ID) && !t.includes(SECRET), `a file holds a value: ${p}`);
  }
});

test("one place fetches: no fetch or http request to the server anywhere in client/src outside net.ts", () => {
  const src = join(ROOT, "src");
  const bad: string[] = [];
  for (const n of readdirSync(src).filter((x) => x.endsWith(".ts"))) {
    if (n === "net.ts") continue;
    const lines = readFileSync(join(src, n), "utf-8").split("\n");
    lines.forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, "");
      if (/(^|[^.\w])fetch\(|\bhttps?\.(request|get)\(|from "node:https"/.test(code)) bad.push(`${n}:${i + 1}: ${l.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, [], "call serverFetch (client/src/net.ts) instead: it is the one place that adds the Cloudflare Access headers and refuses redirects");
});

// overseer review: the token goes only where the same environment says, BOTLINK_SERVER (and BOTLINK_UPDATE_ORIGIN)
test("only BOTLINK_SERVER / BOTLINK_UPDATE_ORIGIN get the headers: not a member's server, not the saved server", async () => {
  const h = newHome("cforigin");
  await on(h, async () => {
    st.saveConfig({ ...st.loadConfig(), server: otherUrl });
    assert.deepEqual(accessHeaders(`${otherUrl}/api/v1/me`), {}, "the saved server is not named in the environment");
    st.saveMember({ id: "01a1e4ee-0000-7000-8000-00000000c0fa", server: otherUrl, room: { id: "r", name: "x", purpose: "" }, name: "m", job: "", app: "claude-code", folder: "~", cwd: h, machine: "m", turn: "on_turn", account: "a", person_name: "P", holder_session: null, holder_epoch: 0, key_id: "k", key_backend: "file", pin: {} as any, joined_at: 0 });
    assert.deepEqual(accessHeaders(`${otherUrl}/api/v1/me/wait`), {}, "a member's server (an invite pointed there) is not named in the environment");
    assert.deepEqual(accessHeaders(`${f.url}/api/v1/me`), { "CF-Access-Client-Id": ID, "CF-Access-Client-Secret": SECRET });
  }, { ...BOTH, BOTLINK_SERVER: f.url, BOTLINK_UPDATE_ORIGIN: undefined });
  await on(h, () => assert.deepEqual(accessHeaders(`${otherUrl}/dl/botlink.manifest.json`), { "CF-Access-Client-Id": ID, "CF-Access-Client-Secret": SECRET }), { ...BOTH, BOTLINK_SERVER: f.url, BOTLINK_UPDATE_ORIGIN: otherUrl });
});

test("the two settings without BOTLINK_SERVER: said once on stderr (names only), and nothing is sent", async () => {
  const h = newHome("cfnoserver");
  const code = `import("${join(ROOT, "src", "net.ts")}").then((n) => { n.accessHeaders("${f.url}/a"); n.accessHeaders("${f.url}/b"); const x = n.accessHeaders("${f.url}/c"); process.stdout.write(JSON.stringify(x)); })`;
  const c = spawn(process.execPath, ["--import", "tsx", "-e", code], { cwd: ROOT, env: { ...process.env, HOME: h, BOTLINK_HOME: join(h, ".botlink"), ...BOTH, BOTLINK_SERVER: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  c.stdout.on("data", (b) => (out += b));
  c.stderr.on("data", (b) => (err += b));
  await new Promise((res) => c.on("exit", res));
  assert.equal(out, "{}");
  assert.equal(err.match(/BOTLINK_CF_ACCESS_CLIENT_ID and BOTLINK_CF_ACCESS_CLIENT_SECRET are set but BOTLINK_SERVER is not/g)?.length, 1, err);
  assert.ok(!err.includes(ID) && !err.includes(SECRET));
});
