/**
 * Putting bot-link into the apps on this computer (`up`, the first `join`) and taking it out (`uninstall`).
 * The config edits themselves are botlink-mcp's span edits (harnesses.ts): only bot-link's own entry and hooks,
 * a ledger + backups before the first write, uninstall removes only that span.
 */
import { selfCmd } from "./version.js";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { currentDir, runKind, shimCli } from "./update.js";
import { findOld, removeOld, type OldEntry } from "./oldentries.js";

import * as h from "./harnesses.js";
import { installService, serviceFile, uninstallService, unitInstalled } from "./service.js";
import { cliPath } from "./harnesses.js";
import type { App } from "./state.js";
import { cursorChatFromEnv } from "./session.js";

export type SetupApp = "claude-code" | "codex" | "cursor" | "opencode";
/** OpenCode: MCP only (opencode.json "mcp", type local); it has no hooks bot-link uses, so its chats read messages
 *  with the inbox tool and stay reachable with `listen --on-message "opencode run --continue …"`. */
export const SETUP_APPS: SetupApp[] = ["claude-code", "codex", "cursor", "opencode"];

function mark(r: h.Report): string {
  return r.ok ? (r.warn ? "!" : "✓") : "✗";
}

export function reportLines(r: h.Report): string[] {
  const out = [`${mark(r)} ${h.LABELS[r.harness]}`];
  for (const c of r.changes) if (c.action !== "unchanged") out.push(`  ${c.action} ${c.file} (${c.detail})`);
  for (const n of r.notes) out.push(`  ${n}`);
  return out;
}

/** Is this a loopback / local-only server URL (a dev or test server)? */
export function isLocalServer(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1" || host === "0.0.0.0" || host === "::";
}

/** `--dev` or BOTLINK_DEV=1: the caller knowingly installs a local/test server into this app config. */
export function devAllowed(flag = false): boolean {
  return flag || process.env.BOTLINK_DEV === "1";
}

/**
 * FINDINGS F4: a test or dev run with BOTLINK_SERVER=http://127.0.0.1:… must never write bot-link into a person's real
 * app config (~/.codex, ~/.claude, ~/.cursor): that entry then shadows their real bot-link install in every chat. So
 * installing with a local server needs an explicit --dev (or BOTLINK_DEV=1). -> why not, or null when fine.
 */
export function localInstallProblem(apps: string[], dev = false): string | null {
  const server = process.env.BOTLINK_SERVER;
  if (!server || !isLocalServer(server) || devAllowed(dev)) return null;
  const where = apps.map((a) => (h.LABELS as Record<string, string>)[a] || a).join(", ");
  return `BOTLINK_SERVER is a local server (${server}), so bot-link did not set itself up in ${where || "your apps"}: an entry pointing at a test server would shadow your real bot-link in every chat. Nothing was changed. If you mean it (a dev setup in a throwaway config), run again with --dev (or BOTLINK_DEV=1).`;
}

/** Install bot-link into `app` if it isn't there yet. -> lines to print (empty when already set up). */
export function ensureInstalled(app: App, o: { dev?: boolean } = {}): { lines: string[]; ok: boolean } {
  // T3 Code: nothing of bot-link's is installed into it (a thread uses the command line; its wake is `t3 thread send`)
  if (app === "other" || app === "t3" || app === "antigravity" || app === "grok-bot") return { lines: [], ok: true };
  if (h.configured(app)) return { lines: [], ok: true };
  const bad = localInstallProblem([app], o.dev);
  if (bad) return { lines: [bad], ok: false };
  const r = h.setup(app);
  return { lines: [`bot-link set up ${h.LABELS[app]} on this computer (it edited only its own entries, with a backup):`, ...reportLines(r)], ok: r.ok };
}

/** Apps found on this computer. */
export function foundApps(): SetupApp[] {
  const d = h.detect();
  return SETUP_APPS.filter((a) => d[a]?.found);
}

/** Can watch wake a chat of this app here? Cursor: only when this process knows its chat (CURSOR_CONVERSATION_ID). */
export function serviceInstalledFor(app: App): boolean {
  if (app === "cursor") return !!cursorChatFromEnv() && unitInstalled();
  return (app === "claude-code" || app === "codex") && unitInstalled();
}

export function watchArgv(): string[] {
  return [h.stableNode(), cliPath(), "watch"];
}

export function watchInstall(): string[] {
  const r = installService(watchArgv());
  return [...r.lines, "bot-link watch is on: Claude Code, Codex and Cursor chats that are members wake in seconds when a message arrives."];
}

export function watchUninstall(): string[] {
  return uninstallService().lines;
}

export function watchStatus(): string[] {
  const f = serviceFile();
  return [unitInstalled() ? `bot-link watch is installed (${f}).` : `bot-link watch is not installed (${f} ${existsSync(f) ? "exists but isn't bot-link's" : "is absent"}).`];
}

export function up(o: { apps?: SetupApp[]; watch?: boolean; dev?: boolean } = {}): { lines: string[]; ok: boolean } {
  const apps = o.apps && o.apps.length ? o.apps : foundApps();
  const bad = apps.length ? localInstallProblem(apps, o.dev) : null;
  if (bad) return { lines: [bad], ok: false };
  const lines: string[] = [];
  let ok = true;
  if (!apps.length) lines.push(`No Claude Code, Codex, Cursor or OpenCode found on this computer. Install one, then run \`${selfCmd()} up\` again.`);
  for (const a of apps) {
    const r = h.setup(a);
    ok &&= r.ok;
    lines.push(...reportLines(r));
  }
  if (o.watch !== false && apps.some((a) => a !== "opencode")) {
    try {
      lines.push(...watchInstall());
    } catch (e) {
      ok = false;
      lines.push(`! bot-link watch was not installed: ${(e as Error).message}`);
    }
  }
  return { lines, ok };
}

export function uninstallAll(o: { apps?: SetupApp[]; scope?: "project" | "user"; dir?: string } = {}): { lines: string[]; ok: boolean } {
  const lines: string[] = [];
  let ok = true;
  // both scopes unless one is named: this folder's project files, then the profile-wide ones
  const scopes: h.Scope[] = o.scope === "user" ? [{ kind: "user" }] : o.scope === "project" ? [{ kind: "project", dir: o.dir || process.cwd() }] : [{ kind: "project", dir: o.dir || process.cwd() }, { kind: "user" }];
  for (const sc of scopes) {
    h.withScope(sc, () => {
      const apps = o.apps && o.apps.length ? o.apps : SETUP_APPS.filter((a) => h.configured(a));
      for (const a of apps) {
        const r = h.uninstall(a);
        ok &&= r.ok;
        lines.push(...reportLines(r));
      }
    });
  }
  if (!o.apps || !o.apps.length) {
    lines.push(...watchUninstall());
    if (!o.scope || o.scope === "user") lines.push(...removeShim());
  }
  lines.push(`Your bot-link memberships and keys stay in ~/.botlink (leave a room with \`${selfCmd()} leave <name>\`).`);
  return { lines, ok };
}

// ---------------------------------------------------------------- self-update: configs launch the stable shim (SPEC §7.6)
/** bot-link cli.js paths in a config text that are NOT the stable shim: an npx cache copy, the old ~/.botlink/app,
 *  or one version's folder under ~/.botlink/client (pinned: an update swaps `current` and never reaches it). */
export function staleCliPaths(text: string, shim = shimCli()): string[] {
  const out = new Set<string>();
  const versions = dirname(dirname(dirname(shim))) + sep; // ~/.botlink/client/
  for (const m of text.matchAll(/[^\s"'`=,\[\]]*[\\/]dist[\\/]cli\.js/g)) {
    const p = m[0];
    if (p !== shim && (/[\\/]_npx[\\/]/.test(p) || /[\\/]\.botlink[\\/]app[\\/]dist[\\/]cli\.js$/.test(p) || p.startsWith(versions))) out.add(p);
  }
  return [...out];
}

/** Homebrew Cellar node paths in a config text that are not the node bot-link writes now (h.stableNode): a
 *  versioned folder that `brew upgrade node` deletes, or already deleted. */
export function staleNodePaths(text: string, node = h.stableNode()): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[^\s"'`=,\[\]]*[\\/]Cellar[\\/]node(?:@[\w.]+)?[\\/][^\s"'`\\/]+[\\/]bin[\\/]node(?=[\s"'`,\]]|$)/g)) if (m[0] !== node) out.add(m[0]);
  return [...out];
}

/** Set-up apps whose config files still launch bot-link from an npx cache, the old ~/.botlink/app copy, or a
 *  versioned Homebrew node. */
export function staleApps(): SetupApp[] {
  return SETUP_APPS.filter((a) => {
    if (!h.configured(a)) return false;
    return h.filesOf(a).some((f) => {
      try {
        const text = readFileSync(f.path, "utf-8");
        return staleCliPaths(text).length > 0 || staleNodePaths(text).length > 0;
      } catch {
        return false;
      }
    });
  });
}

/** Re-run setup (span edit, backup, ledger) for apps still pointing at an npx path, so they launch the shim. */
export function migrateToShim(): string[] {
  if (runKind() === "checkout") return [];
  const lines: string[] = [];
  for (const a of staleApps()) {
    if (localInstallProblem([a])) continue;
    const r = h.setup(a);
    lines.push(...reportLines(r));
  }
  return lines;
}

// ---------------------------------------------------------------- consent: preview first, project scope by default (SPEC §7.0)
export interface SetupOpts {
  apps?: SetupApp[];
  /** "project" (default): only chats started in `dir` get bot-link; "user": every chat of the app (profile-wide) */
  scope?: "project" | "user";
  /** the project folder (default: this folder) */
  dir?: string;
  watch?: boolean;
  /** the `botlink` launcher in ~/.local/bin */
  shim?: boolean;
  /** remove old bot-link (v3) servers found next to this one (backup first) */
  removeOld?: boolean;
  dev?: boolean;
}

export function scopeOf(o: SetupOpts): h.Scope {
  return o.scope === "user" ? { kind: "user" } : { kind: "project", dir: o.dir || process.cwd() };
}

/** Where `botlink` goes on PATH (user-local, no sudo). */
export const shimPath = () => join(h.home(), ".local", "bin", "botlink");
const SHIM_MARK = "# bot-link launcher";
export function shimContent(): string {
  const cli = runKind() === "checkout" ? cliPath() : shimCli();
  return `#!/bin/sh\n${SHIM_MARK} (written by botlink setup; botlink uninstall removes it)\nexec ${JSON.stringify(h.stableNode())} ${JSON.stringify(cli)} "$@"\n`;
}
const shimOurs = (p = shimPath()) => {
  try {
    return readFileSync(p, "utf-8").includes(SHIM_MARK);
  } catch {
    return false;
  }
};
export function shimState(): "absent" | "ours" | "current" | "foreign" {
  const p = shimPath();
  if (!existsSync(p)) return "absent";
  if (!shimOurs(p)) return "foreign";
  return readFileSync(p, "utf-8") === shimContent() ? "current" : "ours";
}
export function onPathDir(dir: string): boolean {
  return (process.env.PATH || "").split(delimiter).some((d) => d && resolve(d) === resolve(dir));
}
export function installShim(): string {
  const p = shimPath();
  const s = shimState();
  if (s === "foreign") return `! ${p} exists and isn't bot-link's launcher; left it alone (use ${selfCmd()} instead).`;
  if (s === "current") return `  ${p} already launches bot-link.`;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, shimContent(), { mode: 0o755 });
  chmodSync(p, 0o755);
  return `✓ ${s === "absent" ? "created" : "updated"} ${p}: \`botlink\` now runs this client${onPathDir(dirname(p)) ? "" : ` (${dirname(p)} isn't on your PATH yet: add it, or run ${p} directly)`}.`;
}
export function removeShim(): string[] {
  return shimOurs() ? (rmSync(shimPath(), { force: true }), [`✓ removed ${shimPath()}`]) : [];
}

/** The config files of the apps (both scopes) that may hold an OLD bot-link server. */
export function oldFiles(apps: SetupApp[], dir: string): { path: string; format: "json" | "toml"; key?: string }[] {
  const out: { path: string; format: "json" | "toml"; key?: string }[] = [];
  for (const sc of [{ kind: "user" } as h.Scope, { kind: "project", dir } as h.Scope]) {
    h.withScope(sc, () => {
      for (const a of apps) {
        if (a === "claude-code") out.push({ path: h.claudeJsonPath(), format: "json" });
        if (a === "codex") out.push({ path: join(h.codexHome(), "config.toml"), format: "toml" });
        if (a === "cursor") out.push({ path: join(h.cursorDir(), "mcp.json"), format: "json" });
        if (a === "opencode") out.push({ path: h.opencodePath(), format: "json", key: "mcp" });
      }
    });
  }
  return out;
}

/** Simple line diff for the preview: + added, - removed (common lines skipped). */
export function lineChanges(before: string | null, after: string): string[] {
  const a = (before ?? "").split("\n"), b = after.split("\n");
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [`(${m} lines; too large to show line by line)`];
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out.filter((l) => l.trim() !== "+" && l.trim() !== "-");
}

const tilde = (p: string) => (p.startsWith(h.home() + "/") ? "~" + p.slice(h.home().length) : p);

function setupCmd(o: SetupOpts, extra: string[] = []): string {
  const parts = [selfCmd(), "setup", ...(o.apps?.length ? o.apps : [])];
  if (o.scope === "user") parts.push("--scope", "user");
  else if (o.dir && resolve(o.dir) !== resolve(process.cwd())) parts.push("--dir", JSON.stringify(o.dir));
  if (o.watch === false) parts.push("--no-watch");
  if (o.shim === false) parts.push("--no-shim");
  if (o.dev) parts.push("--dev");
  return [...parts, ...extra].join(" ");
}

/**
 * What setup would change, without changing anything: per app the exact files and lines, the watch service, the
 * launcher, and old bot-link servers it found. -> lines to show the human, and whether there is anything to do.
 */
export function previewSetup(o: SetupOpts = {}): { lines: string[]; ok: boolean; pending: boolean; old: OldEntry[] } {
  const apps = o.apps && o.apps.length ? o.apps : foundApps();
  const bad = apps.length ? localInstallProblem(apps, o.dev) : null;
  if (bad) return { lines: [bad], ok: false, pending: false, old: [] };
  if (!apps.length) return { lines: [`No Claude Code, Codex, Cursor or OpenCode found on this computer. Install one, then run \`${selfCmd()} setup\` again.`], ok: false, pending: false, old: [] };
  const sc = scopeOf(o);
  const lines: string[] = [sc.kind === "project"
    ? `bot-link setup preview · project scope: only chats started in ${tilde(sc.dir)} get bot-link (--scope user: every chat of the app).`
    : "bot-link setup preview · user scope: EVERY chat of these apps on this computer gets bot-link (the default is --scope project)."];
  let pending = false;
  for (const a of apps) {
    const { result: r, files } = h.dryRun(() => h.withScope(sc, () => h.setup(a)));
    lines.push(`${h.LABELS[a]}${r.ok ? "" : " (can't be set up: see below)"}`);
    for (const c of r.changes) {
      if (c.action === "unchanged") {
        lines.push(`  ${tilde(c.file)}: already set up (${c.detail})`);
        continue;
      }
      pending = true;
      const f = files.get(resolve(c.file));
      lines.push(`  ${c.action === "created" ? "create" : "edit"} ${tilde(c.file)} (${c.detail}):`);
      const diff = f ? lineChanges(f.before, f.after) : [];
      for (const l of diff.slice(0, 40)) lines.push(`    ${l}`);
      if (diff.length > 40) lines.push(`    … ${diff.length - 40} more lines`);
    }
    if (!r.ok) for (const n of r.notes) lines.push(`  ${n}`);
  }
  if (o.watch !== false && apps.some((a) => a !== "opencode") && !unitInstalled()) {
    pending = true;
    lines.push(`bot-link watch (wakes a closed Claude Code / Codex / Cursor chat when a message comes): create ${tilde(serviceFile())} and start it`);
  }
  const ss = shimState();
  if (o.shim !== false && (ss === "absent" || ss === "ours")) {
    pending = true;
    lines.push(`launcher: ${ss === "absent" ? "create" : "update"} ${tilde(shimPath())} (2 lines: runs ${tilde(runKind() === "checkout" ? cliPath() : shimCli())}), so \`botlink …\` works in any terminal`);
  }
  const old = findOld(oldFiles(apps, sc.kind === "project" ? sc.dir : process.cwd()));
  if (old.length) {
    lines.push("Old bot-link servers found (their tools look like bot-link's but can't reach room members; a chat sees both sets):");
    for (const e of old) lines.push(`  ${tilde(e.file)}: "${e.name}" (${e.command})`);
    if (o.removeOld) pending = true;
    lines.push(o.removeOld ? "  → they will be removed (a backup copy of each file first)." : "  → add --remove-old to remove them (a backup copy of each file first).");
  }
  lines.push(pending
    ? `Nothing was changed yet. Show this to your human; with their OK run:\n  ${setupCmd(o, ["--yes", ...(old.length && !o.removeOld ? [] : o.removeOld ? ["--remove-old"] : [])])}${old.length && !o.removeOld ? `\n  (or with --remove-old as well, to remove the old servers)` : ""}`
    : "Everything is already set up; nothing to change.");
  return { lines, ok: true, pending, old };
}

/** Apply setup (the human said yes to the preview). */
export function applySetup(o: SetupOpts = {}): { lines: string[]; ok: boolean } {
  const apps = o.apps && o.apps.length ? o.apps : foundApps();
  const bad = apps.length ? localInstallProblem(apps, o.dev) : null;
  if (bad) return { lines: [bad], ok: false };
  const sc = scopeOf(o);
  const lines: string[] = [];
  let ok = true;
  if (!apps.length) lines.push(`No Claude Code, Codex, Cursor or OpenCode found on this computer. Install one, then run \`${selfCmd()} setup\` again.`);
  for (const a of apps) {
    const r = h.withScope(sc, () => h.setup(a));
    ok &&= r.ok;
    lines.push(...reportLines(r));
  }
  if (o.removeOld) lines.push(...removeOld(findOld(oldFiles(apps, sc.kind === "project" ? sc.dir : process.cwd()))));
  if (o.watch !== false && apps.some((a) => a !== "opencode")) {
    try {
      lines.push(...watchInstall());
    } catch (e) {
      ok = false;
      lines.push(`! bot-link watch was not installed: ${(e as Error).message}`);
    }
  }
  if (o.shim !== false) lines.push(installShim());
  lines.push(...consolidateLegacy());
  return { lines, ok };
}

/** Is bot-link set up for this app where this chat runs (its project folder, or profile-wide)? */
export function configuredHere(app: App, dir = process.cwd()): "project" | "user" | null {
  if (app === "other" || app === "t3" || app === "antigravity" || app === "grok-bot") return null;
  const a = app as SetupApp;
  if (h.withScope({ kind: "project", dir }, () => h.configured(a))) return "project";
  if (h.withScope({ kind: "user" }, () => h.configured(a))) return "user";
  return null;
}

/**
 * One client copy (feedback: "two copies of the CLI disagree"): the old ~/.botlink/app directory becomes a link to
 * ~/.botlink/client/current, once no running process uses it (a running MCP server keeps its files until it exits).
 */
export function consolidateLegacy(): string[] {
  if (runKind() === "checkout") return [];
  const legacy = join(h.home(), ".botlink", "app");
  const target = currentDir();
  try {
    if (process.env.BOTLINK_HOME && resolve(process.env.BOTLINK_HOME) !== resolve(join(h.home(), ".botlink"))) return [];
    if (!existsSync(legacy) || lstatSync(legacy).isSymbolicLink() || !existsSync(target)) return [];
    const ps = spawnSync("ps", ["-A", "-o", "args="], { encoding: "utf-8" });
    if (ps.status !== 0 || ps.stdout.includes(join(legacy, "dist", "cli.js"))) return [`  ${tilde(legacy)} (an older copy) is still used by a running app; it becomes a link to the current copy after the app restarts and setup runs again.`];
    const aside = `${legacy}.old-${Date.now()}`;
    renameSync(legacy, aside);
    symlinkSync(target, legacy);
    return [`✓ ${tilde(legacy)} now points at the one current copy (${tilde(target)}); the old copy is kept in ${tilde(aside)}.`];
  } catch (e) {
    return [`! couldn't replace ${tilde(legacy)} (${(e as Error).message}); it is unused by your apps.`];
  }
}
