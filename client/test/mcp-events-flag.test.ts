/**
 * BOTLINK_MCP_EVENTS (SPEC §6.13, docs/protocol/mcp-events.md): the experimental MCP Events methods (SEP-3415 draft)
 * have one switch. Default `on`: the tool server answers `initialize` and `tools/list` byte for byte as the base build
 * (768fdc8) did. `off`: no events capability, no extension key, and every `events/*` method is method-not-found.
 *
 * The snapshot is test/fixtures/mcp-base-768fdc8.json. To write it again from a build of another commit:
 *   MCP_SNAPSHOT_BASE_CLI=<that build>/dist/cli.js node scripts/run-tests.mjs test/mcp-events-flag.test.ts
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { assertIsolated, newHome } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
const FIXTURE = join(import.meta.dirname, "fixtures", "mcp-base-768fdc8.json");

before(() => assertIsolated());

/** Raw JSON-RPC over stdio: the exact lines the tool server writes (no SDK in between). */
async function raw(cli: string, env: Record<string, string>, calls: { method: string; params?: unknown }[]): Promise<string[]> {
  const home = newHome("mcpflag");
  const ch = spawn(process.execPath, [cli, "mcp", "--app", "claude-code"], {
    cwd: home,
    env: { ...(process.env as Record<string, string>), HOME: home, BOTLINK_HOME: join(home, ".botlink"), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiters: ((l: string) => void)[] = [];
  const early: string[] = [];
  ch.stdout.on("data", (b) => {
    buf += b;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w) w(l);
      else early.push(l);
    }
  });
  const next = () => new Promise<string>((res, rej) => {
    if (early.length) return res(early.shift()!);
    const t = setTimeout(() => rej(new Error("no answer from the tool server in 15 s")), 15_000);
    waiters.push((l) => {
      clearTimeout(t);
      res(l);
    });
  });
  const send = (o: unknown) => ch.stdin.write(JSON.stringify(o) + "\n");
  const out: string[] = [];
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "flag-test", version: "1" } } });
    out.push(await next());
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    let id = 2;
    for (const c of calls) {
      send({ jsonrpc: "2.0", id: id++, method: c.method, ...(c.params === undefined ? {} : { params: c.params }) });
      out.push(await next());
    }
  } finally {
    ch.kill("SIGTERM");
  }
  // the CLI's own folder appears in the instructions (the command to run): the same text, wherever the build lives
  const root = dirname(dirname(cli));
  return out.map((l) => l.split(root).join("<ROOT>"));
}

const EVENT_METHODS = ["events/list", "events/subscribe", "events/unsubscribe", "events/poll", "events/stream"];

test("BOTLINK_MCP_EVENTS default (unset or on): initialize and tools/list byte for byte the base build's (768fdc8)", async () => {
  if (process.env.MCP_SNAPSHOT_BASE_CLI) {
    const [init, tools] = await raw(process.env.MCP_SNAPSHOT_BASE_CLI, { BOTLINK_SERVER: "http://127.0.0.1:9" }, [{ method: "tools/list" }]);
    writeFileSync(FIXTURE, JSON.stringify({ initialize: init, toolsList: tools }, null, 1) + "\n");
  }
  assert.ok(existsSync(FIXTURE), "the base snapshot is missing: write it with MCP_SNAPSHOT_BASE_CLI (see the top of this file)");
  const base = JSON.parse(readFileSync(FIXTURE, "utf-8"));
  for (const env of [{}, { BOTLINK_MCP_EVENTS: "on" }]) {
    const [init, tools] = await raw(CLI, { BOTLINK_SERVER: "http://127.0.0.1:9", ...env }, [{ method: "tools/list" }]);
    // the snapshot's build called itself 1.0.0-dev; serverInfo.version is the package's own version (1.0.0 from 20 Nov 2026 on)
    const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")).version;
    const baseInit = String(base.initialize).replace('"serverInfo":{"name":"botlink","version":"1.0.0-dev"}', `"serverInfo":{"name":"botlink","version":${JSON.stringify(version)}}`);
    assert.notEqual(baseInit === base.initialize, version !== "1.0.0-dev", "the snapshot's serverInfo was not found where expected");
    assert.equal(init, baseInit, `initialize changed with ${JSON.stringify(env)}: with the flag at its default the tool server must answer exactly as 768fdc8 did (apart from the package's version)`);
    assert.equal(tools, base.toolsList, `tools/list changed with ${JSON.stringify(env)}`);
  }
  // and the events methods still answer (events/list needs no member)
  const [, list] = await raw(CLI, { BOTLINK_SERVER: "http://127.0.0.1:9" }, [{ method: "events/list" }]);
  assert.match(list, /"message\.received"/);
});

test("BOTLINK_MCP_EVENTS=off: no events capability or extension; every events/* method is method-not-found", async () => {
  const lines = await raw(CLI, { BOTLINK_SERVER: "http://127.0.0.1:9", BOTLINK_MCP_EVENTS: "off" }, [{ method: "tools/list" }, ...EVENT_METHODS.map((method) => ({ method, params: { name: "message.received" } }))]);
  const init = JSON.parse(lines[0]).result;
  assert.equal(init.capabilities.events, undefined, "off: initialize must not declare capabilities.events");
  assert.equal(init.capabilities.extensions, undefined, "off: initialize must not declare the io.modelcontextprotocol/events extension");
  assert.ok(!/events/i.test(JSON.stringify(init.capabilities)), JSON.stringify(init.capabilities));
  const base = JSON.parse(readFileSync(FIXTURE, "utf-8"));
  assert.equal(lines[1], base.toolsList, "off changes nothing about the tools");
  EVENT_METHODS.forEach((m, i) => {
    const r = JSON.parse(lines[2 + i]);
    assert.equal(r.error?.code, -32601, `${m} must be method-not-found with BOTLINK_MCP_EVENTS=off, got ${lines[2 + i]}`);
  });
});

test("BOTLINK_MCP_EVENTS: a value other than on / off is refused at start with a sentence that names the two values", async () => {
  const { eventsSetting } = await import("../src/mcp-events.js");
  assert.equal(eventsSetting({}), "on");
  assert.equal(eventsSetting({ BOTLINK_MCP_EVENTS: "on" }), "on");
  assert.equal(eventsSetting({ BOTLINK_MCP_EVENTS: "off" }), "off");
  assert.equal(eventsSetting({ BOTLINK_MCP_EVENTS: "" }), "on");
  assert.equal(eventsSetting({ BOTLINK_MCP_EVENTS: " OFF " }), "off");
  for (const bad of ["1", "0", "true", "yes", "disabled"]) assert.throws(() => eventsSetting({ BOTLINK_MCP_EVENTS: bad }), /BOTLINK_MCP_EVENTS must be on or off/, bad);
});
