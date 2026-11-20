// The copy check's rules, on a small made-up repository: each rule catches what it is for, and the exceptions are
// exact (a near miss still fails).
//   node --test web/test/copy_check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyProblems, FREE_SENTENCE, LEGAL_FACTS, PAID_WORDING, PAYWALL, REPO_PUBLIC, REPO_URL, SUPPORT_FILE, APP_LISTS } from "../scripts/copy-check.mjs";

const page = (body) => `<!doctype html><html><head><title>t</title></head><body><main>${body}</main></body></html>`;
const SUPPORT = { apps: [{ key: "claude-code", name: "Claude Code", state: "tested", last_run: "2026-11-12", os: "Linux", how: "a real run", turn: "Answers while idle.", evidence: "evals/RESULTS.md" }] };

/** The paid wording file of the paywall: one pair, the text on the page while off and its paid wording. */
const paid = (off, on) => `<!-- merge steps -->\n<template data-off>${off}</template>\n<template data-on>${on}</template>\n`;
const OFF_TEXT = { "web/public/terms.html": FREE_SENTENCE, "web/public/privacy.html": `${FREE_SENTENCE} Fair use.`, "web/public/security.html": "Storage counts." };
const ON_TEXT = { "web/public/terms.html": "Free while in beta.", "web/public/privacy.html": "Payment records are kept.", "web/public/security.html": "Payment records." };
/** A final legal page: the founder's facts for it, and a body. */
const legalPage = (rel, body, facts = LEGAL_FACTS[rel] || []) => page(`${body}${facts.map((f) => `<p>${f.replace(/"/g, "&quot;")}</p>`).join("")}`);

/** A repository with nothing wrong in it, plus the files given (path -> text, or null to leave one out). */
function repo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "copy-check-"));
  const legal = (rel) => legalPage(rel, OFF_TEXT[rel] ? `<p>${OFF_TEXT[rel]}</p>` : "");
  const base = {
    "web/public/index.html": page("<p>Rooms for your agent chats.</p>").replace("</head>", '<meta name="description" content="Rooms where your Claude Code chats work together."></head>'),
    "web/public/security.html": page(`<p>${OFF_TEXT["web/public/security.html"]}</p>`),
    ...Object.fromEntries(Object.keys(LEGAL_FACTS).map((rel) => [rel, legal(rel)])), // every legal page with its facts
    ...Object.fromEntries(Object.entries(PAID_WORDING).map(([f, rel]) => [f, paid(`<p>${OFF_TEXT[rel]}</p>`, `<p>${ON_TEXT[rel]}</p>`)])),
    "web/public/assets/js/views/landing.js": `export const T = "Claude Code chats talk in a room.";\nexport const S = h("a", { href: "${REPO_URL}" }, "the source");\n`,
    [SUPPORT_FILE]: JSON.stringify(SUPPORT),
    "evals/RESULTS.md": "results\n",
    "docs/agents.md": "# Agents\n\nChats in Claude Code work together. Read `inbox`.\n",
    "docs/llms.txt": "# bot-link\n\n> Rooms for AI chats across apps (Claude Code).\n",
    ...files,
  };
  for (const [rel, text] of Object.entries(base)) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
function problems(files, paywall = false) {
  const root = repo(files);
  try { return copyProblems(root, { paywall }); } finally { rmSync(root, { recursive: true, force: true }); }
}
const has = (ps, re) => assert.ok(ps.some((p) => re.test(p)), `expected a problem matching ${re}, got:\n${ps.join("\n")}`);

test("a clean repository passes (the exceptions that match nothing here are the only problems)", () => {
  const ps = problems().filter((p) => !/^copy-check: (CANNOT_OK|ALLOW|PAID_OK|PAID_ONLY) entry/.test(p));
  assert.deepEqual(ps, []);
});

test("claims nothing backs", () => {
  for (const [text, re] of [
    ["The client is open source.", /claims open source/],
    ["The client is open-source.", /claims open source/],
    ["Here is what bot-link guarantees.", /claims guarantee/],
    ["It asks you every time.", /claims every time/],
    ["No exceptions.", /claims no exceptions/],
    ["SOC 2 ready.", /claims SOC 2/],
    ["A tamper-proof log.", /claims tamper-proof/],
    ["The safest way to link agents.", /superlative/],
    ["The server cannot add a chat to a room.", /cannot add a chat/],
  ]) has(problems({ "web/public/security.html": page(`<p>${text}</p>`) }), re);
});

// While the repository is private (REPO_PUBLIC false) no page names a licence, a public repository or the repository's
// address: the "Self-host it" link comes only from the server setting BOTLINK_SOURCE_URL. The public export flips
// REPO_PUBLIC (deploy/public-repo/build-candidate.sh), and then these are allowed.
test("licence, public repository and a hard-coded repository link: banned while the repository is private", () => {
  for (const [text, re] of [
    ["Published under the Apache License 2.0.", /claims a licence/],
    ["Licence: Apache-2.0.", /claims a licence/],
    ["The specs are in a public repository.", /public repository/],
    ['<a href="https://github.com/charles161/botlink">Self-host it</a>', /hard-coded link to the repository/],
  ]) {
    const ps = problems({ "web/public/security.html": page(`<p>${text}</p>`) });
    if (REPO_PUBLIC) assert.ok(!ps.some((p) => re.test(p)), `REPO_PUBLIC is true: ${re} must not fire, got:\n${ps.join("\n")}`);
    else has(ps, re);
  }
});

// The repository is public (founder, 20 Nov 2026: "make the repo public"). Saying anywhere that the code or the
// repository is not public is now false, and the landing page carries a typed link to it.
test("the repository is public: REPO_PUBLIC is on and REPO_URL is its address", () => {
  assert.equal(REPO_PUBLIC, true);
  assert.equal(REPO_URL, "https://github.com/charles161/botlink");
});

test("with the repository public: a page or doc that says the code or the repository is not public fails", () => {
  for (const [rel, text] of [
    ["web/public/terms.html", page("<p>bot-link's source code is not public. The wire format is described here.</p>")],
    ["web/public/security.html", page("<p>The source code is not public.</p>")],
    ["web/public/trust.html", page("<p>The repository is not public yet.</p>")],
    ["web/public/trust.html", page("<ul><li>The client's source code is not public. Publishing it is planned.</li></ul>")],
    ["docs/agents.md", "# Agents\n\nThe repository is private for now.\n"],
    ["docs/protocol/wake.md", "# W\n\nThe code is closed source.\n"],
  ]) has(problems({ [rel]: text }), new RegExp(`${rel.replace(/[.]/g, "\\.")}.*says the code or the repository is not public, which is no longer true`));
  // true sentences about other things that are not public pass
  const ok = problems({ "web/public/security.html": page("<p>A room is not public: only its members read it. The private key is not in the repository.</p>") });
  assert.ok(!ok.some((p) => /no longer true/.test(p)), ok.join("\n"));
});

test("with the repository public: the landing page links it with its typed address", () => {
  has(problems({ "web/public/assets/js/views/landing.js": 'export const T = "Claude Code chats talk in a room.";\n' }), /landing\.js: does not link the public repository/);
  has(problems({ "web/public/assets/js/views/landing.js": 'export const T = "Claude Code chats talk in a room.";\n// https://github.com/charles161/botlink\n' }), /landing\.js: does not link the public repository/);
  assert.ok(!problems().some((p) => /does not link the public repository/.test(p)));
});

test("claims in landing.js are caught even after a regex literal with a quote in it", () => {
  const js = 'const re = /^[^\\s"\'<>]+$/;\nconst R = ["Anything risky waits for you. Every time, no exceptions."];\n';
  has(problems({ "web/public/assets/js/views/landing.js": js }), /claims every time/);
});

test("claims in a meta description and in the docs", () => {
  has(problems({ "web/public/index.html": page("").replace("</head>", '<meta name="description" content="The safest way to talk."></head>') }), /index\.html.*superlative/);
  has(problems({ "docs/agents.md": "bot-link guarantees it.\n" }), /agents\.md.*guarantee/);
});

test("statements a feature made false fail in SPEC, in every doc under docs/ and on the pages; the true ones pass", () => {
  has(problems({ "SPEC.md": "# Spec\n\nRooms per owner ≤ 20. **Agents cannot create rooms in v1.**\n" }), /SPEC\.md.*agents cannot create rooms, which is no longer true/);
  has(problems({ "docs/protocol/join-and-approval.md": "Agents cannot create rooms in this\nversion.\n" }), /join-and-approval\.md.*agents cannot create rooms/);
  has(problems({ "SPEC.md": "## 13. Not in v1\nattachments · agent-created rooms · room rename\n" }), /SPEC\.md.*agent-created rooms are not built/);
  has(problems({ "web/public/security.html": page("<p>An agent can't create a room.</p>") }), /security\.html.*agents cannot create rooms/);
  const ok = problems({ "docs/protocol/room-drafts.md": "A chat can ask for a new room. It cannot make one.\n", "SPEC.md": "# Spec\n\nA chat can ask for a room; a person confirms it.\n" });
  assert.ok(!ok.some((p) => /no longer true/.test(p)), ok.join("\n"));
});

test("the protocol index links every file in docs/protocol", () => {
  const files = { "docs/protocol/README.md": "# Protocol\n\n1. [envelope.md](envelope.md)\n2. [wake.md](wake.md#1-the-signal)\n", "docs/protocol/envelope.md": "# E\n", "docs/protocol/wake.md": "# W\n" };
  assert.ok(!problems(files).some((p) => /does not link/.test(p)));
  has(problems({ ...files, "docs/protocol/room-drafts.md": "# Rooms started by a chat\n" }), /README\.md: does not link room-drafts\.md/);
});

test("'the server cannot' needs a reviewed entry; a near miss is not enough", () => {
  has(problems({ "web/public/security.html": page("<p>The server cannot see who you are.</p>") }), /says the server or we cannot/);
  has(problems({ "web/public/security.html": page("<p>We can't read your files.</p>") }), /says the server or we cannot/);
});

test("legal pages: any blank fails, any draft marker fails, and each founder fact is required", () => {
  for (const blank of ["[TO DECIDE: postal address]", "[N]", "[operator legal name, address]"]) {
    has(problems({ "web/public/privacy.html": legalPage("web/public/privacy.html", `<p>${FREE_SENTENCE} Fair use.</p><p>Kept ${blank} days.</p>`) }), /privacy\.html: blank .* in a published page/);
  }
  for (const marker of ["<p><strong>Draft for review.</strong> Not yet reviewed by a lawyer.</p>", "<p class=\"meta\">Draft of 2026-11-16.</p>", "<p><strong>Draft.</strong></p>", "<p>The parts marked TO DECIDE must be filled in before this page is final.</p>"]) {
    has(problems({ "web/public/terms.html": legalPage("web/public/terms.html", `<p>${FREE_SENTENCE}</p>${marker}`) }), /terms\.html: .* is a draft marker/);
  }
  has(problems({ "web/public/trust.html": page("<p><strong>Draft.</strong> Facts.</p>") }), /trust\.html: .* is a draft marker/);
  for (const [rel, facts] of Object.entries(LEGAL_FACTS)) for (const f of facts) {
    const body = `<p>${rel.endsWith("terms.html") ? FREE_SENTENCE : `${FREE_SENTENCE} Fair use.`}</p>`;
    const want = `${rel}: does not state ${JSON.stringify(f)}`;
    const ps = problems({ [rel]: legalPage(rel, body, facts.filter((x) => x !== f)) });
    assert.ok(ps.some((p) => p.startsWith(want)), `expected ${want}, got:\n${ps.join("\n")}`);
  }
  // a paid-only page is not published while the paywall is off: its blank is not checked then (it is with it on)
  assert.deepEqual(problems({ "web/public/pricing.html": page("<p>[TO DECIDE: whether it is for sale]</p>") }).filter((p) => /pricing\.html: blank/.test(p)), []);
  has(problems({ "web/public/pricing.html": page("<p>[TO DECIDE: whether it is for sale]</p>") }, true), /pricing\.html: blank/);
});

test("product words and internal names in what people read; code is not read for words", () => {
  has(problems({ "web/public/security.html": page("<p>We deliver every message.</p>") }), /uses the word "deliver"/);
  has(problems({ "docs/agents.md": "A read receipt is shown.\n" }), /uses the word "receipt"/);
  has(problems({ "web/public/security.html": page(`<p>Built with ${"pnera".replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 84) % 26) + 97))}.</p>`) }), /internal name/);
  has(problems({ "web/public/security.html": page("<p>Plain words — no dashes.</p>") }), /em dash/);
  const ok = problems({ "web/public/security.html": page("<p>The field <code>envelope</code> is sealed.</p>") });
  assert.ok(!ok.some((p) => /uses the word/.test(p)), ok.join("\n"));
});

test("support table: a tested row needs a date, an OS and evidence; the landing names only backed apps", () => {
  const row = (r) => JSON.stringify({ apps: [{ ...SUPPORT.apps[0], ...r }] });
  has(problems({ [SUPPORT_FILE]: row({ last_run: undefined }) }), /tested with no date/);
  has(problems({ [SUPPORT_FILE]: row({ last_run: "last week" }) }), /tested with no date/);
  has(problems({ [SUPPORT_FILE]: row({ last_run: "2999-01-01" }) }), /in the future/);
  has(problems({ [SUPPORT_FILE]: row({ os: "" }) }), /tested with no OS/);
  has(problems({ [SUPPORT_FILE]: row({ evidence: "" }) }), /no evidence/);
  has(problems({ [SUPPORT_FILE]: row({ evidence: "evals/nothing-here.md" }) }), /not in the repository/);
  has(problems({ [SUPPORT_FILE]: row({ state: "works" }) }), /state must be/);
  has(problems({ [SUPPORT_FILE]: null }), /missing/);
  has(problems({ "web/public/assets/js/views/landing.js": 'export const T = "Claude Code and Windsurf.";\n' }), /names Windsurf/);
});

// One list of supported apps (the rows marked tested); the meta description, agents.md and llms.txt name every one,
// each says how its chats get a turn, and an app with an icon of ours shows it on the landing (17 Nov 2026: Grok Bot
// was run with bot-link and missing from all of them).
test("supported apps: every tested app is named in each list of apps, says how it gets a turn and has its icon on the landing", () => {
  const grok = { key: "grok-bot", name: "Grok Bot", state: "tested", last_run: "2026-11-11", os: "Linux", how: "a real run", turn: "Answers on its next turn.", evidence: "evals/RESULTS.md" };
  const table = JSON.stringify({ apps: [SUPPORT.apps[0], grok] });
  const icon = { "web/public/assets/apps/grok-bot.png": "png" };
  const landing = { "web/public/assets/js/app-logos.js": 'export const LOGOS = {\n  "grok-bot": { name: "Grok Bot", src: "/assets/apps/grok-bot.png", full: true },\n};\n' };
  const named = {
    "web/public/index.html": page("").replace("</head>", '<meta name="description" content="Rooms where your Claude Code and Grok Bot chats work together."></head>'),
    "docs/agents.md": "# Agents\n\nChats in Claude Code and Grok Bot work together.\n",
    "docs/llms.txt": "# bot-link\n\n> Rooms for AI chats across apps (Claude Code, Grok Bot).\n",
  };
  assert.deepEqual(APP_LISTS.map(([f]) => f), ["web/public/index.html", "docs/agents.md", "docs/llms.txt"]);
  const listed = (ps) => ps.filter((p) => /does not name|LOGOS has no entry|no "turn"|no key|lists the supported apps/.test(p));
  assert.deepEqual(listed(problems({ [SUPPORT_FILE]: table, ...icon, ...landing, ...named })), []);
  const ps = listed(problems({ [SUPPORT_FILE]: table, ...icon }));
  has(ps, /index\.html: its meta description does not name Grok Bot, which .*app-support\.json marks tested/);
  has(ps, /agents\.md: its first paragraph does not name Grok Bot/);
  has(ps, /llms\.txt: its summary line .* does not name Grok Bot/);
  has(ps, /app-logos\.js: LOGOS has no entry "grok-bot" with name "Grok Bot" and src "\/assets\/apps\/grok-bot\.png"/);
  assert.equal(ps.length, 4, ps.join("\n"));
  has(listed(problems({ [SUPPORT_FILE]: JSON.stringify({ apps: [SUPPORT.apps[0], { ...grok, turn: "" }] }), ...icon, ...landing, ...named })), /Grok Bot: tested with no "turn"/);
  has(listed(problems({ [SUPPORT_FILE]: JSON.stringify({ apps: [SUPPORT.apps[0], { ...grok, key: undefined }] }), ...landing, ...named })), /Grok Bot: no key/);
  has(listed(problems({ "docs/llms.txt": null })), /llms\.txt: missing/);
  has(listed(problems({ "web/public/index.html": page("") })), /index\.html: its meta description is not there/);
  // a set-up row (not run by us) is not a supported app: the lists need not name it, and no icon is required without a file
  assert.deepEqual(listed(problems({ [SUPPORT_FILE]: JSON.stringify({ apps: [SUPPORT.apps[0], { ...grok, state: "setup", last_run: undefined, os: undefined, turn: undefined }] }) })), []);
});

// ------------------------------------------------------------------ the paywall (BOTLINK_PAYWALL, default off)
// Off: nothing a person or a model reads mentions plans, prices, credits, upgrades, billing or payments, and terms
// and privacy say bot-link is free. On: the paid wording kept under web/paywall/ is merged into its pages.
const paidProblems = (ps) => ps.filter((p) => /mentions the paywall|paid wording|free sentence|web\/paywall|PAID_/.test(p));

test("paywall off: each paid word fails on a page, in the docs and in the client's texts", () => {
  for (const [text, word] of [
    ["Pick a plan.", "plan"], ["See the plans.", "plans"], ["See pricing.", "pricing"], ["The price is fair.", "price"],
    ["Buy credits.", "credits"], ["One credit each.", "credit"], ["Upgrade now.", "Upgrade"], ["Open billing.", "billing"],
    ["Your subscription renews monthly.", "Your subscription"], ["Buy a paid subscription.", "paid subscription"],
    ["Subscribe to bot-link.", "Subscribe to bot-link"], ["A monthly subscription.", "monthly subscription"], ["It costs $ 15.", "\\$ 15"], ["Only $15 a seat.", "\\$15"], ["A payment failed.", "payment"], ["Payments are off.", "Payments"],
    ["Go Pro.", "Pro"], ["The Team tier.", "Team"], ["Only $8 a seat.", "$8"], ["Eight dollars per month.", "per month"],
  ]) has(problems({ "web/public/security.html": page(`<p>${text}</p>`) }), new RegExp(`security\\.html: .* mentions the paywall \\("${word.startsWith("\\") ? word : word.replace("$", "\\$")}"\\)`));
  has(problems({ "docs/agents.md": "# Agents\n\nThe `plan` field of `/api/v1/me`.\n" }), /agents\.md: .* mentions the paywall \("plan"\)/);
  has(problems({ "docs/protocol/x.md": "History is kept longer on plans that keep more.\n" }), /docs\/protocol\/x\.md: .* mentions the paywall/);
  has(problems({ "client/src/cli.ts": 'const S = "Tell your human to upgrade the room.";\n' }), /client\/src\/cli\.ts: .* mentions the paywall \("upgrade"\)/);
  has(problems({ "client/README.md": "Knows the payment flow.\n" }), /client\/README\.md: .* mentions the paywall/);
  has(problems({ "web/public/assets/js/views/landing.js": 'export const T = "Free on the Free plan.";\n' }), /landing\.js: .* mentions the paywall/);
  has(problems({ "web/public/trust.html": page("<p>Table <code>plans</code>.</p>") }), /trust\.html: .* mentions the paywall \("plans"\)/);
});

test("paywall off: whole words, and Pro and Team only with their capital", () => {
  const ps = problems({ "web/public/security.html": page("<p>We explain it. Publishing is planned. A professional team of teams. Process, project, protocol. The variable $x and ${a}.</p>") });
  assert.deepEqual(ps.filter((p) => /mentions the paywall/.test(p)), []);
});

test("paywall off: subscription as the events and MCP word, and SQL placeholders, are not paid words", () => {
  const md = "# Events\n\n`events/unsubscribe` removes the matching subscription. The subscription API and the event stream. Use `subscriptions/listen` with `X-MCP-Subscription-Id`. Resource subscriptions are a draft.\n\nThe pattern `insert into t (a, b) values ($1, $2)` and the regex insert into t \\(a\\) values \\(\\$1\\) and where id = $1::uuid.\n";
  assert.deepEqual(problems({ "docs/protocol/events.md": md }).filter((p) => /mentions the paywall/.test(p)), []);
  // landing-claims.json: its sources are code patterns; only the claim texts are read
  const claims = JSON.stringify({ about: "x", section: { title: "How it's secured" }, hero: { text: "Signed.", sources: [{ file: "a.go", test: "values \\(\\$1, \\$2\\) and $9" }] }, steps: [], note: { text: "Note.", sources: [] } });
  assert.deepEqual(problems({ "web/public/assets/landing-claims.json": claims }).filter((p) => /mentions the paywall/.test(p)), []);
  const priced = JSON.stringify({ about: "x", section: {}, hero: { text: "Only $15 a month.", sources: [] }, steps: [], note: { text: "n", sources: [] } });
  has(problems({ "web/public/assets/landing-claims.json": priced }), /landing-claims\.json: .* mentions the paywall \("\$15"\)/);
});

test("paywall off: the paid-only files are exempt by name; the same words anywhere else fail", () => {
  const js = 'export const T = "Upgrade to Pro for more rooms.";\n';
  const ok = problems({ "web/public/assets/js/views/billing.js": js, "web/public/pricing.html": page("<p>Pro: $8 per month.</p>") });
  assert.deepEqual(ok.filter((p) => /mentions the paywall/.test(p)), []);
  has(problems({ "web/public/assets/js/views/account.js": js }), /account\.js: .* mentions the paywall/);
});

test("paywall off: terms and privacy say bot-link is free", () => {
  has(problems({ "web/public/terms.html": legalPage("web/public/terms.html", "") }), /terms\.html: .*free sentence/);
  has(problems({ "web/public/privacy.html": legalPage("web/public/privacy.html", "") }), /privacy\.html: .*free sentence/);
});

test("paywall off: the paid wording is kept, and its off text is still on the page so the merge applies", () => {
  has(problems({ "web/paywall/terms-paid.html": null }), /web\/paywall\/terms-paid\.html: missing/);
  has(problems({ "web/paywall/privacy-paid.html": "<p>no pairs</p>" }), /privacy-paid\.html: no paid wording/);
  has(problems({ "web/paywall/security-paid.html": paid("<p>Not on the page.</p>", "<p>Payment records.</p>") }), /security-paid\.html: off text .* is not in web\/public\/security\.html/);
});

test("paywall on: paid words are allowed, the paid wording must be merged and the free sentence gone", () => {
  // nothing merged yet: every on text is missing, and the free sentence is still there
  const before = problems({}, true);
  has(before, /terms-paid\.html: on text .* is not in web\/public\/terms\.html/);
  has(before, /terms\.html: .*free sentence.* paywall is on/);
  // merged: clean
  const merged = Object.fromEntries(Object.keys(LEGAL_FACTS).map((rel) => [rel, legalPage(rel, `<p>${ON_TEXT[rel] || ""}</p><p>Upgrade to Pro for $8 per month.</p>`)]));
  merged["web/public/security.html"] = page(`<p>${ON_TEXT["web/public/security.html"]}</p>`);
  const ps = problems(merged, true).filter((p) => !/^copy-check: (CANNOT_OK|ALLOW|PAID_OK|PAID_ONLY) entry/.test(p));
  assert.deepEqual(ps, []);
});

test("paywall: the shipped constant is off", () => {
  assert.equal(PAYWALL, false);
});

test("fair use: a number the pages print must still be the code's (only checked in a repository with a server)", () => {
  const ps = problems({ "server/internal/config/plans.go": "func x() int {\n\tif p.StorageCeilingMB <= 0 {\n\t\treturn 32\n\t}\n}\n" });
  has(ps, /plans\.go: the fair-use number behind "up to 64 MB per account" is no longer found/);
  has(ps, /terms\.html: does not say the fair-use limit "up to 64 MB per account"/);
  assert.ok(!problems().some((p) => /fair-use/.test(p)), "no server folder: not checked");
});
