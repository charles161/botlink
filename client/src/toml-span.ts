/**
 * Line spans of TOML tables, for bot-link's minimal edits of a Codex config.toml (J3-r3 F1: a header scanner that
 * missed `[[array.tables]]` and headers with comments deleted the user's hooks).
 *
 * The scanner knows enough TOML to never mistake data for a header: basic/literal strings (one-line and
 * multi-line), comments, and multi-line arrays / inline tables (bracket depth). Every line that starts a
 * statement with `[` is a table boundary: `[x]`, `[[x]]`, quoted keys, whitespace and a trailing comment are all
 * understood. A header it can't read is still a boundary (and never "ours").
 *
 * The span is only half the safety: every edit is then checked semantically with a real TOML parser
 * (verifyTomlEdit), and refused if anything but our own table changed.
 */
import { parse } from "smol-toml";

export interface TomlHeader {
  line: number;
  array: boolean;
  path: string[] | null; // null: unreadable header (a boundary that is never ours)
}

/** Parse a header line's key path: `[ a . "b.c" . 'd' ]  # x` -> ["a", "b.c", "d"]. */
export function parseHeader(line: string): { array: boolean; path: string[] | null } | null {
  let i = 0;
  const s = line;
  if (s.charCodeAt(0) === 0xfeff) i++; // the BOM of the file's first line
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  if (s[i] !== "[") return null;
  const array = s[i + 1] === "[";
  i += array ? 2 : 1;
  const path: string[] = [];
  const ws = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  };
  for (;;) {
    ws();
    let key = "";
    if (s[i] === '"') {
      i++;
      let ok = false;
      while (i < s.length) {
        const c = s[i];
        if (c === "\\") {
          const n = s[i + 1];
          const map: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
          if (n in map) {
            key += map[n];
            i += 2;
          } else if (n === "u" || n === "U") {
            const len = n === "u" ? 4 : 8;
            const hex = s.slice(i + 2, i + 2 + len);
            if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) return { array, path: null };
            key += String.fromCodePoint(parseInt(hex, 16));
            i += 2 + len;
          } else return { array, path: null };
        } else if (c === '"') {
          i++;
          ok = true;
          break;
        } else {
          key += c;
          i++;
        }
      }
      if (!ok) return { array, path: null };
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return { array, path: null };
      key = s.slice(i + 1, j);
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return { array, path: null };
      key = m[0];
      i += key.length;
    }
    path.push(key);
    ws();
    if (s[i] === ".") {
      i++;
      continue;
    }
    break;
  }
  if (array ? s.slice(i, i + 2) !== "]]" : s[i] !== "]") return { array, path: null };
  i += array ? 2 : 1;
  ws();
  if (i < s.length && s[i] !== "#" && s[i] !== "\r") return { array, path: null };
  return { array, path };
}

/** Every table header of the document, with its line index. Lines inside strings and multi-line values are skipped. */
export function tomlHeaders(text: string): TomlHeader[] {
  const lines = text.split("\n");
  const out: TomlHeader[] = [];
  let ml: '"""' | "'''" | null = null; // inside a multi-line string
  let depth = 0; // inside a multi-line array / inline table
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    let i = 0;
    if (!ml && depth === 0) {
      const h = /^\s*\[/.test(line) ? parseHeader(line) : null;
      if (h) {
        out.push({ line: n, array: h.array, path: h.path });
        continue; // a header line holds nothing else (a trailing comment at most)
      }
    }
    while (i < line.length) {
      if (ml) {
        const j = line.indexOf(ml, i);
        if (j < 0) {
          i = line.length;
          break;
        }
        i = j + 3;
        while (line[i] === ml[0]) i++; // up to two extra quotes belong to the content
        ml = null;
        continue;
      }
      const c = line[i];
      if (c === "#") break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        ml = line.slice(i, i + 3) as '"""' | "'''";
        i += 3;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (c === "'") {
        const j = line.indexOf("'", i + 1);
        i = j < 0 ? line.length : j + 1;
        continue;
      }
      if (c === "[" || c === "{") depth++;
      else if ((c === "]" || c === "}") && depth > 0) depth--;
      i++;
    }
  }
  return out;
}

const startsWith = (p: string[] | null, pre: string[]) => !!p && p.length >= pre.length && pre.every((k, i) => p[i] === k);

/**
 * The line ranges [start, end) of every table under `prefix` (the table itself, its sub-tables, and array tables
 * below it). A range runs from its header to the next header that isn't ours; comments and blank lines right above
 * that next header belong to it.
 */
export function tomlTableRanges(text: string, prefix: string[]): [number, number][] {
  const lines = text.split("\n");
  const hs = tomlHeaders(text);
  const out: [number, number][] = [];
  for (let k = 0; k < hs.length; k++) {
    if (!startsWith(hs[k].path, prefix)) continue;
    const start = hs[k].line;
    let j = k + 1;
    while (j < hs.length && startsWith(hs[j].path, prefix)) j++;
    let end = j < hs.length ? hs[j].line : lines.length;
    if (j < hs.length) while (end - 1 > start && /^\s*(#.*)?\r?$/.test(lines[end - 1])) end--;
    out.push([start, end]);
    k = j - 1;
  }
  return out;
}

/**
 * Remove the given ranges from the text (by line). A range that runs to the end of the file never takes the
 * file's final newline with it (J3 L1: the empty element after the last "\n" is not a line of the table).
 */
export function cutRanges(text: string, ranges: [number, number][]): string {
  const lines = text.split("\n");
  const drop = new Set<number>();
  const last = lines.length - 1;
  const finalNl = last > 0 && lines[last] === "";
  for (const [a, b0] of ranges) {
    const b = finalNl && b0 > last ? last : b0;
    for (let i = a; i < b; i++) drop.add(i);
    // the blank line that separated our table from the one above goes with it (no double blank at the seam)
    const blank = (i: number) => i >= 0 && i < lines.length && /^\s*\r?$/.test(lines[i]);
    if (blank(a - 1) && (b >= lines.length || blank(b)) && !drop.has(a - 1)) drop.add(a - 1);
  }
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

/** TOML integers are 64-bit: parsed as BigInt, so a valid i64 above 2^53 is accepted (J3 L2), never rounded. */
export function parseToml(text: string): Record<string, any> {
  // J3b: a UTF-8 byte-order mark at the very start is not content (Codex reads such a file fine); bot-link's edits
  // keep it where it is
  return parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, { integersAsBigInt: true }) as Record<string, any>;
}

/**
 * The last line of the key/value statement that starts on lines[start] (multi-line arrays, inline tables and
 * multi-line strings included), and the trailing comment on that last line, if any.
 */
export function statementEnd(lines: string[], start: number): { end: number; comment: string | null } {
  let depth = 0;
  let ml: '"""' | "'''" | null = null;
  for (let n = start; n < lines.length; n++) {
    const line = lines[n];
    let i = n === start ? line.indexOf("=") + 1 : 0;
    let comment: string | null = null;
    while (i < line.length) {
      if (ml) {
        const j = line.indexOf(ml, i);
        if (j < 0) {
          i = line.length;
          break;
        }
        i = j + 3;
        while (line[i] === ml[0]) i++;
        ml = null;
        continue;
      }
      const c = line[i];
      if (c === "#") {
        comment = line.slice(i);
        break;
      }
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        ml = line.slice(i, i + 3) as '"""' | "'''";
        i += 3;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (c === "'") {
        const j = line.indexOf("'", i + 1);
        i = j < 0 ? line.length : j + 1;
        continue;
      }
      if (c === "[" || c === "{") depth++;
      else if ((c === "]" || c === "}") && depth > 0) depth--;
      i++;
    }
    if (!ml && depth === 0) return { end: n, comment };
  }
  return { end: lines.length - 1, comment: null };
}

/** A TOML value in a comparable form (dates, BigInts, key order). */
export const canonToml = (v: any): any => canonJson(v);

const canonJson = (v: any): any =>
  v instanceof Date ? { $date: v.toISOString() } :
  Array.isArray(v) ? v.map(canonJson) :
  v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonJson(v[k])])) :
  typeof v === "bigint" ? { $int: String(v) } :
  v;

/** The document without mcp_servers.<names> (and without an mcp_servers table left empty by that). */
function without(doc: Record<string, any>, names: string[]): any {
  const d = JSON.parse(JSON.stringify(canonJson(doc)));
  if (d.mcp_servers && typeof d.mcp_servers === "object") {
    for (const n of names) delete d.mcp_servers[n];
    if (!Object.keys(d.mcp_servers).length) delete d.mcp_servers;
  }
  return d;
}

/**
 * The semantic guard: `after` minus our tables must equal `before` minus our tables, and our entry must be exactly
 * `want` (or gone, for a removal). -> null when the edit is safe, else why not.
 */
export function verifyTomlEdit(before: string | null, after: string, names: string[], want: { name: string; entry: Record<string, unknown> } | null): string | null {
  let b: Record<string, any>;
  let a: Record<string, any>;
  try {
    b = before === null || !before.trim() ? {} : parseToml(before);
  } catch (e) {
    return `the file isn't valid TOML (${(e as Error).message.split("\n")[0]}), so bot-link won't edit it`;
  }
  try {
    a = parseToml(after);
  } catch (e) {
    return `the edit would not be valid TOML (${(e as Error).message.split("\n")[0]})`;
  }
  const all = [...new Set([...names, ...(want ? [want.name] : [])])];
  if (JSON.stringify(without(b, all)) !== JSON.stringify(without(a, all))) return "the edit would change more than bot-link's own table";
  for (const n of all) {
    const got = a.mcp_servers?.[n];
    if (want && n === want.name) {
      if (JSON.stringify(canonJson(got)) !== JSON.stringify(canonJson(want.entry))) return `the edit would not leave [mcp_servers.${n}] as intended`;
    } else if (got !== undefined) return `[mcp_servers.${n}] is still there after removing it (is it defined as a dotted key or an inline table?)`;
  }
  return null;
}
