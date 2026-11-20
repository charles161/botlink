// The one lookup from a chat's app to an icon of ours (web/public/assets/js/app-logos.js): a chat whose app is "other"
// and whose self-given name (app_name) is the name of an app we keep an icon for gets that app's name and icon on the
// dashboard (17 Nov 2026: Grok Bot chats name themselves, `--app-name "Grok Bot"`); any other name keeps the generic bot.
//   node --test web/test/app_logos.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGOS, logoFor } from "../public/assets/js/app-logos.js";
import { appName } from "../public/assets/js/art.js";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const APPS_DIR = join(PUBLIC, "assets/apps");

test("a self-named chat matches an app we have an icon for, ignoring case, spaces and dashes", () => {
  for (const n of ["Grok Bot", "grok bot", "grok-bot", "GROK-BOT", "  Grok   Bot ", "Grok - Bot", "grokbot"]) {
    const l = logoFor("other", n);
    assert.ok(l, `${JSON.stringify(n)} should match Grok Bot`);
    assert.equal(l.key, "grok-bot");
    assert.equal(l.name, "Grok Bot");
    assert.equal(l.src, "/assets/apps/grok-bot.png");
  }
  assert.equal(logoFor("other", "T3 Code")?.key, "t3-code", "the client's own T3 Code name gets its icon too");
  assert.equal(logoFor("other", "opencode")?.key, "opencode");
});

test("no icon for a name we have none for, an empty name, or a chat whose app was detected", () => {
  for (const n of ["Totally New App", "Grok", "Grok Botty", "Grok_Bot", "", "   ", null, undefined, 7]) assert.equal(logoFor("other", n), null, `${JSON.stringify(n)}`);
  for (const app of ["cursor", "claude-code", "codex", "opencode", "", undefined]) assert.equal(logoFor(app, "Grok Bot"), null, `app ${app}: the detected app decides, not a name`);
});

test("the dashboard writes the matched app's own name; any other name as the chat gave it; detected apps unchanged", () => {
  assert.equal(appName("other", "grok-bot"), "Grok Bot");
  assert.equal(appName("other", "GROK BOT"), "Grok Bot");
  assert.equal(appName("other", "Totally New App"), "Totally New App");
  assert.equal(appName("cursor", "Grok Bot"), "Cursor");
  assert.equal(appName("other", null), "Other app");
});

test("every icon file of ours has one entry, and every entry's file exists and is in SOURCES.md", () => {
  const sources = readFileSync(join(APPS_DIR, "SOURCES.md"), "utf8");
  const files = readdirSync(APPS_DIR).filter((f) => /\.(svg|png)$/.test(f)).sort();
  const named = Object.values(LOGOS).map((l) => l.src.replace("/assets/apps/", "")).sort();
  assert.deepEqual(named, files, "one LOGOS entry per file in assets/apps");
  const norm = (s) => s.toLowerCase().replace(/[\s-]+/g, "");
  assert.equal(new Set(Object.values(LOGOS).map((l) => norm(l.name))).size, Object.keys(LOGOS).length, "two entries must not match the same name");
  for (const [key, l] of Object.entries(LOGOS)) {
    assert.ok(existsSync(join(PUBLIC, l.src)), `${key}: ${l.src} is missing`);
    assert.ok(sources.includes(`| ${l.src.replace("/assets/apps/", "")} |`), `${key}: ${l.src} is not in SOURCES.md`);
    assert.match(key, /^[a-z0-9-]+$/);
  }
});
