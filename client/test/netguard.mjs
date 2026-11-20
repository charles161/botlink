// Test network guard (test code only; never in the tarball: netguard.test.ts checks the packed file list).
//
// Loaded into every test process and every process a test starts (NODE_OPTIONS=--import <this file>, set by
// scripts/run-tests.mjs; spawns from a guarded process get it added to their env below). A connection to anything that
// is not loopback (127.0.0.0/8, ::1, localhost) is refused BEFORE it is made: no DNS lookup, no packet. It is recorded
// (BOTLINK_NET_GUARD_LOG, one JSON line per attempt) and, unless BOTLINK_NET_GUARD=record, said on stderr with the
// host. Founder's rule, 17 Nov 2026: no contact with production from this work.
//
// Where it hooks: net.Socket.prototype.connect is the one door for http, https (tls.connect connects its TLSSocket
// through it), raw sockets and fetch (undici opens its sockets with net.connect / tls.connect); dns.lookup for a name
// looked up directly. netguard.test.ts proves fetch, https and a raw socket in this process and fetch in a child.
import { appendFileSync, writeSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const net = require("node:net");
const dns = require("node:dns");
const cp = require("node:child_process");

const SELF = import.meta.url;
const IMPORT = `--import=${SELF}`;

const loopback = (host) => {
  const h = String(host ?? "localhost").toLowerCase().replace(/^\[|\]$/g, "");
  return h === "" || h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
};

function refuse(host, port) {
  const where = `${host}${port !== undefined ? `:${port}` : ""}`;
  // the loud line first and synchronously (fd 2), then the record: whoever sees the record can rely on the line being
  // out already (process.stderr.write to a pipe is asynchronous: a test that stopped the child at the record lost it)
  if (process.env.BOTLINK_NET_GUARD !== "record") {
    const line = `bot-link test network guard: refused a connection to ${where} (tests may only reach loopback: 127.0.0.1, ::1, localhost)\n`;
    try {
      writeSync(2, line);
    } catch {
      process.stderr.write(line);
    }
  }
  try {
    if (process.env.BOTLINK_NET_GUARD_LOG) appendFileSync(process.env.BOTLINK_NET_GUARD_LOG, JSON.stringify({ host: String(host), port: port ?? null, pid: process.pid, argv: process.argv.slice(1, 4), blocked: true, at: Date.now() }) + "\n");
  } catch {
    /* the record is best effort; the refusal is not */
  }
  const e = new Error(`bot-link test network guard: refused a connection to ${where}: tests never reach a real server`);
  e.code = "BOTLINK_NET_GUARD";
  return e;
}

/** host and port of a Socket#connect call (options, [options, cb] as net.connect normalises them, port + host, or a path). */
function target(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];
  if (a && typeof a === "object") return a.path ? null : { host: a.host ?? "localhost", port: a.port };
  if (typeof a === "number" || /^\d+$/.test(String(a))) return { host: typeof args[1] === "string" ? args[1] : "localhost", port: Number(a) };
  return null; // a unix socket path
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const t = target(args);
  if (t && !loopback(t.host)) {
    const err = refuse(t.host, t.port);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return connect.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (!loopback(host)) {
    const cb = rest.find((x) => typeof x === "function");
    const err = refuse(host);
    if (cb) process.nextTick(() => cb(err));
    return {};
  }
  return lookup.call(this, host, ...rest);
};
const plookup = dns.promises.lookup;
dns.promises.lookup = function (host, ...rest) {
  return loopback(host) ? plookup.call(this, host, ...rest) : Promise.reject(refuse(host));
};

// every process a guarded process starts is guarded too, whatever env the caller built
const withGuard = (env) => {
  const base = env || process.env;
  const opts = String(base.NODE_OPTIONS || "");
  return opts.includes(SELF) ? base : { ...base, NODE_OPTIONS: `${opts} ${IMPORT}`.trim() };
};
const optsAt = (args, i) => {
  const o = args[i];
  if (o && typeof o === "object" && !Array.isArray(o)) args[i] = { ...o, env: withGuard(o.env) };
  else if (o === undefined || o === null) args[i] = { env: withGuard(undefined) };
  else args.splice(i, 0, { env: withGuard(undefined) });
  return args;
};
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork"]) {
  const orig = cp[name];
  cp[name] = function (file, ...rest) {
    // (file, args?, options?, cb?)
    const i = Array.isArray(rest[0]) ? 1 : 0;
    if (typeof rest[i] === "function") rest.splice(i, 0, undefined);
    return orig.call(this, file, ...optsAt(rest, i));
  };
}
for (const name of ["exec", "execSync"]) {
  const orig = cp[name];
  cp[name] = function (command, ...rest) {
    if (typeof rest[0] === "function") rest.unshift(undefined);
    return orig.call(this, command, ...optsAt(rest, 0));
  };
}
syncBuiltinESMExports();

if (!String(process.env.NODE_OPTIONS || "").includes(SELF)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} ${IMPORT}`.trim();
globalThis.__botlinkNetGuard = true;
