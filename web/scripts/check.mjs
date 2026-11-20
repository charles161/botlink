// Static checks for web/public (the "build" is a check: the app ships as plain ES modules + CSS).
//   node web/scripts/check.mjs
// Fails on: inline event handlers or inline <script> bodies (CSP), external URLs other than
// Turnstile, innerHTML/eval use, forbidden UI words in source strings, missing imports, dashboard routes that the
// server's host table does not name (and the other way round).
import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const FORBIDDEN = /\b(receipts?|seen|answered|webhooks?|delivered|leases?|envelopes?|chatgpt)\b/i;
const problems = [];
const files = [];
async function walk(d) { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? await walk(p) : files.push(p); } }
await walk(PUBLIC);

for (const f of files) {
  const rel = relative(PUBLIC, f);
  if (!/\.(html|js|css|svg)$/.test(f)) continue;
  const src = await readFile(f, "utf8");
  if (/\son[a-z]+\s*=\s*["']/i.test(src) && /\.(html|svg)$/.test(f)) problems.push(`${rel}: inline event handler attribute`);
  if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(src)) problems.push(`${rel}: inline <script> body (CSP script-src 'self')`);
  if (/\.innerHTML\s*=|insertAdjacentHTML|\beval\(|new Function\(/.test(src)) problems.push(`${rel}: innerHTML/eval`);
  for (const m of src.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
    const u = m[0];
    if (/^https:\/\/challenges\.cloudflare\.com\//.test(u) || /^http:\/\/www\.w3\.org\//.test(u)) continue;
    // The client's download address, shown as text in the landing's one command (copied, never fetched by the page).
    if ((rel === "assets/js/views/landing.js" || rel === "trust.html") && /^https:\/\/api\.botlink\.dev\/dl\/[\w.-]+$/.test(u)) continue;
    // The public repository: a plain link in the copy (web/scripts/copy-check.mjs REPO_URL); it loads nothing. Not on
    // trust.html: there the repository appears only as BOTLINK_SOURCE_URL's footer link (server/internal/pages/source_test.go).
    if (["assets/js/views/landing.js", "security.html", "terms.html"].includes(rel) && u === "https://github.com/charles161/botlink") continue;
    // Link-preview meta (Open Graph / Twitter) must name absolute URLs; they load nothing in the page (CSP unaffected).
    // Allowed only in index.html <meta property="og:*"|name="twitter:*"> on the public site's origin (botlink.dev), for a file that ships.
    const og = rel === "index.html" && /^https:\/\/botlink\.dev\/([\w.-]*)$/.exec(u);
    if (og && /<meta (property="og:[\w:]+"|name="twitter:[\w:]+") content="$/.test(src.slice(Math.max(0, m.index - 60), m.index)) && src[m.index + u.length] === '"') {
      if (og[1]) { try { await stat(join(PUBLIC, og[1])); } catch { problems.push(`${rel}: ${u} names a file web/public doesn't ship`); } }
      continue;
    }
    problems.push(`${rel}: external URL ${u}`);
  }
  if (f.endsWith(".js")) {
    // UI strings only: string and template literals.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const s = m[2];
      if (FORBIDDEN.test(s) && !/^\/|\.md$|^[a-z_-]+$/.test(s)) problems.push(`${rel}: forbidden UI word in ${JSON.stringify(s.slice(0, 60))}`);
    }
    for (const m of src.matchAll(/(?:import\(|from\s+)["'](\.[^"']+)["']/g)) {
      try { await stat(resolve(dirname(f), m[1])); } catch { problems.push(`${rel}: missing import ${m[1]}`); }
    }
  }
}
// the trust page must say what the code says (web/scripts/trust-facts.mjs)
problems.push(...(await import("./trust-facts.mjs")).trustProblems());
// what a visitor or a model reads must not claim what the code does not do (web/scripts/copy-check.mjs)
problems.push(...(await import("./copy-check.mjs")).copyProblems());
// the dashboard's routes and the server's host table name the same pages (web/scripts/host-check.mjs)
problems.push(...(await (await import("./host-check.mjs")).hostProblems(PUBLIC)));
// the landing's security steps render only the generated claims, each with a source that still matches (copy-check.mjs)
problems.push(...(await import("./copy-check.mjs")).landingProblems());
// the README's architecture diagrams are drawn from data whose every box and arrow still matches the code
problems.push(...(await import("../../docs/architecture/render.mjs")).diagramProblems());
for (const w of (await import("../../docs/architecture/render.mjs")).diagramWarnings()) console.warn(w);
// builders' private notes at the repository root are never tracked (web/scripts/notes-check.mjs)
problems.push(...(await import("./notes-check.mjs")).notesProblems());
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`web/public OK (${files.length} files)`);
