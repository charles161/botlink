#!/usr/bin/env node
/**
 * Runs every command bot-link prints that runs the client from a URL, exactly as printed, under each npm major
 * (npm 12, 21 Nov 2026: `allow-remote` defaults to "none" and npx on a tarball URL without --allow-remote ends with EALLOWREMOTE).
 *
 *   cd client && node --import tsx scripts/npm-matrix.mjs [--repo <checkout>] [--out <file>] [--npm 8.19.4,…]
 *        [--port-base 57460] [--cache <dir>] [--deps-cache <npm cache dir>] [--printed <file>] [--no-join]
 *
 * Needs a node that npm 12 supports (^22.22.2 || ^24.15.0 || >=26). Everything runs on 127.0.0.1 except two things:
 * fetching the npm versions themselves (once, into --cache, from registry.npmjs.org) and, only for a dependency that
 * is not in --deps-cache (default: this user's npm cache), that dependency's tarball from registry.npmjs.org.
 *
 *   1. packs the client of --repo (npm pack: dist plus the shrinkwrap, as deploy builds it)
 *   2. serves it the way server/internal/pages/download.go does: /dl/botlink.tgz and /dl/botlink-<16 hex>.tgz (an old
 *      hex redirects), on its own port, so npm 12 never takes it for a registry tarball
 *   3. a local registry serves the client's dependencies at the shrinkwrap's addresses (by integrity)
 *   4. collects the commands from the code, not by hand: the server's invite page (markdown and html), the served
 *      /agents.md and /llms.txt and the join refusal (go test TestPrintedCommandsUseOnePrefix writes them), the
 *      client's selfCmd() and its "out of date, run exactly" lines (asked from an npx-installed copy of the build),
 *      and the URL lines of the READMEs
 *   5. per npm: each command's prefix with --help (fresh HOME and npm cache each run), a probe tarball that prints its
 *      argv (the flag must not reach the client), then the invite's join line and its join --wait line against the
 *      client tests' fake server, with the request approved in between
 * Prints a table, writes JSON to --out (and the table next to it, .txt), exits 1 when a printed command fails.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const REPO = resolve(arg("repo", join(HERE, "..", "..")));
const NPMS = arg("npm", "8.19.4,9.9.4,10.9.11,11.21.3,12.2.3").split(",");
const PORT = Number(arg("port-base", process.env.BOTLINK_TEST_PORT_BASE || 57460));
const CACHE = resolve(arg("cache", join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "botlink-npm-matrix")));
const DEPS_CACHE = resolve(arg("deps-cache", join(homedir(), ".npm")));
const OUT = arg("out", null);
const JOIN = !process.argv.includes("--no-join");
const PROD_URL = "https://api.botlink.dev/dl/botlink.tgz";
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (!(nodeMajor >= 26 || (nodeMajor === 24 && nodeMinor >= 15) || (nodeMajor === 22 && nodeMinor >= 22))) {
  console.error(`npm-matrix: node ${process.versions.node} is not one npm 12 supports; run it with node 24.15+ or 22.22.2+`);
  process.exit(2);
}
const work = mkdtempSync(join(process.env.BOTLINK_TEST_TMP || tmpdir(), "botlink-npm-matrix-"));
const started = [];
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_|BOTLINK_|CLAUDE|CODEX|CURSOR|OPENCODE)/i.test(k)));
const say = (s) => process.stderr.write(`npm-matrix: ${s}\n`);

// ---------------------------------------------------------------- 1. npm versions and the client tarball
function npxOf(v) {
  const cli = join(CACHE, `npm-${v}`, "node_modules", "npm", "bin", "npx-cli.js");
  if (!existsSync(cli)) {
    say(`fetching npm ${v} into ${CACHE}`);
    mkdirSync(dirname(dirname(dirname(dirname(cli)))), { recursive: true });
    writeFileSync(join(CACHE, `npm-${v}`, "package.json"), "{}");
    const r = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", `npm@${v}`], { cwd: join(CACHE, `npm-${v}`), env: { ...cleanEnv(), npm_config_cache: join(CACHE, "fetch-cache") }, encoding: "utf-8" });
    if (r.status !== 0 || !existsSync(cli)) throw new Error(`could not fetch npm ${v}: ${r.stderr}`);
  }
  return cli;
}
const npx = Object.fromEntries(NPMS.map((v) => [v, npxOf(v)]));

say(`packing the client of ${REPO}`);
const packDir = join(work, "pack");
mkdirSync(packDir);
// from a copy: npm pack's prepack cleans and rebuilds dist/, which would pull it from under a test run in the checkout
const packSrc = join(work, "client");
cpSync(join(REPO, "client"), packSrc, { recursive: true, filter: (src) => !/[\\/](node_modules|dist)$/.test(src) });
symlinkSync(join(REPO, "client", "node_modules"), join(packSrc, "node_modules"));
const pack = spawnSync("npm", ["pack", "--pack-destination", packDir, "--loglevel=error"], { cwd: packSrc, env: { ...cleanEnv(), npm_config_offline: "true", npm_config_update_notifier: "false" }, encoding: "utf-8" });
const tgzName = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
if (pack.status !== 0 || !tgzName) throw new Error(`npm pack failed: ${pack.stderr}`);
const tgz = readFileSync(join(packDir, tgzName));
const sha = createHash("sha256").update(tgz).digest("hex");
const hex = sha.slice(0, 16);
const clientVersion = JSON.parse(readFileSync(join(REPO, "client", "package.json"), "utf-8")).version;

// a probe with the client's name that prints the arguments it was given
const probeDir = join(work, "probe");
mkdirSync(join(probeDir, "package", "bin"), { recursive: true });
writeFileSync(join(probeDir, "package", "package.json"), JSON.stringify({ name: "botlink", version: "0.0.0-probe", bin: { botlink: "bin/p.js" } }));
writeFileSync(join(probeDir, "package", "bin", "p.js"), '#!/usr/bin/env node\nconsole.log("ARGV=" + JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
spawnSync("tar", ["czf", join(work, "probe.tgz"), "-C", probeDir, "package"]);
const probe = readFileSync(join(work, "probe.tgz"));

// ---------------------------------------------------------------- 2. /dl, as download.go serves it
const DL = `http://127.0.0.1:${PORT}`;
const PLAIN = `${DL}/dl/botlink.tgz`;
const VERSIONED = `${DL}/dl/botlink-${hex}.tgz`;
const PROBE = `${DL}/dl/probe.tgz`;
const dlLog = [];
const listen = (srv, port) => new Promise((res, rej) => srv.once("error", rej).listen(port, "127.0.0.1", () => (started.push(srv), res())));
await listen(
  createServer((req, res) => {
    dlLog.push(req.url);
    const body = (b, cache) => {
      res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": b.length, "Cache-Control": cache, ETag: `"${sha}"`, "X-Content-Type-Options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : b);
    };
    const m = (req.url || "").match(/^\/dl\/botlink-([0-9a-f]{16})\.tgz$/);
    if (req.url === "/dl/botlink.tgz") return body(tgz, "no-cache");
    if (m && m[1] === hex) return body(tgz, "public, max-age=31536000, immutable");
    if (m) return res.writeHead(302, { Location: `/dl/botlink-${hex}.tgz`, "Cache-Control": "no-store" }).end();
    if (req.url === "/dl/probe.tgz") return body(probe, "no-cache");
    res.writeHead(404).end("not found");
  }),
  PORT,
);

// ---------------------------------------------------------------- 3. the client's dependencies, from a local registry
const REG = `http://127.0.0.1:${PORT + 1}/`;
const lock = JSON.parse(readFileSync(join(REPO, "client", "package-lock.json"), "utf-8"));
const byPath = new Map();
const packuments = new Map(); // name -> packument with the locked versions only
for (const [path, p] of Object.entries(lock.packages)) {
  if (!path || !p.resolved || !p.integrity) continue;
  const tarPath = new URL(p.resolved).pathname;
  byPath.set(tarPath, p.integrity);
  const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const doc = packuments.get(name) || { name, "dist-tags": {}, versions: {} };
  const { dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta, bin, engines, os, cpu } = p;
  doc.versions[p.version] = { name, version: p.version, dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta, bin, engines, os, cpu, dist: { tarball: `${REG.slice(0, -1)}${tarPath}`, integrity: p.integrity } };
  doc["dist-tags"].latest = p.version;
  packuments.set(name, doc);
}
const regLog = { packuments: 0, cache: 0, upstream: 0, missing: [] };
async function depTarball(path) {
  const integrity = byPath.get(path);
  if (!integrity) return null;
  const hexd = Buffer.from(integrity.replace(/^sha512-/, ""), "base64").toString("hex");
  const f = join(DEPS_CACHE, "_cacache", "content-v2", "sha512", hexd.slice(0, 2), hexd.slice(2, 4), hexd.slice(4));
  if (existsSync(f)) return regLog.cache++, readFileSync(f);
  const r = await fetch(`https://registry.npmjs.org${path}`); // anonymous read, only for what the local cache lacks
  if (!r.ok) return null;
  regLog.upstream++;
  return Buffer.from(await r.arrayBuffer());
}
await listen(
  createServer(async (req, res) => {
    const path = decodeURIComponent((req.url || "").split("?")[0]);
    const doc = packuments.get(path.slice(1));
    if (doc) return regLog.packuments++, res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(doc));
    const b = await depTarball(path).catch(() => null);
    if (!b) return regLog.missing.push(req.url), res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": b.length }).end(b);
  }),
  PORT + 1,
);

// ---------------------------------------------------------------- 4a. the server's lines (go test writes them)
const { FakeServer } = await import(join(HERE, "..", "test", "fake-server.ts"));
const c = await import(join(HERE, "..", "src", "crypto.ts"));
await c.ready();
const f = await new FakeServer().start(PORT + 2);
started.push({ close: () => f.stop() });

let printed = arg("printed", null);
if (!printed) {
  printed = join(work, "printed.json");
  const go = existsSync(join(homedir(), ".local", "go", "bin", "go")) ? join(homedir(), ".local", "go", "bin", "go") : "go";
  const r = spawnSync(go, ["test", "./server/internal/pages/", "-run", "TestPrintedCommandsUseOnePrefix", "-count=1"], {
    cwd: REPO,
    env: { ...cleanEnv(), BOTLINK_PRINTED_OUT: printed, BOTLINK_PRINTED_TGZ: join(packDir, tgzName), BOTLINK_PRINTED_BASE: PLAIN },
    encoding: "utf-8",
  });
  if (!existsSync(printed)) throw new Error(`go test wrote no commands:\n${r.stdout}\n${r.stderr}`);
  if (r.status !== 0) say(`go test TestPrintedCommandsUseOnePrefix failed (its lines are still run):\n${r.stdout.slice(-2000)}`);
}
const server = JSON.parse(readFileSync(printed, "utf-8"));
if (server.url !== VERSIONED) throw new Error(`the server names ${server.url}, the tarball here is ${VERSIONED}`);
const commands = server.commands.map((x) => ({ source: `server: ${x.source}`, line: x.line }));

// ---------------------------------------------------------------- 4b. the client's lines (an npx-installed copy is asked)
function askClient(spec) {
  const home = join(work, `ask-${createHash("sha1").update(spec).digest("hex").slice(0, 8)}`);
  const hashDir = join(home, ".npm", "_npx", "c1f4c78d2534a540");
  const root = join(hashDir, "node_modules", "botlink");
  mkdirSync(root, { recursive: true });
  cpSync(join(packSrc, "dist"), join(root, "dist"), { recursive: true });
  cpSync(join(REPO, "client", "package.json"), join(root, "package.json"));
  symlinkSync(join(REPO, "client", "node_modules"), join(root, "node_modules"));
  writeFileSync(join(hashDir, "package.json"), JSON.stringify({ dependencies: { botlink: spec } }));
  const script = join(home, "ask.mjs");
  writeFileSync(
    script,
    `const v = await import(${JSON.stringify(`file://${root}/dist/version.js`)});
const s = await import(${JSON.stringify(`file://${root}/dist/stale.js`)});
const out = { selfCmd: v.selfCmd() };
const h = new Headers({ "x-botlink-client-current": "999.0.0", "x-botlink-client-url": ${JSON.stringify(VERSIONED)} });
try { s.noteServerClient(${JSON.stringify(DL)}, h, true); out.currentCommand = s.currentCommand(["join", "<invite>"]); out.behindLine = s.behindLine(); s.setMcpMode(true); out.mcpLine = s.behindLine();
  out.refusal = s.clientOutdated(${JSON.stringify(DL)}, { message: "x", details: { url: ${JSON.stringify(VERSIONED)}, current_version: "999.0.0" } }).message; } catch (e) { out.staleError = String(e); }
console.log(JSON.stringify(out));`,
  );
  const r = spawnSync(process.execPath, [script], { cwd: home, env: { ...cleanEnv(), HOME: home, BOTLINK_HOME: join(home, ".botlink"), BOTLINK_SERVER: DL, BOTLINK_SELF_INSTALL: "1", BOTLINK_NO_UPDATE: "1" }, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`asking the client failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}
const lineOf = (text) => (text || "").match(/npx -y [^`\n]*?(?= <the command>| --help lists| \(|`|\s{2}|$)/gm) || [];
for (const spec of [VERSIONED, PLAIN]) {
  const a = askClient(spec);
  const tag = spec === VERSIONED ? "run from the versioned URL" : "run from /dl/botlink.tgz";
  commands.push({ source: `client: selfCmd() (${tag})`, line: a.selfCmd });
  for (const k of ["currentCommand", "behindLine", "mcpLine", "refusal"]) for (const l of lineOf(a[k])) commands.push({ source: `client: stale.ts ${k} (${tag})`, line: l });
}

// ---------------------------------------------------------------- 4c. the READMEs' URL lines
for (const doc of ["deploy/public-repo/files/README.md", "client/README.md", "SELF-HOSTING.md"]) {
  if (!existsSync(join(REPO, doc))) continue;
  for (const l of readFileSync(join(REPO, doc), "utf-8").split("\n")) {
    for (const m of l.matchAll(/npx -y [^`\n#]*?https:\/\/api\.botlink\.dev\/dl\/botlink(?:-[0-9a-f]{16})?\.tgz[^`\n#]*/g)) commands.push({ source: `doc: ${doc}`, line: m[0].trim().replace(/https:\/\/api\.botlink\.dev\/dl\/botlink(?:-[0-9a-f]{16})?\.tgz/, PLAIN) });
  }
}

// ---------------------------------------------------------------- 5. run them
/** shell words, as a person's shell splits a printed line (double and single quotes) */
function words(line) {
  const out = [];
  for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
/** prefix: the words up to and including the URL; rest: what the client gets */
function split(line) {
  const w = words(line);
  const i = w.findIndex((x) => /^https?:\/\//.test(x));
  return i < 0 ? null : { prefix: w.slice(0, i + 1), rest: w.slice(i + 1) };
}
let runN = 0;
function fresh() {
  const d = join(work, "runs", String(++runN));
  mkdirSync(join(d, "home"), { recursive: true });
  mkdirSync(join(d, "cache"));
  return d;
}
function run(v, argv, d, extra = {}) {
  if (argv[0] !== "npx") throw new Error(`not an npx line: ${argv.join(" ")}`);
  const env = {
    ...cleanEnv(),
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    HOME: join(d, "home"),
    npm_config_cache: join(d, "cache"),
    npm_config_registry: REG,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    BOTLINK_HOME: join(d, "home", ".botlink"),
    BOTLINK_NO_UPDATE: "1",
    BOTLINK_NO_SELFTEST: "1",
    BOTLINK_KEYCHAIN: "0",
    BOTLINK_NO_HARNESS_CLI: "1",
    BOTLINK_DEV: "1",
    ...extra,
  };
  return new Promise((res) => {
    const p = spawn(process.execPath, [npx[v], ...argv.slice(1)], { cwd: join(d, "home"), env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    const t = setTimeout(() => p.kill(), 180_000);
    p.on("close", (code) => (clearTimeout(t), res({ code, out, err })));
  });
}
const errLine = (r) => (r.err.split("\n").find((l) => /npm (error|ERR!)|EALLOW|Error:|error:/.test(l)) || r.err.split("\n").find(Boolean) || "").replace(work, "<tmp>").trim().slice(0, 160);

const prefixes = new Map(); // prefix line -> sources
for (const cmd of commands) {
  const s = split(cmd.line);
  if (!s) continue;
  const key = s.prefix.join(" ");
  if (!prefixes.has(key)) prefixes.set(key, new Set());
  prefixes.get(key).add(cmd.source);
}
const joinLine = commands.find((x) => x.source === "server: invite page (markdown, for agents)" && / join https?:\/\/\S+\/i\//.test(x.line));
const waitLine = commands.find((x) => x.source === "server: invite page (markdown, for agents)" && / join --wait$/.test(x.line));

const rows = [];
const flagStderr = {};
for (const v of NPMS) {
  for (const [key, sources] of prefixes) {
    const prefix = words(key);
    const d = fresh();
    const r = await run(v, [...prefix, "--help"], d);
    const ok = r.code === 0 && /join/.test(r.out);
    rows.push({ npm: v, step: "--help", command: `${key} --help`, sources: [...sources], exit: r.code, ok, error: ok ? "" : errLine(r) });
    if (key.includes("--allow-remote=all")) flagStderr[v] = r.err.replace(new RegExp(work.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "<tmp>").trim();
    const pd = fresh();
    const pr = await run(v, [...prefix.slice(0, -1), PROBE, "a", "--b"], pd);
    const argv = (pr.out.match(/ARGV=(.*)/) || [])[1] || "";
    const pok = pr.code === 0 && argv === '["a","--b"]';
    rows.push({ npm: v, step: "argv probe", command: `${[...prefix.slice(0, -1), "<probe>"].join(" ")} a --b`, sources: [...sources], exit: pr.code, ok: pok, error: pok ? "" : argv ? `client got ${argv}` : errLine(pr) });
  }
  if (JOIN && joinLine && waitLine) {
    const adam = await f.account("Adam");
    const room = await f.room(adam, `npm${v.split(".")[0]}x${Math.floor(Math.random() * 1e6)}`, "matrix");
    const invite = `http://localhost:8811/i/${f.invite(room, adam)}`;
    const s = split(joinLine.line);
    const rest = s.rest.map((x) => (/^https?:\/\/\S+\/i\//.test(x) ? invite : x === "<name>" ? `m${v.split(".")[0]}` : x === "<job>" ? "checks the npm matrix" : x));
    const d = fresh(); // one computer: join and join --wait share HOME and npm cache, as a chat's turns do
    const app = { BOTLINK_SERVER: f.url, OPENCODE: "1", OPENCODE_PID: "4242" };
    const before = f.pending().length;
    const j = await run(v, [...s.prefix, ...rest], d, app);
    const pend = f.pending().slice(before);
    const jok = j.code === 0 && pend.length === 1;
    rows.push({ npm: v, step: "join (invite page line)", command: [...s.prefix, ...rest].join(" "), sources: [joinLine.source], exit: j.code, ok: jok, error: jok ? "" : errLine(j) || j.out.split("\n").slice(-3).join(" ").slice(0, 160) });
    if (jok) f.approve(pend[0].id);
    const w = jok ? await run(v, words(waitLine.line), d, app) : { code: null, out: "", err: "not run: the join failed" };
    const wok = w.code === 0 && /approved|You're in|joined/i.test(w.out + w.err);
    rows.push({ npm: v, step: "join --wait (invite page line)", command: waitLine.line, sources: [waitLine.source], exit: w.code, ok: wok, error: wok ? "" : errLine(w) || w.out.split("\n").slice(-3).join(" ").slice(0, 160) });
  }
}

// ---------------------------------------------------------------- report
const head = `npm matrix · client ${clientVersion} (${tgzName}, sha256 ${hex}…) from ${REPO} · node ${process.versions.node} · ${new Date().toISOString()}`;
const table = [head, "", "commands collected from the code:", ...commands.map((x) => `  [${x.source}] ${x.line}`), "", "npm      step                            exit  ok    command / error"];
for (const r of rows) table.push(`${r.npm.padEnd(8)} ${r.step.padEnd(31)} ${String(r.exit).padEnd(5)} ${r.ok ? "PASS " : "FAIL "} ${r.command}${r.error ? `\n${" ".repeat(53)}-> ${r.error}` : ""}`);
table.push("", "stderr of the flagged --help run, per npm (what a person sees besides the help):");
for (const [v, e] of Object.entries(flagStderr)) table.push(`  npm ${v}: ${e ? JSON.stringify(e) : "(empty)"}`);
const fails = rows.filter((r) => !r.ok).length;
table.push("", `local registry: ${regLog.packuments} packuments, dependency tarballs from the local npm cache: ${regLog.cache}, from registry.npmjs.org: ${regLog.upstream}, not found: ${regLog.missing.length}${regLog.missing.length ? ` (${[...new Set(regLog.missing)].slice(0, 5).join(", ")})` : ""}`, `${rows.length} runs, ${rows.length - fails} pass, ${fails} fail`);
const text = table.join("\n");
console.log(text);
if (OUT) {
  writeFileSync(OUT, JSON.stringify({ head, client: { version: clientVersion, sha256: sha }, node: process.versions.node, commands, rows, flagStderr, registry: regLog }, null, 2));
  writeFileSync(OUT.replace(/\.json$/, "") + ".txt", text + "\n");
}
for (const s of started) await s.close();
if (!process.env.BOTLINK_KEEP_TEST_TMP) rmSync(work, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
