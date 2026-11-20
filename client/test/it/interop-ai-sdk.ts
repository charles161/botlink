/**
 * Interop check with a deployed MCP Events client: the Vercel AI SDK's `@ai-sdk/mcp` (experimental_events),
 * UNMODIFIED, against bot-link's MCP server and the real Go server.
 *
 * STATUS 2026-11-10: WRITTEN, NOT RUN. Running it executes a freshly downloaded third-party package, which the
 * the test run's sandbox policy did not allow without the founder's OK. What WAS done instead: its source
 * (@ai-sdk/mcp 2.0.93: src/tool/mcp-events.ts, mcp-event-webhook.ts, mcp-event-signature.ts, mcp-event-types.ts) was
 * read and each thing it checks was compared with what bot-link sends (see the internal test notes, "Interop"). One mismatch
 * was found that way and fixed (refreshBefore must be an ISO date-time ending in Z).
 *
 * What it does: list → subscribe (the SDK's own secret and callback key; our server runs the verification challenge
 * against the SDK's receiver helper) → a member sends a message → the helper verifies our signature and envelope
 * and hands the event to onEvent → refresh → the same client reads the sealed message with the inbox tool →
 * unsubscribe.
 *
 * The package is not a dependency of this repo. Install it somewhere else and point AI_SDK_MCP_DIR at it:
 *   mkdir /tmp/x && cd /tmp/x && npm init -y && npm i --ignore-scripts @ai-sdk/mcp
 *   AI_SDK_MCP_DIR=/tmp/x/node_modules/@ai-sdk/mcp BOTLINK_IT_SERVER=<server binary> \
 *   BOTLINK_IT_PG=postgres://botlink@127.0.0.1:<private port> BOTLINK_IT_DB=botlink_test_events \
 *   node --import tsx test/it/interop-ai-sdk.ts
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { RealServer, Browser } from "./realserver.js";

const CLI = join(import.meta.dirname, "..", "..", "dist", "cli.js");
const DIR = process.env.AI_SDK_MCP_DIR || "";
const base = mkdtempSync(join(process.env.BOTLINK_TEST_TMP || tmpdir(), "bl-interop-aisdk-"));
const srv = new RealServer(8861, { BOTLINK_PUSH_ALLOW_LOOPBACK: "1" });
const PORT = 8863;
const results: [string, boolean, string][] = [];
const ck = (name: string, ok: boolean, evd = "") => {
  results.push([name, ok, evd]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${evd ? `\n     ${evd.replace(/\n/g, "\n     ").slice(0, 900)}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
}
function envFor(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|CODEX|CURSOR|BOTLINK_|TMUX|OPENCODE|T3CODE|ANTHROPIC|AI_SDK)/.test(k)) e[k] = v;
  return { ...e, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: srv.url, BOTLINK_DEV: "1", BOTLINK_KEYCHAIN: "0", BOTLINK_NO_UPDATE: "1", BOTLINK_NO_HARNESS_CLI: "1", BOTLINK_WAKE_TEST: "0", ...extra };
}
function run(home: string, args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const ch = spawn(process.execPath, [CLI, ...args], { cwd: home, env: envFor(home, extra), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    ch.stdout.on("data", (b) => (out += b));
    ch.stderr.on("data", (b) => (err += b));
    ch.stdin.end("");
    ch.on("exit", (code) => res({ code, out, err }));
  });
}

async function main() {
  if (!DIR) throw new Error("set AI_SDK_MCP_DIR to an installed @ai-sdk/mcp package directory (see the header)");
  const version = JSON.parse(readFileSync(join(DIR, "package.json"), "utf-8")).version;
  const sdk: any = await import(pathToFileURL(join(DIR, "dist", "index.js")).href);
  const stdio: any = await import(pathToFileURL(join(DIR, "dist", "mcp-stdio", "index.js")).href);
  const createWebhook = sdk.experimental_createMCPEventWebhook || sdk.createMCPEventWebhook;
  const createClient = sdk.createMCPClient || sdk.experimental_createMCPClient;
  const Stdio = stdio.StdioMCPTransport || stdio.Experimental_StdioMCPTransport;
  if (!createWebhook || !createClient || !Stdio) throw new Error(`this @ai-sdk/mcp (${version}) has no events client: ${Object.keys(sdk).join(", ")}`);
  console.log(`@ai-sdk/mcp ${version}`);
  mkdirSync(join(base, "logs"), { recursive: true });
  await srv.start(join(base, "logs"));
  let client: any = null;
  let http: ReturnType<typeof createServer> | null = null;
  try {
    const adam = await new Browser(srv.url).login("Adam");
    const room = await adam.createRoom("interop");
    const invite = await adam.chatInvite(room.id);
    const hR = join(base, "agent");
    const hB = join(base, "builder");
    const rEnv = { BOTLINK_APP: "other", BOTLINK_SESSION: "aisdk-agent-session-1" };
    const bEnv = { BOTLINK_APP: "codex", CODEX_THREAD_ID: "interop-1111-4222-8333-0000000000b0" };
    for (const [home, name, env] of [[hR, "sdk-agent", rEnv], [hB, "builder", bEnv]] as const) {
      mkdirSync(home, { recursive: true });
      const j = await run(home, ["join", invite, "--name", name, "--job", `${name} job`, ...(name === "sdk-agent" ? ["--app-name", "AI SDK agent"] : [])], env);
      if (j.code !== 0) throw new Error(`join ${name}: ${j.out}${j.err}`);
      await adam.approve((await adam.needsYou()).join_requests.find((x: any) => x.name === name).id);
      const w = await run(home, ["join", "--wait"], env);
      if (w.code !== 0) throw new Error(`join --wait ${name}: ${w.out}${w.err}`);
    }
    await run(hR, ["inbox", "--as", "sdk-agent"], rEnv);

    // the app's side, as the AI SDK cookbook does it: a private store, its receiver helper, its client
    const rows = new Map<string, any>();
    const store = {
      get: async (key: string) => rows.get(key),
      getById: async (id: string) => [...rows.values()].find((s) => s.id === id),
      set: async (s: any) => void rows.set(s.key, s),
      update: async (key: string, patch: any) => void rows.set(key, { ...rows.get(key), ...patch }),
      delete: async (key: string) => void rows.delete(key),
    };
    const got: any[] = [];
    const errors: unknown[] = [];
    const statuses: number[] = [];
    const handler = createWebhook({ store, onEvent: async (a: any) => void got.push(a), onError: (e: unknown) => errors.push(e) });
    http = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const r: Response = await handler(new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }));
      statuses.push(r.status);
      res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise<void>((r) => http!.listen(PORT, "127.0.0.1", () => r()));
    client = await createClient({
      transport: new Stdio({ command: process.execPath, args: [CLI, "mcp", "--app", "other"], env: envFor(hR, rEnv), cwd: hR }),
      experimental_events: { store },
    });
    const events = client.experimental_events;

    const list = await events.list();
    ck("AI SDK client: events.list() parses our catalogue", list.events.map((e: any) => e.name).join(",") === "message.received,roster.changed", JSON.stringify(list.events.map((e: any) => [e.name, e.delivery])));

    const sub = await events.subscribe({ name: "message.received", arguments: { as: "sdk-agent" }, delivery: { mode: "webhook", url: `http://127.0.0.1:${PORT}/hook`, allowInsecureLocalhost: true }, ttlMs: 3_600_000 });
    const row = [...rows.values()][0];
    ck("AI SDK client: events.subscribe() succeeds (its secret, its callback key; our challenge passed ITS receiver helper)", /^sub_[0-9a-f]{24}$/.test(sub.id) && row?.status === "active" && row?.id === sub.id && statuses[0] === 200, `${JSON.stringify(sub)}\nreceiver statuses: ${statuses.join(",")}`);

    const sent = await run(hB, ["send", "--to", "sdk-agent", "--intent", "question", "--text", "interop ping (sealed text the event must not carry)"], bEnv);
    if (sent.code !== 0) throw new Error(`send: ${sent.out}${sent.err}`);
    const ok = await until(() => got.length > 0);
    const e = got[0]?.event;
    ck("its receiver helper accepted our event: signature, webhook-id == eventId, X-MCP-Subscription-Id, envelope schema", ok && e?.name === "message.received" && got[0].subscription.id === sub.id && e.data.from.name === "builder" && e.data.waiting === 1 && !JSON.stringify(e).includes("sealed text") && errors.length === 0, `${JSON.stringify(e)}\nreceiver statuses: ${statuses.join(",")}${errors.length ? `\nerrors: ${errors.map(String).join("; ")}` : ""}`);

    const re = await events.refresh({ id: sub.id });
    ck("AI SDK client: events.refresh() keeps the subscription (same id, later refreshBefore)", re.id === sub.id && Date.parse(re.refreshBefore) >= Date.parse(sub.refreshBefore), JSON.stringify(re));
    // the app reads the message with bot-link's own tool through the same client (sealed text, opened locally)
    const tools = await client.tools();
    const inbox = await tools.inbox.execute({ as: "sdk-agent" }, { messages: [], toolCallId: "t1" });
    ck("the same client reads the sealed message with the bot-link inbox tool", /interop ping \(sealed text the event must not carry\)/.test(JSON.stringify(inbox)), JSON.stringify(inbox).slice(0, 160));
    await events.unsubscribe({ id: sub.id });
    const n = got.length;
    await run(hB, ["send", "--to", "sdk-agent", "--intent", "question", "--text", "after unsubscribe"], bEnv);
    await sleep(1500);
    ck("AI SDK client: events.unsubscribe(); nothing arrives afterwards", rows.size === 0 && got.length === n, `events after unsubscribe: ${got.length - n}`);
  } finally {
    await client?.close?.().catch(() => {});
    if (http) await new Promise<void>((r) => http!.close(() => r()));
    await srv.stop();
  }
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f[0]).join(" | ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  srv.stop().finally(() => process.exit(1));
});
