/**
 * Self-update (SPEC §7.6). Installed apps launch bot-link from ONE stable path, `~/.botlink/client/current/dist/cli.js`,
 * where `current` is a symlink to a versioned install `~/.botlink/client/<version>-<id>/`. A background check asks the
 * server for the signed release manifest (`GET <server>/dl/botlink.manifest.json`, release.ts), refuses it unless a
 * release key pinned in this client signed it and its counter is not below one already accepted (no rollback), then
 * downloads `/dl/botlink.tgz`, refuses it unless it is exactly the tarball the manifest names (sha256, size, name,
 * version), unpacks it next to the old one and swaps `current` atomically (rename of a symlink). The server and
 * everything in front of it can withhold an update; they cannot make a client run code that was not signed.
 *
 * Never mid-session: Node resolves the main script's symlinks at start, so a running process keeps loading from the
 * version directory it started in (old directories are kept for a week). New processes (the app's next restart, the
 * next hook run) use the new copy. The running MCP server tells the model once: "bot-link updated …; restart".
 *
 * Off with BOTLINK_NO_UPDATE=1; never against a loopback server unless BOTLINK_DEV=1; at most every 6 h
 * (BOTLINK_UPDATE_EVERY_S); one updater at a time (client/update.lock). A failed attempt changes nothing, is recorded
 * (`last` in update.json: when, from what to what, a plain reason) and waits for the throttle: `botlink status` shows it,
 * a chat hears it once (restartNotice), and the next good update clears it (updatenote.ts).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { homeDir } from "./config.js";
import { MANIFEST_PATH, verifyManifest, type Manifest } from "./release.js";
import { hostAllowed } from "./hosts.js";
import { PACKAGE_NAMES, PKG_ROOT, VERSION, fileOfSpec, installSpec, knownServer, originFromSpec } from "./version.js";
import { problemNotice } from "./updatenote.js";
import { serverFetch } from "./net.js";

const MAX_TGZ = 20 * 1024 * 1024;
const KEEP_OLD_MS = 7 * 86400_000;

export const clientDir = () => join(homeDir(), "client");
export const currentDir = () => join(clientDir(), "current");
/** What harness configs launch: never an npx cache path. */
export const shimCli = () => join(currentDir(), "dist", "cli.js");
const statePath = () => join(clientDir(), "update.json");

export interface UpdateState {
  checked_at?: number;
  spawned_at?: number;
  server_sha?: string;
  server_version?: string;
  installed?: { version: string; sha256: string; dir: string; at: number };
  /** the highest release counter this computer accepted, and the tarball it named (rollback guard) */
  counter?: number;
  counter_sha?: string;
  error?: string;
  /** the last update attempt (shown by `botlink status` and once to a chat, updatenote.ts); a good one replaces a failed one */
  last?: UpdateAttempt;
  /** when an attempt last ended well (installed, or already up to date) */
  last_ok_at?: number;
  /** the server answered 426 client_too_old (tooold.ts); cleared by the next good update */
  too_old?: { at: number; need?: string; server: string };
  /** when the server's "too old" answer last started an update (at most one per 30 min, never cleared) */
  too_old_update_at?: number;
}

/** Why an update did not happen, in the words a person can act on. */
export type UpdateReason = "network" | "unsigned" | "signature" | "older" | "disk" | "permission" | "other";
export interface UpdateAttempt {
  at: number;
  /** what was installed when it ran ("1.0.0-dev (ab12cd34)") */
  from: string;
  /** what the server offered, when that was known */
  to?: string;
  ok: boolean;
  reason?: UpdateReason;
  /** the technical reason, for a person who asks */
  detail?: string;
}

/** Sort a failure's technical reason into one a person can act on. */
export function reasonOf(why: string): UpdateReason {
  if (/\b(ENOSPC|EDQUOT)\b|no space left/i.test(why)) return "disk";
  if (/\b(EACCES|EPERM|EROFS)\b|permission denied|read-only file system/i.test(why)) return "permission";
  if (/published no signed release/.test(why)) return "unsigned";
  if (/older than the one this computer|same release number/.test(why)) return "older";
  if (/^(check|download): /.test(why)) return "network";
  if (/signature|not signed|signed release can't|sha256 mismatch|not the release that was signed|too big|links or special files|unexpected path|not the bot-link client|no package\.json/.test(why)) return "signature";
  return "other";
}

export function loadState(): UpdateState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf-8"));
  } catch {
    return {};
  }
}
function saveState(s: UpdateState) {
  mkdirSync(clientDir(), { recursive: true, mode: 0o700 });
  const tmp = `${statePath()}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, statePath());
}
/** Merge fields into the update state (best effort: a full disk or a read-only folder must not break the caller). */
export function patchState(p: Partial<UpdateState>): boolean {
  try {
    saveState({ ...loadState(), ...p });
    return true;
  } catch {
    return false;
  }
}

/** What is installed now, for the attempt record: "<version> (<sha8>)". */
function installedLabel(): string {
  const cur = real(currentDir());
  let version = VERSION;
  try {
    if (cur) version = JSON.parse(readFileSync(join(cur, "package.json"), "utf-8")).version || VERSION;
  } catch {
    /* keep this copy's */
  }
  const sha = cur ? installSha(cur) : "";
  return `${safeVersion(String(version))}${sha ? ` (${sha.slice(0, 8)})` : ""}`;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/** How this copy runs: from an install under ~/.botlink/client, from an npx cache / the old ~/.botlink/app copy, or a checkout. */
export function runKind(): "client" | "npx" | "checkout" {
  const root = real(PKG_ROOT) || PKG_ROOT;
  const cd = real(clientDir());
  if (cd && inside(root, cd)) return "client";
  if (/[\\/]_npx[\\/]/.test(PKG_ROOT) || process.env.BOTLINK_SELF_INSTALL === "1") return "npx";
  const legacy = real(join(homeDir(), "app"));
  if (legacy && inside(root, legacy)) return "npx";
  return "checkout";
}

/** sha256 of the tarball an install came from ("" when it came from an npx copy). */
export function installSha(dir: string): string {
  try {
    return readFileSync(join(dir, ".sha256"), "utf-8").trim();
  } catch {
    return "";
  }
}

/** The release counter an install was made from (0 when it came from an npx copy or an older client). */
export function installCounter(dir: string | null): number {
  if (!dir) return 0;
  try {
    const n = Number(readFileSync(join(dir, ".counter"), "utf-8").trim());
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** The release number of the install at dir (its real path): 0 = none (a checkout, an npm install, an npx copy). */
export const releaseOf = (dir: string) => installCounter(real(dir) || dir);

let releaseMemo: number | null = null;
/**
 * The release number of the copy that runs now, sent with every agent API call (X-Botlink-Client-Release; the
 * server's minimum client release, SPEC §7.6). It is the signed manifest's counter this copy was installed from, so
 * it never changes while the process runs. 0 = none: a checkout, a global npm install, or an npx copy before its
 * first signed update.
 */
export function runningRelease(): number {
  if (releaseMemo === null) releaseMemo = releaseOf(PKG_ROOT);
  return releaseMemo;
}
export function setRunningReleaseForTests(n: number | null) {
  releaseMemo = n;
}

function distHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const fp = join(d, f.name);
      if (f.isDirectory()) walk(fp);
      else h.update(f.name).update(readFileSync(fp));
    }
  };
  try {
    walk(dir);
  } catch {
    return "x";
  }
  return h.digest("hex").slice(0, 12);
}

const safeVersion = (v: string) => (/^[0-9A-Za-z.+-]{1,40}$/.test(v) ? v : "0.0.0");

/**
 * Point `current` at dir (relative link, atomic rename over the old link).
 *
 * The rename alone is not enough on ext4: when it removes the last name of the old link, another process that is
 * halfway through a path walk via that link (`current/dist/cli.js`) can fail with ENOENT (measured on this kernel:
 * about 1 walk in 50,000 swaps; never on tmpfs, never on `current` itself). So the old link keeps a second name,
 * `.previous-current`, until the next swap; with it, 0 misses in 570,000 swaps.
 */
export function swapCurrent(dir: string) {
  mkdirSync(clientDir(), { recursive: true, mode: 0o700 });
  const tmp = join(clientDir(), `.current.${process.pid}.${randomBytes(4).toString("hex")}`);
  const prev = join(clientDir(), ".previous-current");
  symlinkSync(basename(dir), tmp);
  try {
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(currentDir());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // no `current` yet: nothing to move aside or keep
    }
    // an old non-link `current` (shouldn't exist) would make rename fail on a directory: move it aside first
    if (st && !st.isSymbolicLink()) renameSync(currentDir(), `${currentDir()}.old.${Date.now()}`);
    else if (st) {
      try {
        rmSync(prev, { force: true });
        linkSync(currentDir(), prev); // link(2) names the symlink itself; it does not follow it
      } catch {
        /* a filesystem without hard links: swap anyway */
      }
    }
    renameSync(tmp, currentDir());
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    throw e;
  }
}

/** The node_modules this copy runs with (its own folder, or the npx cache's flat node_modules around it). */
function copyDepsFrom(root: string, dst: string): boolean {
  const own = join(root, "node_modules");
  if (existsSync(own)) {
    cpSync(own, join(dst, "node_modules"), { recursive: true, dereference: true });
    return true;
  }
  if (basename(dirname(root)) === "node_modules") {
    cpSync(dirname(root), join(dst, "node_modules"), { recursive: true, dereference: true, filter: (s) => !inside(s, root) });
    return true;
  }
  return false;
}

/**
 * Install THIS running copy as a version dir (from npx / the old ~/.botlink/app) and make it `current` when there is
 * no usable `current` yet. Returns the stable root (~/.botlink/client/current). Used by harnesses.appRoot().
 */
export function installSelf(): string {
  const cur = real(currentDir());
  if (cur && existsSync(join(cur, "dist", "cli.js"))) return currentDir();
  const id = `${safeVersion(VERSION)}-${distHash(join(PKG_ROOT, "dist"))}`;
  const dst = join(clientDir(), id);
  if (!existsSync(join(dst, "dist", "cli.js"))) {
    const tmp = join(clientDir(), `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    try {
      for (const part of ["dist", "package.json"]) cpSync(join(PKG_ROOT, part), join(tmp, part), { recursive: true, dereference: true });
      copyDepsFrom(PKG_ROOT, tmp);
      const spec = installSpec();
      if (spec) writeFileSync(join(tmp, ".source"), spec + "\n");
      rmSync(dst, { recursive: true, force: true });
      renameSync(tmp, dst);
      chmodSync(dst, 0o700);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }
  swapCurrent(dst);
  return currentDir();
}

// ---------------------------------------------------------------- the check
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

/** Where this client updates from: BOTLINK_UPDATE_ORIGIN, the tarball's origin it came from, the server it talks to
 *  (BOTLINK_SERVER, the saved server, its members' server), else production; "" for a copy installed from a file on
 *  this computer that knows no server (it never pulls production's client by guess: staging tester, 17 Nov 2026). */
export function updateOrigin(): string {
  const env = (process.env.BOTLINK_UPDATE_ORIGIN || "").trim();
  if (/^https?:\/\//.test(env)) return env.replace(/\/+$/, "");
  const spec = installSpec();
  const origin = originFromSpec(spec);
  if (origin) return origin;
  const server = knownServer();
  if (server) return server;
  return fileOfSpec(spec) ? "" : "https://api.botlink.dev";
}

/** null = updating is allowed here; else why not. */
export function updateBlocked(): string | null {
  if (process.env.BOTLINK_NO_UPDATE === "1") return "BOTLINK_NO_UPDATE=1";
  // a global npm install (`npm install -g @botlink/cli`) runs like a checkout: npm updates it, not bot-link (PUBLISHING.md)
  if (runKind() === "checkout") return /[\\/]node_modules[\\/]/.test(PKG_ROOT) ? "installed with npm, so npm updates it (npm install -g @botlink/cli@latest)" : "running from a checkout";
  const origin = updateOrigin();
  if (!origin) return "installed from a file on this computer, and bot-link doesn't know which server to update from";
  if (isLoopback(origin)) return process.env.BOTLINK_DEV === "1" ? null : "local server";
  if (!/^https:\/\//i.test(origin)) return "the update address is not https";
  if (!hostAllowed(origin).ok) return "the update address is not bot-link's";
  return null;
}

export const everyMs = () => {
  const s = Number(process.env.BOTLINK_UPDATE_EVERY_S);
  return (Number.isFinite(s) && s >= 0 ? s : 6 * 3600) * 1000;
};

export function due(now = Date.now()): boolean {
  const s = loadState();
  if (s.checked_at && now - s.checked_at < everyMs()) return false;
  if (s.spawned_at && now - s.spawned_at < Math.min(everyMs(), 10 * 60_000)) return false;
  return true;
}

/** From a long-lived process (MCP server, SessionStart hook): run the check in a detached child (old code), if due. */
export function maybeSpawnCheck(): boolean {
  if (updateBlocked() || !due()) return false;
  try {
    saveState({ ...loadState(), spawned_at: Date.now() });
    const child = spawn(process.execPath, [join(PKG_ROOT, "dist", "cli.js"), "update", "--background"], { detached: true, stdio: "ignore", env: process.env });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// one updater at a time (async-safe lockfile; stale when its pid is gone or after 15 min)
function tryLock(): (() => void) | null {
  mkdirSync(clientDir(), { recursive: true, mode: 0o700 });
  const lf = join(clientDir(), "update.lock");
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(lf, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lf);
        } catch {
          /* gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        const l = JSON.parse(readFileSync(lf, "utf-8"));
        let alive = true;
        try {
          process.kill(Number(l.pid), 0);
        } catch (err: any) {
          alive = err?.code === "EPERM";
        }
        stale = !alive || Date.now() - Number(l.at) > 15 * 60_000;
      } catch {
        stale = Date.now() - statSync(lf).mtimeMs > 60_000;
      }
      if (!stale) return null;
      try {
        unlinkSync(lf);
      } catch {
        /* someone else did */
      }
    }
  }
  return null;
}

export type UpdateResult =
  | { status: "skipped"; why: string }
  | { status: "busy" }
  | { status: "offline"; why: string }
  | { status: "current"; version: string; sha256: string }
  | { status: "refused"; why: string }
  /** something on this computer stopped it (the disk is full, a folder is not writable) */
  | { status: "failed"; why: string }
  | { status: "updated"; version: string; sha256: string; dir: string };

async function fetchT(url: string, ms: number): Promise<Response> {
  return serverFetch(url, { signal: AbortSignal.timeout(ms), headers: { "user-agent": `botlink/${VERSION}` } });
}

/** List a tarball and refuse anything but plain files/dirs under package/ (no links, no absolute paths, no ..). */
function tarballProblem(tgz: string): string | null {
  const r = spawnSync("tar", ["-tzvf", tgz], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return "not a readable tarball";
  const names = spawnSync("tar", ["-tzf", tgz], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  if (names.status !== 0) return "not a readable tarball";
  for (const line of r.stdout.split("\n").filter(Boolean)) if (!/^[-d]/.test(line)) return "the tarball has links or special files";
  for (const n of names.stdout.split("\n").filter(Boolean)) {
    if (!n.startsWith("package/") || n.split("/").includes("..") || n.includes("\\")) return `unexpected path in the tarball: ${n.slice(0, 80)}`;
  }
  return null;
}

const depsOf = (pj: any) => JSON.stringify(Object.entries(pj?.dependencies || {}).sort());

/**
 * Check the server and install what it serves if it differs from `current`. The process keeps running its own code.
 * opts.force: ignore the 6 h throttle (CLI `botlink update`, `up`).
 */
export async function runUpdate(opts: { force?: boolean } = {}): Promise<UpdateResult> {
  const blocked = updateBlocked();
  if (blocked) return { status: "skipped", why: blocked };
  if (!opts.force && !due()) return { status: "skipped", why: "checked recently" };
  // every attempt that does not end well is recorded (`last`, shown by `botlink status`) and waits for the throttle
  // (checked_at): a failure is never retried in a loop
  let from = "";
  let to: string | undefined;
  const fail = (status: "offline" | "refused" | "failed", why: string): UpdateResult => {
    const at = Date.now();
    // "check: …" = the signed manifest could not be fetched; "download: …" = the tarball or its dependencies
    const check = status === "offline" && !why.startsWith("download:");
    const last: UpdateAttempt = { at, from: from || installedLabel(), ...(to ? { to } : {}), ok: false, reason: reasonOf(check ? `check: ${why}` : why), detail: why.slice(0, 200) };
    patchState({ checked_at: at, error: `${check ? "check" : status === "failed" ? "failed" : "refused"}: ${why}`.slice(0, 200), last });
    return { status, why };
  };
  let unlock: (() => void) | null;
  try {
    unlock = tryLock();
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return fail("failed", `${err.code ? `${err.code}: ` : ""}${err.message}`);
  }
  if (!unlock) return { status: "busy" };
  const state = loadState();
  try {
    from = installedLabel();
    const origin = updateOrigin();
    let doc: unknown;
    try {
      const r = await fetchT(`${origin}${MANIFEST_PATH}`, 15_000);
      if (r.status === 404) {
        // a server that publishes no signed release: nothing to install, and never a fallback to an unsigned one
        return fail("refused", "the release is not signed (the server published no signed release)");
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      doc = await r.json();
    } catch (e) {
      return fail("offline", (e as Error).message);
    }
    const refuse = (why: string): UpdateResult => fail("refused", why);
    const v = verifyManifest(doc);
    if (!v.ok) return refuse(v.why);
    const m = v.m;
    const sha = m.sha256;
    const version = safeVersion(m.version);
    to = `${version} (${sha.slice(0, 8)})`;
    const cur = real(currentDir());
    const curSha = cur ? installSha(cur) : "";
    const ownRoot = real(PKG_ROOT) || PKG_ROOT;
    const ownSha = installSha(ownRoot);
    // no rollback: the counter never goes below the highest this computer accepted (remembered in the update state
    // AND in each install, so losing one of them changes nothing)
    const floor = Math.max(state.counter || 0, installCounter(cur), installCounter(ownRoot));
    if (m.counter < floor) return refuse(`this release (number ${m.counter}) is older than the one this computer already has (${floor})`);
    const floorSha = state.counter === floor && state.counter_sha ? state.counter_sha : installCounter(cur) === floor ? curSha : "";
    if (m.counter === floor && floorSha && floorSha !== sha) return refuse(`a different release was signed with the same release number (${m.counter})`);
    const okAt = Date.now();
    // a good attempt replaces a failed one, and ends a "too old" answer from the server
    const base: UpdateState = { ...state, checked_at: okAt, server_sha: sha, server_version: version, counter: m.counter, counter_sha: sha, error: undefined, last: { at: okAt, from, to, ok: true }, last_ok_at: okAt, too_old: undefined };
    if (curSha === sha || (!cur && ownSha === sha)) {
      saveState(base);
      return { status: "current", version, sha256: sha };
    }
    const dst = join(clientDir(), `${version}-${sha.slice(0, 12)}`);
    if (!existsSync(join(dst, "dist", "cli.js")) || installSha(dst) !== sha) {
      const why = await download(origin, m, dst);
      if (why) {
        patchState({ server_sha: sha, server_version: version });
        return fail(why.startsWith("download:") ? "offline" : "refused", why);
      }
    }
    swapCurrent(dst);
    prune(dst);
    const installed = { version, sha256: sha, dir: dst, at: Date.now() };
    saveState({ ...base, installed });
    return { status: "updated", version, sha256: sha, dir: dst };
  } catch (e) {
    // the disk is full, a folder is not writable, …: recorded like any other failure, nothing half-installed
    const err = e as NodeJS.ErrnoException;
    return fail("failed", `${err?.code ? `${err.code}: ` : ""}${err?.message || String(e)}`);
  } finally {
    unlock();
  }
}

/** Download, verify, unpack, add dependencies -> null, or why it was refused (nothing is left behind). */
async function download(origin: string, m: Manifest, dst: string): Promise<string | null> {
  const sha = m.sha256;
  mkdirSync(clientDir(), { recursive: true, mode: 0o700 });
  const work = join(clientDir(), `.dl-${process.pid}-${randomBytes(4).toString("hex")}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    let buf: Buffer;
    try {
      const r = await fetchT(`${origin}/dl/botlink.tgz`, 120_000);
      if (!r.ok) return `download: HTTP ${r.status}`;
      const len = Number(r.headers.get("content-length") || 0);
      if (len > MAX_TGZ) return "the tarball is too big";
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      return `download: ${(e as Error).message}`;
    }
    if (buf.length > MAX_TGZ) return "the tarball is too big";
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== sha) return `sha256 mismatch (got ${got.slice(0, 12)}…, the signed release names ${sha.slice(0, 12)}…)`;
    if (buf.length !== m.size) return "the tarball is not the release that was signed (size)";
    const tgz = join(work, "botlink.tgz");
    writeFileSync(tgz, buf, { mode: 0o600 });
    const bad = tarballProblem(tgz);
    if (bad) return bad;
    const x = spawnSync("tar", ["-xzf", tgz, "-C", work, "--no-same-owner"], { encoding: "utf-8" });
    if (x.status !== 0) return `the tarball didn't unpack (${(x.stderr || "").trim().slice(-120)})`;
    const pkg = join(work, "package");
    let pj: any;
    try {
      pj = JSON.parse(readFileSync(join(pkg, "package.json"), "utf-8"));
    } catch {
      return "the tarball has no package.json";
    }
    if (!PACKAGE_NAMES.includes(pj?.name) || !existsSync(join(pkg, "dist", "cli.js"))) return "the tarball is not the bot-link client";
    if (pj.name !== m.name || String(pj.version) !== m.version) return "the tarball is not the release that was signed (name or version)";
    // dependencies: same list as a copy we have -> copy its node_modules; else npm install (production deps only)
    let ownPj: any = null;
    try {
      ownPj = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));
    } catch {
      /* none */
    }
    const cur = real(currentDir());
    let curPj: any = null;
    try {
      curPj = cur ? JSON.parse(readFileSync(join(cur, "package.json"), "utf-8")) : null;
    } catch {
      /* none */
    }
    const noDeps = !Object.keys(pj.dependencies || {}).length;
    const copied = noDeps || (curPj && cur && depsOf(curPj) === depsOf(pj) && copyDepsFrom(cur, pkg)) || (ownPj && depsOf(ownPj) === depsOf(pj) && copyDepsFrom(real(PKG_ROOT) || PKG_ROOT, pkg));
    if (!copied) {
      const npm = process.env.BOTLINK_NPM || "npm";
      // a release carries npm-shrinkwrap.json (every dependency at one version, with its integrity hash): `npm ci`
      // installs exactly that or fails. Without one (an older release): production dependencies, no install scripts.
      const locked = existsSync(join(pkg, "npm-shrinkwrap.json"));
      const args = locked ? ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"] : ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"];
      const i = spawnSync(npm, args, { cwd: pkg, encoding: "utf-8", timeout: 300_000 });
      if (i.status !== 0) return `download: npm install failed (${(i.stderr || "").trim().slice(-120)})`;
    }
    writeFileSync(join(pkg, ".sha256"), sha + "\n", { mode: 0o600 });
    writeFileSync(join(pkg, ".counter"), `${m.counter}\n`, { mode: 0o600 });
    rmSync(dst, { recursive: true, force: true });
    renameSync(pkg, dst);
    chmodSync(dst, 0o700);
    return null;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Drop version dirs that aren't current, the running one or the newest previous, and are older than a week. */
function prune(keep: string) {
  const own = real(PKG_ROOT);
  let dirs: { p: string; m: number }[] = [];
  try {
    dirs = readdirSync(clientDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => ({ p: join(clientDir(), d.name), m: statSync(join(clientDir(), d.name)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch {
    return;
  }
  const others = dirs.filter((d) => d.p !== keep && d.p !== own && !(own && inside(own, d.p)));
  for (const d of others.slice(1)) if (Date.now() - d.m > KEEP_OLD_MS) rmSync(d.p, { recursive: true, force: true });
}

// ---------------------------------------------------------------- telling the model (once per process)
let told = false;
let toldProblem = 0;

/**
 * The line to add to the next tool result: when `current` is newer than this running copy (once per process), and
 * when the last update did not end well in a way the human should hear about (once per failed attempt and process).
 */
export function restartNotice(appLabel: string): string | null {
  const parts = [newerNotice(appLabel)];
  try {
    const p = problemNotice(loadState(), Date.now(), { clientDir: clientDir() });
    if (p && p.key !== toldProblem) {
      toldProblem = p.key;
      parts.push(p.text);
    }
  } catch {
    /* nothing to say */
  }
  const out = parts.filter((x): x is string => !!x);
  return out.length ? out.join("\n") : null;
}

/** `current` is newer than this running copy: say so once per process. */
function newerNotice(appLabel: string): string | null {
  if (told || runKind() === "checkout") return null;
  const cur = real(currentDir());
  const own = real(PKG_ROOT);
  if (!cur || !own || cur === own || !existsSync(join(cur, "dist", "cli.js"))) return null;
  let version = "";
  try {
    version = JSON.parse(readFileSync(join(cur, "package.json"), "utf-8")).version || "";
  } catch {
    /* unknown */
  }
  const sha = installSha(cur);
  told = true;
  return `bot-link updated${version ? ` to ${version}` : ""}${sha ? ` (${sha.slice(0, 8)})` : ""}. Tell your human: "bot-link updated, restart ${appLabel} to apply." This chat keeps the version it started with until then.`;
}

export function resetToldForTests() {
  told = false;
  toldProblem = 0;
}

/** A newer install than this running copy is in place (an update finished; the app has not restarted yet). */
export function newerInstalled(): boolean {
  if (runKind() !== "client") return false;
  const cur = real(currentDir());
  const own = real(PKG_ROOT);
  return !!cur && !!own && cur !== own && existsSync(join(cur, "dist", "cli.js"));
}

/** Exit code of a long-running part (a supervised listener, watch) that stops so it is started again on the copy an
 *  update installed: its supervisor, or the service manager, starts it again through the stable path. */
export const RESTART_FOR_UPDATE = 75;

/**
 * A newer install than this running copy is in place, and starting this process again the way it was started runs
 * that one: it was started through the stable path (`current/dist/cli.js`), which Node resolves at start. A process
 * started from a version folder itself would start the old copy again, so it is never restarted for this.
 */
export function restartPicksNewer(argv1 = process.argv[1] || ""): boolean {
  if (!newerInstalled()) return false;
  return argv1 === shimCli() || inside(argv1, currentDir());
}

/** The target `current` points at (relative name), or null. */
export function currentTarget(): string | null {
  try {
    return readlinkSync(currentDir());
  } catch {
    return null;
  }
}

/**
 * An npx copy never updates itself: npx keeps the first tarball it fetched for a URL (real-world run 2026-11-07: three
 * chats kept the old client after a new tarball was published at the same URL). From an npx copy the CLI runs the
 * throttled update check (same as the MCP server / hooks) and, once a newer install exists under
 * ~/.botlink/client/current, hands the command to it. null: keep running this copy.
 */
export function newerInstallCli(): string | null {
  if (runKind() !== "npx" || process.env.BOTLINK_NO_HANDOFF === "1") return null;
  try {
    maybeSpawnCheck();
    const cur = real(currentDir());
    const cli = cur ? join(cur, "dist", "cli.js") : "";
    if (!cur || !existsSync(cli) || inside(real(PKG_ROOT) || PKG_ROOT, cur)) return null;
    return statSync(cur).mtimeMs > statSync(PKG_ROOT).mtimeMs ? cli : null;
  } catch {
    return null;
  }
}
