/**
 * Harness integration: detect, set up, uninstall, and check Claude Code, Codex, Cursor and generic MCP.
 *
 * Rules (J3 "malware with good intentions" bar):
 *   - Always bot-link's own JSON/TOML merge that touches ONLY our entry; never `claude mcp add|remove` or
 *     `codex mcp add|remove` (they rewrite the whole file). A harness CLI on PATH only validates afterwards.
 *     Other servers, hooks, settings and permissions are never changed; inside our own entry only the keys
 *     bot-link owns (type, command, args, its env keys) are set, so a user's `tools`, `enabled`,
 *     `startup_timeout_sec`, ... stay.
 *   - Idempotent: an unchanged entry is not rewritten (same bytes, same mtime). Formatting is preserved
 *     (indent detected from the file).
 *   - Setup only ADDS or UPDATES bot-link's own span (span.ts): its cloud entry, the hooks it recognises as its own
 *     (exact commands, or structurally `<node> <botlink pkg>/dist/cli.js hook <app> <event>`), and containers it
 *     needs. Its edit is refused unless (new text minus our span) === (old text minus our span), byte for byte.
 *   - Uninstall only REMOVES that span, from the CURRENT bytes, cut by self-checked cut; it never writes old bytes
 *     back. It deletes a file only when the ledger says bot-link created it and an empty skeleton is all that is
 *     left. `uninstall <app> --restore <file> --force` is the one way back to the pre-bot-link copy (.bak), and it
 *     shows what that loses first.
 *   - The ledger (filesafe.ts) records, before the first write, what was there (bytes in a `.bak`, mode, symlink);
 *     a `.prev` before every write; the containers bot-link created; inode/link count after each write.
 * Set BOTLINK_MCP_NO_HARNESS_CLI=1 to force the file merge (tests, or a broken harness CLI).
 */
import { parseToml, tomlHeaders, tomlTableRanges, verifyTomlEdit, canonToml, statementEnd } from "./toml-span.js";
import { getAt, hookShape, shellQuote, innerOf, ownsHook, parseJsonStrict, roleOf, setAt, SKELETONS, SpanError, spanItems, stripJson, stripToml, type HookOwner, type JPath, type JsonKind, type SpanItem } from "./span.js";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants as FS, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync, cpSync, rmSync, renameSync, rmdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { homeDir, UNATTENDED_TOOL_NAMES } from "./config.js";
import { applyJsonChange, hasComments, parseJsonc, tokenCanon } from "./jsonedit.js";
import * as jsonc from "jsonc-parser";
import { anySnapshotOf, beginAttempt, clearOverride, collided, dropSnapshot, endAttempt, FileBusy, InPlaceRace, forget, hasOverride, heldOf, overrideOf, isLink, keepNew, ledgerProblem, knownHookCommands, LostWrite, modeStr, OrphanWrite, otherLinks, readForEdit, recordBeforeWrite, recordHookCommands, backupsDir, ConcurrentChange, dirNames, RefusedLink, resolveTarget, setOverride, sha, snapshotOf, snapshotPaths, spanInfo, unlinkIfStill, updateSpanInfo, withLock, writeContent, writePrivate, type Held, type SpanInfo, type Snapshot } from "./filesafe.js";
import { PKG_ROOT, VERSION, installSpec, selfCmd } from "./version.js";
import { currentDir, installSelf, runKind } from "./update.js";

export type HarnessKey = "claude-code" | "codex" | "cursor" | "vscode" | "claude-desktop" | "windsurf" | "gemini-cli" | "antigravity" | "opencode" | "zed" | "muse-code" | "mcp";
/** Harnesses `doctor` checks and `up` can detect (generic MCP has nothing to detect). */
export const ALL_HARNESSES: HarnessKey[] = ["claude-code", "codex", "cursor"];
/**
 * Apps whose MCP config format bot-link could not verify in the vendor's own docs: detected, and `setup` PRINTS the
 * entry to paste; bot-link never writes their files.
 *   Muse Code (Meta, beta since 2026-08): third-party guides describe "mcp_servers" in ~/.config/muse/settings.json
 *   ("transport": "stdio" | "streamable_http"); no Meta document confirms it, and one report says the beta has no
 *   MCP at all (checked 2026-11-04).
 */
export const PASTE_ONLY: ReadonlySet<HarnessKey> = new Set<HarnessKey>(["muse-code"]);
export const KNOWN_HARNESSES: HarnessKey[] = [...ALL_HARNESSES];
export const LABELS: Record<string, string> = {
  "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", vscode: "VS Code + Copilot CLI", "claude-desktop": "Claude Desktop",
  windsurf: "Windsurf/Devin", "gemini-cli": "Gemini CLI", antigravity: "Antigravity CLI", opencode: "OpenCode", zed: "Zed", "muse-code": "Muse Code", mcp: "generic MCP",
};
/** The agent-name suffix: <host>-<short>. */
export const SHORT: Record<HarnessKey, string> = {
  "claude-code": "claude-code", codex: "codex", cursor: "cursor", vscode: "vscode", "claude-desktop": "claude-desktop",
  windsurf: "windsurf", "gemini-cli": "gemini", antigravity: "antigravity", opencode: "opencode", zed: "zed", "muse-code": "muse", mcp: "mcp",
};
export const SERVER_NAME = "botlink";
/** Used when "botlink" is taken by something that is not bot-link v1's entry (botlink-mcp, typically). */
export const ALT_NAME = "botlink-v1";
const NAMES = [SERVER_NAME, ALT_NAME];

/** bot-link v1's entry launches `<node> <...>/dist/cli.js mcp --app <app>` (botlink-mcp's `serve --cloud` is not ours). */
export function isCloudEntry(e: any): boolean {
  const a = Array.isArray(e?.args) ? e.args : Array.isArray(e?.command) ? e.command : [];
  return a.includes("mcp") && a.includes("--app") && !a.includes("serve") && a.some((x: unknown) => typeof x === "string" && /[\\/]dist[\\/]cli\.js$/.test(x));
}

/** The names under which our cloud entry currently sits. */
function cloudNamesIn(servers: Record<string, any> | undefined): string[] {
  return servers ? NAMES.filter((n) => servers[n] && isCloudEntry(servers[n])) : [];
}

/** The name to install under: "botlink", unless that is someone else's entry, which is never replaced. */
function pickName(servers: Record<string, any> | undefined): string {
  if (servers && servers[SERVER_NAME] && !isCloudEntry(servers[SERVER_NAME])) return ALT_NAME;
  return SERVER_NAME;
}

function foreignNote(servers: Record<string, any> | undefined, where: string): string | null {
  return servers && servers[SERVER_NAME] && !isCloudEntry(servers[SERVER_NAME])
    ? `${where} already has a "${SERVER_NAME}" server that is not bot-link v1 (an older botlink-mcp setup, most likely); bot-link checked after the write that it is unchanged, and bot-link v1 was added as "${ALT_NAME}".`
    : null;
}

export interface Change {
  file: string;
  action: "created" | "updated" | "unchanged" | "removed" | "cli" | "restored" | "skipped";
  detail: string;
  /** uninstall: what the user had added inside bot-link's entries, removed with them */
  added?: string[];
}

export interface Report {
  harness: HarnessKey;
  ok: boolean;
  changes: Change[];
  notes: string[];
  /** a PASTE_ONLY app whose file holds our entry: the user removes it by hand (bot-link never writes it) */
  manual?: boolean;
  /** uninstall: every file bot-link touched was compared with its pre-bot-link snapshot (bytes, mode, link) and matched */
  exact?: boolean;
  /** the change went in, but another program saved a file at the same instant (collisionNote): not a success */
  collision?: boolean;
  /** set up, but something of the user's keeps the app from loading it (e.g. `enabled = false`): "!" not "✓" */
  warn?: boolean;
}

// ---------------------------------------------------------------- scope (SPEC §7.0: consent before config edits)
/**
 * Where setup writes. "project" (the default since r2): the app's PROJECT files in one folder, so only chats started
 * in that folder get bot-link (Claude Code <dir>/.mcp.json + <dir>/.claude/settings.local.json, Codex <dir>/.codex/,
 * Cursor <dir>/.cursor/, OpenCode <dir>/opencode.json). "user": the app's profile-wide files (every chat of that app).
 */
export type Scope = { kind: "user" } | { kind: "project"; dir: string };
let SCOPE: Scope = { kind: "user" };
export function currentScope(): Scope {
  return SCOPE;
}
/** Run fn with every path function below pointing at that scope's files. */
export function withScope<T>(sc: Scope, fn: () => T): T {
  const prev = SCOPE;
  SCOPE = sc.kind === "project" ? { kind: "project", dir: resolve(sc.dir) } : sc;
  try {
    return fn();
  } finally {
    SCOPE = prev;
  }
}
const projectDir = (): string | null => (SCOPE.kind === "project" ? SCOPE.dir : null);

/** Dry run (the preview shown before any config edit): writes are captured here instead of made. */
let DRY: Map<string, { before: string | null; after: string }> | null = null;
/** Run fn without writing anything; -> what each file would become. */
export function dryRun<T>(fn: () => T): { result: T; files: Map<string, { before: string | null; after: string }> } {
  const prev = DRY;
  DRY = new Map();
  try {
    const result = fn();
    return { result, files: DRY };
  } finally {
    DRY = prev;
  }
}
export const isDryRun = () => DRY !== null;

// ---------------------------------------------------------------- where things live
export function home(): string {
  return process.env.HOME || homedir();
}
export function claudeConfigDir(): string {
  const pd = projectDir();
  if (pd) return join(pd, ".claude");
  return process.env.CLAUDE_CONFIG_DIR || join(home(), ".claude");
}
/** User-scope MCP servers: ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json when that is set. Project scope: the
 *  folder's .mcp.json (same "mcpServers" shape; approved by enabledMcpjsonServers in .claude/settings.local.json). */
export function claudeJsonPath(): string {
  const pd = projectDir();
  if (pd) return join(pd, ".mcp.json");
  return process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home(), ".claude.json");
}
/** Where Claude Code's hooks go: ~/.claude/settings.json (user) or <dir>/.claude/settings.local.json (project: the
 *  personal, untracked project file; Claude Code applies it once the folder is trusted). */
export function claudeSettingsPath(): string {
  return join(claudeConfigDir(), projectDir() ? "settings.local.json" : "settings.json");
}
export function codexHome(): string {
  const pd = projectDir();
  if (pd) return join(pd, ".codex");
  return process.env.CODEX_HOME || join(home(), ".codex");
}
/** The user-level Codex home, whatever the scope (projects.<dir>.trust_level lives there). */
export function codexUserHome(): string {
  return process.env.CODEX_HOME || join(home(), ".codex");
}
/** Is dir (or a parent) a trusted Codex project ([projects."<dir>"] trust_level = "trusted" in the user config)? Read only. */
export function codexProjectTrusted(dir: string): boolean {
  try {
    const doc = parseToml(readFileSync(join(codexUserHome(), "config.toml"), "utf-8")) as any;
    const ps = doc?.projects || {};
    for (let d = resolve(dir); ; d = dirname(d)) {
      if (ps[d]?.trust_level === "trusted") return true;
      if (d === dirname(d)) return false;
    }
  } catch {
    return false;
  }
}
export function cursorDir(): string {
  const pd = projectDir();
  if (pd) return join(pd, ".cursor");
  return join(home(), ".cursor");
}
/** Cursor CLI's global config dir (cursor-agent: $CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, else ~/.cursor). */
export function cursorConfigDir(): string {
  const c = (process.env.CURSOR_CONFIG_DIR || "").trim();
  if (c) return c;
  const x = (process.env.XDG_CONFIG_HOME || "").trim();
  return x ? join(x, "cursor") : cursorDir();
}
/** Cursor CLI's global settings (permissions live here; cursor-agent rewrites the rest of this file itself). */
export function cursorCliConfigPath(): string {
  const pd = projectDir();
  if (pd) return join(pd, ".cursor", "cli.json"); // cursor.com/docs/cli/reference/permissions: <project>/.cursor/cli.json
  return join(cursorConfigDir(), "cli-config.json");
}
/**
 * The rules that let headless Cursor (`cursor-agent -p`, watch's resume) call bot-link's MCP tools without a prompt
 * (`Mcp(<server>:<tool>)`, cursor.com/docs/cli/reference/permissions): the same tools Claude Code's unattended
 * resume may use. leave, claim, save_rule and join are not in it: Cursor still asks the human for those.
 */
export const cursorPermRules = (server: string) => UNATTENDED_TOOL_NAMES.map((t) => `Mcp(${server}:${t})`);
/** Per-OS application-support dir: macOS ~/Library/Application Support, Windows %APPDATA%, else ~/.config. */
export function appSupportDir(): string {
  return appSupport();
}
function appSupport(): string {
  if (process.platform === "darwin") return join(home(), "Library", "Application Support");
  if (process.platform === "win32") return process.env.APPDATA || join(home(), "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME || join(home(), ".config");
}
/**
 * VS Code ("Copilot Global") and GitHub Copilot CLI share one file: "Copilot Global writes to
 * $COPILOT_HOME/mcp-config.json, or ~/.copilot/mcp-config.json when COPILOT_HOME is unset"
 * (code.visualstudio.com/docs/copilot/customization/mcp-servers; docs.github.com Copilot CLI). The profile
 * mcp.json / .vscode/mcp.json ("servers") are "labeled deprecated", so they are not written.
 */
export function vscodeMcpPath(): string {
  return join(process.env.COPILOT_HOME || join(home(), ".copilot"), "mcp-config.json");
}
/** Claude Desktop config (modelcontextprotocol.io/quickstart/user). */
export function claudeDesktopPath(): string {
  return join(appSupport(), "Claude", "claude_desktop_config.json");
}
/**
 * Windsurf, renamed Devin Desktop (2026-06): user MCP config ~/.config/devin/mcp_config.json, Windows
 * %APPDATA%\devin\mcp_config.json (docs.devin.ai/cli/reference/configuration/config-file). An older Windsurf
 * install keeps ~/.codeium/windsurf/mcp_config.json; that one is used only when the new dir doesn't exist.
 */
export function windsurfPath(): string {
  const now = process.platform === "win32" ? join(process.env.APPDATA || join(home(), "AppData", "Roaming"), "devin") : join(home(), ".config", "devin");
  const legacy = join(home(), ".codeium", "windsurf");
  return join(!existsSync(now) && existsSync(legacy) ? legacy : now, "mcp_config.json");
}
/** Muse Code user settings (third-party guides; see PASTE_ONLY): ~/.config/muse/settings.json. Read, never written. */
export function musePath(): string {
  return join(home(), ".config", "muse", "settings.json");
}
/** Antigravity CLI (replaced Gemini CLI for unpaid users, 2026-06-18): "Global configuration: ~/.gemini/config/mcp_config.json" (antigravity.google/docs/mcp). */
export function antigravityPath(): string {
  return join(home(), ".gemini", "config", "mcp_config.json");
}
/** OpenCode global config, "mcp" with type "local" + a command ARRAY (opencode.ai/docs/mcp-servers). JSONC. */
export function opencodePath(): string {
  const pd = projectDir();
  if (pd) return join(pd, "opencode.json"); // opencode.ai/docs/config: project opencode.json
  return join(process.env.XDG_CONFIG_HOME || join(home(), ".config"), "opencode", "opencode.json");
}
/** Zed settings, "context_servers" (zed.dev/docs/ai/mcp). JSONC: a file with comments is never rewritten. */
export function zedPath(): string {
  return join(process.env.XDG_CONFIG_HOME || join(home(), ".config"), "zed", "settings.json");
}
/** Gemini CLI user settings, mcpServers (geminicli.com/docs/tools/mcp-server). Merged directly: `gemini mcp add` defaults to project scope. */
export function geminiPath(): string {
  return join(home(), ".gemini", "settings.json");
}

/**
 * Where `setup h` writes, and whether that is a non-default place chosen by an environment variable or --config
 * (J6-r2: an inherited CLAUDE_CONFIG_DIR sent config into another profile; the user must always see it).
 */
export function configLocation(h: HarnessKey, configPath?: string): { dir: string; chosenBy: string | null } {
  const tilde = (p: string) => (p.startsWith(home() + "/") ? "~" + p.slice(home().length) : p);
  switch (h) {
    case "claude-code": return { dir: tilde(claudeConfigDir()), chosenBy: process.env.CLAUDE_CONFIG_DIR ? "CLAUDE_CONFIG_DIR" : null };
    case "codex": return { dir: tilde(codexHome()), chosenBy: process.env.CODEX_HOME ? "CODEX_HOME" : null };
    case "cursor": return { dir: tilde(cursorDir()), chosenBy: null };
    case "vscode": return { dir: tilde(dirname(vscodeMcpPath())), chosenBy: process.env.COPILOT_HOME ? "COPILOT_HOME" : null };
    case "mcp": return { dir: configPath ? tilde(dirname(configPath)) : "(printed)", chosenBy: configPath ? "--config" : null };
    case "muse-code": return { dir: "(printed)", chosenBy: null };
    default: {
      const p = JSON_HARNESS[h]?.path();
      const xdg = process.platform !== "darwin" && process.platform !== "win32" && process.env.XDG_CONFIG_HOME && p?.startsWith(process.env.XDG_CONFIG_HOME);
      return { dir: p ? tilde(dirname(p)) : "?", chosenBy: xdg ? "XDG_CONFIG_HOME" : null };
    }
  }
}

/** The JSON-config harnesses: file, the key that holds servers, and the entry shape. */
const JSON_HARNESS: Partial<Record<HarnessKey, { path: () => string; key: string; entry: (argv: string[]) => any; jsonc?: boolean }>> = {
  vscode: { path: vscodeMcpPath, key: "mcpServers", entry: (v) => ({ type: "local", command: v[0], args: v.slice(1), env: serverEnv(), tools: ["*"] }) },
  "claude-desktop": { path: claudeDesktopPath, key: "mcpServers", entry: (v) => ({ command: v[0], args: v.slice(1), env: serverEnv() }) },
  windsurf: { path: windsurfPath, key: "mcpServers", entry: (v) => ({ command: v[0], args: v.slice(1), env: serverEnv() }) },
  "gemini-cli": { path: geminiPath, key: "mcpServers", entry: (v) => ({ command: v[0], args: v.slice(1), env: serverEnv() }) },
  antigravity: { path: antigravityPath, key: "mcpServers", entry: (v) => ({ command: v[0], args: v.slice(1), env: serverEnv() }) },
  opencode: { path: opencodePath, key: "mcp", jsonc: true, entry: (v) => ({ type: "local", command: v, environment: serverEnv(), enabled: true }) },
  zed: { path: zedPath, key: "context_servers", jsonc: true, entry: (v) => ({ command: v[0], args: v.slice(1), env: serverEnv() }) },
};

/** argv of a server entry, whatever the harness's shape (command + args, or a command array). */
export function entryArgv(e: any): string[] {
  if (Array.isArray(e?.command)) return e.command;
  return [e?.command, ...(Array.isArray(e?.args) ? e.args : [])].filter((x) => typeof x === "string");
}

export function restartHint(h: HarnessKey): string {
  return ({
    "claude-code": "restart Claude Code (or run /mcp)", codex: `restart Codex, then run /hooks in Codex and trust the ${codexHookEvents().length} bot-link hooks`, cursor: "reload Cursor",
    vscode: "reload the VS Code window, then start the botlink server in Chat", "claude-desktop": "quit and reopen Claude Desktop",
    windsurf: "refresh MCP servers in Windsurf (or restart it)", "gemini-cli": "restart Gemini CLI", antigravity: "restart Antigravity CLI",
    opencode: "restart OpenCode", zed: "Zed picks it up on save (check the Agent panel)", "muse-code": "restart Muse Code", mcp: "restart your MCP app",
  } as Record<HarnessKey, string>)[h];
}

function onPath(cmd: string): boolean {
  if (process.env.BOTLINK_NO_HARNESS_CLI === "1") return false;
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 15000 });
  return r.status === 0;
}

export interface DetectInfo {
  key: HarnessKey;
  label: string;
  installed: boolean;
  why: string;
  version: string | null;
  connected: boolean;
}

function versionOf(cmd: string): string | null {
  if (process.env.BOTLINK_NO_HARNESS_CLI === "1") return null;
  const r = spawnSync(cmd, ["--version"], { encoding: "utf-8", timeout: 8000 });
  if (r.status !== 0) return null;
  const m = String(r.stdout || "").match(/\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z.]+)?/);
  return m ? m[0] : null;
}

/** Every harness bot-link knows, installed or not, with its version and whether bot-link is set up in it. */
export function detectAll(): DetectInfo[] {
  const d = detect();
  const bins: Partial<Record<HarnessKey, string>> = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent", vscode: "code", windsurf: "windsurf", "gemini-cli": "gemini", antigravity: "agy", opencode: "opencode", zed: "zed", "muse-code": "muse" };
  return KNOWN_HARNESSES.map((key) => {
    if (key === "mcp") return { key, label: LABELS[key], installed: false, why: "any MCP app", version: null, connected: false };
    const info = d[key as Exclude<HarnessKey, "mcp">];
    const bin = bins[key];
    return { key, label: LABELS[key], installed: info.found, why: info.why, version: info.found && bin ? versionOf(bin) : null, connected: configured(key as Exclude<HarnessKey, "mcp">) };
  });
}

export function detect(): Record<Exclude<HarnessKey, "mcp">, { found: boolean; why: string }> {
  if (SCOPE.kind !== "user") return withScope({ kind: "user" }, detect); // an app is on this computer or not, whatever the scope
  const cc = existsSync(claudeConfigDir()) || existsSync(claudeJsonPath()) || onPath("claude");
  const cx = existsSync(codexHome()) || onPath("codex");
  const cu = existsSync(cursorDir()) || onPath("cursor-agent");
  const dirOr = (dir: string, bin?: string, apps: string[] = []) => {
    if (existsSync(dir)) return { found: true, why: dir };
    for (const a of apps) if (existsSync(a)) return { found: true, why: a };
    if (bin && onPath(bin)) return { found: true, why: `${bin} on PATH` };
    return { found: false, why: "not found" };
  };
  return {
    "claude-code": { found: cc, why: cc ? (existsSync(claudeConfigDir()) ? claudeConfigDir() : "claude on PATH") : "not found" },
    codex: { found: cx, why: cx ? (existsSync(codexHome()) ? codexHome() : "codex on PATH") : "not found" },
    cursor: { found: cu, why: cu ? cursorDir() : "not found" },
    vscode: dirOr(dirname(vscodeMcpPath()), "code", ["/Applications/Visual Studio Code.app", join(appSupportDir(), "Code")]),
    "claude-desktop": dirOr(dirname(claudeDesktopPath()), "claude-desktop", ["/Applications/Claude.app"]),
    windsurf: dirOr(dirname(windsurfPath()), "windsurf", ["/Applications/Windsurf.app", "/Applications/Devin.app"]),
    "gemini-cli": dirOr(dirname(geminiPath()), "gemini"),
    antigravity: dirOr(dirname(antigravityPath()), "agy"),
    opencode: dirOr(dirname(opencodePath()), "opencode"),
    zed: dirOr(dirname(zedPath()), "zed", ["/Applications/Zed.app"]),
    "muse-code": dirOr(dirname(musePath()), "muse"),
  };
}

// ---------------------------------------------------------------- the command harnesses launch
/**
 * The package root harness configs launch (SPEC §7.6): ~/.botlink/client/current, a symlink to a versioned install,
 * when this copy runs from a throwaway npx cache, the old ~/.botlink/app copy, or an install under ~/.botlink/client
 * (self-update swaps `current`; configs never change). A git checkout is used in place (dev, tests).
 */
export function appRoot(): string {
  const kind = runKind();
  if (kind === "checkout") return PKG_ROOT;
  if (kind === "npx") return DRY ? currentDir() : withLock("app", () => installSelf());
  return currentDir();
}

export function cliPath(): string {
  return join(appRoot(), "dist", "cli.js");
}

/**
 * The node that app configs, hooks and the launcher run bot-link with. Homebrew's node runs as
 * /opt/homebrew/Cellar/node/<version>/bin/node (process.execPath is the resolved path), and `brew upgrade node` deletes
 * that folder: every app's bot-link entry would point at a node that no longer exists, and no update could reach it.
 * When a stable Homebrew link (opt/<formula>/bin/node, then bin/node) is the very same binary today, write that.
 */
export function stableNode(exec = process.execPath, candidates?: string[]): string {
  const m = /^(.*)[\\/]Cellar[\\/](node(?:@[\w.]+)?)[\\/][^\\/]+[\\/]bin[\\/]node$/.exec(exec);
  if (!m) return exec;
  const prefix = m[1], formula = m[2];
  const cands = candidates ?? [join(prefix, "opt", formula, "bin", "node"), ...(formula === "node" ? [join(prefix, "bin", "node")] : [])];
  let real: string;
  try {
    real = realpathSync(exec);
  } catch {
    return exec;
  }
  for (const c of cands) {
    try {
      if (realpathSync(c) === real) return c;
    } catch {
      /* not there */
    }
  }
  return exec;
}

export function serveArgv(h: HarnessKey): string[] {
  return [stableNode(), cliPath(), "mcp", "--app", h];
}

const q = shellQuote;

export function hookCommand(h: HarnessKey, event: string): string {
  return `${q(stableNode())} ${q(cliPath())} hook ${h} ${event}`;
}

function serverEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  if (process.env.BOTLINK_HOME) e.BOTLINK_HOME = process.env.BOTLINK_HOME;
  if (process.env.BOTLINK_SERVER) e.BOTLINK_SERVER = process.env.BOTLINK_SERVER;
  return e;
}

/** Every hook command bot-link writes for harness h right now. */
function currentHookCommands(h: string): string[] {
  if (h === "claude-code") return claudeHookSpecs().flatMap((s) => s.group.hooks.map((x: any) => x.command));
  if (h === "codex") return codexHookSpecs().flatMap((s) => s.group.hooks.map((x: any) => x.command));
  if (h === "cursor") return cursorHookSpecs().map((s) => s.entry.command);
  return [];
}

/** Who owns a hook command: the exact ones bot-link writes or recorded, or the structural shape (span.ts ownsHook). */
function owner(h: string): HookOwner {
  return { exact: new Set([...currentHookCommands(h), ...knownHookCommands(h)]), home: homeDir() };
}

/** Is this hook command bot-link's (for app h)? Exact command, or `<node> <botlink pkg>/dist/cli.js hook <h> <event>`. */
function OURS(h: string): (cmd: unknown) => boolean {
  const o = owner(h);
  return (cmd: unknown) => ownsHook(h, cmd, o);
}

const mcpKind = (key: string): JsonKind => ({ kind: "mcp", key, isOurs: (n, e) => NAMES.includes(n) && isCloudEntry(e) });
const hookKind = (h: string, flat: boolean): JsonKind => (flat ? { kind: "flat", isOurs: OURS(h) } : { kind: "nested", isOurs: OURS(h) });
/** bot-link's permission rules in a Cursor cli-config.json: only a rule bot-link itself added (the ledger says so). */
/** Claude Code project scope: bot-link's own name in .claude/settings.local.json enabledMcpjsonServers (approves the
 *  project .mcp.json server without a prompt once the folder is trusted; code.claude.com/docs/en/settings-reference). */
const approveKind = (path: string, adding: string[] = []): JsonKind => ({
  kind: "perm",
  at: ["enabledMcpjsonServers"],
  isOurs: (r) => typeof r === "string" && NAMES.includes(r) && (adding.includes(r) || (spanInfo(path).perms || []).includes(r)),
});
const permKind = (path: string, adding: string[] = []): JsonKind => ({
  kind: "perm",
  // (a wildcard Mcp(<server>:*) that an earlier build added is ours too, when the ledger says so: it goes on the next up)
  isOurs: (r) => typeof r === "string" && NAMES.some((n) => cursorPermRules(n).includes(r) || r === `Mcp(${n}:*)`) && (adding.includes(r) || (spanInfo(path).perms || []).includes(r)),
});
const isPlainObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const J = (p: JPath) => JSON.stringify(p);

// ---------------------------------------------------------------- careful file edits
function detectIndent(text: string): number | string {
  const m = text.match(/^[ \t]+(?=\S)/m);
  if (!m) return 2;
  return m[0].includes("\t") ? "\t" : m[0].length;
}

/** Read a JSON or JSONC config (comments and trailing commas are fine: they are kept on edit). */
function readJsonFile(path: string): { obj: any; text: string | null } {
  const text = readText(path);
  if (text === null) return { obj: {}, text: null };
  if (!text.trim()) return { obj: {}, text };
  const r = parseJsonc(text);
  if (r.error) {
    const bom = text.charCodeAt(0) === 0xfeff;
    const err = new Error(bom
      ? `${path} starts with a byte-order mark (BOM), so it is not valid JSON (${r.error}). Remove the BOM (the invisible first character; most editors can save "UTF-8 without BOM"), then run setup again; nothing was changed.`
      : `${path} is not valid JSON (${r.error}). Fix or move it, then run setup again; nothing was changed.`);
    (err as any).invalid = { path, detail: r.error };
    throw err;
  }
  return { obj: r.obj, text };
}

/**
 * A config's text as one STABLE read (filesafe readForEdit, J3 v7 C1/C2): never a 0-byte or half-written read of a
 * file another program is saving in place (it waits for that save, or throws FileBusy: nothing written). Inside an edit
 * attempt the read is taken once and held open until the write, which checks against exactly it. null: no file.
 */
function readText(path: string): string | null {
  const b = readForEdit(path, knownBytes(path)).plan;
  return b === null ? null : b.toString("utf-8");
}

const EMPTY_SHA = sha("");

/**
 * How many bytes the file held before, when bot-link's entry is supposed to be in it (a live ledger snapshot of a
 * non-empty original): a 0-byte read of it is then never the content (J3 v7 C1). 0: no such knowledge.
 */
function knownBytes(path: string): number {
  const snap = snapshotOf(path);
  if (!snap || (snap.existed && snap.sha256 === EMPTY_SHA)) return 0;
  let n = 1;
  for (const f of [latestPrev(path), snap.bak]) {
    try {
      if (f) n = Math.max(n, statSync(f).size);
    } catch {
      /* none */
    }
  }
  return n;
}

// ---------------------------------------------------------------- symlinked configs (stow / home-manager / chezmoi)
/** Where writes to `path` really go: through every symlink to its target, a dangling one included (the link itself is never replaced). */
function writeTarget(path: string): string {
  return resolveTarget(path);
}

export class ReadOnlyConfig extends Error {
  readonly = true;
}

function assertWritable(path: string) {
  const target = writeTarget(path);
  if (isLink(path) && !existsSync(target) && !existsSync(dirname(target))) {
    throw new RefusedLink(`${path} is a symlink to ${readlinkSync(path)}, which doesn't exist (nor does its folder ${dirname(target)}), so bot-link won't replace the link or create that folder; nothing was changed.`);
  }
  const via = target !== path ? ` (a link to ${target})` : "";
  try {
    if (existsSync(target)) accessSync(target, FS.W_OK);
  } catch {
    throw new ReadOnlyConfig(`${path}${via} is read-only, so bot-link won't touch it; nothing was changed.`);
  }
  try {
    accessSync(dirname(target), FS.W_OK);
  } catch {
    // the file may be writable, but bot-link writes a new copy beside it and renames it into place
    throw new ReadOnlyConfig(`${path}${via}: its folder ${dirname(target)} is read-only, so bot-link won't touch it; nothing was changed.`);
  }
}

/**
 * Does this config text hold any of bot-link's span (a cloud entry, or a hook bot-link recognises as its own,
 * structurally)? Such a file is never snapshotted as "the original" (J3 v4 H4), and configured() counts it.
 */
function holdsOurs(path: string, text: string): boolean {
  if (/\.toml$/.test(path)) return cloudNamesIn(tomlEntries(text)).length > 0;
  let doc: any;
  try {
    doc = parseJsonStrict(text);
  } catch {
    if (/cli\.js/.test(text) && /"--cloud"/.test(text)) return true;
    for (const h of ["claude-code", "codex", "cursor"]) for (const c of owner(h).exact) if (text.includes(JSON.stringify(c).slice(1, -1))) return true;
    return false;
  }
  for (const key of ["mcpServers", "context_servers", "mcp", "servers", "mcp_servers"]) if (spanItems(doc, mcpKind(key)).length) return true;
  for (const h of ["claude-code", "codex", "cursor"]) if (spanItems(doc, hookKind(h, false)).length || spanItems(doc, hookKind(h, true)).length) return true;
  if (spanItems(doc, permKind(path)).length) return true;
  return false;
}

/**
 * Where the backups of a config live: ~/.botlink-mcp/backups/<the config's path>.{bak,prev,link}, never beside the
 * config (a dotfiles repo would collect them, J3-r3 F9). A backup an older version left beside the config
 * (<file>.botlink-mcp.<kind>) is still found and used.
 */
export function backupPath(path: string, kind: "bak" | "prev" | "link"): string {
  const legacy = `${path}.botlink-mcp.${kind}`;
  if (existsSync(legacy)) return legacy;
  return `${backupBase(path)}.${kind}`;
}

/** ~/.botlink-mcp/backups/<the config's path, encoded> (the name every backup of that config starts with). */
function backupBase(path: string): string {
  let name = encodeURIComponent(resolve(path));
  if (name.length > 200) name = `${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}-${encodeURIComponent(basename(path)).slice(0, 120)}`;
  return join(homeDir(), "backups", name);
}

/**
 * J3b: a copy of `path` as it was before a bot-link write, in a NEW file `<backup>.prev.<UTC time>` (0600) that is
 * never overwritten, moved or deleted afterwards (the single rotating .prev slot lost the user's lines). -> its path.
 */
export function keepPrev(path: string, buf: Buffer | string): string {
  backupsDir();
  return keepNew(`${backupBase(path)}.prev`, buf);
}

/** Where restore --force saves the file as it was first: ~/.botlink-mcp/backups/<file>.pre-restore.<UTC time>. */
export function preRestoreBase(path: string): string {
  return `${backupBase(path)}.pre-restore`;
}

function keepPreRestore(path: string, buf: Buffer): string {
  backupsDir();
  return keepNew(preRestoreBase(path), buf);
}

/** Every kept copy of `path` from before a bot-link write (an older version's single .prev first), oldest first. */
export function prevCopies(path: string): string[] {
  const out: string[] = [];
  for (const legacy of [`${path}.botlink-mcp.prev`, `${backupBase(path)}.prev`]) if (existsSync(legacy)) out.push(legacy);
  const base = basename(backupBase(path)) + ".prev.";
  try {
    const dir = join(homeDir(), "backups");
    out.push(...readdirSync(dir).filter((f) => f.startsWith(base) && !f.slice(base.length).startsWith("tmp.")).sort().map((f) => join(dir, f)));
  } catch {
    /* no backups yet */
  }
  return out;
}

/** The newest kept copy of `path` (what doctor offers as the last resort), or null. */
export function latestPrev(path: string): string | null {
  const all = prevCopies(path);
  return all.length ? all[all.length - 1] : null;
}

/**
 * J3b: what bot-link removed of the user's (keys or comments inside bot-link's entry, lines in its unit) goes into a
 * permanent file of its own, ~/.botlink-mcp/backups/removed/<file>.<UTC time> (0600, never overwritten), next to a
 * pointer to the whole file as it was. -> its path.
 */
export function keepRemoved(path: string, what: string[], lines: string[], wholeFile: string | null): string {
  const dir = backupsDir("removed");
  const text = [
    `bot-link removed these of yours from ${resolve(path)} on ${new Date().toISOString()}:`,
    ...what.map((x) => `  - ${x}`),
    "",
    "The lines it removed (bot-link's entry, with what you had added inside it):",
    ...lines,
    "",
    ...(wholeFile ? [`The whole file as it was: ${wholeFile}`] : []),
    "",
  ].join("\n");
  return keepNew(join(dir, basename(backupBase(path))), text);
}

/**
 * Before EVERY write: the ledger snapshot (only the first time: .bak of the original bytes, its mode, the link
 * text even for a dangling link, or "nothing was here"), then a new .prev.<time> copy of the current content.
 */
function backupOnce(path: string, held: Held | null | undefined, plan: string | null): Snapshot {
  // J3 v7 C1: the backups are the stable read the edit planned from, never a fresh read (a half-done in-place save)
  const snap = recordBeforeWrite(path, (p, kind) => backupPath(p, kind), { hasOurs: plan !== null && !snapshotOf(path) && holdsOurs(path, plan) }, held);
  if (plan) keepPrev(path, plan);
  return snap;
}

/** Write only if the bytes change; keep a backup first; keep the file's mode; never replace a symlink. */
/** Directories bot-link created for a config are recorded, so uninstall can remove them again once empty (F6). */
function dirMarker(dir: string): string {
  return join(homeDir(), "backups", `${encodeURIComponent(resolve(dir))}.createddir`);
}

function removeCreatedDirs(path: string) {
  for (let d = dirname(path); d !== dirname(d); d = dirname(d)) {
    const m = dirMarker(d);
    if (!existsSync(m) || !existsSync(d)) break;
    try {
      if (readdirSync(d).length) break;
      rmdirSync(d); // only ever an empty directory
      rmSync(m, { force: true });
    } catch {
      break;
    }
  }
}

function writeIfChanged(path: string, next: string, prevText: string | null): Change["action"] {
  if (DRY) {
    if (prevText === next) return "unchanged";
    DRY.set(resolve(path), { before: prevText, after: next });
    return prevText === null ? "created" : "updated";
  }
  // the stable read this attempt planned from, still open: the write is checked against exactly it (J3 v7 H1)
  const held = heldOf(path);
  const inPlace = held === undefined ? prevText : held === null ? null : held.buf.toString("utf-8");
  if (prevText !== null && prevText === next && inPlace === next) return "unchanged";
  if (isLink(path) && !existsSync(writeTarget(path))) assertWritable(path); // a dangling link into a gone folder: refused before anything
  backupOnce(path, held, prevText); // the ledger snapshot comes before ANY write, a folder included
  const first = mkdirSync(dirname(writeTarget(path)), { recursive: true, mode: 0o700 });
  if (first) {
    backupsDir();
    // a folder bot-link creates is 0700 whatever the umask (J3 v4 M1)
    for (let d = dirname(writeTarget(path)); d.length >= first.length; d = dirname(d)) {
      writeFileSync(dirMarker(d), "", { mode: 0o600 });
      chmodSync(d, 0o700);
    }
  }
  assertWritable(path);
  // an existing file keeps its exact mode (and inode, when hard-linked); a new one is 0600. The file must still be
  // exactly what the edit started from right before the rename (J3 v6 HIGH: a running app's write was lost).
  writeContent(path, next, { expect: held === undefined ? prevText : held ? held.buf : null, held: held ?? null, names: attemptNames.get(dirname(writeTarget(path))), appLock: appLockOf(path) });
  lastWrites.set(resolve(path), { before: prevText, after: next });
  noteLinks(path);
  // and after it: someone who wrote in that window wins; the caller plans again on top of their bytes
  let now: string | null = null;
  try {
    now = readFileSync(writeTarget(path), "utf-8");
  } catch {
    /* gone: someone removed it */
  }
  if (now !== next) throw new ConcurrentChange(path, true);
  return prevText === null ? "created" : "updated";
}

const RACE_TRIES = 5;

/** The lock an app takes while it saves this file, when bot-link knows it: Claude Code's `<~/.claude.json>.lock` (proper-lockfile). */
function appLockOf(path: string): string | undefined {
  return resolve(path) === resolve(claudeJsonPath()) ? `${claudeJsonPath()}.lock` : undefined;
}
/** The folder listing taken when the current attempt read its file (filesafe ifStill compares it right before the rename). */
const attemptNames = new Map<string, string[] | null>();

/**
 * Run one file edit (it reads the file, plans, writes through writeIfChanged) until it goes in without anyone
 * writing the file at the same time: a write that raced a running app is planned again from the app's new bytes
 * (never written over them), up to RACE_TRIES times with a short jittered pause. -> the edit's Change.
 */
function raceSafe(path: string, edit: () => Change): Change {
  let landed: Change["action"] | null = null;
  try {
    for (let attempt = 1; ; attempt++) {
      const saved = JSON.stringify(spanInfo(path));
      const dir = dirname(writeTarget(path));
      attemptNames.set(dir, dirNames(dir));
      beginAttempt();
      try {
        let c = edit();
        if (hasOverride(path) && c.action === "unchanged") {
          // their bytes (from the copy bot-link replaced) already hold what bot-link wants: they go back in place
          const theirs = readForEdit(path).plan!.toString("utf-8");
          c = { ...c, action: writeIfChanged(path, theirs, theirs) };
        }
        clearOverride(path);
        return landed && c.action === "unchanged" ? { ...c, action: landed } : c;
      } catch (e) {
        if (e instanceof OrphanWrite) {
          // an app wrote the file in place while bot-link renamed its own over it: bot-link's write is in, theirs is
          // in the inode it replaced. Plan again on top of THEIR bytes and write that over bot-link's own file
          setOverride(path, e.theirs, e.ours);
          landed ??= "updated";
          if (attempt >= RACE_TRIES) throw new Error(rescueOrphan(path));
          continue;
        }
        if (!(e instanceof ConcurrentChange)) {
          // an app's save from the inode bot-link replaced is still only in hand: it goes back in place (or is kept
          // and named), never dropped with the error (J3 v7 race matrix: it was dropped on a FileBusy re-plan)
          if (hasOverride(path)) (e as Error).message += ` ${rescueOrphan(path)}`;
          // bot-link's write of an earlier try went in and that program wrote after it: not "nothing was changed"
          else if (landed && e instanceof FileBusy) e.message = e.message.replace(" Nothing was changed.", " bot-link's write a moment before went in, and that program wrote the file after it: what it holds now is that program's save.");
          throw e;
        }
        if (e.landed) landed ??= existsSync(writeTarget(path)) ? "updated" : "created";
        else {
          const was = JSON.parse(saved) as SpanInfo;
          updateSpanInfo(path, (s) => {
            for (const k of Object.keys(s)) delete (s as any)[k];
            Object.assign(s, was);
          });
        }
        if (attempt >= RACE_TRIES) {
          if (hasOverride(path)) throw new Error(rescueOrphan(path));
          throw new Error(landed
            ? `${path} kept changing while bot-link tried to update it (is the app running?). bot-link's last write went in, but the app wrote after it, so its entry may be missing. Run setup again in a moment.`
            : `${path} kept changing while bot-link tried to update it (is the app running?). Nothing was changed. Run setup again in a moment.`);
        }
        sleepMs(10 * attempt + Math.floor(Math.random() * 25));
      } finally {
        endAttempt();
      }
    }
  } finally {
    clearOverride(path);
  }
}

/**
 * Giving up while an app's write sits in the inode bot-link replaced (their bytes, setOverride): put THEIR bytes back
 * in place over bot-link's own write (so the file is exactly what the app saved), else save them where the user can
 * find them. -> the message (always a failure: the command exits non-zero).
 */
function rescueOrphan(path: string): string {
  const target = resolveTarget(path);
  const ov = overrideOf(path);
  clearOverride(path);
  if (!ov) return `${path} kept changing while bot-link saved it (is the app running?). Run the command again in a moment.`;
  const parses = (() => {
    const t = ov.theirs.toString("utf-8");
    if (!ov.theirs.length) return !ov.ours.length;
    try {
      if (/\.toml$/.test(target)) parseToml(t);
      else if (t.trim() && parseJsonc(t).error) return false;
      return true;
    } catch {
      return false;
    }
  })();
  const dir = dirname(writeTarget(path));
  attemptNames.set(dir, dirNames(dir));
  beginAttempt();
  try {
    const { held } = parses ? readForEdit(path) : { held: null };
    if (held && held.buf.equals(ov.ours)) {
      writeContent(path, ov.theirs, { expect: held.buf, held, names: attemptNames.get(dir), appLock: appLockOf(path) });
      if (readFileSync(target).equals(ov.theirs)) return `${path} kept being written in place by another program while bot-link saved it, so bot-link put back exactly what that program wrote (without bot-link's change). Run the command again in a moment.`;
    }
  } catch {
    /* below */
  } finally {
    endAttempt();
  }
  const saved = join(backupsDir("lost"), `${encodeURIComponent(target)}.${new Date().toISOString().replace(/[:.]/g, "-")}`);
  writePrivate(saved, ov.theirs);
  return `${path} kept being written in place by another program while bot-link saved it. That program's last save landed in the copy bot-link replaced; it is saved in ${saved}. Compare it with ${path} and copy back anything missing, then run the command again.`;
}

/**
 * After a command that otherwise went through: files where another program saved at the very instant bot-link wrote
 * (filesafe `collided`). -> the note that makes the run a failure, or null.
 */
function collisionNote(paths: string[]): string | null {
  const hit = paths.filter((p) => collided.has(resolve(p)));
  if (!hit.length) return null;
  return `${hit.join(", ")}: another program saved ${hit.length === 1 ? "it" : "them"} at the very instant bot-link did. bot-link put that program's save back in place (it was out of place for well under a millisecond) and made its own change on top, so nothing of that program's is lost from the file. But if that program read the file in that instant, it saw an older copy and may save that again: check ${hit.length === 1 ? "the file" : "the files"}, then run the command again to confirm.`;
}

/** The last write bot-link made to each file in this run: what it planned from and what it wrote (M1 rollback). */
const lastWrites = new Map<string, { before: string | null; after: string }>();

/**
 * Undo one write of this setup (M1): only if the file still holds exactly what bot-link wrote, through the same checked
 * write path (stable read, compare, inode, names, app lock, the replaced inode watched). A file bot-link created is
 * deleted again. The ledger and span record go back to how they were. -> undone?
 */
function rollback(path: string, pre: { span: string; snap: boolean }): boolean {
  const w = lastWrites.get(resolve(path));
  if (!w) return false;
  const dir = dirname(writeTarget(path));
  for (let attempt = 1; attempt <= RACE_TRIES; attempt++) {
    attemptNames.set(dir, dirNames(dir));
    beginAttempt();
    try {
      const { held } = readForEdit(path);
      if (!held || held.buf.toString("utf-8") !== w.after) return false; // changed since bot-link wrote it: not undone
      if (w.before === null) {
        if (!unlinkIfStill(path, held)) throw new ConcurrentChange(path, false);
        removeCreatedDirs(writeTarget(path));
      } else {
        writeContent(path, w.before, { expect: held.buf, held, names: attemptNames.get(dir), appLock: appLockOf(path) });
        if (readFileSync(writeTarget(path), "utf-8") !== w.before) return false;
      }
      const was = JSON.parse(pre.span) as SpanInfo;
      updateSpanInfo(path, (s) => {
        for (const k of Object.keys(s)) delete (s as any)[k];
        Object.assign(s, was);
      });
      if (!pre.snap) dropSnapshot(path);
      lastWrites.delete(resolve(path));
      return true;
    } catch (e) {
      if (!(e instanceof ConcurrentChange) || e.landed) return false;
      sleepMs(10 * attempt + Math.floor(Math.random() * 25)); // nothing written: try again
    } finally {
      endAttempt();
    }
  }
  return false;
}

function sleepMs(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Other names of inode `ino`: under the home folder, else one level up (a dotfiles checkout beside the home folder,
 * as in the J3 v6 fixture), each a bounded walk.
 */
function linkNames(ino: number, dev: number, self: string): string[] {
  const inHome = otherLinks(home(), ino, dev, self);
  if (inHome.length) return inHome;
  const up = dirname(resolve(home()));
  return up === resolve(home()) ? [] : otherLinks(up, ino, dev, self, 40_000, resolve(home()));
}

function sameInode(p: string, ino: number, dev: number): boolean {
  try {
    const st = statSync(p);
    return st.ino === ino && st.dev === dev;
  } catch {
    return false;
  }
}

/** After a write: the file's inode and link count, and (hard-linked) its other names, so uninstall can tell a broken link (H3). */
function noteLinks(path: string) {
  try {
    const t = writeTarget(path);
    const st = statSync(t);
    const prev = spanInfo(path).links;
    const others = st.nlink > 1 ? (prev && prev.ino === st.ino && prev.others.length ? prev.others : linkNames(st.ino, st.dev, t)) : [];
    updateSpanInfo(path, (s) => {
      s.links = { ino: st.ino, dev: st.dev, nlink: st.nlink, others };
    });
  } catch {
    /* best effort */
  }
}

/** Merge what this edit adds into the span record (created containers, inner layouts, flags). */
function mergeSpan(a: SpanInfo, b: SpanInfo): SpanInfo {
  return {
    ...a,
    ...(b.created?.length ? { created: [...new Set([...(a.created || []), ...b.created])] } : {}),
    ...(b.inner && Object.keys(b.inner).length ? { inner: { ...b.inner, ...(a.inner || {}) } } : {}),
    ...(b.tomlNoFinalNl ? { tomlNoFinalNl: true } : {}),
    ...(b.emptyFile !== undefined && a.emptyFile === undefined ? { emptyFile: b.emptyFile } : {}),
    ...(b.perms?.length ? { perms: [...new Set([...(a.perms || []), ...b.perms])] } : {}),
  };
}

function recordSpan(path: string, add: SpanInfo) {
  if (DRY) return;
  if (!add.created?.length && !(add.inner && Object.keys(add.inner).length) && !add.tomlNoFinalNl && add.emptyFile === undefined && !add.perms?.length) return;
  updateSpanInfo(path, (s) => Object.assign(s, mergeSpan(s, add)));
}

type FileKind = { json: JsonKind } | { toml: true };

/** The text with bot-link's span cut out (span.ts), for the "only our span changed" checks. */
function stripAny(fk: FileKind, text: string, rec: SpanInfo): string {
  if ("toml" in fk) return stripToml(text, cloudNamesIn(tomlEntries(text)), rec);
  const r = stripJson(text, fk.json, rec).text;
  return SKELETONS.has(r) && rec.emptyFile !== undefined ? rec.emptyFile : r;
}

/**
 * Setup's self-check: the new text minus bot-link's span must be byte-for-byte the old text minus bot-link's span
 * (a new file: an empty skeleton). Otherwise nothing is written and the entry to paste is printed.
 */
function checkEdit(path: string, fk: FileKind, before: string | null, after: string, rec: SpanInfo) {
  let ok = false;
  try {
    const sa = stripAny(fk, after, rec);
    ok = before === null ? SKELETONS.has(sa) : sa === stripAny(fk, before, rec);
  } catch {
    ok = false;
  }
  if (!ok) throw new ReadOnlyConfig(`${path}: bot-link's edit would have changed more than its own entries, so it wasn't made; nothing was changed.`);
}

/** The new file text: a minimal edit of the old text (only our lines change), or a fresh file. */
function serialize(prevText: string | null, before: any, after: any): string {
  if (prevText === null || !prevText.trim()) return dumpJson(after, prevText);
  return applyJsonChange(prevText, before, after);
}

function dumpJson(obj: any, prevText: string | null): string {
  const indent = prevText ? detectIndent(prevText) : 2;
  const trailing = prevText === null || prevText.endsWith("\n") ? "\n" : "";
  return JSON.stringify(obj, null, indent) + trailing;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Add or update bot-link's cloud entry in a JSON config's servers object; only that entry (and a container it needs) changes. */
function mergeMcpJson(path: string, key: string, entry: any): Change {
  return raceSafe(path, () => mergeMcpJsonOnce(path, key, entry));
}

function mergeMcpJsonOnce(path: string, key: string, entry: any): Change {
  const { obj: o0, text } = readJsonFile(path);
  if (!isPlainObj(o0)) throw new Error(`${path}: expected a JSON object; nothing was changed.`);
  if (o0[key] !== undefined && !isPlainObj(o0[key])) throw new Error(`${path}: "${key}" is not an object, so bot-link won't edit it; nothing was changed.`);
  const k = mcpKind(key);
  const rec = spanInfo(path);
  // a second copy of our entry (botlink AND botlink-cloud) goes; the first one stays where it is
  const t1 = text === null ? null : stripJson(text, k, rec, (_d, items) => new Set(items.length ? [0] : [])).text;
  const obj = t1 === null ? {} : parseJsonStrict(t1);
  const before = structuredClone(obj);
  const servers = isPlainObj(obj[key]) ? obj[key] : undefined;
  const name = cloudNamesIn(servers)[0] ?? pickName(servers);
  const merged = mergeOwned(servers?.[name], entry);
  const add: SpanInfo = { created: [], inner: {} };
  if (text !== null && !text.trim()) add.emptyFile = text;
  if (!servers) {
    if (t1 && t1.trim() && !Object.keys(obj).length) add.inner![J([])] = innerOf(t1, []);
    obj[key] = {};
    add.created!.push(J([key]));
  } else if (!Object.keys(servers).length && t1 && t1.trim()) add.inner![J([key])] = innerOf(t1, [key]);
  obj[key][name] = merged;
  const next = sameJson(before, obj) ? (t1 as string) : serialize(t1, before, obj);
  if (next === text) return { file: path, action: "unchanged", detail: `${key}.${name} already current` };
  const recNew = mergeSpan(rec, add);
  checkEdit(path, { json: k }, text, next, recNew);
  recordSpan(path, add);
  return { file: path, action: writeIfChanged(path, next, text), detail: `${key}.${name}` };
}

/** The keys of a server entry bot-link owns. Everything else in its entry (tools, enabled, disabled, timeouts, ...) is the user's. */
const OWNED_KEYS = new Set(["type", "command", "args", "env", "environment"]);
/** The env keys bot-link writes into its entry (serverEnv); a user's other env keys stay. */
const OWNED_ENV = new Set(["BOTLINK_HOME", "BOTLINK_SERVER"]);

function mergeEnv(cur: unknown, want: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (cur && typeof cur === "object" && !Array.isArray(cur)) for (const [k, v] of Object.entries(cur)) if (!OWNED_ENV.has(k)) out[k] = v;
  return { ...out, ...want };
}

/**
 * bot-link's fresh entry merged into the one that is there: only the owned keys are set (an env merged key by
 * key); every other key the user put in our entry is kept, in its place. A brand-new entry is the fresh one.
 */
function mergeOwned(cur: any, fresh: Record<string, any>): any {
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) return fresh;
  const out: Record<string, any> = { ...cur };
  for (const [k, v] of Object.entries(fresh)) {
    if (!OWNED_KEYS.has(k)) continue; // e.g. Copilot's tools: ["*"], OpenCode's enabled: true are only defaults for a new entry
    out[k] = k === "env" || k === "environment" ? mergeEnv(cur[k], v) : v;
  }
  return out;
}

type HookSpec = { event: string; group: any };
type HookWant = { event: string; fresh: any; group: any };

const nestedWants = (specs: HookSpec[]): HookWant[] => specs.map((s) => ({ event: s.event, fresh: s.group.hooks[0], group: s.group }));
const flatWants = (specs: { event: string; entry: any }[]): HookWant[] => specs.map((s) => ({ event: s.event, fresh: s.entry, group: s.entry }));

/**
 * bot-link's hook object merged into the one that is there, key by key (J3 v4 H5, like mergeOwned): bot-link sets
 * only command, type and the flags it needs (asyncRewake); a user's timeout, statusMessage and any other key stay.
 * A timeout is only filled in when there is none.
 */
function mergeHookObj(cur: any, fresh: Record<string, any>): any {
  if (!isPlainObj(cur)) return fresh;
  const out: Record<string, any> = { ...cur };
  if (fresh.type !== undefined) out.type = fresh.type;
  out.command = fresh.command;
  if (fresh.asyncRewake) out.asyncRewake = true;
  if (out.timeout === undefined && fresh.timeout !== undefined) out.timeout = fresh.timeout;
  return out;
}

/**
 * Add or update bot-link's hooks (Claude Code / Codex nested groups, or Cursor's flat list). One hook of ours per
 * event and role is kept and updated in place (its group's matcher and the user's keys stay); dead or duplicate
 * hooks of ours are cut out; missing ones are appended. Nothing outside bot-link's span changes (checkEdit).
 */
function mergeHooks(path: string, h: HarnessKey, flat: boolean, wants: HookWant[]): Change {
  return raceSafe(path, () => mergeHooksOnce(path, h, flat, wants));
}

function mergeHooksOnce(path: string, h: HarnessKey, flat: boolean, wants: HookWant[]): Change {
  const { obj: o0, text } = readJsonFile(path);
  recordHookCommands(h, wants.map((w) => w.fresh.command));
  if (!isPlainObj(o0)) throw new Error(`${path}: expected a JSON object; nothing was changed.`);
  if (o0.hooks !== undefined && !isPlainObj(o0.hooks)) throw new Error(`${path}: "hooks" is not an object, so bot-link won't edit it; nothing was changed.`);
  const k = hookKind(h, flat);
  const rec = spanInfo(path);
  const wanted = (ev: string | undefined, role: string | undefined) => wants.some((w) => w.event === ev && roleOf(w.fresh.command) === role);
  const claim = (_doc: any, items: SpanItem[]) => {
    const taken = new Set<string>();
    const keep = new Set<number>();
    items.forEach((it, i) => {
      const key = `${it.ev}\u0000${it.role}`;
      if (!taken.has(key) && wanted(it.ev, it.role)) {
        taken.add(key);
        keep.add(i);
      }
    });
    return keep;
  };
  const t1 = text === null ? null : stripJson(text, k, rec, claim).text;
  const doc = t1 === null ? {} : parseJsonStrict(t1);
  const out = structuredClone(doc);
  const items = spanItems(doc, k);
  const add: SpanInfo = { created: [], inner: {} };
  if (text !== null && !text.trim()) add.emptyFile = text;
  for (const w of wants) {
    const it = items.find((x) => x.ev === w.event && x.role === roleOf(w.fresh.command));
    if (it) {
      setAt(out, it.at!, mergeHookObj(getAt(out, it.at!), w.fresh));
      continue;
    }
    if (!isPlainObj(out.hooks)) {
      out.hooks = {};
      add.created!.push(J(["hooks"]));
    }
    if (out.hooks[w.event] === undefined) {
      out.hooks[w.event] = [];
      add.created!.push(J(["hooks", w.event]));
    } else if (!Array.isArray(out.hooks[w.event])) throw new Error(`${path}: "hooks.${w.event}" is not a list, so bot-link won't edit it; nothing was changed.`);
    out.hooks[w.event].push(structuredClone(w.group));
  }
  if (flat && out.version === undefined) {
    out.version = 1;
    add.created!.push(J(["version"]));
  }
  // a container that was there but empty: how it looked inside, so removing our last item gives exactly that back
  if (t1 && t1.trim()) {
    for (const p of [[], ["hooks"], ...wants.map((w) => ["hooks", w.event])]) {
      const v0 = getAt(doc, p);
      const v1 = getAt(out, p);
      const empty = (v: any) => (Array.isArray(v) ? !v.length : isPlainObj(v) && !Object.keys(v).length);
      if (v0 !== undefined && empty(v0) && !empty(v1)) add.inner![J(p)] = innerOf(t1, p);
    }
  }
  const next = sameJson(doc, out) ? (t1 as string) : serialize(t1, doc, out);
  const events = [...new Set(wants.map((w) => w.event))].join(", ");
  if (next === text) return { file: path, action: "unchanged", detail: "hooks already current" };
  checkEdit(path, { json: k }, text, next, mergeSpan(rec, add));
  recordSpan(path, add);
  return { file: path, action: writeIfChanged(path, next, text), detail: `hooks: ${events}` };
}

/**
 * Cursor CLI: add `Mcp(<server>:<tool>)` rules (cursorPermRules) to `permissions.allow` in cli-config.json, so headless
 * runs (`cursor-agent -p`, watch's resume) may call bot-link's tools (without them every call is "User rejected MCP").
 * A rule already there (the user's own) is left alone and never becomes bot-link's, so uninstall keeps it; rules
 * bot-link added for its other server name go. Nothing outside bot-link's span changes (checkEdit).
 */
function mergeCursorPerm(path: string, server: string): Change {
  const rules = cursorPermRules(server);
  return raceSafe(path, () => mergeListOnce(path, ["permissions", "allow"], rules, (adding) => permKind(path, adding), (doc) => {
    const denied = isPlainObj(doc.permissions) && Array.isArray(doc.permissions.deny) && doc.permissions.deny.some((r: unknown) => rules.includes(r as string) || r === "Mcp(*:*)" || r === `Mcp(${server}:*)`);
    return { what: `permissions.allow Mcp(${server}:${UNATTENDED_TOOL_NAMES.join("|")})`, note: denied ? ` (but ${path} denies bot-link in permissions.deny: deny wins, so headless Cursor still can't use bot-link)` : "" };
  }));
}

/** Claude Code project scope: approve bot-link's .mcp.json server by name in .claude/settings.local.json. */
function mergeClaudeApprove(path: string, server: string): Change {
  return raceSafe(path, () => mergeListOnce(path, ["enabledMcpjsonServers"], [server], (adding) => approveKind(path, adding), (doc) => ({
    what: `enabledMcpjsonServers "${server}"`,
    note: Array.isArray(doc.disabledMcpjsonServers) && doc.disabledMcpjsonServers.includes(server) ? ` (but ${path} lists it in disabledMcpjsonServers, which wins)` : "",
  })));
}

/** Add bot-link's strings to the list at `at` (creating the containers it needs), recorded as bot-link's (ledger perms). */
function mergeListOnce(path: string, at: string[], rules: string[], kindOf: (adding: string[]) => JsonKind, describe: (doc: any) => { what: string; note: string }): Change {
  const { obj: o0, text } = readJsonFile(path);
  if (!isPlainObj(o0)) throw new Error(`${path}: expected a JSON object; nothing was changed.`);
  for (let i = 1; i < at.length; i++) {
    const v = getAt(o0, at.slice(0, i));
    if (v !== undefined && !isPlainObj(v)) throw new Error(`${path}: "${at.slice(0, i).join(".")}" is not an object, so bot-link won't edit it; nothing was changed.`);
  }
  const l0 = getAt(o0, at);
  if (l0 !== undefined && !Array.isArray(l0)) throw new Error(`${path}: "${at.join(".")}" is not a list, so bot-link won't edit it; nothing was changed.`);
  const rec = spanInfo(path);
  // ours for another server name (or a second copy of ours) goes; the first copy of each wanted rule stays
  const firstOfEach = (_d: any, items: SpanItem[]) => new Set(rules.map((r) => items.findIndex((x) => x.ev === r)).filter((i) => i >= 0));
  const t1 = text === null ? null : stripJson(text, kindOf([]), rec, firstOfEach).text; // never the user's own entries
  const doc = t1 === null ? {} : parseJsonStrict(t1);
  const out = structuredClone(doc);
  const add: SpanInfo = { created: [], inner: {} };
  if (text !== null && !text.trim()) add.emptyFile = text;
  const list0 = getAt(doc, at);
  const missing = rules.filter((r) => !(Array.isArray(list0) && list0.includes(r)));
  const k = kindOf(missing);
  if (missing.length) {
    for (let i = 1; i <= at.length; i++) {
      const p = at.slice(0, i);
      if (getAt(out, p) === undefined) {
        setAt(out, p, i === at.length ? [] : {});
        add.created!.push(J(p));
      }
    }
    (getAt(out, at) as string[]).push(...missing);
    add.perms = missing;
    if (t1 && t1.trim()) {
      for (let i = 0; i <= at.length; i++) {
        const p = at.slice(0, i);
        const v0 = getAt(doc, p);
        const empty = (v: any) => (Array.isArray(v) ? !v.length : isPlainObj(v) && !Object.keys(v).length);
        if (v0 !== undefined && empty(v0)) add.inner![J(p)] = innerOf(t1, p);
      }
    }
  }
  const next = sameJson(doc, out) ? (t1 as string) : serialize(t1, doc, out);
  const { what, note } = describe(doc);
  if (next === text) return { file: path, action: "unchanged", detail: `${what} already there${note}` };
  checkEdit(path, { json: k }, text, next, mergeSpan(rec, add));
  recordSpan(path, add);
  return { file: path, action: writeIfChanged(path, next, text), detail: `${what}${note}` };
}

// ---------------------------------------------------------------- TOML (Codex fallback when its CLI is absent)
/**
 * FINDINGS F1: without an approval mode Codex asks before every MCP tool call, and a non-interactive run
 * (`codex exec resume`, i.e. every watch wake; approval_policy "never") refuses them all. bot-link's own entry
 * therefore approves bot-link's own tools (official config reference: mcp_servers.<id>.default_tools_approval_mode,
 * auto | prompt | writes | approve; verified in codex-cli 0.162.1). The safety rules live in the fence text, not in
 * Codex approvals. Owned by bot-link like command/args/env; uninstall removes it with the table.
 */
export const CODEX_TOOLS_APPROVAL = "approve";
/**
 * The tools that always need the human (join a room, move a member to this chat, leave, save a standing rule) are
 * NOT approved: Codex asks its human before each call (mcp_servers.<id>.tools.<tool>.approval_mode = "prompt"), and a
 * non-interactive run (a woken chat) can't call them at all. bot-link's own tools refuse them in such a run too.
 */
export const CODEX_HUMAN_TOOLS = ["join", "claim", "leave", "save_rule"];
/** The `tools` value of bot-link's Codex entry: the user's own per-tool settings stay, the four above are set to ask. */
export function codexTools(cur?: unknown): Record<string, any> {
  const base = cur && typeof cur === "object" && !Array.isArray(cur) ? { ...(cur as Record<string, any>) } : {};
  for (const t of CODEX_HUMAN_TOOLS) base[t] = { ...(base[t] && typeof base[t] === "object" ? base[t] : {}), approval_mode: "prompt" };
  return base;
}
const codexToolsLine = () => `tools = { ${CODEX_HUMAN_TOOLS.map((t) => `${t} = { approval_mode = "prompt" }`).join(", ")} }`;
/** Do the human-only tools ask in this entry? */
export function codexHumanToolsAsk(entry: any): boolean {
  return CODEX_HUMAN_TOOLS.every((t) => entry?.tools?.[t]?.approval_mode === "prompt");
}
const tomlStr = (s: string) => JSON.stringify(s); // TOML basic strings use the JSON escapes we emit

/** Our [mcp_servers.<server>] entry, read with a real TOML parser (span scanner + regex only for a file that isn't valid TOML). */
function tomlEntries(text: string): Record<string, { command?: string; args?: string[]; enabled?: boolean; disabled?: boolean }> {
  const out: Record<string, { command?: string; args?: string[]; enabled?: boolean; disabled?: boolean }> = {};
  try {
    const doc = parseToml(text);
    for (const n of NAMES) {
      const e = doc.mcp_servers?.[n];
      if (e && typeof e === "object") out[n] = { command: typeof e.command === "string" ? e.command : undefined, args: Array.isArray(e.args) ? e.args : undefined, ...(e.enabled === false ? { enabled: false } : {}), ...(e.disabled === true ? { disabled: true } : {}) };
    }
    return out;
  } catch {
    /* not valid TOML: Codex can't read it either; report what the header scan finds, and never edit it */
  }
  for (const n of NAMES) {
    const r = tomlTableRanges(text, ["mcp_servers", n])[0];
    if (!r) continue;
    const block = text.split("\n").slice(r[0], r[1]).join("\n");
    const cmd = block.match(/^\s*command\s*=\s*("(?:[^"\\]|\\.)*")/m);
    const args = block.match(/^\s*args\s*=\s*(\[[^\]]*\])/m);
    try {
      out[n] = { command: cmd ? JSON.parse(cmd[1]) : undefined, args: args ? JSON.parse(args[1]) : undefined };
    } catch {
      out[n] = {};
    }
  }
  return out;
}

/** The [mcp_servers.*] entries (botlink, botlink-cloud) in a Codex config.toml. */
function codexServers(path: string): Record<string, { command?: string; args?: string[] }> {
  const t = readText(path);
  return t === null ? {} : tomlEntries(t);
}

/** J3b: does the user's own key in bot-link's entry turn it off (`enabled = false`, `"disabled": true`)? -> that key, or null. */
export function disabledBy(entry: unknown, toml = false): string | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (e.enabled === false) return toml ? "enabled = false" : `"enabled": false`;
  if (e.disabled === true) return toml ? "disabled = true" : `"disabled": true`;
  return null;
}

function codexTomlEntry(path: string): { name: string; command?: string; args?: string[] } | null {
  const sv = codexServers(path);
  const n = cloudNamesIn(sv)[0];
  return n ? { name: n, ...sv[n] } : null;
}

const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

/** A value bot-link writes into its own table (strings, string arrays, inline tables of those). null: can't. */
function tomlValue(v: unknown): string | null {
  if (typeof v === "string") return tomlStr(v);
  if (typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(tomlValue);
    return parts.every((x) => x !== null) ? `[${parts.join(", ")}]` : null;
  }
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const parts = Object.entries(v).map(([k, x]) => [k, tomlValue(x)] as const);
    if (parts.some(([, x]) => x === null)) return null;
    return parts.length ? `{ ${parts.map(([k, x]) => `${tomlKey(k)} = ${x}`).join(", ")} }` : "{}";
  }
  return null;
}

/**
 * Set bot-link's owned keys (command, args, env) inside its existing [mcp_servers.<name>] table, in place: every
 * other line of the table (a user's startup_timeout_sec, enabled, tools, comments) and the table's position stay.
 * A key whose value is already right is not touched at all. -> the new text, or why it can't be done safely.
 */
const OWNED_TOML_KEYS = ["command", "args", "env", "default_tools_approval_mode", "tools"];

function editTomlTable(text: string, name: string, cur: Record<string, any>, desired: Record<string, any>): { text: string } | { why: string } {
  const lines = text.split("\n");
  const hs = tomlHeaders(text);
  const k = hs.findIndex((x) => !x.array && x.path && x.path.length === 2 && x.path[0] === "mcp_servers" && x.path[1] === name);
  if (k < 0) return { why: `[mcp_servers.${name}] isn't a plain table (a dotted key or an inline table?)` };
  const hdr = hs[k].line;
  const secEnd = k + 1 < hs.length ? hs[k + 1].line : lines.length;
  const eol = lines[hdr].endsWith("\r") ? "\r" : "";
  const edits: { at: number; del: number; lines: string[] }[] = [];
  const inserts: string[] = [];
  let lastOwned = hdr;
  const keyLine = (key: string) => {
    for (let i = hdr + 1; i < secEnd; i++) if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) return i;
    return -1;
  };
  for (const key of OWNED_TOML_KEYS) {
    const at = keyLine(key);
    if (at >= 0) lastOwned = Math.max(lastOwned, statementEnd(lines, at).end);
  }
  for (const key of OWNED_TOML_KEYS) {
    const want = desired[key];
    const have = cur[key];
    if (JSON.stringify(canonToml(want)) === JSON.stringify(canonToml(have))) continue;
    const at = keyLine(key);
    const val = want === undefined ? null : tomlValue(want);
    if (want !== undefined && val === null) return { why: `bot-link can't write ${key} of [mcp_servers.${name}] as TOML` };
    if (at < 0) {
      if (have !== undefined) return { why: `${key} of [mcp_servers.${name}] is written in a form bot-link doesn't edit (a sub-table or dotted keys)` };
      inserts.push(`${key} = ${val}${eol}`);
      continue;
    }
    const { end, comment } = statementEnd(lines, at);
    const indent = (lines[at].match(/^\s*/) || [""])[0];
    const lineEol = lines[end].endsWith("\r") ? "\r" : "";
    edits.push({ at, del: end - at + 1, lines: want === undefined ? [] : [`${indent}${key} = ${val}${comment && end === at ? ` ${comment.replace(/\r$/, "")}` : ""}${lineEol}`] });
  }
  // a missing key goes right after our last owned key (or the header); edits never overlap, so bottom-up splices are exact
  if (inserts.length) edits.push({ at: lastOwned + 1, del: 0, lines: inserts });
  const out = lines.slice();
  for (const e of edits.sort((a, b) => b.at - a.at)) out.splice(e.at, e.del, ...e.lines);
  return { text: out.join("\n") };
}

/**
 * bot-link's own minimal edit of a Codex config.toml (setup):
 *   - our table already there: only its owned keys are set in place (a user's keys and comments in it stay)
 *   - not there: the new table is appended, in the file's own line endings; the user's last line is never rewritten
 *     (no final newline: one is added after it, and the ledger remembers so uninstall takes it away again)
 * Then PROVE it: everything but our table must be byte-for-byte what it was (checkEdit), and a TOML parser must
 * read our table as exactly the entry we meant. Anything else is refused, with the lines to paste.
 */
function mergeCodexToml(path: string, argv: string[], env: Record<string, string>): Change {
  return raceSafe(path, () => mergeCodexTomlOnce(path, argv, env));
}

function mergeCodexTomlOnce(path: string, argv: string[], env: Record<string, string>): Change {
  const text = readText(path);
  const sv = text === null ? {} : tomlEntries(text); // from the same bytes the edit starts from
  const ours = cloudNamesIn(sv);
  const name = ours[0] ?? pickName(sv);
  const eol = text && text.includes("\r\n") ? "\r\n" : "\n";
  const block = [`[mcp_servers.${name}]`, `command = ${tomlStr(argv[0])}`, `args = [${argv.slice(1).map(tomlStr).join(", ")}]`];
  if (Object.keys(env).length) block.push(`env = { ${Object.entries(env).map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v)}`).join(", ")} }`);
  block.push(`default_tools_approval_mode = ${tomlStr(CODEX_TOOLS_APPROVAL)}`);
  block.push(codexToolsLine());
  const refuse = (why: string): never => {
    const e = new ReadOnlyConfig(`${path}: ${why}. Nothing was changed.`);
    throw e;
  };
  const rec = spanInfo(path);
  const add: SpanInfo = {};
  let body: string;
  let want: { name: string; entry: Record<string, any> };
  if (ours.length) {
    const doc = parseToml(text ?? "");
    const cur = doc.mcp_servers[name] as Record<string, any>;
    const desired: Record<string, any> = { ...cur, command: argv[0], args: argv.slice(1), default_tools_approval_mode: CODEX_TOOLS_APPROVAL, tools: codexTools(cur.tools) };
    const e = mergeEnv(cur.env, env);
    if (Object.keys(e).length || cur.env !== undefined) desired.env = e;
    else delete desired.env;
    want = { name, entry: desired };
    const others = ours.filter((n) => n !== name);
    if (!others.length && JSON.stringify(canonToml(desired)) === JSON.stringify(canonToml(cur))) {
      return { file: path, action: "unchanged", detail: `[mcp_servers.${name}] already current` };
    }
    let base = text ?? "";
    if (others.length) {
      try {
        base = stripToml(base, others, {}); // a second copy of our table goes
      } catch (x) {
        refuse((x as Error).message);
      }
    }
    let r = editTomlTable(base, name, parseToml(base).mcp_servers[name], desired);
    // the user wrote per-tool settings as sub-tables ([mcp_servers.x.tools.y]): bot-link edits no sub-table, so their
    // tools stay exactly as written (doctor says when the human-only tools don't ask)
    if ("why" in r && /^tools of /.test(r.why)) {
      desired.tools = cur.tools;
      r = editTomlTable(base, name, parseToml(base).mcp_servers[name], desired);
    }
    if ("why" in r) refuse(r.why);
    body = (r as { text: string }).text;
  } else {
    const t = text ?? "";
    const tbl = block.join(eol) + eol;
    body = t === "" ? tbl : t.endsWith("\n") ? t + eol + tbl : t + eol + eol + tbl;
    if (t !== "" && !t.endsWith("\n")) add.tomlNoFinalNl = true;
    want = { name, entry: { command: argv[0], args: argv.slice(1), ...(Object.keys(env).length ? { env } : {}), default_tools_approval_mode: CODEX_TOOLS_APPROVAL, tools: codexTools() } };
  }
  const why = verifyTomlEdit(text, body, ours, want);
  if (why) refuse(why);
  checkEdit(path, { toml: true }, text, body, mergeSpan(rec, add));
  recordSpan(path, add);
  const act = writeIfChanged(path, body, text);
  return { file: path, action: act, detail: `[mcp_servers.${name}]` };
}

// ---------------------------------------------------------------- per harness
/** SPEC §7.2: the hook table. No PreToolUse taint gate in v1. */
function claudeHookSpecs(): HookSpec[] {
  const c = (ev: string, extra: Record<string, unknown> = {}) => ({ type: "command", command: hookCommand("claude-code", ev), ...extra });
  return [
    { event: "SessionStart", group: { hooks: [c("session-start", { timeout: 30 })] } },
    { event: "UserPromptSubmit", group: { hooks: [c("prompt", { timeout: 25 })] } },
    { event: "Stop", group: { hooks: [c("stop", { asyncRewake: true, timeout: 3600 })] } },
  ];
}

function codexHookSpecs(): HookSpec[] {
  const c = (ev: string) => ({ type: "command", command: hookCommand("codex", ev), timeout: 30 });
  return [
    { event: "SessionStart", group: { hooks: [c("session-start")] } },
    { event: "UserPromptSubmit", group: { hooks: [c("prompt")] } },
    { event: "Stop", group: { hooks: [c("stop")] } },
  ];
}

/** The distinct hook events bot-link installs, from the specs themselves (doctor, up and setup all count these). */
const eventsOf = (specs: HookSpec[]) => [...new Set(specs.map((x) => x.event))];
export const codexHookEvents = () => eventsOf(codexHookSpecs());
export const claudeHookEvents = () => eventsOf(claudeHookSpecs());
export const cursorHookEvents = () => [...new Set(cursorHookSpecs().map((x) => x.event))];

function cursorHookSpecs() {
  const c = (ev: string) => ({ command: hookCommand("cursor", ev), timeout: 15 });
  return [
    { event: "sessionStart", entry: c("session-start") },
    { event: "stop", entry: c("stop") },
  ];
}

function claudeMcpEntry(): any {
  const argv = serveArgv("claude-code");
  return { type: "stdio", command: argv[0], args: argv.slice(1), env: serverEnv() };
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  try {
    const o = execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 60000, ...(env ? { env } : {}) }).toString();
    return { ok: true, out: o };
  } catch (e: any) {
    return { ok: false, out: `${e?.stderr?.toString?.() || ""}${e?.message || ""}`.trim() };
  }
}

/** The line of a CLI's output that says what went wrong (not a leading "WARNING: ..." line, J3 L4). */
function errorLine(out: string): string {
  const lines = (out || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => !/^warn(ing)?\b/i.test(l)) || lines[0] || "no output";
}

/**
 * Ask the app's own CLI whether it reads bot-link's entry (`claude mcp get botlink`, `codex mcp get botlink`).
 * Those CLIs migrate or rewrite their config files, create folders (~/.claude/backups) and may start the MCP
 * server on ANY run, so the CLI never runs against the real home: it reads an exact copy of the files bot-link
 * wrote, in a throwaway HOME (CLAUDE_CONFIG_DIR / CODEX_HOME / BOTLINK_MCP_HOME pointed there too). The CLI can't
 * touch the real files, so if one of them changed meanwhile, someone else (the running app, typically) wrote it:
 * bot-link NEVER writes it back (J3 v4 H1), it only says so.
 */
function validateWithCli(cmd: string, args: string[], files: { real: string; rel: string }[], envDirs: Record<string, string>, rep: Report, h: HarnessKey) {
  const sandbox = mkdtempSync(join(tmpdir(), "botlink-validate-"));
  const before = files.map(({ real }) => {
    const t = writeTarget(real);
    return { f: real, t, bytes: existsSync(t) ? readFileSync(t) : null };
  });
  let g: { ok: boolean; out: string };
  try {
    for (const { real, rel } of files) {
      if (!existsSync(writeTarget(real))) continue;
      mkdirSync(dirname(join(sandbox, rel)), { recursive: true });
      copyFileSync(writeTarget(real), join(sandbox, rel));
    }
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, BOTLINK_MCP_HOME: join(sandbox, ".botlink-mcp") };
    for (const [k, rel] of Object.entries(envDirs)) env[k] = join(sandbox, rel);
    g = run(cmd, args, env);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  for (const b of before) {
    const now = existsSync(b.t) ? readFileSync(b.t) : null;
    if (b.bytes === null ? now === null : now !== null && now.equals(b.bytes)) continue;
    rep.notes.push(`${b.f} was changed by another program (the running app, most likely) while \`${cmd} ${args.join(" ")}\` checked a copy of it; bot-link left it exactly as that program wrote it. Run \`${selfCmd()} setup ${h}\` again to make sure bot-link's entry is still there.`);
  }
  return g;
}

export function setup(h: HarnessKey, opts: { configPath?: string } = {}): Report {
  const bad = ledgerProblem();
  if (bad && !PASTE_ONLY.has(h) && !(h === "mcp" && !opts.configPath)) return { harness: h, ok: false, changes: [], notes: [bad] };
  return withLock("config", () => setupLocked(h, opts));
}

function setupLocked(h: HarnessKey, opts: { configPath?: string }): Report {
  const rep: Report = { harness: h, ok: true, changes: [], notes: [] };
  collided.clear();
  // how each file's ledger entry and span record were before this setup, for an undo (M1)
  const files = filesOf(h, opts.configPath).map((f) => f.path);
  const pre = new Map(files.map((f) => [resolve(f), { span: JSON.stringify(spanInfo(f)), snap: !!snapshotOf(f) }]));
  lastWrites.clear();
  const jsonServers = (path: string, key = "mcpServers") => {
    const o = readJsonFile(path).obj;
    return o && typeof o[key] === "object" ? o[key] : undefined;
  };
  /** The note about someone else's "botlink" server, said only after checking it really is unchanged. */
  const foreignChecked = (path: string, key: string, before: string): string =>
    JSON.stringify(jsonServers(path, key)?.[SERVER_NAME] ?? null) === before
      ? foreignNote({ [SERVER_NAME]: JSON.parse(before) }, path)!
      : `${path}: the "${SERVER_NAME}" server that is not bot-link cloud changed during setup; compare it with ${latestPrev(path) ?? "the backups in ~/.botlink-mcp/backups"}.`;
  try {
    // every file this app needs is checked BEFORE any of them is written (J3-r3 F5)
    assertWirable(h, opts.configPath);
    if (h === "claude-code") {
      // always bot-link's own minimal merge, never `claude mcp add|remove`: the CLI migrates and rewrites the whole
      // ~/.claude.json and ~/.claude/settings.json (J3 final H3). The CLI, when present, only validates.
      const servers = jsonServers(claudeJsonPath());
      const foreignBefore = JSON.stringify(servers?.[SERVER_NAME] ?? null);
      const mc = mergeMcpJson(claudeJsonPath(), "mcpServers", claudeMcpEntry());
      rep.changes.push(mc);
      const name = cloudNamesIn(jsonServers(claudeJsonPath()))[0] || SERVER_NAME;
      if (foreignNote(servers, claudeJsonPath())) rep.notes.push(foreignChecked(claudeJsonPath(), "mcpServers", foreignBefore));
      const sp = claudeSettingsPath();
      const hc = mergeHooks(sp, h, false, nestedWants(claudeHookSpecs()));
      rep.changes.push(hc);
      // project scope: .mcp.json servers need an approval; bot-link's own name in the personal settings.local.json
      if (projectDir()) rep.changes.push(mergeClaudeApprove(sp, name));
      if ((mc.action !== "unchanged" || hc.action !== "unchanged") && onPath("claude") && !DRY && !projectDir()) {
        const cd: Record<string, string> = process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: "claude-config" } : {};
        const base = process.env.CLAUDE_CONFIG_DIR ? "claude-config" : "";
        const g = validateWithCli("claude", ["mcp", "get", name], [
          { real: claudeJsonPath(), rel: join(base, ".claude.json") },
          { real: sp, rel: join(base || ".claude", "settings.json") },
        ], cd, rep, h);
        if (!g.ok) rep.notes.push(`\`claude mcp get ${name}\` didn't confirm the new entry (${errorLine(g.out)}); check that Claude Code can read ${claudeJsonPath()}.`);
      }
      rep.notes.push(projectDir()
        ? `Restart Claude Code in ${projectDir()} (or run /mcp) to load bot-link. Claude Code applies a folder's settings.local.json once you trusted that folder (it asks the first time you open it).`
        : `Restart Claude Code (or run /mcp) to load bot-link.`);
    } else if (h === "codex") {
      const argv = serveArgv("codex");
      const cfg = join(codexHome(), "config.toml");
      const sv = codexServers(cfg);
      const foreign = foreignNote(sv, cfg);
      const foreignBefore = JSON.stringify(canonToml(sv[SERVER_NAME] ?? null));
      // always bot-link's own byte-minimal merge, never `codex mcp add`: that CLI drops comments, rewrites
      // numbers (20 -> 20.0) and changes the file mode (J3-r3 F2). The CLI, when present, only validates.
      const mc = mergeCodexToml(cfg, argv, serverEnv());
      rep.changes.push(mc);
      const name = cloudNamesIn(codexServers(cfg))[0] || pickName(sv);
      if (mc.action !== "unchanged" && onPath("codex") && !DRY && !projectDir()) {
        const g = validateWithCli("codex", ["mcp", "get", name], [{ real: cfg, rel: join(".codex", "config.toml") }], { CODEX_HOME: ".codex" }, rep, h);
        if (!g.ok) rep.notes.push(`\`codex mcp get ${name}\` didn't confirm the new entry (${errorLine(g.out)}). The file is valid TOML; check that Codex can read ${cfg}.`);
      }
      const off = disabledBy(codexTomlEntry(cfg), true);
      if (off) {
        rep.warn = true;
        rep.notes.push(`${cfg}: bot-link's entry [mcp_servers.${name}] has ${off} (kept: it is yours), so Codex won't load bot-link. Delete that line to turn it on.`);
      }
      if (foreign) rep.notes.push(JSON.stringify(canonToml(codexServers(cfg)[SERVER_NAME] ?? null)) === foreignBefore ? foreign : `${cfg}: the "${SERVER_NAME}" server that is not bot-link cloud changed during setup; compare it with ${latestPrev(cfg) ?? "the backups in ~/.botlink-mcp/backups"}.`);
      rep.changes.push(mergeHooks(join(codexHome(), "hooks.json"), h, false, nestedWants(codexHookSpecs())));
      if (projectDir()) {
        const trusted = codexProjectTrusted(projectDir()!);
        rep.notes.push(trusted
          ? `${projectDir()} is a trusted Codex project, so Codex loads ${codexHome()} there.`
          : `Codex loads a project's .codex/ only when you trust the project: open Codex in ${projectDir()} and trust it when it asks (bot-link does not edit your user config for this).`);
      }
      rep.notes.push(`Restart Codex to load bot-link. Then run /hooks in Codex and trust the ${codexHookEvents().length} bot-link hooks (${codexHookEvents().join(", ")}): Codex skips new hooks until you trust them, so until then messages show up only when the chat calls the bot-link inbox tool.`);
    } else if (h === "cursor") {
      const argv = serveArgv("cursor");
      const path = join(cursorDir(), "mcp.json");
      const before = jsonServers(path);
      const fb = JSON.stringify(before?.[SERVER_NAME] ?? null);
      rep.changes.push(mergeMcpJson(path, "mcpServers", { type: "stdio", command: argv[0], args: argv.slice(1), env: serverEnv() }));
      if (foreignNote(before, path)) rep.notes.push(foreignChecked(path, "mcpServers", fb));
      rep.changes.push(mergeHooks(join(cursorDir(), "hooks.json"), h, true, flatWants(cursorHookSpecs())));
      // headless Cursor (watch's `cursor-agent -p --resume`) rejects every MCP call that isn't permitted
      rep.changes.push(mergeCursorPerm(cursorCliConfigPath(), cloudNamesIn(jsonServers(path))[0] || SERVER_NAME));
      rep.notes.push("Reload Cursor (or toggle the server in Settings > MCP).");
    } else if (PASTE_ONLY.has(h)) {
      const path = musePath();
      const cur = existsSync(path) ? readJsonFile(path).obj : null;
      const n = cloudNamesIn(cur?.mcp_servers)[0];
      const v = n ? entryArgv(cur.mcp_servers[n]) : [];
      const argv = serveArgv(h);
      if (n && sameJson(v, argv)) rep.changes.push({ file: path, action: "unchanged", detail: `mcp_servers.${n} already current (you pasted it)` });
      else rep.notes.push(museNote(path));
    } else if (JSON_HARNESS[h]) {
      const j = JSON_HARNESS[h]!;
      const path = j.path();
      const before = jsonServers(path, j.key);
      const fb = JSON.stringify(before?.[SERVER_NAME] ?? null);
      rep.changes.push(mergeMcpJson(path, j.key, j.entry(serveArgv(h))));
      if (foreignNote(before, path)) rep.notes.push(foreignChecked(path, j.key, fb));
      rep.notes.push(`${LABELS[h]} has no hooks bot-link can use, so new messages show up when the chat calls \`inbox\` (the tools tell it to). Then ${restartHint(h)}.`);
    } else {
      const argv = serveArgv("mcp");
      const entry = { command: argv[0], args: argv.slice(1), env: serverEnv() };
      if (opts.configPath) {
        const before = jsonServers(opts.configPath);
        const fb = JSON.stringify(before?.[SERVER_NAME] ?? null);
        rep.changes.push(mergeMcpJson(opts.configPath, "mcpServers", entry));
        if (foreignNote(before, opts.configPath)) rep.notes.push(foreignChecked(opts.configPath, "mcpServers", fb));
      } else rep.notes.push("Add this to your MCP app's config:\n" + JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2));
      rep.notes.push("Generic MCP apps get the tools; messages show up when the chat calls `inbox` (no hook support to push them).");
    }
    const cn = collisionNote(files);
    if (cn) {
      rep.ok = false;
      rep.collision = true;
      rep.notes.unshift(cn);
    }
  } catch (e) {
    rep.ok = false;
    // a file bot-link can't write (read-only, e.g. a link into the nix store): print what to add by hand
    const msg = (e as any).readonly ? `${(e as Error).message} Add this yourself, then ${restartHint(h)}:\n${pasteSnippet(h, opts.configPath)}` : (e as Error).message;
    // J3 v7 M1: an app with two files where one was written and the other refused is never "Nothing was changed".
    // The written ones are put back through the same checked write path; what can't be put back is said exactly.
    const done = rep.changes.filter((c) => (c.action === "created" || c.action === "updated") && lastWrites.has(resolve(c.file)));
    if (!done.length) rep.notes.unshift(msg);
    else {
      const failed = files.find((f) => !rep.changes.some((c) => resolve(c.file) === resolve(f))) ?? "the other file";
      const undone = done.filter((c) => rollback(c.file, pre.get(resolve(c.file)) ?? { span: "{}", snap: true }));
      if (undone.length === done.length) {
        const what = done.map((c) => `${c.action} ${c.file}`).join(" and ");
        for (const c of done) Object.assign(c, { action: "unchanged", detail: `${c.detail}: written, then put back exactly as it was` });
        rep.notes.unshift(`${msg} bot-link had already ${what}; it put ${done.length === 1 ? "it back exactly as it was" : "them back exactly as they were"}.`);
      } else {
        const why = msg.replace(/[;,.]?\s*[Nn]othing was changed\.?/g, "").replace(/\s*(Try again|Run setup again) in a moment\./g, "").trim().replace(/\.$/, "");
        const kept = done.filter((c) => !undone.includes(c));
        rep.notes.unshift(`bot-link is half-installed for ${LABELS[h]}: ${kept.map((c) => c.file).join(", ")} updated, ${failed} not (${why}). Run ${selfCmd()} setup ${h} again.`);
      }
    }
  }
  return rep;
}

/** What bot-link would add to a harness's files, for pasting by hand. */
function museEntry(): Record<string, unknown> {
  const argv = serveArgv("muse-code");
  return { transport: "stdio", command: argv[0], args: argv.slice(1), env: serverEnv() };
}

function museNote(path: string): string {
  return `bot-link didn't write ${path}: Muse Code's MCP settings format isn't in Meta's documentation yet (third-party guides ` +
    `describe "mcp_servers" with "transport": "stdio"), so check it against Muse Code before you paste. ` +
    `Add this entry to "mcp_servers" in ${path} (keep everything else, e.g. "schema_version"), then restart Muse Code:\n` +
    JSON.stringify({ mcp_servers: { [SERVER_NAME]: museEntry() } }, null, 2) +
    `\nMuse Code has no hooks bot-link can use, so new messages show up when the chat calls \`inbox\`.`;
}

export function pasteSnippet(h: HarnessKey, configPath?: string): string {
  const pj = (o: unknown) => JSON.stringify(o, null, 2);
  if (h === "muse-code") return `${musePath()} "mcp_servers":\n${pj({ [SERVER_NAME]: museEntry() })}`;
  if (h === "claude-code") {
    const hooks: Record<string, any[]> = {};
    for (const x of claudeHookSpecs()) (hooks[x.event] ||= []).push(x.group);
    return `${claudeJsonPath()} "mcpServers":\n${pj({ [SERVER_NAME]: claudeMcpEntry() })}\n${claudeSettingsPath()} "hooks" (append to each event):\n${pj(hooks)}`;
  }
  if (h === "codex") {
    const argv = serveArgv("codex");
    const hooks: Record<string, any[]> = {};
    for (const x of codexHookSpecs()) (hooks[x.event] ||= []).push(x.group);
    return `${join(codexHome(), "config.toml")}:\n[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlStr(argv[0])}\nargs = [${argv.slice(1).map(tomlStr).join(", ")}]\ndefault_tools_approval_mode = ${tomlStr(CODEX_TOOLS_APPROVAL)}\n${codexToolsLine()}\n${join(codexHome(), "hooks.json")} "hooks" (append to each event):\n${pj(hooks)}`;
  }
  if (h === "cursor") {
    const argv = serveArgv("cursor");
    const hooks: Record<string, any[]> = {};
    for (const x of cursorHookSpecs()) (hooks[x.event] ||= []).push(x.entry);
    return `${join(cursorDir(), "mcp.json")} "mcpServers":\n${pj({ [SERVER_NAME]: { type: "stdio", command: argv[0], args: argv.slice(1), env: serverEnv() } })}\n${join(cursorDir(), "hooks.json")} "hooks" (append to each event):\n${pj(hooks)}\n${cursorCliConfigPath()} "permissions" "allow" (append):\n${pj(cursorPermRules(SERVER_NAME))}`;
  }
  if (JSON_HARNESS[h]) {
    const j = JSON_HARNESS[h]!;
    return `${j.path()} "${j.key}":\n${pj({ [SERVER_NAME]: j.entry(serveArgv(h)) })}`;
  }
  const argv = serveArgv("mcp");
  return `${configPath || "your MCP app's config"} "mcpServers":\n${pj({ [SERVER_NAME]: { command: argv[0], args: argv.slice(1), env: serverEnv() } })}`;
}

/**
 * Can `setup h` write this harness's config? -> null, or why not (checked BEFORE pairing an agent for it, so a
 * harness bot-link can't wire never spends an agent slot).
 */
export function wireProblem(h: HarnessKey, configPath?: string): string | null {
  try {
    assertWirable(h, configPath);
    return null;
  } catch (e) {
    return (e as Error).message.split("\n")[0];
  }
}

/** Throws (the same error a write would) unless every file `setup h` touches can be read and written. */
function assertWirable(h: HarnessKey, configPath?: string): void {
  const files: { path: string; json: boolean }[] =
    h === "claude-code" ? [{ path: claudeJsonPath(), json: true }, { path: claudeSettingsPath(), json: true }] :
    h === "codex" ? [{ path: join(codexHome(), "config.toml"), json: false }, { path: join(codexHome(), "hooks.json"), json: true }] :
    h === "cursor" ? [{ path: join(cursorDir(), "mcp.json"), json: true }, { path: join(cursorDir(), "hooks.json"), json: true }, { path: cursorCliConfigPath(), json: true }] :
    JSON_HARNESS[h] ? [{ path: JSON_HARNESS[h]!.path(), json: true }] :
    configPath ? [{ path: configPath, json: true }] : [];
  for (const f of files) {
    if (f.json) {
      const o = readJsonFile(f.path).obj;
      if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error(`${f.path}: expected a JSON object; nothing was changed.`);
    } else if (existsSync(f.path)) {
      const t = readText(f.path) ?? ""; // FileBusy (another program is saving it) is its own refusal, not "invalid"
      try {
        parseToml(t);
      } catch (e) {
        throw new Error(`${f.path} isn't valid TOML (${(e as Error).message.split("\n")[0]}); bot-link won't edit it. Nothing was changed.`);
      }
    }
    if (existsSync(writeTarget(f.path)) || isLink(f.path)) assertWritable(f.path); // a dangling link into a gone folder is refused here, before any file is written
  }
}

// ---------------------------------------------------------------- uninstall: cut bot-link's span out of the CURRENT bytes
/** Every file `setup h` writes, with what kind of span bot-link has in it. */
export function filesOf(h: HarnessKey, configPath?: string): { path: string; fk: FileKind }[] {
  if (h === "claude-code") {
    const sp = claudeSettingsPath();
    return [{ path: claudeJsonPath(), fk: { json: mcpKind("mcpServers") } }, { path: sp, fk: { json: projectDir() ? { kind: "multi", parts: [hookKind(h, false), approveKind(sp)] } : hookKind(h, false) } }];
  }
  if (h === "codex") return [{ path: join(codexHome(), "config.toml"), fk: { toml: true } }, { path: join(codexHome(), "hooks.json"), fk: { json: hookKind(h, false) } }];
  if (h === "cursor") return [{ path: join(cursorDir(), "mcp.json"), fk: { json: mcpKind("mcpServers") } }, { path: join(cursorDir(), "hooks.json"), fk: { json: hookKind(h, true) } }, { path: cursorCliConfigPath(), fk: { json: permKind(cursorCliConfigPath()) } }];
  if (JSON_HARNESS[h]) return [{ path: JSON_HARNESS[h]!.path(), fk: { json: mcpKind(JSON_HARNESS[h]!.key) } }];
  return configPath ? [{ path: configPath, fk: { json: mcpKind("mcpServers") } }] : [];
}

interface Removal {
  path: string;
  target: string;
  text: string;
  after: string;
  removed: string[];
  /** what the user added INSIDE bot-link's entries (keys, env keys, comments): it goes with the entry, and is named */
  added: string[];
  /** J3b: set when `added` is not empty and the removal is carried out: the kept copies (never overwritten) */
  prevFile?: string;
  keptFile?: string;
  del: boolean;
  notes: string[];
}

/** Keys bot-link writes into its hook objects / hook groups (anything else in them is the user's). */
const OWN_HOOK_KEYS = new Set(["type", "command", "timeout", "asyncRewake"]);

/** The comments in text[from, to) (JSONC). */
function jsonComments(text: string, from: number, to: number): string[] {
  const sc = jsonc.createScanner(text.slice(from, to), false);
  const out: string[] = [];
  for (let t = sc.scan(); t !== jsonc.SyntaxKind.EOF; t = sc.scan()) {
    if (t === jsonc.SyntaxKind.LineCommentTrivia || t === jsonc.SyntaxKind.BlockCommentTrivia) out.push(text.slice(from + sc.getTokenOffset(), from + sc.getTokenOffset() + sc.getTokenLength()));
  }
  return out;
}

/** Where a `#` comment starts in one TOML line (outside "..." and '...' strings); -1: none. Multi-line strings aside. */
function tomlCommentAt(l: string): number {
  let q: string | null = null;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#") return i;
  }
  return -1;
}

const shortQ = (c: string) => (c.length > 40 ? `${c.slice(0, 37)}...` : c);

/**
 * What the user put inside bot-link's own entries in `text` (setup keeps those; uninstall cuts them with the entry):
 * keys bot-link doesn't write, env keys other than its own, and comments. -> labels like env.MY_VAR, alwaysAllow,
 * a comment (// mine).
 */
function userAdditions(h: HarnessKey, fk: FileKind, text: string): string[] {
  if ("json" in fk && fk.json.kind === "multi") return [...new Set(fk.json.parts.flatMap((k) => userAdditions(h, { json: k }, text)))];
  const out: string[] = [];
  try {
    if ("toml" in fk) {
      const doc = parseToml(text);
      const lines = text.split("\n");
      for (const n of cloudNamesIn(tomlEntries(text))) {
        const e = doc.mcp_servers?.[n] as Record<string, any> | undefined;
        if (!e) continue;
        for (const k of Object.keys(e)) {
          if (k === "env" && e.env && typeof e.env === "object") for (const ek of Object.keys(e.env)) { if (!OWNED_ENV.has(ek)) out.push(`env.${ek}`); }
          else if (!OWNED_KEYS.has(k)) out.push(k);
        }
        for (const [a, b] of tomlTableRanges(text, ["mcp_servers", n])) {
          for (let i = a; i < b; i++) {
            const l = lines[i].replace(/\r$/, "");
            const at = tomlCommentAt(l);
            if (at >= 0) out.push(`a comment (${shortQ(l.slice(at).trim())})`);
          }
        }
      }
      return out;
    }
    const doc = parseJsonStrict(text);
    const root = jsonc.parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
    const comments = (p: JPath) => {
      const node = root && jsonc.findNodeAtLocation(root, p);
      return node ? jsonComments(text, node.offset, node.offset + node.length).map((c) => `a comment (${shortQ(c)})`) : [];
    };
    for (const it of spanItems(doc, fk.json)) {
      if (fk.json.kind === "perm") continue; // a bare string: nothing of the user's can be inside it
      if (fk.json.kind === "mcp") {
        const e = getAt(doc, it.path);
        if (!isPlainObj(e)) continue;
        const fresh = freshEntryKeys(h, fk.json.key);
        for (const [k, v] of Object.entries(e)) {
          if ((k === "env" || k === "environment") && isPlainObj(v)) { for (const ek of Object.keys(v)) if (!OWNED_ENV.has(ek)) out.push(`${k}.${ek}`); }
          else if (!OWNED_KEYS.has(k) && !(k in fresh && sameJson(fresh[k], v))) out.push(k);
        }
        out.push(...comments(it.path));
        continue;
      }
      const hk = getAt(doc, it.at!);
      if (isPlainObj(hk)) for (const k of Object.keys(hk)) if (!OWN_HOOK_KEYS.has(k)) out.push(`${it.label}: ${k}`);
      if (it.path.length === 3 && fk.json.kind === "nested") {
        // the whole group goes with bot-link's hook: the user's keys on the group (a matcher bot-link didn't set)
        const g = getAt(doc, it.path);
        if (isPlainObj(g)) for (const [k, v] of Object.entries(g)) if (k !== "hooks" && !(k === "matcher" && v === "*")) out.push(`${it.label}: ${k}`);
      }
      out.push(...comments(it.path).map((c) => `${it.label}: ${c}`));
    }
  } catch {
    /* can't tell: say nothing extra */
  }
  return [...new Set(out)];
}

/** The keys (with values) of the entry bot-link writes for h, beyond the owned ones (vscode's tools, opencode's enabled). */
function freshEntryKeys(h: HarnessKey, key: string): Record<string, unknown> {
  try {
    const j = JSON_HARNESS[h];
    if (j && j.key === key) return j.entry(serveArgv(h));
  } catch {
    /* none */
  }
  return {};
}

/** What bot-link's entries in a file are, for removing them by hand. */
function spanList(fk: FileKind, text: string): string {
  try {
    if ("toml" in fk) return cloudNamesIn(tomlEntries(text)).map((n) => `[mcp_servers.${n}]`).join(", ");
    if (fk.json.kind === "multi") return fk.json.parts.map((k) => spanList({ json: k }, text)).filter(Boolean).join("; ");
    const doc = parseJsonStrict(text);
    return spanItems(doc, fk.json).map((it) => (fk.json.kind === "mcp" || fk.json.kind === "perm" ? it.label : `${it.label}: ${getAt(doc, it.at!)?.command}`)).join("; ");
  } catch {
    return "bot-link's entries";
  }
}

/**
 * J3 v7 L1: ~/.botlink-mcp (the ledger) is gone, so bot-link has no record of the containers it created. Then a
 * container that holds ONLY bot-link's items (its server list, a hooks event list, the hooks object, Cursor's
 * "version": 1 next to such hooks) counts as bot-link's: setup creates exactly those when they are missing. -> the span
 * record to cut with, or null (the ledger knows this file, or nothing of ours is in it).
 */
function noLedgerRecord(path: string, fk: FileKind, text: string): SpanInfo | null {
  if (snapshotOf(path) || Object.keys(spanInfo(path)).length || "toml" in fk) return null;
  let doc: any;
  try {
    doc = parseJsonStrict(text);
  } catch {
    return null;
  }
  if (!isPlainObj(doc) || !spanItems(doc, fk.json).length) return null;
  const created: string[] = [];
  const k0 = fk.json;
  if (k0.kind === "multi") {
    for (const part of k0.parts) created.push(...(noLedgerRecord(path, { json: part }, text)?.created || []));
    return { created };
  }
  if (k0.kind === "perm") return { created };
  const k = k0;
  if (k.kind === "mcp") {
    const sv = doc[k.key];
    if (isPlainObj(sv) && Object.keys(sv).length && Object.entries(sv).every(([n, e]) => k.isOurs(n, e))) created.push(J([k.key]));
    return { created };
  }
  if (!isPlainObj(doc.hooks)) return { created };
  const evs = Object.entries(doc.hooks);
  const oursOnly = (g: any) => (k.kind === "flat" ? !!g && k.isOurs(g.command) : !!g && Array.isArray(g.hooks) && g.hooks.length > 0 && g.hooks.every((x: any) => x && k.isOurs(x.command)));
  let all = evs.length > 0;
  for (const [ev, list] of evs) {
    if (Array.isArray(list) && list.length && list.every(oursOnly)) created.push(J(["hooks", ev]));
    else all = false;
  }
  if (all) {
    created.push(J(["hooks"]));
    if (k.kind === "flat" && doc.version === 1) created.push(J(["version"]));
  }
  return { created };
}

/**
 * Plan the removal of bot-link's span from one file: the current bytes minus our span (span.ts, self-checked cut by
 * cut). Deleted only when the ledger says bot-link created the file AND what is left is an empty skeleton. -> the
 * plan, or null (nothing of ours in it). Throws (nothing written anywhere) when the cut can't be made safely.
 */
function planRemoval(h: HarnessKey, path: string, fk: FileKind): Removal | null {
  const target = writeTarget(path);
  const text = readText(path); // a stable read, held until the write (J3 v7)
  if (text === null) return null;
  const rec = noLedgerRecord(path, fk, text) ?? spanInfo(path);
  let after: string;
  let removed: string[];
  try {
    if ("toml" in fk) {
      let names: string[];
      try {
        names = cloudNamesIn(tomlEntries(text));
        parseToml(text);
      } catch (e) {
        throw new SpanError(`it isn't valid TOML (${(e as Error).message.split("\n")[0]})`);
      }
      if (!names.length) return null;
      after = stripToml(text, names, rec);
      if (after === text) throw new SpanError(`${names.map((n) => `[mcp_servers.${n}]`).join(", ")} is written as a dotted key or an inline table, which bot-link doesn't cut`);
      const why = verifyTomlEdit(text, after, names, null);
      if (why) throw new SpanError(why);
      removed = names.map((n) => `[mcp_servers.${n}]`);
    } else {
      let r;
      try {
        r = stripJson(text, fk.json, rec);
      } catch (e) {
        if (e instanceof SpanError && /valid JSON/.test(e.message)) throw new SpanError(`it isn't valid JSON (${parseJsonc(text).error})`);
        throw e;
      }
      if (!r.removed.length && r.text === text) return null;
      after = r.text;
      removed = r.removed;
      if (SKELETONS.has(after) && rec.emptyFile !== undefined) after = rec.emptyFile;
      if (spanItems(parseJsonStrict(after), fk.json).length) throw new SpanError("some of bot-link's entries would still be there");
    }
  } catch (e) {
    if (!(e instanceof SpanError)) throw e;
    throw new Error(`${path}: bot-link couldn't remove its entries without touching anything else (${e.message}); nothing was changed. Remove these yourself: ${spanList(fk, text)}`);
  }
  const snap = snapshotOf(path);
  const del = !!snap?.created && SKELETONS.has(after) && rec.emptyFile === undefined;
  const notes: string[] = [];
  if (!snap && SKELETONS.has(after.trim()) && after.trim() && !SKELETONS.has(text.trim())) {
    notes.push(`${path} is now an empty ${after.trim()}. bot-link has no record of creating it (${homeDir()} was deleted), so it left the file; delete it if nothing else uses it.`);
  }
  // a hard link that was there when bot-link wrote, and isn't any more (the app replaced the file): name the twin (H3)
  const ln = rec.links;
  if (ln && ln.nlink > 1) {
    const st = statSync(target);
    if (st.ino !== ln.ino || st.nlink < ln.nlink) {
      // the names recorded at setup, else a search by the inode recorded then (the old inode lives on under them)
      const others = (ln.others.length ? ln.others : linkNames(ln.ino, ln.dev, target)).filter((o) => existsSync(o) && resolve(o) !== resolve(target) && sameInode(o, ln.ino, ln.dev));
      const still = others.filter((o) => holdsOurs(o, readFileSync(o, "utf-8")));
      notes.push(`${path} was hard-linked${others.length ? ` with ${others.join(", ")}` : ""} when bot-link wrote it, but something has since replaced it with a separate file, so that link is broken. bot-link removed its entries from ${path} only. ${still.length ? `${still.join(", ")} still hold${still.length === 1 ? "s" : ""} bot-link's entry: remove it there by hand (or re-link the files after this uninstall).` : others.length ? `${others.join(", ")} may differ from ${path} now.` : "bot-link couldn't find the other name of that file; it may still hold bot-link's entry."}`);
    }
  }
  // a symlink something replaced with a regular file: the link's target may still hold our entry
  if (snap && snap.link !== null && !isLink(path)) {
    const t = snap.target;
    const still = existsSync(t) && holdsOurs(t, readFileSync(t, "utf-8"));
    notes.push(`${path} was a symlink to ${snap.link} when bot-link set it up; it is a regular file now (something replaced the link). bot-link removed its entries from ${path} only; ${t} ${still ? "still holds bot-link's entry: remove it there by hand" : "was left as it is"}.`);
  }
  // other changes since bot-link's first write stay: said plainly, never undone
  if (!del && snap && snap.existed && snap.bak && existsSync(snap.bak) && snap.sha256 !== null && sha(readFileSync(snap.bak)) === snap.sha256) {
    const orig = readFileSync(snap.bak, "utf-8");
    const mode = statSync(target).mode & 0o7777;
    const diffs: string[] = [];
    if (orig !== after) diffs.push(firstDiff(orig, after));
    if (snap.mode !== null && mode !== snap.mode) diffs.push(`its mode is ${modeStr(mode)} (it was ${modeStr(snap.mode)})`);
    if (diffs.length) notes.push(`${path}: changes made since bot-link's first edit were kept (compared with the copy saved then, ${diffs.join("; ")}). To go back to that copy and lose them: ${selfCmd()} uninstall ${h} --restore ${q(path)} --force`);
  }
  return { path, target, text, after, removed, added: userAdditions(h, fk, text), del, notes };
}

function firstDiff(a0: string, b0: string): string {
  const a = a0.split("\n");
  const b = b0.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length - 1 && i === b.length && a[i] === "") return "the final newline is gone";
  if (i === b.length - 1 && i === a.length && b[i] === "") return "it ends with a newline the copy didn't have";
  return `it differs from line ${i + 1} on`;
}

/** Carry out a planned removal; the file is re-read first, and a file that changed since the plan is planned again. */
function applyRemoval(r: Removal): Change {
  const held = heldOf(r.path);
  if (r.del) {
    // only the exact bytes and inode that were planned from go (an app saving it meanwhile keeps its file)
    if (!held || !unlinkIfStill(r.path, held)) throw new ConcurrentChange(r.path, false);
    removeCreatedDirs(r.target);
    forget(r.path);
    return { file: r.path, action: "removed", detail: r.target !== resolve(r.path) && isLink(r.path) ? `bot-link created ${r.target} (the link pointed at nothing) and nothing else is in it; deleted it, the link stays` : "bot-link created this file and nothing else is in it; deleted it" };
  }
  // J3b: what the user added inside bot-link's entries goes with them: first into files of its own that nothing
  // overwrites later (the whole file as it was, and the removed lines), named in the result
  if (r.added.length && r.text) {
    r.prevFile = keepPrev(r.path, r.text);
    r.keptFile = keepRemoved(r.path, r.added, lineDiff(r.text, r.after).lost.filter((l) => l.trim()), r.prevFile);
  }
  // its mode, and its inode when hard-linked, stay; never over a newer write; the replaced inode is watched (H1)
  writeContent(r.path, r.after, { expect: held ? held.buf : r.text, held: held ?? null, names: attemptNames.get(dirname(r.target)), appLock: appLockOf(r.path) });
  let now: string | null = null;
  try {
    now = readFileSync(r.target, "utf-8");
  } catch {
    /* gone */
  }
  if (now !== r.after) throw new ConcurrentChange(r.path, true); // someone wrote right after: planned again from their bytes
  forget(r.path);
  return { file: r.path, action: "removed", detail: removedDetail(r), ...(r.added.length ? { added: r.added } : {}) };
}

function removedDetail(r: Removal): string {
  const what = `Removed bot-link's entries (${[...new Set(r.removed)].join(", ")})`;
  if (!r.added.length) return `${what}. Nothing else was changed.`;
  return `${what}, including what you added inside them: ${r.added.join(", ")}. Nothing outside them was changed. The file as it was is in ${r.prevFile}. What you added is also saved in ${r.keptFile} (bot-link never overwrites or deletes either).`;
}

export function uninstall(h: HarnessKey, opts: { configPath?: string } = {}): Report {
  const bad = ledgerProblem();
  if (bad && !PASTE_ONLY.has(h)) return { harness: h, ok: false, changes: [], notes: [bad] };
  return withLock("config", () => uninstallLocked(h, opts));
}

function uninstallLocked(h: HarnessKey, opts: { configPath?: string }): Report {
  const rep: Report = { harness: h, ok: true, changes: [], notes: [] };
  if (PASTE_ONLY.has(h)) {
    // never written by bot-link, so never edited on uninstall either: say what to remove, if anything
    const path = musePath();
    let obj: any = null;
    try {
      obj = existsSync(path) ? readJsonFile(path).obj : null;
    } catch (e) {
      rep.notes.push((e as Error).message.split("\n")[0]);
    }
    const ours = cloudNamesIn(obj?.mcp_servers);
    if (ours.length) {
      rep.manual = true;
      rep.notes.push(`bot-link never writes ${path}: remove ${ours.map((n) => `"${n}"`).join(", ")} from "mcp_servers" in ${path} yourself, then restart Muse Code.`);
    }
    return rep;
  }
  const done = new Map<string, { c: Change; notes: string[] }>();
  const files = filesOf(h, opts.configPath);
  collided.clear();
  try {
    // 1. every file is planned (and checked) before any is written: one that can't be done safely stops them all
    beginAttempt();
    try {
      for (const f of files) planRemoval(h, f.path, f.fk);
    } finally {
      endAttempt();
    }
    // 2. then each file on its own, from a fresh stable read held open until its write (J3 v7): the window between the
    // read a cut is planned from and the checks before its rename stays as short as setup's
    for (const f of files) {
      for (let attempt = 1; ; attempt++) {
        attemptNames.set(dirname(writeTarget(f.path)), dirNames(dirname(writeTarget(f.path))));
        beginAttempt();
        let plan: Removal | null = null;
        try {
          const p = (plan = planRemoval(h, f.path, f.fk));
          if (!p) {
            if (!done.has(f.path)) {
              done.set(f.path, { c: { file: f.path, action: "unchanged", detail: existsSync(writeTarget(f.path)) ? "no bot-link entries" : "not there" }, notes: [] });
              if (snapshotOf(f.path)) forget(f.path);
            } else if (hasOverride(f.path)) {
              // their bytes hold nothing of ours any more: they go back in place over bot-link's own write
              const theirs = readForEdit(f.path).plan!;
              const held = heldOf(f.path)!;
              writeContent(f.path, theirs, { expect: held.buf, held, names: attemptNames.get(dirname(writeTarget(f.path))), appLock: appLockOf(f.path) });
            }
            clearOverride(f.path);
            break;
          }
          const c = applyRemoval(p);
          if (done.has(f.path) && done.get(f.path)!.c.action === "removed") c.detail = done.get(f.path)!.c.detail; // the first removal's report
          clearOverride(f.path);
          done.set(f.path, { c, notes: p.notes });
          break;
        } catch (e) {
          if (e instanceof OrphanWrite) {
            // the app saved the file in place while bot-link renamed its own over it: cut the span again, from THEIR bytes
            setOverride(f.path, e.theirs, e.ours);
            if (!done.has(f.path)) done.set(f.path, { c: { file: f.path, action: "removed", detail: plan ? removedDetail(plan) : "Removed bot-link's entries." }, notes: plan?.notes ?? [] });
            if (attempt >= RACE_TRIES) throw new Error(rescueOrphan(f.path));
            continue;
          }
          if (!(e instanceof ConcurrentChange)) {
            if (hasOverride(f.path)) (e as Error).message += ` ${rescueOrphan(f.path)}`;
            throw e;
          }
          if (e.landed && !done.has(f.path)) done.set(f.path, { c: { file: f.path, action: "removed", detail: plan ? removedDetail(plan) : "Removed bot-link's entries." }, notes: plan?.notes ?? [] });
          if (attempt >= RACE_TRIES) {
            if (hasOverride(f.path)) throw new Error(rescueOrphan(f.path));
            const gone = [...done.values()].filter((d) => d.c.action === "removed").map((d) => d.c.file);
            throw new Error(`${f.path} kept changing while bot-link removed its entries (is the app running?); ${gone.length ? `bot-link removed its entries from ${gone.join(", ")} only` : "nothing was changed"}. Quit the app and run uninstall again.`);
          }
          sleepMs(10 * attempt + Math.floor(Math.random() * 25));
        } finally {
          endAttempt();
        }
      }
    }
    // in file order, each once (a file written, then re-planned after a racing write, reports its first removal)
    for (const f of files) {
      const d = done.get(f.path);
      if (!d) continue;
      rep.changes.push(d.c);
      rep.notes.push(...d.notes);
    }
    const cn = collisionNote(files.map((f) => f.path));
    if (cn) {
      rep.ok = false;
      rep.collision = true;
      rep.notes.unshift(cn);
    }
  } catch (e) {
    rep.ok = false;
    for (const f of files) {
      clearOverride(f.path);
      const d = done.get(f.path);
      if (d && d.c.action === "removed") rep.changes.push(d.c); // what was removed before it stopped is said, exactly
    }
    rep.notes.unshift((e as Error).message);
  }
  return rep;
}

// ---------------------------------------------------------------- --restore <file> --force: the only way old bytes come back
/** Line diff (LCS) of now -> then: the lines that would be lost and the ones that would come back. */
function lineDiff(now: string, then: string): { lost: string[]; back: string[] } {
  const a = now.split("\n");
  const b = then.split("\n");
  if (a.length * b.length > 4_000_000) return { lost: a.filter((l) => !b.includes(l)), back: b.filter((l) => !a.includes(l)) };
  const L: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const lost: string[] = [];
  const back: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && L[i + 1][j] >= L[i][j + 1])) lost.push(a[i++]);
    else back.push(b[j++]);
  }
  return { lost, back };
}

/** Lines in a text the way an editor counts them (a final newline doesn't start another line). */
function lineCount(t: string): number {
  return t === "" ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
}

/**
 * Put back the copy of `file` bot-link saved before its first change. Shows what that loses first; does it only
 * with force. Never part of uninstall. -> ok + the lines to print.
 */
export function restore(h: HarnessKey, file: string, force: boolean): { ok: boolean; changed: boolean; lines: string[] } {
  const bad = ledgerProblem();
  if (bad) return { ok: false, changed: false, lines: [bad] };
  return withLock("config", () => {
    const path = resolve(file.replace(/^~(?=\/|$)/, home()));
    collided.clear();
    const snap = anySnapshotOf(path);
    const lines: string[] = [];
    let preFile: string | null = null;
    if (!snap) {
      const known = snapshotPaths();
      return { ok: false, changed: false, lines: [`bot-link has no copy of ${path} from before it changed it; nothing was changed.${known.length ? ` It has copies of: ${known.join(", ")}` : ""}`] };
    }
    const target = snap.target;
    let orig: Buffer | null = null;
    if (!snap.created && snap.existed) {
      if (!snap.bak || !existsSync(snap.bak) || snap.sha256 === null || sha(readFileSync(snap.bak)) !== snap.sha256) {
        return { ok: false, changed: false, lines: [`bot-link's copy of ${path} from before its first change is missing or damaged; nothing was changed.`] };
      }
      orig = readFileSync(snap.bak);
    }
    // J3 v7 H2: the same safe write path as setup and uninstall: a stable read held open until the write (flock'ed),
    // the folder names, Claude Code's save lock, the compare, the inode, and the replaced inode watched after
    const relink = snap.link !== null && !isLink(path);
    const where = relink ? target : path;
    const dir = dirname(writeTarget(where));
    for (let attempt = 1; ; attempt++) {
      attemptNames.set(dir, dirNames(dir));
      beginAttempt();
      try {
        const { held } = readForEdit(where, knownBytes(path));
        const nowText = held ? held.buf.toString("utf-8") : null;
        const out: string[] = [];
        const when = snap.at.slice(0, 16).replace("T", " ") + " UTC";
        if (orig === null) out.push(`bot-link created ${target} (${when}); restoring means DELETING it${nowText !== null ? `, which loses all ${lineCount(nowText)} line${lineCount(nowText) === 1 ? "" : "s"} in it` : ""}.`);
        else {
          const d = lineDiff(nowText ?? "", orig.toString("utf-8"));
          out.push(`Restoring ${path} puts back the copy bot-link saved on ${when}, before its first change.`);
          if (!d.lost.length && !d.back.length) out.push("The content is already the same.");
          if (d.lost.length) out.push(`It LOSES ${d.lost.length} line${d.lost.length === 1 ? "" : "s"} that ${d.lost.length === 1 ? "is" : "are"} in the file now (every change made since then, by you or the app, included):`, ...d.lost.slice(0, 30).map((l) => `  - ${l}`), ...(d.lost.length > 30 ? [`  ... and ${d.lost.length - 30} more`] : []));
          if (d.back.length) out.push(`It brings back ${d.back.length} line${d.back.length === 1 ? "" : "s"}:`, ...d.back.slice(0, 30).map((l) => `  + ${l}`), ...(d.back.length > 30 ? [`  ... and ${d.back.length - 30} more`] : []));
          const mode = held ? held.mode : null;
          if (snap.mode !== null && mode !== null && mode !== snap.mode) out.push(`Its mode goes back to ${modeStr(snap.mode)} (it is ${modeStr(mode)} now).`);
        }
        if (relink) out.push(`${path} becomes a symlink to ${snap.link} again (it is a regular file now; its content above is what is lost).`);
        if (!force) {
          out.push(`Nothing was changed. To do it: ${selfCmd()} uninstall ${h} --restore ${q(path)} --force${held ? ` (the file as it is now is saved first, as a new file ${preRestoreBase(path)}.<date and time>)` : ""}`);
          return { ok: true, changed: false, lines: [...lines, ...out] };
        }
        // undoable: the file as it is now (the stable read) is saved first (J3 v6), 0600, in a NEW file every time
        // (J3b: an earlier restore's copy is never moved or overwritten); a re-try after a racing write saves the
        // newest bytes again, and that copy is the one named
        if (held) preFile = keepPreRestore(path, held.buf);
        if (attempt === 1) lines.push(...out);
        if (relink) {
          // the regular file goes only if it is still exactly what was read
          const cur = readForEdit(path);
          if (cur.held && !unlinkIfStill(path, cur.held)) throw new ConcurrentChange(path, false);
          symlinkSync(snap.link!, path);
          const t = readForEdit(target);
          if (orig !== null) writeContent(target, orig, { ...(snap.mode !== null ? { mode: snap.mode } : {}), expect: t.held ? t.held.buf : null, held: t.held, names: dirNames(dirname(target)), appLock: appLockOf(path) });
          else if (t.held && !unlinkIfStill(target, t.held)) throw new ConcurrentChange(path, false);
        } else if (orig === null) {
          if (held && !unlinkIfStill(where, held)) throw new ConcurrentChange(path, false);
          removeCreatedDirs(target);
        } else {
          // never over a write that came after the read above (the app's): that would be lost, the copy wouldn't hold it
          writeContent(where, orig, { ...(snap.mode !== null ? { mode: snap.mode } : {}), expect: held ? held.buf : null, held, names: attemptNames.get(dir), appLock: appLockOf(path) });
        }
        forget(path);
        if (preFile) lines.push(`Saved the file as it was before this restore: ${preFile} (to undo: cp ${q(preFile)} ${q(path)}).`);
        lines.push(`Restored ${path}.`);
        const cn = collisionNote([path, where]);
        if (cn) return { ok: false, changed: true, lines: [...lines, cn] };
        return { ok: true, changed: true, lines };
      } catch (e) {
        if (e instanceof OrphanWrite) {
          // the app saved the file in place while bot-link renamed the old copy over it: their save is put back (and
          // kept in .pre-restore); the restore is not done
          endAttempt();
          setOverride(where, e.theirs, e.ours);
          const msg = rescueOrphan(where);
          try {
            keepPreRestore(path, e.theirs);
          } catch {
            /* best effort: the message names where their bytes are */
          }
          return { ok: false, changed: false, lines: [...lines, `${path} was saved by another program while bot-link was restoring it, so it was not restored. ${msg} Quit the app and run the restore again.`] };
        }
        if (e instanceof InPlaceRace) return { ok: false, changed: true, lines: [...lines, e.message] };
        if (e instanceof FileBusy || e instanceof LostWrite) return { ok: false, changed: false, lines: [...lines, `${e.message} It was not restored.`] };
        if (!(e instanceof ConcurrentChange)) throw e;
        if (attempt >= RACE_TRIES) return { ok: false, changed: false, lines: [...lines, `${path} changed while bot-link was restoring it (is the app running?); it was not restored. Quit the app and run the restore again.`] };
        sleepMs(10 * attempt + Math.floor(Math.random() * 25));
      } finally {
        endAttempt();
      }
    }
  });
}

// ---------------------------------------------------------------- doctor support
export interface Check {
  ok: boolean;
  what: string;
  fix?: string;
  /** files this failure is about that don't exist (doctor folds many of them under one gone directory) */
  missing?: string[];
  harness?: string;
}

/** How old the .prev copy is and what copying it back throws away (J3-r3 F4: it can be weeks old). */
function prevNote(prev: string): string {
  const t = statSync(prev).mtime;
  const days = Math.floor((Date.now() - t.getTime()) / 86400000);
  const age = days < 1 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
  return `the copy from before bot-link's last change is from ${t.toISOString().slice(0, 16).replace("T", " ")} UTC (${age}); copying it back DISCARDS every change made to the file since then (by you or the app):`;
}

function argvFiles(cmd: string, args: string[]): string[] {
  return [cmd, ...args.filter((a) => /cli\.js$/.test(a))];
}

export function checkHarness(h: Exclude<HarnessKey, "mcp">): Check[] {
  const out: Check[] = [];
  const fixSetup = `${selfCmd()} setup ${h}${PASTE_ONLY.has(h) ? " (prints what to paste)" : ""}`;
  const jsonOk = (path: string): any | null => {
    try {
      return readJsonFile(path).obj;
    } catch (e) {
      if (e instanceof FileBusy) {
        out.push({ ok: false, what: e.message.replace(/ Nothing was changed\./, ""), fix: `run ${selfCmd()} doctor again in a moment` });
        return null;
      }
      const inv = (e as any).invalid as { detail: string } | undefined;
      const prev = latestPrev(path);
      out.push({
        ok: false,
        what: `${path} is not valid JSON${inv ? ` (${inv.detail})` : ""}`,
        fix: `fix the syntax error${inv ? ` (${inv.detail})` : ""}, then run ${fixSetup}${prev && existsSync(prev) ? `. Last resort: ${prevNote(prev)} cp ${prev} ${path}` : ""}`,
      });
      return null;
    }
  };
  const entryCheck = (where: string, cmd?: string, args?: string[], entry?: unknown) => {
    if (!cmd) {
      out.push({ ok: false, what: `${h}: the bot-link cloud MCP server is not configured (${where})`, fix: fixSetup });
      return;
    }
    const off = disabledBy(entry, /\.toml$/.test(where));
    if (off) {
      out.push({ ok: false, what: `${h}: bot-link's MCP server is turned off in ${where} (${off}): ${h === "codex" ? "Codex" : LABELS[h] || h} won't load it`, fix: `delete that line (${off}) from bot-link's entry in ${where}, then restart the app` });
      return;
    }
    const missing = argvFiles(cmd, args || []).filter((f) => !existsSync(f));
    if (missing.length) out.push({ ok: false, what: `${h}: the bot-link server points to missing files: ${missing.join(", ")}`, fix: `${fixSetup} (re-points it at this install)`, missing, harness: h });
    else out.push({ ok: true, what: `${h}: MCP server configured (${where})` });
  };
  const hooksCheck = (path: string, flat: boolean, wantEvents: string[]) => {
    const obj = jsonOk(path);
    if (obj === null) return;
    // every hook bot-link recognises as its own (exact or by shape), so dead and duplicate ones are seen too (H4)
    const items = spanItems(obj, hookKind(h, flat));
    const have = new Set<string>();
    const count = new Map<string, number>();
    let deadOurs = false;
    for (const it of items) {
      have.add(it.ev!); // there (even when it points into a gone folder: that is its own line, J3 v7 L5)
      const c = getAt(obj, it.at!)?.command;
      const key = `${it.ev} ${it.role}`;
      count.set(key, (count.get(key) || 0) + 1);
      const file = hookShape(c)?.cli;
      if (file && !existsSync(file)) {
        out.push({ ok: false, what: `${h}: hook ${it.ev} points to a missing file ${file}`, fix: `${fixSetup} (re-points it at this install)`, missing: [file], harness: h });
        deadOurs = true;
      }
    }
    // hooks shaped like bot-link's (`<node> <path>/dist/cli.js hook <app> <role>`) whose cli.js is gone, but at a path
    // that isn't where bot-link installs itself: bot-link can't prove they are its own, so it never removes them;
    // they still fail on every event, so they are named here with the fix (J3 v6)
    const mine = new Set(items.map((it) => J(it.at!)));
    const dead = new Map<string, { evs: string[]; cmds: string[] }>();
    const visit = (ev: string, at: JPath, c: unknown) => {
      const sh = hookShape(c);
      if (!sh || sh.app !== h || existsSync(sh.cli) || mine.has(J(at))) return;
      const d = dead.get(sh.cli) || { evs: [], cmds: [] };
      d.evs.push(ev);
      d.cmds.push(c as string);
      dead.set(sh.cli, d);
    };
    for (const [ev, list] of Object.entries(isPlainObj(obj?.hooks) ? obj.hooks : {})) {
      if (!Array.isArray(list)) continue;
      list.forEach((g: any, gi: number) => {
        if (flat) visit(ev, ["hooks", ev, gi], g?.command);
        else if (Array.isArray(g?.hooks)) g.hooks.forEach((x: any, hi: number) => visit(ev, ["hooks", ev, gi, "hooks", hi], x?.command));
      });
    }
    for (const [cli, d] of dead) {
      out.push({
        ok: false,
        what: `${h}: ${d.cmds.length} hook${d.cmds.length === 1 ? "" : "s"} in ${path} (${[...new Set(d.evs)].join(", ")}) run ${cli}, which doesn't exist: ${h === "cursor" ? "Cursor" : LABELS[h]} runs a failing command on every one of those events`,
        fix: `delete ${d.cmds.length === 1 ? "that hook" : "those hooks"} from ${path} by hand (bot-link removes only hooks it can prove are its own, and ${dirname(dirname(cli))} isn't a place bot-link installs itself): ${[...new Set(d.cmds)].join(" | ")}`,
        harness: h, // no `missing`: never folded into a "run setup" line, setup leaves these
      });
    }
    const dups = [...count].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
    if (dups.length) out.push({ ok: false, what: `${h}: duplicate bot-link hooks in ${path} (${dups.join(", ")}): the app runs each of them more than once`, fix: `${fixSetup} (keeps one of each and removes the rest)` });
    const missing = wantEvents.filter((e) => !have.has(e));
    if (missing.length) out.push({ ok: false, what: `${h}: live-arrival/taint hooks missing: ${missing.join(", ")} (${path})`, fix: fixSetup });
    else if (!dups.length && !deadOurs) out.push({ ok: true, what: `${h}: ${wantEvents.length} hooks installed (${wantEvents.join(", ")})${h === "codex" ? `. Codex runs them only after you trust them in /hooks; bot-link can't check that, so run /hooks in Codex once and trust the ${wantEvents.length} bot-link hooks` : ""}` });
  };
  /** two cloud entries of ours (botlink AND botlink-cloud): the app starts bot-link twice (H4: doctor flags it everywhere) */
  const dupEntries = (where: string, servers: any) => {
    const n = cloudNamesIn(isPlainObj(servers) ? servers : undefined);
    if (n.length > 1) out.push({ ok: false, what: `${h}: ${n.length} bot-link server entries in ${where} (${n.join(", ")}): the app starts bot-link more than once`, fix: `${fixSetup} (keeps one and removes the rest)` });
  };
  if (h === "muse-code") {
    const obj = jsonOk(musePath());
    if (obj !== null) {
      const n = cloudNamesIn(obj?.mcp_servers)[0];
      const v = n ? entryArgv(obj.mcp_servers[n]) : [];
      entryCheck(musePath(), v[0], v.slice(1), n ? obj.mcp_servers[n] : undefined);
    }
    return out;
  }
  if (JSON_HARNESS[h]) {
    const j = JSON_HARNESS[h]!;
    const obj = jsonOk(j.path());
    if (obj !== null) {
      const n = cloudNamesIn(obj?.[j.key])[0];
      const v = n ? entryArgv(obj[j.key][n]) : [];
      entryCheck(j.path(), v[0], v.slice(1), n ? obj[j.key][n] : undefined);
      dupEntries(j.path(), obj?.[j.key]);
    }
    return out;
  }
  if (h === "claude-code") {
    const obj = jsonOk(claudeJsonPath());
    if (obj !== null) {
      const n = cloudNamesIn(obj?.mcpServers)[0];
      entryCheck(claudeJsonPath(), n ? obj.mcpServers[n].command : undefined, n ? obj.mcpServers[n].args : undefined, n ? obj.mcpServers[n] : undefined);
      dupEntries(claudeJsonPath(), obj?.mcpServers);
    }
    hooksCheck(claudeSettingsPath(), false, claudeHookEvents());
  } else if (h === "codex") {
    const cfg = join(codexHome(), "config.toml");
    let bad: string | null = null;
    try {
      if (existsSync(cfg)) parseToml(readFileSync(cfg, "utf-8")); // the real parser, as Codex reads it (J3 L3)
    } catch (e) {
      bad = (e as Error).message.split("\n")[0];
    }
    if (bad !== null) {
      const prev = latestPrev(cfg);
      out.push({ ok: false, what: `${cfg} is invalid TOML: Codex won't start (${bad})`, fix: `fix the syntax error (${bad}), then run ${fixSetup}${prev && existsSync(prev) ? `. Last resort: ${prevNote(prev)} cp ${prev} ${cfg}` : ""}` });
    } else {
      const e = codexTomlEntry(cfg);
      entryCheck(cfg, e?.command, e?.args, e);
      if (e?.command) {
        let mode: unknown;
        let entry: any;
        try {
          entry = (parseToml(readFileSync(cfg, "utf-8")) as any).mcp_servers?.[e.name];
          mode = entry?.default_tools_approval_mode;
        } catch {
          mode = undefined;
        }
        if (entry && !codexHumanToolsAsk(entry)) out.push({ ok: false, what: `codex: bot-link's entry in ${cfg} lets a chat call ${CODEX_HUMAN_TOOLS.join(", ")} without asking its human (tools.<tool>.approval_mode isn't "prompt")`, fix: fixSetup });
        if (mode !== CODEX_TOOLS_APPROVAL) out.push({ ok: false, what: `codex: bot-link's entry in ${cfg} doesn't approve bot-link's own tools (default_tools_approval_mode = ${mode === undefined ? "not set" : JSON.stringify(mode)}), so a woken (non-interactive) Codex chat can't call reply, inbox or ask_human`, fix: fixSetup });
      }
      dupEntries(cfg, codexServers(cfg));
    }
    hooksCheck(join(codexHome(), "hooks.json"), false, codexHookEvents());
  } else {
    const obj = jsonOk(join(cursorDir(), "mcp.json"));
    if (obj !== null) {
      const n = cloudNamesIn(obj?.mcpServers)[0];
      entryCheck(join(cursorDir(), "mcp.json"), n ? obj.mcpServers[n].command : undefined, n ? obj.mcpServers[n].args : undefined, n ? obj.mcpServers[n] : undefined);
      dupEntries(join(cursorDir(), "mcp.json"), obj?.mcpServers);
    }
    hooksCheck(join(cursorDir(), "hooks.json"), true, cursorHookEvents()); // every event bot-link installs (sessionStart, stop)
  }
  return out;
}

/** Private-relay mode: the "botlink" entry `connect` registered with Claude Code (node .../dist/serve.js). */
export function checkPrivateClaude(): Check | null {
  let e: any;
  try {
    e = readJsonFile(claudeJsonPath()).obj?.mcpServers?.[SERVER_NAME];
  } catch {
    return null; // the cloud checks report the bad JSON
  }
  if (!e || isCloudEntry(e)) return null;
  const files = (Array.isArray(e.args) ? e.args : []).filter((a: unknown) => typeof a === "string" && /serve\.js$/.test(a));
  const missing = files.filter((f: string) => !existsSync(f));
  return missing.length
    ? { ok: false, what: `claude-code: the private-relay MCP server "${SERVER_NAME}" points to missing files: ${missing.join(", ")}`, fix: "rebuild that checkout (npm install), or run: botlink-mcp connect --app claude-code" }
    : { ok: true, what: `claude-code: private-relay MCP server "${SERVER_NAME}" configured (${claudeJsonPath()})` };
}

/** Does this hooks document hold one of bot-link's hooks (exact command match)? */
function hasOurHooks(h: string, obj: any, flat: boolean): boolean {
  const isOurs = OURS(h);
  for (const list of Object.values(obj?.hooks && typeof obj.hooks === "object" ? obj.hooks : {})) {
    if (!Array.isArray(list)) continue;
    for (const g of list as any[]) if ((flat ? [g?.command] : (g?.hooks || []).map((x: any) => x?.command)).some(isOurs)) return true;
  }
  return false;
}

export function configured(h: Exclude<HarnessKey, "mcp">): boolean {
  // our hooks left behind (the server entry was removed) still count: doctor must look at that harness
  const hooksFile = h === "claude-code" ? claudeSettingsPath() : h === "codex" ? join(codexHome(), "hooks.json") : h === "cursor" ? join(cursorDir(), "hooks.json") : null;
  try {
    if (hooksFile && existsSync(hooksFile)) {
      let mine: boolean;
      try {
        mine = hasOurHooks(h, readJsonFile(hooksFile).obj, h === "cursor");
      } catch {
        mine = holdsOurs(hooksFile, readFileSync(hooksFile, "utf-8")); // not valid JSON: look for our exact command strings in the text
      }
      if (mine) return true;
    }
  } catch {
    /* unreadable: the entry check below decides */
  }
  try {
    if (h === "claude-code") return cloudNamesIn(readJsonFile(claudeJsonPath()).obj?.mcpServers).length > 0;
    if (h === "codex") return !!codexTomlEntry(join(codexHome(), "config.toml"));
    if (h === "muse-code") return cloudNamesIn(readJsonFile(musePath()).obj?.mcp_servers).length > 0;
    if (JSON_HARNESS[h]) return cloudNamesIn(readJsonFile(JSON_HARNESS[h]!.path()).obj?.[JSON_HARNESS[h]!.key]).length > 0;
    return cloudNamesIn(readJsonFile(join(cursorDir(), "mcp.json")).obj?.mcpServers).length > 0;
  } catch {
    return false;
  }
}
