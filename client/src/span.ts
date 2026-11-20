/**
 * bot-link's own span in a config file, and the only removal bot-link ever makes: cut that span out of the CURRENT
 * bytes (J3 v4: restoring old bytes after a lossy "same content?" test overwrote user and app edits).
 *
 * The span is:
 *   - bot-link's cloud MCP server entries (by name + shape, see harnesses.isCloudEntry);
 *   - hook entries bot-link recognises as its own: the exact commands it wrote (current + ledger), or STRUCTURALLY
 *     `<node> <dir>/dist/cli.js hook <app> <event>` where that cli.js belongs to a botlink package, or is missing and
 *     sits where bot-link installs itself (~/.botlink-mcp/app, node_modules/botlink). A missing cli.js anywhere else
 *     (`/opt/x/dist/cli.js`) is a lookalike, never ours;
 *   - containers bot-link created (the ledger says so), once they are empty again.
 *
 * Every cut is checked as it is made: the bytes removed are the item itself plus whitespace and one comma, never a
 * comment or anything else. A cut that can't meet that throws SpanError and nothing is written.
 */
import * as jsonc from "jsonc-parser";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cutRanges, tomlTableRanges } from "./toml-span.js";

export type JPath = (string | number)[];

export class SpanError extends Error {}

const PARSE_OPTS: jsonc.ParseOptions = { allowTrailingComma: true, disallowComments: false };

// ---------------------------------------------------------------- hook ownership
/** The `hook <app> <event>` subcommands bot-link has ever installed. */
export const HOOK_ROLES = new Set(["session-start", "prompt", "stop"]);

/** Split a hook command the way sh would for the forms bot-link writes ("..." with \-escapes, '...', bare words). */
export function splitCmd(s: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === " " || s[i] === "\t") i++;
    if (i >= s.length) break;
    let tok = "";
    while (i < s.length && s[i] !== " " && s[i] !== "\t") {
      const c = s[i];
      if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === "\\" && i + 1 < s.length) {
            tok += s[i + 1];
            i += 2;
          } else tok += s[i++];
        }
        if (s[i] !== '"') return null;
        i++;
      } else if (c === "'") {
        const j = s.indexOf("'", i + 1);
        if (j < 0) return null;
        tok += s.slice(i + 1, j);
        i = j + 1;
      } else if (c === "\\" && i + 1 < s.length) {
        tok += s[i + 1];
        i += 2;
      } else tok += s[i++];
    }
    out.push(tok);
  }
  return out;
}

/** `<node> <abs>/dist/cli.js hook <app> <event>` -> its parts, or null for anything else. */
/** How bot-link quotes one word of a hook command (harnesses.ts hookCommand). */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:=@%+-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function hookShape(cmd: unknown): { node: string; cli: string; app: string; role: string } | null {
  if (typeof cmd !== "string") return null;
  const t = splitCmd(cmd);
  if (!t || t.length !== 5 || t[2] !== "hook") return null;
  if (!/^(node|nodejs)(\.exe)?$/i.test(basename(t[0]))) return null;
  if (!/^(\/|[A-Za-z]:[\\/])/.test(t[1]) || !/[\\/]dist[\\/]cli\.js$/.test(t[1])) return null;
  if (!HOOK_ROLES.has(t[4])) return null;
  // exactly the way bot-link writes a hook command (README: recognised by the exact string, never a pattern): no extra
  // spaces, tabs or other quoting; a hand-written variant is the user's, even when it runs bot-link's own cli
  if (cmd !== [shellQuote(t[0]), shellQuote(t[1]), "hook", t[3], t[4]].join(" ")) return null;
  return { node: t[0], cli: t[1], app: t[3], role: t[4] };
}

/** Does this cli.js belong to a bot-link v1 package (its ../package.json is "botlink" or "@botlink/cli" at version >= 1)?
 * botlink-mcp (also named "botlink", 0.x) is a different product: its entries and hooks are never ours. */
export function isBotlinkPackage(cli: string): boolean {
  try {
    const p = JSON.parse(readFileSync(join(dirname(dirname(cli)), "package.json"), "utf-8"));
    return !!p && (p.name === "botlink" || p.name === "@botlink/cli") && Number(String(p.version || "0").split(".")[0]) >= 1;
  } catch {
    return false;
  }
}

/** A cli.js path where bot-link installs itself (its self-install dir, or a botlink package in node_modules). */
export function botlinkInstallPath(cli: string, botlinkHome: string): boolean {
  const p = cli.replace(/\\/g, "/");
  if (p === join(botlinkHome, "app", "dist", "cli.js").replace(/\\/g, "/") || /\/\.botlink\/app\/dist\/cli\.js$/.test(p)) return true;
  // self-update installs (SPEC §7.6): ~/.botlink/client/current/dist/cli.js and ~/.botlink/client/<version>-<id>/dist/cli.js
  const cd = join(botlinkHome, "client").replace(/\\/g, "/");
  return (p.startsWith(cd + "/") && /^[^/]+\/dist\/cli\.js$/.test(p.slice(cd.length + 1))) || /\/\.botlink\/client\/[^/]+\/dist\/cli\.js$/.test(p);
}

export interface HookOwner {
  /** the exact commands bot-link writes now, plus every one it recorded in the ledger */
  exact: Set<string>;
  /** ~/.botlink-mcp (or BOTLINK_MCP_HOME) */
  home: string;
}

/** Is this hook command bot-link's own (for app h)? */
export function ownsHook(h: string, cmd: unknown, o: HookOwner): boolean {
  if (typeof cmd !== "string") return false;
  if (o.exact.has(cmd)) return true;
  const s = hookShape(cmd);
  if (!s || s.app !== h) return false;
  if (existsSync(s.cli)) return isBotlinkPackage(s.cli);
  return botlinkInstallPath(s.cli, o.home);
}

/** The role (session-start, wait, ...) of one of our hook commands; "?" when it can't be read. */
export function roleOf(cmd: unknown): string {
  return hookShape(cmd)?.role ?? (typeof cmd === "string" ? (cmd.match(/ hook \S+ (\S+)\s*$/) || [])[1] ?? "?" : "?");
}

// ---------------------------------------------------------------- the span of a JSON document
export type JsonKind =
  | { kind: "mcp"; key: string; isOurs: (name: string, entry: unknown) => boolean }
  | { kind: "nested"; isOurs: (cmd: unknown) => boolean }
  | { kind: "flat"; isOurs: (cmd: unknown) => boolean }
  /** strings in a list, `permissions.allow` by default (Cursor CLI's cli-config.json): bot-link's MCP permission; or
   *  `at` another list (Claude Code's project `enabledMcpjsonServers`) */
  | { kind: "perm"; isOurs: (rule: unknown) => boolean; at?: JPath }
  /** a file holding several of bot-link's kinds at once (Claude Code's project .claude/settings.local.json: hooks +
   *  enabledMcpjsonServers) */
  | { kind: "multi"; parts: JsonKind[] };

export interface SpanItem {
  /** the path to cut for this item */
  path: JPath;
  label: string;
  /** hooks: the event and the role (for claiming); mcp: the server name */
  ev?: string;
  role?: string;
  /** hooks: the hook object (merge target) */
  at?: JPath;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Every item of bot-link's span in `doc`, in document order. */
export function spanItems(doc: any, k: JsonKind): SpanItem[] {
  const out: SpanItem[] = [];
  if (!isObj(doc)) return out;
  if (k.kind === "mcp") {
    const s = doc[k.key];
    if (isObj(s)) for (const n of Object.keys(s)) if (k.isOurs(n, s[n])) out.push({ path: [k.key, n], label: `${k.key}.${n}`, ev: n });
    return out;
  }
  if (k.kind === "multi") return k.parts.flatMap((p) => spanItems(doc, p));
  if (k.kind === "perm") {
    const at = k.at ?? ["permissions", "allow"];
    const allow = getAt(doc, at);
    if (Array.isArray(allow)) allow.forEach((r: unknown, i: number) => {
      if (k.isOurs(r)) out.push({ path: [...at, i], label: `${at.join(".")} ${String(r)}`, ev: String(r) });
    });
    return out;
  }
  const hooks = doc.hooks;
  if (!isObj(hooks)) return out;
  for (const ev of Object.keys(hooks)) {
    const arr = hooks[ev];
    if (!Array.isArray(arr)) continue;
    arr.forEach((g: any, gi: number) => {
      if (k.kind === "flat") {
        if (g && k.isOurs(g.command)) out.push({ path: ["hooks", ev, gi], at: ["hooks", ev, gi], label: `hooks.${ev}`, ev, role: roleOf(g.command) });
        return;
      }
      if (!g || !Array.isArray(g.hooks)) return;
      g.hooks.forEach((x: any, hi: number) => {
        if (!x || !k.isOurs(x.command)) return;
        // the last hook of a group goes with its group (a group holding only bot-link's hook is bot-link's)
        const path = g.hooks.length === 1 ? ["hooks", ev, gi] : ["hooks", ev, gi, "hooks", hi];
        out.push({ path, at: ["hooks", ev, gi, "hooks", hi], label: `hooks.${ev}`, ev, role: roleOf(x.command) });
      });
    });
  }
  return out;
}

export function parseJsonStrict(text: string): any {
  if (!text.trim()) return {};
  const errors: jsonc.ParseError[] = [];
  const v = jsonc.parse(text, errors, PARSE_OPTS);
  if (errors.length) throw new SpanError("the file isn't valid JSON");
  return v;
}

function getAt(doc: any, p: JPath): any {
  let v = doc;
  for (const k of p) {
    if (v === null || typeof v !== "object") return undefined;
    v = v[k as any];
  }
  return v;
}

/** What lies between two offsets: comments? commas (their offsets)? anything else? */
function gap(text: string, from: number, to: number): { comments: boolean; commas: number[]; other: boolean } {
  const s = jsonc.createScanner(text.slice(from, to), false);
  const r = { comments: false, commas: [] as number[], other: false };
  for (let t = s.scan(); t !== jsonc.SyntaxKind.EOF; t = s.scan()) {
    if (t === jsonc.SyntaxKind.LineCommentTrivia || t === jsonc.SyntaxKind.BlockCommentTrivia) r.comments = true;
    else if (t === jsonc.SyntaxKind.CommaToken) r.commas.push(from + s.getTokenOffset());
    else if (t !== jsonc.SyntaxKind.Trivia && t !== jsonc.SyntaxKind.LineBreakTrivia) r.other = true;
  }
  return r;
}

/**
 * Cut the property/element at `path` out of `text`, with its separator. Never cuts a comment that sits between
 * items. `inner` is how the container looked inside before bot-link put its first item in (recorded at setup;
 * whitespace only), used when this was the container's last item. -> the new text.
 */
export function cutJson(text: string, path: JPath, inner?: string): string {
  const root = jsonc.parseTree(text, [], PARSE_OPTS);
  const node = root && jsonc.findNodeAtLocation(root, path);
  if (!node) throw new SpanError(`no ${JSON.stringify(path)} to remove`);
  const item = node.parent && node.parent.type === "property" ? node.parent : node;
  const c = item.parent;
  if (!c || !c.children) throw new SpanError("not inside an object or array");
  const kids = c.children;
  const i = kids.indexOf(item);
  const end = (n: jsonc.Node) => n.offset + n.length;
  const cuts: [number, number][] = [];
  let replaceInner: string | null = null;
  if (kids.length === 1) {
    const open = c.offset + 1;
    const close = end(c) - 1;
    const a = gap(text, open, item.offset);
    const b = gap(text, end(item), close);
    if (a.other || b.other || a.commas.length || b.commas.length > 1) throw new SpanError("unexpected text around the entry");
    if (!a.comments && !b.comments) {
      replaceInner = inner !== undefined && /^\s*$/.test(inner) ? inner : "";
      cuts.push([open, close]);
    } else {
      // comments inside stay: the entry goes with the whitespace in front of it (when that is all there is)
      cuts.push([a.comments ? item.offset : open, end(item)]);
      for (const k of b.commas) cuts.push([k, k + 1]);
    }
  } else if (i > 0) {
    const prev = kids[i - 1];
    const g = gap(text, end(prev), item.offset);
    if (g.other || g.commas.length !== 1) throw new SpanError("unexpected text before the entry");
    const k = g.commas[0];
    if (!g.comments) cuts.push([end(prev), end(item)]);
    else if (!gap(text, k + 1, item.offset).comments) cuts.push([k, end(item)]); // a comment before the comma belongs to prev: it stays
    else {
      // a comment after prev's comma (`"keep": 1, // note`, then ours: jsonedit insertChild) stays where it is: the
      // entry goes with the whitespace in front of it and its OWN comma (prev's comma stays); the last entry without
      // a comma of its own takes prev's comma instead (J3 v7 L2)
      let ws = item.offset;
      while (ws > 0 && /[ \t\r\n]/.test(text[ws - 1])) ws--;
      const nextStart = i === kids.length - 1 ? end(c) - 1 : kids[i + 1].offset;
      const after = gap(text, end(item), nextStart);
      if (after.other || after.commas.length > 1) throw new SpanError("unexpected text after the entry");
      if (after.commas.length === 1 && !gap(text, end(item), after.commas[0]).comments) cuts.push([ws, after.commas[0] + 1]);
      else if (i === kids.length - 1 && !after.commas.length && !after.comments) cuts.push([k, k + 1], [ws, end(item)]);
      else cuts.push([k, k + 1], [item.offset, end(item)]);
    }
  } else {
    const next = kids[1];
    const g = gap(text, end(item), next.offset);
    if (g.other || g.commas.length !== 1) throw new SpanError("unexpected text after the entry");
    const k = g.commas[0];
    if (!g.comments) cuts.push([item.offset, next.offset]);
    else if (!gap(text, end(item), k).comments) cuts.push([item.offset, k + 1]); // a comment after the comma belongs to next: it stays
    else cuts.push([item.offset, end(item)], [k, k + 1]);
  }
  // self-check: every cut is the item itself, or only whitespace and commas
  const itemText = text.slice(item.offset, end(item));
  for (const [a, b] of cuts) {
    const piece = text.slice(a, b);
    const rest = a <= item.offset && b >= end(item) ? piece.slice(0, item.offset - a) + piece.slice(item.offset - a + itemText.length) : piece;
    if (!/^[\s,]*$/.test(rest)) throw new SpanError("the cut would take more than bot-link's entry");
  }
  let out = text;
  for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + (replaceInner !== null && a === c.offset + 1 && b === end(c) - 1 ? replaceInner : "") + out.slice(b);
  if (out === text) throw new SpanError("nothing was cut");
  return out;
}

export interface SpanRecord {
  /** containers bot-link created (JSON paths, JSON-encoded) */
  created?: string[];
  /** a container bot-link put its first item into: how it looked inside before (whitespace) */
  inner?: Record<string, string>;
  /** TOML: bot-link appended its table to a file that didn't end with a newline (it added one) */
  tomlNoFinalNl?: boolean;
}

/** Is the container at p empty (and without comments inside)? */
function emptyContainer(text: string, p: JPath): boolean {
  const root = jsonc.parseTree(text, [], PARSE_OPTS);
  const n = root && jsonc.findNodeAtLocation(root, p);
  if (!n || (n.type !== "object" && n.type !== "array") || (n.children && n.children.length)) return false;
  const g = gap(text, n.offset + 1, n.offset + n.length - 1);
  return !g.comments && !g.other && !g.commas.length;
}

/**
 * The current text with bot-link's whole span cut out (plus the containers bot-link created, once empty).
 * `keep`: items to leave (setup keeps the ones it updates). -> the text and what was removed.
 */
export function stripJson(text: string, k: JsonKind, rec: SpanRecord = {}, keep?: (doc: any, items: SpanItem[]) => Set<number>): { text: string; removed: string[] } {
  let t = text;
  const removed: string[] = [];
  const innerFor = (p: JPath) => rec.inner?.[JSON.stringify(p.slice(0, -1))];
  for (let n = 0; ; n++) {
    if (n > 2000) throw new SpanError("too many entries");
    const doc = parseJsonStrict(t);
    const items = spanItems(doc, k);
    const kept = keep ? keep(doc, items) : new Set<number>();
    const idx = items.findIndex((_, i) => !kept.has(i));
    if (idx < 0) break;
    t = cutJson(t, items[idx].path, innerFor(items[idx].path));
    removed.push(items[idx].label);
  }
  if (keep) return { text: t, removed };
  const created = (rec.created || []).map((s) => JSON.parse(s) as JPath).filter((p) => !(p.length === 1 && p[0] === "version"));
  created.sort((a, b) => b.length - a.length);
  for (const p of created) {
    if (getAt(parseJsonStrict(t), p) === undefined || !emptyContainer(t, p)) continue;
    t = cutJson(t, p, innerFor(p));
  }
  // Cursor's "version": 1, when bot-link added it: it goes, unless hooks someone added into a "hooks" bot-link created need it
  if ((rec.created || []).includes(JSON.stringify(["version"]))) {
    const doc = parseJsonStrict(t);
    const ourHooks = (rec.created || []).includes(JSON.stringify(["hooks"]));
    if (isObj(doc) && doc.version === 1 && (doc.hooks === undefined || !ourHooks)) t = cutJson(t, ["version"], innerFor(["version"]));
  }
  return { text: t, removed };
}

/** The empty skeletons a file bot-link created may be left as (deleted only when it is exactly one of these). */
export const SKELETONS = new Set(["", "\n", "{}", "{}\n", "{}\r\n"]);

// ---------------------------------------------------------------- TOML
/** The text with bot-link's [mcp_servers.<name>] tables (and their sub-tables) cut out, by line. */
export function stripToml(text: string, names: string[], rec: SpanRecord = {}): string {
  const ranges = names.flatMap((n) => tomlTableRanges(text, ["mcp_servers", n]));
  if (!ranges.length) return text;
  const lines = text.split("\n");
  const atEof = ranges.some(([, b]) => b >= lines.length);
  const cut = cutRanges(text, ranges);
  // the newline bot-link added after a last line that had none goes again
  const out = atEof && rec.tomlNoFinalNl ? cut.replace(/\r?\n$/, "") : cut;
  // self-check: only whole lines went, and every one was inside our tables or a blank line
  const keptLines = cut.split("\n");
  let j = 0;
  const inOurs = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  for (let i = 0; i < lines.length; i++) {
    if (j < keptLines.length && lines[i] === keptLines[j]) {
      j++;
      continue;
    }
    if (!inOurs(i) && !/^\s*\r?$/.test(lines[i])) throw new SpanError("the cut would take more than bot-link's table");
  }
  if (j !== keptLines.length) throw new SpanError("the cut would change a line it keeps");
  return out;
}

/** The inside of the container at p (between its brackets), exactly as written. */
export function innerOf(text: string, p: JPath): string {
  const root = jsonc.parseTree(text, [], PARSE_OPTS);
  const n = root && (p.length ? jsonc.findNodeAtLocation(root, p) : root);
  return n ? text.slice(n.offset + 1, n.offset + n.length - 1) : "";
}

export { getAt };

/** Set the value at path p in doc (every parent exists). */
export function setAt(doc: any, p: JPath, v: unknown) {
  let o = doc;
  for (const k of p.slice(0, -1)) o = o[k as any];
  o[p[p.length - 1] as any] = v;
}
