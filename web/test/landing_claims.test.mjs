// The landing's security claims: each failure mode of the rule (web/scripts/copy-check.mjs landingProblems), of the
// generator (web/scripts/trust-facts.mjs readLanding) and of the builders'-notes check, on small made-up repositories.
//   node --test web/test/landing_claims.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { landingProblems, LANDING_CLAIMS, LANDING_JS, LANDING_CANNOT_OK, LANDING_SHORT_MAX_WORDS, LANDING_READ_WORDS } from "../scripts/copy-check.mjs";
import { build, perJoinProblems, capWords, PER_JOIN_PAGES } from "../scripts/trust-facts.mjs";
import { notesProblems } from "../scripts/notes-check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CANNOT = LANDING_CANNOT_OK[0][0];
const step = (o = {}) => ({ id: "keys", icon: "key", title: "Each chat has its own key.", short: "Our server acts for a chat only on requests it signed.", text: `Requests are signed. ${CANNOT}`, caveat: "Two requests go unsigned.",
  sources: [{ file: "src/a.ts", pattern: "signRequest\\(", flags: "" }, { file: "src/a.test.ts", test: "requests are signed" }], ...o });
const claims = (o = {}) => ({ about: "x", section: { kicker: "How it's secured", title: "What keeps a room yours.", lead: "Six things.", limit_label: "Where it stops:",
  trust_link: { text: "See the actual signed request", href: "/trust.html#server" }, security_link: { text: "Read the security page", href: "/security.html" } },
  hero: { text: "A person approves every chat.", sources: [{ file: "src/a.ts", pattern: "signRequest", flags: "" }] },
  steps: [step()], note: { text: "Keep your prompts on.", sources: [{ file: "src/a.ts", pattern: "sign", flags: "" }] }, ...o });
const JS = (region = 'const CLAIMS_URL = "/assets/landing-claims.json";\nconst x = h("p", { class: "lp-sstep lead" }, c.text);', outside = 'const t = "Every agent chat.";') =>
  `${outside}\n// landing-claims:start\n${region}\n// landing-claims:end\n`;

function problems({ c = claims(), js = JS(), files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "landing-claims-"));
  const all = {
    [LANDING_CLAIMS]: c === null || typeof c === "string" ? c : JSON.stringify(c), [LANDING_JS]: js,
    "src/a.ts": "export function signRequest() {}\n", "src/a.test.ts": 'test("requests are signed", () => {});\n',
    "web/public/assets/js/crypto.js": 'await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);\n', ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  try { return landingProblems(root).filter((p) => !/LANDING_INLINE_OK entry/.test(p)); } finally { rmSync(root, { recursive: true, force: true }); }
}
const has = (ps, re) => assert.ok(ps.some((p) => re.test(p)), `expected a problem matching ${re}, got:\n${ps.join("\n")}`);

test("a clean made-up repository passes", () => assert.deepEqual(problems(), []));

test("the claims file is missing or not JSON", () => {
  has(problems({ c: null }), /landing-claims\.json: missing/);
  has(problems({ c: "{" }), /not JSON/);
  has(problems({ c: "[]" }), /not an object/);
});

test("a step with no source, no title or no text", () => {
  has(problems({ c: claims({ steps: [step({ sources: [] })] }) }), /claim "keys": no source/);
  has(problems({ c: claims({ steps: [step({ title: "" })] }) }), /claim "keys": no title/);
  has(problems({ c: claims({ steps: [step({ text: "" })] }) }), /claim "keys": no text/);
  has(problems({ c: claims({ steps: [step(), step()] }) }), /claim "keys": the id is used twice/);
});

test("each step has one short sentence of at most 22 words, and all titles and short sentences make a 30-second read", () => {
  assert.equal(LANDING_SHORT_MAX_WORDS, 22);
  assert.equal(LANDING_READ_WORDS, 190);
  has(problems({ c: claims({ steps: [step({ short: undefined })] }) }), /claim "keys": no short sentence/);
  has(problems({ c: claims({ steps: [step({ short: Array(23).fill("word").join(" ") + "." })] }) }), /claim "keys": its short sentence has 23 words; at most 22/);
  has(problems({ c: claims({ steps: [step({ short: "It is signed. It is checked." })] }) }), /claim "keys": its short form is more than one sentence/);
  const long = (i) => step({ id: `s${i}`, title: Array(12).fill("title").join(" ") + ".", short: Array(20).fill("word").join(" ") + "." });
  has(problems({ c: claims({ steps: [0, 1, 2, 3, 4, 5].map(long) }) }), /have 192 words together; a 30-second read is at most 190/);
  has(problems({ c: claims({ steps: [step({ short: "Agents can never approve." })] }) }), /says something cannot or never happens/);
  has(problems({ c: claims({ steps: [step({ short: "We guarantee it." })] }) }), /claims guarantee/);
});

test("a caveat that says what can, could or may still happen needs its limiting words in the short line", () => {
  const cav = "A changed page could make your browser sign.";
  has(problems({ c: claims({ steps: [step({ caveat: cav })] }) }), /claim "keys": its caveat says what can still happen \("A changed page could make your browser sign\."\), so the short line must carry its limit: set limits_in_short: true and short_must_say/);
  has(problems({ c: claims({ steps: [step({ caveat: "It works unless you turn it off.", limits_in_short: false })] }) }), /claim "keys": its caveat says what can still happen/);
  has(problems({ c: claims({ steps: [step({ caveat: cav, limits_in_short: true, short_must_say: ["without a browser's signature"] })] }) }), /claim "keys": the short line lacks "without a browser's signature"/);
  has(problems({ c: claims({ steps: [step({ limits_in_short: true, short_must_say: [] })] }) }), /claim "keys": limits_in_short is true but short_must_say names no words/);
  assert.deepEqual(problems({ c: claims({ steps: [step({ caveat: cav, limits_in_short: true, short_must_say: ["requests it signed"] })] }) }), []);
  assert.deepEqual(problems({ c: claims({ steps: [step({ caveat: "The server cannot read it." })] }) }).filter((p) => /what can still happen/.test(p)), [], "'cannot' is not 'can'");
});

test("a source file that does not exist, a pattern that no longer matches, a test that is gone", () => {
  has(problems({ files: { "src/a.ts": null } }), /claim "keys": source file src\/a\.ts does not exist/);
  has(problems({ files: { "src/a.ts": "export function sign_request() {}\n" } }), /claim "keys": pattern no longer matches in src\/a\.ts/);
  has(problems({ files: { "src/a.test.ts": 'test("requests are checked", () => {});\n' } }), /claim "keys": test "requests are signed" is no longer in src\/a\.test\.ts/);
});

test("banned words, product words, an em dash and a blank in a claim", () => {
  for (const [text, re] of [["Here is what bot-link guarantees.", /claims guarantee/], ["It asks you every time.", /claims every time/],
    ["The client is open source.", /claims open source/], ["The message was delivered.", /uses the word "delivered"/],
    ["Signed — and checked.", /em dash/], ["Kept [N] days.", /bracketed blank/]]) has(problems({ c: claims({ steps: [step({ text: text })] }) }), re);
});

test("'cannot' or 'never' only in a reviewed sentence; a reviewed sentence nobody uses is stale", () => {
  has(problems({ c: claims({ steps: [step({ text: `The server can never read it. ${CANNOT}` })] }) }), /says something cannot or never happens/);
  has(problems({ c: claims({ steps: [step({ caveat: "Agents cannot approve." })] }) }), /says something cannot or never happens/);
  has(problems({ c: claims({ steps: [step({ text: "Requests are signed." })] }) }), /LANDING_CANNOT_OK entry .* is in no claim/);
  has(problems({ files: { "web/public/assets/js/crypto.js": "generateKey(true)\n" } }), /LANDING_CANNOT_OK entry .*its source no longer matches/);
});

test("landing.js: the section markers, the claims file it loads, prose inside the section", () => {
  has(problems({ js: 'const x = "a";\n' }), /must sit between one "\/\/ landing-claims:start" line/);
  has(problems({ js: JS('const x = h("p", null, c.text);') }), /does not load \/assets\/landing-claims\.json/);
  has(problems({ js: JS('const CLAIMS_URL = "/assets/landing-claims.json";\nconst x = h("p", null, "Every request is signed by the chat.");') }), /writes "Every request is signed by the chat\." \(7 words\) itself/);
  assert.deepEqual(problems({ js: JS('const CLAIMS_URL = "/assets/landing-claims.json";\nconst x = h("a", { class: "btn btn-sun lp-safe-more" }, "Security");') }), []);
});

test("landing.js: security talk outside the section must be reviewed", () => {
  has(problems({ js: JS(undefined, 'const t = "Messages are sealed end to end.";') }), /talks security outside the generated section/);
  has(problems({ js: JS(undefined, 'const t = `Only you approve ${n} chats`;') }), /talks security outside the generated section/);
  assert.deepEqual(problems({ js: JS(undefined, 'const t = h("span", { class: "lp-seal lp-w-x" }, "room");') }), [], "class names are not words");
});

test("the generator fails on a source pattern that no longer matches, naming the claim and the file", () => {
  const { R } = build(ROOT);
  const root = mkdtempSync(join(tmpdir(), "landing-gen-"));
  try {
    for (const f of R.inputs) { mkdirSync(dirname(join(root, f)), { recursive: true }); cpSync(join(ROOT, f), join(root, f)); }
    assert.ok(build(root).landing.includes('"signed-requests"'));
    const f = join(root, "client/src/roster.ts");
    writeFileSync(f, readFileSync(f, "utf8").replace("member_add not signed by a device of that person", "member_add not signed"));
    assert.throws(() => build(root), /landing claim "signed-member-list": no longer found in client\/src\/roster\.ts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a builder's note tracked at the repository root fails", () => {
  const root = mkdtempSync(join(tmpdir(), "notes-"));
  try {
    const git = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(root, "README.md"), "x\n");
    writeFileSync(join(root, ".fixall-landing-REPORT.md"), "notes\n");
    git("add", "README.md");
    assert.deepEqual(notesProblems(root), [], "an untracked note is fine");
    git("add", "-f", ".fixall-landing-REPORT.md");
    assert.deepEqual(notesProblems(root), [".fixall-landing-REPORT.md: builders' notes are not product: git rm --cached .fixall-landing-REPORT.md"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Batch approval: one passkey step lets in up to MaxTargets waiting chats of one room, so "each join asks for the
// passkey" became false (17 Nov 2026). The generator reads the cap from the code and fails on per-join wording.
test("per-join passkey wording fails while one approval can let in more than one chat; the cap named must be the code's", () => {
  const OLD = "Each join asks for the passkey again, even one a minute after the last, and so does a chat that moves to another chat or computer.";
  const NEW = "Each approval asks for the passkey again, even one a minute after the last; one approval can let in up to five waiting chats of one room that you tick, each beside its own code.";
  const claimsWith = (text) => JSON.stringify({ hero: { text: "A person approves." }, steps: [{ id: "human-approves", title: "t", short: "Every join is confirmed with a passkey on the dashboard.", text }] });
  const sec = (li, cell = "a passkey in the browser for each approval") => `<ul><li>${li}</li></ul><table><tr><td>An agent cannot approve a join</td><td>Enforced by code: ${cell}</td></tr><tr><td>A room</td><td>a passkey each time</td></tr></table>`;
  const GOOD_LI = "Its person approves with a passkey. Each approval asks for the passkey again; one approval can let in up to five waiting chats of one room that the person ticks.";
  const texts = (o = {}) => ({ "web/public/security.html": sec(GOOD_LI), "web/public/trust.html": "<p>Facts.</p>", "web/public/assets/landing-claims.json": claimsWith(NEW), ...o });
  assert.deepEqual(PER_JOIN_PAGES, ["web/public/security.html", "web/public/trust.html", "web/public/assets/landing-claims.json"]);
  assert.equal(capWords(5), "five");
  assert.deepEqual(perJoinProblems(5, texts()), [], "the new wording passes; a room confirm's 'a passkey each time' is not about joins");
  has(perJoinProblems(5, texts({ "web/public/assets/landing-claims.json": claimsWith(OLD) })), /landing-claims\.json: "Each join asks for the passkey again.*says the passkey is asked for each join, but one approval lets in up to 5 chats/);
  has(perJoinProblems(5, texts({ "web/public/security.html": sec("Its person approves with a passkey each time. One approval can let in up to five waiting chats.") })), /security\.html: .*approves with a passkey each time.* says the passkey is asked for each join/);
  has(perJoinProblems(5, texts({ "web/public/security.html": sec(GOOD_LI, "no approve call for agents; a passkey in the browser each time") })), /security\.html: "Enforced by code: no approve call for agents; a passkey in the browser each time" says the passkey is asked for each join/);
  has(perJoinProblems(5, texts({ "web/public/trust.html": "<p>A passkey is asked per join.</p>" })), /trust\.html: .*per join/);
  has(perJoinProblems(5, texts({ "web/public/security.html": sec("Its person approves with a passkey.") })), /security\.html: does not say "up to five waiting chats"/);
  has(perJoinProblems(5, texts({ "web/public/security.html": sec(GOOD_LI.replace("five", "four")) })), /"up to four waiting chats" names a batch cap of four, but the code's is 5/);
  has(perJoinProblems(7, texts()), /names a batch cap of five, but the code's is 7/);
  assert.deepEqual(perJoinProblems(1, texts({ "web/public/assets/landing-claims.json": claimsWith(OLD) })), [], "with a cap of one, each join is one approval");
});

test("the generator writes the batch cap from the code, and a changed cap fails until the claim is reviewed", () => {
  const { R, landing } = build(ROOT);
  const step = JSON.parse(landing).steps.find((s) => s.id === "human-approves");
  assert.match(step.text, /Each approval asks for the passkey again, even one a minute after the last; one approval can let in up to five waiting chats of one room that you tick, each beside its own code\./);
  assert.ok(step.sources.some((s) => s.file === "server/internal/appapi/approve_batch.go"), "the batch handler backs the claim");
  assert.ok(step.sources.some((s) => s.file === "server/internal/humancheck/humancheck.go" && s.pattern === "const MaxTargets = 5"), "the cap backs the claim");
  const root = mkdtempSync(join(tmpdir(), "landing-cap-"));
  try {
    for (const f of R.inputs) { mkdirSync(dirname(join(root, f)), { recursive: true }); cpSync(join(ROOT, f), join(root, f)); }
    const f = join(root, "server/internal/humancheck/humancheck.go");
    writeFileSync(f, readFileSync(f, "utf8").replace("const MaxTargets = 5", "const MaxTargets = 8"));
    assert.throws(() => build(root), /landing claim "human-approves".*humancheck\.go/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
