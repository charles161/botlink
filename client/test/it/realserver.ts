/**
 * Integration harness: the real Go server (server/) on 127.0.0.1:8821-8829 against the PRIVATE dev Postgres
 * (PLAN §2, port 55432, database botlink_test_client — never the shared 5432), plus a scripted "browser" that drives
 * /app/v1 the way the dashboard does (dev login, device key, genesis, approve with a signed roster entry, stub check).
 *   BOTLINK_IT_SERVER=<path to a built server binary>   BOTLINK_IT_PG=postgres://botlink@127.0.0.1:55432
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";

import * as c from "../../src/crypto.js";
import { makeEntry, entryHash, type SignedEntry } from "../../src/roster.js";

export const IT = !!(process.env.BOTLINK_IT_SERVER && process.env.BOTLINK_IT_PG);
const PSQL = "/usr/lib/postgresql/16/bin/psql";
// BOTLINK_IT_DB: another worktree running run-it.sh at the same time uses its own database (botlink_test_* only)
const DB = /^botlink_test_[a-z0-9_]+$/.test(process.env.BOTLINK_IT_DB || "") ? process.env.BOTLINK_IT_DB! : "botlink_test_client";

export function pgUrl(db = DB) {
  const base = process.env.BOTLINK_IT_PG!.replace(/\/+$/, "");
  // only a private dev cluster on this computer: the default port 55432, or another worktree's own (55xxx)
  if (!/^postgres:\/\/[^@]+@127\.0\.0\.1:55\d{3}$/.test(base)) throw new Error("integration tests use only a private dev cluster on 127.0.0.1:55xxx");
  return `${base}/${db}`;
}

export function sql(q: string): string {
  const r = spawnSync(PSQL, [pgUrl(), "-tA", "-c", q], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
}

export class RealServer {
  proc: ChildProcess | null = null;
  /** extra: more server env for one test (e.g. BOTLINK_PUSH_ALLOW_LOOPBACK=1 so events can reach a local receiver) */
  constructor(public port: number, public extra: Record<string, string> = {}) {}
  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  env(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH, HOME: process.env.HOME,
      BOTLINK_ENV: "dev", BOTLINK_ADDR: `127.0.0.1:${this.port}`, BOTLINK_COPY_ID: `C${this.port}`,
      BOTLINK_DATABASE_URL: pgUrl(), BOTLINK_APP_ORIGIN: this.url, BOTLINK_DEV_LOGIN: "1", BOTLINK_HUMAN_CHECK: "stub",
      BOTLINK_METRICS_ADDR: "off", BOTLINK_RETRY_MS: "0", ...this.extra,
    };
  }

  async start(logDir: string): Promise<this> {
    // a fresh database every run (it is the client workstream's own test database)
    const admin = pgUrl("postgres");
    for (const q of [`drop database if exists ${DB} with (force)`, `create database ${DB}`]) {
      const r = spawnSync(PSQL, [admin, "-qc", q], { encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
    }
    const m = spawnSync(process.env.BOTLINK_IT_SERVER!, ["migrate"], { env: this.env(), encoding: "utf-8" });
    if (m.status !== 0) throw new Error(`migrate failed: ${m.stdout}${m.stderr}`);
    const log = openSync(join(logDir, `server-${this.port}.log`), "a");
    this.proc = spawn(process.env.BOTLINK_IT_SERVER!, [], { env: this.env(), stdio: ["ignore", log, log] });
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${this.url}/readyz`);
        if (r.ok) return this;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("server did not become ready");
  }

  async stop() {
    const p = this.proc;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((res) => {
      p.on("exit", () => res());
      p.kill("SIGTERM"); // by the PID we started
      setTimeout(() => p.exitCode === null && p.kill("SIGKILL"), 5000).unref();
    });
  }
}

/** One person in one browser profile. */
export class Browser {
  cookie = "";
  csrf = "";
  account = { id: "", email: "", display_name: "" };
  device = { id: "", seed: "", pk: "" };
  constructor(public base: string) {}

  async call(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cookie) headers.Cookie = this.cookie;
    if (method !== "GET") {
      headers.Origin = this.base;
      headers["Content-Type"] = "application/json";
      if (this.csrf) headers["X-CSRF-Token"] = this.csrf;
    }
    const r = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    const txt = await r.text();
    const j = txt ? JSON.parse(txt) : null;
    if (!r.ok) throw Object.assign(new Error(`${method} ${path} -> ${r.status} ${txt}`), { status: r.status, body: j });
    return j;
  }

  async login(name: string, email?: string): Promise<this> {
    await c.ready();
    const me = await this.call("POST", "/app/v1/auth/dev-login", { email: email || `${name.toLowerCase().replace(/\W/g, "")}-${c.nonceHex().slice(0, 6)}@example.test`, display_name: name });
    this.account = me.account;
    this.csrf = me.csrf_token;
    const seed = c.nonceHex() + c.nonceHex();
    this.device = { id: c.uuidv7(), seed, pk: c.edPkFromSeed(seed) };
    await this.call("POST", "/app/v1/devices", { id: this.device.id, ed25519_pk: this.device.pk, label: "test browser" });
    const me2 = await this.call("GET", `/app/v1/me?device_id=${this.device.id}`);
    this.csrf = me2.csrf_token;
    return this;
  }

  async createRoom(name: string, purpose = ""): Promise<{ id: string; name: string }> {
    const id = c.uuidv7();
    const genesis = makeEntry({ room: id, op: "genesis", name, owner: this.account.id, device: this.device.pk }, 0, null, this.device.pk, this.device.seed);
    await this.call("POST", "/app/v1/rooms", { id, name, purpose, genesis });
    return { id, name };
  }

  async chatInvite(roomId: string): Promise<string> {
    return (await this.call("GET", `/app/v1/rooms/${roomId}/chat-invite`)).url;
  }

  async roster(roomId: string): Promise<SignedEntry[]> {
    return (await this.call("GET", `/app/v1/rooms/${roomId}/roster`)).entries;
  }

  async needsYou(): Promise<any> {
    return this.call("GET", "/app/v1/needs-you");
  }

  async humanCheck(action: string, target: string) {
    const ch = await this.call("POST", "/app/v1/human-check", { action, target_id: target });
    return { id: ch.id, stub: true };
  }

  /** What the dashboard does on Approve: sign member_add (join) / member_rekey (claim) at the current head. */
  async approve(requestId: string): Promise<any> {
    const card = (await this.needsYou()).join_requests.find((x: any) => x.id === requestId);
    if (!card) throw new Error(`no join request ${requestId} in needs-you`);
    const entries = await this.roster(card.room_id);
    const head = entries[entries.length - 1];
    const fields =
      card.kind === "join"
        ? { room: card.room_id, op: "member_add", member: card.member_id, account: this.account.id, name: card.name, app: card.app, ed: card.ed25519_pk, x: card.x25519_pk }
        : { room: card.room_id, op: "member_rekey", member: card.member_id, ed: card.ed25519_pk, x: card.x25519_pk };
    const entry = makeEntry(fields, head.seq + 1, entryHash(head), this.device.pk, this.device.seed);
    return this.call("POST", `/app/v1/join-requests/${requestId}/approve`, { human_check: await this.humanCheck("approve_join", requestId), roster_entry: entry });
  }

  async reject(requestId: string) {
    return this.call("POST", `/app/v1/join-requests/${requestId}/reject`);
  }

  async card(requestId: string): Promise<any> {
    return (await this.needsYou()).join_requests.find((x: any) => x.id === requestId);
  }
}
