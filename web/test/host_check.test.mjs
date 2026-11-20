// The dashboard-routes-versus-host-table check, on a made-up web/public: a route the table lacks fails, a table page
// without a route fails, and the real tree passes.
//   node --test web/test/host_check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostProblems } from "../scripts/host-check.mjs";

const PUBLIC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
const many = Array.from({ length: 10 }, (_, i) => `  { re: /^\\/p${i}\\/?$/, load: () => 0, name: "p${i}" },`).join("\n");
const table = (rows) => `export const HOST_TABLE = ${JSON.stringify(rows)};\n`;
const pages = Array.from({ length: 10 }, (_, i) => [`/p${i}`, "app", "page"]);

function tree(routes, rows) {
  const d = mkdtempSync(join(tmpdir(), "host-check-"));
  mkdirSync(join(d, "assets", "js"), { recursive: true });
  writeFileSync(join(d, "assets", "js", "app.js"), `const routes = [\n${many}\n${routes}\n];\n`);
  writeFileSync(join(d, "assets", "js", "hosts.js"), table([...pages, ...rows]));
  return d;
}

test("the real tree passes", async () => assert.deepEqual(await hostProblems(PUBLIC), []));

test("a route the table does not name fails, with the line to add", async () => {
  const d = tree(`  { re: /^\\/rooms\\/([0-9a-f-]{36})\\/?$/, load: () => 0, name: "room" },\n  { re: /^\\/extra\\/?$/, load: () => 0, name: "x" },`, [["/rooms/{id}", "app", "page"]]);
  const p = await hostProblems(d);
  rmSync(d, { recursive: true });
  assert.equal(p.length, 1);
  assert.match(p[0], /route \/\^\\\/extra.*add it to the host table as site or app/);
});

test("a table page without a route fails; files and calls need none", async () => {
  const d = tree("", [["/gone", "site", "page"], ["/x.css", "site", "file"], ["/app/v1/", "app", "call"]]);
  const p = await hostProblems(d);
  rmSync(d, { recursive: true });
  assert.deepEqual(p, ["host table page /gone has no route in assets/js/app.js: add one to `routes`, or drop the row from HostTable (server/internal/pages/hosts.go)"]);
});
