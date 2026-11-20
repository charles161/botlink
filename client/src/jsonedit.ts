/**
 * Minimal-diff edits of JSON / JSONC config files (J3: a dotfiles repo must see only bot-link's lines change).
 *
 * applyJsonChange(text, before, after) turns the document `before` (parsed from `text`) into `after` by editing
 * ONLY the places that differ: a property or array element we add is inserted next to its siblings in the
 * file's own style (pretty with the file's indent, or compact on a one-line object/array), one we remove is cut
 * out together with its separator. Everything else (comments, trailing commas, inline arrays, key order, tabs,
 * CRLF, the trailing newline) keeps its exact bytes, so removing what we added gives back the original file.
 */
import * as jsonc from "jsonc-parser";

type Path = (string | number)[];

const PARSE_OPTS: jsonc.ParseOptions = { allowTrailingComma: true, disallowComments: false };

/** Parse JSON or JSONC. -> {obj, error}: error is a sentence with line and column, or null. */
export function parseJsonc(text: string): { obj: any; error: string | null } {
  const errors: jsonc.ParseError[] = [];
  const obj = jsonc.parse(text, errors, PARSE_OPTS);
  if (!errors.length) return { obj, error: null };
  const e = errors[0];
  const before = text.slice(0, e.offset).split("\n");
  return { obj, error: `${jsonc.printParseErrorCode(e.error)} at line ${before.length}, column ${before[before.length - 1].length + 1}` };
}

/** Does the text have // or /* comments (as tokens, not inside strings)? */
export function hasComments(text: string): boolean {
  const s = jsonc.createScanner(text, false);
  for (let t = s.scan(); t !== jsonc.SyntaxKind.EOF; t = s.scan()) {
    if (t === jsonc.SyntaxKind.LineCommentTrivia || t === jsonc.SyntaxKind.BlockCommentTrivia) return true;
  }
  return false;
}

/** The token stream without whitespace (comments kept): equal means "same content, layout aside". */
export function tokenCanon(text: string): string {
  const s = jsonc.createScanner(text, false);
  const out: string[] = [];
  for (let t = s.scan(); t !== jsonc.SyntaxKind.EOF; t = s.scan()) {
    if (t === jsonc.SyntaxKind.Trivia || t === jsonc.SyntaxKind.LineBreakTrivia) continue;
    if (t === jsonc.SyntaxKind.CommaToken) continue; // a trailing comma is layout
    out.push(s.getTokenValue());
  }
  return out.join("\u0000");
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function indentUnit(text: string): string {
  const m = text.match(/^[ \t]+(?=\S)/m);
  if (!m) return "  ";
  return m[0].includes("\t") ? "\t" : m[0];
}

function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const m = text.slice(start, offset).match(/^[ \t]*/);
  return m ? m[0] : "";
}

function oneLine(text: string, node: jsonc.Node): boolean {
  return !text.slice(node.offset, node.offset + node.length).includes("\n");
}

function multiLineFile(text: string): boolean {
  return text.trim().includes("\n");
}

function pretty(value: unknown, unit: string, base: string, eol: string): string {
  return JSON.stringify(value, null, unit).split("\n").join(eol + base);
}

function splice(text: string, from: number, to: number, ins: string): string {
  return text.slice(0, from) + ins + text.slice(to);
}

/** ", " or "," (how this one-line container separates its children). */
function sepOf(text: string, kids: jsonc.Node[]): string {
  if (kids.length < 2) return text.match(/,\s/) && !multiLineFile(text) ? ", " : ",";
  const between = text.slice(kids[0].offset + kids[0].length, kids[1].offset);
  return /,\s/.test(between) ? ", " : ",";
}

function colonOf(text: string, props: jsonc.Node[]): string {
  const p = props.find((x) => x.children && x.children.length === 2);
  if (!p) return multiLineFile(text) ? ": " : ":";
  const [k, v] = p.children!;
  return /:\s/.test(text.slice(k.offset + k.length, v.offset)) ? ": " : ":";
}

function tree(text: string): jsonc.Node {
  const root = jsonc.parseTree(text, [], PARSE_OPTS);
  if (!root) throw new Error("not a JSON document");
  return root;
}

function nodeAt(text: string, path: Path): jsonc.Node {
  const n = path.length ? jsonc.findNodeAtLocation(tree(text), path) : tree(text);
  if (!n) throw new Error(`no node at ${JSON.stringify(path)}`);
  return n;
}

/** Insert `child` into container node `c` (object: [key, value]; array: value at index). */
function insertChild(text: string, c: jsonc.Node, child: { key?: string; value: unknown; index?: number }): string {
  const eol = eolOf(text);
  const unit = indentUnit(text);
  const kids = c.type === "object" ? c.children || [] : c.children || [];
  const isObj = c.type === "object";
  const colon = isObj ? colonOf(text, kids) : "";
  const head = isObj ? `${JSON.stringify(child.key)}${colon}` : "";
  if (!kids.length) {
    const open = c.offset + 1;
    const close = c.offset + c.length - 1;
    if (hasComments(text.slice(open, close))) {
      // a comment inside the empty container stays exactly where it is: the entry goes in front of it
      if (!multiLineFile(text)) return splice(text, open, open, head + JSON.stringify(child.value));
      const base = lineIndent(text, c.offset);
      return splice(text, open, open, eol + base + unit + head + pretty(child.value, unit, base + unit, eol));
    }
    if (!multiLineFile(text)) {
      return splice(text, open, close, head + JSON.stringify(child.value));
    }
    const base = lineIndent(text, c.offset);
    return splice(text, open, close, eol + base + unit + head + pretty(child.value, unit, base + unit, eol) + eol + base);
  }
  const compact = oneLine(text, c);
  const at = !isObj && child.index !== undefined && child.index < kids.length ? kids[child.index] : null;
  if (at) {
    // before an existing element
    if (compact) return splice(text, at.offset, at.offset, JSON.stringify(child.value) + sepOf(text, kids));
    const base = lineIndent(text, at.offset);
    return splice(text, at.offset, at.offset, pretty(child.value, unit, base, eol) + "," + eol + base);
  }
  const last = kids[kids.length - 1];
  const end = last.offset + last.length;
  if (compact) return splice(text, end, end, sepOf(text, kids) + head + JSON.stringify(child.value));
  const base = lineIndent(text, last.offset);
  // J3 v7 L2: a comment on the last entry's line (`"keep": {...}, // note`) stays on that line: the new entry goes on
  // the next line (with a trailing comma when the file had one there), so span.ts cutJson gives the exact bytes back
  const tail = lineTail(text, end, c.offset + c.length - 1);
  if (tail) {
    const ins = eol + base + head + pretty(child.value, unit, base, eol) + (tail.comma ? "," : "");
    const t = splice(text, tail.lineEnd, tail.lineEnd, ins);
    return tail.comma ? t : splice(t, end, end, ",");
  }
  return splice(text, end, end, "," + eol + base + head + pretty(child.value, unit, base, eol));
}

/**
 * What follows the last entry on its own line, when that is a comment (with or without a trailing comma before it)
 * and the container closes on a later line with nothing else in between. -> where the line ends, and whether the
 * trailing comma is there; null otherwise.
 */
function lineTail(text: string, end: number, close: number): { lineEnd: number; comma: boolean } | null {
  const nl = text.indexOf("\n", end);
  if (nl < 0 || nl >= close) return null;
  const lineEnd = text[nl - 1] === "\r" ? nl - 1 : nl;
  const s = jsonc.createScanner(text.slice(end, lineEnd), false);
  let comment = false;
  let comma = false;
  for (let t = s.scan(); t !== jsonc.SyntaxKind.EOF; t = s.scan()) {
    if (s.getTokenError() !== jsonc.ScanError.None) return null;
    if (t === jsonc.SyntaxKind.LineCommentTrivia || t === jsonc.SyntaxKind.BlockCommentTrivia) comment = true;
    else if (t === jsonc.SyntaxKind.CommaToken && !comment && !comma) comma = true;
    else if (t !== jsonc.SyntaxKind.Trivia) return null;
  }
  if (!comment) return null;
  // between that line and the closing bracket: only whitespace
  return /^[\s]*$/.test(text.slice(nl, close)) ? { lineEnd, comma } : null;
}

/** Remove the property / element `n` (a property node or an array element node) with its separator. */
function removeChild(text: string, n: jsonc.Node): string {
  const c = n.parent!;
  const kids = c.children || [];
  const i = kids.indexOf(n);
  if (kids.length === 1) return splice(text, c.offset + 1, c.offset + c.length - 1, "");
  if (i > 0) {
    const prev = kids[i - 1];
    return splice(text, prev.offset + prev.length, n.offset + n.length, "");
  }
  return splice(text, n.offset, kids[1].offset, "");
}

function replaceNode(text: string, n: jsonc.Node, value: unknown): string {
  const v = oneLine(text, n) ? JSON.stringify(value) : pretty(value, indentUnit(text), lineIndent(text, n.offset), eolOf(text));
  return splice(text, n.offset, n.offset + n.length, v);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEq(a[k], b[k]));
  }
  return false;
}

/** Longest common subsequence of two arrays (deep equality): matched index pairs. */
function lcs(a: unknown[], b: unknown[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = deepEq(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (deepEq(a[i], b[j])) {
      out.push([i, j]);
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** Edit `text` (whose parsed value is `before`) so that it parses to `after`, touching only what differs. */
export function applyJsonChange(text: string, before: unknown, after: unknown): string {
  if (!text.trim()) return JSON.stringify(after, null, 2) + "\n";
  let t = text;
  const walk = (path: Path, a: unknown, b: unknown) => {
    if (deepEq(a, b)) return;
    if (isObj(a) && isObj(b)) {
      for (const k of Object.keys(a)) if (!Object.prototype.hasOwnProperty.call(b, k)) t = removeChild(t, nodeAt(t, [...path, k]).parent!);
      for (const k of Object.keys(b)) {
        if (Object.prototype.hasOwnProperty.call(a, k)) walk([...path, k], a[k], b[k]);
        else t = insertChild(t, nodeAt(t, path), { key: k, value: b[k] });
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length === b.length) {
        a.forEach((x, i) => walk([...path, i], x, b[i]));
        return;
      }
      const pairs = lcs(a, b);
      const keptA = new Set(pairs.map((p) => p[0]));
      const keptB = new Set(pairs.map((p) => p[1]));
      for (let i = a.length - 1; i >= 0; i--) if (!keptA.has(i)) t = removeChild(t, nodeAt(t, [...path, i]));
      for (let j = 0; j < b.length; j++) if (!keptB.has(j)) t = insertChild(t, nodeAt(t, path), { value: b[j], index: j });
      return;
    }
    t = replaceNode(t, nodeAt(t, path), b);
  };
  walk([], before, after);
  return t;
}
