#!/usr/bin/env node
// Copy check: what a visitor or a model can read from bot-link must not claim what the code does not do.
//
//   node web/scripts/copy-check.mjs            exit 1 and list every problem (web/scripts/check.mjs runs this too)
//   node web/scripts/copy-check.mjs --root <dir>   check another copy of the repository (tests)
//
// It reads every page and script under web/public, the docs the server serves (docs/agents.md, docs/llms.txt,
// crypto/ENVELOPE.md as /envelope.md, api/openapi.yaml), client/README.md (it ships inside the client), a root
// README.md if there is one, SPEC.md (claims only), and the strings a chat or a person reads from the client
// (client/src: mcp.ts, core.ts, cli.ts, joinend.ts, tooold.ts, updatenote.ts, limits.ts, memberend.ts, hookmiss.ts). It fails on:
//   - claims nothing backs: "open source", a licence (while the repository is private), "guarantee", "every time",
//     "no exceptions", "SOC 2", "compliance", "tamper-proof", "complete record", "independent", "the safest"…
//   - sentences that were false on the live pages ("cannot add a chat", "public repository"…)
//   - sentences a feature made false (STALE: "agents cannot create rooms"…), in every file read here and every doc
//     under docs/
//   - a sentence that says the server, we, Cloudflare or PostHog "cannot" do something, unless it is on the reviewed
//     list below with the reason it is true
//   - a bracketed blank ("[operator legal name]", "[N] days", "[TO DECIDE: …]") or a draft marker in a published page,
//     and terms or privacy without one of the founder's legal facts (LEGAL_FACTS)
//   - the product words nobody should read (receipt, seen, answered, webhook, lease, delivery, envelope, epoch,
//     chatgpt) and internal names, in the text a person or a model reads
//   - the app support table (web/public/assets/app-support.json): a "tested" row without a date, an OS and
//     evidence, and any app named on the landing page that the table does not back
//   - with the paywall off (PAYWALL below, default): any word of plans, prices, credits, upgrades, billing or payments
//     in what a person or a model reads (pages, scripts, docs, the client's texts), terms and privacy without the
//     sentence that bot-link is free, and paid wording under web/paywall/ that can no longer be merged. With it on: the
//     paid wording must be merged into its pages and the free sentence gone.
//
//   node web/scripts/copy-check.mjs --paywall on   check the build with the paywall on (after the merge)
//
// Every exception is listed here with its reason. Keep them few and exact; never loosen a pattern to pass a page.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { omitted } from "./export-omit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// The repository is public at REPO_URL (founder, 20 Nov 2026: "make the repo public"; Apache-2.0, see NOTICE). With
// REPO_PUBLIC on, pages may name the licence and the public repository, and must not say the code is not public; the
// landing page carries a typed link to REPO_URL. "Open source" stays banned (CLAIMS): say what NOTICE grants instead.
export const REPO_PUBLIC = true;
export const REPO_URL = "https://github.com/charles161/botlink";

// The paywall: the server's BOTLINK_PAYWALL (on | off, default off). Off: bot-link is free and nothing a person or a
// model reads mentions plans, prices, credits, upgrades, billing or payments (founder, 16 Nov 2026: "we are gonna
// release without a paywall"). Turn it on only together with the server flag, after the merge steps at the top of
// each file in web/paywall/ (copy-check --paywall on says what is missing).
export const PAYWALL = false;
// Whole words; Pro and Team only with their capital (a professional team is fine). "Subscription" alone is MCP's and
// bot-link Events' own word (events/subscribe, subscriptions/listen, X-MCP-Subscription-Id): only the phrases that are
// about paying count. A currency sign before a number is a price, except an SQL placeholder ($1 to $9 escaped as \$1,
// inside a code span, or followed by a comma, a closing bracket or ::).
const PAID = [/\b(plans?|pricing|prices?|credits?|upgrade[sd]?|billing|payments?|per month)\b/i, /\b(Pro|Team)\b/,
  /\b(paid subscriptions?|subscription (plans?|fees?|prices?|tiers?|renews?|renewals?|charges?|costs?)|your subscriptions?|(monthly|yearly|annual) subscriptions?|subscribe to (Pro|Team|a plan|bot-link))\b/i];
const MONEY = /[$€£₹¥]\s?\d+/g;
const inCode = (s, i) => (s.slice(0, i).match(/`/g) || []).length % 2 === 1;
const placeholder = (s, m) => /^\$[1-9]$/.test(m[0]) && (s[m.index - 1] === "\\" || inCode(s, m.index) || /^\s*([,)]|::)/.test(s.slice(m.index + m[0].length)));
const paidWord = (s) => {
  for (const re of PAID) { const m = re.exec(s); if (m) return m[0]; }
  for (const m of s.matchAll(MONEY)) if (!placeholder(s, m)) return m[0];
  return null;
};
// The one sentence terms and privacy carry while the paywall is off.
export const FREE_SENTENCE = "bot-link is free.";
const FREE_PAGES = ["web/public/terms.html", "web/public/privacy.html"];
// The paid wording of the pages, kept for the build with the paywall on (not served: web/embed.go embeds web/public
// only). Each file holds pairs <template data-off>…</template><template data-on>…</template>: the exact HTML on the page
// while off, and the paid HTML that replaces it. Off: every off text must be on its page, so the merge still applies.
export const PAID_WORDING = {
  "web/paywall/terms-paid.html": "web/public/terms.html",
  "web/paywall/privacy-paid.html": "web/public/privacy.html",
  "web/paywall/security-paid.html": "web/public/security.html",
};
// The fair-use limits terms and privacy print (in both modes), each read from the code: [text on both pages, file,
// pattern that holds the number]. A number changed in the code fails here until both pages say the new one.
const FAIR_USE = [
  ["up to 64 MB per account", "server/internal/config/plans.go", /StorageCeilingMB <= 0 \{\s*return 64\b/],
  ["the whole server stores 8192 MB", "server/internal/config/plans.go", /StorageTotalMB <= 0 \{\s*return 8192\b/],
  ["up to 20 rooms you own at a time", "server/internal/appapi/rooms.go", /where owner_account_id = \$1 and deleted_at is null`[^\n]*\n[^\n]*\n[^\n]*\n\s*if n >= 20 \{/],
  ["up to 30 new rooms a day", "server/internal/ratelimit/ratelimit.go", /RoomsCreatedDay = Limit\{"room:a", 24 \* time\.Hour, 30,/],
  ["up to 20 chats", "server/internal/appapi/approve.go", /"room_full", "This room is full \(20 members\)\."/],
  ["up to 10 people", "server/internal/appapi/approve.go", /persons >= 10 \{\s*return httpx\.E\(409, "room_full"/],
  ["up to 30 messages a minute", "server/internal/ratelimit/ratelimit.go", /SendMember\s*= Limit\{"send:m", time\.Minute, 30,/],
  ["1000 a day from each chat", "server/internal/ratelimit/ratelimit.go", /SendMemberDay\s*= Limit\{"send:md", 24 \* time\.Hour, 1000,/],
  ["300 a minute in each room", "server/internal/ratelimit/ratelimit.go", /SendRoom\s*= Limit\{"send:r", time\.Minute, 300,/],
  ["up to 10 an hour", "server/internal/ratelimit/ratelimit.go", /SignupAddrHour = Limit\{"signup:ip", time\.Hour, 10,/],
  ["30 a day from one address", "server/internal/ratelimit/ratelimit.go", /SignupAddrDay\s*= Limit\{"signup:ipd", 24 \* time\.Hour, 30,/],
  ["1000 an hour", "server/internal/ratelimit/ratelimit.go", /SignupHour\s*= Limit\{"signup:all", time\.Hour, 1000,/],
  ["5000 a day in total", "server/internal/ratelimit/ratelimit.go", /SignupDay\s*= Limit\{"signup:alld", 24 \* time\.Hour, 5000,/],
  ["8400 waits open at once", "server/internal/config/config.go", /c\.MaxWaits = 8400\b/],
];
// Files the dashboard keeps for the build with the paywall on. Exempt from the paid words by name.
const PAID_ONLY = [
  ["web/public/pricing.html", "served or loaded only with the paywall on (the server answers 404 for it while off)"],
  ["web/public/assets/js/pricing.js", "served or loaded only with the paywall on (loaded by pricing.html only)"],
  ["web/public/assets/js/plans-util.js", "served or loaded only with the paywall on (imported by the paid views only)"],
  ["web/public/assets/js/views/usage.js", "served or loaded only with the paywall on (the dashboard routes to it only when /app/v1/me says paywall)"],
  ["web/public/assets/js/views/billing.js", "served or loaded only with the paywall on (the dashboard routes to it only when /app/v1/me says paywall)"],
  ["web/public/assets/js/paid-text.js", "shown only when GET /app/v1/me says paywall true (app.paywallOn() in app.js and account.js)"],
  ["web/public/assets/js/views/admin-plans.js", "served or loaded only with the paywall on (the dashboard routes to it only when /app/v1/me says paywall)"],
];
// Paid words that are not about paying, checked one by one. Each: [file, exact text in the sentence, why]. An entry
// that matches nothing fails, like CANNOT_OK.
const PLAN_LIMIT = "said only for a 409 plan_limit answer (client/src/limits.ts), which the server never sends while the paywall is off; kept for the build with it on";
const PAID_OK = [
  ["web/public/trust.html", "plans holds only the fixed rows the database starts with", "the name of a switched-off table, in the trust page's one neutral group of switched-off tables (generated by web/scripts/trust-facts.mjs); the one place those table names may stay"],
  ["web/public/trust.html", "Only they carry the fields limit and plan .", "the names of two analytics fields in the code, listed so the field list stays complete; only the switched-off events carry them (generated by trust-facts.mjs)"],
  ["crypto/ENVELOPE.md", "see PLAN.md", "PLAN.md, the repository's build plan document; not a paid plan"],
  ...[
    "your human's plan allows … of messages stored on bot-link",
    "or they can upgrade their plan.",
    "the most its plan allows.",
    "or upgrade the plan.",
    "the most their plan allows.",
    "they can delete a room or upgrade.",
    "over a limit of your human's plan.",
    "the dashboard shows the plan's limits.",
  ].map((x) => ["client/src/limits.ts", x, PLAN_LIMIT]),
];

// ------------------------------------------------------------------ the rules
const CLAIMS = [
  ["open source", /\bopen[- ]?source\b/i],
  ["a licence while the repository is private", REPO_PUBLIC ? null : /\b(apache|licen[cs]e[ds]?|MIT licen|GPL)\b/i],
  ["guarantee", /\bguarantee(s|d|ing)?\b/i],
  ["every time", /\bevery time\b/i],
  ["no exceptions", /\bno exceptions?\b/i],
  ["SOC 2", /\bSOC ?2\b/i],
  ["compliance", /\bcomplian(ce|t)\b/i],
  ["tamper-proof", /\btamper[- ]?(proof|evident)\b/i],
  ["complete record", /\bcomplete (audit )?record\b/i],
  ["independent", /\bindependent(ly)?\b/i],
  ["a superlative nobody measured", /\b(safest|most secure|unhackable|unbreakable|bullet-?proof|military[- ]grade|bank[- ]grade|100% (safe|secure|private))\b/i],
  // false on the live pages (prod-readiness review, 16 Nov 2026): never again
  ["the server cannot add a chat (it can, through the dashboard code it serves)", /cannot add a chat/i],
  ["the server cannot pretend to be a chat", /cannot pretend to be/i],
  ["a public repository (it is private)", REPO_PUBLIC ? null : /\bpublic (repository|repo)\b/i],
].filter(([, re]) => re);

// Statements a feature made false, checked in every file this script reads, every doc under docs/ (the protocol folder
// too) and SPEC.md. Each: [what it says, why it is false now and what to say instead, pattern].
export const STALE = [
  // rooms started by a chat (docs/protocol/room-drafts.md, 17 Nov 2026): a chat asks, a person confirms with the code
  // and a passkey, and their browser signs the genesis
  ["agents cannot create rooms", "a chat can ask for a room and a person confirms it (docs/protocol/room-drafts.md); say that instead", /\bagents? (cannot|can't|can not) (create|make|start) (a )?rooms?\b/i],
  ["agent-created rooms are not built", "a chat can ask for a room (docs/protocol/room-drafts.md); name what is still not built: a room made with no person confirming it", /\bagent-created rooms?\b/i],
  // the repository went public (REPO_PUBLIC): the pages said "not public", "not public yet", "publishing it is planned"
  ...(REPO_PUBLIC ? [["the code or the repository is not public", `the repository is public at ${REPO_URL}; say so and link it`,
    /\b(source( code)?|code|repository|repo)\b[^.]{0,40}?\b(is|are)\s+(not (yet )?(public|published|open)|private)\b|\bnot public yet\b|\bpublishing it is planned\b|\bclosed[- ]source\b/i]] : []),
];

// The "Self-host it" link is rendered from the server setting BOTLINK_SOURCE_URL (server/internal/pages/source.go): while
// the repository is private no source a visitor or a model reads may carry its address (in text or in an attribute).
const REPO_LINK = REPO_PUBLIC ? null : /github\.com\/charles161\/botlink(?:-v1)?\b/i;
const WORDS = /\b(receipts?|seen|answered|webhooks?|leases?|deliver(y|ies|ed|s)?|envelopes?|epochs?|chatgpt)\b/i;
// internal names, rot13 so this public file does not spell them
const INTERNAL = new RegExp(`\\b(${["pnera", "rqvgu", "snoyr", "yvtugfyvcf", "zbxh"].map((w) => w.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97))).join("|")})\\b`, "i");
const CANNOT = /\b(cannot|can't|can not|is unable to|has no way to)\b/i;
const WHO = /\b(server|servers|we|our|operator|cloudflare|posthog)\b/i;
const BLANK = /\[(?!\s?\]|x\])[^\[\]\n]{1,200}\]/gi; // [anything], not a checkbox

// Sentences of the form "the server / we cannot …" that were checked against the code. Each: [file, text it
// contains, why it is true]. The text must be found in that file, or the entry is stale and fails.
const CANNOT_OK = [
  ["README.md", "Its signing key (IndexedDB) cannot be exported", "the dashboard makes its device key with WebCrypto extractable false (web/public/assets/js/crypto.js generateKey(..., false, ...)); the diagram block from docs/architecture/README-embed.md"],
  ["web/public/privacy.html", "we cannot read the messages your chats send each other", "messages are sealed on the sender's machine per recipient (client/src/core.ts sealEnvelope); the server has no private key"],
  ["web/public/privacy.html", "so PostHog cannot turn it back into an id", "ids leave the server as HMAC-SHA256 with a key only the server has (server/internal/analytics/analytics.go)"],
  ["web/public/privacy.html", "It sees what our server sees, and cannot open sealed messages", "Cloudflare ends TLS and sees what the server sees; sealed copies need the recipient's private key"],
  ["web/public/terms.html", "Messages are sealed end to end and we cannot read them", "as above: sealed per recipient on the sender's machine"],
  ["web/public/security.html", "so it cannot be replayed", "nonce stored in request_nonces with on conflict do nothing (server/internal/agentapi/auth.go), 60 s window"],
  ["web/public/security.html", "The server cannot read messages", "sealed per recipient; the table says how it is enforced"],
  ["web/public/security.html", "Cloudflare can see what the server sees; it cannot open sealed messages either", "sealed copies need the recipient's private key, which stays on the chat's machine; the page says the dashboard code is a separate risk"],
  ["web/public/trust.html", "the sealed text it cannot", "generated by web/scripts/trust-facts.mjs from the migrations"],
  ["web/public/trust.html", "(the server cannot read it)", "handover_env is sealed by the chat to its own key (generated by trust-facts.mjs)"],
  ["web/public/assets/trust-facts.json", "the sealed text it cannot", "the facts behind trust.html, as above"],
  ["web/public/assets/trust-facts.json", "(the server cannot read it)", "the facts behind trust.html, as above"],
  ["web/public/trust.html", "Someone who controls our server, or what sits between it and you, cannot:", "each item under it is read from the code by trust-facts.mjs"],
  ["web/public/assets/js/views/account.js", "Messages are sealed on your chats' computers and the server can't open them", "the export lists sealed copies as counts and sizes only (server/internal/store/account.go export); each copy is sealed per recipient on the sender's machine and the server holds no private key"],
  ["web/public/assets/js/views/admin.js", "the server can't read it anyway", "operator page; sealed copies are opaque to the server"],
  ["docs/agents.md", "the bot-link server can't read them", "sealed per recipient"],
  ["docs/agents.md", "bot-link's server can't give it one", "check the sentence in docs/agents.md if this entry fails"],
  ["docs/agents.md", "from bot-link v3, with tools that look like these but can't reach", "about an old, separate server program, not a claim about ours"],
  ["docs/agents.md", "but it can't pass the wake test", "a schedule is not woken by the server; the wake test needs a chat that is woken"],
  // the client: sentences where the client says what it could not do, not what the server is unable to do
  ["client/src/core.ts", "bot-link can't reach its server right now", "the client could not connect (NetworkError); a statement about this call, not about the server's abilities"],
  ["client/src/core.ts", "The member list can't be verified: the server and the signed member list of", "the client's own check (core.send: the server's recipients differ from the signed member list); it says the list can't be verified"],
  ["client/src/core.ts", "This bot-link server is older than this client and can't move a member to another chat safely", "an older server rejects the session_id field (400): it lacks the move, which the client then refuses to do"],
];

// Other exact exceptions: [file, rule, text it contains, why].
const PUBLIC_README_SRC = "deploy/public-repo/files/README.md";
const sameFile = (f, rel) => f === rel || (f === "README.md" && rel === PUBLIC_README_SRC);
const ALLOW = [
  ["README.md", "word", "Events webhook (HMAC)", "the architecture diagram's arrow names the Standard Webhooks event format the server sends (server/internal/events); generated by docs/architecture/render.mjs"],
  ["README.md", "word", "an Events webhook with its subscription's secret (Standard Webhooks)", "the diagram caption names the published Standard Webhooks spec the events follow"],
  ["SPEC.md", "every time", "Turnstile token verified with Cloudflare `siteverify` every time", "a technical statement of what the server does on each approval (server/internal/humancheck), not a promise to people"],
  ["docs/agents.md", "word", "re-delivered: you may have handled this already", "the one flag SPEC section 1 mandates in tool output (client/src/render.ts REDELIVERED); the doc quotes it exactly"],
  ["docs/agents.md", "em dash", "re-delivered: you may have handled this already", "same quote: the client's mandated text has the dash"],
  ["docs/agents.md", "word", "each event is a Standard Webhooks message", "the name of the published spec the events follow (standardwebhooks.com); the header names are code"],
  ["client/src/core.ts", "word", "(r.deliveries", "not text: the scanner read the code between two string literals (a field name of the server's answer)"],
];

// The legal pages are final (founder, 16 Nov 2026): a bracketed blank on a published page is an error, and so is a
// draft marker. The markers removed that day, banned since: "Draft for review.", "Not yet reviewed by a lawyer.",
// "The parts marked TO DECIDE must be filled in before this page is final.", "Draft of 2026-11-16", and the trust
// page's "Draft." label.
const DRAFT = /\b(draft for review|not yet reviewed|to decide|draft of \d{4}-\d{2}-\d{2}|before this page is final)\b/i;
const DRAFT_LABEL = /(^|\s)Draft\.?$/; // the bare label, as the last word of a sentence ("… Terms Draft.")
// The founder's facts each legal page must state (16 Nov 2026); exact text, so a rewrite cannot drop one unseen.
export const LEGAL_FACTS = {
  "web/public/terms.html": ["Maria Charles MJ", "sole proprietor", "Bengaluru, Karnataka, India", "security@botlink.dev", "privacy@botlink.dev",
    "\"as is\"", "INR 1,000", "laws of India", "courts of Bengaluru", "14 days' notice"],
  "web/public/privacy.html": ["Maria Charles MJ", "sole proprietor", "Bengaluru, Karnataka, India", "privacy@botlink.dev", "security@botlink.dev",
    "our own server in India (Tamil Nadu), behind Cloudflare", "within 30 days", "Digital Personal Data Protection Act 2023"],
};

// App support. States, at most three: tested (a real run, with a date), setup (bot-link sets itself up there, not
// yet run by us), and nothing (not in the file, so not shown).
export const SUPPORT_FILE = "web/public/assets/app-support.json";
// Every app name that could appear on the landing page; any of them named there must be backed by the table.
const APP_NAMES = ["Claude Code", "Claude Desktop", "Codex", "Cursor", "Grok Bot", "OpenCode", "T3 Code", "Hermes", "VS Code", "Copilot", "Windsurf", "Gemini CLI", "Zed", "Antigravity", "Cline", "Continue", "Goose", "Aider"];
// The supported apps are the rows of the support table marked tested. Every other place that lists the apps names
// each of them, so a supported app is never missing from one (founder, 17 Nov 2026: Grok Bot was run with bot-link
// and left off the landing page). Each: [file, which part of it, how to read that part (null: not found)].
export const APP_LISTS = [
  ["web/public/index.html", "its meta description", (src) => /<meta name="description" content="([^"]*)"/i.exec(src)?.[1] ?? null],
  ["docs/agents.md", "its first paragraph", (src) => src.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("#")) ?? null],
  ["docs/llms.txt", "its summary line (the one that starts with >)", (src) => /^> (.+)$/m.exec(src)?.[1] ?? null],
];
// An app's own icon (web/public/assets/apps, SOURCES.md) reaches the landing and the dashboard through one table,
// LOGOS in app-logos.js, keyed like the support table.
export const APP_ICON_DIR = "web/public/assets/apps";
export const APP_LOGOS_JS = "web/public/assets/js/app-logos.js";

// ------------------------------------------------------------------ reading what people read
const ent = (s) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&rsquo;/g, "'").replace(/&amp;/g, "&");
const squash = (s) => s.replace(/\s+/g, " ").trim();

/** HTML: the visible text plus the text in meta descriptions, alt, title and aria-label. `plain` drops <code>. */
function htmlText(src) {
  const body = src.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  const attrs = [...body.matchAll(/\s(?:content|alt|title|aria-label)="([^"]*)"/gi)].map((m) => m[1]).filter((v) => / /.test(v));
  // a table cell, list item, paragraph or heading ends a sentence
  const text = (s) => ent(s.replace(/\s+/g, " ").replace(/<\/(p|li|td|th|tr|h[1-6]|summary|dt|dd|div|caption)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).split("\n").map(squash).filter(Boolean).join(" \n ");
  const all = text(body) + " \n " + attrs.map(ent).join(" \n ");
  // paid words: code too (a table or field name is read as much as a sentence)
  return { all, plain: text(body.replace(/<code\b[\s\S]*?<\/code>/gi, " ")) + " \n " + attrs.map(ent).join(" \n "), paid: all };
}
/** JS: claims are looked for in the code line by line (a regex literal with a quote in it would throw a literal
 * scanner off); words only in string and template literals that read as words. Comments are not read. */
function jsText(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const parts = [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]).filter((s) => / /.test(s) && /[a-z]{3}/i.test(s) && !/^[\s\w-]*\(/.test(s));
  const plain = parts.map((s) => squash(s.replace(/\$\{[^}]*\}/g, "…"))).join(" \n ");
  // paid words: the literals as a tokenizer reads them, so a variable named plan in the code is not read as text
  const paid = jsLiterals(src).filter((s) => / /.test(s) && /[a-z]{3}/i.test(s) && !/^[\s\w-]*\(/.test(s)).map(squash).join(" \n ");
  return { all: code.split("\n").map(squash).filter(Boolean).join(" \n "), plain, paid };
}
/** The text of every string and template literal in a script ("…" in place of each ${}), skipping comments and regex
 * literals. A small tokenizer: enough for the dashboard's plain JS and the client's TypeScript. */
export function jsLiterals(src) {
  const out = [];
  const tpl = []; // open templates: { depth, text } (depth: the brace depth their ${ opened at)
  let i = 0, depth = 0, prev = "", word = "";
  const n = src.length;
  const esc = (d) => (d === "n" || d === "t" ? " " : d ?? "");
  const readTemplate = (text) => {
    while (i < n) {
      const c = src[i];
      if (c === "\\") { text += esc(src[i + 1]); i += 2; continue; }
      if (c === "`") { i++; out.push(text); prev = "`"; return; }
      if (c === "$" && src[i + 1] === "{") { tpl.push({ depth, text: text + "…" }); depth++; i += 2; prev = "{"; return; }
      text += c; i++;
    }
    out.push(text);
  };
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, t = "";
      while (j < n && src[j] !== c && src[j] !== "\n") { if (src[j] === "\\") { t += esc(src[j + 1]); j += 2; } else t += src[j++]; }
      out.push(t); i = j + 1; prev = c; word = ""; continue;
    }
    if (c === "`") { i++; readTemplate(""); word = ""; continue; }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /^(return|typeof|case|of|in|yield|await|void|delete|throw|new|else|do)$/.test(word))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== "\n") { const d = src[j]; if (d === "\\") { j += 2; continue; } if (d === "[") cls = true; else if (d === "]") cls = false; else if (d === "/" && !cls) break; j++; }
      i = j + 1; while (i < n && /[a-z]/i.test(src[i])) i++;
      prev = "/"; word = ""; continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (tpl.length && tpl[tpl.length - 1].depth === depth) { const t = tpl.pop(); i++; readTemplate(t.text); word = ""; continue; }
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[\w$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(src[j])) j++; word = src.slice(i, j); prev = "a"; i = j; continue; }
    prev = c; word = ""; i++;
  }
  return out;
}
/** Markdown: prose without fenced or inline code; a link keeps its text. */
function mdText(src) {
  const noFence = src.replace(/```[\s\S]*?```/g, " ");
  const links = (s) => s.replace(/\]\(([^)]*)\)/g, "] ").replace(/\[([^\]]*)\]\s/g, "$1 ");
  // paid words: code and fenced blocks too (a field name or an example is read as much as a sentence)
  return { all: squash(links(noFence)), plain: squash(links(noFence.replace(/`[^`\n]*`/g, " ").replace(/<[^>\s]+>/g, " "))), paid: links(src).split("\n").map(squash).filter(Boolean).join(" \n ") };
}
// landing-claims.json: its sources are code patterns, not text; only the claim texts are read for paid words
function landingClaimTexts(d) {
  const claims = [d?.hero, ...(Array.isArray(d?.steps) ? d.steps : []), d?.note].filter(Boolean);
  const out = [];
  for (const c of claims) for (const k of ["title", "short", "text", "caveat"]) if (typeof c[k] === "string") out.push(c[k]);
  for (const c of claims) if (Array.isArray(c.limits)) out.push(...c.limits.filter((x) => typeof x === "string"));
  else if (typeof c.limits === "string") out.push(c.limits);
  return out.map(squash).join(" \n ");
}
function jsonText(src, rel) {
  const out = [];
  const walk = (v) => { if (typeof v === "string") out.push(v); else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x); };
  walk(JSON.parse(src));
  const t = out.filter((s) => / /.test(s)).map(squash).join(" \n ");
  return { all: t, plain: t, paid: rel === LANDING_CLAIMS ? landingClaimTexts(JSON.parse(src)) : t };
}
const sentences = (t) => t.split(/\s*\n\s*|(?<=[.!?])\s+/).filter(Boolean);

/** Every file to read, with how to read it and which rules apply. */
function sources(root) {
  const out = [];
  const add = (rel, kind, rules) => { if (existsSync(join(root, rel))) out.push({ rel, kind, rules }); };
  const walk = (dir) => {
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "fonts") walk(rel); continue; }
      const m = /\.(html|js|json)$/.exec(e.name);
      // landing-claims.json carries code patterns as its sources: landingProblems reads its texts for blanks and words
      if (m) add(rel, m[1], { claims: true, cannot: true, blanks: m[1] !== "js" && rel !== LANDING_CLAIMS, words: m[1] !== "json", names: true, paid: true });
    }
  };
  walk("web/public");
  add("docs/agents.md", "md", { claims: true, cannot: true, blanks: true, words: true, names: true, paid: true });
  add("docs/llms.txt", "md", { claims: true, cannot: true, blanks: true, words: true, names: true, paid: true });
  add("client/README.md", "md", { claims: true, cannot: true, blanks: true, words: true, names: true, paid: true });
  // the public repository's README: README.md in the export, its source deploy/public-repo/files/README.md here; the
  // exceptions below name it README.md in both trees (sameFile)
  add(existsSync(join(root, "README.md")) ? "README.md" : PUBLIC_README_SRC, "md", { claims: true, cannot: true, blanks: true, words: true, names: true, paid: true });
  // every other doc under docs/: not served today, but read as bot-link's own words (paid words only)
  const docs = (dir) => {
    if (!existsSync(join(root, dir))) return;
    for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) docs(rel);
      else if (/\.md$/.test(e.name) && rel !== "docs/agents.md") add(rel, "md", { paid: true });
    }
  };
  docs("docs");
  // the paid wording kept for the build with the paywall on: the same rules as the pages it goes into, except paid
  // words and blanks (both are checked on the page once it is merged)
  for (const f of Object.keys(PAID_WORDING)) add(f, "html", { claims: true, cannot: true, words: true, names: true });
  // what a chat or a person reads from the client: tool descriptions, tool output and command-line text (string
  // literals; comments are not read). The same rules as the pages, except bracketed blanks (a usage line's "[--x]").
  for (const f of ["mcp.ts", "core.ts", "cli.ts", "joinend.ts", "tooold.ts", "updatenote.ts", "limits.ts", "memberend.ts", "hookmiss.ts"]) add(`client/src/${f}`, "js", { claims: true, cannot: true, blanks: false, words: true, names: true, paid: true });
  // specs: their terms of art (envelope, epoch, lease) are the protocol's names, so only claims and names (and the
  // served wire format no paid words)
  add("crypto/ENVELOPE.md", "md", { claims: true, names: true, paid: true });
  add("api/openapi.yaml", "md", { claims: true, names: true });
  add("SPEC.md", "md", { claims: true, names: true });
  return out;
}

// ------------------------------------------------------------------ the check
export function copyProblems(root = resolve(HERE, "../.."), { paywall = PAYWALL } = {}) {
  const problems = [];
  const used = new Set();
  const paidOnly = new Set(PAID_ONLY.map(([f]) => f));
  const allowed = (rel, rule, s) => {
    const i = ALLOW.findIndex(([f, r, t]) => sameFile(f, rel) && r === rule && s.includes(t));
    if (i >= 0) used.add(`a${i}`);
    return i >= 0;
  };
  const blanksSeen = {};
  const texts = {};
  for (const { rel, kind, rules } of sources(root)) {
    const src = readFileSync(join(root, rel), "utf8");
    let t;
    try { t = { html: htmlText, js: jsText, md: mdText, json: (x) => jsonText(x, rel) }[kind](src); } catch (e) { problems.push(`${rel}: cannot read (${e.message})`); continue; }
    texts[rel] = t;
    if (rules.claims && REPO_LINK && REPO_LINK.test(src)) problems.push(`${rel}: has a hard-coded link to the repository; the "Self-host it" link comes only from BOTLINK_SOURCE_URL (set it on the server, do not type the address)`);
    const where = (s) => `${rel}: ${JSON.stringify(s.length > 140 ? s.slice(0, 137) + "…" : s)}`;
    for (const s of sentences(t.all)) {
      for (const [name, why, re] of STALE) if (re.test(s)) problems.push(`${where(s)} says ${name}, which is no longer true: ${why}`);
      if (rules.claims) for (const [name, re] of CLAIMS) if (re.test(s) && !allowed(rel, name, s)) problems.push(`${where(s)} claims ${name}`);
      if (rules.names && INTERNAL.test(s)) problems.push(`${where(s)} names an internal name`);
      if (rules.cannot && CANNOT.test(s) && WHO.test(s)) {
        const i = CANNOT_OK.findIndex(([f, x]) => sameFile(f, rel) && s.includes(x));
        if (i >= 0) used.add(`c${i}`);
        else problems.push(`${where(s)} says the server or we cannot do something: check it against the code, then add it to CANNOT_OK in web/scripts/copy-check.mjs with the reason`);
      }
    }
    // paid words, while the paywall is off; a paid-only file is not published then
    if (rules.paid && !paywall && !paidOnly.has(rel)) for (const s of sentences(t.paid)) {
      const w = paidWord(s);
      if (!w) continue;
      const i = PAID_OK.findIndex(([f, x]) => f === rel && s.includes(x));
      if (i >= 0) used.add(`p${i}`);
      else problems.push(`${where(s)} mentions the paywall ("${w}") while it is off: say it without plans, prices, credits, upgrades, billing or payments; if the word is not about paying, add the exact text to PAID_OK in web/scripts/copy-check.mjs with the reason`);
    }
    // blanks, outside code: a command's optional part ("[--days <n>]") is not a blank; a paid-only file has none
    // published while the paywall is off
    if (rules.blanks && (paywall || !paidOnly.has(rel))) for (const m of t.plain.matchAll(BLANK)) if (!/^\[-/.test(m[0])) (blanksSeen[rel] ||= []).push(m[0]);
    if (rules.words) for (const s of sentences(t.plain)) {
      const w = WORDS.exec(s);
      if (w && !allowed(rel, "word", s)) problems.push(`${where(s)} uses the word "${w[0]}" (COMMON product text rules)`);
      if (/—/.test(s) && (rel.startsWith("web/public/") || rel.startsWith("docs/")) && !allowed(rel, "em dash", s)) problems.push(`${where(s)} has an em dash`);
    }
  }
  // blanks and draft markers: none on a published page (a paid-only page is not published while the paywall is off)
  for (const [rel, list] of Object.entries(blanksSeen)) for (const b of list) problems.push(`${rel}: blank ${JSON.stringify(b)} in a published page: fill it (the legal pages are final; there is no list of allowed blanks)`);
  for (const [rel, t] of Object.entries(texts)) {
    if (!rel.startsWith("web/public/") || !/\.html$/.test(rel) || (!paywall && paidOnly.has(rel))) continue;
    for (const s of sentences(t.all)) if (DRAFT.test(s) || DRAFT_LABEL.test(s.trim())) problems.push(`${rel}: ${JSON.stringify(s.slice(0, 140))} is a draft marker: the page is final; remove it`);
  }
  for (const [rel, facts] of Object.entries(LEGAL_FACTS)) {
    if (!texts[rel]) continue;
    for (const f of facts) if (!texts[rel].all.includes(f)) problems.push(`${rel}: does not state ${JSON.stringify(f)} (the founder's legal facts, LEGAL_FACTS in web/scripts/copy-check.mjs)`);
  }
  CANNOT_OK.forEach(([f, x], i) => { if (!used.has(`c${i}`)) problems.push(`copy-check: CANNOT_OK entry for ${f} (${JSON.stringify(x)}) matches nothing; remove it`); });
  ALLOW.forEach(([f, r, x], i) => { if (!used.has(`a${i}`)) problems.push(`copy-check: ALLOW entry for ${f} ${r} (${JSON.stringify(x)}) matches nothing; remove it`); });
  if (!paywall) {
    PAID_OK.forEach(([f, x], i) => { if (!used.has(`p${i}`)) problems.push(`copy-check: PAID_OK entry for ${f} (${JSON.stringify(x)}) matches nothing; remove it`); });
    for (const [f] of PAID_ONLY) if (!existsSync(join(root, f))) problems.push(`copy-check: PAID_ONLY entry ${f} is not in the repository; remove it`);
  }
  problems.push(...paywallProblems(root, paywall, texts));
  problems.push(...supportProblems(root, texts));
  problems.push(...protocolIndexProblems(root));
  problems.push(...repoLinkProblems(root));
  return [...new Set(problems)];
}

/** With the repository public, the landing page links it: REPO_URL as a string in landing.js (a comment does not count). */
export function repoLinkProblems(root) {
  if (!REPO_PUBLIC) return [];
  const rel = "web/public/assets/js/views/landing.js";
  if (!existsSync(join(root, rel))) return [];
  return jsLiterals(readFileSync(join(root, rel), "utf8")).includes(REPO_URL) ? [] : [`${rel}: does not link the public repository ${REPO_URL}: put the typed link in the landing page copy (REPO_PUBLIC is on)`];
}

/** docs/protocol/README.md is the public specification's index: it links every other file in that folder. */
export function protocolIndexProblems(root) {
  const dir = join(root, "docs/protocol");
  if (!existsSync(join(dir, "README.md"))) return [];
  const index = readFileSync(join(dir, "README.md"), "utf8");
  return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md" && !index.includes(`](${f})`) && !index.includes(`](${f}#`))
    .map((f) => `docs/protocol/README.md: does not link ${f}; add it to the reading order (the index names every part of the specification)`);
}

/** The free sentence on terms and privacy, and the paid wording under web/paywall/ against its pages. */
export function paywallProblems(root, paywall = PAYWALL, texts = {}) {
  const out = [];
  const flat = (s) => s.replace(/\s+/g, " ").trim();
  for (const rel of FREE_PAGES) {
    if (!texts[rel]) { out.push(`${rel}: missing (it carries the free sentence while the paywall is off)`); continue; }
    const has = texts[rel].all.includes(FREE_SENTENCE);
    if (!paywall && !has) out.push(`${rel}: no free sentence (${JSON.stringify(FREE_SENTENCE)}): with the paywall off, say plainly that bot-link is free`);
    if (paywall && has) out.push(`${rel}: the free sentence (${JSON.stringify(FREE_SENTENCE)}) is still there while the paywall is on: merge the paid wording (web/paywall/)`);
  }
  // the fair-use numbers, against the code (only in a whole repository: the tests' small copies have no server)
  if (existsSync(join(root, "server"))) for (const [say, file, re] of FAIR_USE) {
    const code = existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "";
    if (!re.test(code)) out.push(`${file}: the fair-use number behind ${JSON.stringify(say)} is no longer found (${re}): read the code, then fix FAIR_USE in web/scripts/copy-check.mjs and both pages`);
    for (const rel of FREE_PAGES) if (texts[rel] && !texts[rel].all.includes(say)) out.push(`${rel}: does not say the fair-use limit ${JSON.stringify(say)} (the code's number; FAIR_USE in web/scripts/copy-check.mjs)`);
  }
  for (const [f, rel] of Object.entries(PAID_WORDING)) {
    if (!existsSync(join(root, f))) { out.push(`${f}: missing (the paid wording for ${rel}, kept for the build with the paywall on)`); continue; }
    const pairs = [...readFileSync(join(root, f), "utf8").replace(/<!--[\s\S]*?-->/g, "").matchAll(/<template data-off>([\s\S]*?)<\/template>\s*<template data-on>([\s\S]*?)<\/template>/g)].map((m) => [flat(m[1]), flat(m[2])]);
    if (!pairs.length) { out.push(`${f}: no paid wording (pairs of <template data-off> and <template data-on>)`); continue; }
    const pg = existsSync(join(root, rel)) ? flat(readFileSync(join(root, rel), "utf8")) : "";
    for (const [off, on] of pairs) {
      const cut = (x) => JSON.stringify(x.length > 80 ? x.slice(0, 77) + "…" : x);
      if (!off || !on) out.push(`${f}: a pair with an empty side (each needs the text it replaces and its paid wording)`);
      else if (!paywall && !pg.includes(off)) out.push(`${f}: off text ${cut(off)} is not in ${rel}: the page changed, so update the pair (the merge must still apply)`);
      else if (paywall && !pg.includes(on)) out.push(`${f}: on text ${cut(on)} is not in ${rel}: the paywall is on, so merge it (steps at the top of ${f})`);
    }
  }
  return out;
}

/** The app support table, and the landing page against it. */
export function supportProblems(root, texts = {}) {
  const out = [];
  const skipped = new Set();
  const p = join(root, SUPPORT_FILE);
  if (!existsSync(p)) return [`${SUPPORT_FILE}: missing (the landing page's support table reads it)`];
  let d;
  try { d = JSON.parse(readFileSync(p, "utf8")); } catch (e) { return [`${SUPPORT_FILE}: not JSON (${e.message})`]; }
  const rows = Array.isArray(d.apps) ? d.apps : [];
  if (!rows.length) out.push(`${SUPPORT_FILE}: no apps`);
  const today = new Date().toISOString().slice(0, 10);
  const names = new Map();
  for (const [i, r] of rows.entries()) {
    const at = `${SUPPORT_FILE}: apps[${i}] (${r?.name || "no name"})`;
    if (!r || typeof r.name !== "string" || !r.name) { out.push(`${at}: no name`); continue; }
    names.set(r.name, r.state);
    if (!["tested", "setup"].includes(r.state)) out.push(`${at}: state must be "tested" or "setup" (an app with no evidence is left out)`);
    if (typeof r.how !== "string" || !r.how.trim()) out.push(`${at}: no "how" (what was run, or what is set up)`);
    if (typeof r.evidence !== "string" || !r.evidence.trim()) out.push(`${at}: no evidence (a file in the repository or a report)`);
    if (r.state === "tested") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.last_run || "") || Number.isNaN(Date.parse(r.last_run))) out.push(`${at}: tested with no date of its last real run (last_run: YYYY-MM-DD)`);
      else if (r.last_run > today) out.push(`${at}: last_run ${r.last_run} is in the future`);
      if (typeof r.os !== "string" || !r.os.trim()) out.push(`${at}: tested with no OS`);
    } else if (r.last_run) out.push(`${at}: has a run date but is not marked tested`);
    const ev = typeof r.evidence === "string" ? r.evidence.split(/[\s,;]+/).filter((x) => /^[\w.-]+\/[\w./-]+$/.test(x) && !x.startsWith("the internal test notes")) : [];
    for (const f of ev) {
      const file = f.replace(/:\d+$/, "");
      if (existsSync(join(root, file))) continue;
      // the public export leaves evals/ out (.public-export, export-omit.mjs): there the evidence is named, not re-read
      if (omitted(root, file)) { skipped.add(`${file}: evidence not re-checked, left out of this public export (${omitted(root, file)})`); continue; }
      out.push(`${at}: evidence ${f} is not in the repository`);
    }
  }
  // every supported app: how its chats get a turn, its icon on the landing, and its name in every list of apps
  const reName = (n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const tested = rows.filter((r) => r && r.state === "tested" && typeof r.name === "string" && r.name);
  for (const r of tested) if (typeof r.turn !== "string" || !r.turn.trim()) out.push(`${SUPPORT_FILE}: ${r.name}: tested with no "turn" (how a chat in that app gets its turn, as its runs showed; the landing's table prints it)`);
  const logosSrc = existsSync(join(root, APP_LOGOS_JS)) ? readFileSync(join(root, APP_LOGOS_JS), "utf8") : "";
  for (const r of rows) {
    if (!r || typeof r.name !== "string" || !r.name) continue;
    if (typeof r.key !== "string" || !/^[a-z0-9-]+$/.test(r.key)) { out.push(`${SUPPORT_FILE}: ${r.name}: no key (lowercase letters, digits, dashes: the landing finds its icon by it)`); continue; }
    const file = ["svg", "png"].map((e) => `${r.key}.${e}`).find((f) => existsSync(join(root, APP_ICON_DIR, f)));
    if (!file) continue;
    const q = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const entry = new RegExp(`(?:"${q(r.key)}"|(?<![\\w-])${q(r.key)}(?![\\w-]))\\s*:\\s*\\{\\s*name:\\s*"${q(r.name)}",\\s*src:\\s*"/assets/apps/${q(file)}"`);
    if (!entry.test(logosSrc)) out.push(`${APP_LOGOS_JS}: LOGOS has no entry ${JSON.stringify(r.key)} with name ${JSON.stringify(r.name)} and src "/assets/apps/${file}": the support table would show ${r.name} on a plain tile instead of its icon`);
  }
  for (const [rel, part, read] of APP_LISTS) {
    if (!existsSync(join(root, rel))) { out.push(`${rel}: missing (${part} lists the supported apps)`); continue; }
    const text = read(readFileSync(join(root, rel), "utf8"));
    if (text === null) { out.push(`${rel}: ${part} is not there (it lists the supported apps)`); continue; }
    for (const r of tested) if (!reName(r.name).test(ent(text))) out.push(`${rel}: ${part} does not name ${r.name}, which ${SUPPORT_FILE} marks tested: every list of apps names every supported app`);
  }
  // the landing page names only apps the table backs
  const landing = texts["web/public/assets/js/views/landing.js"]?.all ?? "";
  for (const n of APP_NAMES) {
    if (!new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(landing)) continue;
    if (!names.has(n)) out.push(`web/public/assets/js/views/landing.js: names ${n}, which ${SUPPORT_FILE} does not list as tested or set up`);
  }
  for (const note of skipped) console.warn(`copy-check: ${note}`);
  return out;
}

// ------------------------------------------------------------------ the landing page's security steps
// The landing's "How it's secured" section renders web/public/assets/landing-claims.json, which
// web/scripts/trust-facts.mjs writes with the sources of every claim. This rule (web/scripts/check.mjs runs it) fails
// when a claim has no source, a source file is gone, its pattern no longer matches or its test is gone; when a claim
// uses a word the rules above ban, or says "cannot", "can't" or "never" in a sentence nobody checked against the code;
// and when landing.js writes a claim of its own instead of rendering the file.
export const LANDING_CLAIMS = "web/public/assets/landing-claims.json";
export const LANDING_JS = "web/public/assets/js/views/landing.js";
// The security section's code in landing.js sits between these two lines. A string literal in it may be a label of
// at most LANDING_MAX_WORDS words (class names, paths and ids are not words); anything longer is a claim and belongs
// in trust-facts.mjs (readLanding), with its sources.
export const LANDING_REGION = ["// landing-claims:start", "// landing-claims:end"];
export const LANDING_MAX_WORDS = 2;
// Each step reads in one plain sentence (its "short"), true without its caveat; the details open below it. The six
// titles and short sentences together stay a 30-second read: 190 words at about 380 words a minute.
export const LANDING_SHORT_MAX_WORDS = 22;
export const LANDING_READ_WORDS = 190;
// Outside that section, a string literal that talks security must be one of these exact texts, each with why it may
// stay inline. A new one fails: put the claim in the generated file, or review it here.
const SECURITY_TALK = /\b(seal\w*|sign(s|ed|ing|atures?)?|encrypt\w*|end to end|keys?|passkeys?|private|secur\w*|safe\w*|verif\w*|forg\w*|tamper\w*|approv\w*|revok\w*|cannot|can't|never|guarantee\w*)\b/i;
export const LANDING_INLINE_OK = [
  ["One safe room.", "the headline the owner chose (12 Nov 2026, tested in test_landing.py); the generated hero line and steps under it say what makes it so"],
  ["Bring a teammate's chats into your room. A person still approves every chat that joins.", "the join rule; the generated step human-approves backs it with its sources"],
  ["Match the code, approve", "a step title of the join flow; the generated step human-approves says what the approval needs"],
  ["The chat shows a 6-character code. You check that it matches in your browser and approve it.", "the join flow; the generated step human-approves reads the code length from server/internal/agentapi/join.go"],
  ["Waiting for a person to approve…", "a drawing of the chat's screen"],
  ["Approve", "a button in a drawing"],
  ["It takes a minute: start a room, paste the invite, approve the code.", "the join flow, no claim about security"],
];
// "cannot", "can't" or "never" in a claim: only these exact sentences, each with why it is true and a pattern that
// must still match in the named file.
export const LANDING_CANNOT_OK = [
  ["These keys are made in the browser and cannot be exported.", "a browser key is made with WebCrypto generateKey(..., extractable false, ...)",
    "web/public/assets/js/crypto.js", /crypto\.subtle\.generateKey\(\{ name: "Ed25519" \}, false, \["sign", "verify"\]\)/],
];
const LANDING_LIMITING = /\b(can|could|unless|may)\b/i;
const LANDING_NEGATIVE = /\b(cannot|can't|can not|never|impossible|no way to|unable to)\b/i;

const literals = (code) => [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
/** The words of a literal: template holes, class names, paths and ids taken out. */
const wordsOf = (s) => s.replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter((w) => w && !/[-_/.#:=$@]|\d/.test(w.replace(/[.,;:!?…)]+$/, "")) && /[A-Za-z]{2,}/.test(w));
const testPattern = (file, name) => {
  const q = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (file.endsWith(".go")) return new RegExp(`^func ${q}\\(t \\*testing\\.T\\)`, "m");
  if (file.endsWith(".py")) return new RegExp(`^def ${q}\\(`, "m");
  return new RegExp(`^test\\("${q}",`, "m");
};

export function landingProblems(root = resolve(HERE, "../..")) {
  const out = [];
  const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : null);
  const raw = read(LANDING_CLAIMS);
  if (raw === null) return [`${LANDING_CLAIMS}: missing. Run: node web/scripts/trust-facts.mjs`];
  let d;
  try { d = JSON.parse(raw); } catch (e) { return [`${LANDING_CLAIMS}: not JSON (${e.message})`]; }
  if (!d || typeof d !== "object" || Array.isArray(d)) return [`${LANDING_CLAIMS}: not an object with hero, section, steps and note`];
  const steps = Array.isArray(d.steps) ? d.steps : [];
  if (!steps.length) out.push(`${LANDING_CLAIMS}: no steps`);
  const claims = [["hero", d.hero], ...steps.map((s, i) => [s?.id || `steps[${i}]`, s]), ["note", d.note]];
  const ids = new Set();
  for (const [id, c] of claims) {
    const at = `${LANDING_CLAIMS}: claim "${id}"`;
    if (!c || typeof c.text !== "string" || !c.text.trim()) { out.push(`${at}: no text`); continue; }
    if (c !== d.hero && c !== d.note) {
      if (ids.has(id)) out.push(`${at}: the id is used twice`);
      ids.add(id);
      if (typeof c.title !== "string" || !c.title.trim()) out.push(`${at}: no title`);
      const n = typeof c.short === "string" ? c.short.trim().split(/\s+/).filter(Boolean).length : 0;
      if (!n) out.push(`${at}: no short sentence (one plain sentence of at most ${LANDING_SHORT_MAX_WORDS} words, true without its caveat)`);
      else if (n > LANDING_SHORT_MAX_WORDS) out.push(`${at}: its short sentence has ${n} words; at most ${LANDING_SHORT_MAX_WORDS}`);
      else if (sentences(c.short).length !== 1) out.push(`${at}: its short form is more than one sentence`);
      // A caveat that says what can, could or may still happen limits the claim: the short line must say so itself,
      // with the words the claim declares (security re-review, fourth pass, finding 3).
      const must = Array.isArray(c.short_must_say) ? c.short_must_say.filter((w) => typeof w === "string" && w.trim()) : [];
      const limiting = sentences(typeof c.caveat === "string" ? c.caveat : "").find((x) => LANDING_LIMITING.test(x));
      if (limiting && c.limits_in_short !== true) out.push(`${at}: its caveat says what can still happen (${JSON.stringify(limiting)}), so the short line must carry its limit: set limits_in_short: true and short_must_say to the words that say it (web/scripts/trust-facts.mjs readLanding)`);
      if (c.limits_in_short === true && !must.length) out.push(`${at}: limits_in_short is true but short_must_say names no words`);
      for (const w of must) if (typeof c.short === "string" && !c.short.includes(w)) out.push(`${at}: the short line lacks "${w}" (short_must_say), so it says more than is true without its caveat`);
    }
    if (!Array.isArray(c.sources) || !c.sources.length) { out.push(`${at}: no source (every claim names the code it rests on, in web/scripts/trust-facts.mjs readLanding)`); continue; }
    for (const s of c.sources) {
      const text = typeof s?.file === "string" ? read(s.file) : null;
      if (text === null) { out.push(`${at}: source file ${s?.file} does not exist`); continue; }
      if (typeof s.test === "string") {
        if (!testPattern(s.file, s.test).test(text)) out.push(`${at}: test "${s.test}" is no longer in ${s.file}`);
      } else if (typeof s.pattern === "string") {
        let re;
        try { re = new RegExp(s.pattern, s.flags || ""); } catch (e) { out.push(`${at}: bad pattern for ${s.file} (${e.message})`); continue; }
        if (!re.test(text)) out.push(`${at}: pattern no longer matches in ${s.file}: /${s.pattern}/`);
      } else out.push(`${at}: a source in ${s.file} has neither a pattern nor a test`);
    }
  }
  const read30 = steps.reduce((a, c) => a + [c?.title, c?.short].filter((x) => typeof x === "string").join(" ").trim().split(/\s+/).filter(Boolean).length, 0);
  if (read30 > LANDING_READ_WORDS) out.push(`${LANDING_CLAIMS}: the step titles and short sentences have ${read30} words together; a 30-second read is at most ${LANDING_READ_WORDS}`);
  // the words: every text a visitor reads from the file
  const texts = [];
  const skip = new Set(["sources", "about", "href", "id", "icon"]);
  const walk = (v) => { if (typeof v === "string") texts.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!skip.has(k)) walk(x); };
  walk(d);
  const usedCannot = new Set();
  for (const s of texts.flatMap(sentences)) {
    const where = `${LANDING_CLAIMS}: ${JSON.stringify(s.length > 120 ? s.slice(0, 117) + "…" : s)}`;
    for (const [name, re] of CLAIMS) if (re.test(s)) out.push(`${where} claims ${name}`);
    const w = WORDS.exec(s);
    if (w) out.push(`${where} uses the word "${w[0]}" (COMMON product text rules)`);
    if (INTERNAL.test(s)) out.push(`${where} names an internal name`);
    if (/—/.test(s)) out.push(`${where} has an em dash`);
    for (const m of s.matchAll(BLANK)) out.push(`${where} has a bracketed blank ${m[0]}`);
    if (LANDING_NEGATIVE.test(s)) {
      const i = LANDING_CANNOT_OK.findIndex(([t]) => t === s);
      if (i < 0) out.push(`${where} says something cannot or never happens: check it against the code, then add the exact sentence to LANDING_CANNOT_OK in web/scripts/copy-check.mjs with why it is true and a pattern`);
      else usedCannot.add(i);
    }
  }
  LANDING_CANNOT_OK.forEach(([t, , file, re], i) => {
    if (!usedCannot.has(i)) out.push(`copy-check: LANDING_CANNOT_OK entry ${JSON.stringify(t)} is in no claim; remove it`);
    const src = read(file);
    if (src === null || !re.test(src)) out.push(`copy-check: LANDING_CANNOT_OK entry ${JSON.stringify(t)}: its source no longer matches in ${file}`);
  });
  // landing.js renders the file and writes no claim of its own
  const js = read(LANDING_JS);
  if (js === null) return [...out, `${LANDING_JS}: missing`];
  const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/(?! landing-claims:).*$/gm, "$1");
  const a = code.indexOf(LANDING_REGION[0]), b = code.indexOf(LANDING_REGION[1]);
  if (a < 0 || b < a || code.indexOf(LANDING_REGION[0], a + 1) >= 0 || code.indexOf(LANDING_REGION[1], b + 1) >= 0) {
    out.push(`${LANDING_JS}: the security section must sit between one "${LANDING_REGION[0]}" line and one "${LANDING_REGION[1]}" line`);
    return out;
  }
  const url = `/${LANDING_CLAIMS.replace(/^web\/public\//, "")}`;
  if (!code.slice(a, b).includes(`"${url}"`)) out.push(`${LANDING_JS}: the security section does not load ${url}`);
  for (const s of literals(code.slice(a, b))) {
    const n = wordsOf(s).length;
    if (n > LANDING_MAX_WORDS) out.push(`${LANDING_JS}: the security section writes ${JSON.stringify(s.slice(0, 80))} (${n} words) itself; only labels of at most ${LANDING_MAX_WORDS} words may be inline. Put the text in web/scripts/trust-facts.mjs (readLanding) with its sources`);
  }
  const usedInline = new Set();
  for (const s of literals(code.slice(0, a) + "\n" + code.slice(b))) {
    if (!SECURITY_TALK.test(wordsOf(s).join(" "))) continue;
    const i = LANDING_INLINE_OK.findIndex(([x]) => x === squash(s));
    if (i >= 0) { usedInline.add(i); continue; }
    out.push(`${LANDING_JS}: ${JSON.stringify(s.slice(0, 100))} talks security outside the generated section. Say it in a claim in web/scripts/trust-facts.mjs (readLanding), with its sources, or review it into LANDING_INLINE_OK with why it may stay`);
  }
  LANDING_INLINE_OK.forEach(([x], i) => { if (!usedInline.has(i)) out.push(`copy-check: LANDING_INLINE_OK entry ${JSON.stringify(x)} is no longer in ${LANDING_JS}; remove it`); });
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ri = args.indexOf("--root");
  const root = resolve(ri >= 0 ? args[ri + 1] : resolve(HERE, "../.."));
  const pi = args.indexOf("--paywall");
  if (pi >= 0 && !["on", "off"].includes(args[pi + 1])) { console.error("--paywall takes on or off"); process.exit(2); }
  const p = [...copyProblems(root, { paywall: pi >= 0 ? args[pi + 1] === "on" : PAYWALL }), ...landingProblems(root)];
  if (p.length) { console.error(p.join("\n")); console.error(`\ncopy check: ${p.length} problem(s)`); process.exit(1); }
  console.log("copy check OK");
}
