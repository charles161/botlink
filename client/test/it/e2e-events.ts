/**
 * End-to-end check for bot-link Events (SPEC §6.13; not part of `npm test`): the real Go server on 127.0.0.1:8861
 * against a private dev Postgres, real CLI processes in temp HOMEs, a real `botlink events serve` receiver, and the
 * real bot-link MCP server driven by the MCP SDK's client.
 *
 *   A. `events serve`: a member's chat is woken by a signed event (no listener, no long-poll): a message from another
 *      member → the receiver checks the signature → runs the wake command → the chat's inbox read shows the text →
 *      the room says "wakes on its own"; the wake test says PASSED; forged / replayed requests are refused; stopping
 *      the receiver removes the subscription.
 *   B. MCP Events: capabilities, events/list, events/subscribe (challenge handshake against a receiver this script
 *      runs), a delivered event with webhook-id == eventId and a valid Standard Webhooks signature, events/poll,
 *      events/unsubscribe, and the error codes.
 *
 * Run: BOTLINK_IT_SERVER=<server binary> BOTLINK_IT_PG=postgres://botlink@127.0.0.1:<private port> \
 *      BOTLINK_IT_DB=botlink_test_events node --import tsx test/it/e2e-events.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { RealServer, Browser } from "./realserver.js";
import * as ev from "../../src/events.js";

const CLI = join(import.meta.dirname, "..", "..", "dist", "cli.js");
const base = mkdtempSync(join(process.env.BOTLINK_TEST_TMP || tmpdir(), "bl-e2e-events-"));
const srv = new RealServer(8861, { BOTLINK_PUSH_ALLOW_LOOPBACK: "1" });
const RECV_PORT = 8862; // `botlink events serve`
const MCP_RECV_PORT = 8863; // this script's own receiver (stands in for an app that speaks MCP Events)
const results: [string, boolean, string][] = [];
const ck = (name: string, ok: boolean, evd = "") => {
  results.push([name, ok, evd]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${evd ? `\n     ${evd.replace(/\n/g, "\n     ").slice(0, 900)}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
}

function envFor(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLAUDE|CODEX|CURSOR|BOTLINK_|TMUX|OPENCODE|T3CODE)/.test(k)) e[k] = v;
  return { ...e, HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: srv.url, BOTLINK_DEV: "1", BOTLINK_KEYCHAIN: "0", BOTLINK_NO_UPDATE: "1", BOTLINK_NO_HARNESS_CLI: "1", BOTLINK_WAKE_TEST_DELAY_S: "2", BOTLINK_LISTEN_GAP_MS: "500", ...extra };
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
async function joinChat(adam: Browser, invite: string, home: string, name: string, env: Record<string, string>) {
  mkdirSync(home, { recursive: true });
  const j = await run(home, ["join", invite, "--name", name, "--job", `${name} job`], env);
  if (j.code !== 0) throw new Error(`join ${name}: ${j.out}${j.err}`);
  const req = (await adam.needsYou()).join_requests.find((x: any) => x.name === name);
  await adam.approve(req.id);
  const w = await run(home, ["join", "--wait"], env);
  if (w.code !== 0) throw new Error(`join --wait ${name}: ${w.out}${w.err}`);
}

const S_REV = "e2eevents-1111-4222-8333-000000000001";
const S_BLD = "e2eevents-1111-4222-8333-0000000000b0";
const started: ChildProcess[] = [];

async function main() {
  mkdirSync(join(base, "logs"), { recursive: true });
  await srv.start(join(base, "logs"));
  try {
    const adam = await new Browser(srv.url).login("Adam");
    const room = await adam.createRoom("events");
    const invite = await adam.chatInvite(room.id);
    const hR = join(base, "reviewer");
    const hB = join(base, "builder");
    const rEnv = { BOTLINK_APP: "claude-code", CLAUDE_CODE_SESSION_ID: S_REV };
    const bEnv = { BOTLINK_APP: "codex", CODEX_THREAD_ID: S_BLD };
    await joinChat(adam, invite, hR, "reviewer", rEnv);
    await joinChat(adam, invite, hB, "builder", bEnv);
    // the join's own wake test (nothing can wake reviewer yet): read it on a "turn" so the inbox is empty
    await sleep(2500);
    await run(hR, ["inbox"], rEnv);
    await run(hB, ["inbox"], bEnv);
    const label = async (viewerHome: string, env: Record<string, string>, name: string) => {
      const r = await run(viewerHome, ["roster"], env);
      return (r.out.split("\n").find((l) => l.includes(name)) || r.out).trim();
    };
    ck("before: the room does not say reviewer wakes on its own", !/wakes on its own/.test(await label(hB, bEnv, "reviewer")), await label(hB, bEnv, "reviewer"));

    // ---------------------------------------------------------------- A. events serve
    // a URL bot-link's server can't reach is refused, and nothing is subscribed
    const dead = await run(hR, ["events", "subscribe", "--url", "http://127.0.0.1:9/nobody"], rEnv);
    ck("subscribe to a URL nobody answers on: refused in plain words, nothing subscribed", dead.code !== 0 && /didn't pass bot-link's check/.test(dead.err + dead.out) && !/webhook/i.test(dead.err + dead.out), (dead.err + dead.out).trim());
    const priv = await run(hR, ["events", "subscribe", "--url", "http://10.1.2.3/hook"], rEnv);
    ck("a private address is refused", priv.code !== 0 && /public address/.test(priv.err + priv.out), (priv.err + priv.out).trim());

    // the receiver: on an event, run a command that stands in for "this chat gets a turn and reads its inbox"
    const woken = join(hR, "woken.txt");
    const wakeCmd = `'${process.execPath}' '${CLI}' inbox >> '${woken}' 2>&1`;
    const recv = spawn(process.execPath, [CLI, "events", "serve", "--url", `http://127.0.0.1:${RECV_PORT}/hook`, "--port", String(RECV_PORT), "--on-message", wakeCmd], { cwd: hR, env: envFor(hR, rEnv), stdio: ["ignore", "pipe", "pipe"] });
    started.push(recv);
    let recvOut = "";
    recv.stdout!.on("data", (b) => (recvOut += b));
    recv.stderr!.on("data", (b) => (recvOut += b));
    ck("events serve: subscribed after bot-link's signed check, says what it does (no message text in events)", await until(() => /subscription sub_[0-9a-f]{24}/.test(recvOut)) && /Events carry no message text/.test(recvOut), recvOut.trim());
    const list1 = await run(hR, ["events", "list"], rEnv);
    ck("events list: one subscription, on", /sub_[0-9a-f]{24} · message\.received → http:\/\/127\.0\.0\.1:8862\/hook · on/.test(list1.out) && !/whsec_/.test(list1.out), list1.out.trim());

    // builder asks; nobody touches reviewer's side
    const t0 = Date.now();
    const sent = await run(hB, ["send", "--to", "reviewer", "--intent", "question", "--text", "E2E-EVENTS ping: what is 6 x 7?"], bEnv);
    ck("builder sent a question", sent.code === 0, (sent.out + sent.err).slice(0, 200));
    const got = await until(() => existsSync(woken) && /E2E-EVENTS ping: what is 6 x 7\?/.test(readFileSync(woken, "utf-8")));
    ck("reviewer's chat was woken by the event and read the sealed message (no listener, no long-poll)", got, `woken after ${Date.now() - t0} ms\n${existsSync(woken) ? readFileSync(woken, "utf-8").split("\n").filter((l) => /From:|E2E-EVENTS|BEGIN/.test(l)).slice(0, 4).join("\n") : "(no wake)"}`);
    ck("the room now says reviewer wakes on its own", await until(async () => /wakes on its own/.test(await label(hB, bEnv, "reviewer")), 8000), await label(hB, bEnv, "reviewer"));

    // the wake test through the same path
    const st = await run(hR, ["selftest"], rEnv);
    ck("selftest sent", st.code === 0, st.out.trim().slice(0, 300));
    ck("wake test: PASSED (it reached the chat by itself, through the event)", await until(async () => /PASSED/.test((await run(hR, ["selftest", "--result"], rEnv)).out), 15_000), (await run(hR, ["selftest", "--result"], rEnv)).out.trim());

    // forged and replayed requests are refused by the receiver
    const body = JSON.stringify({ eventId: "evt-forged", name: "message.received", timestamp: new Date().toISOString(), data: { member: { id: "x", name: "reviewer" }, waiting: 1 } });
    const ts = String(Math.floor(Date.now() / 1000));
    const forged = await fetch(`http://127.0.0.1:${RECV_PORT}/hook`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": "evt-forged", "webhook-timestamp": ts, "webhook-signature": ev.sign(ev.newSecret(), "evt-forged", ts, body) }, body });
    const unsigned = await fetch(`http://127.0.0.1:${RECV_PORT}/hook`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const before = readFileSync(woken, "utf-8").length;
    await sleep(1200);
    ck("the receiver refuses a forged signature and an unsigned request (401), and nothing runs", forged.status === 401 && unsigned.status === 401 && readFileSync(woken, "utf-8").length === before, `forged ${forged.status} · unsigned ${unsigned.status}`);

    // stop the receiver (by the PID we started): it removes its subscription
    recv.kill("SIGTERM");
    await until(() => recv.exitCode !== null, 10_000);
    const list2 = await run(hR, ["events", "list"], rEnv);
    ck("stopping the receiver removes the subscription", /no event subscriptions/.test(list2.out), list2.out.trim().slice(0, 200));

    // in the background: --detach returns once it is subscribed; status shows it; a second one refuses; stop removes it
    const det = await run(hR, ["events", "serve", "--url", `http://127.0.0.1:${RECV_PORT}/hook`, "--port", String(RECV_PORT), "--on-message", wakeCmd, "--detach"], rEnv);
    const st1 = await run(hR, ["status"], rEnv);
    const det2 = await run(hR, ["events", "serve", "--url", `http://127.0.0.1:${RECV_PORT}/hook`, "--port", String(RECV_PORT), "--detach"], rEnv);
    ck("events serve --detach: runs in the background, status shows it, a second one refuses", det.code === 0 && /Running in the background/.test(det.out) && /events: reviewer in #events · receiver pid \d+ on port 8862/.test(st1.out) && det2.code === 5 && /already running/.test(det2.out), `${det.out.trim().split("\n").slice(-1)[0]}\n${(st1.out.split("\n").find((l) => l.startsWith("events:")) || "").slice(0, 160)}\n${det2.out.trim().slice(0, 160)}`);
    const bad = await run(hR, ["events", "serve", "--url", "http://127.0.0.1:9/none", "--port", "8864", "--detach", "--as", "reviewer"], rEnv);
    ck("--detach on a URL that can't pass the check: says why and leaves nothing running", bad.code === 5 || (bad.code !== 0 && /didn't start/.test(bad.err + bad.out)), (bad.err + bad.out).trim().slice(0, 300));
    // self-healing: the background receiver is killed (SIGKILL, by the PID it reported); the chat's next bot-link call
    // restarts it with the same command and says so; a message then wakes the chat again
    const pid1 = Number((st1.out.match(/receiver pid (\d+) on port 8862/) || [])[1]);
    await run(hR, ["listen", "--stop"], rEnv); // stopping a listener (none here) must not forget the receiver
    process.kill(pid1, "SIGKILL");
    await sleep(500);
    const healed = await run(hR, ["inbox"], rEnv);
    const st2 = await run(hR, ["status"], rEnv);
    const pid2 = Number((st2.out.match(/receiver pid (\d+) on port 8862/) || [])[1]);
    const before2 = readFileSync(woken, "utf-8").length;
    await run(hB, ["send", "--to", "reviewer", "--intent", "question", "--text", "E2E-EVENTS after the receiver was killed"], bEnv);
    const again = await until(() => readFileSync(woken, "utf-8").slice(before2).includes("after the receiver was killed"));
    ck("self-healing: a killed background receiver is restarted by the chat's next bot-link call, and wakes work again", !!pid1 && !!pid2 && pid2 !== pid1 && /event receiver in #events had stopped\. bot-link restarted it/.test(healed.out) && again, `${(healed.out.split("\n").find((l) => /event receiver/.test(l)) || "").slice(0, 220)}\npid ${pid1} → ${pid2}; woken again: ${again}`);
    const stop = await run(hR, ["events", "stop"], rEnv);
    const list3 = await run(hR, ["events", "list"], rEnv);
    const after = await run(hR, ["inbox"], rEnv);
    ck("events stop: the receiver ends, its subscription is removed, and it is not restarted (stopped on purpose)", stop.code === 0 && /Stopped the receiver for reviewer/.test(stop.out) && /no event subscriptions/.test(list3.out) && !/event receiver/.test(after.out) && !/events: reviewer/.test((await run(hR, ["status"], rEnv)).out), stop.out.trim());

    // a one-shot receiver (a background task the app turns into a turn): it fires and exits; a message that lands
    // before the chat re-arms is not lost: re-arming is told at once that messages wait (catch-up)
    const onceArgs = ["events", "serve", "--url", `http://127.0.0.1:${RECV_PORT}/hook`, "--port", String(RECV_PORT), "--once"];
    const once1 = run(hR, onceArgs, rEnv);
    await until(async () => /sub_[0-9a-f]{24}/.test((await run(hR, ["events", "list"], rEnv)).out), 10_000);
    await run(hB, ["send", "--to", "reviewer", "--intent", "question", "--text", "once: first"], bEnv);
    const o1 = await once1;
    await run(hB, ["send", "--to", "reviewer", "--intent", "question", "--text", "once: landed while nothing was armed"], bEnv);
    const tOnce = Date.now();
    const o2 = await run(hR, onceArgs, rEnv);
    ck("events serve --once: exits on the first event; re-armed, it fires at once for what landed in between", o1.code === 0 && /1 new bot-link message for reviewer/.test(o1.out) && o2.code === 0 && /2 new bot-link messages for reviewer/.test(o2.out) && Date.now() - tOnce < 8000, `${o1.out.trim().split("\n").slice(-1)[0]}\n${o2.out.trim().split("\n").slice(-1)[0]}\nre-arm fired after ${Date.now() - tOnce} ms`);
    await run(hR, ["inbox"], rEnv);

    // your own endpoint: the one-file example receiver (client/examples/events-receiver.mjs) + `events subscribe`
    const exSecret = ev.newSecret();
    const example = spawn(process.execPath, [join(import.meta.dirname, "..", "..", "examples", "events-receiver.mjs")], { env: { PATH: process.env.PATH || "", BOTLINK_EVENT_SECRET: exSecret, PORT: "8864" }, stdio: ["ignore", "pipe", "pipe"] });
    started.push(example);
    let exOut = "";
    example.stdout!.on("data", (b) => (exOut += b));
    example.stderr!.on("data", (b) => (exOut += b));
    await until(() => /receiver on http/.test(exOut), 5000);
    const exSub = await run(hR, ["events", "subscribe", "--url", "http://127.0.0.1:8864/", "--secret", exSecret], rEnv);
    await run(hB, ["send", "--to", "reviewer", "--intent", "question", "--text", "for the example receiver"], bEnv);
    const exGot = await until(() => /WAKE reviewer in #events: 1 waiting, newest from builder/.test(exOut));
    const exForged = await fetch("http://127.0.0.1:8864/", { method: "POST", headers: { "content-type": "application/json", "webhook-id": "x", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": ev.sign(ev.newSecret(), "x", Math.floor(Date.now() / 1000), "{}") }, body: "{}" });
    const exUn = await run(hR, ["events", "unsubscribe", "--url", "http://127.0.0.1:8864/"], rEnv);
    ck("the one-file example receiver: `events subscribe` passes its check, it gets the signed event, refuses a forged one; unsubscribe by URL", exSub.code === 0 && /Subscribed: sub_/.test(exSub.out) && !/whsec_/.test(exSub.out) && exGot && exForged.status === 401 && /Removed sub_/.test(exUn.out), `${exOut.trim().split("\n").slice(-1)[0]}\n${exSub.out.trim().split("\n")[0].slice(0, 160)}\n${exUn.out.trim()}`);
    example.kill("SIGTERM");
    await run(hR, ["inbox"], rEnv);

    // ---------------------------------------------------------------- B. MCP Events
    const seen: { headers: Record<string, string>; raw: Buffer; json: any }[] = [];
    const secret = ev.newSecret();
    const app = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const h = req.headers as Record<string, string>;
        if (ev.verify([secret], { id: h["webhook-id"], timestamp: h["webhook-timestamp"], signature: h["webhook-signature"] }, raw) !== "ok") {
          res.writeHead(401).end();
          return;
        }
        const json = JSON.parse(raw.toString("utf-8"));
        seen.push({ headers: h, raw, json });
        if (json.type === "verification") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: json.challenge }));
          return;
        }
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => app.listen(MCP_RECV_PORT, "127.0.0.1", () => r()));
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", "--app", "claude-code"], env: envFor(hR, rEnv), cwd: hR, stderr: "pipe" });
    const client = new Client({ name: "e2e-events", version: "0" });
    await client.connect(transport);
    try {
      const rpc = (method: string, params?: unknown) => client.request({ method, params } as any, z.any());
      // on the wire (the official SDK's client drops capability keys it doesn't know, so ask a raw process)
      const wire = await new Promise<string>((res) => {
        const ch = spawn(process.execPath, [CLI, "mcp", "--app", "claude-code"], { cwd: hR, env: envFor(hR, rEnv), stdio: ["pipe", "pipe", "ignore"] });
        let out = "";
        ch.stdout.on("data", (b) => {
          out += b;
          if (out.includes("\n")) ch.kill("SIGTERM");
        });
        ch.on("exit", () => res(out));
        ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }) + "\n");
        setTimeout(() => ch.kill("SIGTERM"), 8000).unref();
      });
      const caps: any = JSON.parse(wire.split("\n")[0] || "{}")?.result?.capabilities || {};
      ck("MCP: initialize advertises events under both capability keys (the two dialects of the draft)", !!caps.events && !!caps.extensions?.["io.modelcontextprotocol/events"] && !!caps.tools, JSON.stringify(caps));
      const list = await rpc("events/list");
      const names = (list.events || []).map((e: any) => `${e.name}[${e.delivery.join(",")}]`);
      ck("events/list: the catalogue with delivery modes and schemas", list.resultType === "complete" && names.includes("message.received[webhook,poll]") && names.includes("roster.changed[webhook]") && !!list.events[0].inputSchema && !!list.events[0].payloadSchema, names.join(" · "));
      const url = `http://127.0.0.1:${MCP_RECV_PORT}/hooks/e2e`;
      const sub = await rpc("events/subscribe", { name: "message.received", arguments: {}, delivery: { mode: "webhook", url, secret }, ttlMs: 3_600_000 });
      const ver = seen.find((s) => s.json.type === "verification");
      ck("events/subscribe: id, refreshBefore ≈ 1 h, after a signed verification challenge", /^sub_[0-9a-f]{24}$/.test(sub.id) && Math.abs(Date.parse(sub.refreshBefore) - Date.now() - 3_600_000) < 60_000 && !!ver && /^msg_verification_/.test(ver.headers["webhook-id"]) && ver.headers["x-mcp-subscription-id"] === sub.id, JSON.stringify(sub));
      const again = await rpc("events/subscribe", { name: "message.received", arguments: {}, delivery: { mode: "webhook", url, secret }, ttlMs: 3_600_000 });
      ck("subscribing again is a refresh: same id, deliveryStatus.active, no second challenge", again.id === sub.id && again.deliveryStatus?.active === true && seen.filter((s) => s.json.type === "verification").length === 1, JSON.stringify(again));
      await run(hB, ["send", "--to", "reviewer", "--intent", "question", "--text", "E2E-EVENTS second question (secret text)"], bEnv);
      const okEvt = await until(() => seen.some((s) => s.json.name === "message.received"));
      const e = seen.find((s) => s.json.name === "message.received");
      ck("the app's URL got one signed event: webhook-id == eventId, X-MCP-Subscription-Id, ids and names only", okEvt && !!e && e.headers["webhook-id"] === e.json.eventId && e.headers["x-mcp-subscription-id"] === sub.id && e.json.data.from.name === "builder" && e.json.data.member.name === "reviewer" && e.json.data.waiting === 1 && !/secret text/.test(e.raw.toString("utf-8")), e ? e.raw.toString("utf-8") : "(none)");
      // poll (an app with no reachable URL): a null cursor starts from now; the next call reports what waits, once
      const p0 = await rpc("events/poll", { name: "message.received", cursor: null });
      const p1 = await rpc("events/poll", { name: "message.received", cursor: p0.cursor });
      const p2 = await rpc("events/poll", { name: "message.received", cursor: p1.cursor });
      ck("events/poll: nothing on a null cursor, then the waiting message once, then quiet", p0.events.length === 0 && p1.events.length === 1 && p1.events[0].data.waiting === 1 && p2.events.length === 0 && p1.nextPollMs >= 1000, `p0 ${p0.events.length} · p1 ${JSON.stringify(p1.events[0])} · p2 ${p2.events.length}`);
      const errOf = async (method: string, params: unknown) => {
        try {
          await rpc(method, params);
          return 0;
        } catch (x: any) {
          return Number(x?.code);
        }
      };
      const codes = {
        badSecret: await errOf("events/subscribe", { name: "message.received", delivery: { mode: "webhook", url, secret: "hunter2" } }),
        noSuchEvent: await errOf("events/subscribe", { name: "deployment.succeeded", delivery: { mode: "webhook", url, secret } }),
        pushMode: await errOf("events/subscribe", { name: "message.received", delivery: { mode: "push" } }),
        stream: await errOf("events/stream", { name: "message.received" }),
        deadUrl: await errOf("events/subscribe", { name: "message.received", delivery: { mode: "webhook", url: "http://127.0.0.1:9/x", secret } }),
        privateUrl: await errOf("events/subscribe", { name: "message.received", delivery: { mode: "webhook", url: "http://10.1.2.3/x", secret } }),
        rosterPoll: await errOf("events/poll", { name: "roster.changed" }),
      };
      ck("error codes follow the draft (InvalidParams, NotFound, Unsupported, CallbackEndpointError)", codes.badSecret === -32602 && codes.noSuchEvent === -32023 && codes.pushMode === -32026 && codes.stream === -32026 && codes.deadUrl === -32027 && codes.privateUrl === -32602 && codes.rosterPoll === -32026, JSON.stringify(codes));
      await rpc("events/unsubscribe", { name: "message.received", arguments: {}, delivery: { mode: "webhook", url } });
      const twice = await rpc("events/unsubscribe", { name: "message.received", arguments: {}, delivery: { url } });
      const n0 = seen.length;
      await run(hB, ["send", "--to", "reviewer", "--intent", "question", "--text", "after unsubscribe"], bEnv);
      await sleep(1500);
      ck("events/unsubscribe: idempotent, and nothing is sent afterwards", twice.resultType === "complete" && seen.length === n0, `events after unsubscribe: ${seen.length - n0}`);
      // the tools still work next to events (same server, same chat)
      const inbox: any = await client.callTool({ name: "inbox", arguments: {} });
      ck("the same MCP server's inbox tool reads the sealed text", /second question \(secret text\)/.test(JSON.stringify(inbox.content)), JSON.stringify(inbox.content).slice(0, 200));
    } finally {
      await client.close().catch(() => {});
      await new Promise<void>((r) => app.close(() => r()));
    }
  } finally {
    for (const p of started) if (p.exitCode === null) p.kill("SIGTERM"); // by the PIDs we started
    await srv.stop();
  }
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; FAILED: ${failed.map((f) => f[0]).join(" | ")}` : ""}`);
  console.log(`logs: ${join(base, "logs")}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  for (const p of started) if (p.exitCode === null) p.kill("SIGTERM");
  srv.stop().finally(() => process.exit(1));
});
