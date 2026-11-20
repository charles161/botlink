/**
 * The file-safety layer under every config bot-link writes (J3 final: H1 H2 M2 and the "exactly as it was" claims).
 *
 * 1. The ledger, ~/.botlink/ledger.json, is written BEFORE bot-link's first write to a config. It records
 *    what the path was right then: a regular file (with sha256 and mode, and a .bak copy of the bytes), a
 *    symlink (its link text, even when the link is dangling), or nothing at all. Only a file the ledger says
 *    bot-link CREATED may ever be deleted by uninstall.
 * 2. It also records every hook command string bot-link wrote, so bot-link's hooks are recognised by the exact
 *    string (never by a substring: a user's `node /opt/x/cli.js hook codex stop` is not ours).
 * 3. Writes go through symlinks (a dangling one included: the target is created when its folder exists, else the
 *    write is refused), keep the exact file mode whatever the umask, and write a hard-linked file in place so
 *    the link isn't split.
 * 4. stateDiff() compares a path now with the ledger's snapshot: bytes, mode and symlink-ness. Every "exactly as
 *    it was" bot-link prints comes from an empty diff here, never from a guess.
 */
import { chmodSync, closeSync, constants as FSC, copyFileSync, mkdtempSync, existsSync, fstatSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readlinkSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homeDir } from "./config.js";
import { parseJsonc } from "./jsonedit.js";
import { parseToml } from "./toml-span.js";

export interface Snapshot {
  /** the path held a regular file (directly or through links) */
  existed: boolean;
  /** bot-link created the content file (nothing was there, or a dangling link pointed at nothing) */
  created: boolean;
  /** the path itself was a symlink: its link text (readlink), dangling or not */
  link: string | null;
  /** where the content lives (the link resolved; the path itself when it isn't a link) */
  target: string;
  sha256: string | null;
  mode: number | null;
  /** the .bak copy of the original bytes (null when nothing existed) */
  bak: string | null;
  at: string;
}

/** What bot-link knows about its own span in a file (span.ts SpanRecord) and how the file was linked when bot-link last wrote it. */
export interface SpanInfo {
  created?: string[];
  inner?: Record<string, string>;
  tomlNoFinalNl?: boolean;
  emptyFile?: string;
  /** Cursor cli-config.json: the permission rules bot-link added (a rule the user had before is never ours) */
  perms?: string[];
  /** right after bot-link's last write: inode, device, link count, and the other names of a hard-linked file */
  links?: { ino: number; dev: number; nlink: number; others: string[] };
  /** a whole file bot-link owns (the watch service unit): the sha256 of what bot-link last wrote there */
  wrote?: string;
}

interface Ledger {
  version: 1;
  files: Record<string, Snapshot>;
  hooks: Record<string, string[]>;
  spans?: Record<string, SpanInfo>;
  /** target -> the file right after bot-link's last in-place write (a hard-linked file): its own change is not "another program's" */
  inplace?: Record<string, OwnWrite>;
  history?: { path: string; snapshot: Snapshot; settled: string }[];
}

// ---------------------------------------------------------------- cross-process locks (J3 v4 M2)
const held = new Map<string, number>();

function sleepMs(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Run fn holding ~/.botlink/<name>.lock (O_EXCL create; retried; a lock whose process is gone, or older than
 * staleMs, is taken over). Re-entrant within one process.
 */
export function withLock<T>(name: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const depth = held.get(name) || 0;
  if (depth) {
    held.set(name, depth + 1);
    try {
      return fn();
    } finally {
      held.set(name, depth);
    }
  }
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const staleMs = opts.staleMs ?? 120_000;
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const lf = join(homeDir(), `${name}.lock`);
  const me = JSON.stringify({ pid: process.pid, at: Date.now() });
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lf, "wx", 0o600);
      writeSync(fd, me);
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let stale = false;
    let seen = "";
    try {
      seen = readFileSync(lf, "utf-8");
      const l = JSON.parse(seen);
      stale = !alive(Number(l.pid)) || Date.now() - Number(l.at) > staleMs;
    } catch {
      // being written right now, or gone: only an old unreadable file is stale
      try {
        stale = Date.now() - statSync(lf).mtimeMs > staleMs;
      } catch {
        stale = false;
      }
    }
    if (stale) {
      const mine = `${lf}.stale.${process.pid}`;
      try {
        renameSync(lf, mine); // only one taker wins the rename
        const got = readFileSync(mine, "utf-8");
        if (seen && got !== seen) {
          // someone else's fresh lock: put it back
          try {
            renameSync(mine, lf);
          } catch {
            /* gone */
          }
        } else unlinkSync(mine);
      } catch {
        /* someone else took it */
      }
      continue;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`another bot-link process is busy (it holds ${lf}); try again in a moment, or delete that file if no bot-link is running.`);
    sleepMs(20 + Math.floor(Math.random() * 40));
  }
  held.set(name, 1);
  try {
    return fn();
  } finally {
    held.set(name, 0);
    try {
      unlinkSync(lf);
    } catch {
      /* gone */
    }
  }
}

/** Read-modify-write of the ledger under its lock. */
function mutateLedger<T>(fn: (l: Ledger) => T): T {
  return withLock("ledger", () => {
    const l = loadLedger();
    const r = fn(l);
    saveLedger(l);
    return r;
  });
}

export function spanInfo(path: string): SpanInfo {
  return loadLedger().spans?.[key(path)] || {};
}

export function updateSpanInfo(path: string, fn: (s: SpanInfo) => void) {
  mutateLedger((l) => {
    const s = ((l.spans ||= {})[key(path)] ||= {});
    fn(s);
  });
}

export function clearSpanInfo(path: string) {
  mutateLedger((l) => {
    if (l.spans) delete l.spans[key(path)];
  });
}

/** The snapshot of `path`: the live one, else the latest settled one (for --restore after an uninstall). */
export function anySnapshotOf(path: string): Snapshot | null {
  const l = loadLedger();
  const k = key(path);
  if (l.files[k]) return l.files[k];
  const h = (l.history || []).filter((x) => x.path === k);
  return h.length ? h[h.length - 1].snapshot : null;
}

/** Every path the ledger holds a snapshot for (live or settled). */
export function snapshotPaths(): string[] {
  const l = loadLedger();
  return [...new Set([...Object.keys(l.files), ...(l.history || []).map((x) => x.path)])];
}

/**
 * Other names of the inode `ino` on device `dev` under the home folder (a bounded walk: dotfiles repos live there).
 * -> paths, never `self`.
 */
export function otherLinks(root: string, ino: number, dev: number, self: string, maxEntries = 40_000, skipDir?: string): string[] {
  const out: string[] = [];
  let n = 0;
  const skip = new Set(["node_modules", ".git", ".cache", ".npm", ".botlink", "Library", ".Trash", ".local", ".rustup", ".cargo"]);
  const walk = (d: string, depth: number) => {
    if (depth > 5 || n > maxEntries) return;
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (++n > maxEntries) return;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name) && p !== skipDir) walk(p, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = lstatSync(p);
          if (st.ino === ino && st.dev === dev && resolve(p) !== resolve(self)) out.push(p);
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

export function ledgerPath(): string {
  return join(homeDir(), "ledger.json");
}

/**
 * J3c: is ledger.json damaged (there, but not a ledger)? -> the refusal to give (and a copy of it is kept in
 * backups/ledger.json.damaged.<time>, once per content), or null. bot-link never replaces a damaged ledger: it holds
 * what bot-link knows of your originals (which files it created, their original bytes' hashes and modes).
 */
export function ledgerProblem(): string | null {
  let raw: Buffer;
  try {
    raw = readFileSync(ledgerPath());
  } catch {
    return null; // none yet
  }
  let why = "";
  try {
    const l = JSON.parse(raw.toString("utf-8"));
    if (l && typeof l === "object" && !Array.isArray(l) && l.files && typeof l.files === "object" && l.hooks && typeof l.hooks === "object") return null;
    why = "not a bot-link ledger";
  } catch (e) {
    why = `not valid JSON: ${(e as Error).message.split("\n")[0]}`;
  }
  let copy = "";
  try {
    const dir = backupsDir();
    const same = readdirSync(dir).filter((f) => f.startsWith("ledger.json.damaged.")).find((f) => sha(readFileSync(join(dir, f))) === sha(raw));
    copy = same ? join(dir, same) : keepNew(join(dir, "ledger.json.damaged"), raw);
  } catch {
    /* the message says it without the copy */
  }
  return `${ledgerPath()} is damaged (${why}), so bot-link won't change any file it keeps a record of: it would lose what it knows of your originals.${copy ? ` A copy of it is saved in ${copy}.` : ""} Repair it, or move it away if you accept losing those records (bot-link then starts a new one), and run the command again. Nothing was changed.`;
}

export class LedgerDamaged extends Error {}

function loadLedger(): Ledger {
  try {
    const l = JSON.parse(readFileSync(ledgerPath(), "utf-8"));
    if (l && typeof l === "object" && l.files && l.hooks) return l as Ledger;
  } catch {
    /* none yet, or damaged: a write refuses (saveLedger) */
  }
  return { version: 1, files: {}, hooks: {} };
}

function saveLedger(l: Ledger) {
  // never over a damaged ledger (J3c: it was silently replaced by an empty one)
  const bad = ledgerProblem();
  if (bad) throw new LedgerDamaged(bad);
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const tmp = `${ledgerPath()}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(l, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, ledgerPath());
}

const key = (path: string) => resolve(path);

export function snapshotOf(path: string): Snapshot | null {
  return loadLedger().files[key(path)] || null;
}

export function sha(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Where the content of `path` lives: every symlink in the chain followed by hand, so a DANGLING link resolves to
 * the (missing) file it points at rather than to the link itself. -> the final non-link path.
 */
export function resolveTarget(path: string): string {
  let cur = resolve(path);
  for (let i = 0; i < 40; i++) {
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      // a missing component: resolve the parent's links, so a link under a linked folder still lands right
      const parent = dirname(cur);
      if (parent === cur) return cur;
      return join(resolveDir(parent), cur.slice(parent.length + 1));
    }
    if (!st.isSymbolicLink()) return join(resolveDir(dirname(cur)), cur.slice(dirname(cur).length + 1));
    cur = resolve(resolveDir(dirname(cur)), readlinkSync(cur)); // relative to the folder the link really sits in
  }
  throw new Error(`${path}: too many levels of symbolic links`);
}

function resolveDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export interface PathState {
  link: string | null;
  exists: boolean;
  sha256: string | null;
  mode: number | null;
  target: string;
}

export function stateOf(path: string, content = true): PathState {
  const link = isLink(path) ? readlinkSync(path) : null;
  const target = resolveTarget(path);
  if (!content || !existsSync(target)) return { link, exists: false, sha256: null, mode: null, target };
  return { link, exists: true, sha256: sha(readFileSync(target)), mode: statSync(target).mode & 0o7777, target };
}

/**
 * Called before EVERY write bot-link makes to `path`; only the first one (no ledger entry yet) records anything:
 * the .bak of the original bytes (before the ledger, so a recorded snapshot always has its copy), the link, the
 * mode. `backupPath` names the .bak/.link files (harnesses.ts owns that layout).
 */
export function recordBeforeWrite(path: string, backupPath: (p: string, kind: "bak" | "link") => string, legacy?: { hasOurs: boolean }, cur?: Held | null): Snapshot {
  return withLock("ledger", () => recordLocked(path, backupPath, legacy, cur));
}

function recordLocked(path: string, backupPath: (p: string, kind: "bak" | "link") => string, legacy?: { hasOurs: boolean }, cur?: Held | null): Snapshot {
  const l = loadLedger();
  const k = key(path);
  if (l.files[k]) return l.files[k];
  // J3 v7 C1: the original is the stable read the edit planned from (never a fresh read, which can catch an app's
  // in-place save half done); the .bak gets exactly those bytes, checked
  const s0 = stateOf(path, false);
  const s: PathState = cur === undefined ? stateOf(path) : cur === null ? { ...s0, exists: false, sha256: null, mode: null } : { ...s0, exists: true, sha256: sha(cur.buf), mode: cur.mode };
  let bak: string | null = null;
  let created = !s.exists;
  let existed = s.exists;
  let shaOrig = s.sha256;
  let mode = s.mode;
  backupsDir();
  if (s.exists) {
    bak = backupPath(path, "bak");
    if (legacy?.hasOurs) {
      // an install from before the ledger: the file already holds bot-link's entries. Its .bak (if an older
      // version made one) is the best original there is; without one, the original is unknown: never deleted,
      // never claimed equal.
      if (existsSync(bak)) {
        shaOrig = sha(readFileSync(bak));
        mode = null; // not recorded back then
      } else {
        bak = null;
        shaOrig = null;
        mode = null;
      }
      created = false;
      existed = true;
    } else {
      if (existsSync(bak)) retire(bak);
      // 0600: it can hold the user's tokens (J3 v6), whatever the original's mode was
      if (cur) writePrivate(bak, cur.buf);
      else copyPrivate(s.target, bak);
      if (sha(readFileSync(bak)) !== shaOrig) {
        rmSync(bak, { force: true });
        throw new FileBusy(path, `${path}: bot-link couldn't save a verified copy of it before changing it, so it didn't change it. Nothing was changed. Try again in a moment.`);
      }
    }
  }
  if (s.link !== null) writeFileSync(backupPath(path, "link"), s.link + "\n", { mode: 0o600 });
  const snap: Snapshot = { existed, created, link: s.link, target: s.target, sha256: shaOrig, mode, bak, at: new Date().toISOString() };
  l.files[k] = snap;
  saveLedger(l);
  return snap;
}

/** The ledger entry is done with (uninstall settled the file): keep it in the history, so the next setup snapshots afresh. */
export function forget(path: string) {
  mutateLedger((l) => {
    const k = key(path);
    if (l.spans) delete l.spans[k];
    if (!l.files[k]) return;
    (l.history ||= []).push({ path: k, snapshot: l.files[k], settled: new Date().toISOString() });
    delete l.files[k];
  });
}

/**
 * ~/.botlink/backups (and a subfolder of it): 0700 whatever the umask, also when an older version made it 0755
 * (J3 v6: it was 0777 under umask 000). Backups hold copies of configs that can carry the user's tokens.
 */
export function backupsDir(sub?: string): string {
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const dir = join(homeDir(), "backups");
  for (const d of sub ? [dir, join(dir, sub)] : [dir]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    try {
      if ((statSync(d).mode & 0o777) !== 0o700) chmodSync(d, 0o700);
    } catch {
      /* not ours to change */
    }
  }
  return sub ? join(dir, sub) : dir;
}

/** Copy a config into a backup: 0600 (never the source's mode: a world-readable config's copy is still private). */
export function copyPrivate(src: string, dst: string) {
  copyFileSync(src, dst);
  chmodSync(dst, 0o600);
}

/** Write bytes bot-link already holds (a stable read) into a backup: 0600, via a temp file. */
export function writePrivate(dst: string, buf: Buffer | string) {
  const tmp = `${dst}.tmp.${process.pid}`;
  writeFileSync(tmp, buf, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, dst);
}

/**
 * J3b: a NEW backup file, never one that exists: `<base>.<UTC time>` (`.<n>` added on a clash), 0600, made
 * exclusively (link(2) of a complete temp file, so it never exists half written and never replaces anything).
 * Backups are append-only: nothing bot-link does later overwrites, moves or deletes the file this returns, so a
 * message naming it stays true. -> its path.
 */
export function keepNew(base: string, buf: Buffer | string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const tmp = `${base}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, buf, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(tmp, 0o600);
    for (let n = 0; ; n++) {
      const dst = n ? `${base}.${ts}.${String(n).padStart(3, "0")}` : `${base}.${ts}`;
      try {
        linkSync(tmp, dst);
        return dst;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** A ledger entry made by a setup that was then undone (M1 rollback): gone, no history (the file is as it was). */
export function dropSnapshot(path: string) {
  mutateLedger((l) => {
    delete l.files[key(path)];
  });
}

function retire(file: string) {
  const dir = backupsDir("retired");
  renameSync(file, join(dir, `${file.split("/").pop()}.${new Date().toISOString().replace(/[:.]/g, "-")}`));
}

// ---------------------------------------------------------------- bot-link's own hook commands
export function recordHookCommands(harness: string, cmds: string[]) {
  const have = new Set(knownHookCommands(harness));
  if (cmds.every((c) => have.has(c))) return;
  mutateLedger((l) => {
    const now = new Set(l.hooks[harness] || []);
    const add = cmds.filter((c) => !now.has(c));
    l.hooks[harness] = [...(l.hooks[harness] || []), ...add];
  });
}

export function knownHookCommands(harness: string): string[] {
  return loadLedger().hooks[harness] || [];
}

// ---------------------------------------------------------------- stable reads (J3 v7 C1, C2, H1)
/**
 * Another program is in the middle of writing the file (an in-place save: truncated or half written, and that program
 * still has it open for writing), or the file changed under every read. Nothing was written.
 */
export class FileBusy extends Error {
  readonly busy = true;
  constructor(readonly path: string, message?: string) {
    super(message ?? `${path} is being written by another program right now. Nothing was changed. Try again in a moment.`);
  }
}

/**
 * A hard-linked file (bot-link must write it in place to keep the link) that another program changed in the last
 * HL_QUIET_MS, or while bot-link read it: an in-place write could interleave with that program's own in-place save
 * (J3 v7 race matrix, hardlink@40: torn files, lost writes, a false success). Nothing was written.
 */
export class HardLinkBusy extends FileBusy {
  constructor(path: string) {
    super(path, `${path} is hard-linked and another program is writing it right now, so bot-link won't write in place. Nothing was changed. Close the app or try again in a moment.`);
  }
}

/**
 * bot-link's in-place write of a hard-linked file read back as bytes that aren't its own: another program wrote it in
 * place at the same moment. The file was put back to a valid version (or, when none is valid, to the exact bytes
 * from before); the message says which. Always a failure.
 */
export class InPlaceRace extends FileBusy {}

/** Test seams (never set outside the test suite): runs right after bot-link's in-place write, before the re-read. */
export const _testHooks: { afterInPlaceWrite: ((target: string) => void) | null } = { afterInPlaceWrite: null };

/**
 * bot-link renamed its file into place, and another program wrote the file bot-link replaced (the old inode: it had it
 * open, an in-place save). `theirs`: that inode's bytes now (their save, complete); `ours`: what bot-link put in place.
 * The edit is planned again on top of `theirs` (setOverride), so their write is never discarded.
 */
export class OrphanWrite extends Error {
  constructor(readonly path: string, readonly theirs: Buffer, readonly ours: Buffer) {
    super(`${path} was written in place by another program while bot-link was saving it`);
  }
}

/**
 * Files where another program saved at the very instant bot-link replaced them (its save was swapped straight back,
 * or landed in the copy bot-link replaced and was merged again): for well under a millisecond the file held
 * bot-link's bytes instead of that save, so a read in that instant saw an older copy. bot-link can't know whether
 * one happened, so such a run never reports success (J3 v7: a false success is the worst outcome).
 */
export const collided = new Set<string>();

/** One stable read of a file, kept open: the inode bot-link planned its edit from (after its rename: the one it replaced). */
export interface Held {
  target: string;
  fd: number;
  buf: Buffer;
  ino: number;
  dev: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  nlink: number;
  mode: number;
}

/** Two reads of one open file this far apart must match (bytes, size, mtime). */
const STABLE_GAP_MS = 5;
/** A file changed in place (same inode) less than this ago may be half written: who has it open for writing decides. */
const QUIET_MS = 3000;
/** An empty file changed less than this ago may be truncated by a save that hasn't written yet. */
const ZERO_QUIET_MS = 10_000;
/** mtime - birth time below this: the inode was written in one go when it was created (an atomic save: never torn). */
const FRESH_MS = 10;
/** How long bot-link waits for another program's save to finish before it refuses. */
const MAX_WAIT_MS = 8000;
/** Reads that changed under bot-link (an app rewriting the file in place, again and again) before it refuses. */
const MAX_UNSTABLE = 6;

function readAll(fd: number): Buffer {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(Math.max(fstatSync(fd).size + 1, 4096));
  for (let pos = 0; ; ) {
    const r = readSync(fd, buf, 0, buf.length, pos);
    if (r <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, r)));
    pos += r;
  }
  return Buffer.concat(chunks);
}

/**
 * The processes (of this user: the only ones whose open files can be seen) that have inode dev:ino open for WRITING,
 * from /proc on Linux. null: this system can't tell (bot-link then waits for the file to be quiet instead).
 */
export function openWriters(dev: number, ino: number): number[] | null {
  if (process.platform !== "linux") return null;
  let pids: string[];
  try {
    pids = readdirSync("/proc");
  } catch {
    return null;
  }
  const out: number[] = [];
  for (const p of pids) {
    const c = p.charCodeAt(0);
    if (c < 48 || c > 57 || Number(p) === process.pid) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${p}/fd`);
    } catch {
      continue;
    }
    for (const f of fds) {
      let l: string;
      try {
        l = readlinkSync(`/proc/${p}/fd/${f}`);
      } catch {
        continue;
      }
      if (l.charCodeAt(0) !== 47 || l.startsWith("/dev/") || l.startsWith("/proc/")) continue; // sockets, pipes, ttys
      let st: Stats;
      try {
        st = statSync(`/proc/${p}/fd/${f}`);
      } catch {
        continue;
      }
      if (st.ino !== ino || st.dev !== dev) continue;
      try {
        const m = /^flags:\s*([0-7]+)/m.exec(readFileSync(`/proc/${p}/fdinfo/${f}`, "utf-8"));
        if (m && (parseInt(m[1], 8) & 3) !== 0) {
          out.push(Number(p));
          break;
        }
      } catch {
        /* gone */
      }
    }
  }
  return out;
}

/** The largest size each file had when bot-link read it in this run (a later 0-byte read of it is never the content). */
const seenBytes = new Map<string, number>();

function emptiedMsg(path: string, known: number): string {
  return `${path} is empty now, but it held ${known} bytes when bot-link last saw it. bot-link never takes an emptied config as its content (another program may be halfway through saving it). Nothing was changed. If you emptied it yourself, delete it and run the command again.`;
}

/**
 * Before reading an inode: can a read of it be a whole save? true; false: wait and look again; a string: refuse with
 * it. Decided from its stat and, when it was changed in place recently or is empty, from who has it open for writing
 * (scanned BEFORE the read, so the bytes returned are as fresh as they can be).
 */
function settled(path: string, target: string, st: Stats, knownBytes: number): boolean | string {
  const age = Date.now() - st.mtimeMs;
  const recent = (q: number) => age < q && age > -1000; // a clock far ahead: nothing to judge by
  const known = Math.max(knownBytes, seenBytes.get(target) || 0);
  const zero = st.size === 0;
  const suspicious = zero ? known > 0 || recent(ZERO_QUIET_MS) : !freshInode(st) && recent(QUIET_MS);
  if (!suspicious) return true;
  const w = openWriters(st.dev, st.ino);
  if (w && w.length) return false; // a program has it open for writing: its save may not be done
  if (zero && known > 0) return w === null && recent(QUIET_MS) ? false : emptiedMsg(path, known);
  // an empty file changed recently is never taken as empty, whatever the scan says (J3 v7 race matrix, under load: a
  // 0-byte read was once taken as the content and recorded as the original): it must have been empty for 10 s
  if (zero) return !recent(ZERO_QUIET_MS);
  if (w === null) return !recent(zero ? ZERO_QUIET_MS : QUIET_MS); // can't see writers here: wait until it is quiet
  return true; // nobody has it open for writing: what is read now is a whole save
}

/** Written in one go when it was created (an atomic save's temp file renamed into place): it can't be half written. */
function freshInode(st: Stats): boolean {
  return st.birthtimeMs > 0 && st.mtimeMs - st.birthtimeMs < FRESH_MS && st.mtimeMs >= st.birthtimeMs;
}

/**
 * Read `target` until the read is stable and complete (J3 v7 C1/C2):
 *   - an inode changed in place recently, or an empty one, only once no program has it open for writing (Linux
 *     /proc; elsewhere once it has been quiet for QUIET_MS); a file that held content before (`knownBytes`, or an
 *     earlier read in this run) is never taken as empty
 *   - an inode written in place: two reads of the open file STABLE_GAP_MS apart, identical bytes, size and mtime;
 *     a freshly written inode (an atomic save): one read, with its size and mtime unchanged around it
 *   - and the path still names that inode afterwards (an atomic save that replaced it meanwhile: read again)
 * -> the read, its fd still open; null: no file. Throws FileBusy (nothing written) after MAX_WAIT_MS or after
 * MAX_UNSTABLE reads that changed under bot-link.
 */
function readStableAt(path: string, target: string, knownBytes: number): Held | null {
  const start = Date.now();
  let unstable = 0;
  let replaced = 0;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(target, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    let keep = false;
    let wait = false;
    try {
      const s0 = fstatSync(fd);
      const v = settled(path, target, s0, knownBytes);
      if (typeof v === "string") throw new FileBusy(path, v);
      if (!v) wait = true;
      else {
        let b = readAll(fd);
        let s = fstatSync(fd);
        let ok = s.size === b.length && s.size === s0.size && s.mtimeMs === s0.mtimeMs && s.ctimeMs === s0.ctimeMs;
        if (ok && !freshInode(s0)) {
          sleepMs(STABLE_GAP_MS);
          const b2 = readAll(fd);
          const s2 = fstatSync(fd);
          ok = b2.equals(b) && s2.size === s.size && s2.mtimeMs === s.mtimeMs && s2.ctimeMs === s.ctimeMs;
          b = b2;
          s = s2;
        }
        if (!ok) unstable++;
        else {
          let same = false;
          try {
            const p = statSync(target);
            same = p.ino === s.ino && p.dev === s.dev;
          } catch {
            /* gone meanwhile */
          }
          if (!same) replaced++;
          else if (b.length === 0 && Math.max(knownBytes, seenBytes.get(target) || 0) > 0) throw new FileBusy(path, emptiedMsg(path, Math.max(knownBytes, seenBytes.get(target) || 0)));
          else {
            keep = true;
            if (b.length) seenBytes.set(target, Math.max(b.length, seenBytes.get(target) || 0));
            return { target, fd, buf: b, ino: s.ino, dev: s.dev, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, nlink: s.nlink, mode: s.mode & 0o7777 };
          }
        }
      }
    } finally {
      if (!keep) closeSync(fd);
    }
    if (unstable >= MAX_UNSTABLE || replaced >= 50 || Date.now() - start > MAX_WAIT_MS) {
      let emptyRecent = false;
      let linked = false;
      try {
        const st = statSync(target);
        emptyRecent = st.size === 0;
        linked = st.nlink > 1;
      } catch {
        /* gone */
      }
      if (linked && !emptyRecent) throw new HardLinkBusy(path);
      throw new FileBusy(path, emptyRecent ? `${path} is empty, and it was changed in the last ${ZERO_QUIET_MS / 1000} s: another program may be in the middle of saving it, so bot-link won't take it as empty. Nothing was changed. Try again in a moment (or, if you emptied it yourself, delete it).` : undefined);
    }
    if (wait) sleepMs(40);
    else if (unstable) sleepMs(5 + Math.floor(Math.random() * 15));
  }
}

// one edit attempt: the stable read of every file it touches, held open (and flock'ed) until the attempt ends
const attempt = { active: false, held: new Map<string, Held | null>(), locks: [] as number[], locked: new Set<string>() };
/** target -> their write that landed in the inode bot-link replaced (plan from it), and what bot-link put in place */
const overrides = new Map<string, { theirs: Buffer; ours: Buffer }>();

export function beginAttempt() {
  endAttempt();
  attempt.active = true;
  // the swap helper starts before the edit reads anything, never between its read and its compare (J3 v7 H1)
  startSwapper();
}

/** Close every held read and release every flock of the attempt. */
export function endAttempt() {
  for (const h of attempt.held.values()) {
    if (h) {
      try {
        closeSync(h.fd);
      } catch {
        /* closed */
      }
    }
  }
  attempt.held.clear();
  for (const fd of attempt.locks) {
    try {
      closeSync(fd); // the last reference to the open file: the flock goes with it
    } catch {
      /* closed */
    }
  }
  attempt.locks = [];
  attempt.locked.clear();
  attempt.active = false;
}

export function setOverride(path: string, theirs: Buffer, ours: Buffer) {
  overrides.set(resolveTarget(path), { theirs, ours });
}
export function clearOverride(path: string) {
  overrides.delete(resolveTarget(path));
}
export function hasOverride(path: string): boolean {
  return overrides.has(resolveTarget(path));
}
export function overrideOf(path: string): { theirs: Buffer; ours: Buffer } | undefined {
  return overrides.get(resolveTarget(path));
}

/**
 * Their write landed in the inode bot-link replaced AND the file changed again since bot-link's write (that program
 * wrote it twice): the two can't both be kept by a re-plan. Their first write is saved; nothing more is written.
 */
export class LostWrite extends Error {
  constructor(readonly path: string, readonly saved: string) {
    super(`${path} was written twice by another program while bot-link was saving it. Its first write landed in the copy bot-link had just replaced; it is saved in ${saved}. The file now holds that program's later write. Compare the two and copy back anything missing, then run the command again.`);
  }
}

/**
 * The bytes an edit of `path` plans from: a stable read (readStableAt), taken once per attempt and kept open (with an
 * advisory flock: programs that use flock wait for bot-link, and it for them) until endAttempt(). After an OrphanWrite
 * the plan is their bytes and `held` is what is in place now (bot-link's own write). Outside an attempt: a stable read,
 * closed again. `knownBytes`: the file held this much before (ledger/backup), so a 0-byte read is never the content.
 */
export function readForEdit(path: string, knownBytes = 0): { plan: Buffer | null; held: Held | null } {
  const target = resolveTarget(path);
  if (!attempt.active) {
    const h = readStableAt(path, target, knownBytes);
    if (h) closeSync(h.fd);
    return { plan: h ? h.buf : null, held: null };
  }
  let h = attempt.held.get(target);
  if (h === undefined) {
    flockFile(path, target);
    h = readStableAt(path, target, knownBytes);
    attempt.held.set(target, h);
    const ov = overrides.get(target);
    if (ov && !ov.theirs.length && ov.ours.length) {
      // never plan from an empty "their save" over a file with content (it can only be one caught mid-save)
      overrides.delete(target);
      throw new FileBusy(path);
    }
    if (ov && !(h && h.buf.equals(ov.ours))) {
      overrides.delete(target);
      const saved = join(backupsDir("lost"), `${encodeURIComponent(target)}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
      writePrivate(saved, ov.theirs);
      throw new LostWrite(path, saved);
    }
  }
  const ov = overrides.get(target);
  return { plan: ov ? ov.theirs : h ? h.buf : null, held: h };
}

/** The held read of `path` in this attempt (undefined: not read in it). */
export function heldOf(path: string): Held | null | undefined {
  return attempt.held.get(resolveTarget(path));
}

let flockCmd: boolean | undefined;

/**
 * An advisory exclusive flock on the file for the rest of the attempt (J3 v7 H1): flock(1) locks the open file it is
 * handed, which this process shares, so the lock lasts until the attempt closes that fd. macOS: O_EXLOCK. A program
 * holding it for over 1.5 s: FileBusy. No flock available: nothing (programs that don't use flock aren't helped by it
 * anyway: the stable read and the checks around the rename are what protect them).
 */
function flockFile(path: string, target: string) {
  const fd = acquireFlock(path, target);
  if (fd === null) return;
  attempt.locks.push(fd);
  attempt.locked.add(target);
}

/**
 * An exclusive flock on `target` (flock(1) on an fd this process keeps; macOS: O_EXLOCK), waited for up to 1.5 s.
 * -> the fd holding it (closing it releases the lock); null: no file, or no flock on this system. Held by another
 * program for longer: FileBusy (`busy`, or the plain one).
 */
function acquireFlock(path: string, target: string, busy?: () => Error): number | null {
  let fd: number;
  try {
    fd = openSync(target, "r");
  } catch {
    return null; // no file yet: nothing to lock
  }
  const exlock = (FSC as Record<string, number>).O_EXLOCK;
  if (process.platform === "darwin" && exlock) {
    closeSync(fd);
    const start = Date.now();
    for (;;) {
      try {
        return openSync(target, FSC.O_RDONLY | exlock | FSC.O_NONBLOCK);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EWOULDBLOCK" && code !== "EAGAIN") return null;
        if (Date.now() - start > 1500) throw busy ? busy() : new FileBusy(path);
        sleepMs(5);
      }
    }
  }
  if (flockCmd === false) {
    closeSync(fd);
    return null;
  }
  const r = spawnSync("flock", ["-x", "-w", "1.5", "3"], { stdio: ["ignore", "ignore", "ignore", fd], timeout: 5000 });
  if (r.error) {
    flockCmd = false;
    closeSync(fd);
    return null;
  }
  flockCmd = true;
  if (r.status !== 0) {
    closeSync(fd);
    throw busy ? busy() : new FileBusy(path);
  }
  return fd;
}

/** Bytes of a file as one stable read, or null (no file). For reads that don't plan a write (doctor, checks). */
export function readStable(path: string, knownBytes = 0): Buffer | null {
  return readForEdit(path, knownBytes).plan;
}

// ---------------------------------------------------------------- writes
export class RefusedLink extends Error {
  readonly = true;
}

/**
 * The file changed under bot-link between its read and its write (a running app wrote it). `landed`: bot-link's
 * write went in and someone wrote after it (their bytes are what the file holds now); else nothing was written.
 */
export class ConcurrentChange extends Error {
  constructor(readonly path: string, readonly landed: boolean) {
    super(`${path} changed while bot-link was writing it`);
  }
}

/** The names in `dir`, sorted (null: it can't be listed). */
export function dirNames(dir: string): string[] | null {
  try {
    const t = process.hrtime.bigint();
    const n = readdirSync(dir);
    listNs.set(dir, process.hrtime.bigint() - t); // how long listing this folder takes when nothing is in the way
    return n.sort();
  } catch {
    return null;
  }
}
const listNs = new Map<string, bigint>();

/**
 * Run `then` (the rename) only if, right before it:
 *   - the file at `target` holds exactly `expect` (null: there is no file), byte for byte
 *   - the folder holds the same names as `names` (taken when the edit read the file; bot-link's temp file and the
 *     app lock aside): a program that writes with a temp file + rename shows its temp file from before its rename
 *     starts until it is done. Listing a folder takes the folder's lock, so it also waits for a rename into it that
 *     is still in progress (its old file still shows to a stat) to finish
 *   - then: it is still the file that was read (same inode)
 * Only a stat lies between the listing and the rename. -> ran?
 */
/** How long a folder listing counts as current before the rename (a program's temp-file write takes far longer). */
const FRESH_NS = 20_000n;

function ifStill(target: string, expect: string | Buffer | null, names: string[] | null | undefined, then: () => void, lockName?: string, ino?: number): boolean {
  const dir = dirname(target);
  const mine = new Set([`${target.slice(dir.length + 1)}.botlink.tmp`, ...(lockName ? [lockName] : [])]);
  const before = names ? new Set(names.filter((n) => !mine.has(n))) : null;
  const sameNames = () => {
    let now: string[];
    try {
      now = readdirSync(dir); // listed even without `names`: the wait for a rename in progress
    } catch {
      return !before;
    }
    if (!before) return true;
    let k = 0;
    for (const n of now) {
      if (mine.has(n)) continue;
      if (!before.has(n)) return false;
      k++;
    }
    return k === before.size;
  };
  let fd: number;
  try {
    fd = openSync(target, "r");
  } catch (e) {
    if (expect === null && (e as NodeJS.ErrnoException).code === "ENOENT" && sameNames()) {
      then();
      return true;
    }
    return false;
  }
  try {
    if (expect === null) return false;
    const want = Buffer.isBuffer(expect) ? expect : Buffer.from(expect, "utf-8");
    const buf = Buffer.alloc(want.length + 1);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, n)) > 0; ) n += r;
    if (n !== want.length || !buf.subarray(0, n).equals(want)) return false;
    const st = fstatSync(fd);
    // the inode bot-link read and planned from (J3 v7 H1: after the rename, that inode is the one watched for writes)
    if (ino !== undefined && st.ino !== ino) return false;
    // the listing reads the folder under its lock, so it also waits out a rename into the folder still in progress
    // (whose old file still shows to a stat); then the inode, then the rename: nothing else in between, so another
    // program would have to create, write and start renaming its temp file within those few microseconds
    if (!sameNames()) return false; // also the wait for a rename still in progress
    if (statSync(target).ino !== st.ino) return false; // replaced (renamed over) after it was opened
    // the names once more, directly before the rename: another program would have to create, write and start renaming
    // its temp file between this listing and the rename. If bot-link was descheduled (or paused by a GC) during or
    // after this listing, it may be stale: try again rather than rename on it
    const start = process.hrtime.bigint();
    if (!sameNames()) return false;
    if (process.hrtime.bigint() - start > 2n * (listNs.get(dir) ?? 100_000n) + FRESH_NS) return false;
    then();
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * Hold an app's own lock on its config while bot-link does its last compare and rename: Claude Code saves
 * ~/.claude.json under `<file>.lock`, a proper-lockfile lock (a folder made with mkdir, its mtime refreshed while
 * held, stale after 10 s). Taken the same way, so Claude Code can't write the file in that window. A lock a live app
 * holds for longer than ~1.5 s: ConcurrentChange (the edit is planned again later). A stale one (its holder is gone)
 * is left alone and not waited for.
 */
function withAppLock<T>(lock: string, fn: () => T): T {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (code === "ENOENT" || code === "EACCES" || code === "EROFS" || code === "EPERM") return fn(); // no lock possible there: the compare alone
        throw e;
      }
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released just now
      }
      if (age > 10_000) return fn(); // stale: its holder is gone
      if (Date.now() - start > 1500) throw new ConcurrentChange(lock.replace(/\.lock$/, ""), false);
      sleepMs(2 + Math.floor(Math.random() * 6));
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* gone */
    }
  }
}

/**
 * Write `text` as the content of `path`:
 *   - through every symlink (the link is never replaced); a dangling link gets its target created when the
 *     target's folder exists, and is refused otherwise
 *   - an existing file keeps its exact mode (chmod after the write: the umask never decides)
 *   - a hard-linked file (nlink > 1) is written in place, so every name keeps seeing the same content (never
 *     truncated first: the new bytes go over the old ones, then the length is set)
 *   - `expect` (the bytes the file held when the edit read it; null: no file): the new bytes go to a temp file first,
 *     then the target is compared with `expect` byte for byte right before the rename, and the write is abandoned
 *     (ConcurrentChange, nothing written) if it changed, if the folder's names changed (another program's temp
 *     file), or if the file was replaced. A new file is linked into place, which never replaces a file someone else
 *     created meanwhile.
 *   - `held`: the stable read the edit planned from, still open (J3 v7 H1). The compare also checks it is still that
 *     inode, and after the rename that inode is watched: a program that had it open for writing is waited for, and
 *     if it wrote, OrphanWrite (with its bytes) is thrown so the caller re-plans on top of them. (A hard-linked file
 *     is written in place: no inode is replaced; the caller's re-read after the write catches a program that wrote
 *     right after it.)
 *   - `names`: the folder listing from when the edit read the file; `appLock`: the app's own save lock, held for the
 *     compare and the rename (withAppLock).
 */
export function writeContent(path: string, text: string | Buffer, opts: WriteOpts = {}): void {
  const lock = opts.appLock;
  if (lock && opts.expect !== undefined) return withAppLock(lock, () => writeUnder(path, text, opts, lock.slice(dirname(lock).length + 1)));
  writeUnder(path, text, opts);
}

export interface WriteOpts {
  mode?: number;
  expect?: string | Buffer | null;
  names?: string[] | null;
  appLock?: string;
  held?: Held | null;
}

/** A hard-linked file changed (mtime or ctime) less than this ago is being written: never written in place. */
const HL_QUIET_MS = 3000;

/** The file right after one of bot-link's own in-place writes (ledger `inplace`): that change is bot-link's, not an app's. */
interface OwnWrite {
  ino: number;
  dev: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  sha256: string;
}

function recordOwnWrite(target: string, st: Stats, buf: Buffer) {
  const w: OwnWrite = { ino: st.ino, dev: st.dev, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, sha256: sha(buf) };
  try {
    mutateLedger((l) => {
      (l.inplace ||= {})[target] = w;
    });
  } catch {
    /* not recorded: the next write within 3 s is refused, which is safe */
  }
}

/**
 * Is a hard-linked file being written by another program right now? Its mtime or ctime is less than HL_QUIET_MS
 * old, and that change isn't bot-link's own last in-place write (the same inode, size, times and bytes).
 */
function changingInPlace(target: string, st: Stats, bytes: Buffer): boolean {
  const age = Date.now() - Math.max(st.mtimeMs, st.ctimeMs);
  if (!(age < HL_QUIET_MS && age > -1000)) return false;
  const own = loadLedger().inplace?.[target];
  return !(own && own.ino === st.ino && own.dev === st.dev && own.size === st.size && own.mtimeMs === st.mtimeMs && own.ctimeMs === st.ctimeMs && own.sha256 === sha(bytes));
}

/** Does `buf` parse as the config `target` is (TOML by its name, else JSON with comments)? Empty counts as valid. */
function validConfig(target: string, buf: Buffer): boolean {
  const t = buf.toString("utf-8");
  if (!t.trim()) return true;
  try {
    if (/\.toml$/i.test(target)) {
      parseToml(t);
      return true;
    }
    return parseJsonc(t).error === null;
  } catch {
    return false;
  }
}

/** One write of all of `buf` at offset 0 (pwrite; continued only after a short write), then the length set. */
function putAt0(fd: number, buf: Buffer) {
  for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off, off);
  ftruncateSync(fd, buf.length);
}

/** Wait (up to `ms`) until no program has inode dev:ino open for writing (where that can't be seen: a short settle). */
function waitNoWriters(dev: number, ino: number, ms = MAX_WAIT_MS) {
  const start = Date.now();
  for (;;) {
    const w = openWriters(dev, ino);
    if (w === null) {
      sleepMs(50);
      return;
    }
    if (!w.length || Date.now() - start > ms) return;
    sleepMs(5);
  }
}

/** Two reads STABLE_GAP_MS apart, identical (bytes and stat): -> the bytes, or null (still changing / gone). */
function stableNow(target: string): Buffer | null {
  try {
    const fd = openSync(target, "r");
    try {
      const s1 = fstatSync(fd);
      const a = readAll(fd);
      sleepMs(STABLE_GAP_MS);
      const b = readAll(fd);
      const s2 = fstatSync(fd);
      return a.equals(b) && s1.size === s2.size && s1.mtimeMs === s2.mtimeMs && s1.ctimeMs === s2.ctimeMs && s2.size === b.length ? b : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The exclusive flock on `target` for an in-place write: the attempt's own when it holds one, else taken for `fn`. */
function withInPlaceLock<T>(path: string, target: string, fn: () => T): T {
  if (attempt.locked.has(target)) return fn();
  const fd = acquireFlock(path, target, () => new HardLinkBusy(path));
  try {
    return fn();
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Write `buf` over a hard-linked file's bytes in place (the link is kept), under an exclusive flock, never while
 * another program is writing it (J3 v7 race matrix, hardlink@40):
 *   - refused (HardLinkBusy, nothing written) when the file changed in the last HL_QUIET_MS (mtime or ctime: not by
 *     bot-link's own last write), or since `held` (the stable read the edit planned from) was taken
 *   - one pwrite of the whole content at offset 0, then the length (never truncated first), the mode, and at once a
 *     re-read: bytes that aren't exactly bot-link's are another program's in-place save interleaved with it. Then
 *     that program is waited for; a complete, valid save of theirs is left in place; else the file gets back their
 *     last stable bytes (`theirs`) with bot-link's change (`buf`) when that is valid, else `theirs` alone (exactly,
 *     even when neither is valid). Never an invalid mix left behind. InPlaceRace (a failure) says which.
 * `theirs`: the bytes the file held right before (compared byte for byte by the caller, or `held`'s).
 */
function overwriteInPlace(path: string, target: string, buf: Buffer, theirs: Buffer | null, held?: Held | null, mode?: number) {
  const fd = openSync(target, "r+");
  let st: Stats;
  let before: Buffer;
  try {
    st = fstatSync(fd);
    if (held && (st.ino !== held.ino || st.size !== held.size || st.mtimeMs !== held.mtimeMs || st.ctimeMs !== held.ctimeMs)) throw new HardLinkBusy(path);
    before = theirs ?? held?.buf ?? readAll(fd);
    if (changingInPlace(target, st, before)) throw new HardLinkBusy(path);
    putAt0(fd, buf);
    if (mode !== undefined && (fstatSync(fd).mode & 0o7777) !== mode) chmodSync(target, mode);
  } finally {
    closeSync(fd);
  }
  _testHooks.afterInPlaceWrite?.(target);
  let now: Buffer | null = null;
  try {
    now = readFileSync(target);
  } catch {
    /* gone */
  }
  if (now && now.equals(buf)) {
    recordOwnWrite(target, statSync(target), buf);
    return;
  }
  repairInPlace(path, target, buf, before, st, mode);
}

/** After an interleaved in-place write (overwriteInPlace): a valid file back, then InPlaceRace. */
function repairInPlace(path: string, target: string, ours: Buffer, theirs: Buffer, st: Stats, mode?: number): never {
  const kind = /\.toml$/i.test(target) ? "TOML" : "JSON";
  const head = `${path} is hard-linked, and another program wrote it in place at the same moment as bot-link`;
  const tail = "Close the app, check the file, then run the command again.";
  let saved: string | null = null;
  const keep = (b: Buffer) => {
    if (saved || b.equals(ours) || b.equals(theirs)) return;
    try {
      saved = join(backupsDir("lost"), `${encodeURIComponent(target)}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
      writePrivate(saved, b);
    } catch {
      saved = null;
    }
  };
  const put = validConfig(target, ours) ? ours : theirs;
  const start = Date.now();
  for (let round = 0; ; round++) {
    waitNoWriters(st.dev, st.ino);
    const now = stableNow(target);
    if (now && round === 0 && !now.equals(ours) && validConfig(target, now)) {
      // their whole save landed on top of bot-link's: it stays, without bot-link's change
      throw new InPlaceRace(path, `${head}. That program's save is in the file, without bot-link's change. ${tail}`);
    }
    if (now && now.equals(put)) break;
    if (now) keep(now);
    if (Date.now() - start > MAX_WAIT_MS && round > 0) break;
    const fd = openSync(target, "r+");
    try {
      putAt0(fd, put);
      if (mode !== undefined && (fstatSync(fd).mode & 0o7777) !== mode) chmodSync(target, mode);
    } finally {
      closeSync(fd);
    }
    let back: Buffer | null = null;
    try {
      back = readFileSync(target);
    } catch {
      /* gone */
    }
    if (back && back.equals(put)) {
      sleepMs(STABLE_GAP_MS);
      const again = stableNow(target);
      if (again && again.equals(put)) break;
    }
  }
  if (put === ours) recordOwnWrite(target, statSync(target), ours);
  const lost = saved ? ` What the file held after the two writes mixed is kept in ${saved}.` : "";
  if (put === ours) throw new InPlaceRace(path, `${head}, and the two writes mixed. bot-link put back what the file held before with its own change, so bot-link's change is in it, but that program's save in progress is not.${lost} ${tail}`);
  if (validConfig(target, theirs)) throw new InPlaceRace(path, `${head}, and the two writes mixed. bot-link put back exactly what the file held before, without bot-link's change; that program's save in progress is not in it.${lost} ${tail}`);
  throw new InPlaceRace(path, `${head}, and the two writes mixed, and neither bot-link's version nor the one from before is valid ${kind}, so bot-link put back exactly the bytes from before, without bot-link's change.${lost} ${tail}`);
}

let swapUnavailable = process.platform !== "linux" && process.platform !== "darwin";
let swapper: { req: number; resp: number; dir: string; pid: number } | null = null;
const SWAP_PY = [
  "import ctypes,os,sys",
  "c=ctypes.CDLL(None,use_errno=True)",
  "f=(lambda a,b:c.renamex_np(a,b,ctypes.c_uint(2))) if sys.platform=='darwin' else (lambda a,b:c.renameat2(-100,a,-100,b,ctypes.c_uint(2)))",
  "q=open(sys.argv[1],'rb',buffering=0)",
  "w=open(sys.argv[2],'wb',buffering=0)",
  "w.write(b'R\\n')",
  "buf=b''",
  "while True:",
  "  d=q.read(65536)",
  "  if not d: break",
  "  buf+=d",
  "  while b'\\n' in buf:",
  "    line,buf=buf.split(b'\\n',1)",
  "    a,b,i=line.split(b'\\0')",
  "    r=f(a,b)",
  "    if r!=0: w.write(b'3\\n'); continue",
  "    i=int(i)",
  "    if i==0 or os.lstat(a).st_ino==i: w.write(b'0\\n'); continue",
  "    w.write(b'B\\n' if f(a,b)==0 else b'X\\n')",
].join("\n");

/**
 * A helper that swaps two names atomically (Linux renameat2 RENAME_EXCHANGE, macOS renamex_np RENAME_SWAP: Node can't
 * call either). Started once per run, BEFORE bot-link's last compare, and asked over two FIFOs, so the swap itself
 * takes microseconds. -> ready? (false: no python3 or mkfifo here; bot-link then renames as before)
 */
function startSwapper(): boolean {
  if (swapper) return true;
  if (swapUnavailable) return false;
  try {
    const dir = mkdtempSync(join(tmpdir(), "botlink-swap-"));
    const req = join(dir, "req");
    const resp = join(dir, "resp");
    const mk = spawnSync("mkfifo", ["-m", "600", req, resp], { stdio: "ignore", timeout: 5000 });
    if (mk.error || mk.status !== 0) throw new Error("no mkfifo");
    const child = spawn("python3", ["-I", "-S", "-c", SWAP_PY, req, resp], { stdio: "ignore", detached: false });
    child.on("error", () => {});
    child.unref();
    // both ends of each FIFO block until the other side opens them; a python3 that can't start never opens them,
    // so the opens are made non-blocking first and waited for (bounded)
    const start = Date.now();
    let w = -1;
    while (w < 0) {
      try {
        w = openSync(req, FSC.O_WRONLY | FSC.O_NONBLOCK);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENXIO" || Date.now() - start > 3000) throw e;
        sleepMs(2);
      }
    }
    const r = openSync(resp, FSC.O_RDONLY | FSC.O_NONBLOCK);
    const one = Buffer.alloc(2);
    let got = "";
    while (!got.includes("\n")) {
      try {
        const n = readSync(r, one, 0, 2, null);
        if (n > 0) got += one.subarray(0, n).toString();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
      }
      if (!got.includes("\n")) {
        if (Date.now() - start > 3000) throw new Error("helper didn't start");
        sleepMs(1);
      }
    }
    swapper = { req: w, resp: r, dir, pid: child.pid ?? -1 };
    process.once("exit", stopSwapper);
    return true;
  } catch {
    swapUnavailable = true;
    return false;
  }
}

function stopSwapper() {
  if (!swapper) return;
  try {
    closeSync(swapper.req); // the helper reads EOF and exits
    closeSync(swapper.resp);
  } catch {
    /* closed */
  }
  rmSync(swapper.dir, { recursive: true, force: true });
  swapper = null;
}

/**
 * Swap two names atomically through the helper. With `expectIno` (the inode bot-link read): if what the swap took out of
 * `b` is a different inode (another program's save came in after bot-link's last compare), the helper swaps straight
 * back, within microseconds. -> "swapped"; "back" (swapped and swapped back: `b` holds their save again, `a` bot-link's
 * file); "foreign" (swapped, the swap back failed); false: not possible here (nothing was done).
 */
function swapNames(a: string, b: string, expectIno = 0): "swapped" | "back" | "foreign" | false {
  if (!swapper) return false;
  try {
    const msg = Buffer.from(`${a}\0${b}\0${expectIno}\n`);
    for (let off = 0; off < msg.length; ) {
      try {
        off += writeSync(swapper.req, msg, off, msg.length - off);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
      }
    }
    const one = Buffer.alloc(2);
    let got = "";
    const start = Date.now();
    while (!got.includes("\n")) {
      try {
        const n = readSync(swapper.resp, one, 0, 2, null);
        if (n > 0) got += one.subarray(0, n).toString();
        else if (n === 0) throw new Error("helper gone");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
        if (Date.now() - start > 5000) throw e;
      }
    }
    return got.startsWith("0") ? "swapped" : got.startsWith("B") ? "back" : got.startsWith("X") ? "foreign" : false;
  } catch {
    stopSwapper();
    swapUnavailable = true;
    return false;
  }
}

/**
 * After swapNames(tmp, target): `tmp` names the inode bot-link replaced. The one it read (`held`): its in-place writes
 * are checked (afterReplace). Another one: a program renamed its own save in after bot-link's last compare, so THEIR
 * save is in hand: OrphanWrite with its bytes (re-planned on top), never discarded.
 */
function afterSwap(path: string, target: string, tmp: string, held: Held | null, ours: Buffer, expect: Buffer | null, oursIno: number | null) {
  let fd: number;
  try {
    fd = openSync(tmp, "r");
  } catch {
    if (held) afterReplace(path, held, ours);
    return;
  }
  try {
    const st = fstatSync(fd);
    if (held && st.ino === held.ino && st.dev === held.dev) {
      rmSync(tmp, { force: true });
      afterReplace(path, held, ours);
      return;
    }
    const settledBytes = theirBytes(fd, expect ? expect.length : 1, 0);
    if (expect && settledBytes && settledBytes.equals(expect)) {
      rmSync(tmp, { force: true }); // they saved the very bytes bot-link planned from: nothing of theirs to keep
      return;
    }
    // put THEIR save straight back where it was (one more swap, microseconds: the app barely sees bot-link's bytes),
    // then the edit is planned again from a fresh read
    if (oursIno !== null && swapNames(tmp, target) === "swapped") {
      let back: Stats | null = null;
      try {
        back = lstatSync(tmp);
      } catch {
        /* gone */
      }
      if (back && back.ino === oursIno) {
        rmSync(tmp, { force: true });
        collided.add(resolve(path));
        throw new ConcurrentChange(path, false);
      }
      // yet another save came in between the two swaps: the newest goes in place, the one in between is kept aside
      if (back && swapNames(tmp, target) === "swapped") {
        const saved = join(backupsDir("lost"), `${encodeURIComponent(target)}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
        renameSync(tmp, saved);
        throw new LostWrite(path, saved);
      }
    }
    collided.add(resolve(path));
    const theirs = theirBytes(fd, expect ? expect.length : 1);
    if (!theirs) {
      const e = unsettled(path, target, fd);
      rmSync(tmp, { force: true });
      throw e;
    }
    rmSync(tmp, { force: true });
    throw new OrphanWrite(path, theirs, ours);
  } finally {
    closeSync(fd);
  }
}

/**
 * The bytes of an inode bot-link replaced that another program wrote (their save), read under the same rules as any
 * plan (J3 v7, found by the race matrix under load: a /proc scan can miss a program between its O_TRUNC and its
 * write): nobody has it open for writing, two reads STABLE_GAP_MS apart are equal, and it is never 0 bytes when it
 * held content (`hadBytes`). -> the bytes; null: not settled within `waitMs`.
 */
export function theirBytes(fd: number, hadBytes: number, waitMs = MAX_WAIT_MS): Buffer | null {
  const start = Date.now();
  for (;;) {
    const st = fstatSync(fd);
    const w = openWriters(st.dev, st.ino);
    if (!w || !w.length) {
      const a = readAll(fd);
      sleepMs(w === null ? 30 : STABLE_GAP_MS);
      const b = readAll(fd);
      const st2 = fstatSync(fd);
      if (a.equals(b) && st2.mtimeMs === st.mtimeMs && st2.size === b.length && (b.length > 0 || hadBytes === 0)) return b;
    }
    if (Date.now() - start > waitMs) return null;
    sleepMs(5);
  }
}

/** Their save didn't settle (theirBytes null): bot-link stops, keeps what there is, and says so. Never planned from. */
function unsettled(path: string, target: string, fd: number): Error {
  collided.add(resolve(path));
  let saved = "";
  try {
    const b = readAll(fd);
    if (b.length) {
      saved = join(backupsDir("lost"), `${encodeURIComponent(target)}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
      writePrivate(saved, b);
    }
  } catch {
    /* nothing to keep */
  }
  return new Error(`${path}: another program was saving the copy of the file bot-link had just replaced and didn't finish within ${MAX_WAIT_MS / 1000} s, so bot-link stopped (its own change is in place).${saved ? ` What that program had written so far is in ${saved}.` : ""} Check the file, then run the command again.`);
}

/**
 * Right after bot-link renamed its file over `held`'s inode: did another program write that inode meanwhile (an
 * in-place save between bot-link's last compare and its rename, or one still going on)? Their bytes would be lost with
 * that inode. Every program that has it open for writing is waited for (Linux /proc; elsewhere a short settle), twice,
 * then its bytes are compared with what bot-link read. Changed -> OrphanWrite with their (complete) bytes.
 */
function afterReplace(path: string, held: Held, ours: Buffer) {
  const changed = () => {
    try {
      const st = fstatSync(held.fd);
      return st.size !== held.size || st.mtimeMs !== held.mtimeMs || !readAll(held.fd).equals(held.buf);
    } catch {
      return false;
    }
  };
  let ch = changed();
  const start = Date.now();
  for (let pass = 0; pass < 2; pass++) {
    for (;;) {
      const w = openWriters(held.dev, held.ino);
      if (w === null) {
        sleepMs(30);
        break;
      }
      if (!w.length) break;
      if (Date.now() - start > MAX_WAIT_MS) {
        throw new Error(`${path}: bot-link saved its change, but another program kept the old copy of the file open for writing, so what that program writes next is lost. Quit it, check the file, then run the command again.`);
      }
      sleepMs(5);
    }
    if (pass === 0) sleepMs(2); // an open() that resolved the old inode just before the rename shows up by now
  }
  ch = ch || changed();
  if (ch) {
    collided.add(resolve(path));
    const theirs = theirBytes(held.fd, held.size);
    if (!theirs) throw unsettled(path, held.target, held.fd);
    throw new OrphanWrite(path, theirs, ours);
  }
}

function writeUnder(path: string, text: string | Buffer, opts: WriteOpts, lockName?: string): void {
  const target = resolveTarget(path);
  const check = opts.expect !== undefined;
  const held = opts.held || null;
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf-8");
  if (isLink(path) && !existsSync(target) && !existsSync(dirname(target))) {
    throw new RefusedLink(`${path} is a symlink to ${readlinkSync(path)}, which doesn't exist (nor does its folder ${dirname(target)}), so bot-link won't replace the link or create that folder; nothing was changed.`);
  }
  const tmp = `${target}.botlink.tmp`;
  if (existsSync(target)) {
    const st = statSync(target);
    const mode = opts.mode ?? st.mode & 0o7777;
    if (st.nlink > 1) {
      // same inode: the other names see it too. An app that renames over the file breaks the link, so a write
      // racing it lands on the old inode only and the target keeps the app's bytes (the caller's re-read sees it).
      // J3 v7 race matrix (hardlink@40): flock'ed, and never while another program is writing it in place
      withInPlaceLock(path, target, () => {
        if (!check) return overwriteInPlace(path, target, buf, null, null, mode);
        const want = opts.expect === null ? null : Buffer.isBuffer(opts.expect) ? opts.expect : Buffer.from(opts.expect!, "utf-8");
        // changed since the edit read it: another program is writing it (not re-planned: refused)
        if (ifStill(target, opts.expect!, opts.names, () => overwriteInPlace(path, target, buf, want, held, mode), lockName, held?.ino)) return;
        let same = false;
        try {
          same = want !== null && readFileSync(target).equals(want) && (!held || statSync(target).ino === held.ino);
        } catch {
          /* gone */
        }
        if (!same) throw new HardLinkBusy(path); // changed since the edit read it: another program is writing it
        throw new ConcurrentChange(path, false); // only the folder's names changed: planned again
      });
      return;
    }
    writeFileSync(tmp, buf, { mode: 0o600 });
    chmodSync(tmp, mode);
    const tmpIno = statSync(tmp).ino;
    // right after the compare, with the file held open: the window is one stat and the swap (or rename) itself
    if (!check) {
      renameSync(tmp, target);
      return;
    }
    let swapped = false as ReturnType<typeof swapNames>;
    startSwapper(); // already running when an attempt began (beginAttempt): the swap itself takes microseconds
    const put = () => {
      swapped = swapNames(tmp, target, held ? held.ino : 0);
      if (!swapped) renameSync(tmp, target);
    };
    if (!ifStill(target, opts.expect!, opts.names, put, lockName, held?.ino)) {
      rmSync(tmp, { force: true });
      throw new ConcurrentChange(path, false);
    }
    const want = opts.expect === null ? null : Buffer.isBuffer(opts.expect) ? opts.expect : Buffer.from(opts.expect!, "utf-8");
    if (swapped === "back") {
      // another program's save came in after the last compare: it is back in place (it was out for microseconds)
      let st: Stats | null = null;
      try {
        st = lstatSync(tmp);
      } catch {
        /* gone */
      }
      collided.add(resolve(path));
      if (st && st.ino === tmpIno) {
        rmSync(tmp, { force: true });
        throw new ConcurrentChange(path, false);
      }
      // yet another save came in between: the newest is put in place, the one in between kept aside
      const saved = join(backupsDir("lost"), `${encodeURIComponent(target)}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
      if (st && swapNames(tmp, target)) renameSync(tmp, saved);
      throw new LostWrite(path, saved);
    }
    if (swapped) afterSwap(path, target, tmp, held, buf, want, tmpIno);
    else if (held) afterReplace(path, held, buf);
    return;
  }
  // a new file: private (0600) whatever the umask (J3 v4 M1: umask 000 made world-writable hook configs)
  writeFileSync(tmp, buf, { mode: 0o600 });
  chmodSync(tmp, opts.mode ?? 0o600);
  if (check) {
    if (opts.expect !== null) {
      rmSync(tmp, { force: true });
      throw new ConcurrentChange(path, false); // it was there when the edit started and is gone now
    }
    try {
      linkSync(tmp, target); // atomic, and fails if someone created the file meanwhile
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        rmSync(tmp, { force: true });
        throw new ConcurrentChange(path, false);
      }
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "ENOSYS") {
        rmSync(tmp, { force: true });
        throw e;
      }
      // a filesystem without hard links: check, then rename
      if (existsSync(target)) {
        rmSync(tmp, { force: true });
        throw new ConcurrentChange(path, false);
      }
      renameSync(tmp, target);
      return;
    }
    rmSync(tmp, { force: true });
    return;
  }
  renameSync(tmp, target);
}

/**
 * Delete a file only if it still holds exactly `held`'s bytes and inode (an M1 rollback of a file bot-link created).
 * -> deleted?
 */
export function unlinkIfStill(path: string, held: Held): boolean {
  const target = resolveTarget(path);
  const aside = `${target}.botlink.del`;
  // moved aside (atomic), then checked: it must be the inode that was read. A save another program renamed in
  // meanwhile is put back (or kept, when the name was taken again), never deleted
  if (!ifStill(target, held.buf, null, () => renameSync(target, aside), undefined, held.ino)) return false;
  const st = statSync(aside);
  if (st.ino === held.ino && st.dev === held.dev) {
    unlinkSync(aside);
    return true;
  }
  try {
    linkSync(aside, target);
    unlinkSync(aside);
  } catch {
    const saved = join(backupsDir("lost"), `${encodeURIComponent(target)}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
    renameSync(aside, saved);
    throw new LostWrite(path, saved);
  }
  return false;
}

// ---------------------------------------------------------------- before/after
const oct = (m: number | null) => (m === null ? "?" : "0" + (m & 0o7777).toString(8));

/** Every way `path` differs now from its snapshot (empty = bytes, mode and symlink-ness all identical). */
export function stateDiff(path: string, snap: Snapshot): string[] {
  const now = stateOf(path);
  const out: string[] = [];
  if ((snap.link ?? null) !== (now.link ?? null)) {
    out.push(snap.link === null ? `it is now a symlink to ${now.link} (it was a regular file)` : now.link === null ? `it was a symlink to ${snap.link} and is now ${now.exists ? "a regular file" : "gone"}` : `it links to ${now.link} (it linked to ${snap.link})`);
  }
  if (snap.created || !snap.existed) {
    if (now.exists) out.push(snap.link !== null ? `${now.target} exists now (the link pointed at nothing before)` : "the file exists now (it didn't before)");
    return out;
  }
  if (!now.exists) {
    out.push("the file is gone");
    return out;
  }
  if (snap.sha256 === null) out.push("there is no copy from before bot-link was set up to compare the content with");
  else if (snap.sha256 !== now.sha256) out.push(contentDiff(snap, now.target));
  if (snap.mode === null) out.push("its mode from before bot-link wasn't recorded");
  else if (snap.mode !== now.mode) out.push(`its mode is ${oct(now.mode)} (it was ${oct(snap.mode)})`);
  return out;
}

function contentDiff(snap: Snapshot, target: string): string {
  if (!snap.bak || !existsSync(snap.bak)) return "its content differs from the original";
  const a = readFileSync(snap.bak, "utf-8").split("\n");
  const b = readFileSync(target, "utf-8").split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length - 1 && i === b.length && a[i] === "") return "its final newline is missing (the original ended with one)";
  if (i === b.length - 1 && i === a.length && b[i] === "") return "it ends with a newline the original didn't have";
  return `its content differs from the original from line ${i + 1} on`;
}

export const modeStr = oct;
